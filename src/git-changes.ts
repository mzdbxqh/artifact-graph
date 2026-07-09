import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// @scenario S-03 @feature ACA2
const execFileAsync = promisify(execFile);

export type GitChangeMode = 'staged' | 'worktree' | 'base';

export interface CollectChangedPathsOptions {
  mode: GitChangeMode;
  base?: string;
}

export interface GitChangeResult {
  root: string;
  mode: GitChangeMode;
  base?: string;
  changedPaths: string[];
  unstagedPaths: string[];
  stagedUnstagedConflictPaths: string[];
}

export async function collectChangedPaths(root: string, options: CollectChangedPathsOptions): Promise<GitChangeResult> {
  const args = gitDiffArgs(options);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', args, { cwd: root }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to collect git changed paths (${options.mode}): ${message}`);
  }

  const changedPaths = normalizeGitPathList(stdout);
  const unstagedPaths = options.mode === 'staged' ? await collectUnstagedPaths(root) : [];
  const stagedUnstagedConflictPaths = options.mode === 'staged'
    ? intersect(changedPaths, unstagedPaths)
    : [];

  return {
    root,
    mode: options.mode,
    base: options.base,
    changedPaths,
    unstagedPaths,
    stagedUnstagedConflictPaths,
  };
}

function gitDiffArgs(options: CollectChangedPathsOptions): string[] {
  const common = ['diff', '--name-only', '--diff-filter=ACDMRT'];
  if (options.mode === 'staged') {
    return [...common, '--cached'];
  }
  if (options.mode === 'worktree') {
    return common;
  }
  if (!options.base) {
    throw new Error('--base requires a ref when collecting base changed paths');
  }
  return [...common, `${options.base}...HEAD`];
}

async function collectUnstagedPaths(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=ACDMRT'], { cwd: root });
    return normalizeGitPathList(stdout);
  } catch {
    return [];
  }
}

function normalizeGitPathList(stdout: string): string[] {
  return sortUnique(stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((line) => line.length > 0 && !line.startsWith('../') && !line.startsWith('/')));
}

function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function sortUnique(items: string[]): string[] {
  return [...new Set(items)].sort((left, right) => left.localeCompare(right));
}
