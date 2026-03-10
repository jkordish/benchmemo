import { Agent, fileSearchTool, webSearchTool } from '@openai/agents';
import {
  DecisionFrameSchema,
  EvidenceBundleSchema,
  JudgeDraftSchema,
  OptionCaseDraftSchema,
  RiskCaseDraftSchema,
} from '@benchmemo/shared';

export type DebateContext = {
  vectorStoreIds: string[];
  domainLabel: string;
};

export function buildFrameAgent() {
  return new Agent<DebateContext, typeof DecisionFrameSchema>({
    name: 'Frame Agent',
    model: 'gpt-5.4',
    outputType: DecisionFrameSchema,
    instructions: `You normalize messy engineering decisions into a strict decision frame.
Return only the schema.
Do not recommend an option.
Force tradeoffs, hidden assumptions, and unknowns into explicit fields.
Criteria weights are provided by the caller; preserve them.`,
  });
}

export function buildAdvocateAgent() {
  return new Agent<DebateContext, typeof OptionCaseDraftSchema>({
    name: 'Advocate Agent',
    model: 'gpt-5.4',
    outputType: OptionCaseDraftSchema,
    instructions: `You are a disciplined advocate for exactly one engineering option.
Produce the strongest steelman case for the option.
Every claim must be concrete, falsifiable, and scoped to engineering decisions.
Do not compare options unless necessary for the claim rationale.
Set claim.status to unverified.`,
  });
}

export function buildSkepticAgent() {
  return new Agent<DebateContext, typeof RiskCaseDraftSchema>({
    name: 'Skeptic Agent',
    model: 'gpt-5.4',
    outputType: RiskCaseDraftSchema,
    instructions: `You are a hard-nosed skeptic for exactly one engineering option.
Focus on rollback risk, coupling, migration hazards, oncall pain, observability gaps, and hidden complexity.
Do not be vague. If a risk is not testable or inspectable, sharpen it until it is.
Set claim.status to unverified.`,
  });
}

export function buildEvidenceAgent(vectorStoreIds: string[]) {
  const tools = [webSearchTool()];

  if (vectorStoreIds.length > 0) {
    tools.push(fileSearchTool(vectorStoreIds, { maxNumResults: 12 }));
  }

  return new Agent<DebateContext, typeof EvidenceBundleSchema>({
    name: 'Evidence Agent',
    model: 'gpt-5.4',
    outputType: EvidenceBundleSchema,
    tools,
    instructions: `You verify engineering-decision claims.
Rules:
- Every claim must end verified, contradicted, or unresolved.
- Repo probe findings count as repo evidence when included by the caller.
- Failed or timed-out repo probes mean repo evidence is incomplete; do not treat them as contradictory evidence.
- Leave claims unresolved when they depend on missing repo evidence and no other primary source closes the gap.
- Use web search for time-sensitive or vendor facts.
- Use file search when attached docs are available.
- Never invent evidence IDs.
- Prefer primary sources and precise citations in the locator field.
Return only the schema.`,
  });
}

export function buildJudgeAgent() {
  return new Agent<DebateContext, typeof JudgeDraftSchema>({
    name: 'Judge Agent',
    model: 'gpt-5.4',
    outputType: JudgeDraftSchema,
    instructions: `You synthesize an engineering decision using only the supplied evidence and claim statuses.
Rules:
- No unsupported decisive statements.
- If evidence is insufficient, return need_more_evidence.
- Treat incomplete repo probe coverage as an evidence gap, not as affirmative evidence for any option.
- Score every option against every criterion on a 1-5 scale.
- Include dissent and evidence gaps.
Return only the schema.`,
  });
}
