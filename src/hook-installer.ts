import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readlink, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// @scenario S-04 @feature ACA4
const DEFAULT_MARKER_ID = 'artifact-chain-assistant';
const MANAGED_STATE_PREFIX = '# artifact-chain-assistant managed state v1:';

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

type HookEntryKind = 'missing' | 'file' | 'symlink' | 'other';

interface HookSnapshot {
  kind: HookEntryKind;
  bytes: Buffer;
  dev?: bigint;
  ino?: bigint;
  size?: bigint;
  mtimeNs?: bigint;
  mode?: bigint;
  linkTarget?: string;
}

interface DesiredHookState {
  exists: boolean;
  bytes: Buffer;
  mode?: number;
}

export interface PreparedManagedHookBlock {
  readonly hookPath: string;
  readonly result: HookInstallResult;
  readonly snapshot: HookSnapshot;
  readonly desired: DesiredHookState;
  readonly writeRequired: boolean;
}

interface ManagedHookStateV1 {
  version: 1;
  originalExists: boolean;
  originalMode: number | null;
  managedPrefix: string;
  displacedBytes: string | null;
}

interface RestoredHookState {
  exists: boolean;
  bytes: Buffer;
  mode?: number;
  insertionOffset?: number;
  managedPrefix?: Buffer;
}

export class UnsupportedHookInterpreterError extends Error {
  readonly code = 'UNSUPPORTED_HOOK_INTERPRETER';

  constructor(readonly hookPath: string, readonly shebang: string) {
    super(
      `Refusing to modify non-shell Git hook ${hookPath} (${shebang || 'missing shebang'}). ` +
      'Call the artifact-chain hook from the existing hook explicitly.',
    );
  }
}

export class SymlinkHookUnsupportedError extends Error {
  readonly code = 'SYMLINK_HOOK_UNSUPPORTED';

  constructor(readonly hookPath: string, readonly linkTarget: string) {
    super(
      `SYMLINK_HOOK_UNSUPPORTED: Refusing to modify Git hook symlink ${hookPath} -> ${linkTarget}. ` +
      'Integrate the artifact-graph commands manually in the symlink target or replace the link yourself.',
    );
  }
}

export class UnsupportedHookTypeError extends Error {
  readonly code = 'UNSUPPORTED_HOOK_TYPE';

  constructor(readonly hookPath: string) {
    super(`UNSUPPORTED_HOOK_TYPE: Git hook path ${hookPath} is not a regular file. Resolve it manually before retrying.`);
  }
}

export class InvalidManagedHookStateError extends Error {
  readonly code = 'INVALID_MANAGED_HOOK_STATE';

  constructor(readonly hookPath: string, detail: string) {
    super(`INVALID_MANAGED_HOOK_STATE: Cannot safely update ${hookPath}: ${detail}`);
  }
}

export class ConcurrentHookModificationError extends Error {
  readonly code = 'CONCURRENT_HOOK_MODIFICATION';

  constructor(readonly hookPath: string) {
    super(`Refusing to overwrite concurrently modified Git hook ${hookPath}. Retry the operation after reviewing the hook.`);
  }
}

export class HookTransactionRollbackError extends Error {
  readonly code = 'HOOK_TRANSACTION_ROLLBACK_FAILED';

  constructor(
    readonly operationError: unknown,
    readonly rollbackErrors: Array<{ hookPath: string; error: unknown }>,
  ) {
    super(
      `HOOK_TRANSACTION_ROLLBACK_FAILED: Hook update failed and ${rollbackErrors.length} rollback operation(s) also failed: ` +
      rollbackErrors.map(({ hookPath, error }) => `${hookPath}: ${(error as Error).message}`).join('; '),
    );
  }
}

export function detectHookInterpreter(content: string): 'empty' | 'shell' | 'unsupported' {
  if (content.trim().length === 0) {
    return 'empty';
  }
  const firstLine = content.split(/\r?\n/, 1)[0];
  const tokens = firstLine.match(/^#!\s*(.*)$/)?.[1]?.trim().split(/\s+/) ?? [];
  const [command, ...args] = tokens;
  const interpreter = command === '/usr/bin/env'
    ? args[0] === '-S' ? args[1] : args[0]
    : command;
  const name = interpreter?.split('/').at(-1);
  return name === 'sh' || name === 'bash' || name === 'dash' || name === 'zsh'
    ? 'shell'
    : 'unsupported';
}

export async function prepareManagedHookBlock(options: ManagedHookBlockOptions): Promise<PreparedManagedHookBlock> {
  const markerId = options.markerId ?? DEFAULT_MARKER_ID;
  const begin = beginMarker(markerId);
  const end = endMarker(markerId);
  const snapshot = await readHookSnapshot(options.hookPath);
  assertSupportedHookEntry(options.hookPath, snapshot);
  const existing = snapshot.kind === 'file' ? snapshot.bytes : Buffer.alloc(0);
  const range = findManagedRange(existing, begin, end);

  if (options.uninstall === true) {
    if (!range) {
      return {
        hookPath: options.hookPath,
        result: { hookPath: options.hookPath, action: 'unchanged', markerId },
        snapshot,
        desired: desiredFromSnapshot(snapshot),
        writeRequired: false,
      };
    }
    const restored = restoreManagedHook(existing, range, snapshotMode(snapshot), options.hookPath);
    return {
      hookPath: options.hookPath,
      result: { hookPath: options.hookPath, action: 'uninstalled', markerId },
      snapshot,
      desired: restored,
      writeRequired: true,
    };
  }

  const existingText = existing.toString('utf8');
  if (detectHookInterpreter(existingText) === 'unsupported') {
    throw new UnsupportedHookInterpreterError(options.hookPath, existingText.split(/\r?\n/, 1)[0]);
  }

  const base: RestoredHookState = range
    ? restoreManagedHook(existing, range, snapshotMode(snapshot), options.hookPath)
    : desiredFromSnapshot(snapshot);
  const baseText = base.bytes.toString('utf8');
  if (detectHookInterpreter(baseText) === 'unsupported') {
    throw new UnsupportedHookInterpreterError(options.hookPath, baseText.split(/\r?\n/, 1)[0]);
  }

  const empty = detectHookInterpreter(baseText) === 'empty';
  const insertionOffset = empty ? 0 : base.insertionOffset ?? base.bytes.length;
  const managedPrefix = empty
    ? Buffer.from('#!/bin/sh\n')
    : base.managedPrefix ?? (insertionOffset === base.bytes.length ? hookSeparator(base.bytes) : Buffer.alloc(0));
  const retainedPrefix = empty ? Buffer.alloc(0) : base.bytes.subarray(0, insertionOffset);
  const retainedSuffix = empty ? Buffer.alloc(0) : base.bytes.subarray(insertionOffset);
  const state: ManagedHookStateV1 = {
    version: 1,
    originalExists: base.exists,
    originalMode: base.exists ? base.mode ?? null : null,
    managedPrefix: managedPrefix.toString('base64'),
    displacedBytes: empty && base.exists ? base.bytes.toString('base64') : null,
  };
  const managedBlock = createManagedBlock(begin, end, options.block, state);
  const desiredMode = executableHookMode(base.exists ? base.mode : undefined);

  return {
    hookPath: options.hookPath,
    result: { hookPath: options.hookPath, action: range ? 'replaced' : 'installed', markerId },
    snapshot,
    desired: {
      exists: true,
      bytes: Buffer.concat([retainedPrefix, managedPrefix, managedBlock, retainedSuffix]),
      mode: desiredMode,
    },
    writeRequired: true,
  };
}

export async function applyPreparedManagedHookBlocks(
  prepared: readonly PreparedManagedHookBlock[],
): Promise<HookInstallResult[]> {
  assertDistinctHookPaths(prepared);
  for (const plan of prepared) {
    const current = await readHookSnapshot(plan.hookPath);
    if (!sameHookSnapshot(plan.snapshot, current)) {
      throw new ConcurrentHookModificationError(plan.hookPath);
    }
  }

  const applied: PreparedManagedHookBlock[] = [];
  try {
    for (const plan of prepared) {
      if (plan.writeRequired) {
        await applyDesiredState(plan);
        applied.push(plan);
      }
    }
    return prepared.map((plan) => plan.result);
  } catch (error) {
    const rollbackErrors: Array<{ hookPath: string; error: unknown }> = [];
    for (const plan of applied.reverse()) {
      try {
        await rollbackPreparedHook(plan);
      } catch (rollbackError) {
        rollbackErrors.push({ hookPath: plan.hookPath, error: rollbackError });
      }
    }
    if (rollbackErrors.length > 0) {
      throw new HookTransactionRollbackError(error, rollbackErrors);
    }
    throw error;
  }
}

export async function installManagedHookBlock(options: ManagedHookBlockOptions): Promise<HookInstallResult> {
  const prepared = await prepareManagedHookBlock(options);
  return (await applyPreparedManagedHookBlocks([prepared]))[0];
}

function beginMarker(markerId: string): string {
  return `# >>> ${markerId} managed block >>>`;
}

function endMarker(markerId: string): string {
  return `# <<< ${markerId} managed block <<<`;
}

function createManagedBlock(begin: string, end: string, block: string, state: ManagedHookStateV1): Buffer {
  const encodedState = Buffer.from(JSON.stringify(state)).toString('base64');
  return Buffer.from(`${begin}\n${MANAGED_STATE_PREFIX} ${encodedState}\n${block.trimEnd()}\n${end}\n`);
}

function assertSupportedHookEntry(hookPath: string, snapshot: HookSnapshot): void {
  if (snapshot.kind === 'symlink') {
    throw new SymlinkHookUnsupportedError(hookPath, snapshot.linkTarget ?? '<unknown>');
  }
  if (snapshot.kind === 'other') {
    throw new UnsupportedHookTypeError(hookPath);
  }
}

function assertDistinctHookPaths(prepared: readonly PreparedManagedHookBlock[]): void {
  const seen = new Set<string>();
  for (const plan of prepared) {
    if (seen.has(plan.hookPath)) {
      throw new Error(`Duplicate prepared Git hook path: ${plan.hookPath}`);
    }
    seen.add(plan.hookPath);
  }
}

function executableHookMode(mode: number | undefined): number {
  if (mode === undefined) {
    return 0o755;
  }
  return (mode & 0o111) === 0 ? mode | 0o100 : mode;
}

function hookSeparator(existing: Buffer): Buffer {
  return existing.at(-1) === 0x0a ? Buffer.from('\n') : Buffer.from('\n\n');
}

function desiredFromSnapshot(snapshot: HookSnapshot): DesiredHookState {
  return snapshot.kind === 'file'
    ? { exists: true, bytes: snapshot.bytes, mode: snapshotMode(snapshot) }
    : { exists: false, bytes: Buffer.alloc(0) };
}

function snapshotMode(snapshot: HookSnapshot): number | undefined {
  return snapshot.mode === undefined ? undefined : Number(snapshot.mode & 0o777n);
}

function restoreManagedHook(
  content: Buffer,
  range: { start: number; end: number },
  currentMode: number | undefined,
  hookPath: string,
): RestoredHookState {
  const state = parseManagedState(content.subarray(range.start, range.end), hookPath);
  if (!state) {
    return {
      exists: true,
      bytes: Buffer.concat([content.subarray(0, range.start), content.subarray(range.end)]),
      mode: currentMode,
      insertionOffset: range.start,
      managedPrefix: Buffer.alloc(0),
    };
  }

  const managedPrefix = decodeBase64(state.managedPrefix, hookPath, 'managedPrefix');
  const prefixStart = range.start - managedPrefix.length;
  if (prefixStart < 0 || !content.subarray(prefixStart, range.start).equals(managedPrefix)) {
    throw new InvalidManagedHookStateError(hookPath, 'managed prefix does not match the recorded state');
  }
  const displaced = state.displacedBytes === null
    ? Buffer.alloc(0)
    : decodeBase64(state.displacedBytes, hookPath, 'displacedBytes');
  const bytes = Buffer.concat([
    content.subarray(0, prefixStart),
    displaced,
    content.subarray(range.end),
  ]);
  const exists = state.originalExists || bytes.length > 0;
  return {
    exists,
    bytes,
    mode: state.originalExists ? state.originalMode ?? undefined : exists ? currentMode : undefined,
    insertionOffset: prefixStart + displaced.length,
    managedPrefix,
  };
}

function parseManagedState(managedBlock: Buffer, hookPath: string): ManagedHookStateV1 | undefined {
  const stateLine = managedBlock.toString('utf8')
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${MANAGED_STATE_PREFIX} `));
  if (!stateLine) {
    return undefined;
  }
  try {
    const encoded = stateLine.slice(MANAGED_STATE_PREFIX.length + 1).trim();
    const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Partial<ManagedHookStateV1>;
    if (
      parsed.version !== 1 ||
      typeof parsed.originalExists !== 'boolean' ||
      !(parsed.originalMode === null || Number.isInteger(parsed.originalMode)) ||
      typeof parsed.managedPrefix !== 'string' ||
      !(parsed.displacedBytes === null || typeof parsed.displacedBytes === 'string')
    ) {
      throw new Error('unsupported state fields');
    }
    if (parsed.originalExists && parsed.originalMode === null) {
      throw new Error('existing hook state is missing its original mode');
    }
    return parsed as ManagedHookStateV1;
  } catch (error) {
    throw new InvalidManagedHookStateError(hookPath, (error as Error).message);
  }
}

function decodeBase64(value: string, hookPath: string, field: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new InvalidManagedHookStateError(hookPath, `${field} is not canonical base64`);
  }
  return decoded;
}

async function readHookSnapshot(hookPath: string): Promise<HookSnapshot> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let metadata;
    try {
      metadata = await lstat(hookPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kind: 'missing', bytes: Buffer.alloc(0) };
      }
      throw error;
    }

    if (metadata.isSymbolicLink()) {
      return {
        kind: 'symlink',
        bytes: Buffer.alloc(0),
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        mtimeNs: metadata.mtimeNs,
        mode: metadata.mode,
        linkTarget: await readlink(hookPath),
      };
    }
    if (!metadata.isFile()) {
      return {
        kind: 'other',
        bytes: Buffer.alloc(0),
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        mtimeNs: metadata.mtimeNs,
        mode: metadata.mode,
      };
    }

    let handle;
    try {
      handle = await open(hookPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        await handle.close();
        continue;
      }
      const bytes = await handle.readFile();
      await handle.close();
      return {
        kind: 'file',
        bytes,
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        mtimeNs: metadata.mtimeNs,
        mode: metadata.mode,
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ELOOP') {
        continue;
      }
      throw error;
    }
  }
  throw new ConcurrentHookModificationError(hookPath);
}

async function applyDesiredState(plan: PreparedManagedHookBlock): Promise<void> {
  if (plan.desired.exists) {
    await writeHookAtomically(plan.hookPath, plan.desired.bytes, plan.snapshot, plan.desired.mode!);
  } else {
    await removeHookAtomically(plan.hookPath, plan.snapshot);
  }
}

async function rollbackPreparedHook(plan: PreparedManagedHookBlock): Promise<void> {
  const current = await readHookSnapshot(plan.hookPath);
  if (!matchesDesiredState(current, plan.desired)) {
    throw new ConcurrentHookModificationError(plan.hookPath);
  }
  if (plan.snapshot.kind === 'file') {
    await writeHookAtomically(plan.hookPath, plan.snapshot.bytes, current, snapshotMode(plan.snapshot)!);
  } else {
    await removeHookAtomically(plan.hookPath, current);
  }
}

function matchesDesiredState(snapshot: HookSnapshot, desired: DesiredHookState): boolean {
  if (!desired.exists) {
    return snapshot.kind === 'missing';
  }
  return snapshot.kind === 'file'
    && snapshot.bytes.equals(desired.bytes)
    && snapshotMode(snapshot) === desired.mode;
}

async function removeHookAtomically(hookPath: string, snapshot: HookSnapshot): Promise<void> {
  const current = await readHookSnapshot(hookPath);
  if (!sameHookSnapshot(snapshot, current)) {
    throw new ConcurrentHookModificationError(hookPath);
  }
  if (current.kind !== 'missing') {
    await unlink(hookPath);
  }
}

async function writeHookAtomically(
  hookPath: string,
  content: Buffer,
  snapshot: HookSnapshot,
  mode: number,
): Promise<void> {
  await mkdir(dirname(hookPath), { recursive: true });
  const temporaryPath = join(dirname(hookPath), `.${basename(hookPath)}.${randomUUID()}.tmp`);
  let temporaryExists = false;

  try {
    const temporary = await open(temporaryPath, 'wx', mode);
    temporaryExists = true;
    try {
      await temporary.writeFile(content);
      await temporary.chmod(mode);
      await temporary.sync();
    } finally {
      await temporary.close();
    }

    const current = await readHookSnapshot(hookPath);
    if (!sameHookSnapshot(snapshot, current)) {
      throw new ConcurrentHookModificationError(hookPath);
    }
    await rename(temporaryPath, hookPath);
    temporaryExists = false;
  } finally {
    if (temporaryExists) {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  }
}

function sameHookSnapshot(expected: HookSnapshot, actual: HookSnapshot): boolean {
  return expected.kind === actual.kind
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeNs === actual.mtimeNs
    && expected.mode === actual.mode
    && expected.linkTarget === actual.linkTarget
    && expected.bytes.equals(actual.bytes);
}

function findManagedRange(content: Buffer, begin: string, end: string): { start: number; end: number } | undefined {
  const start = content.indexOf(Buffer.from(begin));
  if (start < 0) {
    return undefined;
  }
  const endStart = content.indexOf(Buffer.from(end), start + Buffer.byteLength(begin));
  if (endStart < 0) {
    return undefined;
  }
  const endLine = content.indexOf(0x0a, endStart);
  return {
    start,
    end: endLine < 0 ? content.length : endLine + 1,
  };
}
