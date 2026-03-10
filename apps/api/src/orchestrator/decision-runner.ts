import { run } from '@openai/agents';
import {
  Claim,
  DecisionBrief,
  DecisionBriefSchema,
  DecisionFrame,
  DecisionFrameSchema,
  DecisionRunEvent,
  DecisionRunStep,
  EvidenceBundleSchema,
  FinalMemo,
  FinalMemoSchema,
  JudgeDraft,
  JudgeDraftSchema,
  OptionCaseDraftSchema,
  RepoProbeCoverage,
  RepoProbeRequest,
  RepoProbeOutcome,
  RiskCaseDraftSchema,
} from '@benchmemo/shared';
import {
  buildAdvocateAgent,
  buildEvidenceAgent,
  buildFrameAgent,
  buildJudgeAgent,
  buildSkepticAgent,
} from '../agents/index.js';
import { runRepoProbes } from './repo-probes.js';

export interface ArtifactStore {
  save(step: DecisionRunStep, artifact: unknown): Promise<void>;
}

export class NullArtifactStore implements ArtifactStore {
  async save(_step: DecisionRunStep, _artifact: unknown): Promise<void> {
    return;
  }
}

export type DecisionRunnerEvent = Pick<DecisionRunEvent, 'step' | 'message'>;

export interface DecisionRunnerOptions {
  onEvent?: (event: DecisionRunnerEvent) => Promise<void> | void;
  artifactStore?: ArtifactStore;
  runAgent?: typeof run;
  runRepoProbes?: (requests: RepoProbeRequest[]) => Promise<RepoProbeOutcome[]>;
}

export class DecisionRunner {
  private readonly onEvent?: DecisionRunnerOptions['onEvent'];
  private readonly artifactStore: ArtifactStore;
  private readonly runAgent: typeof run;
  private readonly runRepoProbes: (requests: RepoProbeRequest[]) => Promise<RepoProbeOutcome[]>;

  constructor(options: DecisionRunnerOptions = {}) {
    this.onEvent = options.onEvent;
    this.artifactStore = options.artifactStore ?? new NullArtifactStore();
    this.runAgent = options.runAgent ?? run;
    this.runRepoProbes = options.runRepoProbes ?? runRepoProbes;
  }

  async run(input: DecisionBrief): Promise<FinalMemo> {
    const brief = DecisionBriefSchema.parse(input);
    await this.emit('received', 'Decision brief accepted');

    const vectorStoreIds = brief.attachments.map((item) => item.vectorStoreId);
    const context = {
      vectorStoreIds,
      domainLabel: 'engineering-decisions',
    };

    const frameAgent = buildFrameAgent();
    const advocateAgent = buildAdvocateAgent();
    const skepticAgent = buildSkepticAgent();
    const evidenceAgent = buildEvidenceAgent(vectorStoreIds);
    const judgeAgent = buildJudgeAgent();

    const frameInput = JSON.stringify({
      brief,
      instruction: 'Normalize this decision into an explicit frame.',
    });

    const frameResult = await this.runAgent(frameAgent, frameInput, { context });
    const frame = DecisionFrameSchema.parse(frameResult.finalOutput);
    await this.persist('framed', frame, 'Decision framed');

    const optionWork = await Promise.all(
      frame.options.map(async (option) => {
        const advocateInput = JSON.stringify({
          frame,
          option,
          instruction: 'Generate the strongest case for this option.',
        });

        const skepticInput = JSON.stringify({
          frame,
          option,
          instruction: 'Generate the strongest technical critique of this option.',
        });

        const [advocateResult, skepticResult] = await Promise.all([
          this.runAgent(advocateAgent, advocateInput, { context }),
          this.runAgent(skepticAgent, skepticInput, { context }),
        ]);

        return {
          optionId: option.id,
          advocate: OptionCaseDraftSchema.parse(advocateResult.finalOutput),
          skeptic: RiskCaseDraftSchema.parse(skepticResult.finalOutput),
        };
      })
    );

    await this.persist('cases_built', optionWork, 'Advocate and skeptic cases built');

    const repoProbeRequests = frame.options.flatMap((option) => {
      const baseReq = {
        decisionId: frame.decisionId,
        optionId: option.id,
        repoName: brief.repo.repoName,
        localPath: brief.repo.localPath,
        branch: brief.repo.branch,
        paths: brief.repo.paths,
        sandbox: 'read-only' as const,
      };

      const impact: RepoProbeRequest = {
        ...baseReq,
        probeType: 'impact_scan',
        question: `Analyze repository impact for option ${option.name}: ${option.description}`,
        outputSchemaName: 'impact-scan',
      };

      const risk: RepoProbeRequest = {
        ...baseReq,
        probeType: 'risk_scan',
        question: `Analyze operational and migration risk for option ${option.name}: ${option.description}`,
        outputSchemaName: 'risk-scan',
      };

      return [impact, risk];
    });

    const repoProbes = await this.runRepoProbes(repoProbeRequests);
    const repoProbeCoverage = this.buildRepoProbeCoverage(frame, repoProbeRequests, repoProbes);
    const repoEvidenceGaps = this.buildRepoEvidenceGaps(frame, repoProbeCoverage, repoProbes);

    await this.persist('repo_probed', repoProbes, 'Codex repo probes completed');

    const claims: Claim[] = optionWork.flatMap(({ advocate, skeptic }) => [
      ...advocate.claims,
      ...skeptic.claims,
    ]);

    const evidenceInput = JSON.stringify({
      frame,
      claims,
      optionWork,
      repoProbes,
      repoProbeCoverage,
      repoEvidenceGaps,
      instruction:
        'Verify or contradict claims using the supplied repo probes, attached docs, and web search where needed.',
    });

    const evidenceResult = await this.runAgent(evidenceAgent, evidenceInput, { context });
    const evidenceBundle = EvidenceBundleSchema.parse(evidenceResult.finalOutput);
    await this.persist('evidence_verified', evidenceBundle, 'Evidence verification completed');

    this.assertEvidenceGate(claims, evidenceBundle.claimStatuses);

    const judgeInput = JSON.stringify({
      frame,
      optionWork,
      repoProbes,
      repoProbeCoverage,
      evidenceBundle,
      repoEvidenceGaps,
      instruction:
        'Score each option against the criteria and produce a final recommendation with dissent and evidence gaps.',
    });

    const judgeResult = await this.runAgent(judgeAgent, judgeInput, { context });
    const judgeDraft = JudgeDraftSchema.parse(judgeResult.finalOutput);
    await this.persist('judged', judgeDraft, 'Judge produced decision draft');

    const finalMemo = this.materializeFinalMemo(frame, judgeDraft, repoProbeCoverage, repoEvidenceGaps);
    await this.persist('completed', finalMemo, 'Decision run completed');

    return finalMemo;
  }

  private materializeFinalMemo(
    frame: DecisionFrame,
    draft: JudgeDraft,
    repoProbeCoverage: RepoProbeCoverage[],
    repoEvidenceGaps: string[]
  ): FinalMemo {
    const criteriaById = new Map(frame.criteria.map((criterion) => [criterion.id, criterion]));

    const optionScores = draft.optionScores.map((optionScore) => {
      const weightedTotal = optionScore.criterionScores.reduce((sum, item) => {
        const criterion = criteriaById.get(item.criterionId);
        if (!criterion) {
          throw new Error(`Unknown criterion: ${item.criterionId}`);
        }

        return sum + (item.score / 5) * criterion.weight;
      }, 0);

      return {
        optionId: optionScore.optionId,
        weightedTotal: Number(weightedTotal.toFixed(2)),
        criterionScores: optionScore.criterionScores,
      };
    });

    const baseMemo = FinalMemoSchema.parse({
      ...draft,
      optionScores,
    });

    const hasIncompleteRepoCoverage = repoProbeCoverage.some((item) => item.status !== 'complete');
    const needsRepoEvidence = frame.requiredEvidence.includes('repo');
    const evidenceGaps = dedupeStrings([
      ...baseMemo.evidenceGaps,
      ...repoEvidenceGaps,
    ]);

    if (!needsRepoEvidence || !hasIncompleteRepoCoverage) {
      return FinalMemoSchema.parse({
        ...baseMemo,
        evidenceGaps,
      });
    }

    return FinalMemoSchema.parse({
      ...baseMemo,
      verdict: 'need_more_evidence',
      recommendedOptionId: null,
      executiveSummary: [
        'BenchMemo cannot make a reliable recommendation yet because required repository evidence is incomplete.',
        baseMemo.executiveSummary,
      ].join(' '),
      evidenceGaps,
      nextSteps: dedupeStrings([
        ...baseMemo.nextSteps,
        ...repoEvidenceGaps.map((gap) => `Resolve repo evidence gap: ${gap}`),
      ]),
    });
  }

  private buildRepoProbeCoverage(
    frame: DecisionFrame,
    requests: RepoProbeRequest[],
    outcomes: RepoProbeOutcome[]
  ): RepoProbeCoverage[] {
    return frame.options.map((option) => {
      const expectedProbeTypes = uniqStrings(
        requests
          .filter((request) => request.optionId === option.id)
          .map((request) => request.probeType)
      );

      const succeededProbeTypes = uniqStrings(
        outcomes
          .filter((outcome) => outcome.optionId === option.id && outcome.status === 'succeeded')
          .map((outcome) => outcome.probeType)
      );

      const missingProbeTypes = expectedProbeTypes.filter(
        (probeType) => !succeededProbeTypes.includes(probeType)
      );

      return {
        decisionId: frame.decisionId,
        optionId: option.id,
        status:
          succeededProbeTypes.length === expectedProbeTypes.length
            ? 'complete'
            : succeededProbeTypes.length > 0
              ? 'partial'
              : 'missing',
        succeededProbeTypes,
        missingProbeTypes,
      };
    });
  }

  private buildRepoEvidenceGaps(
    frame: DecisionFrame,
    coverage: RepoProbeCoverage[],
    outcomes: RepoProbeOutcome[]
  ) {
    const optionNames = new Map(frame.options.map((option) => [option.id, option.name]));

    return coverage.flatMap((entry) => {
      if (entry.status === 'complete') {
        return [];
      }

      const failedOutcomes = outcomes.filter(
        (
          outcome
        ): outcome is Extract<RepoProbeOutcome, { status: 'failed' }> =>
          outcome.optionId === entry.optionId && outcome.status === 'failed'
      );
      const failureSummary =
        failedOutcomes.length > 0
          ? failedOutcomes
              .map((outcome) => `${outcome.probeType}: ${outcome.errorMessage}`)
              .join('; ')
          : 'repo probes did not return enough evidence';

      return [
        `${optionNames.get(entry.optionId) ?? entry.optionId} is missing repo probe coverage for ${entry.missingProbeTypes.join(', ')}. ${failureSummary}`,
      ];
    });
  }

  private assertEvidenceGate(
    claims: Claim[],
    statuses: Array<{ claimId: string; status: 'verified' | 'contradicted' | 'unresolved'; evidenceIds: string[] }>
  ) {
    const statusByClaimId = new Map(statuses.map((status) => [status.claimId, status]));

    for (const claim of claims) {
      if (claim.severity !== 'high') continue;

      const status = statusByClaimId.get(claim.id);
      if (!status) {
        throw new Error(`Missing evidence status for high-severity claim ${claim.id}`);
      }

      if (status.status === 'verified' && status.evidenceIds.length === 0) {
        throw new Error(`High-severity claim ${claim.id} is verified without evidence IDs`);
      }
    }
  }

  private async persist(step: DecisionRunStep, artifact: unknown, message: string) {
    await this.artifactStore.save(step, artifact);
    await this.emit(step, message);
  }

  private async emit(step: DecisionRunStep, message: string) {
    await this.onEvent?.({ step, message });
  }
}

function uniqStrings<T extends string>(items: T[]) {
  return Array.from(new Set(items));
}

function dedupeStrings(items: string[]) {
  return Array.from(new Set(items));
}
