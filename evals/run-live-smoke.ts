import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBenchMemoServer } from '../apps/api/src/server.js';
import {
  DecisionBrief,
  DecisionRunRecord,
  RepoProbeFailure,
  DecisionRunRecordSchema,
  RepoProbeOutcomeSchema,
} from '../packages/shared/src/schemas.js';
import { runCodexPreflight } from '../workers/codex-runner/src/preflight.js';

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

async function main() {
  const preflight = await runCodexPreflight();
  if (!preflight.ok) {
    console.log('SKIPPED live smoke eval');
    for (const check of preflight.checks) {
      console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.summary}`);
    }
    process.exit(0);
  }

  const timeoutMs = getLiveEvalTimeoutMs();
  const dataDir = await mkdtemp(join(tmpdir(), 'benchmemo-live-eval-'));
  const { server, service } = createBenchMemoServer({ dataDir });

  try {
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Live smoke server did not expose a TCP port');
    }

    const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
    const brief = buildBrief();
    const runStartedAt = Date.now();
    const createResponse = await fetch(`${baseUrl}/decisions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(brief),
    });

    if (createResponse.status !== 202) {
      throw new Error(`Expected 202 from POST /decisions, got ${createResponse.status}`);
    }

    const record = await waitForDecision(baseUrl, brief.id, timeoutMs, runStartedAt);
    if (record.status !== 'completed') {
      throw new Error(`Live smoke decision ended with status ${record.status}`);
    }

    const repoProbedRef = record.artifactRefs.find((artifact) => artifact.step === 'repo_probed');
    if (!repoProbedRef) {
      throw new Error('Live smoke decision completed without a repo_probed artifact');
    }

    const repoProbeArtifact = JSON.parse(await readFile(repoProbedRef.path, 'utf8')) as unknown;
    if (!Array.isArray(repoProbeArtifact)) {
      throw new Error('repo_probed artifact is not an array');
    }

    const repoProbes = repoProbeArtifact.map((entry) => RepoProbeOutcomeSchema.parse(entry));
    const failures = repoProbes.filter(
      (probe): probe is RepoProbeFailure => probe.status === 'failed'
    );

    if (failures.length > 0) {
      const failureSummary = summarizeFailures(failures);
      const timingSummary = summarizeTiming(record, runStartedAt);
      console.log('FAIL live smoke eval');
      console.log(`Decision ${brief.id} completed in ${timingSummary.runElapsed}, but repo probes failed: ${failureSummary}`);
      console.log(`Timing: ${timingSummary.summary}`);
      process.exit(1);
    }

    const timingSummary = summarizeTiming(record, runStartedAt);
    console.log('PASS live smoke eval');
    console.log(`Decision ${brief.id} completed with verdict ${record.finalMemo?.verdict ?? 'unknown'}`);
    console.log(`Timing: ${timingSummary.summary}`);
    console.log(`Repo probes succeeded: ${repoProbes.length}/${repoProbes.length}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    await service.waitForIdle();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function buildBrief(): DecisionBrief {
  return {
    id: `eval_live_${Date.now()}`,
    title: 'Keep JSON store or move to SQLite?',
    question: 'Should BenchMemo keep file-backed persistence for the next milestone, or move to SQLite now?',
    repo: {
      provider: 'github',
      repoName: 'jkordish/benchmemo',
      branch: 'main',
      localPath: process.cwd(),
      paths: ['apps/api', 'workers/codex-runner', 'packages/shared'],
    },
    options: [
      {
        id: 'opt_file',
        name: 'Keep file-backed persistence',
        description: 'Retain JSON-on-disk for the next milestone and prioritize delivery speed.',
      },
      {
        id: 'opt_sqlite',
        name: 'Move to SQLite now',
        description: 'Adopt SQLite before more product work to improve persistence durability.',
      },
    ],
    constraints: ['Keep local setup simple', 'Avoid derailing the next milestone'],
    criteria: [
      { id: 'risk', name: 'Risk', weight: 55 },
      { id: 'velocity', name: 'Velocity', weight: 45 },
    ],
    reversibility: 'costly_reversible',
    horizon: 'weeks',
    attachments: [],
  };
}

async function listen(server: ReturnType<typeof createBenchMemoServer>['server']) {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
}

async function waitForDecision(
  baseUrl: string,
  id: string,
  timeoutMs: number,
  fallbackStartedAtMs: number
) {
  const deadline = Date.now() + timeoutMs;
  let lastBody: DecisionRunRecord | null = null;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/decisions/${id}`);
    if (response.status !== 200) {
      throw new Error(`Expected 200 from GET /decisions/${id}, got ${response.status}`);
    }

    const body = DecisionRunRecordSchema.parse(await response.json());
    lastBody = body;

    if (body.status === 'completed' || body.status === 'failed') {
      return body;
    }

    await sleep(2_000);
  }

  if (lastBody) {
    const timingSummary = summarizeTiming(lastBody, fallbackStartedAtMs);
    const lastStep = lastBody.events.at(-1)?.step ?? 'unknown';
    throw new Error(
      `Timed out waiting for live smoke decision ${id} after ${formatDuration(timeoutMs)} (status ${lastBody.status}, last step ${lastStep}, timing: ${timingSummary.summary})`
    );
  }

  throw new Error(`Timed out waiting for live smoke decision ${id} after ${formatDuration(timeoutMs)}`);
}

function summarizeFailures(failures: RepoProbeFailure[]) {
  const counts = new Map<string, { count: number; example: string }>();

  for (const failure of failures) {
    const key = `${failure.failurePhase}:${failure.failureKind}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }

    counts.set(key, {
      count: 1,
      example: truncate(normalizeWhitespace(failure.errorMessage), 100),
    });
  }

  return Array.from(counts.entries())
    .map(([key, summary]) => `${key} x${summary.count} (example: ${summary.example})`)
    .join(', ');
}

function summarizeTiming(record: DecisionRunRecord, fallbackStartedAtMs: number) {
  const runStartedAtMs = parseDate(record.startedAt) ?? fallbackStartedAtMs;
  const runCompletedAtMs = parseDate(record.completedAt) ?? Date.now();
  const casesBuiltAtMs = parseEventTime(record.events, 'cases_built');
  const repoProbedAtMs = parseEventTime(record.events, 'repo_probed');
  const runElapsedMs = Math.max(0, runCompletedAtMs - runStartedAtMs);
  const repoProbeElapsedMs =
    casesBuiltAtMs !== null && repoProbedAtMs !== null ? Math.max(0, repoProbedAtMs - casesBuiltAtMs) : null;

  return {
    runElapsed: formatDuration(runElapsedMs),
    summary:
      repoProbeElapsedMs === null
        ? `run ${formatDuration(runElapsedMs)}`
        : `run ${formatDuration(runElapsedMs)}, repo probe stage ${formatDuration(repoProbeElapsedMs)}`,
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getLiveEvalTimeoutMs() {
  const raw = process.env.BENCHMEMO_LIVE_EVAL_TIMEOUT_MS;
  if (!raw) {
    return 360_000;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 10_000) {
    return 360_000;
  }

  return Math.floor(value);
}

function parseEventTime(
  events: DecisionRunRecord['events'],
  step: DecisionRunRecord['events'][number]['step']
) {
  const event = events.find((entry) => entry.step === step);
  return event ? parseDate(event.at) : null;
}

function parseDate(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDuration(ms: number) {
  if (ms < 1_000) {
    return `${ms}ms`;
  }

  const totalSeconds = Math.round(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}
