import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RepoProbeRequest } from '@benchmemo/shared';
import { runCodexProbe } from './exec.js';
import {
  CODEX_PROBE_CONFIG_OVERRIDES,
  CODEX_PROBE_DISABLED_FEATURES,
  CodexProbeEnvironmentError,
  type PreparedCodexProbeEnvironment,
} from './probe-environment.js';

test('runCodexProbe parses a successful codex result with isolated probe settings', async () => {
  const localPath = await mkdtemp(join(tmpdir(), 'benchmemo-codex-success-'));
  let cleanupCalls = 0;

  const result = await runCodexProbe(makeRequest(localPath), {
    env: {
      OPENAI_API_KEY: 'sk-openai-test',
      HOME: '/home/tester',
    },
    probeEnvironmentFactory: async (sourceEnv) =>
      makePreparedProbeEnvironment(sourceEnv, {
        cleanup: async () => {
          cleanupCalls += 1;
        },
      }),
    spawnFn(command, args, options) {
      assert.equal(command, 'codex');
      assert.equal(options?.env?.OPENAI_API_KEY, 'sk-openai-test');
      assert.equal(options?.env?.HOME, '/tmp/benchmemo-probe-home');

      for (const feature of CODEX_PROBE_DISABLED_FEATURES) {
        assert.equal(hasArgPair(args, '--disable', feature), true);
      }

      for (const override of CODEX_PROBE_CONFIG_OVERRIDES) {
        assert.equal(hasArgPair(args, '-c', override), true);
      }

      const prompt = args[args.length - 1] ?? '';
      assert.match(prompt, /non-interactive batch probe/i);
      assert.match(prompt, /never call request_user_input/i);
      assert.match(prompt, /do not spawn sub-agents or use collaboration tools/i);
      assert.match(prompt, /do not use MCP resources, GitHub tools, browser tools, web search/i);
      assert.match(prompt, /use only local shell commands and local file inspection/i);

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
  assert.equal(result.probeType, 'repo_scan');
  assert.equal(result.attempts, 1);
  assert.equal(result.summary, 'Looks contained.');
  assert.equal(result.estimatedComplexity, 'low');
  assert.equal(cleanupCalls, 1);
});

test('runCodexProbe reports isolated probe-home preparation failures as preflight failures', async () => {
  const localPath = await mkdtemp(join(tmpdir(), 'benchmemo-codex-preflight-'));

  const result = await runCodexProbe(makeRequest(localPath), {
    probeEnvironmentFactory: async () => {
      throw new CodexProbeEnvironmentError(
        'Codex auth state is not available for isolated probe runs at /home/test/.codex/auth.json: ENOENT',
        'auth'
      );
    },
    timeoutMs: 1_000,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureKind, 'auth');
  assert.equal(result.failurePhase, 'preflight');
  assert.equal(result.retryable, false);
  assert.match(result.errorMessage, /auth state is not available/i);
  assert.match(result.eventSummary, /diagnostics:/);

  const diagnosticsPath = getDiagnosticsPath(result.eventSummary);
  const diagnostics = JSON.parse(await readFile(diagnosticsPath, 'utf8')) as {
    failurePhase: string;
    probeEnvironment: unknown;
  };
  assert.equal(diagnostics.failurePhase, 'preflight');
  assert.equal(diagnostics.probeEnvironment, null);
});

test('runCodexProbe times out and returns a failed probe outcome', async () => {
  const localPath = await mkdtemp(join(tmpdir(), 'benchmemo-codex-timeout-'));
  const child = new FakeChild();

  const result = await runCodexProbe(makeRequest(localPath), {
    probeEnvironmentFactory: async (sourceEnv) => makePreparedProbeEnvironment(sourceEnv),
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

test('runCodexProbe classifies auth-like timeouts as retryable timeout failures', async () => {
  const localPath = await mkdtemp(join(tmpdir(), 'benchmemo-codex-auth-timeout-'));

  const result = await runCodexProbe(makeRequest(localPath), {
    probeEnvironmentFactory: async (sourceEnv) => makePreparedProbeEnvironment(sourceEnv),
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
  assert.equal(result.failureKind, 'timeout');
  assert.equal(result.failurePhase, 'execution');
  assert.equal(result.retryable, true);
});

test('runCodexProbe classifies unauthorized non-zero exits as auth failures', async () => {
  const localPath = await mkdtemp(join(tmpdir(), 'benchmemo-codex-auth-exit-'));

  const result = await runCodexProbe(makeRequest(localPath), {
    probeEnvironmentFactory: async (sourceEnv) => makePreparedProbeEnvironment(sourceEnv),
    spawnFn() {
      const child = new FakeChild();

      queueMicrotask(() => {
        child.stderr.write('authentication failed: HTTP 403 Forbidden\n');
        child.stdout.end();
        child.stderr.end();
        child.exitCode = 1;
        child.emit('close', 1);
      });

      return child.asChildProcess();
    },
    timeoutMs: 1_000,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureKind, 'auth');
  assert.equal(result.failurePhase, 'execution');
  assert.equal(result.retryable, false);
});

test('runCodexProbe classifies connectivity failures as transport failures', async () => {
  const localPath = await mkdtemp(join(tmpdir(), 'benchmemo-codex-transport-exit-'));

  const result = await runCodexProbe(makeRequest(localPath), {
    probeEnvironmentFactory: async (sourceEnv) => makePreparedProbeEnvironment(sourceEnv),
    spawnFn() {
      const child = new FakeChild();

      queueMicrotask(() => {
        child.stderr.write('failed to connect to websocket: connection reset by peer\n');
        child.stdout.end();
        child.stderr.end();
        child.exitCode = 1;
        child.emit('close', 1);
      });

      return child.asChildProcess();
    },
    timeoutMs: 1_000,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureKind, 'transport');
  assert.equal(result.failurePhase, 'execution');
  assert.equal(result.retryable, true);
});

test('runCodexProbe returns stderr, event summaries, and diagnostics on non-zero exit', async () => {
  const localPath = await mkdtemp(join(tmpdir(), 'benchmemo-codex-failure-'));

  const result = await runCodexProbe(makeRequest(localPath), {
    probeEnvironmentFactory: async (sourceEnv) => makePreparedProbeEnvironment(sourceEnv),
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
  assert.match(result.eventSummary, /diagnostics:/);
  assert.match(result.eventSummary, /thread\.started/);
});

test('runCodexProbe returns invalid_output when structured output is unreadable', async () => {
  const localPath = await mkdtemp(join(tmpdir(), 'benchmemo-codex-invalid-output-'));

  const result = await runCodexProbe(makeRequest(localPath), {
    probeEnvironmentFactory: async (sourceEnv) => makePreparedProbeEnvironment(sourceEnv),
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
    probeType: 'repo_scan',
    repoName: 'jkordish/benchmemo',
    localPath,
    paths: ['apps/api'],
    question: 'Inspect repository impact and risk',
    outputSchemaName: 'repo-scan',
    sandbox: 'read-only',
  };
}

function makePreparedProbeEnvironment(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  overrides: Partial<PreparedCodexProbeEnvironment> = {}
): PreparedCodexProbeEnvironment {
  const probeHomeRoot = overrides.probeHomeRoot ?? '/tmp/benchmemo-probe-home';
  const codexHome = overrides.codexHome ?? `${probeHomeRoot}/.codex`;

  return {
    env: overrides.env ?? {
      ...sourceEnv,
      HOME: probeHomeRoot,
      CODEX_HOME: codexHome,
    },
    probeHomeRoot,
    codexHome,
    configPath: overrides.configPath ?? `${codexHome}/config.toml`,
    authSourcePath: overrides.authSourcePath ?? '/home/tester/.codex/auth.json',
    cleanup: overrides.cleanup ?? (async () => {}),
  };
}

function hasArgPair(args: string[], flag: string, value: string) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === flag && args[index + 1] === value) {
      return true;
    }
  }

  return false;
}

function getOutputPath(args: string[]) {
  const index = args.indexOf('--output-last-message');
  if (index === -1 || !args[index + 1]) {
    throw new Error('Missing --output-last-message argument');
  }

  return args[index + 1];
}

function getDiagnosticsPath(eventSummary: string) {
  const match = eventSummary.match(/diagnostics:([^|]+)/);
  if (!match?.[1]) {
    throw new Error(`Missing diagnostics path in event summary: ${eventSummary}`);
  }

  return match[1].trim();
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
