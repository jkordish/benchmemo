import assert from 'node:assert/strict';
import test from 'node:test';
import { RepoProbeFailure, RepoProbeRequest, RepoProbeResult } from '@benchmemo/shared';
import { mapWithConcurrency, runProbeWithRetry } from './repo-probes.js';

test('mapWithConcurrency respects the concurrency cap and preserves order', async () => {
  const items = [30, 5, 20, 10, 15];
  let inFlight = 0;
  let maxInFlight = 0;

  const results = await mapWithConcurrency(items, 2, async (delay, index) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(delay);
    inFlight -= 1;
    return `result_${index}`;
  });

  assert.equal(maxInFlight, 2);
  assert.deepEqual(results, ['result_0', 'result_1', 'result_2', 'result_3', 'result_4']);
});

test('runProbeWithRetry retries once and returns the second successful outcome', async () => {
  const request = makeRequest();
  let calls = 0;

  const result = await runProbeWithRetry(request, {
    runProbe: async () => {
      calls += 1;
      if (calls === 1) {
        return makeFailure(request, 1);
      }

      return makeSuccess(request, 1);
    },
    maxAttempts: 2,
    retryBackoffMs: 0,
  });

  assert.equal(calls, 2);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.attempts, 2);
});

test('runProbeWithRetry returns the final failed outcome when retries are exhausted', async () => {
  const request = makeRequest();
  let calls = 0;

  const result = await runProbeWithRetry(request, {
    runProbe: async () => {
      calls += 1;
      return makeFailure(request, calls);
    },
    maxAttempts: 2,
    retryBackoffMs: 0,
  });

  assert.equal(calls, 2);
  assert.equal(result.status, 'failed');
  assert.equal(result.attempts, 2);
  assert.equal(result.timedOut, true);
});

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeRequest(): RepoProbeRequest {
  return {
    decisionId: 'dec_probe',
    optionId: 'opt_file',
    probeType: 'impact_scan',
    repoName: 'jkordish/benchmemo',
    localPath: process.cwd(),
    paths: ['apps/api'],
    question: 'Inspect impact',
    outputSchemaName: 'impact-scan',
    sandbox: 'read-only',
  };
}

function makeSuccess(request: RepoProbeRequest, attempts: number): RepoProbeResult {
  return {
    taskId: `task_${attempts}`,
    decisionId: request.decisionId,
    optionId: request.optionId,
    probeType: request.probeType,
    status: 'succeeded',
    attempts,
    summary: 'Looks contained.',
    touchedAreas: ['apps/api'],
    hiddenDependencies: [],
    likelyTestSurface: [],
    migrationHazards: [],
    operationalRisks: [],
    estimatedComplexity: 'low',
    confidence: 0.8,
    rawArtifactPath: '/tmp/probe.json',
  };
}

function makeFailure(request: RepoProbeRequest, attempts: number): RepoProbeFailure {
  return {
    taskId: `task_fail_${attempts}`,
    decisionId: request.decisionId,
    optionId: request.optionId,
    probeType: request.probeType,
    status: 'failed',
    attempts,
    errorMessage: 'codex exec timed out after 30000ms',
    timedOut: true,
    stderrSummary: '',
    eventSummary: 'thread.started',
    rawArtifactPath: null,
  };
}
