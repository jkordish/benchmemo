import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { DecisionBrief } from '@benchmemo/shared';
import {
  DefaultGitHubArtifactDiscoverer,
  DefaultRepoDocumentDiscoverer,
  EvidencePreparationService,
  type GitHubFetch,
  type KnowledgeBaseAttachmentResult,
  type KnowledgeBaseClient,
  type PreparedTextSource,
  type SourceDiscoveryResult,
} from './evidence-preparer.js';

test('DefaultRepoDocumentDiscoverer selects allowlisted repo docs and skips oversized files', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'benchmemo-repo-docs-'));

  await writeFile(join(repoRoot, 'AGENTS.md'), '# Repo rules\nKeep claims grounded.\n');
  await writeFile(join(repoRoot, 'README.md'), '# BenchMemo\nEvidence-first memos.\n');
  await writeFile(join(repoRoot, 'DECISIONS.md'), '# Decision log\n');
  await mkdir(join(repoRoot, 'docs'), { recursive: true });
  await writeFile(join(repoRoot, 'docs', 'guide.md'), '# Guide\nUse the CLI.\n');
  await writeFile(join(repoRoot, 'docs', 'too-big.md'), `${'a'.repeat(100_001)}\n`);
  await writeFile(join(repoRoot, 'notes.txt'), 'ignore me\n');

  try {
    const discoverer = new DefaultRepoDocumentDiscoverer();
    const result = await discoverer.discover(makeBrief(repoRoot));

    assert.equal(result.discoveredCount, 5);
    assert.deepEqual(
      result.selectedSources.map((item) => item.locator),
      ['AGENTS.md', 'README.md', 'DECISIONS.md', 'docs/guide.md']
    );
    assert.ok(
      result.skippedSources.some(
        (item) => item.locator === 'docs/too-big.md' && /larger than/i.test(item.reason)
      )
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('DefaultGitHubArtifactDiscoverer warns cleanly when GITHUB_TOKEN is missing', async () => {
  const discoverer = new DefaultGitHubArtifactDiscoverer({
    token: null,
  });

  const result = await discoverer.discover(makeBrief('/repo'));

  assert.equal(result.discoveredCount, 0);
  assert.equal(result.selectedSources.length, 0);
  assert.match(result.warnings[0]?.message ?? '', /GITHUB_TOKEN/i);
});

test('DefaultGitHubArtifactDiscoverer ranks relevant issues and pull requests above irrelevant releases', async () => {
  const fetchImpl: GitHubFetch = async (input) => {
    if (input.includes('/issues?')) {
      return okJson([
        {
          number: 42,
          title: 'Improve memo UX for first-time readers',
          body: 'The current decision memo is hard to scan during demos.',
          html_url: 'https://github.com/acme/platform/issues/42',
          updated_at: '2026-03-10T00:00:00.000Z',
          labels: [{ name: 'ux' }],
        },
      ]);
    }

    if (input.includes('/pulls?')) {
      return okJson([
        {
          number: 99,
          title: 'Refine evidence input scoring',
          body: 'Tightens ranking of imported planning artifacts for decision quality.',
          html_url: 'https://github.com/acme/platform/pull/99',
          merged_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-09T00:00:00.000Z',
        },
      ]);
    }

    if (input.includes('/releases?')) {
      return okJson([
        {
          id: 7,
          tag_name: 'v0.1.0',
          body: 'Routine maintenance release.',
          html_url: 'https://github.com/acme/platform/releases/tag/v0.1.0',
          published_at: '2026-01-01T00:00:00.000Z',
        },
      ]);
    }

    throw new Error(`Unexpected GitHub URL: ${input}`);
  };

  const discoverer = new DefaultGitHubArtifactDiscoverer({
    token: 'ghs_test',
    fetchImpl,
    now: () => new Date('2026-03-11T00:00:00.000Z'),
  });

  const result = await discoverer.discover(makeBrief('/repo'));

  assert.equal(result.discoveredCount, 3);
  assert.deepEqual(
    result.selectedSources.map((item) => item.kind),
    ['github_issue', 'github_pull_request']
  );
  assert.ok(
    result.skippedSources.some(
      (item) => item.kind === 'github_release' && /did not overlap meaningfully/i.test(item.reason)
    )
  );
});

test('EvidencePreparationService enriches the brief with discovered attachments and manifest metadata', async () => {
  const service = new EvidencePreparationService({
    repoDocumentDiscoverer: {
      async discover(): Promise<SourceDiscoveryResult> {
        return {
          discoveredCount: 1,
          selectedSources: [
            makeSource({
              id: 'repo_doc:README.md',
              kind: 'repo_doc',
              title: 'README',
              locator: 'README.md',
              score: 95,
            }),
          ],
          skippedSources: [],
          warnings: [],
        };
      },
    },
    githubArtifactDiscoverer: {
      async discover(): Promise<SourceDiscoveryResult> {
        return {
          discoveredCount: 1,
          selectedSources: [
            makeSource({
              id: 'github_issue:17',
              kind: 'github_issue',
              title: 'Issue #17: Improve import relevance',
              locator: 'https://github.com/acme/platform/issues/17',
              score: 11,
            }),
          ],
          skippedSources: [],
          warnings: [],
        };
      },
    },
    knowledgeBaseClient: new StubKnowledgeBaseClient(),
  });

  const prepared = await service.prepare(makeBrief('/repo'));

  assert.equal(prepared.brief.attachments.length, 1);
  assert.equal(prepared.manifest.repoDocumentsDiscovered, 1);
  assert.equal(prepared.manifest.githubArtifactsDiscovered, 1);
  assert.equal(prepared.manifest.selectedSources[0]?.attachmentFileId, 'file_docs_1');
  assert.equal(prepared.manifest.selectedSources[1]?.attachmentFileId, null);
});

function makeBrief(localPath: string): DecisionBrief {
  return {
    id: 'dec_evidence_inputs',
    title: 'Improve memo UX or evidence logic?',
    question: 'Should BenchMemo improve memo UX or expand evidence inputs next?',
    repo: {
      provider: 'github',
      repoName: 'acme/platform',
      branch: 'main',
      localPath,
      paths: [],
    },
    options: [
      {
        id: 'opt_ux',
        name: 'Improve memo UX',
        description: 'Make decision output easier to scan and trust.',
      },
      {
        id: 'opt_inputs',
        name: 'Expand evidence inputs',
        description: 'Import repo docs and GitHub planning artifacts automatically.',
      },
    ],
    constraints: ['Keep iteration speed high'],
    criteria: [
      { id: 'risk', name: 'Risk', weight: 55 },
      { id: 'velocity', name: 'Velocity', weight: 45 },
    ],
    reversibility: 'costly_reversible',
    horizon: 'weeks',
    attachments: [],
  };
}

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      return body;
    },
  };
}

function makeSource(input: {
  id: string;
  kind: PreparedTextSource['kind'];
  title: string;
  locator: string;
  score: number;
}): PreparedTextSource {
  return {
    ...input,
    retrievedAt: '2026-03-11T00:00:00.000Z',
    text: `# ${input.title}\n\nSource ID: ${input.id}\n`,
  };
}

class StubKnowledgeBaseClient implements KnowledgeBaseClient {
  async attachSources(
    _decisionId: string,
    sources: PreparedTextSource[]
  ): Promise<KnowledgeBaseAttachmentResult> {
    return {
      attachments: [
        {
          fileId: 'file_docs_1',
          vectorStoreId: 'vs_docs_1',
        },
      ],
      vectorStoreId: 'vs_docs_1',
      attachmentFileIdsBySourceId: new Map([[sources[0]?.id ?? 'repo_doc:README.md', 'file_docs_1']]),
      warnings: [],
    };
  }
}
