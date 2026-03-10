import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DecisionRunner, type DecisionRunnerOptions } from '../apps/api/src/orchestrator/decision-runner.js';
import {
  DecisionBrief,
  DecisionBriefSchema,
  DecisionFrame,
  DecisionFrameSchema,
  EvidenceBundle,
  EvidenceBundleSchema,
  JudgeDraft,
  JudgeDraftSchema,
  OptionCaseDraft,
  OptionCaseDraftSchema,
  RepoProbeOutcome,
  RepoProbeOutcomeSchema,
  RiskCaseDraft,
  RiskCaseDraftSchema,
} from '../packages/shared/src/schemas.js';

interface EvalFixture {
  name: string;
  brief: DecisionBrief;
  frame: DecisionFrame;
  advocateCases: Record<string, OptionCaseDraft>;
  skepticCases: Record<string, RiskCaseDraft>;
  repoProbes: RepoProbeOutcome[];
  evidenceBundle: EvidenceBundle;
  judgeDraft: JudgeDraft;
  expected: {
    verdict: JudgeDraft['verdict'];
    recommendedOptionId: string | null;
    requiredEvidenceGaps: string[];
    requiredNextSteps: string[];
    requiredSummaryIncludes: string[];
    scoreOrder: string[];
  };
}

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

async function main() {
  const fixtureFiles = (await readdir(fixtureDir))
    .filter((name) => name.endsWith('.json'))
    .sort();
  let failures = 0;

  for (const fixtureFile of fixtureFiles) {
    try {
      const fixture = await loadFixture(join(fixtureDir, fixtureFile));
      const memo = await runFixture(fixture);
      assert.equal(memo.verdict, fixture.expected.verdict);
      assert.equal(memo.recommendedOptionId, fixture.expected.recommendedOptionId);

      for (const expectedGap of fixture.expected.requiredEvidenceGaps) {
        assert.ok(
          memo.evidenceGaps.some((gap) => gap.includes(expectedGap)),
          `Missing expected evidence gap substring: ${expectedGap}`
        );
      }

      for (const expectedStep of fixture.expected.requiredNextSteps) {
        assert.ok(
          memo.nextSteps.some((step) => step.includes(expectedStep)),
          `Missing expected next step substring: ${expectedStep}`
        );
      }

      for (const expectedSummary of fixture.expected.requiredSummaryIncludes) {
        assert.match(memo.executiveSummary, new RegExp(escapeRegExp(expectedSummary), 'i'));
      }

      if (fixture.expected.scoreOrder.length > 0) {
        const actualOrder = [...memo.optionScores]
          .sort((left, right) => right.weightedTotal - left.weightedTotal)
          .map((item) => item.optionId);
        assert.deepEqual(actualOrder, fixture.expected.scoreOrder);
      }

      console.log(`PASS ${fixture.name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${fixtureFile}`);
      console.error(error instanceof Error ? error.stack ?? error.message : error);
    }
  }

  if (failures > 0) {
    process.exit(1);
  }

  console.log(`Fixture evals passed: ${fixtureFiles.length}`);
}

async function runFixture(fixture: EvalFixture) {
  const runAgent = (async (agent, payload) => {
    const body = JSON.parse(payload as string) as Record<string, unknown>;

    switch (agent.name) {
      case 'Frame Agent':
        return { finalOutput: fixture.frame };
      case 'Advocate Agent': {
        const optionId = String((body.option as { id: string }).id);
        return {
          finalOutput: requireCase(fixture.advocateCases, optionId, 'advocate'),
        };
      }
      case 'Skeptic Agent': {
        const optionId = String((body.option as { id: string }).id);
        return {
          finalOutput: requireCase(fixture.skepticCases, optionId, 'skeptic'),
        };
      }
      case 'Evidence Agent':
        return { finalOutput: fixture.evidenceBundle };
      case 'Judge Agent':
        return { finalOutput: fixture.judgeDraft };
      default:
        throw new Error(`Unexpected agent in fixture harness: ${agent.name}`);
    }
  }) as NonNullable<DecisionRunnerOptions['runAgent']>;

  const runner = new DecisionRunner({
    runAgent,
    runRepoProbes: async () => fixture.repoProbes,
  });

  return runner.run(fixture.brief);
}

async function loadFixture(path: string): Promise<EvalFixture> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const advocateCases = parseCaseMap(raw.advocateCases, OptionCaseDraftSchema, 'advocateCases');
  const skepticCases = parseCaseMap(raw.skepticCases, RiskCaseDraftSchema, 'skepticCases');
  const repoProbes = parseRepoProbes(raw.repoProbes);
  const expected = parseExpected(raw.expected);

  return {
    name: readString(raw.name, 'name'),
    brief: DecisionBriefSchema.parse(raw.brief),
    frame: DecisionFrameSchema.parse(raw.frame),
    advocateCases,
    skepticCases,
    repoProbes,
    evidenceBundle: EvidenceBundleSchema.parse(raw.evidenceBundle),
    judgeDraft: JudgeDraftSchema.parse(raw.judgeDraft),
    expected,
  };
}

function parseCaseMap<T>(
  value: unknown,
  parser: { parse: (input: unknown) => T },
  label: string
): Record<string, T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object keyed by option id`);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, parser.parse(entry)])
  );
}

function parseRepoProbes(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error('repoProbes must be an array');
  }

  return value.map((entry) => RepoProbeOutcomeSchema.parse(entry));
}

function parseExpected(value: unknown): EvalFixture['expected'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected must be an object');
  }

  const record = value as Record<string, unknown>;

  return {
    verdict: readVerdict(record.verdict),
    recommendedOptionId: readNullableString(record.recommendedOptionId, 'expected.recommendedOptionId'),
    requiredEvidenceGaps: readStringArray(record.requiredEvidenceGaps, 'expected.requiredEvidenceGaps'),
    requiredNextSteps: readStringArray(record.requiredNextSteps, 'expected.requiredNextSteps'),
    requiredSummaryIncludes: readStringArray(record.requiredSummaryIncludes, 'expected.requiredSummaryIncludes'),
    scoreOrder: readStringArray(record.scoreOrder, 'expected.scoreOrder'),
  };
}

function requireCase<T>(cases: Record<string, T>, optionId: string, label: string) {
  const entry = cases[optionId];
  if (!entry) {
    throw new Error(`Missing ${label} case for option ${optionId}`);
  }

  return entry;
}

function readString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
}

function readNullableString(value: unknown, label: string) {
  if (value === null) {
    return null;
  }

  return readString(value, label);
}

function readStringArray(value: unknown, label: string) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }

  return value;
}

function readVerdict(value: unknown): JudgeDraft['verdict'] {
  if (value === 'approve' || value === 'reject' || value === 'need_more_evidence') {
    return value;
  }

  throw new Error('expected.verdict must be approve, reject, or need_more_evidence');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
