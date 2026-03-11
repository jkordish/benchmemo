import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { DecisionService, FileDecisionStore, type RunDecisionOptions } from '@benchmemo/api';
import {
  DecisionBriefSchema,
  type DecisionBrief,
  type DecisionRunRecord,
} from '@benchmemo/shared';
import {
  buildGuidedBrief,
  type BuildGuidedBriefOptions,
  type PromptSession,
} from './brief-builder.js';

export interface LocalCliRunner {
  dataDir: string;
  runDecision(
    brief: DecisionBrief,
    options?: RunDecisionOptions
  ): Promise<DecisionRunRecord>;
}

export interface RunCliOptions {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  cwd?: string;
  now?: () => Date;
  stdout?: { write(chunk: string): void };
  stderr?: { write(chunk: string): void };
  promptSession?: PromptSession;
  buildBrief?: (options: BuildGuidedBriefOptions) => Promise<unknown>;
  createRunner?: (input: { cwd: string }) => Promise<LocalCliRunner> | LocalCliRunner;
}

const HELP_TEXT = [
  'BenchMemo console app',
  '',
  'Usage:',
  '  benchmemo run',
  '  benchmemo --help',
  '',
  'The v1 CLI is interactive and guides you through a one-shot decision run.',
].join('\n');

export async function runCli(argv: string[], options: RunCliOptions = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();
  const parsed = parseArgs(argv);

  if (parsed.help || !parsed.command) {
    writeLine(stdout, HELP_TEXT);
    return 0;
  }

  if (parsed.command !== 'run') {
    writeLine(stderr, `Unknown command: ${parsed.command}`);
    writeLine(stderr, HELP_TEXT);
    return 1;
  }

  if (parsed.unexpectedOptions.length > 0 || parsed.extraPositionals.length > 0) {
    if (parsed.unexpectedOptions.length > 0) {
      writeLine(stderr, `Unknown option(s): ${parsed.unexpectedOptions.join(', ')}`);
    }

    if (parsed.extraPositionals.length > 0) {
      writeLine(stderr, `Unexpected argument(s): ${parsed.extraPositionals.join(', ')}`);
    }

    writeLine(stderr, HELP_TEXT);
    return 1;
  }

  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY ?? false;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY ?? false;

  if (!stdinIsTTY || !stdoutIsTTY) {
    writeLine(stderr, 'benchmemo run requires an interactive terminal.');
    return 1;
  }

  const buildBrief = options.buildBrief ?? buildGuidedBrief;
  const createRunner = options.createRunner ?? createDefaultRunner;
  const promptOwner = options.promptSession ?? createPromptSession();
  const ownsPrompt = !options.promptSession;

  try {
    const candidateBrief = await buildBrief({
      prompt: promptOwner,
      cwd,
      now: options.now,
    });
    const briefResult = DecisionBriefSchema.safeParse(candidateBrief);

    if (!briefResult.success) {
      writeLine(stderr, formatDecisionBriefError(briefResult.error));
      return 1;
    }

    const brief = briefResult.data;
    const runner = await createRunner({ cwd });

    writeLine(stdout, `Starting BenchMemo run ${brief.id}...`);

    const record = await runner.runDecision(brief, {
      onEvent: async (event) => {
        writeLine(stdout, `[${event.step}] ${event.message}`);
      },
    });

    writeLine(stdout, `Run data: ${runner.dataDir}`);

    if (record.status === 'completed' && record.finalMemo) {
      writeLine(stdout, '');
      writeLine(stdout, renderFinalMemo(record));
      return 0;
    }

    if (record.status === 'failed') {
      writeLine(stderr, `Run failed: ${record.error?.message ?? 'Unknown error'}`);
      return 1;
    }

    writeLine(stderr, `Run ended in unexpected status: ${record.status}`);
    return 1;
  } catch (error) {
    writeLine(stderr, `BenchMemo CLI failed: ${toErrorMessage(error)}`);
    return 1;
  } finally {
    if (ownsPrompt) {
      promptOwner.close?.();
    }
  }
}

export function formatDecisionBriefError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}) {
  const lines = ['Brief validation failed:'];

  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'brief';
    lines.push(`- ${path}: ${issue.message}`);
  }

  return lines.join('\n');
}

export async function createDefaultRunner(input: { cwd: string }): Promise<LocalCliRunner> {
  const dataDir = process.env.BENCHMEMO_DATA_DIR ?? join(input.cwd, '.benchmemo-data');
  const store = new FileDecisionStore(dataDir);
  const service = new DecisionService({ store });

  return {
    dataDir: store.rootDir,
    runDecision: (brief, options) => service.runDecision(brief, options),
  };
}

function createPromptSession(): PromptSession {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    ask(message: string) {
      return readline.question(message);
    },
    close() {
      readline.close();
    },
  };
}

function parseArgs(argv: string[]) {
  const result = {
    command: '' as string | undefined,
    help: false,
    unexpectedOptions: [] as string[],
    extraPositionals: [] as string[],
  };

  for (const arg of argv) {
    if (arg === '--') {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }

    if (arg.startsWith('-')) {
      result.unexpectedOptions.push(arg);
      continue;
    }

    if (!result.command) {
      result.command = arg;
      continue;
    }

    result.extraPositionals.push(arg);
  }

  return result;
}

function renderFinalMemo(record: DecisionRunRecord) {
  const memo = record.finalMemo;
  if (!memo) {
    return 'No final memo was produced.';
  }

  const optionNames = new Map(record.brief.options.map((option) => [option.id, option.name]));
  const lines = [
    'BenchMemo memo',
    `Decision ID: ${memo.decisionId}`,
    `Verdict: ${memo.verdict}`,
    `Recommended option: ${memo.recommendedOptionId ? optionNames.get(memo.recommendedOptionId) ?? memo.recommendedOptionId : 'none'}`,
    '',
    'Summary:',
    memo.executiveSummary,
    '',
    'Option scores:',
    ...memo.optionScores.map((optionScore) => `- ${optionNames.get(optionScore.optionId) ?? optionScore.optionId}: ${formatScore(optionScore.weightedTotal)}`),
  ];

  if (memo.keyRisks.length > 0) {
    lines.push('', 'Key risks:', ...memo.keyRisks.map((item) => `- ${item}`));
  }

  if (memo.evidenceGaps.length > 0) {
    lines.push('', 'Evidence gaps:', ...memo.evidenceGaps.map((item) => `- ${item}`));
  }

  if (memo.nextSteps.length > 0) {
    lines.push('', 'Next steps:', ...memo.nextSteps.map((item) => `- ${item}`));
  }

  return lines.join('\n');
}

function formatScore(value: number) {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function writeLine(stream: { write(chunk: string): void }, message: string) {
  stream.write(`${message}\n`);
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Unknown CLI error';
}
