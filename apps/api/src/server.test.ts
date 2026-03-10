import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { TestContext } from 'node:test';
import {
  DecisionBrief,
  DecisionRunRecord,
  DecisionRunRecordSchema,
  FinalMemo,
  FinalMemoSchema,
  RepoProbeFailureSchema,
  RepoProbeResultSchema,
} from '@benchmemo/shared';
import { DecisionExecutor } from './decision-executor.js';
import { DecisionService } from './decision-service.js';
import { createBenchMemoServer } from './server.js';
import { FileDecisionStore } from './store/decision-store.js';

test('POST /decisions returns 202 and an accepted payload', async (t) => {
  const rawArtifactPath = await seedRawArtifact(t);
  const gate = createDeferred<void>();
  const harness = await startHarness(t, new SuccessfulExecutor(rawArtifactPath, gate.promise));

  const brief = makeBrief('dec_accept');
  const response = await postDecision(harness.baseUrl, brief);

  assert.equal(response.status, 202);
  const body = await response.json();
  assert.deepEqual(body, {
    id: brief.id,
    status: 'queued',
    location: `/decisions/${brief.id}`,
  });

  gate.resolve();
});

test('POST /decisions rejects invalid briefs with 400', async (t) => {
  const rawArtifactPath = await seedRawArtifact(t);
  const harness = await startHarness(t, new SuccessfulExecutor(rawArtifactPath));

  const response = await fetch(`${harness.baseUrl}/decisions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: 'bad',
      title: 'Bad brief',
      question: 'What now?',
      repo: {
        provider: 'github',
        repoName: 'acme/platform',
      },
      options: [{ id: 'only', name: 'Only', description: 'Not enough options' }],
      criteria: [{ id: 'risk', name: 'Risk', weight: 90 }],
      reversibility: 'reversible',
      horizon: 'weeks',
    }),
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /criteria|options/i);
});

test('POST /decisions rejects duplicate ids with 409', async (t) => {
  const rawArtifactPath = await seedRawArtifact(t);
  const harness = await startHarness(t, new SuccessfulExecutor(rawArtifactPath));
  const brief = makeBrief('dec_duplicate');

  const first = await postDecision(harness.baseUrl, brief);
  assert.equal(first.status, 202);

  const second = await postDecision(harness.baseUrl, brief);
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.match(body.error, /already exists/i);
});

test('GET /decisions/:id returns queued records', async (t) => {
  const rawArtifactPath = await seedRawArtifact(t);
  const harness = await startHarness(t, new SuccessfulExecutor(rawArtifactPath));
  const brief = makeBrief('dec_queued');
  await harness.store.create(brief);

  const response = await fetch(`${harness.baseUrl}/decisions/${brief.id}`);
  assert.equal(response.status, 200);

  const record = DecisionRunRecordSchema.parse(await response.json());
  assert.equal(record.status, 'queued');
  assert.equal(record.finalMemo, null);
  assert.deepEqual(record.events, []);
});

test('GET /decisions/:id returns running records while work is in flight', async (t) => {
  const rawArtifactPath = await seedRawArtifact(t);
  const gate = createDeferred<void>();
  const harness = await startHarness(t, new SuccessfulExecutor(rawArtifactPath, gate.promise));
  const brief = makeBrief('dec_running');

  const response = await postDecision(harness.baseUrl, brief);
  assert.equal(response.status, 202);

  const record = await waitForDecision(
    harness.baseUrl,
    brief.id,
    (candidate) => candidate.status === 'running'
  );

  assert.equal(record.status, 'running');
  assert.equal(record.finalMemo, null);
  assert.equal(record.startedAt !== null, true);

  gate.resolve();
});

test('GET /decisions/:id returns completed records with durable artifacts and final memo', async (t) => {
  const rawArtifactPath = await seedRawArtifact(t);
  const harness = await startHarness(t, new SuccessfulExecutor(rawArtifactPath));
  const brief = makeBrief('dec_completed');

  const response = await postDecision(harness.baseUrl, brief);
  assert.equal(response.status, 202);

  const record = await waitForDecision(
    harness.baseUrl,
    brief.id,
    (candidate) => candidate.status === 'completed'
  );

  assert.equal(record.status, 'completed');
  assert.equal(record.finalMemo?.decisionId, brief.id);
  assert.equal(record.error, null);
  assert.deepEqual(
    record.events.map((event) => event.step),
    ['received', 'framed', 'repo_probed', 'completed']
  );
  assert.deepEqual(
    record.artifactRefs.map((artifact) => artifact.step),
    ['framed', 'repo_probed', 'completed']
  );

  const repoProbedRef = record.artifactRefs.find((artifact) => artifact.step === 'repo_probed');
  assert.ok(repoProbedRef);

  const repoProbes = JSON.parse(await readFile(repoProbedRef.path, 'utf8')) as unknown;
  const parsedRepoProbes = RepoProbeResultSchema.array().parse(repoProbes);
  assert.equal(parsedRepoProbes.length, 1);
  assert.ok(
    parsedRepoProbes[0].rawArtifactPath.startsWith(
      join(harness.rootDir, 'artifacts', brief.id, 'repo-probes')
    )
  );

  const durableRawArtifact = JSON.parse(
    await readFile(parsedRepoProbes[0].rawArtifactPath, 'utf8')
  ) as Record<string, unknown>;
  assert.deepEqual(durableRawArtifact, {
    summary: 'repo probe raw artifact',
  });
});

test('GET /decisions/:id returns completed degraded records with evidence gaps', async (t) => {
  const harness = await startHarness(t, new DegradedExecutor());
  const brief = makeBrief('dec_degraded');

  const response = await postDecision(harness.baseUrl, brief);
  assert.equal(response.status, 202);

  const record = await waitForDecision(
    harness.baseUrl,
    brief.id,
    (candidate) => candidate.status === 'completed'
  );

  assert.equal(record.status, 'completed');
  assert.equal(record.error, null);
  assert.equal(record.finalMemo?.verdict, 'need_more_evidence');
  assert.equal(record.finalMemo?.recommendedOptionId, null);
  assert.ok(record.finalMemo?.evidenceGaps.some((gap) => /repo probe coverage/i.test(gap)));

  const repoProbedRef = record.artifactRefs.find((artifact) => artifact.step === 'repo_probed');
  assert.ok(repoProbedRef);

  const repoProbes = JSON.parse(await readFile(repoProbedRef.path, 'utf8')) as unknown;
  const failedProbe = RepoProbeFailureSchema.array().parse(repoProbes);
  assert.equal(failedProbe.length, 1);
  assert.equal(failedProbe[0].timedOut, true);
});

test('GET /decisions/:id returns failed records with partial history intact', async (t) => {
  const harness = await startHarness(t, new FailingExecutor());
  const brief = makeBrief('dec_failed');

  const response = await postDecision(harness.baseUrl, brief);
  assert.equal(response.status, 202);

  const record = await waitForDecision(
    harness.baseUrl,
    brief.id,
    (candidate) => candidate.status === 'failed'
  );

  assert.equal(record.status, 'failed');
  assert.equal(record.finalMemo, null);
  assert.equal(record.error?.message, 'Synthetic executor failure');
  assert.deepEqual(
    record.events.map((event) => event.step),
    ['received', 'framed']
  );
  assert.deepEqual(
    record.artifactRefs.map((artifact) => artifact.step),
    ['framed']
  );
});

async function startHarness(t: TestContext, executor: DecisionExecutor) {
  const rootDir = await mkdtemp(join(tmpdir(), 'benchmemo-api-'));
  const store = new FileDecisionStore(rootDir);
  const service = new DecisionService({ store, executor });
  const { server } = createBenchMemoServer({ service });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP port');
  }

  t.after(async () => {
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
    await rm(rootDir, { recursive: true, force: true });
  });

  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    rootDir,
    service,
    store,
  };
}

async function postDecision(baseUrl: string, brief: DecisionBrief) {
  return fetch(`${baseUrl}/decisions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(brief),
  });
}

async function waitForDecision(
  baseUrl: string,
  id: string,
  predicate: (record: DecisionRunRecord) => boolean,
  timeoutMs = 5_000
) {
  const deadline = Date.now() + timeoutMs;
  let lastRecord: DecisionRunRecord | null = null;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/decisions/${id}`);
    if (response.status === 200) {
      const record = DecisionRunRecordSchema.parse(await response.json());
      lastRecord = record;

      if (predicate(record)) {
        return record;
      }
    }

    await sleep(25);
  }

  throw new Error(`Timed out waiting for decision ${id}. Last record: ${JSON.stringify(lastRecord)}`);
}

function makeBrief(id: string): DecisionBrief {
  return {
    id,
    title: 'Extract billing service?',
    question: 'Should billing stay in the monolith or move into its own service?',
    repo: {
      provider: 'github',
      repoName: 'acme/platform',
      branch: 'main',
      localPath: process.cwd(),
      paths: ['services/billing', 'infra'],
    },
    options: [
      {
        id: 'opt_keep',
        name: 'Keep billing in monolith',
        description: 'Improve module boundaries without introducing a service split.',
      },
      {
        id: 'opt_split',
        name: 'Extract billing service',
        description: 'Create a standalone service for billing workflows.',
      },
    ],
    constraints: ['No customer-visible outage'],
    criteria: [
      { id: 'risk', name: 'Risk', weight: 60 },
      { id: 'velocity', name: 'Velocity', weight: 40 },
    ],
    reversibility: 'costly_reversible',
    horizon: 'quarters',
    attachments: [],
  };
}

function buildFinalMemo(brief: DecisionBrief): FinalMemo {
  return FinalMemoSchema.parse({
    decisionId: brief.id,
    verdict: 'approve',
    recommendedOptionId: brief.options[0].id,
    executiveSummary: 'Keep billing in the monolith for this quarter.',
    optionScores: [
      {
        optionId: brief.options[0].id,
        weightedTotal: 84,
        criterionScores: [
          {
            criterionId: 'risk',
            score: 4,
            rationale: 'Lower migration exposure.',
            evidenceIds: ['evidence_repo_1'],
          },
          {
            criterionId: 'velocity',
            score: 4,
            rationale: 'Less delivery churn.',
            evidenceIds: ['evidence_repo_1'],
          },
        ],
      },
      {
        optionId: brief.options[1].id,
        weightedTotal: 52,
        criterionScores: [
          {
            criterionId: 'risk',
            score: 2,
            rationale: 'Migration and rollback risk remain high.',
            evidenceIds: ['evidence_repo_2'],
          },
          {
            criterionId: 'velocity',
            score: 3,
            rationale: 'Longer-term velocity improves after the move.',
            evidenceIds: ['evidence_repo_2'],
          },
        ],
      },
    ],
    keyRisks: ['Migration rollback window is tight.'],
    dissent: [],
    evidenceGaps: [],
    nextSteps: ['Improve billing observability before revisiting the split.'],
  });
}

function buildDegradedMemo(brief: DecisionBrief): FinalMemo {
  return FinalMemoSchema.parse({
    ...buildFinalMemo(brief),
    verdict: 'need_more_evidence',
    recommendedOptionId: null,
    executiveSummary: 'Repository evidence is incomplete, so BenchMemo cannot make a reliable recommendation yet.',
    evidenceGaps: ['Keep billing in monolith is missing repo probe coverage for impact_scan. impact_scan: codex exec timed out after 30000ms'],
    nextSteps: ['Retry the missing repo probe and revisit the decision.'],
  });
}

class SuccessfulExecutor implements DecisionExecutor {
  constructor(
    private readonly rawArtifactPath: string,
    private readonly gate?: Promise<void>
  ) {}

  async run(
    brief: DecisionBrief,
    options: Parameters<DecisionExecutor['run']>[1]
  ): Promise<FinalMemo> {
    await options.onEvent?.({ step: 'received', message: 'Decision brief accepted' });

    await options.artifactStore?.save('framed', {
      decisionId: brief.id,
      normalizedQuestion: brief.question,
    });
    await options.onEvent?.({ step: 'framed', message: 'Decision framed' });

    await options.artifactStore?.save('repo_probed', [
      RepoProbeResultSchema.parse({
        taskId: `probe_${brief.id}`,
        decisionId: brief.id,
        optionId: brief.options[0].id,
        probeType: 'impact_scan',
        status: 'succeeded',
        attempts: 1,
        summary: 'Billing touches shared deploy infrastructure.',
        touchedAreas: ['services/billing'],
        hiddenDependencies: ['deploy pipeline'],
        likelyTestSurface: ['billing integration tests'],
        migrationHazards: ['state sync'],
        operationalRisks: ['on-call ownership'],
        estimatedComplexity: 'medium',
        confidence: 0.73,
        rawArtifactPath: this.rawArtifactPath,
      }),
    ]);
    await options.onEvent?.({ step: 'repo_probed', message: 'Codex repo probes completed' });

    if (this.gate) {
      await this.gate;
    }

    const finalMemo = buildFinalMemo(brief);
    await options.artifactStore?.save('completed', finalMemo);
    await options.onEvent?.({ step: 'completed', message: 'Decision run completed' });
    return finalMemo;
  }
}

class DegradedExecutor implements DecisionExecutor {
  async run(
    brief: DecisionBrief,
    options: Parameters<DecisionExecutor['run']>[1]
  ): Promise<FinalMemo> {
    await options.onEvent?.({ step: 'received', message: 'Decision brief accepted' });
    await options.artifactStore?.save('framed', {
      decisionId: brief.id,
      normalizedQuestion: brief.question,
    });
    await options.onEvent?.({ step: 'framed', message: 'Decision framed' });

    await options.artifactStore?.save('repo_probed', [
      RepoProbeFailureSchema.parse({
        taskId: `probe_fail_${brief.id}`,
        decisionId: brief.id,
        optionId: brief.options[0].id,
        probeType: 'impact_scan',
        status: 'failed',
        attempts: 2,
        errorMessage: 'codex exec timed out after 30000ms',
        timedOut: true,
        stderrSummary: '',
        eventSummary: 'thread.started',
        rawArtifactPath: null,
      }),
    ]);
    await options.onEvent?.({ step: 'repo_probed', message: 'Codex repo probes completed' });

    const finalMemo = buildDegradedMemo(brief);
    await options.artifactStore?.save('completed', finalMemo);
    await options.onEvent?.({ step: 'completed', message: 'Decision run completed' });
    return finalMemo;
  }
}

class FailingExecutor implements DecisionExecutor {
  async run(
    brief: DecisionBrief,
    options: Parameters<DecisionExecutor['run']>[1]
  ): Promise<FinalMemo> {
    await options.onEvent?.({ step: 'received', message: 'Decision brief accepted' });
    await options.artifactStore?.save('framed', {
      decisionId: brief.id,
      normalizedQuestion: brief.question,
    });
    await options.onEvent?.({ step: 'framed', message: 'Decision framed' });
    throw new Error('Synthetic executor failure');
  }
}

async function seedRawArtifact(t: TestContext) {
  const rootDir = await mkdtemp(join(tmpdir(), 'benchmemo-raw-artifact-'));
  const artifactPath = join(rootDir, 'artifact.json');
  await writeFile(artifactPath, JSON.stringify({ summary: 'repo probe raw artifact' }, null, 2));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });
  return artifactPath;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
