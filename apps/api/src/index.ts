import { DecisionRunner } from './orchestrator/decision-runner.js';
import { DecisionBrief } from '@benchmemo/shared';

const sample: DecisionBrief = {
  id: 'dec_001',
  title: 'Split billing out of the monolith?',
  question:
    'Should we keep billing inside the monolith or extract it into its own service this quarter?',
  repo: {
    provider: 'github',
    repoName: 'acme/platform',
    localPath: process.cwd(),
    branch: 'main',
    paths: ['services/billing', 'infra', 'tests'],
  },
  options: [
    {
      id: 'opt_keep',
      name: 'Keep billing in monolith',
      description: 'Improve module boundaries and observability without a service split.',
    },
    {
      id: 'opt_split',
      name: 'Extract billing service',
      description: 'Create an independent billing service with separate deploy and ownership boundaries.',
    },
  ],
  constraints: ['No customer-visible billing outage', 'Support rollback within one deploy window'],
  criteria: [
    { id: 'risk', name: 'Delivery risk', weight: 30 },
    { id: 'ops', name: 'Operational burden', weight: 25 },
    { id: 'velocity', name: 'Team velocity', weight: 25 },
    { id: 'reversibility', name: 'Reversibility', weight: 20 },
  ],
  reversibility: 'costly_reversible',
  horizon: 'quarters',
  attachments: [],
};

async function main() {
  const runner = new DecisionRunner({
    onEvent(event) {
      console.log(`\n[${event.step}] ${event.message}`);
    },
  });

  const memo = await runner.run(sample);
  console.log('\nFINAL MEMO\n');
  console.dir(memo, { depth: null });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
