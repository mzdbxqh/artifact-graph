import { execFile } from 'node:child_process';
import { access, chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { doctorArtifactChain, resolveArtifactGraphCli } from '../src/cli-resolver.js';
import { installManagedHookBlock } from '../src/hook-installer.js';

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
    const root = await tempRoot('hook-cli');
    await write(root, '.git/hooks/pre-commit', '#!/bin/sh\necho user\n');

    const install = await capture(['hooks', 'install-git', '--root', root, '--hook', 'pre-commit'], root);
    expect(install.code).toBe(0);
    expect(install.stdout).toContain('installed');
    const installed = await readFile(join(root, '.git/hooks/pre-commit'), 'utf-8');
    expect(installed).toContain('echo user');
    expect(installed).toContain('version-lock refresh --changed-only --staged');

    const uninstall = await capture(['hooks', 'install-git', '--root', root, '--hook', 'pre-commit', '--uninstall'], root);
    expect(uninstall.code).toBe(0);
    expect(uninstall.stdout).toContain('uninstalled');
    const uninstalled = await readFile(join(root, '.git/hooks/pre-commit'), 'utf-8');
    expect(uninstalled).toContain('echo user');
    expect(uninstalled).not.toContain('version-lock refresh');
  });

  it('pre-commit template fails when refresh changes the lock file', async () => {
    const template = await readFile(join(pluginRoot, 'templates/git-hooks/pre-commit.sh'), 'utf-8');

    expect(template).toContain('version-lock refresh --changed-only --staged');
    expect(template).toContain('|| exit $?');
    expect(template).toContain('git diff --quiet -- artifacts/traceability-version-lock.json');
    expect(template).toContain('stage artifacts/traceability-version-lock.json');
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

  it('keeps CLI and plugin Git hook templates in sync', async () => {
    const pluginTemplate = await readFile(join(pluginRoot, 'templates/git-hooks/pre-commit.sh'), 'utf-8');
    const cliTemplate = await readFile(join(cliPackageRoot, 'templates/git-hooks/pre-commit.sh'), 'utf-8');
    const pluginPrePush = await readFile(join(pluginRoot, 'templates/git-hooks/pre-push.sh'), 'utf-8');
    const cliPrePush = await readFile(join(cliPackageRoot, 'templates/git-hooks/pre-push.sh'), 'utf-8');

    expect(cliTemplate).toBe(pluginTemplate);
    expect(cliPrePush).toBe(pluginPrePush);
  });
});
