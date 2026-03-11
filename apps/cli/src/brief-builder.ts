import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_CRITERIA = [
  { id: 'risk', name: 'Risk', weight: 55 },
  { id: 'velocity', name: 'Velocity', weight: 45 },
] as const;

export interface PromptSession {
  ask(message: string): Promise<string>;
  close?(): void;
}

export interface GitMetadata {
  branch?: string;
  repoName?: string;
}

export interface GitMetadataLoader {
  load(cwd: string): Promise<GitMetadata>;
}

export interface BuildGuidedBriefOptions {
  prompt: PromptSession;
  cwd?: string;
  gitMetadataLoader?: GitMetadataLoader;
  now?: () => Date;
}

export async function buildGuidedBrief(
  options: BuildGuidedBriefOptions
): Promise<unknown> {
  const cwd = options.cwd ?? process.cwd();
  const gitMetadataLoader = options.gitMetadataLoader ?? defaultGitMetadataLoader;
  const now = options.now ?? (() => new Date());
  const prompt = options.prompt;
  const gitMetadata = await gitMetadataLoader.load(cwd);

  const title = await askRequired(prompt, 'Decision title');
  const question = await askRequired(prompt, 'Decision question');
  const repoName = await askRequired(prompt, 'GitHub repo slug', gitMetadata.repoName);
  const paths = splitCommaSeparatedInput(
    await askOptional(prompt, 'Scoped paths (comma-separated, optional)')
  );
  const optionInputs = await collectOptions(prompt);
  const constraints = splitCommaSeparatedInput(
    await askOptional(prompt, 'Constraints (comma-separated, optional)')
  );

  return {
    id: `dec_${now().getTime()}`,
    title,
    question,
    repo: {
      provider: 'github',
      repoName,
      branch: gitMetadata.branch,
      localPath: cwd,
      paths,
    },
    options: optionInputs,
    constraints,
    criteria: DEFAULT_CRITERIA.map((criterion) => ({ ...criterion })),
    reversibility: 'costly_reversible',
    horizon: 'weeks',
    attachments: [],
  };
}

export function splitCommaSeparatedInput(input: string) {
  return input
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseGitHubRepoName(remoteUrl: string | undefined) {
  if (!remoteUrl) {
    return undefined;
  }

  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return undefined;
  }

  const sshMatch = trimmed.match(/^git@github\.com:(.+?)(?:\.git)?$/i);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/i);
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }

  const sshUrlMatch = trimmed.match(/^ssh:\/\/git@github\.com\/(.+?)(?:\.git)?$/i);
  if (sshUrlMatch?.[1]) {
    return sshUrlMatch[1];
  }

  return undefined;
}

export const defaultGitMetadataLoader: GitMetadataLoader = {
  async load(cwd: string) {
    const [branch, remoteUrl] = await Promise.all([
      runGit(['branch', '--show-current'], cwd),
      runGit(['config', '--get', 'remote.origin.url'], cwd),
    ]);

    return {
      branch,
      repoName: parseGitHubRepoName(remoteUrl),
    };
  },
};

async function collectOptions(prompt: PromptSession) {
  const options: Array<{ id: string; name: string; description: string }> = [];
  const seenIds = new Set<string>();

  for (let index = 1; index <= 2; index += 1) {
    const name = await askRequired(prompt, `Option ${index} name`);
    const description = await askRequired(prompt, `Option ${index} description`);
    options.push({
      id: createOptionId(name, seenIds, options.length + 1),
      name,
      description,
    });
  }

  while (true) {
    const name = await askOptional(
      prompt,
      'Additional option name (leave blank to finish)'
    );
    if (!name) {
      break;
    }

    const description = await askRequired(
      prompt,
      `Description for ${name}`
    );
    options.push({
      id: createOptionId(name, seenIds, options.length + 1),
      name,
      description,
    });
  }

  return options;
}

async function askRequired(
  prompt: PromptSession,
  label: string,
  defaultValue?: string
) {
  while (true) {
    const answer = await prompt.ask(buildPromptLabel(label, defaultValue));
    const normalized = normalizeAnswer(answer);
    if (normalized) {
      return normalized;
    }

    if (defaultValue) {
      return defaultValue;
    }
  }
}

async function askOptional(
  prompt: PromptSession,
  label: string,
  defaultValue?: string
) {
  const answer = await prompt.ask(buildPromptLabel(label, defaultValue));
  const normalized = normalizeAnswer(answer);
  return normalized || defaultValue || '';
}

function buildPromptLabel(label: string, defaultValue?: string) {
  if (defaultValue) {
    return `${label} [${defaultValue}]: `;
  }

  return `${label}: `;
}

function normalizeAnswer(value: string) {
  return value.trim();
}

function createOptionId(name: string, seenIds: Set<string>, fallbackIndex: number) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = slug ? `opt_${slug}` : `opt_${fallbackIndex}`;
  let candidate = base;
  let suffix = 2;

  while (seenIds.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }

  seenIds.add(candidate);
  return candidate;
}

async function runGit(args: string[], cwd: string) {
  try {
    const result = await execFileAsync('git', args, { cwd });
    const stdout = result.stdout.trim();
    return stdout || undefined;
  } catch {
    return undefined;
  }
}
