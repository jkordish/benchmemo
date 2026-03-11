import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGuidedBrief,
  parseGitHubRepoName,
  splitCommaSeparatedInput,
  type PromptSession,
} from './brief-builder.js';

test('buildGuidedBrief uses git defaults and the built-in engineering template', async () => {
  const brief = await buildGuidedBrief({
    prompt: new StubPrompt([
      'Keep JSON store or move to SQLite?',
      'Should BenchMemo keep file-backed storage or adopt SQLite now?',
      '',
      'apps/api, workers/codex-runner',
      'Keep file-backed persistence',
      'Retain the current JSON-on-disk path.',
      'Move to SQLite now',
      'Adopt SQLite before more product work.',
      '',
      'Keep local setup simple, Avoid derailing the next milestone',
    ]),
    cwd: '/repo',
    gitMetadataLoader: {
      async load() {
        return {
          branch: 'main',
          repoName: 'jkordish/benchmemo',
        };
      },
    },
    now: () => new Date('2026-03-11T00:00:00Z'),
  });

  assert.deepEqual(brief, {
    id: 'dec_1773187200000',
    title: 'Keep JSON store or move to SQLite?',
    question: 'Should BenchMemo keep file-backed storage or adopt SQLite now?',
    repo: {
      provider: 'github',
      repoName: 'jkordish/benchmemo',
      branch: 'main',
      localPath: '/repo',
      paths: ['apps/api', 'workers/codex-runner'],
    },
    options: [
      {
        id: 'opt_keep_file_backed_persistence',
        name: 'Keep file-backed persistence',
        description: 'Retain the current JSON-on-disk path.',
      },
      {
        id: 'opt_move_to_sqlite_now',
        name: 'Move to SQLite now',
        description: 'Adopt SQLite before more product work.',
      },
    ],
    constraints: [
      'Keep local setup simple',
      'Avoid derailing the next milestone',
    ],
    criteria: [
      { id: 'risk', name: 'Risk', weight: 55 },
      { id: 'velocity', name: 'Velocity', weight: 45 },
    ],
    reversibility: 'costly_reversible',
    horizon: 'weeks',
    attachments: [],
  });
});

test('buildGuidedBrief falls back to prompted repo slug and creates unique option ids', async () => {
  const brief = await buildGuidedBrief({
    prompt: new StubPrompt([
      'Persistence direction',
      'Should we switch storage now?',
      'acme/platform',
      '',
      'SQLite',
      'Use SQLite for persistence.',
      'SQLite',
      'Use SQLite in a different shape.',
      'SQLite',
      'Use SQLite as a phased migration.',
      '',
      '',
    ]),
    cwd: '/workspace',
    gitMetadataLoader: {
      async load() {
        return {};
      },
    },
  });

  const options = (brief as { options: Array<{ id: string }> }).options;
  assert.deepEqual(
    options.map((option) => option.id),
    ['opt_sqlite', 'opt_sqlite_2', 'opt_sqlite_3']
  );
  assert.equal((brief as { repo: { repoName: string } }).repo.repoName, 'acme/platform');
});

test('splitCommaSeparatedInput trims blanks and empty items', () => {
  assert.deepEqual(splitCommaSeparatedInput(' apps/api, , workers/codex-runner ,, '), [
    'apps/api',
    'workers/codex-runner',
  ]);
});

test('parseGitHubRepoName handles common GitHub remote formats', () => {
  assert.equal(parseGitHubRepoName('git@github.com:jkordish/benchmemo.git'), 'jkordish/benchmemo');
  assert.equal(parseGitHubRepoName('https://github.com/jkordish/benchmemo.git'), 'jkordish/benchmemo');
  assert.equal(parseGitHubRepoName('ssh://git@github.com/jkordish/benchmemo.git'), 'jkordish/benchmemo');
  assert.equal(parseGitHubRepoName('git@gitlab.com:jkordish/benchmemo.git'), undefined);
});

class StubPrompt implements PromptSession {
  constructor(private readonly answers: string[]) {}

  async ask(_message: string) {
    const answer = this.answers.shift();
    if (typeof answer !== 'string') {
      throw new Error('Prompt answer queue exhausted');
    }

    return answer;
  }
}
