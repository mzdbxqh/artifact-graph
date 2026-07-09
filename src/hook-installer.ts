import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// @scenario S-04 @feature ACA4
const DEFAULT_MARKER_ID = 'artifact-chain-assistant';

export interface ManagedHookBlockOptions {
  hookPath: string;
  block: string;
  markerId?: string;
  uninstall?: boolean;
}

export interface HookInstallResult {
  hookPath: string;
  action: 'installed' | 'replaced' | 'uninstalled' | 'unchanged';
  markerId: string;
}

export async function installManagedHookBlock(options: ManagedHookBlockOptions): Promise<HookInstallResult> {
  const markerId = options.markerId ?? DEFAULT_MARKER_ID;
  const begin = beginMarker(markerId);
  const end = endMarker(markerId);
  const existing = await readHook(options.hookPath);
  const range = findManagedRange(existing, begin, end);

  if (options.uninstall === true) {
    if (!range) {
      return { hookPath: options.hookPath, action: 'unchanged', markerId };
    }
    await writeHook(options.hookPath, stripExtraBlankLines(`${existing.slice(0, range.start)}${existing.slice(range.end)}`));
    return { hookPath: options.hookPath, action: 'uninstalled', markerId };
  }

  const managedBlock = `${begin}\n${options.block.trimEnd()}\n${end}\n`;
  const next = range
    ? `${existing.slice(0, range.start)}${managedBlock}${existing.slice(range.end)}`
    : appendManagedBlock(existing, managedBlock);
  await writeHook(options.hookPath, next);
  return { hookPath: options.hookPath, action: range ? 'replaced' : 'installed', markerId };
}

function beginMarker(markerId: string): string {
  return `# >>> ${markerId} managed block >>>`;
}

function endMarker(markerId: string): string {
  return `# <<< ${markerId} managed block <<<`;
}

async function readHook(hookPath: string): Promise<string> {
  try {
    return await readFile(hookPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '#!/bin/sh\n';
    }
    throw error;
  }
}

async function writeHook(hookPath: string, content: string): Promise<void> {
  await mkdir(dirname(hookPath), { recursive: true });
  await writeFile(hookPath, content.endsWith('\n') ? content : `${content}\n`);
  await chmod(hookPath, 0o755);
}

function findManagedRange(content: string, begin: string, end: string): { start: number; end: number } | undefined {
  const start = content.indexOf(begin);
  if (start < 0) {
    return undefined;
  }
  const endStart = content.indexOf(end, start + begin.length);
  if (endStart < 0) {
    return undefined;
  }
  const endLine = content.indexOf('\n', endStart);
  return {
    start,
    end: endLine < 0 ? content.length : endLine + 1,
  };
}

function appendManagedBlock(existing: string, managedBlock: string): string {
  const base = existing.trimEnd();
  if (base.length === 0) {
    return managedBlock;
  }
  return `${base}\n\n${managedBlock}`;
}

function stripExtraBlankLines(content: string): string {
  return content.replace(/\n{3,}/g, '\n\n');
}
