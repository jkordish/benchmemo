import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  DecisionArtifactRef,
  DecisionArtifactRefSchema,
  DecisionBrief,
  DecisionRunEvent,
  DecisionRunEventSchema,
  DecisionRunRecord,
  DecisionRunRecordSchema,
  DecisionRunStep,
  FinalMemo,
  RepoProbeResultSchema,
} from '@benchmemo/shared';
import { z } from 'zod';
import type { ArtifactStore } from '../orchestrator/decision-runner.js';

export type DecisionEventInput = Pick<DecisionRunEvent, 'step' | 'message'>;

export interface DecisionStore {
  create(brief: DecisionBrief): Promise<DecisionRunRecord>;
  get(id: string): Promise<DecisionRunRecord | null>;
  markRunning(id: string): Promise<DecisionRunRecord>;
  appendEvent(id: string, event: DecisionEventInput): Promise<DecisionRunRecord>;
  saveArtifact(id: string, step: DecisionRunStep, artifact: unknown): Promise<DecisionArtifactRef>;
  markCompleted(id: string, finalMemo: FinalMemo): Promise<DecisionRunRecord>;
  markFailed(id: string, error: unknown): Promise<DecisionRunRecord>;
}

export class DuplicateDecisionError extends Error {
  constructor(id: string) {
    super(`Decision ${id} already exists`);
    this.name = 'DuplicateDecisionError';
  }
}

export class FileDecisionStore implements DecisionStore {
  readonly rootDir: string;

  constructor(rootDir = process.env.BENCHMEMO_DATA_DIR ?? join(process.cwd(), '.benchmemo-data')) {
    this.rootDir = resolve(rootDir);
  }

  async create(brief: DecisionBrief): Promise<DecisionRunRecord> {
    const now = nowIso();
    const record = DecisionRunRecordSchema.parse({
      id: brief.id,
      status: 'queued',
      brief,
      events: [],
      artifactRefs: [],
      finalMemo: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      failedAt: null,
    });

    await mkdir(this.decisionsDir(), { recursive: true });

    try {
      await writeFile(this.recordPath(brief.id), toJson(record), { flag: 'wx' });
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw new DuplicateDecisionError(brief.id);
      }

      throw error;
    }

    return record;
  }

  async get(id: string): Promise<DecisionRunRecord | null> {
    try {
      const raw = await readFile(this.recordPath(id), 'utf8');
      return DecisionRunRecordSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return null;
      }

      throw error;
    }
  }

  async markRunning(id: string): Promise<DecisionRunRecord> {
    return this.updateRecord(id, (record) => {
      const now = nowIso();

      return {
        ...record,
        status: 'running',
        updatedAt: now,
        startedAt: record.startedAt ?? now,
        failedAt: null,
        error: null,
      };
    });
  }

  async appendEvent(id: string, event: DecisionEventInput): Promise<DecisionRunRecord> {
    return this.updateRecord(id, (record) => {
      const now = nowIso();
      const nextEvent = DecisionRunEventSchema.parse({
        ...event,
        at: now,
      });

      return {
        ...record,
        events: [...record.events, nextEvent],
        updatedAt: now,
      };
    });
  }

  async saveArtifact(id: string, step: DecisionRunStep, artifact: unknown): Promise<DecisionArtifactRef> {
    const createdAt = nowIso();
    const normalizedArtifact = await this.normalizeArtifact(id, artifact);
    const artifactPath = join(this.artifactDir(id), `${step}.json`);
    await writeJsonAtomic(artifactPath, normalizedArtifact);

    const ref = DecisionArtifactRefSchema.parse({
      step,
      path: artifactPath,
      createdAt,
    });

    await this.updateRecord(id, (record) => ({
      ...record,
      artifactRefs: [...record.artifactRefs.filter((item) => item.step !== step), ref],
      updatedAt: createdAt,
    }));

    return ref;
  }

  async markCompleted(id: string, finalMemo: FinalMemo): Promise<DecisionRunRecord> {
    return this.updateRecord(id, (record) => {
      const now = nowIso();

      return {
        ...record,
        status: 'completed',
        finalMemo,
        error: null,
        updatedAt: now,
        completedAt: now,
        failedAt: null,
      };
    });
  }

  async markFailed(id: string, error: unknown): Promise<DecisionRunRecord> {
    return this.updateRecord(id, (record) => {
      const now = nowIso();

      return {
        ...record,
        status: 'failed',
        finalMemo: null,
        error: {
          message: toErrorMessage(error),
        },
        updatedAt: now,
        failedAt: now,
        completedAt: null,
      };
    });
  }

  private decisionsDir() {
    return join(this.rootDir, 'decisions');
  }

  private artifactDir(id: string) {
    return join(this.rootDir, 'artifacts', id);
  }

  private recordPath(id: string) {
    return join(this.decisionsDir(), `${id}.json`);
  }

  private async updateRecord(
    id: string,
    update: (record: DecisionRunRecord) => DecisionRunRecord | Promise<DecisionRunRecord>
  ): Promise<DecisionRunRecord> {
    const current = await this.get(id);
    if (!current) {
      throw new Error(`Decision ${id} not found`);
    }

    const next = DecisionRunRecordSchema.parse(await update(current));
    await writeJsonAtomic(this.recordPath(id), next);
    return next;
  }

  private async normalizeArtifact(id: string, artifact: unknown): Promise<unknown> {
    const repoProbes = z.array(RepoProbeResultSchema).safeParse(artifact);
    if (!repoProbes.success) {
      return artifact;
    }

    const rawArtifactDir = join(this.artifactDir(id), 'repo-probes');
    await mkdir(rawArtifactDir, { recursive: true });

    return Promise.all(
      repoProbes.data.map(async (probe) => {
        const durableRawPath = join(rawArtifactDir, `${probe.taskId}.json`);
        await copyFile(probe.rawArtifactPath, durableRawPath);

        return {
          ...probe,
          rawArtifactPath: durableRawPath,
        };
      })
    );
  }
}

export class DecisionArtifactStore implements ArtifactStore {
  constructor(
    private readonly store: DecisionStore,
    private readonly decisionId: string
  ) {}

  async save(step: DecisionRunStep, artifact: unknown): Promise<void> {
    await this.store.saveArtifact(this.decisionId, step, artifact);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function toJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJsonAtomic(targetPath: string, value: unknown) {
  await mkdir(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, toJson(value));
  await rename(tempPath, targetPath);
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Unknown error';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
