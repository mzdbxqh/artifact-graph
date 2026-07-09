/**
 * packet-audit.ts
 *
 * Batch audit of implementation packets from a targets file.
 * Each target is processed independently — a single failure does not abort the batch.
 */
import type {
  ArtifactGraph,
  ContextManifest,
  ContextMode,
  MissingDetail,
} from './index.js';
import {
  assemblePacket,
  discoverTargets,
  loadConfig,
  renderPacketMarkdown,
  resolveArtifactContext,
  scanArtifacts,
} from './index.js';
import type { DiscoverOptions } from './index.js';
import { VALID_PACKET_TARGET_TYPES, validatePacket } from './packet-validator.js';
import type { PacketValidationIssue } from './packet-validator.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ── Public types ──

export interface PacketAuditEntry {
  type: string;
  id: string;
  status: 'passed' | 'failed' | 'missing';
  outputPath?: string;
  missingCount: number;
  omittedCount: number;
  itemsCount: number;
  baselineCount: number;
  constraintsCount: number;
  errors: string[];
  validationIssues?: PacketValidationIssue[];
  missingDetailsSummary?: { ref: string; kind: string; suggestedAction: string }[];
}

export interface PacketAuditSummary {
  schemaVersion: '1.3';
  total: number;
  passed: number;
  failed: number;
  missing: number;
  totalOmitted: number;
  targets: PacketAuditEntry[];
  generatedAt: string;
  /** Absolute path to the targets file (--targets-file mode only) */
  sourceTargetsPath?: string;
  /** Context mode used for this audit run */
  mode?: ContextMode;
  /** Output format used for this audit run */
  format?: 'json' | 'markdown';
  /** maxPerCategory value used (undefined = default) */
  maxPerCategory?: number;
  /** How packet files were written: 'full' (all), 'summary-only' (none), 'sample' (selected) */
  packetOutputMode?: 'full' | 'summary-only' | 'sample';
  /** Targets for which packet files were written (--sample-targets mode) */
  sampleTargets?: string[];
  /** Paths to sample packet files written */
  sampleOutputPaths?: string[];
  /** Detail level: 'full' includes all targets, 'compact' omits passed targets */
  summaryDetail?: 'full' | 'compact';
  /** Per-type counts (compact mode) */
  countsByType?: Record<string, number>;
}

// ── Internal types ──

interface TargetRef {
  type: string;
  id: string;
}

interface AuditOptions {
  root: string;
  outDir?: string;
  format?: 'json' | 'markdown';
  mode?: ContextMode;
  maxPerCategory?: number;
  /** Absolute path to the targets file (--targets-file mode only) */
  sourceTargetsPath?: string;
  /** If true, do not write individual packet files — only summary */
  summaryOnly?: boolean;
  /** List of target keys (type:id) for which to write packet files */
  sampleTargets?: string[];
  /** Detail level: 'full' includes all targets, 'compact' omits passed targets */
  summaryDetail?: 'full' | 'compact';
}

// ── Parse targets file ──

export interface ParseError {
  line: number;
  raw: string;
  message: string;
}

export interface ParseResult {
  targets: TargetRef[];
  errors: ParseError[];
}

const VALID_TYPES = new Set<string>(VALID_PACKET_TARGET_TYPES);
const VALID_TYPES_LABEL = VALID_PACKET_TARGET_TYPES.join(', ');

/**
 * Parse a targets file where each line is `type:id`.
 * Blank lines and lines starting with `#` are skipped.
 * Returns structured result with valid targets and parse errors.
 */
export function parseTargetsFile(content: string): ParseResult {
  const targets: TargetRef[] = [];
  const errors: ParseError[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) {
      errors.push({ line: i + 1, raw: lines[i], message: `缺少冒号分隔符，期望格式 "type:id"` });
      continue;
    }
    const type = line.slice(0, colonIdx).trim();
    const id = line.slice(colonIdx + 1).trim();
    if (!VALID_TYPES.has(type)) {
      errors.push({ line: i + 1, raw: lines[i], message: `非法类型 "${type}"，允许值: ${VALID_TYPES_LABEL}` });
      continue;
    }
    if (!id) {
      errors.push({ line: i + 1, raw: lines[i], message: `ID 为空，期望格式 "type:id"` });
      continue;
    }
    targets.push({ type: type as TargetRef['type'], id });
  }
  return { targets, errors };
}

// ── Audit a single target ──

async function auditSingleTarget(
  target: TargetRef,
  graph: ArtifactGraph,
  options: AuditOptions,
): Promise<PacketAuditEntry> {
  const entry: PacketAuditEntry = {
    type: target.type,
    id: target.id,
    status: 'passed',
    missingCount: 0,
    omittedCount: 0,
    itemsCount: 0,
    baselineCount: 0,
    constraintsCount: 0,
    errors: [],
  };

  try {
    const contextOpts: Record<string, string | number | undefined> = {
      [target.type]: target.id,
    };
    if (options.mode) contextOpts.mode = options.mode;
    if (options.maxPerCategory !== undefined) contextOpts.maxPerCategory = options.maxPerCategory;

    const manifest: ContextManifest = resolveArtifactContext(graph, {
      feature: target.type === 'feature' ? target.id : undefined,
      scenario: target.type === 'scenario' ? target.id : undefined,
      decision: target.type === 'decision' ? target.id : undefined,
      design: target.type === 'design' ? target.id : undefined,
      e2e_test: target.type === 'e2e_test' ? target.id : undefined,
      mode: options.mode,
      maxPerCategory: options.maxPerCategory,
    });

    const packet = assemblePacket(manifest, {
      mode: options.mode,
      maxPerCategory: options.maxPerCategory,
    });

    entry.missingCount = manifest.missing.length;
    entry.omittedCount = packet.omittedItems.length;
    entry.baselineCount = packet.requiredBaseline.total;
    entry.constraintsCount = packet.implementationBlueprintDraft.constraints.length;

    let totalItems = 0;
    for (const items of Object.values(manifest.context)) {
      totalItems += items.length;
    }
    entry.itemsCount = totalItems;

    // Validate assembled packet
    const validationResult = validatePacket(packet);
    if (validationResult.issues.length > 0) {
      entry.validationIssues = validationResult.issues;
    }
    if (!validationResult.ok) {
      entry.status = 'failed';
      for (const issue of validationResult.issues) {
        if (issue.severity === 'error') {
          entry.errors.push(`validation ${issue.code}: ${issue.message}`);
        }
      }
    }

    if (manifest.missing.length > 0) {
      entry.status = 'failed';
      for (const m of manifest.missing) {
        entry.errors.push(`missing: ${m}`);
      }
      if (manifest.missingDetails && manifest.missingDetails.length > 0) {
        entry.missingDetailsSummary = manifest.missingDetails.map((d) => ({
          ref: d.ref,
          kind: d.kind,
          suggestedAction: d.suggestedAction,
        }));
      }
    }

    // Write packet file if outDir is specified and not summary-only
    if (options.outDir && !options.summaryOnly) {
      const fmt = options.format ?? 'markdown';
      const ext = fmt === 'json' ? 'json' : 'md';
      const filename = `${target.type}-${target.id}.packet.${ext}`;
      const outPath = join(options.outDir, filename);

      let content: string;
      if (fmt === 'json') {
        content = JSON.stringify(packet, null, 2) + '\n';
      } else {
        content = renderPacketMarkdown(packet);
      }
      await writeFile(outPath, content, 'utf-8');
      entry.outputPath = outPath;
    }
  } catch (error) {
    entry.status = 'failed';
    entry.errors.push((error as Error).message);
  }

  return entry;
}

// ── Batch audit ──

/**
 * Audit a list of targets by generating packets for each.
 * Each target is processed independently — a single failure does not abort the batch.
 */
export async function auditPackets(
  root: string,
  targets: TargetRef[],
  options: AuditOptions,
  graph?: ArtifactGraph,
): Promise<PacketAuditSummary> {
  // Reuse provided graph or scan once for the entire batch
  const resolvedGraph = graph ?? await scanArtifacts(root);

  // Validate sampleTargets: all must exist in the target set
  if (options.sampleTargets && options.sampleTargets.length > 0) {
    const targetSet = new Set(targets.map((t) => `${t.type}:${t.id}`));
    const missingSamples = options.sampleTargets.filter((st) => !targetSet.has(st));
    if (missingSamples.length > 0) {
      throw new Error(
        `Sample target(s) not found in audit target set: ${missingSamples.join(', ')}`,
      );
    }
  }

  if (options.outDir) {
    await mkdir(options.outDir, { recursive: true });
  }

  // Determine effective options per target (sample-targets overrides summaryOnly for selected targets)
  const sampleSet = options.sampleTargets ? new Set(options.sampleTargets) : null;
  const sampleOutputPaths: string[] = [];

  const entries: PacketAuditEntry[] = [];
  for (const target of targets) {
    const targetKey = `${target.type}:${target.id}`;
    // For sample mode: enable writing only for matching targets
    const effectiveOptions: AuditOptions = { ...options };
    if (sampleSet) {
      // In sample mode, only write packet files for selected targets
      effectiveOptions.summaryOnly = !sampleSet.has(targetKey);
    }
    const entry = await auditSingleTarget(target, resolvedGraph, effectiveOptions);
    if (entry.outputPath) {
      sampleOutputPaths.push(entry.outputPath);
    }
    entries.push(entry);
  }

  const passed = entries.filter((e) => e.status === 'passed').length;
  const failed = entries.filter((e) => e.status === 'failed').length;
  const missing = entries.filter((e) => e.status === 'missing').length;
  const totalOmitted = entries.reduce((sum, e) => sum + e.omittedCount, 0);

  // Determine packetOutputMode
  let packetOutputMode: 'full' | 'summary-only' | 'sample' = 'full';
  if (options.summaryOnly && !sampleSet) {
    packetOutputMode = 'summary-only';
  } else if (sampleSet) {
    packetOutputMode = 'sample';
  }

  // Compute countsByType (dynamically handles all target types)
  const countsByType: Record<string, number> = {};
  for (const e of entries) {
    countsByType[e.type] = (countsByType[e.type] ?? 0) + 1;
  }

  // In compact mode, only include failed/missing targets
  const isCompact = options.summaryDetail === 'compact';
  const summaryTargets = isCompact
    ? entries.filter((e) => e.status !== 'passed')
    : entries;

  const summary: PacketAuditSummary = {
    schemaVersion: '1.3',
    total: entries.length,
    passed,
    failed,
    missing,
    totalOmitted,
    targets: summaryTargets,
    generatedAt: new Date().toISOString(),
    sourceTargetsPath: options.sourceTargetsPath,
    mode: options.mode,
    format: options.format,
    maxPerCategory: options.maxPerCategory,
    packetOutputMode,
    ...(sampleSet ? { sampleTargets: options.sampleTargets } : {}),
    ...(sampleOutputPaths.length > 0 ? { sampleOutputPaths } : {}),
    ...(isCompact ? { summaryDetail: 'compact', countsByType } : {}),
  };

  // Write summary.json to outDir if specified
  if (options.outDir) {
    const summaryPath = join(options.outDir, 'summary.json');
    await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf-8');
  }

  return summary;
}

// ── Discover and audit ──

interface DiscoverAuditOptions {
  root: string;
  outDir?: string;
  format?: 'json' | 'markdown';
  mode?: ContextMode;
  maxPerCategory?: number;
  limit?: number;
  summaryOnly?: boolean;
  sampleTargets?: string[];
  summaryDetail?: 'full' | 'compact';
}

/**
 * Scan artifacts, discover targets, then audit packets for each.
 * Single scan is reused for both discovery and audit.
 */
export async function discoverAndAuditPackets(
  root: string,
  options: DiscoverAuditOptions,
): Promise<PacketAuditSummary> {
  const config = await loadConfig(root);
  const graph = await scanArtifacts(root, config);
  const discovered = discoverTargets(graph, { limit: options.limit, schema: config });
  const targets: TargetRef[] = discovered.map((d) => ({
    type: d.type,
    id: d.id,
  }));
  return auditPackets(root, targets, {
    root,
    outDir: options.outDir,
    format: options.format,
    mode: options.mode,
    maxPerCategory: options.maxPerCategory,
    summaryOnly: options.summaryOnly,
    sampleTargets: options.sampleTargets,
    summaryDetail: options.summaryDetail,
  }, graph);
}
