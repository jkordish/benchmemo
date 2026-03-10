import { DecisionBrief, FinalMemo } from '@benchmemo/shared';
import { DecisionRunner, DecisionRunnerOptions } from './orchestrator/decision-runner.js';

export interface DecisionExecutor {
  run(brief: DecisionBrief, options: DecisionRunnerOptions): Promise<FinalMemo>;
}

export class RunnerDecisionExecutor implements DecisionExecutor {
  async run(brief: DecisionBrief, options: DecisionRunnerOptions): Promise<FinalMemo> {
    const runner = new DecisionRunner(options);
    return runner.run(brief);
  }
}
