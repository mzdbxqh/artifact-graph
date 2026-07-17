import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function command(binary, args, options = {}) {
  try {
    const result = await execFileAsync(binary, args, options);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function git(root, args, options = {}) {
  const result = await command('git', ['-C', root, ...args], options);
  assert.equal(result.code, 0, result.stderr);
  return result;
}

async function initRepository(root) {
  await mkdir(root, { recursive: true });
  await git(root, ['init', '--quiet']);
  await writeFile(join(root, 'seed.txt'), 'seed\n');
  await git(root, ['add', 'seed.txt']);
  await git(root, [
    '-c', 'user.name=Packed Hook Test',
    '-c', 'user.email=packed-hook@example.invalid',
    'commit', '--quiet', '-m', 'seed',
  ]);
}

async function resolveHookPath(root, hookName) {
  const value = (await git(root, ['rev-parse', '--git-path', `hooks/${hookName}`])).stdout.trim();
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), (error) => error.code === 'ENOENT');
}

async function packBuiltCli(testRoot) {
  const build = await command('pnpm', ['build'], { cwd: packageRoot });
  assert.equal(build.code, 0, build.stderr);
  const packDir = join(testRoot, 'pack');
  await mkdir(packDir, { recursive: true });
  const packed = await command('pnpm', ['pack', '--pack-destination', packDir], { cwd: packageRoot });
  assert.equal(packed.code, 0, packed.stderr);
  const tarball = join(packDir, (await readdir(packDir)).find((entry) => entry.endsWith('.tgz')));
  const extractDir = join(testRoot, 'extract');
  await mkdir(extractDir, { recursive: true });
  const extracted = await command('tar', ['-xzf', tarball, '-C', extractDir]);
  assert.equal(extracted.code, 0, extracted.stderr);
  await symlink(join(packageRoot, 'node_modules'), join(extractDir, 'package/node_modules'), 'dir');
  const cli = join(extractDir, 'package/dist/cli.js');
  await lstat(cli);
  return cli;
}

async function runCli(cli, root, args) {
  return command('node', [cli, 'hooks', 'install-git', '--root', root, ...args], { cwd: root });
}

async function verifyAllPreflight(cli, testRoot) {
  const root = join(testRoot, 'all-preflight-python');
  await initRepository(root);
  const preCommit = await resolveHookPath(root, 'pre-commit');
  const prePush = await resolveHookPath(root, 'pre-push');
  const bytes = Buffer.from('#!/usr/bin/env python3\nprint("user")\n');
  await writeFile(prePush, bytes);
  await chmod(prePush, 0o741);
  await utimes(prePush, new Date('2003-04-05T06:07:08.000Z'), new Date('2003-04-05T06:07:08.000Z'));
  const before = await stat(prePush);

  const result = await runCli(cli, root, ['--hook', 'all']);

  assert.equal(result.code, 1);
  await assertMissing(preCommit);
  assert.deepEqual(await readFile(prePush), bytes);
  const after = await stat(prePush);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
}

async function verifySymlinkRefusal(cli, testRoot) {
  for (const kind of ['valid', 'dangling']) {
    for (const selection of ['single', 'all']) {
      const root = join(testRoot, `symlink-${kind}-${selection}`);
      await initRepository(root);
      const hookName = selection === 'all' ? 'pre-push' : 'pre-commit';
      const hookPath = await resolveHookPath(root, hookName);
      const target = join(root, `${kind}-target`);
      if (kind === 'valid') {
        await writeFile(target, '#!/bin/sh\necho target\n');
        await chmod(target, 0o741);
        await utimes(target, new Date('2004-05-06T07:08:09.000Z'), new Date('2004-05-06T07:08:09.000Z'));
      }
      await symlink(target, hookPath);
      const beforeLink = await lstat(hookPath);
      const beforeTargetBytes = kind === 'valid' ? await readFile(target) : undefined;
      const beforeTarget = kind === 'valid' ? await stat(target) : undefined;

      const result = await runCli(cli, root, ['--hook', selection === 'all' ? 'all' : hookName]);

      assert.equal(result.code, 1);
      assert.match(result.stderr, /SYMLINK_HOOK_UNSUPPORTED/);
      assert.equal(await readlink(hookPath), target);
      const afterLink = await lstat(hookPath);
      assert.equal(afterLink.mode, beforeLink.mode);
      assert.equal(afterLink.mtimeMs, beforeLink.mtimeMs);
      if (kind === 'valid') {
        assert.deepEqual(await readFile(target), beforeTargetBytes);
        const afterTarget = await stat(target);
        assert.equal(afterTarget.mode, beforeTarget.mode);
        assert.equal(afterTarget.mtimeMs, beforeTarget.mtimeMs);
      }
      if (selection === 'all') {
        await assertMissing(await resolveHookPath(root, 'pre-commit'));
      }
    }
  }
}

async function verifyExactLifecycle(cli, testRoot) {
  for (const fixture of [
    { name: 'missing', exists: false, bytes: Buffer.alloc(0), mode: undefined },
    { name: 'empty', exists: true, bytes: Buffer.alloc(0), mode: 0o640 },
    { name: 'shell', exists: true, bytes: Buffer.from('#!/bin/sh\r\necho original\r\n'), mode: 0o640 },
  ]) {
    const root = join(testRoot, `lifecycle-${fixture.name}`);
    await initRepository(root);
    const hookPath = await resolveHookPath(root, 'pre-commit');
    if (fixture.exists) {
      await writeFile(hookPath, fixture.bytes);
      await chmod(hookPath, fixture.mode);
    }
    assert.equal((await runCli(cli, root, ['--hook', 'pre-commit'])).code, 0);
    assert.equal((await readFile(hookPath, 'utf8')).split(/\r?\n/, 1)[0], '#!/bin/sh');
    assert.notEqual((await stat(hookPath)).mode & 0o100, 0);
    assert.equal((await runCli(cli, root, ['--hook', 'pre-commit', '--uninstall'])).code, 0);
    if (!fixture.exists) {
      await assertMissing(hookPath);
    } else {
      assert.deepEqual(await readFile(hookPath), fixture.bytes);
      assert.equal((await stat(hookPath)).mode & 0o777, fixture.mode);
    }
  }
}

async function verifyRealGitExecution(cli, testRoot) {
  const root = join(testRoot, 'real-git-execution');
  const remote = join(testRoot, 'real-git-remote.git');
  await initRepository(root);
  const fakeCli = join(root, 'node_modules/.bin/artifact-graph');
  const log = join(root, 'hook.log');
  await mkdir(dirname(fakeCli), { recursive: true });
  await writeFile(fakeCli, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOOK_LOG"\nexit 0\n');
  await chmod(fakeCli, 0o755);
  await writeFile(log, '');
  assert.equal((await runCli(cli, root, ['--hook', 'all'])).code, 0);
  for (const hookName of ['pre-commit', 'pre-push']) {
    const hookPath = await resolveHookPath(root, hookName);
    assert.equal((await readFile(hookPath, 'utf8')).split(/\r?\n/, 1)[0], '#!/bin/sh');
    assert.notEqual((await stat(hookPath)).mode & 0o100, 0);
  }

  await writeFile(join(root, 'seed.txt'), 'changed\n');
  await git(root, ['add', 'seed.txt']);
  await git(root, [
    '-c', 'user.name=Packed Hook Test',
    '-c', 'user.email=packed-hook@example.invalid',
    'commit', '--quiet', '-m', 'exercise pre-commit',
  ], { env: { ...process.env, HOOK_LOG: log } });
  assert.equal((await readFile(log, 'utf8')).trim(), 'version-lock refresh --changed-only --staged --format markdown');

  await writeFile(log, '');
  const initBare = await command('git', ['init', '--bare', '--quiet', remote]);
  assert.equal(initBare.code, 0, initBare.stderr);
  await git(root, ['remote', 'add', 'origin', remote]);
  await git(root, ['push', '--quiet', '--set-upstream', 'origin', 'HEAD'], {
    env: { ...process.env, HOOK_LOG: log },
  });
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
    'validate --warning-only',
    'version-lock audit --strict-missing-lock',
  ]);
}

async function verifyConfigStagedAllMode(cli, testRoot) {
  const root = join(testRoot, 'config-staged-all');
  await initRepository(root);
  const fakeCli = join(root, 'node_modules/.bin/artifact-graph');
  const log = join(root, 'hook.log');
  await mkdir(dirname(fakeCli), { recursive: true });
  await writeFile(fakeCli, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOOK_LOG"\nexit 0\n');
  await chmod(fakeCli, 0o755);
  await writeFile(log, '');

  assert.equal((await runCli(cli, root, ['--hook', 'all'])).code, 0);

  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(join(root, 'artifacts/traceability-version-lock.json'), 'initial\n');
  await git(root, ['add', 'artifacts/traceability-version-lock.json']);
  await git(root, [
    '-c', 'user.name=Packed Hook Test',
    '-c', 'user.email=packed-hook@example.invalid',
    'commit', '--quiet', '-m', 'lock',
  ]);

  await writeFile(join(root, 'artifact-graph.config.yaml'), 'types: {}\n');
  await git(root, ['add', 'artifact-graph.config.yaml']);

  await git(root, [
    '-c', 'user.name=Packed Hook Test',
    '-c', 'user.email=packed-hook@example.invalid',
    'commit', '--quiet', '-m', 'config change',
  ], { env: { ...process.env, HOOK_LOG: log } });

  assert.equal((await readFile(log, 'utf8')).trim(), 'version-lock refresh --all --format markdown');
}

async function verifyFourLayouts(cli, testRoot) {
  const cases = [];
  const normal = join(testRoot, 'layout-normal');
  await initRepository(normal);
  cases.push(normal);

  const linkedMain = join(testRoot, 'layout-linked-main');
  const linked = join(testRoot, 'layout-linked-worktree');
  await initRepository(linkedMain);
  await git(linkedMain, ['worktree', 'add', '--quiet', '-b', 'packed-linked', linked]);
  cases.push(linked);

  const relative = join(testRoot, 'layout-relative');
  await initRepository(relative);
  await git(relative, ['config', 'core.hooksPath', '.hooks relative']);
  cases.push(relative);

  const absolute = join(testRoot, 'layout-absolute');
  const absoluteHooks = join(testRoot, 'absolute hooks');
  await initRepository(absolute);
  await git(absolute, ['config', 'core.hooksPath', absoluteHooks]);
  cases.push(absolute);

  for (const root of cases) {
    assert.equal((await runCli(cli, root, ['--hook', 'all'])).code, 0);
    for (const hookName of ['pre-commit', 'pre-push']) {
      const hookPath = await resolveHookPath(root, hookName);
      assert.equal((await readFile(hookPath, 'utf8')).split(/\r?\n/, 1)[0], '#!/bin/sh');
      assert.notEqual((await stat(hookPath)).mode & 0o100, 0);
    }
  }
}

const testRoot = await mkdtemp(join(tmpdir(), 'artifact-graph-packed-hooks-'));
const cli = await packBuiltCli(testRoot);
await verifyAllPreflight(cli, testRoot);
await verifySymlinkRefusal(cli, testRoot);
await verifyExactLifecycle(cli, testRoot);
await verifyRealGitExecution(cli, testRoot);
await verifyFourLayouts(cli, testRoot);
await verifyConfigStagedAllMode(cli, testRoot);
console.log('packed hook CLI: all scenarios passed');
