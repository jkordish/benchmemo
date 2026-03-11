#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const binDir = dirname(fileURLToPath(import.meta.url));
const entryPath = resolve(binDir, '../src/index.ts');
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', entryPath, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
  }
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
