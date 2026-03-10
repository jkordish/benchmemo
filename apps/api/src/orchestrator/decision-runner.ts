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
  RepoProbeFailure,
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

interface RepoEvidenceGapReport {
  evidenceGaps: string[];
  nextSteps: string[];
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
    const repoEvidenceGapReport = this.buildRepoEvidenceGapReport(frame, repoProbeCoverage, repoProbes);
    const repoEvidenceGaps = repoEvidenceGapReport.evidenceGaps;

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

    const finalMemo = this.materializeFinalMemo(frame, judgeDraft, repoProbeCoverage, repoEvidenceGapReport);
    await this.persist('completed', finalMemo, 'Decision run completed');

    return finalMemo;
  }

  private materializeFinalMemo(
    frame: DecisionFrame,
    draft: JudgeDraft,
    repoProbeCoverage: RepoProbeCoverage[],
    repoEvidenceGapReport: RepoEvidenceGapReport
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
      ...repoEvidenceGapReport.evidenceGaps,
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
        ...repoEvidenceGapReport.nextSteps,
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

  private buildRepoEvidenceGapReport(
    frame: DecisionFrame,
    coverage: RepoProbeCoverage[],
    outcomes: RepoProbeOutcome[]
  ): RepoEvidenceGapReport {
    const optionNames = new Map(frame.options.map((option) => [option.id, option.name]));
    const failedOutcomes = outcomes.filter(
      (outcome): outcome is Extract<RepoProbeOutcome, { status: 'failed' }> => outcome.status === 'failed'
    );
    const platformFailureGroups = this.groupFailedProbeOutcomes(failedOutcomes);

    const coverageGaps = coverage.flatMap((entry) => {
      if (entry.status === 'complete') {
        return [];
      }

      return [
        `${optionNames.get(entry.optionId) ?? entry.optionId} is missing repo probe coverage for ${entry.missingProbeTypes.join(', ')}.`,
      ];
    });

    const platformGaps = platformFailureGroups.map((group) => {
      const affectedProbeCount = group.outcomes.length;
      const phaseLabel = group.failurePhase === 'preflight' ? 'during preflight' : 'during execution';

      switch (group.failureKind) {
        case 'auth':
          return `Codex repo probing was blocked by an authentication issue ${phaseLabel} (${affectedProbeCount} probes affected). Example: ${group.exampleError}`;
        case 'transport':
          return `Codex repo probing encountered a transport issue ${phaseLabel} (${affectedProbeCount} probes affected). Example: ${group.exampleError}`;
        case 'timeout':
          return `Codex repo probing timed out ${phaseLabel} (${affectedProbeCount} probes affected). Example: ${group.exampleError}`;
        case 'cli':
          return `Codex repo probing could not start because the CLI is unavailable or unhealthy ${phaseLabel} (${affectedProbeCount} probes affected). Example: ${group.exampleError}`;
        case 'invalid_output':
          return `Codex repo probing returned invalid structured output ${phaseLabel} (${affectedProbeCount} probes affected). Example: ${group.exampleError}`;
      }
    });

    const nextSteps = dedupeStrings([
      ...platformFailureGroups.flatMap((group) => this.buildNextStepsForFailure(group.failureKind)),
      ...(coverageGaps.length > 0
        ? ['Re-run the decision after the missing repository evidence is collected.']
        : []),
    ]);

    return {
      evidenceGaps: dedupeStrings([
        ...platformGaps,
        ...coverageGaps,
      ]),
      nextSteps,
    };
  }

  private groupFailedProbeOutcomes(failedOutcomes: RepoProbeFailure[]) {
    const groups = new Map<
      string,
      {
        failureKind: RepoProbeFailure['failureKind'];
        failurePhase: RepoProbeFailure['failurePhase'];
        exampleError: string;
        outcomes: RepoProbeFailure[];
      }
    >();

    for (const outcome of failedOutcomes) {
      const key = [
        outcome.failurePhase,
        outcome.failureKind,
        normalizeWhitespace(outcome.errorMessage),
      ].join('|');
      const existing = groups.get(key);

      if (existing) {
        existing.outcomes.push(outcome);
        continue;
      }

      groups.set(key, {
        failureKind: outcome.failureKind,
        failurePhase: outcome.failurePhase,
        exampleError: outcome.errorMessage,
        outcomes: [outcome],
      });
    }

    return Array.from(groups.values());
  }

  private buildNextStepsForFailure(failureKind: RepoProbeFailure['failureKind']) {
    switch (failureKind) {
      case 'auth':
        return [
          'Run `pnpm doctor` and refresh Codex login or OpenAI credentials before retrying repo probes.',
        ];
      case 'transport':
        return [
          'Run `pnpm doctor`, verify network connectivity to Codex/OpenAI, and retry repo probes.',
        ];
      case 'timeout':
        return [
          'Narrow the repo scope or increase `BENCHMEMO_CODEX_PROBE_TIMEOUT_MS` before retrying repo probes.',
        ];
      case 'cli':
        return [
          'Install the Codex CLI and confirm `codex login status` works before retrying repo probes.',
        ];
      case 'invalid_output':
        return [
          'Inspect the stored repo probe diagnostics and adjust the Codex prompt or schema before retrying repo probes.',
        ];
    }
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

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}
