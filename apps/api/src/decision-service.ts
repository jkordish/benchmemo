import {
  CreateDecisionAccepted,
  CreateDecisionAcceptedSchema,
  DecisionBrief,
  EvidencePreparationManifest,
  DecisionRunEvent,
  DecisionRunRecord,
  DecisionRunStep,
} from '@benchmemo/shared';
import { DecisionExecutor, RunnerDecisionExecutor } from './decision-executor.js';
import {
  EvidencePreparationService,
  EvidencePreparer,
} from './evidence-preparer.js';
import { DecisionArtifactStore, DecisionStore } from './store/decision-store.js';

export interface DecisionServiceOptions {
  store: DecisionStore;
  executor?: DecisionExecutor;
  evidencePreparer?: EvidencePreparer;
}

export interface RunDecisionOptions {
  onEvent?: (event: Pick<DecisionRunEvent, 'step' | 'message'>) => Promise<void> | void;
}

export class DecisionService {
  private readonly executor: DecisionExecutor;
  private readonly evidencePreparer: EvidencePreparer;
  private readonly activeRuns = new Map<string, Promise<DecisionRunRecord>>();

  constructor(private readonly options: DecisionServiceOptions) {
    this.executor = options.executor ?? new RunnerDecisionExecutor();
    this.evidencePreparer = options.evidencePreparer ?? new EvidencePreparationService();
  }

  async createDecision(brief: DecisionBrief): Promise<CreateDecisionAccepted> {
    const record = await this.options.store.create(brief);
    void this.trackRun(record);

    return CreateDecisionAcceptedSchema.parse({
      id: record.id,
      status: record.status,
      location: `/decisions/${record.id}`,
    });
  }

  async getDecision(id: string): Promise<DecisionRunRecord | null> {
    return this.options.store.get(id);
  }

  async runDecision(
    brief: DecisionBrief,
    options: RunDecisionOptions = {}
  ): Promise<DecisionRunRecord> {
    const record = await this.options.store.create(brief);
    return this.trackRun(record, options);
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled(this.activeRuns.values());
  }

  private trackRun(
    record: DecisionRunRecord,
    options: RunDecisionOptions = {}
  ): Promise<DecisionRunRecord> {
    const existing = this.activeRuns.get(record.id);
    if (existing) {
      return existing;
    }

    const task = this.executeRun(record, options)
      .catch((error) => this.options.store.markFailed(record.id, error))
      .finally(() => {
        this.activeRuns.delete(record.id);
      });

    this.activeRuns.set(record.id, task);
    return task;
  }

  private async executeRun(
    record: DecisionRunRecord,
    options: RunDecisionOptions = {}
  ): Promise<DecisionRunRecord> {
    await this.options.store.markRunning(record.id);
    await this.emitEvent(record.id, 'received', 'Decision brief accepted', options);

    const prepared = await this.evidencePreparer.prepare(record.brief);
    await this.options.store.replaceBrief(record.id, prepared.brief);
    await this.persistStep(
      record.id,
      'evidence_prepared',
      prepared.manifest,
      formatEvidencePreparedMessage(prepared.manifest),
      options
    );

    let shouldSkipExecutorReceived = true;

    const finalMemo = await this.executor.run(prepared.brief, {
      onEvent: async (event) => {
        if (shouldSkipExecutorReceived && event.step === 'received') {
          shouldSkipExecutorReceived = false;
          return;
        }

        shouldSkipExecutorReceived = false;
        await this.options.store.appendEvent(record.id, event);
        await options.onEvent?.(event);
      },
      artifactStore: new DecisionArtifactStore(this.options.store, record.id),
    });

    return this.options.store.markCompleted(record.id, finalMemo);
  }

  private async persistStep(
    decisionId: string,
    step: DecisionRunStep,
    artifact: unknown,
    message: string,
    options: RunDecisionOptions
  ) {
    await this.options.store.saveArtifact(decisionId, step, artifact);
    await this.emitEvent(decisionId, step, message, options);
  }

  private async emitEvent(
    decisionId: string,
    step: DecisionRunStep,
    message: string,
    options: RunDecisionOptions
  ) {
    await this.options.store.appendEvent(decisionId, { step, message });
    await options.onEvent?.({ step, message });
  }
}

function formatEvidencePreparedMessage(manifest: EvidencePreparationManifest) {
  const repoDocsAttached = manifest.selectedSources.filter(
    (item) => item.kind === 'repo_doc' && item.attachmentFileId
  ).length;
  const githubArtifactsAttached = manifest.selectedSources.filter(
    (item) => item.kind !== 'repo_doc' && item.attachmentFileId
  ).length;
  const warningSuffix =
    manifest.warnings.length > 0 ? `, ${manifest.warnings.length} warning${manifest.warnings.length === 1 ? '' : 's'}` : '';

  return `Evidence prepared (${repoDocsAttached} repo docs, ${githubArtifactsAttached} GitHub artifacts attached${warningSuffix})`;
}
