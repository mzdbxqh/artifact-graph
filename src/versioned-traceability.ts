import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { ArtifactEdge, ArtifactGraph, ArtifactNode, scanArtifacts } from './index.js';

// @scenario S-02 @feature ACA2
export const VERSION_LOCK_PATH = 'artifacts/traceability-version-lock.json';
export const VERSION_INDEX_SCHEMA_VERSION = '1.0';
export const VERSION_LOCK_SCHEMA_VERSION = '1.0';

export type VersionSourceKind = 'artifact' | 'code' | 'test';
export type VersionEdgeKind = 'references' | 'covers' | 'depends_on' | 'implements' | 'verifies';
export type VersionLockStatus =
  | 'fresh'
  | 'target_not_found'
  | 'artifact_changed'
  | 'source_changed'
  | 'verified_by_changed'
  | 'missing_lock'
  | 'orphan_lock';

export interface VersionedNode {
  uid: string;
  type: string;
  id: string;
  path: string;
  title: string;
  line: number;
  sourceKind: VersionSourceKind;
  contentHash: string;
}

export interface VersionedEdge {
  from: string;
  to: string;
  kind: VersionEdgeKind | string;
  source: string;
  sourcePath: string;
  sourceLine: number;
  fromHash?: string;
  toHash?: string;
}

export interface VersionIndex {
  schemaVersion: typeof VERSION_INDEX_SCHEMA_VERSION;
  root: string;
  graph: {
    nodes: number;
    edges: number;
  };
  nodes: VersionedNode[];
  edges: VersionedEdge[];
}

export interface VersionLockRef {
  type: string;
  id: string;
  path: string;
  contentHash: string;
}

export interface VersionLockSourceRef {
  type: 'code' | 'test';
  path: string;
  contentHash: string;
}

export interface VersionLockEntry {
  edgeId: string;
  kind: 'implements' | 'verifies';
  artifact: VersionLockRef;
  source: VersionLockSourceRef;
  verifiedBy?: VersionLockSourceRef[];
}

export interface VersionLockFile {
  schemaVersion: typeof VERSION_LOCK_SCHEMA_VERSION;
  locks: VersionLockEntry[];
}

export interface VersionLockIssue {
  status: VersionLockStatus;
  edgeId: string;
  message: string;
  artifact?: VersionLockRef;
  source?: VersionLockSourceRef;
  currentArtifactHash?: string;
  currentSourceHash?: string;
  currentVerifiedByHash?: string;
  verifiedByPath?: string;
}

export interface VersionLockAuditResult {
  schemaVersion: '1.0';
  root: string;
  lockPath: string;
  totalLocks: number;
  fresh: number;
  issues: VersionLockIssue[];
}

export interface TraceVersionResult {
  schemaVersion: '1.0';
  root: string;
  lockPath: string;
  target: {
    uid: string;
    node?: VersionedNode;
  };
  currentEdges: VersionedEdge[];
  locks: VersionLockEntry[];
  issues: VersionLockIssue[];
}

export interface VersionLockUpdateOptions {
  target: string;
  source: string;
  verifiedBy?: string[];
  lockPath?: string;
}

export interface VersionLockBootstrapOptions {
  lockPath?: string;
  force?: boolean;
}

export interface VersionLockRefreshOptions {
  lockPath?: string;
  changedOnly?: boolean;
  changedPaths?: string[];
  all?: boolean;
  removeOrphans?: boolean;
}

export interface VersionLockRefreshResult {
  schemaVersion: '1.0';
  root: string;
  lockPath: string;
  mode: 'all' | 'changed-only';
  changedPaths: string[];
  affectedEdges: string[];
  addedLocks: string[];
  updatedLocks: string[];
  retainedOrphans: string[];
  removedOrphans: string[];
  postAudit: VersionLockAuditResult;
  warnings: string[];
}

export async function buildVersionIndex(root: string, graph?: ArtifactGraph): Promise<VersionIndex> {
  const scannedGraph = graph ?? await scanArtifacts(root);
  const hashCache = new Map<string, string>();
  const nodes = await Promise.all(scannedGraph.nodes.map(async (node) => ({
    uid: node.uid,
    type: node.type,
    id: node.code,
    path: node.path,
    title: node.title,
    line: node.line,
    sourceKind: classifyNode(node),
    contentHash: await hashRelativePath(root, node.path, hashCache),
  } satisfies VersionedNode)));

  const hashByUid = new Map(nodes.map((node) => [node.uid, node.contentHash]));
  const edges = scannedGraph.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    kind: normalizeVersionEdgeKind(edge),
    source: edge.source,
    sourcePath: edge.sourcePath,
    sourceLine: edge.sourceLine,
    fromHash: hashByUid.get(edge.from),
    toHash: hashByUid.get(edge.to),
  }));

  return {
    schemaVersion: VERSION_INDEX_SCHEMA_VERSION,
    root,
    graph: {
      nodes: scannedGraph.nodes.length,
      edges: scannedGraph.edges.length,
    },
    nodes: sortBy(nodes, (node) => node.uid),
    edges: sortBy(edges, (edge) => `${edge.from}\t${edge.to}\t${edge.kind}\t${edge.sourcePath}\t${edge.sourceLine}`),
  };
}

export async function auditVersionLock(root: string, lockPath = VERSION_LOCK_PATH, graph?: ArtifactGraph): Promise<VersionLockAuditResult> {
  const index = await buildVersionIndex(root, graph);
  const safeLockPath = normalizeRelativePath(root, lockPath);
  const lock = await readVersionLock(root, safeLockPath);
  const nodeByArtifact = new Map(index.nodes.map((node) => [`${node.type}:${node.id}`, node]));
  const nodeByPath = new Map(index.nodes.map((node) => [node.path, node]));
  const currentEdges = implementationEdges(index);
  const currentEdgeIds = new Set(currentEdges.map((edge) => edge.edgeId));
  const issues: VersionLockIssue[] = [];
  let fresh = 0;

  for (const entry of lock.locks) {
    const artifactNode = nodeByArtifact.get(`${entry.artifact.type}:${entry.artifact.id}`);
    const sourceNode = nodeByPath.get(entry.source.path);
    if (!artifactNode || !sourceNode) {
      issues.push({
        status: 'orphan_lock',
        edgeId: entry.edgeId,
        message: `Lock references missing ${!artifactNode ? 'artifact' : 'source'} node`,
        artifact: entry.artifact,
        source: entry.source,
      });
      continue;
    }

    const entryIssues: VersionLockIssue[] = [];
    if (!currentEdgeIds.has(entry.edgeId)) {
      entryIssues.push({
        status: 'orphan_lock',
        edgeId: entry.edgeId,
        message: `Locked traceability edge no longer exists in the current graph`,
        artifact: entry.artifact,
        source: entry.source,
      });
    }
    if (artifactNode.contentHash !== entry.artifact.contentHash) {
      entryIssues.push({
        status: 'artifact_changed',
        edgeId: entry.edgeId,
        message: `${entry.artifact.type}:${entry.artifact.id} changed since the lock was written`,
        artifact: entry.artifact,
        source: entry.source,
        currentArtifactHash: artifactNode.contentHash,
      });
    }
    if (sourceNode.contentHash !== entry.source.contentHash) {
      entryIssues.push({
        status: 'source_changed',
        edgeId: entry.edgeId,
        message: `${entry.source.path} changed since the lock was written`,
        artifact: entry.artifact,
        source: entry.source,
        currentSourceHash: sourceNode.contentHash,
      });
    }
    for (const verifiedBy of entry.verifiedBy ?? []) {
      const verifierNode = nodeByPath.get(verifiedBy.path);
      if (!verifierNode) {
        entryIssues.push({
          status: 'orphan_lock',
          edgeId: entry.edgeId,
          message: `Verifier ${verifiedBy.path} is missing`,
          artifact: entry.artifact,
          source: entry.source,
          verifiedByPath: verifiedBy.path,
        });
        continue;
      }
      if (verifierNode.contentHash !== verifiedBy.contentHash) {
        entryIssues.push({
          status: 'verified_by_changed',
          edgeId: entry.edgeId,
          message: `Verifier ${verifiedBy.path} changed since the lock was written`,
          artifact: entry.artifact,
          source: entry.source,
          currentVerifiedByHash: verifierNode.contentHash,
          verifiedByPath: verifiedBy.path,
        });
      }
      if (artifactNode && !currentEdges.some((edge) => edge.from === verifierNode.uid && edge.to === artifactNode.uid)) {
        entryIssues.push({
          status: 'orphan_lock',
          edgeId: entry.edgeId,
          message: `Verifier ${verifiedBy.path} no longer declares a traceability link to ${entry.artifact.type}:${entry.artifact.id}`,
          artifact: entry.artifact,
          source: entry.source,
          verifiedByPath: verifiedBy.path,
        });
      }
    }

    if (entryIssues.length === 0) {
      fresh += 1;
    } else {
      issues.push(...entryIssues);
    }
  }

  const reportedMissingLocks = new Set<string>();
  for (const edge of currentEdges) {
    const edgeId = edge.edgeId;
    if (!lock.locks.some((entry) => entry.edgeId === edgeId)) {
      if (reportedMissingLocks.has(edgeId)) {
        continue;
      }
      reportedMissingLocks.add(edgeId);
      const source = index.nodes.find((node) => node.uid === edge.from);
      const artifact = index.nodes.find((node) => node.uid === edge.to);
      issues.push({
        status: 'missing_lock',
        edgeId,
        message: `${edge.from} ${edge.kind} ${edge.to} has no version lock`,
        artifact: artifact ? lockRefFromNode(artifact) : undefined,
        source: source ? sourceRefFromNode(source) : undefined,
      });
    }
  }

  return {
    schemaVersion: '1.0',
    root,
    lockPath: safeLockPath,
    totalLocks: lock.locks.length,
    fresh,
    issues: sortBy(issues, (issue) => `${issue.status}\t${issue.edgeId}\t${issue.verifiedByPath ?? ''}`),
  };
}

export async function updateVersionLock(root: string, options: VersionLockUpdateOptions): Promise<VersionLockFile> {
  const index = await buildVersionIndex(root);
  const currentEdges = implementationEdges(index);
  const targetUid = parseTarget(options.target);
  const sourcePath = normalizeRelativePath(root, options.source);
  const source = index.nodes.find((node) => node.path === sourcePath);
  const artifact = index.nodes.find((node) => node.uid === targetUid);
  if (!artifact) {
    throw new Error(`Target artifact not found: ${options.target}`);
  }
  if (!source) {
    throw new Error(`Source node not found or has no traceability comment: ${sourcePath}`);
  }
  if (source.sourceKind !== 'code' && source.sourceKind !== 'test') {
    throw new Error(`Source must be code or test, got ${source.sourceKind}: ${sourcePath}`);
  }

  const matchingEdge = currentEdges.find((edge) => edge.from === source.uid && edge.to === artifact.uid);
  if (!matchingEdge) {
    throw new Error(`Source ${sourcePath} does not declare a traceability link to ${options.target}`);
  }

  const verifiedBy = (options.verifiedBy ?? []).map((path) => {
    const verifierPath = normalizeRelativePath(root, path);
    const verifier = index.nodes.find((node) => node.path === verifierPath);
    if (!verifier) {
      throw new Error(`Verifier node not found or has no traceability comment: ${verifierPath}`);
    }
    if (verifier.sourceKind !== 'code' && verifier.sourceKind !== 'test') {
      throw new Error(`Verifier must be code or test, got ${verifier.sourceKind}: ${verifierPath}`);
    }
    const verifierEdge = currentEdges.find((edge) => edge.from === verifier.uid && edge.to === artifact.uid);
    if (!verifierEdge) {
      throw new Error(`Verifier ${verifierPath} does not declare a traceability link to ${options.target}`);
    }
    return sourceRefFromNode(verifier);
  });

  const kind = source.sourceKind === 'test' ? 'verifies' : 'implements';
  const entry: VersionLockEntry = {
    edgeId: lockEdgeIdFor(source, artifact, kind),
    kind,
    artifact: lockRefFromNode(artifact),
    source: sourceRefFromNode(source),
    verifiedBy: verifiedBy.length > 0 ? sortBy(verifiedBy, (item) => item.path) : undefined,
  };

  const lockPath = normalizeRelativePath(root, options.lockPath ?? VERSION_LOCK_PATH);
  const lock = await readVersionLock(root, lockPath);
  const filtered = lock.locks.filter((item) => item.edgeId !== entry.edgeId);
  const next = {
    schemaVersion: VERSION_LOCK_SCHEMA_VERSION,
    locks: sortBy([...filtered, entry], (item) => item.edgeId),
  } satisfies VersionLockFile;
  await writeVersionLock(root, lockPath, next);
  return next;
}

export async function bootstrapVersionLock(root: string, options: VersionLockBootstrapOptions = {}): Promise<VersionLockFile> {
  const index = await buildVersionIndex(root);
  const lockPath = normalizeRelativePath(root, options.lockPath ?? VERSION_LOCK_PATH);
  if (!options.force) {
    const existing = await readVersionLock(root, lockPath);
    if (existing.locks.length > 0) {
      throw new Error(`Version lock already contains ${existing.locks.length} locks. Use --force to overwrite.`);
    }
  }

  const nodeByUid = new Map(index.nodes.map((node) => [node.uid, node]));
  const entries = new Map<string, VersionLockEntry>();
  for (const edge of implementationEdges(index)) {
    const source = nodeByUid.get(edge.from);
    const artifact = nodeByUid.get(edge.to);
    if (!source || !artifact) {
      continue;
    }
    const kind = source.sourceKind === 'test' ? 'verifies' : 'implements';
    const edgeId = edge.edgeId;
    if (entries.has(edgeId)) {
      continue;
    }
    entries.set(edgeId, {
      edgeId,
      kind,
      artifact: lockRefFromNode(artifact),
      source: sourceRefFromNode(source),
    });
  }

  const next = {
    schemaVersion: VERSION_LOCK_SCHEMA_VERSION,
    locks: sortBy([...entries.values()], (item) => item.edgeId),
  } satisfies VersionLockFile;
  await writeVersionLock(root, lockPath, next);
  return next;
}

export async function refreshVersionLock(root: string, options: VersionLockRefreshOptions = {}): Promise<VersionLockRefreshResult> {
  const lockPath = normalizeRelativePath(root, options.lockPath ?? VERSION_LOCK_PATH);
  const changedPaths = sortUnique((options.changedPaths ?? []).map((path) => normalizeRelativePath(root, path)));
  const all = options.all === true || options.changedOnly !== true;
  const mode = all ? 'all' : 'changed-only';
  const warnings: string[] = [];

  if (!all && changedPaths.includes('artifact-graph.config.yaml')) {
    throw new Error('Changed-only version-lock refresh includes artifact-graph.config.yaml and requires --all');
  }

  const index = await buildVersionIndex(root);
  const lock = await readVersionLock(root, lockPath);
  const nodeByUid = new Map(index.nodes.map((node) => [node.uid, node]));
  const nodeByPath = new Map(index.nodes.map((node) => [node.path, node]));
  const currentImplementationEdges = implementationEdges(index);
  const currentEdgePairs = new Set(currentImplementationEdges.map((edge) => `${edge.from}\t${edge.to}`));
  const currentEntries = new Map<string, VersionLockEntry>();
  const changedPathSet = new Set(changedPaths);

  const affectedEdges = new Set<string>();
  const addedLocks: string[] = [];
  const updatedLocks: string[] = [];
  const retainedOrphans: string[] = [];
  const removedOrphans: string[] = [];
  const nextLocks = new Map<string, VersionLockEntry>();

  for (const edge of currentImplementationEdges) {
    const source = nodeByUid.get(edge.from);
    const artifact = nodeByUid.get(edge.to);
    if (!source || !artifact || currentEntries.has(edge.edgeId)) {
      continue;
    }
    const existing = lock.locks.find((entry) => entry.edgeId === edge.edgeId);
    currentEntries.set(edge.edgeId, lockEntryFromCurrentEdge(
      edge.edgeId,
      source,
      artifact,
      existing,
      nodeByPath,
      currentEdgePairs,
      options.removeOrphans === true,
      removedOrphans,
    ));
  }

  for (const existing of lock.locks) {
    const current = currentEntries.get(existing.edgeId);
    const affected = all || lockEntryTouchesAnyPath(existing, changedPathSet);
    if (affected) {
      affectedEdges.add(existing.edgeId);
    }

    if (!current) {
      if (affected && options.removeOrphans === true) {
        removedOrphans.push(existing.edgeId);
      } else {
        if (affected) {
          retainedOrphans.push(existing.edgeId);
        }
        nextLocks.set(existing.edgeId, existing);
      }
      continue;
    }

    if (affected || currentEdgeTouchesAnyPath(current, changedPathSet)) {
      affectedEdges.add(existing.edgeId);
      if (stableEntryJson(existing) !== stableEntryJson(current)) {
        updatedLocks.push(existing.edgeId);
      }
      nextLocks.set(existing.edgeId, current);
    } else {
      nextLocks.set(existing.edgeId, existing);
    }
  }

  for (const [edgeId, current] of currentEntries) {
    if (nextLocks.has(edgeId)) {
      continue;
    }
    const affected = all || currentEdgeTouchesAnyPath(current, changedPathSet);
    if (!affected) {
      continue;
    }
    affectedEdges.add(edgeId);
    addedLocks.push(edgeId);
    nextLocks.set(edgeId, current);
  }

  if (mode === 'changed-only' && changedPaths.length === 0) {
    warnings.push('No changed paths were provided; no locks were refreshed.');
  }

  const next = {
    schemaVersion: VERSION_LOCK_SCHEMA_VERSION,
    locks: sortBy([...nextLocks.values()], (item) => item.edgeId),
  } satisfies VersionLockFile;
  await writeVersionLock(root, lockPath, next);
  const postAudit = await auditVersionLock(root, lockPath);

  return {
    schemaVersion: '1.0',
    root,
    lockPath,
    mode,
    changedPaths,
    affectedEdges: sortUnique([...affectedEdges]),
    addedLocks: sortUnique(addedLocks),
    updatedLocks: sortUnique(updatedLocks),
    retainedOrphans: sortUnique(retainedOrphans),
    removedOrphans: sortUnique(removedOrphans),
    postAudit,
    warnings,
  };
}

export async function traceVersion(root: string, target: string, lockPath = VERSION_LOCK_PATH): Promise<TraceVersionResult> {
  const index = await buildVersionIndex(root);
  const safeLockPath = normalizeRelativePath(root, lockPath);
  const audit = await auditVersionLock(root, safeLockPath);
  const targetUid = parseTarget(target);
  const lock = await readVersionLock(root, safeLockPath);
  const targetNode = index.nodes.find((node) => node.uid === targetUid);
  const targetIssues: VersionLockIssue[] = targetNode ? [] : [{
    status: 'target_not_found',
    edgeId: targetUid,
    message: `Target artifact not found: ${target}`,
  }];
  return {
    schemaVersion: '1.0',
    root,
    lockPath: safeLockPath,
    target: {
      uid: targetUid,
      node: targetNode,
    },
    currentEdges: index.edges.filter((edge) => edge.from === targetUid || edge.to === targetUid),
    locks: lock.locks.filter((entry) => `${entry.artifact.type}:${entry.artifact.id}` === targetUid),
    issues: [...targetIssues, ...audit.issues.filter((issue) => (
      `${issue.artifact?.type}:${issue.artifact?.id}` === targetUid
      || issue.edgeId.includes(`#${targetUid}`)
    ))],
  };
}

export function renderVersionLockAuditMarkdown(result: VersionLockAuditResult): string {
  const lines = [
    '# Version Lock Audit',
    '',
    `Root: \`${result.root}\``,
    `Lock: \`${result.lockPath}\``,
    `Locks: ${result.totalLocks} | Fresh: ${result.fresh} | Issues: ${result.issues.length}`,
    '',
  ];
  if (result.issues.length === 0) {
    lines.push('No version lock issues.');
    return `${lines.join('\n')}\n`;
  }
  for (const issue of result.issues) {
    lines.push(`- [${issue.status}] \`${issue.edgeId}\` — ${issue.message}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderVersionLockRefreshMarkdown(result: VersionLockRefreshResult): string {
  const lines = [
    '# Version Lock Refresh',
    '',
    `Root: \`${result.root}\``,
    `Lock: \`${result.lockPath}\``,
    `Mode: \`${result.mode}\``,
    `Changed paths: ${result.changedPaths.length}`,
    `Affected edges: ${result.affectedEdges.length}`,
    `Added: ${result.addedLocks.length} | Updated: ${result.updatedLocks.length} | Retained orphans: ${result.retainedOrphans.length} | Removed orphans: ${result.removedOrphans.length}`,
    `Post-audit issues: ${result.postAudit.issues.length}`,
    '',
  ];

  appendList(lines, 'Added Locks', result.addedLocks);
  appendList(lines, 'Updated Locks', result.updatedLocks);
  appendList(lines, 'Retained Orphans', result.retainedOrphans);
  appendList(lines, 'Removed Orphans', result.removedOrphans);
  appendList(lines, 'Warnings', result.warnings);
  if (result.postAudit.issues.length > 0) {
    lines.push('## Post-Audit Issues');
    for (const issue of result.postAudit.issues) {
      lines.push(`- [${issue.status}] \`${issue.edgeId}\` — ${issue.message}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function renderTraceVersionMarkdown(result: TraceVersionResult): string {
  const lines = [
    '# Trace Version',
    '',
    `Target: \`${result.target.uid}\``,
    result.target.node ? `Current hash: \`${result.target.node.contentHash}\`` : 'Current hash: target not found',
    `Edges: ${result.currentEdges.length} | Locks: ${result.locks.length} | Issues: ${result.issues.length}`,
    '',
  ];
  if (result.locks.length > 0) {
    lines.push('## Locks');
    for (const lock of result.locks) {
      lines.push(`- \`${lock.edgeId}\` source=\`${lock.source.path}\` sourceHash=\`${lock.source.contentHash}\` artifactHash=\`${lock.artifact.contentHash}\``);
    }
    lines.push('');
  }
  if (result.currentEdges.length > 0) {
    lines.push('## Current Edges');
    for (const edge of result.currentEdges) {
      lines.push(`- \`${edge.from}\` ${edge.kind} \`${edge.to}\` fromHash=\`${edge.fromHash ?? 'unknown'}\` toHash=\`${edge.toHash ?? 'unknown'}\``);
    }
    lines.push('');
  }
  if (result.issues.length > 0) {
    lines.push('## Issues');
    for (const issue of result.issues) {
      lines.push(`- [${issue.status}] \`${issue.edgeId}\` — ${issue.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function readVersionLock(root: string, lockPath: string): Promise<VersionLockFile> {
  const safeLockPath = normalizeRelativePath(root, lockPath);
  try {
    const raw = await readFile(join(root, safeLockPath), 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Version lock ${safeLockPath} is not valid JSON: ${(error as Error).message}`);
    }
    return validateVersionLockFile(parsed, safeLockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: VERSION_LOCK_SCHEMA_VERSION, locks: [] };
    }
    throw error;
  }
}

function validateVersionLockFile(value: unknown, lockPath: string): VersionLockFile {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid version lock schema in ${lockPath}: root must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== VERSION_LOCK_SCHEMA_VERSION || !Array.isArray(record.locks)) {
    throw new Error(`Invalid version lock schema in ${lockPath}`);
  }
  const seen = new Set<string>();
  const locks = record.locks.map((entry, index) => validateVersionLockEntry(entry, index, seen));
  return {
    schemaVersion: VERSION_LOCK_SCHEMA_VERSION,
    locks,
  };
}

function validateVersionLockEntry(value: unknown, index: number, seen: Set<string>): VersionLockEntry {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid version lock entry at locks[${index}]: entry must be an object`);
  }
  const entry = value as Record<string, unknown>;
  const edgeId = requireString(entry.edgeId, `locks[${index}].edgeId`);
  if (seen.has(edgeId)) {
    throw new Error(`Invalid version lock entry at locks[${index}]: duplicate edgeId ${edgeId}`);
  }
  seen.add(edgeId);
  const kind = requireString(entry.kind, `locks[${index}].kind`);
  if (kind !== 'implements' && kind !== 'verifies') {
    throw new Error(`Invalid version lock entry at locks[${index}]: kind must be implements or verifies`);
  }
  const artifact = validateVersionLockRef(entry.artifact, `locks[${index}].artifact`);
  const source = validateVersionLockSourceRef(entry.source, `locks[${index}].source`);
  const verifiedBy = entry.verifiedBy === undefined
    ? undefined
    : validateVerifiedBy(entry.verifiedBy, `locks[${index}].verifiedBy`);
  return {
    edgeId,
    kind,
    artifact,
    source,
    verifiedBy,
  };
}

function validateVersionLockRef(value: unknown, path: string): VersionLockRef {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid version lock entry at ${path}: ref must be an object`);
  }
  const record = value as Record<string, unknown>;
  return {
    type: requireString(record.type, `${path}.type`),
    id: requireString(record.id, `${path}.id`),
    path: requireSafeRelativePath(requireString(record.path, `${path}.path`), `${path}.path`),
    contentHash: requireHash(record.contentHash, `${path}.contentHash`),
  };
}

function validateVersionLockSourceRef(value: unknown, path: string): VersionLockSourceRef {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid version lock entry at ${path}: source must be an object`);
  }
  const record = value as Record<string, unknown>;
  const type = requireString(record.type, `${path}.type`);
  if (type !== 'code' && type !== 'test') {
    throw new Error(`Invalid version lock entry at ${path}.type: source type must be code or test`);
  }
  return {
    type,
    path: requireSafeRelativePath(requireString(record.path, `${path}.path`), `${path}.path`),
    contentHash: requireHash(record.contentHash, `${path}.contentHash`),
  };
}

function validateVerifiedBy(value: unknown, path: string): VersionLockSourceRef[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid version lock entry at ${path}: verifiedBy must be an array`);
  }
  return value.map((item, index) => validateVersionLockSourceRef(item, `${path}[${index}]`));
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid version lock entry at ${path}: expected non-empty string`);
  }
  return value;
}

function requireHash(value: unknown, path: string): string {
  const hash = requireString(value, path);
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Invalid version lock entry at ${path}: expected sha256 hash`);
  }
  return hash;
}

function requireSafeRelativePath(value: string, path: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid version lock entry at ${path}: path must stay within root`);
  }
  return normalized;
}

async function writeVersionLock(root: string, lockPath: string, lock: VersionLockFile): Promise<void> {
  const safeLockPath = normalizeRelativePath(root, lockPath);
  const fullPath = join(root, safeLockPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function implementationEdges(index: VersionIndex): Array<VersionedEdge & { edgeId: string }> {
  const nodesByUid = new Map(index.nodes.map((node) => [node.uid, node]));
  return index.edges
    .filter((edge) => {
      const source = nodesByUid.get(edge.from);
      return source?.sourceKind === 'code' || source?.sourceKind === 'test';
    })
    .map((edge) => {
      const source = nodesByUid.get(edge.from)!;
      const artifact = nodesByUid.get(edge.to);
      const kind = source.sourceKind === 'test' ? 'verifies' : 'implements';
      return {
        ...edge,
        kind,
        edgeId: artifact ? lockEdgeIdFor(source, artifact, kind) : `${source.sourceKind}:${source.path}#${kind}#${edge.to}`,
      };
    });
}

function lockRefFromNode(node: VersionedNode): VersionLockRef {
  return {
    type: node.type,
    id: node.id,
    path: node.path,
    contentHash: node.contentHash,
  };
}

function sourceRefFromNode(node: VersionedNode): VersionLockSourceRef {
  return {
    type: node.sourceKind === 'test' ? 'test' : 'code',
    path: node.path,
    contentHash: node.contentHash,
  };
}

function appendList(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) {
    return;
  }
  lines.push(`## ${title}`);
  for (const item of items) {
    lines.push(`- \`${item}\``);
  }
  lines.push('');
}

function lockEntryFromCurrentEdge(
  edgeId: string,
  source: VersionedNode,
  artifact: VersionedNode,
  existing: VersionLockEntry | undefined,
  nodeByPath: Map<string, VersionedNode>,
  currentEdgePairs: Set<string>,
  removeOrphans: boolean,
  removedOrphans: string[],
): VersionLockEntry {
  const verifiedBy = (existing?.verifiedBy ?? []).flatMap((item) => {
    const verifier = nodeByPath.get(item.path);
    if (!verifier || (verifier.sourceKind !== 'code' && verifier.sourceKind !== 'test')) {
      if (removeOrphans) {
        removedOrphans.push(`${edgeId}#verifiedBy:${item.path}`);
        return [];
      }
      return [item];
    }
    if (!currentEdgePairs.has(`${verifier.uid}\t${artifact.uid}`)) {
      if (removeOrphans) {
        removedOrphans.push(`${edgeId}#verifiedBy:${item.path}`);
        return [];
      }
      return [sourceRefFromNode(verifier)];
    }
    return [sourceRefFromNode(verifier)];
  });

  return {
    edgeId,
    kind: source.sourceKind === 'test' ? 'verifies' : 'implements',
    artifact: lockRefFromNode(artifact),
    source: sourceRefFromNode(source),
    verifiedBy: verifiedBy.length > 0 ? sortBy(verifiedBy, (item) => item.path) : undefined,
  };
}

function currentEdgeTouchesAnyPath(entry: VersionLockEntry, paths: Set<string>): boolean {
  return paths.has(entry.artifact.path)
    || paths.has(entry.source.path)
    || (entry.verifiedBy ?? []).some((item) => paths.has(item.path));
}

function lockEntryTouchesAnyPath(entry: VersionLockEntry, paths: Set<string>): boolean {
  return currentEdgeTouchesAnyPath(entry, paths);
}

function stableEntryJson(entry: VersionLockEntry): string {
  return JSON.stringify({
    edgeId: entry.edgeId,
    kind: entry.kind,
    artifact: entry.artifact,
    source: entry.source,
    verifiedBy: entry.verifiedBy ?? [],
  });
}

function normalizeVersionEdgeKind(edge: ArtifactEdge): VersionEdgeKind | string {
  if (edge.source === 'test-comment') {
    return edge.sourcePath.match(/\.(test|spec)\.(ts|tsx|rs)$/) ? 'verifies' : 'implements';
  }
  return edge.kind;
}

function classifyNode(node: ArtifactNode): VersionSourceKind {
  if (node.type === 'test') {
    return node.path.match(/\.(test|spec)\.(ts|tsx|rs)$/) ? 'test' : 'code';
  }
  return 'artifact';
}

function parseTarget(target: string): string {
  const separator = target.indexOf(':');
  if (separator < 1 || separator === target.length - 1) {
    throw new Error(`Invalid target "${target}". Expected type:id`);
  }
  return `${target.slice(0, separator)}:${target.slice(separator + 1)}`;
}

function lockEdgeIdFor(source: VersionedNode, artifact: VersionedNode, kind: string): string {
  return `${source.sourceKind}:${source.path}#${kind}#${artifact.type}:${artifact.id}`;
}

async function hashRelativePath(root: string, path: string, cache: Map<string, string>): Promise<string> {
  const normalized = normalizeRelativePath(root, path);
  const cached = cache.get(normalized);
  if (cached) return cached;
  const content = await readFile(join(root, normalized));
  const hash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  cache.set(normalized, hash);
  return hash;
}

function normalizeRelativePath(root: string, path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const relativePath = normalized.startsWith('/')
    ? relative(root, normalized).replace(/\\/g, '/')
    : normalized.replace(/^\.\//, '');
  if (relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error(`Path is outside root: ${path}`);
  }
  return relativePath;
}

function sortBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  return [...items].sort((left, right) => keyFn(left).localeCompare(keyFn(right)));
}

function sortUnique(items: string[]): string[] {
  return [...new Set(items)].sort((left, right) => left.localeCompare(right));
}
