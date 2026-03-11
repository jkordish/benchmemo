import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RepoProbeFailureKind } from '@benchmemo/shared';

const PROBE_HOME_PREFIX = '.benchmemo-codex-home-';
const PROBE_PROJECT_DOC_MAX_BYTES = 16_384;
const PROBE_MODEL_REASONING_EFFORT = 'low';

export const CODEX_PROBE_DISABLED_FEATURES = [
  'shell_snapshot',
  'apps',
  'multi_agent',
  'js_repl',
] as const;

export const CODEX_PROBE_CONFIG_OVERRIDES = [
  'approval_policy="never"',
  'shell_environment_policy.experimental_use_profile=false',
  'shell_environment_policy.inherit="core"',
  `project_doc_max_bytes=${PROBE_PROJECT_DOC_MAX_BYTES}`,
  `model_reasoning_effort="${PROBE_MODEL_REASONING_EFFORT}"`,
  'mcp_servers={}',
] as const;

export interface PreparedCodexProbeEnvironment {
  env: NodeJS.ProcessEnv;
  probeHomeRoot: string;
  codexHome: string;
  configPath: string;
  authSourcePath: string;
  cleanup: () => Promise<void>;
}

export class CodexProbeEnvironmentError extends Error {
  readonly failureKind: RepoProbeFailureKind;

  constructor(message: string, failureKind: RepoProbeFailureKind = 'auth') {
    super(message);
    this.name = 'CodexProbeEnvironmentError';
    this.failureKind = failureKind;
  }
}

export async function prepareCodexProbeEnvironment(
  sourceEnv: NodeJS.ProcessEnv = process.env
): Promise<PreparedCodexProbeEnvironment> {
  const sourceHome = getSourceHome(sourceEnv);
  const sourceCodexHome = (sourceEnv.CODEX_HOME?.trim() || join(sourceHome, '.codex'));
  const authSourcePath = join(sourceCodexHome, 'auth.json');
  let probeHomeRoot: string | null = null;

  try {
    probeHomeRoot = await mkdtemp(join(sourceHome, PROBE_HOME_PREFIX));
    const codexHome = join(probeHomeRoot, '.codex');
    const configPath = join(codexHome, 'config.toml');
    await mkdir(codexHome, { recursive: true });
    await copyFile(authSourcePath, join(codexHome, 'auth.json'));
    await writeFile(configPath, buildCodexProbeConfig(), 'utf8');

    const env: NodeJS.ProcessEnv = {
      ...sourceEnv,
      HOME: probeHomeRoot,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: join(probeHomeRoot, '.config'),
    };

    const preparedProbeHomeRoot = probeHomeRoot;

    return {
      env,
      probeHomeRoot: preparedProbeHomeRoot,
      codexHome,
      configPath,
      authSourcePath,
      cleanup: () => cleanupProbeHome(preparedProbeHomeRoot),
    };
  } catch (error) {
    if (probeHomeRoot) {
      await cleanupProbeHome(probeHomeRoot);
    }

    throw normalizeProbeEnvironmentError(error, authSourcePath);
  }
}

export function buildCodexProbeCliArgs(): string[] {
  return [
    ...CODEX_PROBE_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    ...CODEX_PROBE_CONFIG_OVERRIDES.flatMap((override) => ['-c', override]),
  ];
}

function buildCodexProbeConfig() {
  return [
    'approval_policy = "never"',
    `project_doc_max_bytes = ${PROBE_PROJECT_DOC_MAX_BYTES}`,
    `model_reasoning_effort = "${PROBE_MODEL_REASONING_EFFORT}"`,
    '',
    '[shell_environment_policy]',
    'inherit = "core"',
    'experimental_use_profile = false',
    '',
    '[features]',
    ...CODEX_PROBE_DISABLED_FEATURES.map((feature) => `${feature} = false`),
    '',
    '[mcp_servers]',
    '',
  ].join('\n');
}

function getSourceHome(sourceEnv: NodeJS.ProcessEnv) {
  const value = sourceEnv.HOME?.trim() || homedir();
  if (value) {
    return value;
  }

  throw new CodexProbeEnvironmentError(
    'HOME is not set; cannot prepare an isolated Codex probe home.',
    'cli'
  );
}

async function cleanupProbeHome(probeHomeRoot: string) {
  try {
    await rm(probeHomeRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup. Probe failures should still be reported even if temp cleanup fails.
  }
}

function normalizeProbeEnvironmentError(error: unknown, authSourcePath: string) {
  const message = toErrorMessage(error);
  const code = getErrorCode(error);

  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
    return new CodexProbeEnvironmentError(
      `Codex auth state is not available for isolated probe runs at ${authSourcePath}: ${message}`,
      'auth'
    );
  }

  if (error instanceof CodexProbeEnvironmentError) {
    return error;
  }

  return new CodexProbeEnvironmentError(
    `Failed to prepare isolated Codex probe home: ${message}`,
    'cli'
  );
}

function getErrorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }

  return null;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Unknown probe environment error';
}
