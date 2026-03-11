import { runCodexPreflight } from '../workers/codex-runner/src/preflight.js';

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

async function main() {
  const result = await runCodexPreflight();

  console.log('BenchMemo doctor');
  console.log('');

  for (const check of result.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.summary}`);
    console.log(`  ${check.detail}`);
  }

  console.log('');
  console.log(`Overall: ${result.ok ? 'READY' : 'NOT READY'}`);
  console.log('Note: doctor is a lightweight preflight and does not execute a live `codex exec` probe.');
  console.log(
    `GitHub discovery: ${process.env.GITHUB_TOKEN?.trim() ? 'ENABLED' : 'LIMITED (set GITHUB_TOKEN for issues, PRs, and releases)'}`
  );

  if (!result.ok && result.failure) {
    console.log(`Failure kind: ${result.failure.failureKind}`);
    console.log(`Failure phase: ${result.failure.failurePhase}`);
    console.log(`Retryable: ${result.failure.retryable ? 'yes' : 'no'}`);
  }

  process.exit(result.ok ? 0 : 1);
}
