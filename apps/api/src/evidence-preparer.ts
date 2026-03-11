import { createReadStream } from 'node:fs';
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import OpenAI from 'openai';
import {
  DecisionAttachment,
  DecisionBrief,
  DecisionBriefSchema,
  EvidencePreparationManifest,
  EvidencePreparationManifestSchema,
  EvidencePreparationWarning,
  EvidencePreparedSkippedSource,
  EvidencePreparedSource,
  EvidenceSourceKind,
} from '@benchmemo/shared';

const MAX_REPO_DOC_SELECTION = 12;
const MAX_REPO_DOC_BYTES = 100_000;
const MAX_GITHUB_ISSUES = 20;
const MAX_GITHUB_PULLS = 20;
const MAX_GITHUB_RELEASES = 10;
const MAX_GITHUB_SELECTION = 6;
const MAX_GITHUB_BODY_CHARS = 20_000;
const MAX_GITHUB_PER_KIND: Record<EvidenceSourceKind, number> = {
  repo_doc: MAX_REPO_DOC_SELECTION,
  github_issue: 3,
  github_pull_request: 2,
  github_release: 1,
};

export interface PreparedDecisionEvidence {
  brief: DecisionBrief;
  manifest: EvidencePreparationManifest;
}

export interface EvidencePreparer {
  prepare(brief: DecisionBrief): Promise<PreparedDecisionEvidence>;
}

export interface PreparedTextSource {
  id: string;
  kind: EvidenceSourceKind;
  title: string;
  locator: string;
  score: number;
  retrievedAt: string;
  text: string;
}

export interface SourceDiscoveryResult {
  discoveredCount: number;
  selectedSources: PreparedTextSource[];
  skippedSources: EvidencePreparedSkippedSource[];
  warnings: EvidencePreparationWarning[];
}

export interface RepoDocumentDiscoverer {
  discover(brief: DecisionBrief): Promise<SourceDiscoveryResult>;
}

export interface GitHubArtifactDiscoverer {
  discover(brief: DecisionBrief): Promise<SourceDiscoveryResult>;
}

export interface KnowledgeBaseAttachmentResult {
  attachments: DecisionAttachment[];
  vectorStoreId: string | null;
  attachmentFileIdsBySourceId: Map<string, string>;
  warnings: EvidencePreparationWarning[];
}

export interface KnowledgeBaseClient {
  attachSources(
    decisionId: string,
    sources: PreparedTextSource[]
  ): Promise<KnowledgeBaseAttachmentResult>;
}

export interface EvidencePreparationServiceOptions {
  repoDocumentDiscoverer?: RepoDocumentDiscoverer;
  githubArtifactDiscoverer?: GitHubArtifactDiscoverer;
  knowledgeBaseClient?: KnowledgeBaseClient;
}

export class EvidencePreparationService implements EvidencePreparer {
  private readonly repoDocumentDiscoverer: RepoDocumentDiscoverer;
  private readonly githubArtifactDiscoverer: GitHubArtifactDiscoverer;
  private readonly knowledgeBaseClient: KnowledgeBaseClient;

  constructor(options: EvidencePreparationServiceOptions = {}) {
    this.repoDocumentDiscoverer =
      options.repoDocumentDiscoverer ?? new DefaultRepoDocumentDiscoverer();
    this.githubArtifactDiscoverer =
      options.githubArtifactDiscoverer ?? new DefaultGitHubArtifactDiscoverer();
    this.knowledgeBaseClient =
      options.knowledgeBaseClient ?? new OpenAIKnowledgeBaseClient();
  }

  async prepare(brief: DecisionBrief): Promise<PreparedDecisionEvidence> {
    const normalizedBrief = DecisionBriefSchema.parse(brief);
    const [repoDocs, githubArtifacts] = await Promise.all([
      this.repoDocumentDiscoverer.discover(normalizedBrief),
      this.githubArtifactDiscoverer.discover(normalizedBrief),
    ]);

    const selectedSources = [...repoDocs.selectedSources, ...githubArtifacts.selectedSources];
    const skippedSources = [...repoDocs.skippedSources, ...githubArtifacts.skippedSources];
    const warnings = [...repoDocs.warnings, ...githubArtifacts.warnings];

    const attachmentsResult = await this.knowledgeBaseClient.attachSources(
      normalizedBrief.id,
      selectedSources
    );

    warnings.push(...attachmentsResult.warnings);

    const preparedSources = selectedSources.map((source) => ({
      id: source.id,
      kind: source.kind,
      title: source.title,
      locator: source.locator,
      score: Number(source.score.toFixed(2)),
      retrievedAt: source.retrievedAt,
      attachmentFileId: attachmentsResult.attachmentFileIdsBySourceId.get(source.id) ?? null,
    })) satisfies EvidencePreparedSource[];

    const attachments = dedupeAttachments([
      ...normalizedBrief.attachments,
      ...attachmentsResult.attachments,
    ]);

    const enrichedBrief = DecisionBriefSchema.parse({
      ...normalizedBrief,
      attachments,
    });

    const manifest = EvidencePreparationManifestSchema.parse({
      decisionId: normalizedBrief.id,
      repoDocumentsDiscovered: repoDocs.discoveredCount,
      githubArtifactsDiscovered: githubArtifacts.discoveredCount,
      selectedSources: preparedSources,
      skippedSources,
      warnings: dedupeWarnings(warnings),
      attachments,
      vectorStoreId: attachmentsResult.vectorStoreId,
    });

    return {
      brief: enrichedBrief,
      manifest,
    };
  }
}

export class DefaultRepoDocumentDiscoverer implements RepoDocumentDiscoverer {
  async discover(brief: DecisionBrief): Promise<SourceDiscoveryResult> {
    const localPath = brief.repo.localPath?.trim();
    if (!localPath) {
      return {
        discoveredCount: 0,
        selectedSources: [],
        skippedSources: [],
        warnings: [
          warning(
            'repo_local_path_missing',
            'BenchMemo could not auto-discover repo-native docs because repo.localPath is missing.'
          ),
        ],
      };
    }

    const repoRoot = resolve(localPath);
    let candidatePaths: string[];
    try {
      candidatePaths = await collectRepoDocumentPaths(repoRoot);
    } catch (error) {
      return {
        discoveredCount: 0,
        selectedSources: [],
        skippedSources: [],
        warnings: [
          warning(
            'repo_doc_discovery_failed',
            `BenchMemo could not read repo-native docs from ${repoRoot}: ${toErrorMessage(error)}`
          ),
        ],
      };
    }
    const selectedSources: PreparedTextSource[] = [];
    const skippedSources: EvidencePreparedSkippedSource[] = [];

    for (const candidatePath of candidatePaths) {
      const repoRelativePath = toRepoRelativePath(repoRoot, candidatePath);
      const retrievedAt = new Date().toISOString();

      if (selectedSources.length >= MAX_REPO_DOC_SELECTION) {
        skippedSources.push({
          id: `repo_doc:${repoRelativePath}`,
          kind: 'repo_doc',
          title: basename(candidatePath),
          locator: repoRelativePath,
          score: repoDocPriority(repoRelativePath),
          retrievedAt,
          attachmentFileId: null,
          reason: `Skipped because BenchMemo only ingests the top ${MAX_REPO_DOC_SELECTION} repo-native docs per decision.`,
        });
        continue;
      }

      const fileStats = await stat(candidatePath);
      if (fileStats.size > MAX_REPO_DOC_BYTES) {
        skippedSources.push({
          id: `repo_doc:${repoRelativePath}`,
          kind: 'repo_doc',
          title: basename(candidatePath),
          locator: repoRelativePath,
          score: repoDocPriority(repoRelativePath),
          retrievedAt,
          attachmentFileId: null,
          reason: `Skipped because the file is larger than ${MAX_REPO_DOC_BYTES} bytes.`,
        });
        continue;
      }

      const content = await readFile(candidatePath, 'utf8');
      if (content.includes('\u0000')) {
        skippedSources.push({
          id: `repo_doc:${repoRelativePath}`,
          kind: 'repo_doc',
          title: basename(candidatePath),
          locator: repoRelativePath,
          score: repoDocPriority(repoRelativePath),
          retrievedAt,
          attachmentFileId: null,
          reason: 'Skipped because the file appears to contain binary content.',
        });
        continue;
      }

      selectedSources.push({
        id: `repo_doc:${repoRelativePath}`,
        kind: 'repo_doc',
        title: extractMarkdownTitle(content, basename(candidatePath)),
        locator: repoRelativePath,
        score: repoDocPriority(repoRelativePath),
        retrievedAt,
        text: renderSourceText({
          id: `repo_doc:${repoRelativePath}`,
          kind: 'repo_doc',
          title: extractMarkdownTitle(content, basename(candidatePath)),
          locator: repoRelativePath,
          retrievedAt,
          body: content,
        }),
      });
    }

    return {
      discoveredCount: candidatePaths.length,
      selectedSources,
      skippedSources,
      warnings: [],
    };
  }
}

export interface GitHubFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

export type GitHubFetch = (
  input: string,
  init?: {
    headers?: Record<string, string>;
  }
) => Promise<GitHubFetchResponse>;

export interface DefaultGitHubArtifactDiscovererOptions {
  token?: string | null;
  fetchImpl?: GitHubFetch;
  now?: () => Date;
}

type GitHubArtifactKind = Exclude<EvidenceSourceKind, 'repo_doc'>;

type RankedGitHubArtifact = {
  id: string;
  kind: GitHubArtifactKind;
  title: string;
  locator: string;
  score: number;
  overlapCount: number;
  retrievedAt: string;
  body: string;
};

export class DefaultGitHubArtifactDiscoverer implements GitHubArtifactDiscoverer {
  private readonly token: string | null;
  private readonly fetchImpl: GitHubFetch;
  private readonly now: () => Date;

  constructor(options: DefaultGitHubArtifactDiscovererOptions = {}) {
    this.token =
      options.token !== undefined ? options.token : process.env.GITHUB_TOKEN?.trim() ?? null;
    this.fetchImpl = options.fetchImpl ?? defaultGitHubFetch;
    this.now = options.now ?? (() => new Date());
  }

  async discover(brief: DecisionBrief): Promise<SourceDiscoveryResult> {
    if (!this.token) {
      return {
        discoveredCount: 0,
        selectedSources: [],
        skippedSources: [],
        warnings: [
          warning(
            'github_token_missing',
            'GITHUB_TOKEN is not set, so BenchMemo skipped GitHub issue, pull request, and release discovery.'
          ),
        ],
      };
    }

    const repoName = brief.repo.repoName.trim();
    if (!repoName.includes('/')) {
      return {
        discoveredCount: 0,
        selectedSources: [],
        skippedSources: [],
        warnings: [
          warning(
            'github_repo_invalid',
            `BenchMemo could not discover GitHub artifacts because repo slug "${repoName}" is invalid.`
          ),
        ],
      };
    }

    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'User-Agent': 'BenchMemo',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    const [issuesResult, pullsResult, releasesResult] = await Promise.all([
      this.fetchCollection(
        `https://api.github.com/repos/${repoName}/issues?state=open&sort=updated&direction=desc&per_page=${MAX_GITHUB_ISSUES}`,
        headers,
        'github_issue_fetch_failed'
      ),
      this.fetchCollection(
        `https://api.github.com/repos/${repoName}/pulls?state=closed&sort=updated&direction=desc&per_page=${MAX_GITHUB_PULLS}`,
        headers,
        'github_pull_fetch_failed'
      ),
      this.fetchCollection(
        `https://api.github.com/repos/${repoName}/releases?per_page=${MAX_GITHUB_RELEASES}`,
        headers,
        'github_release_fetch_failed'
      ),
    ]);

    const warnings = [
      ...issuesResult.warnings,
      ...pullsResult.warnings,
      ...releasesResult.warnings,
    ];

    const artifacts = [
      ...rankIssues(brief, issuesResult.items, this.now),
      ...rankPulls(brief, pullsResult.items, this.now),
      ...rankReleases(brief, releasesResult.items, this.now),
    ];

    const selectedArtifacts = selectGitHubArtifacts(artifacts);
    const selectedIds = new Set(selectedArtifacts.map((artifact) => artifact.id));

    const selectedSources = selectedArtifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      locator: artifact.locator,
      score: artifact.score,
      retrievedAt: artifact.retrievedAt,
      text: renderSourceText({
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
        locator: artifact.locator,
        retrievedAt: artifact.retrievedAt,
        body: artifact.body,
      }),
    })) satisfies PreparedTextSource[];

    const skippedSources = artifacts
      .filter((artifact) => !selectedIds.has(artifact.id))
      .map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
        locator: artifact.locator,
        score: Number(artifact.score.toFixed(2)),
        retrievedAt: artifact.retrievedAt,
        attachmentFileId: null,
        reason:
          artifact.overlapCount <= 0
            ? 'Skipped because the artifact did not overlap meaningfully with the current decision framing.'
            : 'Skipped because higher-ranked GitHub artifacts already filled the v1 selection limit.',
      })) satisfies EvidencePreparedSkippedSource[];

    return {
      discoveredCount: artifacts.length,
      selectedSources,
      skippedSources,
      warnings: dedupeWarnings(warnings),
    };
  }

  private async fetchCollection(
    url: string,
    headers: Record<string, string>,
    warningCode: string
  ) {
    try {
      const response = await this.fetchImpl(url, { headers });
      if (!response.ok) {
        return {
          items: [] as unknown[],
          warnings: [
            warning(
              warningCode,
              `GitHub returned ${response.status} ${response.statusText} while fetching ${url}.`
            ),
          ],
        };
      }

      const json = await response.json();
      if (!Array.isArray(json)) {
        return {
          items: [] as unknown[],
          warnings: [
            warning(
              warningCode,
              `GitHub returned an unexpected response shape while fetching ${url}.`
            ),
          ],
        };
      }

      return {
        items: json,
        warnings: [] as EvidencePreparationWarning[],
      };
    } catch (error) {
      return {
        items: [] as unknown[],
        warnings: [
          warning(
            warningCode,
            `GitHub discovery failed for ${url}: ${toErrorMessage(error)}`
          ),
        ],
      };
    }
  }
}

export interface OpenAIKnowledgeBaseClientOptions {
  apiKey?: string | null;
  client?: Pick<OpenAI, 'files' | 'vectorStores'>;
}

export class OpenAIKnowledgeBaseClient implements KnowledgeBaseClient {
  private readonly apiKey: string | null;
  private readonly client: Pick<OpenAI, 'files' | 'vectorStores'> | null;

  constructor(options: OpenAIKnowledgeBaseClientOptions = {}) {
    this.apiKey =
      options.apiKey !== undefined ? options.apiKey : process.env.OPENAI_API_KEY?.trim() ?? null;
    this.client =
      options.client ??
      (this.apiKey
        ? new OpenAI({
            apiKey: this.apiKey,
          })
        : null);
  }

  async attachSources(
    decisionId: string,
    sources: PreparedTextSource[]
  ): Promise<KnowledgeBaseAttachmentResult> {
    if (sources.length === 0) {
      return emptyAttachmentResult();
    }

    if (!this.apiKey || !this.client) {
      return {
        ...emptyAttachmentResult(),
        warnings: [
          warning(
            'openai_api_key_missing',
            'OPENAI_API_KEY is not set, so BenchMemo could not build a docs knowledge base for auto-discovered evidence.'
          ),
        ],
      };
    }

    const scratchDir = await mkdtemp(join(tmpdir(), 'benchmemo-evidence-'));
    try {
      const sourceFiles = await Promise.all(
        sources.map(async (source) => ({
          source,
          path: await writePreparedSourceFile(scratchDir, source),
        }))
      );

      const uploadedFiles: Array<{ sourceId: string; fileId: string }> = [];
      const warnings: EvidencePreparationWarning[] = [];

      for (const sourceFile of sourceFiles) {
        try {
          const uploaded = await this.client.files.create({
            file: createReadStream(sourceFile.path),
            purpose: 'assistants',
          });

          uploadedFiles.push({
            sourceId: sourceFile.source.id,
            fileId: uploaded.id,
          });
        } catch (error) {
          warnings.push(
            warning(
              'openai_file_upload_failed',
              `BenchMemo could not upload ${sourceFile.source.locator} for file search: ${toErrorMessage(error)}`
            )
          );
        }
      }

      if (uploadedFiles.length === 0) {
        return {
          ...emptyAttachmentResult(),
          warnings,
        };
      }

      try {
        const vectorStore = await this.client.vectorStores.create({
          name: `BenchMemo ${decisionId} evidence`,
        });

        const batch = await this.client.vectorStores.fileBatches.createAndPoll(
          vectorStore.id,
          {
            file_ids: uploadedFiles.map((item) => item.fileId),
          }
        );

        if (batch.file_counts.completed === 0) {
          warnings.push(
            warning(
              'openai_vector_store_empty',
              `BenchMemo created vector store ${vectorStore.id}, but no files finished processing for this decision.`
            )
          );

          return {
            ...emptyAttachmentResult(),
            vectorStoreId: vectorStore.id,
            warnings,
          };
        }

        if (batch.file_counts.failed > 0) {
          warnings.push(
            warning(
              'openai_vector_store_partial_failure',
              `BenchMemo indexed ${batch.file_counts.completed} files in vector store ${vectorStore.id}, but ${batch.file_counts.failed} files failed during processing.`
            )
          );
        }

        return {
          attachments: uploadedFiles.map((item) => ({
            fileId: item.fileId,
            vectorStoreId: vectorStore.id,
          })),
          vectorStoreId: vectorStore.id,
          attachmentFileIdsBySourceId: new Map(
            uploadedFiles.map((item) => [item.sourceId, item.fileId] as const)
          ),
          warnings,
        };
      } catch (error) {
        warnings.push(
          warning(
            'openai_vector_store_failed',
            `BenchMemo could not build a vector store for auto-discovered evidence: ${toErrorMessage(error)}`
          )
        );

        return {
          ...emptyAttachmentResult(),
          warnings,
        };
      }
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }
}

async function collectRepoDocumentPaths(repoRoot: string) {
  const topLevelEntries = await readdir(repoRoot, { withFileTypes: true });
  const candidatePaths = new Set<string>();

  for (const entry of topLevelEntries) {
    if (!entry.isFile()) {
      continue;
    }

    if (
      entry.name === 'AGENTS.md' ||
      /^README(\..+)?$/i.test(entry.name) ||
      /\.md$/i.test(entry.name)
    ) {
      candidatePaths.add(join(repoRoot, entry.name));
    }
  }

  for (const directoryName of ['docs', 'plans', 'adr']) {
    const directoryPath = join(repoRoot, directoryName);
    if (!(await exists(directoryPath))) {
      continue;
    }

    const nestedMarkdownFiles = await collectMarkdownFiles(directoryPath);
    for (const nestedFile of nestedMarkdownFiles) {
      candidatePaths.add(nestedFile);
    }
  }

  return Array.from(candidatePaths).sort((left, right) =>
    compareRepoDocPaths(
      toRepoRelativePath(repoRoot, left),
      toRepoRelativePath(repoRoot, right)
    )
  );
}

async function collectMarkdownFiles(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const nestedPaths: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      nestedPaths.push(...(await collectMarkdownFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && /\.md$/i.test(entry.name)) {
      nestedPaths.push(fullPath);
    }
  }

  return nestedPaths;
}

function compareRepoDocPaths(left: string, right: string) {
  const leftKey = `${String(1000 - repoDocPriority(left)).padStart(4, '0')}:${left}`;
  const rightKey = `${String(1000 - repoDocPriority(right)).padStart(4, '0')}:${right}`;
  return leftKey.localeCompare(rightKey);
}

function repoDocPriority(pathLike: string) {
  const normalized = pathLike.split(sep).join('/').toLowerCase();

  if (normalized.endsWith('/agents.md') || normalized === 'agents.md') {
    return 100;
  }

  if (normalized.endsWith('/readme.md') || normalized === 'readme.md') {
    return 95;
  }

  if (!normalized.includes('/') && normalized.endsWith('.md')) {
    return 80;
  }

  if (normalized.startsWith('docs/')) {
    return 70;
  }

  if (normalized.startsWith('plans/')) {
    return 60;
  }

  if (normalized.startsWith('adr/')) {
    return 50;
  }

  return 40;
}

function extractMarkdownTitle(content: string, fallback: string) {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('# '));

  if (heading) {
    return heading.replace(/^#\s+/, '').trim();
  }

  return fallback;
}

async function writePreparedSourceFile(rootDir: string, source: PreparedTextSource) {
  const extension = source.kind === 'repo_doc' ? safeExtensionFromLocator(source.locator) : '.md';
  const filePath = join(rootDir, `${sanitizeFileStem(source.id)}${extension}`);
  await writeFile(filePath, source.text, 'utf8');
  return filePath;
}

function safeExtensionFromLocator(locator: string) {
  const extension = extname(locator).toLowerCase();
  return extension === '.md' ? extension : '.md';
}

function renderSourceText(input: {
  id: string;
  kind: EvidenceSourceKind;
  title: string;
  locator: string;
  retrievedAt: string;
  body: string;
}) {
  return [
    `# ${input.title}`,
    '',
    `Source ID: ${input.id}`,
    `Source kind: ${input.kind}`,
    `Locator: ${input.locator}`,
    `Retrieved at: ${input.retrievedAt}`,
    '',
    input.body.trim(),
    '',
  ].join('\n');
}

function rankIssues(brief: DecisionBrief, items: unknown[], now: () => Date) {
  return items
    .filter((item): item is GitHubIssueResponse => isObject(item) && !('pull_request' in item))
    .map((item) =>
      rankGitHubArtifact(brief, {
        id: `github_issue:${item.number}`,
        kind: 'github_issue',
        title: `Issue #${item.number}: ${item.title}`,
        locator: item.html_url,
        body: renderGitHubIssueBody(item),
        updatedAt: item.updated_at ?? item.created_at ?? now().toISOString(),
      }, now)
    );
}

function rankPulls(brief: DecisionBrief, items: unknown[], now: () => Date) {
  return items
    .filter((item): item is GitHubPullResponse => isObject(item) && typeof item.merged_at === 'string')
    .map((item) =>
      rankGitHubArtifact(brief, {
        id: `github_pull_request:${item.number}`,
        kind: 'github_pull_request',
        title: `Pull request #${item.number}: ${item.title}`,
        locator: item.html_url,
        body: renderGitHubPullBody(item),
        updatedAt: item.merged_at ?? item.updated_at ?? item.created_at ?? now().toISOString(),
      }, now)
    );
}

function rankReleases(brief: DecisionBrief, items: unknown[], now: () => Date) {
  return items
    .filter((item): item is GitHubReleaseResponse => isObject(item))
    .map((item) =>
      rankGitHubArtifact(brief, {
        id: `github_release:${item.id}`,
        kind: 'github_release',
        title: `Release ${item.tag_name}`,
        locator: item.html_url,
        body: renderGitHubReleaseBody(item),
        updatedAt: item.published_at ?? item.created_at ?? now().toISOString(),
      }, now)
    );
}

function rankGitHubArtifact(
  brief: DecisionBrief,
  input: {
    id: string;
    kind: GitHubArtifactKind;
    title: string;
    locator: string;
    body: string;
    updatedAt: string;
  },
  now: () => Date
): RankedGitHubArtifact {
  const decisionTokens = tokenizeDecision(brief);
  const artifactTokens = tokenizeText(`${input.title}\n${input.body}`);
  const overlap = countTokenOverlap(decisionTokens, artifactTokens);
  const recencyScore = computeRecencyScore(input.updatedAt, now());
  const kindBonus =
    input.kind === 'github_issue' ? 3 : input.kind === 'github_pull_request' ? 2 : 1;
  const score = overlap * 10 + recencyScore + kindBonus;

  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    locator: input.locator,
    score: Number(score.toFixed(2)),
    overlapCount: overlap,
    retrievedAt: now().toISOString(),
    body: input.body,
  };
}

function selectGitHubArtifacts(artifacts: RankedGitHubArtifact[]) {
  const counts: Record<EvidenceSourceKind, number> = {
    repo_doc: 0,
    github_issue: 0,
    github_pull_request: 0,
    github_release: 0,
  };

  const sorted = [...artifacts].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return left.id.localeCompare(right.id);
  });

  const selected: RankedGitHubArtifact[] = [];
  for (const artifact of sorted) {
    if (artifact.overlapCount <= 0) {
      continue;
    }

    if (selected.length >= MAX_GITHUB_SELECTION) {
      break;
    }

    if (counts[artifact.kind] >= MAX_GITHUB_PER_KIND[artifact.kind]) {
      continue;
    }

    selected.push(artifact);
    counts[artifact.kind] += 1;
  }

  return selected;
}

function tokenizeDecision(brief: DecisionBrief) {
  return tokenizeText(
    [
      brief.title,
      brief.question,
      ...brief.options.flatMap((option) => [option.name, option.description]),
      ...brief.constraints,
    ].join(' ')
  );
}

function tokenizeText(value: string) {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
  );
}

function countTokenOverlap(left: Set<string>, right: Set<string>) {
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function computeRecencyScore(isoTimestamp: string, now: Date) {
  const timestamp = Date.parse(isoTimestamp);
  if (Number.isNaN(timestamp)) {
    return 0;
  }

  const ageDays = Math.max(0, (now.getTime() - timestamp) / (24 * 60 * 60 * 1000));
  return Math.max(0, 12 - ageDays / 14);
}

function renderGitHubIssueBody(item: GitHubIssueResponse) {
  const labels = item.labels
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter(Boolean);

  return [
    `Issue number: ${item.number}`,
    labels.length > 0 ? `Labels: ${labels.join(', ')}` : '',
    '',
    trimBody(item.body),
  ]
    .filter(Boolean)
    .join('\n');
}

function renderGitHubPullBody(item: GitHubPullResponse) {
  return [
    `Pull request number: ${item.number}`,
    item.merged_at ? `Merged at: ${item.merged_at}` : '',
    '',
    trimBody(item.body),
  ]
    .filter(Boolean)
    .join('\n');
}

function renderGitHubReleaseBody(item: GitHubReleaseResponse) {
  return [
    `Tag: ${item.tag_name}`,
    item.published_at ? `Published at: ${item.published_at}` : '',
    '',
    trimBody(item.body),
  ]
    .filter(Boolean)
    .join('\n');
}

function trimBody(value: string | null | undefined) {
  const body = normalizeWhitespace(value ?? '');
  if (body.length <= MAX_GITHUB_BODY_CHARS) {
    return body;
  }

  return `${body.slice(0, MAX_GITHUB_BODY_CHARS)}...`;
}

function warning(code: string, message: string): EvidencePreparationWarning {
  return {
    code,
    message,
  };
}

function dedupeWarnings(warnings: EvidencePreparationWarning[]) {
  const byKey = new Map<string, EvidencePreparationWarning>();
  for (const item of warnings) {
    byKey.set(`${item.code}:${item.message}`, item);
  }

  return Array.from(byKey.values());
}

function dedupeAttachments(attachments: DecisionAttachment[]) {
  const byKey = new Map<string, DecisionAttachment>();
  for (const attachment of attachments) {
    byKey.set(`${attachment.vectorStoreId}:${attachment.fileId}`, attachment);
  }

  return Array.from(byKey.values());
}

function emptyAttachmentResult(): KnowledgeBaseAttachmentResult {
  return {
    attachments: [],
    vectorStoreId: null,
    attachmentFileIdsBySourceId: new Map(),
    warnings: [],
  };
}

async function exists(pathLike: string) {
  try {
    await access(pathLike);
    return true;
  } catch {
    return false;
  }
}

function sanitizeFileStem(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function toRepoRelativePath(repoRoot: string, absolutePath: string) {
  return relative(repoRoot, absolutePath).split(sep).join('/');
}

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Unknown error';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'benchmemo',
  'because',
  'before',
  'below',
  'between',
  'could',
  'from',
  'have',
  'into',
  'just',
  'logic',
  'look',
  'next',
  'over',
  'should',
  'that',
  'their',
  'them',
  'there',
  'these',
  'they',
  'this',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
]);

type GitHubLabel =
  | string
  | {
      name: string;
    };

type GitHubIssueResponse = {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  updated_at?: string;
  created_at?: string;
  labels: GitHubLabel[];
};

type GitHubPullResponse = {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  updated_at?: string;
  created_at?: string;
  merged_at?: string | null;
};

type GitHubReleaseResponse = {
  id: number;
  tag_name: string;
  body?: string | null;
  html_url: string;
  published_at?: string | null;
  created_at?: string;
};

async function defaultGitHubFetch(
  input: string,
  init?: {
    headers?: Record<string, string>;
  }
): Promise<GitHubFetchResponse> {
  return fetch(input, {
    headers: init?.headers,
  });
}
