import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RepoProbeRequest } from '@benchmemo/shared';
import { runCodexProbe } from './exec.js';

test('runCodexProbe parses a successful codex result', async () => {
  const localPath = await mkdtemp(join(tmpdir(), 'benchmemo-codex-success-'));
  process.env.CODEX_API_KEY = 'should-not-be-forwarded';
  try {
    const result = await runCodexProbe(makeRequest(localPath), {
      spawnFn(command, args, options) {
        assert.equal(command, 'codex');
        assert.equal(options?.env?.CODEX_API_KEY, undefined);
        const child = new FakeChild();
        const outputPath = getOutputPath(args);

        queueMicrotask(async () => {
          await writeFile(
            outputPath,
            JSON.stringify(
              {
                summary: 'Looks contained.',
                touchedAreas: ['apps/api'],
                hiddenDependencies: [],
                likelyTestSurface: ['apps/api/src/server.test.ts'],
                migrationHazards: [],
                operationalRisks: [],
                estimatedComplexity: 'low',
                confidence: 0.74,
              },
              null,
              2
            )
          );

          child.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);
          child.stdout.end();
          child.stderr.end();
          child.exitCode = 0;
          child.emit('close', 0);
        });

        return child.asChildProcess();
      },
      timeoutMs: 1_000,
    });

    if (result.status !== 'succeeded') {
      throw new Error(`Expected succeeded probe outcome, got ${result.status}`);
    }

    assert.equal(result.decisionId, 'dec_probe');
    assert.equal(result.optionId, 'opt_file');
    assert.equal(result.probeType, 'impact_scan');
    assert.equal(result.attempts, 1);
    assert.equal(result.summary, 'Looks contained.');
    assert.equal(result.estimatedComplexity, 'low');
  } finally {
    delete process.env.CODEX_API_KEY;
  }
});

test('runCodexProbe times out and returns a failed probe outcome', async () => {
  const localPath = await mkdtemp(join(tmpdir(), 'benchmemo-codex-timeout-'));
  const child = new FakeChild();

  const result = await runCodexProbe(makeRequest(localPath), {
    spawnFn() {
      return child.asChildProcess();
    },
    timeoutMs: 20,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.timedOut, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.failureKind, 'timeout');
  assert.equal(result.failurePhase, 'execution');
  assert.equal(result.retryable, true);
  assert.match(result.errorMessage, /timed out after 20ms/);
  assert.deepEqual(child.killedSignals, ['SIGTERM']);
});

test('runCodexProbe classifies auth-like timeouts as non-retryable auth failures', async () => {
  const localPath = await mkdtemp(join(tmpdir(), 'benchmemo-codex-auth-timeout-'));

  const result = await runCodexProbe(makeRequest(localPath), {
    spawnFn() {
      const child = new FakeChild();

      queueMicrotask(() => {
        child.stderr.write('failed to connect to websocket: HTTP error: 403 Forbidden\n');
      });

      return child.asChildProcess();
    },
    timeoutMs: 20,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureKind, 'auth');
  assert.equal(result.failurePhase, 'execution');
  assert.equal(result.retryable, false);
});

test('runCodexProbe returns stderr and event summaries on non-zero exit', async () => {
  const localPath = await mkdtemp(join(tmpdir(), 'benchmemo-codex-failure-'));

  const result = await runCodexProbe(makeRequest(localPath), {
    spawnFn() {
      const child = new FakeChild();

      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ type: 'thread.started' })}\n`);
        child.stderr.write('probe exploded\n');
        child.stdout.end();
        child.stderr.end();
        child.exitCode = 2;
        child.emit('close', 2);
      });

      return child.asChildProcess();
    },
    timeoutMs: 1_000,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.timedOut, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.failureKind, 'cli');
  assert.equal(result.retryable, false);
  assert.match(result.errorMessage, /exited with code 2/);
  assert.match(result.stderrSummary, /probe exploded/);
  assert.match(result.eventSummary, /thread\.started/);
});

test('runCodexProbe returns invalid_output when structured output is unreadable', async () => {
  const localPath = await mkdtemp(join(tmpdir(), 'benchmemo-codex-invalid-output-'));

  const result = await runCodexProbe(makeRequest(localPath), {
    spawnFn(_command, args) {
      const child = new FakeChild();
      const outputPath = getOutputPath(args);

      queueMicrotask(async () => {
        await writeFile(outputPath, '{not valid json');
        child.stdout.end();
        child.stderr.end();
        child.exitCode = 0;
        child.emit('close', 0);
      });

      return child.asChildProcess();
    },
    timeoutMs: 1_000,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureKind, 'invalid_output');
  assert.equal(result.failurePhase, 'execution');
  assert.equal(result.retryable, false);
  assert.match(result.errorMessage, /unreadable output/i);
});

function makeRequest(localPath: string): RepoProbeRequest {
  return {
    decisionId: 'dec_probe',
    optionId: 'opt_file',
    probeType: 'impact_scan',
    repoName: 'jkordish/benchmemo',
    localPath,
    paths: ['apps/api'],
    question: 'Inspect impact',
    outputSchemaName: 'impact-scan',
    sandbox: 'read-only',
  };
}

function getOutputPath(args: string[]) {
  const index = args.indexOf('--output-last-message');
  if (index === -1 || !args[index + 1]) {
    throw new Error('Missing --output-last-message argument');
  }

  return args[index + 1];
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly killedSignals: string[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killedSignals.push(signal);
    return true;
  }

  asChildProcess() {
    return this as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
  }
}
