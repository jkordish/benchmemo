import { RepoProbeFailureSchema, RepoProbeOutcome, RepoProbeRequest } from '@benchmemo/shared';
import { runCodexPreflight, runCodexProbe, type CodexPreflightResult } from '@benchmemo/codex-runner';

const DEFAULT_MAX_PARALLEL_PROBES = 1;
const DEFAULT_CODEX_PROBE_MAX_ATTEMPTS = 1;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;

export interface RunRepoProbesOptions {
  preflight?: () => Promise<CodexPreflightResult>;
  runProbe?: (request: RepoProbeRequest) => Promise<RepoProbeOutcome>;
  concurrency?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
}

export async function runRepoProbes(
  requests: RepoProbeRequest[],
  options: RunRepoProbesOptions = {}
) {
  const preflight = options.preflight ?? runCodexPreflight;
  const runProbe = options.runProbe ?? runCodexProbe;
  const concurrency = options.concurrency ?? getMaxParallelProbes();
  const maxAttempts = options.maxAttempts ?? getCodexProbeMaxAttempts();
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const preflightResult = await preflight();
  const preflightFailure = preflightResult.failure;

  if (!preflightResult.ok && preflightFailure) {
    return requests.map((request) =>
      RepoProbeFailureSchema.parse({
        taskId: buildPreflightTaskId(request),
        decisionId: request.decisionId,
        optionId: request.optionId,
        probeType: request.probeType,
        status: 'failed',
        attempts: 1,
        errorMessage: preflightFailure.errorMessage,
        failureKind: preflightFailure.failureKind,
        failurePhase: 'preflight',
        retryable: preflightFailure.retryable,
        timedOut: false,
        stderrSummary: preflightFailure.stderrSummary,
        eventSummary: preflightFailure.eventSummary,
        rawArtifactPath: null,
      })
    );
  }

  return mapWithConcurrency(requests, concurrency, async (request) =>
    runProbeWithRetry(request, {
      runProbe,
      maxAttempts,
      retryBackoffMs,
    })
  );
}

export function getMaxParallelProbes() {
  const raw = process.env.BENCHMEMO_MAX_PARALLEL_PROBES;
  if (!raw) {
    return DEFAULT_MAX_PARALLEL_PROBES;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_PARALLEL_PROBES;
  }

  return Math.floor(value);
}

export function getCodexProbeMaxAttempts() {
  const raw = process.env.BENCHMEMO_CODEX_PROBE_MAX_ATTEMPTS;
  if (!raw) {
    return DEFAULT_CODEX_PROBE_MAX_ATTEMPTS;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_CODEX_PROBE_MAX_ATTEMPTS;
  }

  return Math.floor(value);
}

export async function runProbeWithRetry(
  request: RepoProbeRequest,
  options: Required<Pick<RunRepoProbesOptions, 'runProbe' | 'maxAttempts' | 'retryBackoffMs'>>
) {
  let latestFailure: RepoProbeOutcome | null = null;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const outcome = await options.runProbe(request);

    if (outcome.status === 'succeeded') {
      return {
        ...outcome,
        attempts: attempt,
      };
    }

    latestFailure = {
      ...outcome,
      attempts: attempt,
    };

    if (!outcome.retryable) {
      return latestFailure;
    }

    if (attempt < options.maxAttempts) {
      await sleep(options.retryBackoffMs);
    }
  }

  if (!latestFailure) {
    throw new Error('Probe retry loop completed without producing an outcome');
  }

  return latestFailure;
}

export async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>
) {
  if (items.length === 0) {
    return [] as TOutput[];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
  return results;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildPreflightTaskId(request: RepoProbeRequest) {
  return `preflight_${request.decisionId}_${request.optionId}_${request.probeType}`;
}
