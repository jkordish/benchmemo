import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { TestContext } from 'node:test';
import {
  DecisionBrief,
  EvidencePreparationManifestSchema,
  FinalMemo,
  FinalMemoSchema,
  RepoProbeResultSchema,
} from '@benchmemo/shared';
import { DecisionExecutor } from './decision-executor.js';
import { DecisionService } from './decision-service.js';
import { EvidencePreparer, PreparedDecisionEvidence } from './evidence-preparer.js';
import { FileDecisionStore } from './store/decision-store.js';

test('DecisionService.runDecision persists a completed record and durable artifacts', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'benchmemo-service-'));
  const rawArtifactPath = await seedRawArtifact(t);
  const store = new FileDecisionStore(rootDir);
  const service = new DecisionService({
    store,
    executor: new SuccessfulExecutor(rawArtifactPath),
    evidencePreparer: new StubEvidencePreparer(),
  });

  t.after(async () => {
    await service.waitForIdle();
    await rm(rootDir, { recursive: true, force: true });
  });

  const events: string[] = [];
  const record = await service.runDecision(makeBrief('dec_service_completed'), {
    onEvent: async (event) => {
      events.push(event.step);
    },
  });

  assert.equal(record.status, 'completed');
  assert.equal(record.finalMemo?.decisionId, record.id);
  assert.equal(record.error, null);
  assert.deepEqual(events, ['received', 'evidence_prepared', 'framed', 'repo_probed', 'completed']);
  assert.equal(record.brief.attachments.length, 1);

  const persisted = await store.get(record.id);
  assert.ok(persisted);
  assert.equal(persisted.status, 'completed');
  assert.deepEqual(
    persisted.events.map((event) => event.step),
    ['received', 'evidence_prepared', 'framed', 'repo_probed', 'completed']
  );
  assert.equal(persisted.brief.attachments.length, 1);

  const evidencePreparedRef = persisted.artifactRefs.find(
    (artifact) => artifact.step === 'evidence_prepared'
  );
  assert.ok(evidencePreparedRef);

  const evidenceManifest = EvidencePreparationManifestSchema.parse(
    JSON.parse(await readFile(evidencePreparedRef.path, 'utf8')) as unknown
  );
  assert.equal(evidenceManifest.selectedSources.length, 2);
  assert.equal(evidenceManifest.attachments.length, 1);

  const repoProbedRef = persisted.artifactRefs.find((artifact) => artifact.step === 'repo_probed');
  assert.ok(repoProbedRef);

  const repoProbes = RepoProbeResultSchema.array().parse(
    JSON.parse(await readFile(repoProbedRef.path, 'utf8')) as unknown
  );
  assert.equal(repoProbes.length, 1);
  assert.ok(
    repoProbes[0].rawArtifactPath.startsWith(
      join(rootDir, 'artifacts', record.id, 'repo-probes')
    )
  );
});

test('DecisionService.runDecision returns a failed record when the executor throws', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'benchmemo-service-fail-'));
  const store = new FileDecisionStore(rootDir);
  const service = new DecisionService({
    store,
    executor: new FailingExecutor(),
    evidencePreparer: new StubEvidencePreparer(),
  });

  t.after(async () => {
    await service.waitForIdle();
    await rm(rootDir, { recursive: true, force: true });
  });

  const events: string[] = [];
  const record = await service.runDecision(makeBrief('dec_service_failed'), {
    onEvent: async (event) => {
      events.push(event.step);
    },
  });

  assert.equal(record.status, 'failed');
  assert.equal(record.finalMemo, null);
  assert.equal(record.error?.message, 'Synthetic executor failure');
  assert.deepEqual(events, ['received', 'evidence_prepared', 'framed']);

  const persisted = await store.get(record.id);
  assert.ok(persisted);
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.error?.message, 'Synthetic executor failure');
  assert.deepEqual(
    persisted.events.map((event) => event.step),
    ['received', 'evidence_prepared', 'framed']
  );
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
      localPath: process.cwd(),
      paths: ['apps/api', 'workers/codex-runner'],
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

function buildFinalMemo(brief: DecisionBrief): FinalMemo {
  return FinalMemoSchema.parse({
    decisionId: brief.id,
    verdict: 'approve',
    recommendedOptionId: brief.options[0].id,
    executiveSummary: 'Keep the current file-backed store for this milestone.',
    optionScores: [
      {
        optionId: brief.options[0].id,
        weightedTotal: 74,
        criterionScores: [
          {
            criterionId: 'risk',
            score: 3,
            rationale: 'Avoids migration risk.',
            evidenceIds: ['e1'],
          },
          {
            criterionId: 'velocity',
            score: 4,
            rationale: 'Keeps the current delivery path intact.',
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
            rationale: 'Potentially better durability but higher cutover risk.',
            evidenceIds: ['e2'],
          },
          {
            criterionId: 'velocity',
            score: 2,
            rationale: 'Would slow the current milestone.',
            evidenceIds: ['e2'],
          },
        ],
      },
    ],
    keyRisks: ['The current file store has concurrency limitations.'],
    dissent: [],
    evidenceGaps: [],
    nextSteps: ['Revisit SQLite if the next milestone needs stronger persistence semantics.'],
  });
}

class SuccessfulExecutor implements DecisionExecutor {
  constructor(private readonly rawArtifactPath: string) {}

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
        probeType: 'repo_scan',
        status: 'succeeded',
        attempts: 1,
        summary: 'Persistence touches both the API and worker flows.',
        touchedAreas: ['apps/api', 'workers/codex-runner'],
        hiddenDependencies: ['artifact layout'],
        likelyTestSurface: ['decision-service tests'],
        migrationHazards: ['artifact-path compatibility'],
        operationalRisks: ['concurrent writes'],
        estimatedComplexity: 'medium',
        confidence: 0.8,
        rawArtifactPath: this.rawArtifactPath,
      }),
    ]);
    await options.onEvent?.({ step: 'repo_probed', message: 'Codex repo probes completed' });

    const finalMemo = buildFinalMemo(brief);
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

class StubEvidencePreparer implements EvidencePreparer {
  async prepare(brief: DecisionBrief): Promise<PreparedDecisionEvidence> {
    return {
      brief: {
        ...brief,
        attachments: [
          {
            fileId: 'file_docs_1',
            vectorStoreId: 'vs_docs_1',
          },
        ],
      },
      manifest: EvidencePreparationManifestSchema.parse({
        decisionId: brief.id,
        repoDocumentsDiscovered: 1,
        githubArtifactsDiscovered: 1,
        selectedSources: [
          {
            id: 'repo_doc:README.md',
            kind: 'repo_doc',
            title: 'README',
            locator: 'README.md',
            score: 100,
            retrievedAt: '2026-03-11T00:00:00.000Z',
            attachmentFileId: 'file_docs_1',
          },
          {
            id: 'github_issue:42',
            kind: 'github_issue',
            title: 'Issue #42: Improve memo clarity',
            locator: 'https://github.com/jkordish/benchmemo/issues/42',
            score: 17,
            retrievedAt: '2026-03-11T00:00:00.000Z',
            attachmentFileId: null,
          },
        ],
        skippedSources: [],
        warnings: [],
        attachments: [
          {
            fileId: 'file_docs_1',
            vectorStoreId: 'vs_docs_1',
          },
        ],
        vectorStoreId: 'vs_docs_1',
      }),
    };
  }
}

async function seedRawArtifact(t: TestContext) {
  const rootDir = await mkdtemp(join(tmpdir(), 'benchmemo-service-raw-'));
  const artifactPath = join(rootDir, 'artifact.json');
  await writeFile(artifactPath, JSON.stringify({ summary: 'repo probe raw artifact' }, null, 2));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });
  return artifactPath;
}
