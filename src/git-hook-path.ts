import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GitHookName = 'pre-commit' | 'pre-push';

export async function resolveGitHookPath(root: string, hookName: GitHookName): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    '-C', root, 'rev-parse', '--git-path', `hooks/${hookName}`,
  ]);
  const value = stdout.trim();
  if (!value) throw new Error(`Git returned an empty hook path for ${hookName}`);
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}
