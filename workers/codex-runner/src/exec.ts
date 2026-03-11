import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import {
  RepoProbeFailureSchema,
  RepoProbeFailureKind,
  RepoProbeOutcome,
  RepoProbeRequest,
  RepoProbeRequestSchema,
  RepoProbeResult,
  RepoProbeResultSchema,
} from '@benchmemo/shared';
import {
  buildCodexProbeCliArgs,
  CODEX_PROBE_CONFIG_OVERRIDES,
  CODEX_PROBE_DISABLED_FEATURES,
  CodexProbeEnvironmentError,
  type PreparedCodexProbeEnvironment,
  prepareCodexProbeEnvironment,
} from './probe-environment.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, '..', 'schemas');
const DEFAULT_CODEX_PROBE_TIMEOUT_MS = 45_000;

export type CodexJsonEvent = Record<string, unknown>;
export type SpawnFn = (
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2]
) => ChildProcessWithoutNullStreams;

export interface RunCodexProbeOptions {
  spawnFn?: SpawnFn;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  probeEnvironmentFactory?: (
    sourceEnv?: NodeJS.ProcessEnv
  ) => Promise<PreparedCodexProbeEnvironment>;
}

export async function runCodexProbe(
  input: RepoProbeRequest,
  options: RunCodexProbeOptions = {}
): Promise<RepoProbeOutcome> {
  const req = RepoProbeRequestSchema.parse(input);
  const taskId = `codex_${randomUUID()}`;
  const scratch = await mkdtemp(join(tmpdir(), 'benchmemo-codex-'));
  const outputPath = join(scratch, `${taskId}.json`);
  const diagnosticsPath = join(scratch, `${taskId}.diagnostics.json`);
  const schemaPath = join(SCHEMA_DIR, `${req.outputSchemaName}.schema.json`);
  const cwd = req.localPath ?? process.cwd();
  const spawnFn = options.spawnFn ?? spawn;
  const timeoutMs = options.timeoutMs ?? getCodexProbeTimeoutMs();
  const sourceEnv = options.env ?? process.env;
  const probeEnvironmentFactory = options.probeEnvironmentFactory ?? prepareCodexProbeEnvironment;

  const prompt = buildPrompt(req);
  const args = [
    'exec',
    '--ephemeral',
    '--json',
    ...buildCodexProbeCliArgs(),
    '--sandbox',
    req.sandbox,
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outputPath,
    prompt,
  ];

  const events: CodexJsonEvent[] = [];
  const stderrLines: string[] = [];
  let probeEnvironment: PreparedCodexProbeEnvironment | null = null;

  const buildFailureOutcome = async (input: {
    errorMessage: string;
    failureKind?: RepoProbeFailureKind;
    failurePhase: 'preflight' | 'execution';
    retryable?: boolean;
    timedOut: boolean;
  }) => {
    const diagnosticPath = await writeProbeDiagnostics({
      taskId,
      req,
      cwd,
      args,
      prompt,
      outputPath,
      schemaPath,
      diagnosticsPath,
      probeEnvironment,
      stderrLines,
      events,
      failurePhase: input.failurePhase,
      errorMessage: input.errorMessage,
    });

    return buildProbeFailure({
      taskId,
      req,
      attempts: 1,
      errorMessage: input.errorMessage,
      failureKind: input.failureKind,
      failurePhase: input.failurePhase,
      retryable: input.retryable,
      timedOut: input.timedOut,
      stderrLines,
      events,
      diagnosticPath,
    });
  };

  try {
    probeEnvironment = await probeEnvironmentFactory(sourceEnv);
  } catch (error) {
    const failureKind =
      error instanceof CodexProbeEnvironmentError ? error.failureKind : undefined;

    return buildFailureOutcome({
      errorMessage: toErrorMessage(error),
      failureKind,
      failurePhase: 'preflight',
      retryable: false,
      timedOut: false,
    });
  }

  const executionOutcome = await (async () => {
    try {
      return await new Promise<'success' | RepoProbeOutcome>((resolve, reject) => {
        const settleFailure = (input: {
          errorMessage: string;
          failureKind?: RepoProbeFailureKind;
          failurePhase: 'preflight' | 'execution';
          retryable?: boolean;
          timedOut: boolean;
        }) => {
          void buildFailureOutcome(input).then(resolve, reject);
        };

        const child = spawnFn('codex', args, {
          cwd,
          env: probeEnvironment.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let settled = false;

        if (!child.stdout || !child.stderr) {
          settled = true;
          reject(new Error('codex exec did not provide stdout/stderr pipes'));
          return;
        }

        let stdoutBuffer = '';
        let stderrBuffer = '';
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill('SIGKILL');
            }
          }, 5_000).unref();
          settleFailure({
            errorMessage: `codex exec timed out after ${timeoutMs}ms`,
            failurePhase: 'execution',
            timedOut: true,
          });
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
          stdoutBuffer += String(chunk);
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              events.push(JSON.parse(trimmed));
            } catch {
              // Ignore non-JSON lines. Codex should emit JSONL because we passed --json.
            }
          }
        });

        child.stderr.on('data', (chunk) => {
          stderrBuffer += String(chunk);
          const lines = stderrBuffer.split('\n');
          stderrBuffer = lines.pop() ?? '';
          stderrLines.push(...lines.filter(Boolean));
        });

        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          settleFailure({
            errorMessage: toErrorMessage(error),
            failurePhase: 'execution',
            timedOut: false,
          });
        });

        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);

          if (stdoutBuffer.trim()) {
            try {
              events.push(JSON.parse(stdoutBuffer.trim()));
            } catch {
              // Ignore trailing partial or non-JSON line.
            }
          }

          if (stderrBuffer.trim()) {
            stderrLines.push(stderrBuffer.trim());
          }

          if (code === 0) {
            resolve('success');
            return;
          }

          settleFailure({
            errorMessage: `codex exec exited with code ${code ?? 'unknown'}`,
            failurePhase: 'execution',
            timedOut: false,
          });
        });
      });
    } finally {
      await probeEnvironment.cleanup();
    }
  })();

  if (executionOutcome !== 'success') {
    return executionOutcome;
  }

  let parsed: Omit<
    RepoProbeResult,
    'taskId' | 'decisionId' | 'optionId' | 'probeType' | 'rawArtifactPath' | 'status' | 'attempts'
  >;

  try {
    parsed = JSON.parse(await readFile(outputPath, 'utf8')) as Omit<
      RepoProbeResult,
      'taskId' | 'decisionId' | 'optionId' | 'probeType' | 'rawArtifactPath' | 'status' | 'attempts'
    >;
  } catch (error) {
    return buildFailureOutcome({
      errorMessage: `codex exec produced unreadable output: ${toErrorMessage(error)}`,
      failureKind: 'invalid_output',
      failurePhase: 'execution',
      retryable: false,
      timedOut: false,
    });
  }

  const result = RepoProbeResultSchema.safeParse({
    ...parsed,
    taskId,
    decisionId: req.decisionId,
    optionId: req.optionId,
    probeType: req.probeType,
    status: 'succeeded',
    attempts: 1,
    rawArtifactPath: outputPath,
  });

  if (!result.success) {
    return buildFailureOutcome({
      errorMessage: `codex exec produced invalid structured output: ${result.error.issues[0]?.message ?? 'schema validation failed'}`,
      failureKind: 'invalid_output',
      failurePhase: 'execution',
      retryable: false,
      timedOut: false,
    });
  }

  // Intentionally keep the JSON artifact on disk for downstream auditability.
  // A later persistence layer can move or clean up these artifacts on its own schedule.
  return result.data;
}

export function getCodexProbeTimeoutMs() {
  const raw = process.env.BENCHMEMO_CODEX_PROBE_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_CODEX_PROBE_TIMEOUT_MS;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1_000) {
    return DEFAULT_CODEX_PROBE_TIMEOUT_MS;
  }

  return Math.floor(value);
}

function buildPrompt(req: RepoProbeRequest): string {
  const scopedPaths = req.paths.length > 0 ? req.paths.join(', ') : 'entire repository';

  return [
    'Read-only engineering decision probe.',
    'This is a non-interactive batch probe. Do not ask follow-up questions.',
    `Decision ID: ${req.decisionId}`,
    `Option ID: ${req.optionId}`,
    `Probe type: ${req.probeType}`,
    `Repository: ${req.repoName}`,
    `Scope: ${scopedPaths}`,
    `Question: ${req.question}`,
    'Rules:',
    '- Do not modify files.',
    '- Do not ask the user for input and never call request_user_input.',
    '- Do not spawn sub-agents or use collaboration tools.',
    '- Do not use MCP resources, GitHub tools, browser tools, web search, or external network lookups.',
    '- Use only local shell commands and local file inspection against this repository.',
    '- Stay within the scoped paths only.',
    '- Keep the investigation narrow and stop once the requested schema can be filled with concrete evidence.',
    '- Prefer rg plus targeted file reads over broad repository scans.',
    '- Inspect only directly referenced files unless a dependency is explicitly discovered.',
    '- Prefer code, config, tests, docs, and infra artifacts over speculation.',
    '- Keep citations concise and limited to the most relevant file paths, symbols, test names, commands, or config blocks.',
    '- If evidence is missing, say so briefly instead of continuing to search.',
    '- Return only the JSON schema requested by the harness.',
  ].join('\n');
}

function buildProbeFailure(input: {
  taskId: string;
  req: RepoProbeRequest;
  attempts: number;
  errorMessage: string;
  failureKind?: RepoProbeFailureKind;
  failurePhase: 'preflight' | 'execution';
  retryable?: boolean;
  timedOut: boolean;
  stderrLines: string[];
  events: CodexJsonEvent[];
  diagnosticPath?: string | null;
}) {
  const classification =
    input.failureKind && typeof input.retryable === 'boolean'
      ? {
          failureKind: input.failureKind,
          retryable: input.retryable,
        }
      : classifyProbeFailure({
          errorMessage: input.errorMessage,
          timedOut: input.timedOut,
          stderrLines: input.stderrLines,
          events: input.events,
        });

  return RepoProbeFailureSchema.parse({
    taskId: input.taskId,
    decisionId: input.req.decisionId,
    optionId: input.req.optionId,
    probeType: input.req.probeType,
    status: 'failed',
    attempts: input.attempts,
    errorMessage: input.errorMessage,
    failureKind: classification.failureKind,
    failurePhase: input.failurePhase,
    retryable: classification.retryable,
    timedOut: input.timedOut,
    stderrSummary: summarizeStderr(input.stderrLines),
    eventSummary: summarizeFailureEvents(input.events, input.diagnosticPath),
    rawArtifactPath: null,
  });
}

function classifyProbeFailure(input: {
  errorMessage: string;
  timedOut: boolean;
  stderrLines: string[];
  events: CodexJsonEvent[];
}) {
  if (input.timedOut) {
    return {
      failureKind: 'timeout' as const,
      retryable: true,
    };
  }

  const haystack = [
    input.errorMessage,
    ...input.stderrLines,
    summarizeEvents(input.events),
  ]
    .join('\n')
    .toLowerCase();

  if (/(403|401|forbidden|unauthorized|not logged in|login|api key|authentication|auth state)/i.test(haystack)) {
    return {
      failureKind: 'auth' as const,
      retryable: false,
    };
  }

  if (/(failed to connect|connection|websocket|econn|socket|network|dns|refused|reset|unreachable)/i.test(haystack)) {
    return {
      failureKind: 'transport' as const,
      retryable: true,
    };
  }

  return {
    failureKind: 'cli' as const,
    retryable: false,
  };
}

function summarizeCodexEvent(event: CodexJsonEvent) {
  const type = typeof event.type === 'string' ? event.type : 'unknown';
  const item = event.item;
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    const itemType = typeof record.type === 'string' ? record.type : 'unknown_item';
    const status = typeof record.status === 'string' ? `:${record.status}` : '';
    const command =
      typeof record.command === 'string'
        ? `:${record.command.slice(0, 80)}`
        : '';
    return `${type}:${itemType}${status}${command}`;
  }

  const message = typeof event.message === 'string' ? `:${event.message.slice(0, 120)}` : '';
  return `${type}${message}`;
}

function summarizeEvents(events: CodexJsonEvent[]) {
  return events
    .slice(-5)
    .map((event) => summarizeCodexEvent(event))
    .join(' | ');
}

function summarizeFailureEvents(events: CodexJsonEvent[], diagnosticPath?: string | null) {
  const summary = summarizeEvents(events);
  if (!diagnosticPath) {
    return summary;
  }

  return [`diagnostics:${diagnosticPath}`, summary]
    .filter((value): value is string => Boolean(value))
    .join(' | ');
}

function summarizeStderr(stderrLines: string[]) {
  return stderrLines.slice(-10).join('\n');
}

async function writeProbeDiagnostics(input: {
  taskId: string;
  req: RepoProbeRequest;
  cwd: string;
  args: string[];
  prompt: string;
  outputPath: string;
  schemaPath: string;
  diagnosticsPath: string;
  probeEnvironment: PreparedCodexProbeEnvironment | null;
  stderrLines: string[];
  events: CodexJsonEvent[];
  failurePhase: 'preflight' | 'execution';
  errorMessage: string;
}) {
  try {
    await writeFile(
      input.diagnosticsPath,
      JSON.stringify(
        {
          taskId: input.taskId,
          decisionId: input.req.decisionId,
          optionId: input.req.optionId,
          probeType: input.req.probeType,
          failurePhase: input.failurePhase,
          errorMessage: input.errorMessage,
          command: 'codex',
          args: sanitizeCodexArgs(input.args, input.prompt),
          cwd: input.cwd,
          outputPath: input.outputPath,
          schemaPath: input.schemaPath,
          promptPreview: input.prompt.slice(0, 800),
          promptSha256: createHash('sha256').update(input.prompt).digest('hex'),
          probeEnvironment: input.probeEnvironment
            ? {
                probeHomeRoot: input.probeEnvironment.probeHomeRoot,
                codexHome: input.probeEnvironment.codexHome,
                configPath: input.probeEnvironment.configPath,
                authSourcePath: input.probeEnvironment.authSourcePath,
                disabledFeatures: [...CODEX_PROBE_DISABLED_FEATURES],
                configOverrides: [...CODEX_PROBE_CONFIG_OVERRIDES],
              }
            : null,
          stderrTail: input.stderrLines.slice(-10),
          eventTail: input.events.slice(-5),
          eventTailSummary: summarizeEvents(input.events),
        },
        null,
        2
      ),
      'utf8'
    );

    return input.diagnosticsPath;
  } catch {
    return null;
  }
}

function sanitizeCodexArgs(args: string[], prompt: string) {
  if (args.length === 0) {
    return args;
  }

  const sanitized = [...args];
  if (sanitized[sanitized.length - 1] === prompt) {
    sanitized[sanitized.length - 1] = '<prompt omitted>';
  }

  return sanitized;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Unknown codex execution error';
}
