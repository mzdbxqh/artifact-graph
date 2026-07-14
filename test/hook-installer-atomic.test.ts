import { chmod, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

// @scenario S-04 @feature ACA4
const state = vi.hoisted(() => ({
  afterSync: undefined as undefined | ((syncCount: number) => Promise<void>),
  failRenameAt: undefined as undefined | number,
  renameCount: 0,
  syncCount: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'sync') {
            return async () => {
              await target.sync();
              state.syncCount += 1;
              await state.afterSync?.(state.syncCount);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      state.renameCount += 1;
      if (state.renameCount === state.failRenameAt) {
        throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      }
      return actual.rename(...args);
    },
  };
});

import {
  applyPreparedManagedHookBlocks,
  installManagedHookBlock,
  prepareManagedHookBlock,
} from '../src/hook-installer.js';

async function tempRoot(): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-hook-atomic-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

describe('managed hook atomic updates', () => {
  it('rejects a target replaced while the temporary file is prepared', async () => {
    const root = await tempRoot();
    const hookPath = join(root, 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\necho original\n');
    state.afterSync = async (syncCount) => {
      if (syncCount === 1) {
        await writeFile(hookPath, '#!/bin/sh\necho concurrent replacement\n');
      }
    };

    try {
      await expect(installManagedHookBlock({ hookPath, block: 'echo managed' }))
        .rejects.toMatchObject({ code: 'CONCURRENT_HOOK_MODIFICATION', hookPath });
      expect(await readFile(hookPath, 'utf8')).toBe('#!/bin/sh\necho concurrent replacement\n');
      expect(await readdir(root)).toEqual(['pre-commit']);
    } finally {
      state.afterSync = undefined;
      state.syncCount = 0;
      state.renameCount = 0;
    }
  });

  it('rolls back earlier prepared hooks when a later target changes concurrently', async () => {
    const root = await tempRoot();
    const preCommit = join(root, 'pre-commit');
    const prePush = join(root, 'pre-push');
    const prePushOriginal = '#!/bin/sh\necho push-original\n';
    await writeFile(prePush, prePushOriginal);
    await chmod(prePush, 0o640);
    const prepared = await Promise.all([
      prepareManagedHookBlock({ hookPath: preCommit, block: 'echo commit-managed' }),
      prepareManagedHookBlock({ hookPath: prePush, block: 'echo push-managed' }),
    ]);
    state.afterSync = async (syncCount) => {
      if (syncCount === 2) {
        await writeFile(prePush, '#!/bin/sh\necho concurrent push\n');
        await chmod(prePush, 0o700);
      }
    };

    try {
      await expect(applyPreparedManagedHookBlocks(prepared)).rejects.toMatchObject({
        code: 'CONCURRENT_HOOK_MODIFICATION',
        hookPath: prePush,
      });
      await expect(lstat(preCommit)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(prePush, 'utf8')).toBe('#!/bin/sh\necho concurrent push\n');
      expect((await stat(prePush)).mode & 0o777).toBe(0o700);
      expect((await readdir(root)).sort()).toEqual(['pre-push']);
    } finally {
      state.afterSync = undefined;
      state.syncCount = 0;
      state.renameCount = 0;
    }
  });

  it('writes nothing when a prepared target changes before batch application starts', async () => {
    const root = await tempRoot();
    const preCommit = join(root, 'pre-commit');
    const prePush = join(root, 'pre-push');
    await writeFile(prePush, '#!/bin/sh\necho push-original\n');
    const prepared = await Promise.all([
      prepareManagedHookBlock({ hookPath: preCommit, block: 'echo commit-managed' }),
      prepareManagedHookBlock({ hookPath: prePush, block: 'echo push-managed' }),
    ]);
    await writeFile(prePush, '#!/bin/sh\necho changed-before-apply\n');

    await expect(applyPreparedManagedHookBlocks(prepared)).rejects.toMatchObject({
      code: 'CONCURRENT_HOOK_MODIFICATION',
      hookPath: prePush,
    });
    await expect(lstat(preCommit)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(prePush, 'utf8')).toBe('#!/bin/sh\necho changed-before-apply\n');
    expect((await readdir(root)).sort()).toEqual(['pre-push']);
  });

  it('rolls back earlier prepared hooks when a later atomic rename fails', async () => {
    const root = await tempRoot();
    const preCommit = join(root, 'pre-commit');
    const prePush = join(root, 'pre-push');
    const commitOriginal = Buffer.from('#!/bin/sh\r\necho commit-original\r\n');
    const pushOriginal = Buffer.from('#!/bin/sh\necho push-original\n');
    await writeFile(preCommit, commitOriginal);
    await chmod(preCommit, 0o640);
    await writeFile(prePush, pushOriginal);
    await chmod(prePush, 0o650);
    const prepared = await Promise.all([
      prepareManagedHookBlock({ hookPath: preCommit, block: 'echo commit-managed' }),
      prepareManagedHookBlock({ hookPath: prePush, block: 'echo push-managed' }),
    ]);
    state.failRenameAt = 2;

    try {
      await expect(applyPreparedManagedHookBlocks(prepared)).rejects.toMatchObject({ code: 'EIO' });
      expect(await readFile(preCommit)).toEqual(commitOriginal);
      expect((await stat(preCommit)).mode & 0o777).toBe(0o640);
      expect(await readFile(prePush)).toEqual(pushOriginal);
      expect((await stat(prePush)).mode & 0o777).toBe(0o650);
      expect((await readdir(root)).sort()).toEqual(['pre-commit', 'pre-push']);
    } finally {
      state.failRenameAt = undefined;
      state.syncCount = 0;
      state.renameCount = 0;
    }
  });
});
