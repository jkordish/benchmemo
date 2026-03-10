import { mkdtemp, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  RepoProbeRequest,
  RepoProbeRequestSchema,
  RepoProbeResult,
  RepoProbeResultSchema,
} from '@benchmemo/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, '..', 'schemas');

export type CodexJsonEvent = Record<string, unknown>;

export async function runCodexProbe(input: RepoProbeRequest): Promise<RepoProbeResult> {
  const req = RepoProbeRequestSchema.parse(input);
  const taskId = `codex_${randomUUID()}`;
  const scratch = await mkdtemp(join(tmpdir(), 'benchmemo-codex-'));
  const outputPath = join(scratch, `${taskId}.json`);
  const schemaPath = join(SCHEMA_DIR, `${req.outputSchemaName}.schema.json`);
  const cwd = req.localPath ?? process.cwd();

  const prompt = buildPrompt(req);
  const args = [
    'exec',
    '--ephemeral',
    '--json',
    '--sandbox', req.sandbox,
    '--output-schema', schemaPath,
    '--output-last-message', outputPath,
    prompt,
  ];

  const events: CodexJsonEvent[] = [];
  const stderrLines: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

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

    child.on('error', reject);
    child.on('close', (code) => {
      if (stdoutBuffer.trim()) {
        try {
          events.push(JSON.parse(stdoutBuffer.trim()));
        } catch {
          // ignore trailing partial or non-JSON line
        }
      }

      if (stderrBuffer.trim()) {
        stderrLines.push(stderrBuffer.trim());
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `codex exec failed with exit code ${code}. stderr: ${stderrLines.join('\n')}`
        )
      );
    });
  });

  const parsed = JSON.parse(await readFile(outputPath, 'utf8')) as Omit<
    RepoProbeResult,
    'taskId' | 'decisionId' | 'optionId' | 'probeType' | 'rawArtifactPath'
  >;

  const result = RepoProbeResultSchema.parse({
    ...parsed,
    taskId,
    decisionId: req.decisionId,
    optionId: req.optionId,
    probeType: req.probeType,
    rawArtifactPath: outputPath,
  });

  // Intentionally keep the JSON artifact on disk for downstream auditability.
  // A later persistence layer can move or clean up these artifacts on its own schedule.
  return result;
}

function buildPrompt(req: RepoProbeRequest): string {
  const scopedPaths = req.paths.length > 0 ? req.paths.join(', ') : 'entire repository';

  return [
    'Read-only engineering decision probe.',
    `Decision ID: ${req.decisionId}`,
    `Option ID: ${req.optionId}`,
    `Probe type: ${req.probeType}`,
    `Repository: ${req.repoName}`,
    `Scope: ${scopedPaths}`,
    `Question: ${req.question}`,
    'Rules:',
    '- Do not modify files.',
    '- Prefer code, config, tests, docs, and infra artifacts over speculation.',
    '- Cite file paths, symbols, test names, commands, or config blocks whenever possible.',
    '- Return only the JSON schema requested by the harness.',
  ].join('\n');
}
