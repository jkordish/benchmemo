import assert from 'node:assert/strict';
import test from 'node:test';
import { type DecisionBrief, type DecisionRunRecord } from '@benchmemo/shared';
import { runCli, type LocalCliRunner } from './cli.js';

test('runCli runs a completed decision and prints progress plus the final memo', async () => {
  const stdout = createBuffer();
  const stderr = createBuffer();
  const brief = makeBrief('dec_cli_completed');

  const exitCode = await runCli(['run'], {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    buildBrief: async () => brief,
    createRunner: async () =>
      makeRunner('/tmp/benchmemo-data', async (_brief, options) => {
        await options?.onEvent?.({ step: 'received', message: 'Decision brief accepted' });
        await options?.onEvent?.({
          step: 'evidence_prepared',
          message: 'Evidence prepared (1 repo docs, 1 GitHub artifacts attached)',
        });
        await options?.onEvent?.({ step: 'repo_probed', message: 'Codex repo probes completed' });
        return makeCompletedRecord(brief, 'approve');
      }),
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.read(), /Starting BenchMemo run dec_cli_completed/);
  assert.match(stdout.read(), /\[received\] Decision brief accepted/);
  assert.match(stdout.read(), /\[evidence_prepared\] Evidence prepared/);
  assert.match(stdout.read(), /Verdict: approve/);
  assert.match(stdout.read(), /Run data: \/tmp\/benchmemo-data/);
  assert.equal(stderr.read(), '');
});

test('runCli exits successfully for need_more_evidence memos', async () => {
  const stdout = createBuffer();
  const brief = makeBrief('dec_cli_nme');

  const exitCode = await runCli(['run'], {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr: createBuffer(),
    buildBrief: async () => brief,
    createRunner: async () =>
      makeRunner('/tmp/benchmemo-data', async (_brief, options) => {
        await options?.onEvent?.({ step: 'received', message: 'Decision brief accepted' });
        return makeCompletedRecord(brief, 'need_more_evidence');
      }),
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.read(), /Verdict: need_more_evidence/);
  assert.match(stdout.read(), /Recommended option: none/);
});

test('runCli ignores a standalone double-dash separator from package-script invocation', async () => {
  const stdout = createBuffer();
  const brief = makeBrief('dec_cli_separator');

  const exitCode = await runCli(['--', 'run'], {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr: createBuffer(),
    buildBrief: async () => brief,
    createRunner: async () =>
      makeRunner('/tmp/benchmemo-data', async () => makeCompletedRecord(brief, 'approve')),
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.read(), /Starting BenchMemo run dec_cli_separator/);
});

test('runCli reports brief validation failures with field paths', async () => {
  const stderr = createBuffer();

  const exitCode = await runCli(['run'], {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout: createBuffer(),
    stderr,
    buildBrief: async () => ({
      id: 'bad',
      title: '',
      question: '',
    }),
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.read(), /Brief validation failed/);
  assert.match(stderr.read(), /title/i);
});

test('runCli rejects non-interactive terminals for guided mode', async () => {
  const stderr = createBuffer();

  const exitCode = await runCli(['run'], {
    stdinIsTTY: false,
    stdoutIsTTY: true,
    stdout: createBuffer(),
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.read(), /interactive terminal/i);
});

function makeBrief(id: string): DecisionBrief {
  return {
    id,
    title: 'Keep JSON store or move to SQLite?',
    question: 'Should BenchMemo keep file-backed storage or move to SQLite now?',
    repo: {
      provider: 'github',
      repoName: 'jkordish/benchmemo',
      branch: 'main',
      localPath: '/repo',
      paths: ['apps/api'],
    },
    options: [
      {
        id: 'opt_file',
        name: 'Keep file-backed persistence',
        description: 'Retain JSON-on-disk for the next milestone.',
      },
      {
        id: 'opt_sqlite',
        name: 'Move to SQLite now',
        description: 'Adopt SQLite before more product work.',
      },
    ],
    constraints: ['Keep local setup simple'],
    criteria: [
      { id: 'risk', name: 'Risk', weight: 55 },
      { id: 'velocity', name: 'Velocity', weight: 45 },
    ],
    reversibility: 'costly_reversible',
    horizon: 'weeks',
    attachments: [],
  };
}

function makeCompletedRecord(
  brief: DecisionBrief,
  verdict: 'approve' | 'need_more_evidence'
): DecisionRunRecord {
  return {
    id: brief.id,
    status: 'completed',
    brief,
    events: [],
    artifactRefs: [],
    finalMemo: {
      decisionId: brief.id,
      verdict,
      recommendedOptionId: verdict === 'approve' ? brief.options[0].id : null,
      executiveSummary: 'BenchMemo synthesized the current decision.',
      optionScores: [
        {
          optionId: brief.options[0].id,
          weightedTotal: 74,
          criterionScores: [
            {
              criterionId: 'risk',
              score: 3,
              rationale: 'Lower migration risk.',
              evidenceIds: ['e1'],
            },
          ],
        },
        {
          optionId: brief.options[1].id,
          weightedTotal: 48,
          criterionScores: [
            {
              criterionId: 'risk',
              score: 3,
              rationale: 'Potentially stronger persistence.',
              evidenceIds: ['e2'],
            },
          ],
        },
      ],
      keyRisks: ['Concurrent writes remain a risk.'],
      dissent: [],
      evidenceGaps: verdict === 'need_more_evidence' ? ['Missing operational evidence.'] : [],
      nextSteps: ['Gather the next tranche of persistence evidence.'],
    },
    error: null,
    createdAt: '2026-03-11T00:00:00.000Z',
    updatedAt: '2026-03-11T00:00:02.000Z',
    startedAt: '2026-03-11T00:00:00.500Z',
    completedAt: '2026-03-11T00:00:02.000Z',
    failedAt: null,
  };
}

function makeRunner(
  dataDir: string,
  runDecision: LocalCliRunner['runDecision']
): LocalCliRunner {
  return {
    dataDir,
    runDecision,
  };
}

function createBuffer() {
  let output = '';

  return {
    write(chunk: string) {
      output += chunk;
    },
    read() {
      return output;
    },
  };
}
