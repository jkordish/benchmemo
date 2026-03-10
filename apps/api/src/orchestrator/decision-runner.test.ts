import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from '@openai/agents';
import { DecisionBrief, EvidenceBundle, JudgeDraft, RepoProbeFailure, RepoProbeResult } from '@benchmemo/shared';
import { DecisionRunner } from './decision-runner.js';

test('DecisionRunner degrades to need_more_evidence when required repo probes are incomplete', async () => {
  const brief = makeBrief('dec_runner_degraded');
  const events: string[] = [];
  const artifacts = new Map<string, unknown>();

  const runner = new DecisionRunner({
    onEvent: async (event) => {
      events.push(event.step);
    },
    artifactStore: {
      save: async (step, artifact) => {
        artifacts.set(step, artifact);
      },
    },
    runAgent: makeRunAgent({
      requiredEvidence: ['repo'],
      judgeVerdict: 'approve',
      judgeRecommendation: brief.options[0].id,
    }),
    runRepoProbes: async () => [
      makeSucceededProbe(brief.id, brief.options[0].id, 'impact_scan'),
      makeFailedProbe(brief.id, brief.options[0].id, 'risk_scan'),
      makeSucceededProbe(brief.id, brief.options[1].id, 'impact_scan'),
      makeSucceededProbe(brief.id, brief.options[1].id, 'risk_scan'),
    ],
  });

  const memo = await runner.run(brief);

  assert.equal(memo.verdict, 'need_more_evidence');
  assert.equal(memo.recommendedOptionId, null);
  assert.match(memo.executiveSummary, /required repository evidence is incomplete/i);
  assert.ok(memo.evidenceGaps.some((gap) => /missing repo probe coverage/i.test(gap)));
  assert.ok(
    memo.nextSteps.some((step) =>
      /increase `BENCHMEMO_CODEX_PROBE_TIMEOUT_MS`|narrow the repo scope/i.test(step)
    )
  );
  assert.deepEqual(events, [
    'received',
    'framed',
    'cases_built',
    'repo_probed',
    'evidence_verified',
    'judged',
    'completed',
  ]);
  assert.ok(Array.isArray(artifacts.get('repo_probed')));
});

test('DecisionRunner preserves judge verdict when repo evidence is complete', async () => {
  const brief = makeBrief('dec_runner_complete');

  const runner = new DecisionRunner({
    runAgent: makeRunAgent({
      requiredEvidence: ['repo'],
      judgeVerdict: 'approve',
      judgeRecommendation: brief.options[0].id,
    }),
    runRepoProbes: async () => [
      makeSucceededProbe(brief.id, brief.options[0].id, 'impact_scan'),
      makeSucceededProbe(brief.id, brief.options[0].id, 'risk_scan'),
      makeSucceededProbe(brief.id, brief.options[1].id, 'impact_scan'),
      makeSucceededProbe(brief.id, brief.options[1].id, 'risk_scan'),
    ],
  });

  const memo = await runner.run(brief);

  assert.equal(memo.verdict, 'approve');
  assert.equal(memo.recommendedOptionId, brief.options[0].id);
  assert.equal(memo.evidenceGaps.length, 0);
});

test('DecisionRunner deduplicates repeated platform failures into one shared repo gap', async () => {
  const brief = makeBrief('dec_runner_auth_gap');

  const runner = new DecisionRunner({
    runAgent: makeRunAgent({
      requiredEvidence: ['repo'],
      judgeVerdict: 'need_more_evidence',
      judgeRecommendation: null,
    }),
    runRepoProbes: async () => [
      makeFailedProbe(brief.id, brief.options[0].id, 'impact_scan', {
        failureKind: 'auth',
        failurePhase: 'execution',
        retryable: false,
        errorMessage: 'Codex login is not ready.',
      }),
      makeFailedProbe(brief.id, brief.options[0].id, 'risk_scan', {
        failureKind: 'auth',
        failurePhase: 'execution',
        retryable: false,
        errorMessage: 'Codex login is not ready.',
      }),
      makeFailedProbe(brief.id, brief.options[1].id, 'impact_scan', {
        failureKind: 'auth',
        failurePhase: 'execution',
        retryable: false,
        errorMessage: 'Codex login is not ready.',
      }),
      makeFailedProbe(brief.id, brief.options[1].id, 'risk_scan', {
        failureKind: 'auth',
        failurePhase: 'execution',
        retryable: false,
        errorMessage: 'Codex login is not ready.',
      }),
    ],
  });

  const memo = await runner.run(brief);

  const authGapCount = memo.evidenceGaps.filter((gap) => /authentication issue/i.test(gap)).length;
  assert.equal(authGapCount, 1);
  assert.ok(memo.nextSteps.some((step) => /pnpm doctor/i.test(step)));
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
    constraints: ['Keep setup simple'],
    criteria: [
      { id: 'risk', name: 'Risk', weight: 60 },
      { id: 'velocity', name: 'Velocity', weight: 40 },
    ],
    reversibility: 'costly_reversible',
    horizon: 'weeks',
    attachments: [],
  };
}

function makeRunAgent(input: {
  requiredEvidence: Array<'repo' | 'docs' | 'web'>;
  judgeVerdict: JudgeDraft['verdict'];
  judgeRecommendation: string | null;
}) {
  const claimIds: string[] = [];

  return (async (agent, payload) => {
    const body = JSON.parse(payload as string) as Record<string, unknown>;

    switch (agent.name) {
      case 'Frame Agent':
        return {
          finalOutput: {
            decisionId: String((body.brief as DecisionBrief).id),
            normalizedQuestion: String((body.brief as DecisionBrief).question),
            options: (body.brief as DecisionBrief).options,
            constraints: (body.brief as DecisionBrief).constraints,
            criteria: (body.brief as DecisionBrief).criteria.map((criterion) => ({
              ...criterion,
              scoringGuidance: `Score ${criterion.name} using repository and delivery evidence.`,
            })),
            unknowns: [],
            requiredEvidence: input.requiredEvidence,
            notesForAgents: [],
          },
        };
      case 'Advocate Agent': {
        const frame = body.frame as { decisionId: string };
        const option = body.option as { id: string; description: string };
        const claimId = `adv_${option.id}`;
        claimIds.push(claimId);
        return {
          finalOutput: {
            decisionId: frame.decisionId,
            optionId: option.id,
            summary: `Advocate case for ${option.id}`,
            claims: [
              {
                id: claimId,
                decisionId: frame.decisionId,
                optionId: option.id,
                sourceAgent: 'advocate',
                stance: 'pro',
                text: `Reason to choose ${option.id}`,
                rationale: option.description,
                requiresEvidence: ['repo'],
                severity: 'medium',
                confidence: 0.7,
                status: 'unverified',
              },
            ],
            assumptions: [],
          },
        };
      }
      case 'Skeptic Agent': {
        const frame = body.frame as { decisionId: string };
        const option = body.option as { id: string; description: string };
        const claimId = `ske_${option.id}`;
        claimIds.push(claimId);
        return {
          finalOutput: {
            decisionId: frame.decisionId,
            optionId: option.id,
            summary: `Skeptic case for ${option.id}`,
            claims: [
              {
                id: claimId,
                decisionId: frame.decisionId,
                optionId: option.id,
                sourceAgent: 'skeptic',
                stance: 'con',
                text: `Risk for ${option.id}`,
                rationale: option.description,
                requiresEvidence: ['repo'],
                severity: 'medium',
                confidence: 0.6,
                status: 'unverified',
              },
            ],
            unknowns: [],
          },
        };
      }
      case 'Evidence Agent': {
        const frame = body.frame as { decisionId: string };
        const result: EvidenceBundle = {
          decisionId: frame.decisionId,
          evidenceItems: [],
          claimStatuses: claimIds.map((claimId) => ({
            claimId,
            status: 'unresolved',
            evidenceIds: [],
            notes: 'Repository evidence incomplete or not decisive.',
          })),
          unresolvedQuestions: [],
        };
        return { finalOutput: result };
      }
      case 'Judge Agent': {
        const frame = body.frame as { decisionId: string; options: Array<{ id: string }>; criteria: Array<{ id: string }> };
        const result: JudgeDraft = {
          decisionId: frame.decisionId,
          verdict: input.judgeVerdict,
          recommendedOptionId: input.judgeRecommendation,
          executiveSummary: 'Judge prefers the lower-risk path.',
          optionScores: frame.options.map((option, optionIndex) => ({
            optionId: option.id,
            criterionScores: frame.criteria.map((criterion) => ({
              criterionId: criterion.id,
              score: optionIndex === 0 ? 4 : 3,
              rationale: `Score for ${option.id} on ${criterion.id}`,
              evidenceIds: [],
            })),
          })),
          keyRisks: [],
          dissent: [],
          evidenceGaps: [],
          nextSteps: [],
        };
        return { finalOutput: result };
      }
      default:
        throw new Error(`Unexpected agent: ${agent.name}`);
    }
  }) as typeof run;
}

function makeSucceededProbe(
  decisionId: string,
  optionId: string,
  probeType: RepoProbeResult['probeType']
): RepoProbeResult {
  return {
    taskId: `${optionId}_${probeType}`,
    decisionId,
    optionId,
    probeType,
    status: 'succeeded',
    attempts: 1,
    summary: `Succeeded ${probeType}`,
    touchedAreas: ['apps/api'],
    hiddenDependencies: [],
    likelyTestSurface: [],
    migrationHazards: [],
    operationalRisks: [],
    estimatedComplexity: 'medium',
    confidence: 0.7,
    rawArtifactPath: `/tmp/${optionId}_${probeType}.json`,
  };
}

function makeFailedProbe(
  decisionId: string,
  optionId: string,
  probeType: RepoProbeFailure['probeType'],
  overrides: Partial<RepoProbeFailure> = {}
): RepoProbeFailure {
  return {
    taskId: `${optionId}_${probeType}_failed`,
    decisionId,
    optionId,
    probeType,
    status: 'failed',
    attempts: 2,
    errorMessage: 'codex exec timed out after 30000ms',
    failureKind: 'timeout',
    failurePhase: 'execution',
    retryable: true,
    timedOut: true,
    stderrSummary: '',
    eventSummary: 'thread.started',
    rawArtifactPath: null,
    ...overrides,
  };
}
