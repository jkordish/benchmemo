import { spawn } from 'node:child_process';
import { RepoProbeFailureKind } from '@benchmemo/shared';

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5_000;

export interface CodexPreflightCheck {
  id: 'openai_api_key' | 'codex_binary' | 'codex_login';
  ok: boolean;
  summary: string;
  detail: string;
}

export interface CodexPreflightFailure {
  errorMessage: string;
  failureKind: RepoProbeFailureKind;
  failurePhase: 'preflight';
  retryable: boolean;
  stderrSummary: string;
  eventSummary: string;
}

export interface CodexPreflightResult {
  ok: boolean;
  checks: CodexPreflightCheck[];
  failure: CodexPreflightFailure | null;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorMessage: string | null;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }
) => Promise<CommandResult>;

export interface RunCodexPreflightOptions {
  commandRunner?: CommandRunner;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export async function runCodexPreflight(
  options: RunCodexPreflightOptions = {}
): Promise<CodexPreflightResult> {
  const env = options.env ?? process.env;
  const commandRunner = options.commandRunner ?? runCommand;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const checks: CodexPreflightCheck[] = [];

  const openAiApiKey = env.OPENAI_API_KEY?.trim();
  if (openAiApiKey) {
    checks.push({
      id: 'openai_api_key',
      ok: true,
      summary: 'OPENAI_API_KEY is set for API agents.',
      detail: 'BenchMemo can authenticate the agent pipeline through the OpenAI API path.',
    });
  } else {
    checks.push({
      id: 'openai_api_key',
      ok: false,
      summary: 'OPENAI_API_KEY is not set.',
      detail: 'Set OPENAI_API_KEY before starting live BenchMemo runs.',
    });
  }

  const binaryResult = await commandRunner('codex', ['--version'], {
    cwd: options.cwd,
    env,
    timeoutMs,
  });

  if (!commandSucceeded(binaryResult)) {
    const detail = formatCommandDetail(binaryResult);
    checks.push({
      id: 'codex_binary',
      ok: false,
      summary: 'Codex CLI is not available on PATH.',
      detail,
    });

    return buildFailureResult(checks, {
      errorMessage: 'Codex CLI is not available on PATH.',
      failureKind: 'cli',
      failurePhase: 'preflight',
      retryable: false,
      stderrSummary: detail,
      eventSummary: '',
    });
  }

  checks.push({
    id: 'codex_binary',
    ok: true,
    summary: 'Codex CLI is available.',
    detail: binaryResult.stdout.trim() || 'codex --version completed successfully.',
  });

  const loginResult = await commandRunner('codex', ['login', 'status'], {
    cwd: options.cwd,
    env,
    timeoutMs,
  });
  const loginOutput = [loginResult.stdout.trim(), loginResult.stderr.trim()].filter(Boolean).join('\n');
  const loginReady =
    commandSucceeded(loginResult) &&
    /^logged in\b/i.test(loginOutput) &&
    !/not logged in/i.test(loginOutput);

  if (loginReady) {
    checks.push({
      id: 'codex_login',
      ok: true,
      summary: 'Codex login status is ready.',
      detail: loginOutput,
    });
  } else {
    checks.push({
      id: 'codex_login',
      ok: false,
      summary: 'Codex login status is not ready.',
      detail: loginOutput || formatCommandDetail(loginResult),
    });
  }

  const failedCheck = checks.find((check) => !check.ok);
  if (!failedCheck) {
    return {
      ok: true,
      checks,
      failure: null,
    };
  }

  if (failedCheck.id === 'codex_login') {
    return buildFailureResult(checks, {
      errorMessage: 'Codex login is not ready.',
      failureKind: 'auth',
      failurePhase: 'preflight',
      retryable: false,
      stderrSummary: failedCheck.detail,
      eventSummary: '',
    });
  }

  return buildFailureResult(checks, {
    errorMessage: 'OPENAI_API_KEY is not set for BenchMemo API agents.',
    failureKind: 'auth',
    failurePhase: 'preflight',
    retryable: false,
    stderrSummary: failedCheck.detail,
    eventSummary: '',
  });
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, 1_000).unref();
      resolve({
        exitCode: null,
        stdout,
        stderr,
        errorMessage: `${command} ${args.join(' ')} timed out after ${options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS}ms`,
      });
    }, options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS);

    if (!child.stdout || !child.stderr) {
      clearTimeout(timeout);
      resolve({
        exitCode: null,
        stdout,
        stderr,
        errorMessage: `${command} did not expose stdout/stderr pipes`,
      });
      return;
    }

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: null,
        stdout,
        stderr,
        errorMessage: error.message,
      });
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout,
        stderr,
        errorMessage: null,
      });
    });
  });
}

function commandSucceeded(result: CommandResult) {
  return result.exitCode === 0 && !result.errorMessage;
}

function buildFailureResult(
  checks: CodexPreflightCheck[],
  failure: CodexPreflightFailure
): CodexPreflightResult {
  return {
    ok: false,
    checks,
    failure,
  };
}

function formatCommandDetail(result: CommandResult) {
  return [
    result.errorMessage?.trim(),
    result.stderr.trim(),
    result.stdout.trim(),
    result.exitCode === null ? null : `exit code ${result.exitCode}`,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n');
}
