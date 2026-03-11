import assert from 'node:assert/strict';
import test from 'node:test';
import { runCodexPreflight, type CommandResult } from './preflight.js';
import {
  CodexProbeEnvironmentError,
  type PreparedCodexProbeEnvironment,
} from './probe-environment.js';

test('runCodexPreflight reports ready when OPENAI_API_KEY, codex, and isolated login status are available', async () => {
  const result = await runCodexPreflight({
    env: {
      ...process.env,
      OPENAI_API_KEY: 'sk-test',
      HOME: '/home/tester',
    },
    probeEnvironmentFactory: async (sourceEnv) =>
      makePreparedProbeEnvironment(sourceEnv, '/tmp/benchmemo-preflight-home'),
    commandRunner: async (command, args, options) => {
      if (command === 'codex' && args[0] === '--version') {
        assert.equal(options?.env?.HOME, '/home/tester');
        return success('codex 0.0.0');
      }

      if (command === 'codex' && args[0] === 'login') {
        assert.equal(options?.env?.HOME, '/tmp/benchmemo-preflight-home');
        return success('Logged in using ChatGPT');
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.failure, null);
  assert.equal(result.checks.every((check) => check.ok), true);
});

test('runCodexPreflight reports auth failure when OPENAI_API_KEY is missing', async () => {
  const result = await runCodexPreflight({
    env: {},
    probeEnvironmentFactory: async (sourceEnv) =>
      makePreparedProbeEnvironment(sourceEnv, '/tmp/benchmemo-preflight-home'),
    commandRunner: async (command, args) => {
      if (command === 'codex' && args[0] === '--version') {
        return success('codex 0.0.0');
      }

      if (command === 'codex' && args[0] === 'login') {
        return success('Logged in using ChatGPT');
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure?.failureKind, 'auth');
  assert.equal(result.failure?.failurePhase, 'preflight');
  assert.equal(result.failure?.retryable, false);
  assert.match(result.failure?.errorMessage ?? '', /OPENAI_API_KEY/i);
});

test('runCodexPreflight reports cli failure when codex is unavailable', async () => {
  const result = await runCodexPreflight({
    env: {
      OPENAI_API_KEY: 'sk-test',
    },
    commandRunner: async () => ({
      exitCode: null,
      stdout: '',
      stderr: '',
      errorMessage: 'spawn codex ENOENT',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure?.failureKind, 'cli');
  assert.equal(result.failure?.retryable, false);
  assert.match(result.failure?.errorMessage ?? '', /Codex CLI/i);
});

test('runCodexPreflight reports auth failure when isolated probe auth setup is unavailable', async () => {
  const result = await runCodexPreflight({
    env: {
      OPENAI_API_KEY: 'sk-test',
    },
    probeEnvironmentFactory: async () => {
      throw new CodexProbeEnvironmentError(
        'Codex auth state is not available for isolated probe runs at /home/test/.codex/auth.json: ENOENT',
        'auth'
      );
    },
    commandRunner: async (command, args) => {
      if (command === 'codex' && args[0] === '--version') {
        return success('codex 0.0.0');
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure?.failureKind, 'auth');
  assert.equal(result.failure?.retryable, false);
  assert.match(result.failure?.stderrSummary ?? '', /auth state is not available/i);
});

test('runCodexPreflight reports auth failure when codex login is not ready', async () => {
  const result = await runCodexPreflight({
    env: {
      OPENAI_API_KEY: 'sk-test',
    },
    probeEnvironmentFactory: async (sourceEnv) =>
      makePreparedProbeEnvironment(sourceEnv, '/tmp/benchmemo-preflight-home'),
    commandRunner: async (command, args) => {
      if (command === 'codex' && args[0] === '--version') {
        return success('codex 0.0.0');
      }

      if (command === 'codex' && args[0] === 'login') {
        return success('Not logged in');
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure?.failureKind, 'auth');
  assert.equal(result.failure?.retryable, false);
  assert.match(result.failure?.stderrSummary ?? '', /Not logged in/i);
});

function makePreparedProbeEnvironment(
  sourceEnv: NodeJS.ProcessEnv | undefined,
  probeHomeRoot: string
): PreparedCodexProbeEnvironment {
  const env = {
    ...(sourceEnv ?? {}),
    HOME: probeHomeRoot,
    CODEX_HOME: `${probeHomeRoot}/.codex`,
  };

  return {
    env,
    probeHomeRoot,
    codexHome: env.CODEX_HOME,
    configPath: `${env.CODEX_HOME}/config.toml`,
    authSourcePath: '/home/tester/.codex/auth.json',
    cleanup: async () => {},
  };
}

function success(stdout: string): CommandResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    errorMessage: null,
  };
}
