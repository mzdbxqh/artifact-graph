import { execFile } from 'node:child_process';
import { access, chmod, cp, lstat, mkdir, readFile, readlink, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { doctorArtifactChain, resolveArtifactGraphCli } from '../src/cli-resolver.js';
import { resolveGitHookPath } from '../src/git-hook-path.js';
import { detectHookInterpreter, installManagedHookBlock } from '../src/hook-installer.js';

// @scenario S-04 @feature ACA4
// @scenario S-05 @feature ACA5
// @scenario S-06 @feature ACA3
const execFileAsync = promisify(execFile);
const cliPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(cliPackageRoot, '../..');
const pluginRoot = join(repoRoot, 'plugins/artifact-chain-assistant');

async function write(root: string, path: string, content: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

async function tempRoot(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-chain-toolkit-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', ['-C', root, ...args]);
}

async function initGitRoot(name: string): Promise<string> {
  const root = await tempRoot(name);
  await git(root, ['init', '--quiet']);
  await write(root, 'seed.txt', 'seed\n');
  await git(root, ['add', 'seed.txt']);
  await git(root, ['-c', 'user.name=Hook Test', '-c', 'user.email=hook@example.invalid', 'commit', '--quiet', '-m', 'seed']);
  return root;
}

async function tempPluginFixture(name: string): Promise<string> {
  const root = await tempRoot(name);
  const fixtureRoot = join(root, 'artifact-chain-assistant');
  await cp(pluginRoot, fixtureRoot, { recursive: true });
  return fixtureRoot;
}

async function runNodeScript(script: string, args: string[] = [], cwd = pluginRoot): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('node', [script, ...args], { cwd });
}

async function capture(argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    cwd,
    stdout: (chunk) => { stdout += chunk; },
    stderr: (chunk) => { stderr += chunk; },
  });
  return { code, stdout, stderr };
}

async function commandResult(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

function fencedBlock(markdown: string, heading: string, language: string): string {
  const marker = `${heading}:\n\n\`\`\`${language}\n`;
  const start = markdown.indexOf(marker);
  expect(start, `${heading} fenced example`).toBeGreaterThanOrEqual(0);
  const contentStart = start + marker.length;
  const end = markdown.indexOf('\n\`\`\`', contentStart);
  expect(end, `${heading} fenced example terminator`).toBeGreaterThanOrEqual(0);
  return markdown.slice(contentStart, end);
}

async function writeDocumentedHookScript(
  root: string,
  language: 'python' | 'javascript',
  hookName: 'pre-commit' | 'pre-push',
): Promise<string> {
  const installGuide = await readFile(join(repoRoot, 'docs/public/artifact-chain-assistant/INSTALL.md'), 'utf8');
  const isPython = language === 'python';
  const example = fencedBlock(installGuide, isPython ? 'Python example' : 'Node.js example', language);
  const script = join(root, `documented ${language} hooks`, hookName);
  await mkdir(dirname(script), { recursive: true });
  await writeFile(script, `${example}\n`);
  await chmod(script, 0o755);
  return script;
}

async function writeFakeArtifactGraph(root: string): Promise<{ binary: string; log: string }> {
  const binary = join(root, 'bin with spaces', 'artifact graph fake.mjs');
  const log = join(root, 'artifact graph argv.log');
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
appendFileSync(process.env.HOOK_TEST_LOG, JSON.stringify(args) + '\\n');
const lock = join(process.cwd(), 'artifacts/traceability-version-lock.json');
if (args.join(' ') === 'version-lock refresh --changed-only --staged --format markdown') {
  if (!existsSync(lock) || readFileSync(lock, 'utf8') !== 'refreshed\\n') {
    writeFileSync(lock, 'refreshed\\n');
  }
  process.exit(0);
}
if (args.join(' ') === 'validate --warning-only') {
  process.exit(process.env.HOOK_TEST_FAIL === 'validate' ? 17 : 0);
}
if (args.join(' ') === 'version-lock audit --strict-missing-lock') {
  process.exit(process.env.HOOK_TEST_FAIL === 'audit' ? 19 : 0);
}
process.exit(23);
`);
  await chmod(binary, 0o755);
  return { binary, log };
}

async function assertDocumentedManualHook(language: 'python' | 'javascript'): Promise<void> {
  const root = await initGitRoot(`documented ${language} hook with spaces`);
  if (language === 'javascript') {
    await write(root, 'package.json', '{"type":"module"}\n');
  }
  const lock = 'artifacts/traceability-version-lock.json';
  await write(root, lock, 'initial\n');
  await git(root, ['add', lock]);
  await git(root, ['-c', 'user.name=Hook Test', '-c', 'user.email=hook@example.invalid', 'commit', '--quiet', '-m', 'lock']);
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout;
  const { binary, log } = await writeFakeArtifactGraph(root);
  const scripts = {
    'pre-commit': await writeDocumentedHookScript(root, language, 'pre-commit'),
    'pre-push': await writeDocumentedHookScript(root, language, 'pre-push'),
  };
  const run = (operation: 'pre-commit' | 'pre-push', failure?: 'validate' | 'audit') => commandResult(
    scripts[operation],
    [],
    root,
    {
      ...process.env,
      ARTIFACT_GRAPH_BIN: binary,
      HOOK_TEST_LOG: log,
      ...(failure ? { HOOK_TEST_FAIL: failure } : {}),
    },
  );
  const loggedCommands = async () => (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);

  expect((await run('pre-commit')).code).toBe(1);
  expect(await git(root, ['status', '--porcelain', '--', lock])).toMatchObject({
    stdout: ` M ${lock}\n`,
  });
  expect((await commandResult('git', ['-C', root, 'diff', '--cached', '--quiet', '--', lock], root)).code).toBe(0);
  expect((await git(root, ['rev-parse', 'HEAD'])).stdout).toBe(head);

  await git(root, ['add', lock]);
  expect((await commandResult('git', ['-C', root, 'diff', '--cached', '--quiet', '--', lock], root)).code).toBe(1);
  expect((await run('pre-commit')).code).toBe(0);
  expect((await git(root, ['rev-parse', 'HEAD'])).stdout).toBe(head);

  await writeFile(log, '');
  expect((await run('pre-push')).code).toBe(0);
  expect(await loggedCommands()).toEqual([
    ['validate', '--warning-only'],
    ['version-lock', 'audit', '--strict-missing-lock'],
  ]);

  await writeFile(log, '');
  expect((await run('pre-push', 'validate')).code).toBe(17);
  expect(await loggedCommands()).toEqual([['validate', '--warning-only']]);

  await writeFile(log, '');
  expect((await run('pre-push', 'audit')).code).toBe(19);
  expect(await loggedCommands()).toEqual([
    ['validate', '--warning-only'],
    ['version-lock', 'audit', '--strict-missing-lock'],
  ]);

  const missingCli = await commandResult(scripts['pre-push'], [], root, {
    ...process.env,
    ARTIFACT_GRAPH_BIN: join(root, 'missing artifact-graph'),
    HOOK_TEST_LOG: log,
  });
  expect(missingCli.code).not.toBe(0);
}

describe('artifact chain toolkit support', () => {
  it('resolves node_modules artifact-graph before PATH, explicit legacy, and fallback paths', async () => {
    const root = await tempRoot('resolver');
    await write(root, 'artifact-graph/dist/cli.js', 'console.log("project local");\n');
    await write(root, 'node_modules/.bin/artifact-graph', '#!/bin/sh\necho node_modules\n');
    await write(root, 'fallback/artifact-graph.js', 'console.log("fallback");\n');

    const resolution = await resolveArtifactGraphCli(root, {
      projectCliPath: join(root, 'artifact-graph/dist/cli.js'),
      fallbackPath: join(root, 'fallback/artifact-graph.js'),
    });

    expect(resolution.source).toBe('node_modules');
    expect(resolution.path).toBe(join(root, 'node_modules/.bin/artifact-graph'));
    expect(resolution.candidates.map((candidate) => candidate.source)).toEqual([
      'node_modules',
      'path',
      'legacy',
      'plugin-bundled',
    ]);
  });

  it('reports doctor metadata with selected CLI, node compatibility, config, lock, and supported commands', async () => {
    const root = await tempRoot('doctor');
    const nodeModulesCli = 'node_modules/.bin/artifact-graph';
    await write(root, nodeModulesCli, '#!/bin/sh\necho "artifact-graph <command>\\n\\nCommands:\\n  scan\\n  version-lock audit\\n  doctor"\n');
    await chmod(join(root, nodeModulesCli), 0o755);
    await write(root, 'artifact-graph.config.yaml', 'types: {}\n');
    await write(root, 'artifacts/traceability-version-lock.json', '{"schemaVersion":"1.0","locks":[]}\n');

    const report = await doctorArtifactChain(root);

    expect(report.cli.source).toBe('node_modules');
    expect(report.node.compatible).toBe(true);
    expect(report.config.exists).toBe(true);
    expect(report.lock.exists).toBe(true);
    expect(report.supportedCommands).toContain('version-lock audit');
  });

  it('installs, replaces, and uninstalls managed hook blocks without touching user content', async () => {
    const root = await tempRoot('hooks');
    const hookPath = join(root, '.git/hooks/pre-commit');
    await mkdir(dirname(hookPath), { recursive: true });
    await writeFile(hookPath, '#!/bin/sh\necho user-before\n');

    await installManagedHookBlock({
      hookPath,
      block: 'echo managed-v1',
    });
    const installed = await readFile(hookPath, 'utf-8');
    expect(installed).toContain('echo user-before');
    expect(installed).toContain('echo managed-v1');

    await installManagedHookBlock({
      hookPath,
      block: 'echo managed-v2',
    });
    const replaced = await readFile(hookPath, 'utf-8');
    expect(replaced).not.toContain('echo managed-v1');
    expect(replaced).toContain('echo managed-v2');

    await installManagedHookBlock({
      hookPath,
      block: 'echo managed-v2',
      uninstall: true,
    });
    const uninstalled = await readFile(hookPath, 'utf-8');
    expect(uninstalled).toContain('echo user-before');
    expect(uninstalled).not.toContain('managed-v2');
  });

  it('restores missing, empty, and shell hooks to their exact pre-install state', async () => {
    for (const fixture of [
      { name: 'missing', exists: false, bytes: Buffer.alloc(0), mode: undefined, installedMode: 0o755 },
      { name: 'empty', exists: true, bytes: Buffer.alloc(0), mode: 0o640, installedMode: 0o740 },
      { name: 'blank', exists: true, bytes: Buffer.from(' \t\r\n'), mode: 0o604, installedMode: 0o704 },
      { name: 'shell-no-exec', exists: true, bytes: Buffer.from('#!/bin/sh\r\necho user\r\n'), mode: 0o640, installedMode: 0o740 },
      { name: 'shell-group-exec', exists: true, bytes: Buffer.from('#!/bin/sh\necho user\n'), mode: 0o650, installedMode: 0o650 },
    ] as const) {
      const root = await tempRoot(`exact-restore-${fixture.name}`);
      const hookPath = join(root, 'pre-commit');
      if (fixture.exists) {
        await writeFile(hookPath, fixture.bytes);
        await chmod(hookPath, fixture.mode);
      }

      await installManagedHookBlock({ hookPath, block: 'echo managed' });

      const installed = await readFile(hookPath);
      expect(installed.toString('utf8').split(/\r?\n/, 1)[0]).toBe('#!/bin/sh');
      expect((await stat(hookPath)).mode & 0o777).toBe(fixture.installedMode);

      await installManagedHookBlock({ hookPath, block: 'ignored', uninstall: true });

      if (!fixture.exists) {
        await expect(lstat(hookPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(await readFile(hookPath)).toEqual(fixture.bytes);
        expect((await stat(hookPath)).mode & 0o777).toBe(fixture.mode);
      }
    }
  });

  it('makes an empty existing hook executable enough for Git to invoke it', async () => {
    const root = await initGitRoot('empty-hook-real-commit');
    const hookPath = await resolveGitHookPath(root, 'pre-commit');
    const log = join(root, 'hook-execution.log');
    await writeFile(hookPath, '');
    await chmod(hookPath, 0o644);
    await write(root, 'node_modules/.bin/artifact-graph', [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$HOOK_LOG"',
      'exit 0',
      '',
    ].join('\n'));
    await chmod(join(root, 'node_modules/.bin/artifact-graph'), 0o755);
    await writeFile(log, '');

    const install = await capture(['hooks', 'install-git', '--root', root, '--hook', 'pre-commit'], root);
    expect(install.code).toBe(0);
    expect((await stat(hookPath)).mode & 0o777).toBe(0o744);
    expect((await readFile(hookPath, 'utf8')).split(/\r?\n/, 1)[0]).toBe('#!/bin/sh');

    await writeFile(join(root, 'seed.txt'), 'changed\n');
    await git(root, ['add', 'seed.txt']);
    const commit = await commandResult('git', [
      '-C', root,
      '-c', 'user.name=Hook Test',
      '-c', 'user.email=hook@example.invalid',
      'commit', '--quiet', '-m', 'exercise hook',
    ], root, { ...process.env, HOOK_LOG: log });

    expect(commit.code).toBe(0);
    expect((await readFile(log, 'utf8')).trim()).toBe('version-lock refresh --changed-only --staged --format markdown');
  });

  it('refuses non-shell hooks without changing bytes, mode, or mtime', async () => {
    for (const [name, content, shebang] of [
      ['python', '#!/usr/bin/env python3\nprint("user")\n', '#!/usr/bin/env python3'],
      ['node', '#!/usr/bin/env node --no-warnings\r\nconsole.log("user")\r\n', '#!/usr/bin/env node --no-warnings'],
      ['python-sh', '#!/usr/bin/python-sh\r\nprint("user")\r\n', '#!/usr/bin/python-sh'],
      ['unknown', 'echo no-shebang\n', 'echo no-shebang'],
    ] as const) {
      const root = await tempRoot(`unsupported-${name}`);
      const hookPath = join(root, 'pre-commit');
      await writeFile(hookPath, content);
      await chmod(hookPath, 0o744);
      const before = await stat(hookPath);

      await expect(installManagedHookBlock({ hookPath, block: 'echo managed' }))
        .rejects.toMatchObject({
          code: 'UNSUPPORTED_HOOK_INTERPRETER',
          hookPath,
          shebang,
        });

      expect(await readFile(hookPath, 'utf8')).toBe(content);
      const after = await stat(hookPath);
      expect(after.mode & 0o777).toBe(before.mode & 0o777);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    }
  });

  it('installs managed blocks into empty and shell hooks with shebang arguments', async () => {
    for (const [name, content] of [
      ['sh', '#!/bin/sh\r\necho user\r\n'],
      ['bash', '#!/usr/bin/env bash -eu\r\necho user\r\n'],
      ['zsh', '#!/usr/bin/env -S zsh -f\necho user\n'],
      ['empty', ' \t\r\n'],
    ] as const) {
      const root = await tempRoot(`supported-${name}`);
      const hookPath = join(root, 'pre-commit');
      await writeFile(hookPath, content);

      const result = await installManagedHookBlock({ hookPath, block: 'echo managed' });

      expect(result.action).toBe('installed');
      expect(await readFile(hookPath, 'utf8')).toContain('echo managed');
      expect(detectHookInterpreter(content)).toBe(name === 'empty' ? 'empty' : 'shell');
    }
  });

  it('uninstalls an existing managed block from an unsupported hook', async () => {
    const root = await tempRoot('unsupported-uninstall');
    const hookPath = join(root, 'pre-commit');
    await writeFile(hookPath, [
      '#!/usr/bin/env python3',
      'print("user-before")',
      '# >>> artifact-chain-assistant managed block >>>',
      'echo managed',
      '# <<< artifact-chain-assistant managed block <<<',
      'print("user-after")',
      '',
    ].join('\n'));

    const result = await installManagedHookBlock({
      hookPath,
      block: 'echo replacement-is-ignored',
      uninstall: true,
    });

    expect(result.action).toBe('uninstalled');
    const remaining = await readFile(hookPath, 'utf8');
    expect(remaining).toContain('print("user-before")');
    expect(remaining).toContain('print("user-after")');
    expect(remaining).not.toContain('managed block');
  });

  it('uninstalls only the managed byte range from an unsupported hook and preserves its mode', async () => {
    const root = await tempRoot('unsupported-uninstall-bytes');
    const hookPath = join(root, 'pre-commit');
    const prefix = Buffer.from('#!/usr/bin/env python3\r\n\r\nprint("before")\r\n\r\n');
    const managed = Buffer.from([
      '# >>> artifact-chain-assistant managed block >>>',
      'echo managed',
      '# <<< artifact-chain-assistant managed block <<<',
      '',
    ].join('\r\n'));
    const suffix = Buffer.concat([Buffer.from('\r\n\r\nprint("after")\r\n'), Buffer.from([0xff, 0x00, 0x0a])]);
    await writeFile(hookPath, Buffer.concat([prefix, managed, suffix]));
    await chmod(hookPath, 0o744);

    const result = await installManagedHookBlock({ hookPath, block: 'ignored', uninstall: true });

    expect(result.action).toBe('uninstalled');
    expect(await readFile(hookPath)).toEqual(Buffer.concat([prefix, suffix]));
    expect((await stat(hookPath)).mode & 0o777).toBe(0o744);
  });

  it('replaces only the managed byte range and preserves an existing hook mode', async () => {
    const root = await tempRoot('replace-managed-bytes');
    const hookPath = join(root, 'pre-commit');
    const prefix = Buffer.from('#!/bin/sh\r\n\r\necho before\r\n');
    const previous = Buffer.from([
      '# >>> artifact-chain-assistant managed block >>>',
      'echo old',
      '# <<< artifact-chain-assistant managed block <<<',
      '',
    ].join('\r\n'));
    const suffix = Buffer.from('\r\n\r\necho after\r\n');
    await writeFile(hookPath, Buffer.concat([prefix, previous, suffix]));
    await chmod(hookPath, 0o744);

    const result = await installManagedHookBlock({ hookPath, block: 'echo replacement' });

    expect(result.action).toBe('replaced');
    const replaced = await readFile(hookPath);
    expect(replaced.subarray(0, prefix.length)).toEqual(prefix);
    expect(replaced.subarray(-suffix.length)).toEqual(suffix);
    expect(replaced.toString('utf8')).toContain('# artifact-chain-assistant managed state v1:');
    expect(replaced.toString('utf8')).toContain('echo replacement');
    expect((await stat(hookPath)).mode & 0o777).toBe(0o744);

    await installManagedHookBlock({ hookPath, block: 'ignored', uninstall: true });
    expect(await readFile(hookPath)).toEqual(Buffer.concat([prefix, suffix]));
    expect((await stat(hookPath)).mode & 0o777).toBe(0o744);
  });

  it('keeps fixed metadata unchanged when rejecting fish and PowerShell hooks, including managed blocks', async () => {
    for (const [name, content] of [
      ['fish', '#!/usr/bin/env fish\necho user\n'],
      ['pwsh', '#!/usr/bin/pwsh\nWrite-Output user\n'],
      ['env-s-pwsh', '#!/usr/bin/env -S pwsh -NoProfile\r\nWrite-Output user\r\n'],
      ['pwsh-managed', '#!/usr/bin/env pwsh\n# >>> artifact-chain-assistant managed block >>>\necho old\n# <<< artifact-chain-assistant managed block <<<\n'],
    ] as const) {
      const root = await tempRoot(`unsupported-shell-${name}`);
      const hookPath = join(root, 'pre-commit');
      const bytes = Buffer.from(content);
      await writeFile(hookPath, bytes);
      await chmod(hookPath, 0o744);
      await utimes(hookPath, new Date('2001-02-03T04:05:06.000Z'), new Date('2001-02-03T04:05:06.000Z'));
      const before = await stat(hookPath);

      await expect(installManagedHookBlock({ hookPath, block: 'echo replacement' }))
        .rejects.toMatchObject({ code: 'UNSUPPORTED_HOOK_INTERPRETER', hookPath });

      expect(await readFile(hookPath)).toEqual(bytes);
      const after = await stat(hookPath);
      expect(after.mode & 0o777).toBe(0o744);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    }
  });

  it('creates a new hook with mode 0755 without leaving temporary files behind', async () => {
    const root = await tempRoot('new-hook-mode');
    const hookPath = join(root, 'hooks', 'pre-commit');

    await installManagedHookBlock({ hookPath, block: 'echo managed' });

    expect((await stat(hookPath)).mode & 0o777).toBe(0o755);
    expect(await readdir(dirname(hookPath))).toEqual(['pre-commit']);
  });

  it('generates host-specific skills and detects adapter drift', async () => {
    const fixtureRoot = await tempPluginFixture('skills');
    await runNodeScript('scripts/sync-skills.mjs', [], fixtureRoot);

    const codexSkill = await readFile(join(fixtureRoot, 'adapters/codex/skills/where-am-i/SKILL.md'), 'utf-8');
    const claudeSkill = await readFile(join(fixtureRoot, 'adapters/claude/skills/where-am-i/SKILL.md'), 'utf-8');
    const codexBootstrap = await readFile(join(fixtureRoot, 'adapters/codex/skills/artifact-chain-bootstrap/SKILL.md'), 'utf-8');
    const claudeBootstrap = await readFile(join(fixtureRoot, 'adapters/claude/skills/artifact-chain-bootstrap/SKILL.md'), 'utf-8');
    expect(codexSkill).toContain('帮助 Codex');
    expect(claudeSkill).toContain('帮助 Claude Code');
    expect(codexBootstrap).toContain('after reading INSTALL.md');
    expect(claudeBootstrap).toContain('after reading INSTALL.md');
    await expect(runNodeScript('scripts/sync-skills.mjs', ['--check'], fixtureRoot)).resolves.toBeTruthy();

    await writeFile(join(fixtureRoot, 'adapters/codex/skills/where-am-i/SKILL.md'), `${codexSkill}\nDRIFT\n`);
    await expect(runNodeScript('scripts/sync-skills.mjs', ['--check'], fixtureRoot)).rejects.toThrow();
    await runNodeScript('scripts/sync-skills.mjs', [], fixtureRoot);
  });

  it('builds deterministic Codex and Claude Code adapter manifests', async () => {
    const fixtureRoot = await tempPluginFixture('adapters');
    await runNodeScript('scripts/build-adapters.mjs', [], fixtureRoot);

    const codexManifest = JSON.parse(await readFile(join(fixtureRoot, 'adapters/codex/.codex-plugin/plugin.json'), 'utf-8'));
    const claudeManifest = JSON.parse(await readFile(join(fixtureRoot, 'adapters/claude/.claude-plugin/plugin.json'), 'utf-8'));
    expect(codexManifest.name).toBe('artifact-chain-assistant');
    expect(claudeManifest.name).toBe('artifact-chain-assistant');
    expect(codexManifest.skills).toBe('./skills/');
    expect(claudeManifest.hooks).toBeUndefined();
    expect(claudeManifest.skills).toBeUndefined();
    expect(claudeManifest.commands).toBeUndefined();

    await expect(runNodeScript('scripts/build-adapters.mjs', ['--check'], fixtureRoot)).resolves.toBeTruthy();
    await access(join(fixtureRoot, 'adapters/claude/hooks/hooks.json'));
    await access(join(fixtureRoot, 'adapters/claude/commands/version-lock-audit.md'));
    await access(join(fixtureRoot, 'adapters/claude/bin/version-lock-audit.sh'));
  });

  it('validates generated Claude plugin when Claude CLI is available', async () => {
    try {
      await execFileAsync('claude', ['--version']);
    } catch {
      return;
    }

    await expect(execFileAsync('claude', ['plugin', 'validate', join(pluginRoot, 'adapters/claude')])).resolves.toBeTruthy();
  });

  it('exposes opt-in Git hook installation through the CLI', async () => {
    const main = await initGitRoot('hook-cli');
    const worktree = join(dirname(main), `linked worktree-${Math.random().toString(16).slice(2)}`);
    await git(main, ['worktree', 'add', '--quiet', '-b', 'hook-cli-test', worktree]);
    const hookPath = await resolveGitHookPath(worktree, 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\necho user\n');

    const install = await capture(['hooks', 'install-git', '--root', worktree, '--hook', 'pre-commit'], worktree);
    expect(install.code).toBe(0);
    expect(install.stdout).toContain('installed');
    expect(install.stdout).toContain(hookPath);
    const installed = await readFile(hookPath, 'utf-8');
    expect(installed).toContain('echo user');
    expect(installed).toContain('version-lock refresh --changed-only --staged');
    await expect(access(join(worktree, '.git/hooks/pre-commit'))).rejects.toMatchObject({ code: 'ENOTDIR' });

    const uninstall = await capture(['hooks', 'install-git', '--root', worktree, '--hook', 'pre-commit', '--uninstall'], worktree);
    expect(uninstall.code).toBe(0);
    expect(uninstall.stdout).toContain('uninstalled');
    const uninstalled = await readFile(hookPath, 'utf-8');
    expect(uninstalled).toContain('echo user');
    expect(uninstalled).not.toContain('version-lock refresh');
  });

  it('reports an actionable CLI error for an unsupported Git hook interpreter', async () => {
    const root = await initGitRoot('unsupported-hook-cli');
    const hookPath = await resolveGitHookPath(root, 'pre-commit');
    await writeFile(hookPath, '#!/usr/bin/env python3\nprint("user")\n');
    await chmod(hookPath, 0o744);
    const before = await stat(hookPath);

    const result = await capture(['hooks', 'install-git', '--root', root, '--hook', 'pre-commit'], root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Refusing to modify non-shell Git hook ${hookPath}`);
    expect(result.stderr).toContain('#!/usr/bin/env python3');
    expect(result.stderr).toContain('Call the artifact-chain hook from the existing hook explicitly.');
    expect(await readFile(hookPath, 'utf8')).toBe('#!/usr/bin/env python3\nprint("user")\n');
    const after = await stat(hookPath);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('refuses valid and dangling hook symlinks without changing link or target state', async () => {
    for (const kind of ['valid', 'dangling'] as const) {
      const root = await initGitRoot(`hook-symlink-${kind}`);
      const hookPath = await resolveGitHookPath(root, 'pre-commit');
      const targetPath = join(root, `${kind}-target`);
      if (kind === 'valid') {
        await writeFile(targetPath, '#!/bin/sh\necho target\n');
        await chmod(targetPath, 0o741);
        await utimes(targetPath, new Date('2002-03-04T05:06:07.000Z'), new Date('2002-03-04T05:06:07.000Z'));
      }
      await symlink(targetPath, hookPath);
      const beforeLink = await lstat(hookPath);
      const beforeTarget = kind === 'valid' ? await readFile(targetPath) : undefined;
      const beforeTargetStat = kind === 'valid' ? await stat(targetPath) : undefined;

      const result = await capture(['hooks', 'install-git', '--root', root, '--hook', 'pre-commit'], root);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SYMLINK_HOOK_UNSUPPORTED');
      expect(result.stderr).toContain(hookPath);
      expect(result.stderr).toContain('Integrate the artifact-graph commands manually');
      expect(await readlink(hookPath)).toBe(targetPath);
      const afterLink = await lstat(hookPath);
      expect(afterLink.isSymbolicLink()).toBe(true);
      expect(afterLink.mode).toBe(beforeLink.mode);
      expect(afterLink.mtimeMs).toBe(beforeLink.mtimeMs);
      if (kind === 'valid') {
        expect(await readFile(targetPath)).toEqual(beforeTarget);
        const afterTargetStat = await stat(targetPath);
        expect(afterTargetStat.mode).toBe(beforeTargetStat!.mode);
        expect(afterTargetStat.mtimeMs).toBe(beforeTargetStat!.mtimeMs);
      }
    }
  });

  it('preflights every hook before --hook all writes any target', async () => {
    for (const fixture of ['python', 'symlink', 'invalid-state'] as const) {
      const root = await initGitRoot(`all-preflight-${fixture}`);
      const preCommit = await resolveGitHookPath(root, 'pre-commit');
      const prePush = await resolveGitHookPath(root, 'pre-push');
      if (fixture === 'python') {
        await writeFile(prePush, '#!/usr/bin/env python3\nprint("user")\n');
        await chmod(prePush, 0o744);
      } else if (fixture === 'symlink') {
        await symlink(join(root, 'dangling-pre-push-target'), prePush);
      } else {
        await writeFile(prePush, [
          '#!/bin/sh',
          '# >>> artifact-chain-assistant managed block >>>',
          '# artifact-chain-assistant managed state v1: not-base64',
          'echo managed',
          '# <<< artifact-chain-assistant managed block <<<',
          '',
        ].join('\n'));
        await chmod(prePush, 0o755);
      }
      const beforePushLink = fixture === 'symlink' ? await readlink(prePush) : undefined;
      const beforePushBytes = fixture !== 'symlink' ? await readFile(prePush) : undefined;
      const beforePushStat = await lstat(prePush);

      const result = await capture(['hooks', 'install-git', '--root', root, '--hook', 'all'], root);

      expect(result.code).toBe(1);
      await expect(lstat(preCommit)).rejects.toMatchObject({ code: 'ENOENT' });
      if (fixture === 'symlink') {
        expect(await readlink(prePush)).toBe(beforePushLink);
      } else {
        expect(await readFile(prePush)).toEqual(beforePushBytes);
      }
      const afterPushStat = await lstat(prePush);
      expect(afterPushStat.mode).toBe(beforePushStat.mode);
      expect(afterPushStat.mtimeMs).toBe(beforePushStat.mtimeMs);
    }
  });

  it('documents safe Git hook resolution, refusal, and manual chaining', async () => {
    const installPaths = [
      'docs/public/artifact-chain-assistant/INSTALL.md',
      'plugins/artifact-chain-assistant/INSTALL.md',
      'plugins/artifact-chain-assistant/adapters/codex/INSTALL.md',
      'plugins/artifact-chain-assistant/adapters/claude/INSTALL.md',
    ];
    const installGuides = await Promise.all(
      installPaths.map(async (path) => [path, await readFile(join(repoRoot, path), 'utf8')] as const),
    );

    for (const [path, installGuide] of installGuides) {
      expect(installGuide, path).toContain('linked worktree');
      expect(installGuide, path).toContain('core.hooksPath');
      expect(installGuide, path).toContain('Python');
      expect(installGuide, path).toContain('Node');
      expect(installGuide, path).toContain('non-zero');
      expect(installGuide, path).toContain('subprocess.run([binary, *args], check=True)');
      expect(installGuide, path).toContain("spawnSync(binary, args, { shell: false, stdio: 'inherit' })");
      expect(installGuide, path).toContain('Do not paste the managed shell block');
      expect(installGuide, path).toContain('does not replace Git hard gates or CI');
      expect(installGuide, path).not.toMatch(/\bshell\s*=\s*True\b/);
      expect(installGuide, path).not.toMatch(/\bshell\s*:\s*true\b/);
      expect(installGuide, path).not.toMatch(/\bexec(?:Sync)?\s*\(/);
      expect(installGuide, path).not.toMatch(/subprocess\.(?:run|call|check_call|check_output)\(\s*['"`]/);
      expect(installGuide, path).not.toMatch(/spawnSync\(\s*['"`]/);
      expect(installGuide, path).not.toMatch(/\b(?:binary|command|args)\s*\+\s*['"`]/);
    }
  });

  it('executes the documented Python non-shell hook in a Git repository', async () => {
    await assertDocumentedManualHook('python');
  });

  it('executes the documented Node.js non-shell hook in a Git repository', async () => {
    await assertDocumentedManualHook('javascript');
  });

  it('resolves default, worktree, relative, absolute, and spaced Git hook paths', async () => {
    const main = await initGitRoot('git-hook-path with spaces');
    const gitMain = realpathSync(main);
    const regular = await resolveGitHookPath(main, 'pre-commit');
    expect(regular).toBe(resolve(main, '.git/hooks/pre-commit'));

    const worktree = join(dirname(main), `linked-worktree with spaces-${Math.random().toString(16).slice(2)}`);
    await git(main, ['worktree', 'add', '--quiet', '-b', 'hook-path-test', worktree]);
    const linked = await resolveGitHookPath(worktree, 'pre-commit');
    expect(linked).toBe(resolve(gitMain, '.git/hooks/pre-commit'));

    await git(main, ['config', 'core.hooksPath', '.githooks with spaces']);
    const relativeCustom = await resolveGitHookPath(main, 'pre-push');
    expect(relativeCustom).toBe(resolve(main, '.githooks with spaces/pre-push'));

    const absoluteRoot = await tempRoot('absolute hooks with spaces');
    await git(main, ['config', 'core.hooksPath', absoluteRoot]);
    const absoluteCustom = await resolveGitHookPath(main, 'pre-push');
    expect(absoluteCustom).toBe(join(absoluteRoot, 'pre-push'));
  });

  it('propagates Git resolution failures', async () => {
    const root = await tempRoot('not-a-git-repository');
    await expect(resolveGitHookPath(root, 'pre-commit')).rejects.toMatchObject({ code: 128 });
  });

  it('pre-commit template fails when refresh changes the lock file', async () => {
    const template = await readFile(join(pluginRoot, 'templates/git-hooks/pre-commit.sh'), 'utf-8');

    expect(template).toContain('version-lock refresh --changed-only --staged');
    expect(template).toContain('|| exit $?');
    expect(template).toContain('git diff --quiet -- artifacts/traceability-version-lock.json');
    expect(template).toContain('stage artifacts/traceability-version-lock.json');
    expect(template).toContain('artifact-graph.config.yaml');
    expect(template).toContain('config_staged');
    expect(template).toContain('version-lock refresh --all --format markdown');
    expect(template).toContain('git diff --cached --name-only');
  });

  it('pre-commit template propagates refresh failures before diff checks', async () => {
    const root = await tempRoot('pre-commit-failure');
    const template = await readFile(join(pluginRoot, 'templates/git-hooks/pre-commit.sh'), 'utf-8');
    const hookPath = join(root, 'pre-commit.sh');
    await writeFile(hookPath, template);
    await chmod(hookPath, 0o755);
    await write(root, 'node_modules/.bin/artifact-graph', '#!/bin/sh\nexit 7\n');
    await chmod(join(root, 'node_modules/.bin/artifact-graph'), 0o755);

    await expect(execFileAsync('sh', [hookPath], { cwd: root })).rejects.toMatchObject({ code: 7 });
  });

  it('pre-push validates before audit and propagates command failures unchanged', async () => {
    const root = await tempRoot('pre-push-order');
    const hookPath = join(root, 'pre-push.sh');
    const template = await readFile(join(cliPackageRoot, 'templates/git-hooks/pre-push.sh'), 'utf8');
    await writeFile(hookPath, template);
    await chmod(hookPath, 0o755);
    await write(root, 'node_modules/.bin/artifact-graph', [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$HOOK_LOG"',
      'if [ "$1" = "validate" ] && [ "${FAIL_VALIDATE:-0}" = "1" ]; then exit 7; fi',
      'if [ "$1" = "version-lock" ] && [ "${FAIL_AUDIT:-0}" = "1" ]; then exit 9; fi',
      'exit 0',
      '',
    ].join('\n'));
    await chmod(join(root, 'node_modules/.bin/artifact-graph'), 0o755);
    const log = join(root, 'calls.log');
    const baseEnv = { ...process.env, HOOK_LOG: log };

    await execFileAsync('sh', [hookPath], { cwd: root, env: baseEnv });
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
      'validate --warning-only',
      'version-lock audit --strict-missing-lock',
    ]);

    await writeFile(log, '');
    await expect(execFileAsync('sh', [hookPath], {
      cwd: root,
      env: { ...baseEnv, FAIL_VALIDATE: '1' },
    })).rejects.toMatchObject({ code: 7 });
    expect((await readFile(log, 'utf8')).trim()).toBe('validate --warning-only');

    await writeFile(log, '');
    await expect(execFileAsync('sh', [hookPath], {
      cwd: root,
      env: { ...baseEnv, FAIL_AUDIT: '1' },
    })).rejects.toMatchObject({ code: 9 });
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
      'validate --warning-only',
      'version-lock audit --strict-missing-lock',
    ]);
  });

  it('switches pre-commit to --all mode when artifact-graph.config.yaml is staged', async () => {
    const root = await initGitRoot('config-staged-all');
    const log = join(root, 'hook.log');
    await write(root, 'node_modules/.bin/artifact-graph', [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$HOOK_LOG"',
      'if [ "${HOOK_TEST_FAIL:-}" = "refresh" ]; then exit 11; fi',
      'lock="artifacts/traceability-version-lock.json"',
      'if [ "${HOOK_TEST_WRITE_LOCK:-0}" = "1" ]; then printf "refreshed\\n" > "$lock"; fi',
      'exit 0',
      '',
    ].join('\n'));
    await chmod(join(root, 'node_modules/.bin/artifact-graph'), 0o755);
    await write(root, 'artifacts/traceability-version-lock.json', 'initial\n');
    await git(root, ['add', 'artifacts/traceability-version-lock.json']);
    await git(root, ['-c', 'user.name=Hook Test', '-c', 'user.email=hook@example.invalid', 'commit', '--quiet', '-m', 'lock']);

    const install = await capture(['hooks', 'install-git', '--root', root, '--hook', 'pre-commit'], root);
    expect(install.code).toBe(0);

    await write(root, 'artifact-graph.config.yaml', 'types: {}\n');
    await git(root, ['add', 'artifact-graph.config.yaml']);
    await writeFile(log, '');

    const commit = await commandResult('git', [
      '-C', root,
      '-c', 'user.name=Hook Test',
      '-c', 'user.email=hook@example.invalid',
      'commit', '--quiet', '-m', 'config change',
    ], root, { ...process.env, HOOK_LOG: log });

    expect(commit.code).toBe(0);
    expect((await readFile(log, 'utf8')).trim()).toBe('version-lock refresh --all --format markdown');
  });

  it('fails pre-commit when config staged and lock drifts during refresh', async () => {
    const root = await initGitRoot('config-staged-drift');
    const log = join(root, 'hook.log');
    await write(root, 'node_modules/.bin/artifact-graph', [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$HOOK_LOG"',
      'if [ "${HOOK_TEST_FAIL:-}" = "refresh" ]; then exit 11; fi',
      'lock="artifacts/traceability-version-lock.json"',
      'if [ "${HOOK_TEST_WRITE_LOCK:-0}" = "1" ]; then printf "refreshed\\n" > "$lock"; fi',
      'exit 0',
      '',
    ].join('\n'));
    await chmod(join(root, 'node_modules/.bin/artifact-graph'), 0o755);
    await write(root, 'artifacts/traceability-version-lock.json', 'initial\n');
    await git(root, ['add', 'artifacts/traceability-version-lock.json']);
    await git(root, ['-c', 'user.name=Hook Test', '-c', 'user.email=hook@example.invalid', 'commit', '--quiet', '-m', 'lock']);

    const install = await capture(['hooks', 'install-git', '--root', root, '--hook', 'pre-commit'], root);
    expect(install.code).toBe(0);

    await write(root, 'artifact-graph.config.yaml', 'types: {}\n');
    await git(root, ['add', 'artifact-graph.config.yaml']);
    await writeFile(log, '');

    const commit = await commandResult('git', [
      '-C', root,
      '-c', 'user.name=Hook Test',
      '-c', 'user.email=hook@example.invalid',
      'commit', '--quiet', '-m', 'config with drift',
    ], root, { ...process.env, HOOK_LOG: log, HOOK_TEST_WRITE_LOCK: '1' });

    expect(commit.code).not.toBe(0);
    expect((await readFile(log, 'utf8')).trim()).toBe('version-lock refresh --all --format markdown');
  });

  it('propagates refresh exit code when config staged and refresh fails', async () => {
    const root = await initGitRoot('config-staged-refresh-fail');
    const log = join(root, 'hook.log');
    await write(root, 'node_modules/.bin/artifact-graph', [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$HOOK_LOG"',
      'if [ "${HOOK_TEST_FAIL:-}" = "refresh" ]; then exit 11; fi',
      'lock="artifacts/traceability-version-lock.json"',
      'if [ "${HOOK_TEST_WRITE_LOCK:-0}" = "1" ]; then printf "refreshed\\n" > "$lock"; fi',
      'exit 0',
      '',
    ].join('\n'));
    await chmod(join(root, 'node_modules/.bin/artifact-graph'), 0o755);
    await write(root, 'artifacts/traceability-version-lock.json', 'initial\n');
    await git(root, ['add', 'artifacts/traceability-version-lock.json']);
    await git(root, ['-c', 'user.name=Hook Test', '-c', 'user.email=hook@example.invalid', 'commit', '--quiet', '-m', 'lock']);

    const install = await capture(['hooks', 'install-git', '--root', root, '--hook', 'pre-commit'], root);
    expect(install.code).toBe(0);

    await write(root, 'artifact-graph.config.yaml', 'types: {}\n');
    await git(root, ['add', 'artifact-graph.config.yaml']);
    await writeFile(log, '');

    const commit = await commandResult('git', [
      '-C', root,
      '-c', 'user.name=Hook Test',
      '-c', 'user.email=hook@example.invalid',
      'commit', '--quiet', '-m', 'config refresh fail',
    ], root, { ...process.env, HOOK_LOG: log, HOOK_TEST_FAIL: 'refresh' });

    expect(commit.code).not.toBe(0);
    expect((await readFile(log, 'utf8')).trim()).toBe('version-lock refresh --all --format markdown');
  });

  it('checks and repairs generated hook templates with exact bytes and mode', async () => {
    const root = await tempRoot('hook-template-sync');
    const sourceDir = join(root, 'packages/artifact-graph/templates/git-hooks');
    const targetDir = join(root, 'plugins/artifact-chain-assistant/templates/git-hooks');
    const script = join(repoRoot, 'scripts/sync-hook-templates.mjs');

    for (const hook of ['pre-commit.sh', 'pre-push.sh']) {
      const source = await readFile(join(cliPackageRoot, 'templates/git-hooks', hook));
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, hook), source);
      await chmod(join(sourceDir, hook), 0o755);
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, hook), source);
      await chmod(join(targetDir, hook), 0o755);
    }

    await expect(execFileAsync('node', [script, '--root', root, '--check'])).resolves.toBeTruthy();

    const driftedTarget = join(targetDir, 'pre-push.sh');
    const modeDriftedTarget = join(targetDir, 'pre-commit.sh');
    const expectedBytes = await readFile(join(sourceDir, 'pre-push.sh'));
    await writeFile(driftedTarget, Buffer.concat([expectedBytes, Buffer.from('drift\n')]));
    await chmod(driftedTarget, 0o644);
    await chmod(modeDriftedTarget, 0o644);

    const driftCheck = execFileAsync('node', [script, '--root', root, '--check']);
    await expect(driftCheck).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(driftedTarget),
    });
    await expect(driftCheck).rejects.toMatchObject({
      stderr: expect.stringContaining(modeDriftedTarget),
    });
    expect(await readFile(driftedTarget)).toEqual(Buffer.concat([expectedBytes, Buffer.from('drift\n')]));
    expect((await stat(driftedTarget)).mode & 0o777).toBe(0o644);
    expect((await stat(modeDriftedTarget)).mode & 0o777).toBe(0o644);

    await execFileAsync('node', [script, '--root', root]);
    for (const hook of ['pre-commit.sh', 'pre-push.sh']) {
      expect(await readFile(join(targetDir, hook))).toEqual(await readFile(join(sourceDir, hook)));
      expect((await stat(join(targetDir, hook))).mode & 0o777).toBe(0o755);
    }
    await expect(execFileAsync('node', [script, '--root', root, '--check'])).resolves.toBeTruthy();
  });

  it('keeps CLI and plugin Git hook templates in sync', async () => {
    const pluginTemplate = await readFile(join(pluginRoot, 'templates/git-hooks/pre-commit.sh'), 'utf-8');
    const cliTemplate = await readFile(join(cliPackageRoot, 'templates/git-hooks/pre-commit.sh'), 'utf-8');
    const pluginPrePush = await readFile(join(pluginRoot, 'templates/git-hooks/pre-push.sh'), 'utf-8');
    const cliPrePush = await readFile(join(cliPackageRoot, 'templates/git-hooks/pre-push.sh'), 'utf-8');

    expect(cliTemplate).toBe(pluginTemplate);
    expect(cliPrePush).toBe(pluginPrePush);
  });
});
