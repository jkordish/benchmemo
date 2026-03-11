import process from 'node:process';
import { runCli } from './cli.js';

try {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown CLI error';
  process.stderr.write(`BenchMemo CLI failed: ${message}\n`);
  process.exitCode = 1;
}
