import { z } from 'zod';

export const CriterionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  weight: z.number().int().min(0).max(100),
});

export const DecisionBriefSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(1),
  repo: z.object({
    provider: z.literal('github'),
    repoName: z.string().min(1),
    branch: z.string().optional(),
    localPath: z.string().optional(),
    paths: z.array(z.string()).default([]),
  }),
  options: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().min(1),
    })
  ).min(2),
  constraints: z.array(z.string()).default([]),
  criteria: z.array(CriterionSchema)
    .min(1)
    .refine((items) => items.reduce((sum, item) => sum + item.weight, 0) === 100, {
      message: 'criteria weights must sum to 100',
    }),
  reversibility: z.enum(['reversible', 'costly_reversible', 'hard_to_reverse']),
  horizon: z.enum(['days', 'weeks', 'months', 'quarters']),
  attachments: z.array(
    z.object({
      fileId: z.string().min(1),
      vectorStoreId: z.string().min(1),
    })
  ).default([]),
});

export const DecisionFrameSchema = z.object({
  decisionId: z.string().min(1),
  normalizedQuestion: z.string().min(1),
  options: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().min(1),
    })
  ).min(2),
  constraints: z.array(z.string()).default([]),
  criteria: z.array(
    CriterionSchema.extend({
      scoringGuidance: z.string().min(1),
    })
  ).min(1),
  unknowns: z.array(z.string()).default([]),
  requiredEvidence: z.array(z.enum(['repo', 'docs', 'web'])).default([]),
  notesForAgents: z.array(z.string()).default([]),
});

export const ClaimSchema = z.object({
  id: z.string().min(1),
  decisionId: z.string().min(1),
  optionId: z.string().min(1),
  sourceAgent: z.enum(['advocate', 'skeptic']),
  stance: z.enum(['pro', 'con']),
  text: z.string().min(1),
  rationale: z.string().min(1),
  requiresEvidence: z.array(z.enum(['repo', 'docs', 'web'])).default([]),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  confidence: z.number().min(0).max(1),
  status: z.enum(['unverified', 'verified', 'contradicted', 'unresolved']).default('unverified'),
});

export const OptionCaseDraftSchema = z.object({
  decisionId: z.string().min(1),
  optionId: z.string().min(1),
  summary: z.string().min(1),
  claims: z.array(ClaimSchema).min(1),
  assumptions: z.array(z.string()).default([]),
});

export const RiskCaseDraftSchema = z.object({
  decisionId: z.string().min(1),
  optionId: z.string().min(1),
  summary: z.string().min(1),
  claims: z.array(ClaimSchema).min(1),
  unknowns: z.array(z.string()).default([]),
});

export const EvidenceItemSchema = z.object({
  id: z.string().min(1),
  decisionId: z.string().min(1),
  sourceType: z.enum(['repo', 'docs', 'web']),
  title: z.string().min(1),
  locator: z.string().min(1),
  excerpt: z.string().min(1),
  retrievedAt: z.string().min(1),
  quality: z.enum(['primary', 'secondary', 'derived']),
  supportsClaimIds: z.array(z.string()).default([]),
  contradictsClaimIds: z.array(z.string()).default([]),
});

export const RepoProbeTypeSchema = z.enum(['impact_scan', 'risk_scan', 'migration_scan']);
export const RepoProbeOutputSchemaNameSchema = z.enum(['impact-scan', 'risk-scan']);
export const RepoProbeFailureKindSchema = z.enum([
  'auth',
  'transport',
  'timeout',
  'cli',
  'invalid_output',
]);
export const RepoProbeFailurePhaseSchema = z.enum(['preflight', 'execution']);

export const RepoProbeRequestSchema = z.object({
  decisionId: z.string().min(1),
  optionId: z.string().min(1),
  probeType: RepoProbeTypeSchema,
  repoName: z.string().min(1),
  localPath: z.string().optional(),
  branch: z.string().optional(),
  paths: z.array(z.string()).default([]),
  question: z.string().min(1),
  outputSchemaName: RepoProbeOutputSchemaNameSchema,
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('read-only'),
});

export const RepoProbeResultSchema = z.object({
  taskId: z.string().min(1),
  decisionId: z.string().min(1),
  optionId: z.string().min(1),
  probeType: RepoProbeTypeSchema,
  status: z.literal('succeeded'),
  attempts: z.number().int().min(1),
  summary: z.string().min(1),
  touchedAreas: z.array(z.string()).default([]),
  hiddenDependencies: z.array(z.string()).default([]),
  likelyTestSurface: z.array(z.string()).default([]),
  migrationHazards: z.array(z.string()).default([]),
  operationalRisks: z.array(z.string()).default([]),
  estimatedComplexity: z.enum(['low', 'medium', 'high']),
  confidence: z.number().min(0).max(1),
  rawArtifactPath: z.string().min(1),
});

export const RepoProbeFailureSchema = z.object({
  taskId: z.string().min(1),
  decisionId: z.string().min(1),
  optionId: z.string().min(1),
  probeType: RepoProbeTypeSchema,
  status: z.literal('failed'),
  attempts: z.number().int().min(1),
  errorMessage: z.string().min(1),
  failureKind: RepoProbeFailureKindSchema,
  failurePhase: RepoProbeFailurePhaseSchema,
  retryable: z.boolean(),
  timedOut: z.boolean(),
  stderrSummary: z.string().default(''),
  eventSummary: z.string().default(''),
  rawArtifactPath: z.null(),
});

export const RepoProbeOutcomeSchema = z.discriminatedUnion('status', [
  RepoProbeResultSchema,
  RepoProbeFailureSchema,
]);

export const RepoProbeCoverageSchema = z.object({
  decisionId: z.string().min(1),
  optionId: z.string().min(1),
  status: z.enum(['complete', 'partial', 'missing']),
  succeededProbeTypes: z.array(RepoProbeTypeSchema).default([]),
  missingProbeTypes: z.array(RepoProbeTypeSchema).default([]),
});

export const EvidenceBundleSchema = z.object({
  decisionId: z.string().min(1),
  evidenceItems: z.array(EvidenceItemSchema).default([]),
  claimStatuses: z.array(z.object({
    claimId: z.string().min(1),
    status: z.enum(['verified', 'contradicted', 'unresolved']),
    evidenceIds: z.array(z.string()).default([]),
    notes: z.string().default(''),
  })).default([]),
  unresolvedQuestions: z.array(z.string()).default([]),
});

export const JudgeDraftSchema = z.object({
  decisionId: z.string().min(1),
  verdict: z.enum(['approve', 'reject', 'need_more_evidence']),
  recommendedOptionId: z.string().nullable(),
  executiveSummary: z.string().min(1),
  optionScores: z.array(z.object({
    optionId: z.string().min(1),
    criterionScores: z.array(z.object({
      criterionId: z.string().min(1),
      score: z.number().int().min(1).max(5),
      rationale: z.string().min(1),
      evidenceIds: z.array(z.string()).default([]),
    })).min(1),
  })).min(1),
  keyRisks: z.array(z.string()).default([]),
  dissent: z.array(z.string()).default([]),
  evidenceGaps: z.array(z.string()).default([]),
  nextSteps: z.array(z.string()).default([]),
});

export const FinalMemoSchema = z.object({
  decisionId: z.string().min(1),
  verdict: z.enum(['approve', 'reject', 'need_more_evidence']),
  recommendedOptionId: z.string().nullable(),
  executiveSummary: z.string().min(1),
  optionScores: z.array(z.object({
    optionId: z.string().min(1),
    weightedTotal: z.number(),
    criterionScores: z.array(z.object({
      criterionId: z.string().min(1),
      score: z.number().int().min(1).max(5),
      rationale: z.string().min(1),
      evidenceIds: z.array(z.string()).default([]),
    })).min(1),
  })).min(1),
  keyRisks: z.array(z.string()).default([]),
  dissent: z.array(z.string()).default([]),
  evidenceGaps: z.array(z.string()).default([]),
  nextSteps: z.array(z.string()).default([]),
});

export const DecisionRunStepSchema = z.enum([
  'received',
  'framed',
  'cases_built',
  'repo_probed',
  'evidence_verified',
  'judged',
  'completed',
]);

export const DecisionRunEventSchema = z.object({
  step: DecisionRunStepSchema,
  message: z.string().min(1),
  at: z.string().datetime(),
});

export const DecisionArtifactRefSchema = z.object({
  step: DecisionRunStepSchema,
  path: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const DecisionRunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
]);

export const DecisionRunRecordSchema = z.object({
  id: z.string().min(1),
  status: DecisionRunStatusSchema,
  brief: DecisionBriefSchema,
  events: z.array(DecisionRunEventSchema).default([]),
  artifactRefs: z.array(DecisionArtifactRefSchema).default([]),
  finalMemo: FinalMemoSchema.nullable(),
  error: z.object({
    message: z.string().min(1),
  }).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  failedAt: z.string().datetime().nullable(),
});

export const CreateDecisionAcceptedSchema = z.object({
  id: z.string().min(1),
  status: DecisionRunStatusSchema,
  location: z.string().min(1),
});

export const ApiErrorSchema = z.object({
  error: z.string().min(1),
});

export type DecisionBrief = z.infer<typeof DecisionBriefSchema>;
export type DecisionFrame = z.infer<typeof DecisionFrameSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type OptionCaseDraft = z.infer<typeof OptionCaseDraftSchema>;
export type RiskCaseDraft = z.infer<typeof RiskCaseDraftSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
export type RepoProbeRequest = z.infer<typeof RepoProbeRequestSchema>;
export type RepoProbeResult = z.infer<typeof RepoProbeResultSchema>;
export type RepoProbeFailure = z.infer<typeof RepoProbeFailureSchema>;
export type RepoProbeOutcome = z.infer<typeof RepoProbeOutcomeSchema>;
export type RepoProbeCoverage = z.infer<typeof RepoProbeCoverageSchema>;
export type RepoProbeFailureKind = z.infer<typeof RepoProbeFailureKindSchema>;
export type RepoProbeFailurePhase = z.infer<typeof RepoProbeFailurePhaseSchema>;
export type JudgeDraft = z.infer<typeof JudgeDraftSchema>;
export type FinalMemo = z.infer<typeof FinalMemoSchema>;
export type DecisionRunStep = z.infer<typeof DecisionRunStepSchema>;
export type DecisionRunEvent = z.infer<typeof DecisionRunEventSchema>;
export type DecisionArtifactRef = z.infer<typeof DecisionArtifactRefSchema>;
export type DecisionRunStatus = z.infer<typeof DecisionRunStatusSchema>;
export type DecisionRunRecord = z.infer<typeof DecisionRunRecordSchema>;
export type CreateDecisionAccepted = z.infer<typeof CreateDecisionAcceptedSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
