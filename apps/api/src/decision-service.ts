import { CreateDecisionAccepted, CreateDecisionAcceptedSchema, DecisionBrief, DecisionRunRecord } from '@benchmemo/shared';
import { DecisionExecutor, RunnerDecisionExecutor } from './decision-executor.js';
import { DecisionArtifactStore, DecisionStore } from './store/decision-store.js';

export interface DecisionServiceOptions {
  store: DecisionStore;
  executor?: DecisionExecutor;
}

export class DecisionService {
  private readonly executor: DecisionExecutor;
  private readonly activeRuns = new Map<string, Promise<void>>();

  constructor(private readonly options: DecisionServiceOptions) {
    this.executor = options.executor ?? new RunnerDecisionExecutor();
  }

  async createDecision(brief: DecisionBrief): Promise<CreateDecisionAccepted> {
    const record = await this.options.store.create(brief);
    this.startRun(record);

    return CreateDecisionAcceptedSchema.parse({
      id: record.id,
      status: record.status,
      location: `/decisions/${record.id}`,
    });
  }

  async getDecision(id: string): Promise<DecisionRunRecord | null> {
    return this.options.store.get(id);
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled(this.activeRuns.values());
  }

  private startRun(record: DecisionRunRecord) {
    if (this.activeRuns.has(record.id)) {
      return;
    }

    const task = this.executeRun(record)
      .catch(async (error) => {
        await this.options.store.markFailed(record.id, error);
      })
      .finally(() => {
        this.activeRuns.delete(record.id);
      });

    this.activeRuns.set(record.id, task);
  }

  private async executeRun(record: DecisionRunRecord) {
    await this.options.store.markRunning(record.id);

    const finalMemo = await this.executor.run(record.brief, {
      onEvent: async (event) => {
        await this.options.store.appendEvent(record.id, event);
      },
      artifactStore: new DecisionArtifactStore(this.options.store, record.id),
    });

    await this.options.store.markCompleted(record.id, finalMemo);
  }
}
