/**
 * packet-prompt-audit.ts
 *
 * Batch audit of packet-prompt outputs from a targets file or discovery.
 * Each target is processed independently — a single failure does not abort the batch.
 * Generates handoff prompts for each target and validates them via validatePacketPrompt().
 *
 * v1.11: Added --discover, --limit, --summary-detail compact, --summary-only,
 *        countsByType, totalOmitted, schemaVersion '1.1'.
 */
import type {
  ArtifactGraph,
  ContextManifest,
} from './index.js';
import {
  assemblePacket,
  discoverTargets,
  loadConfig,
  resolveArtifactContext,
  scanArtifacts,
} from './index.js';
import { renderPacketPrompt, MIN_PROMPT_CHARS, DEFAULT_MAX_CHARS } from './packet-prompt.js';
import type { PacketPromptError, PacketPromptOptions } from './packet-prompt.js';
import { validatePacketPrompt } from './packet-prompt-validator.js';
import type { PromptValidationIssue } from './packet-prompt-validator.js';
import { parseTargetsFile } from './packet-audit.js';
import type { ParseResult, ParseError } from './packet-audit.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ── Public types ──

export interface PromptAuditTargetEntry {
  type: string;
  id: string;
  ok: boolean;
  length: number;
  outputPath?: string;
  issues: PromptAuditIssue[];
}

export interface PromptAuditIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface PromptAuditCountsByType {
  [type: string]: { total: number; passed: number; failed: number };
}

export interface PromptAuditSummary {
  schemaVersion: '1.0' | '1.1';
  generatedAt: string;
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  countsByType?: PromptAuditCountsByType;
  totalOmitted?: number;
  sourceTargetsPath?: string;
  maxChars: number;
  targets: PromptAuditTargetEntry[];
}

// ── Internal types ──

interface TargetRef {
  type: string;
  id: string;
}

interface PromptAuditOptions {
  root: string;
  outDir?: string;
  format?: 'json' | 'markdown';
  maxChars?: number;
  sourceTargetsPath?: string;
  summaryOnly?: boolean;
  summaryDetail?: 'full' | 'compact';
}

// ── Stable filename for prompt output ──

/**
 * Generate a stable filename for a prompt target.
 * e.g. feature:A1 -> prompt-feature-A1.md
 */
export function promptFilename(target: TargetRef): string {
  return `prompt-${target.type}-${target.id}.md`;
}

// ── Audit a single target ──

async function auditSinglePromptTarget(
  target: TargetRef,
  graph: ArtifactGraph,
  options: PromptAuditOptions,
): Promise<PromptAuditTargetEntry> {
  const entry: PromptAuditTargetEntry = {
    type: target.type,
    id: target.id,
    ok: true,
    length: 0,
    issues: [],
  };

  try {
    const manifest: ContextManifest = resolveArtifactContext(graph, {
      target: { type: target.type, id: target.id },
      mode: 'implementation',
    });

    if (manifest.missing.length > 0) {
      entry.ok = false;
      for (const m of manifest.missing) {
        entry.issues.push({ code: 'MISSING', message: `缺失制品: ${m}`, severity: 'error' });
      }
      return entry;
    }

    const packet = assemblePacket(manifest, { mode: 'implementation' });

    const promptResult = renderPacketPrompt(packet, {
      maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
      root: options.root,
    });

    // Handle structured error from renderPacketPrompt
    if (typeof promptResult === 'object' && 'ok' in promptResult && !promptResult.ok) {
      const e = promptResult as PacketPromptError;
      entry.ok = false;
      entry.issues.push({
        code: 'RENDER',
        message: `${e.reason}。实际长度 ${e.actualLength}，最小需要 ${e.minRequired} 字符`,
        severity: 'error',
      });
      return entry;
    }

    const prompt = promptResult as string;
    entry.length = prompt.length;

    // Validate prompt quality
    const validation = validatePacketPrompt(prompt);
    for (const issue of validation.issues) {
      entry.issues.push({ code: issue.code, message: issue.message, severity: issue.severity });
      if (issue.severity === 'error') {
        entry.ok = false;
      }
    }

    // Write prompt file if outDir specified
    if (options.outDir) {
      const filename = promptFilename(target);
      const outPath = join(options.outDir, filename);
      await writeFile(outPath, prompt, 'utf-8');
      entry.outputPath = outPath;
    }
  } catch (error) {
    entry.ok = false;
    entry.issues.push({
      code: 'INTERNAL',
      message: (error as Error).message,
      severity: 'error',
    });
  }

  return entry;
}

// ── Markdown summary renderer ──

function renderPromptAuditSummaryMarkdown(summary: PromptAuditSummary): string {
  const lines: string[] = [];
  lines.push('# Packet Prompt Audit Summary');
  lines.push('');
  lines.push(`> schemaVersion: ${summary.schemaVersion} | generatedAt: ${summary.generatedAt}`);
  lines.push(`> maxChars: ${summary.maxChars}`);
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---|');
  lines.push(`| 总计 | ${summary.total} |`);
  lines.push(`| 通过 | ${summary.passed} |`);
  lines.push(`| 失败 | ${summary.failed} |`);
  lines.push(`| 警告 | ${summary.warnings} |`);
  if (summary.totalOmitted !== undefined) {
    lines.push(`| 省略 | ${summary.totalOmitted} |`);
  }
  lines.push('');

  // countsByType table
  if (summary.countsByType) {
    lines.push('## 按类型统计');
    lines.push('');
    lines.push('| 类型 | 总计 | 通过 | 失败 |');
    lines.push('|------|------|------|------|');
    for (const [t, c] of Object.entries(summary.countsByType)) {
      lines.push(`| ${t} | ${c.total} | ${c.passed} | ${c.failed} |`);
    }
    lines.push('');
  }

  // compact 模式：只输出 failed targets
  const isCompact = summary.totalOmitted !== undefined && summary.totalOmitted > 0;
  const displayTargets = isCompact
    ? summary.targets.filter((t) => !t.ok)
    : summary.targets;

  lines.push('## Targets');
  lines.push('');
  if (isCompact && displayTargets.length === 0) {
    lines.push('（全部通过，无失败 target）');
  }
  for (const t of displayTargets) {
    const icon = t.ok ? 'PASS' : 'FAIL';
    const issueStr = t.issues.length > 0 ? ` (${t.issues.length} issues)` : '';
    lines.push(`- [${icon}] \`${t.type}:${t.id}\` — length=${t.length}${issueStr}`);
    if (t.outputPath) lines.push(`  -> ${t.outputPath}`);
    for (const issue of t.issues) {
      const sev = issue.severity === 'error' ? 'ERROR' : 'WARN';
      lines.push(`  - [${sev}] ${issue.code}: ${issue.message}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ── Batch audit ──

/**
 * Compute countsByType from audit entries.
 */
function computeCountsByType(entries: PromptAuditTargetEntry[]): PromptAuditCountsByType {
  const result: PromptAuditCountsByType = {};
  for (const e of entries) {
    if (!result[e.type]) {
      result[e.type] = { total: 0, passed: 0, failed: 0 };
    }
    result[e.type].total++;
    if (e.ok) result[e.type].passed++;
    else result[e.type].failed++;
  }
  return result;
}

/**
 * Audit prompts for a list of targets by generating and validating prompts.
 * Each target is processed independently — a single failure does not abort the batch.
 *
 * v1.11: Supports summaryOnly (skip prompt file writes) and summaryDetail (compact omits passed targets).
 */
export async function auditPromptBatch(
  root: string,
  targets: TargetRef[],
  options: PromptAuditOptions,
  graph?: ArtifactGraph,
): Promise<PromptAuditSummary> {
  const resolvedGraph = graph ?? await scanArtifacts(root);

  if (options.outDir) {
    await mkdir(options.outDir, { recursive: true });
  }

  const entries: PromptAuditTargetEntry[] = [];
  for (const target of targets) {
    // summaryOnly: skip file writes by not passing outDir to single-target audit
    const singleOptions = options.summaryOnly ? { ...options, outDir: undefined } : options;
    const entry = await auditSinglePromptTarget(target, resolvedGraph, singleOptions);
    entries.push(entry);
  }

  const passed = entries.filter((e) => e.ok).length;
  const failed = entries.filter((e) => !e.ok).length;
  const warnings = entries.reduce((sum, e) => sum + e.issues.filter((i) => i.severity === 'warning').length, 0);
  const countsByType = computeCountsByType(entries);

  // compact 模式：只保留 failed targets 详情，passed targets 从 targets[] 中省略
  const isCompact = options.summaryDetail === 'compact';
  const summaryTargets = isCompact ? entries.filter((e) => !e.ok) : entries;
  const totalOmitted = isCompact ? entries.filter((e) => e.ok).length : 0;

  const summary: PromptAuditSummary = {
    schemaVersion: '1.1',
    generatedAt: new Date().toISOString(),
    total: entries.length,
    passed,
    failed,
    warnings,
    countsByType,
    totalOmitted,
    sourceTargetsPath: options.sourceTargetsPath,
    maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
    targets: summaryTargets,
  };

  // Write summary files to outDir if specified (not in summaryOnly mode without outDir)
  if (options.outDir) {
    await mkdir(options.outDir, { recursive: true });
    const jsonPath = join(options.outDir, 'prompt-audit-summary.json');
    await writeFile(jsonPath, JSON.stringify(summary, null, 2) + '\n', 'utf-8');

    const mdPath = join(options.outDir, 'prompt-audit-summary.md');
    await writeFile(mdPath, renderPromptAuditSummaryMarkdown(summary), 'utf-8');
  }

  return summary;
}

// ── Discover and audit ──

export interface DiscoverPromptAuditOptions {
  root: string;
  outDir?: string;
  format?: 'json' | 'markdown';
  maxChars?: number;
  limit?: number;
  summaryOnly?: boolean;
  summaryDetail?: 'full' | 'compact';
}

/**
 * Scan artifacts, discover targets, then audit prompts for each.
 * Single scan is reused for both discovery and audit.
 *
 * v1.11: Mirrors discoverAndAuditPackets() pattern from packet-audit.ts.
 */
export async function discoverAndAuditPromptBatch(
  root: string,
  options: DiscoverPromptAuditOptions,
): Promise<PromptAuditSummary> {
  const config = await loadConfig(root);
  const graph = await scanArtifacts(root, config);
  const discovered = discoverTargets(graph, { limit: options.limit, schema: config });
  const targets: TargetRef[] = discovered.map((d) => ({
    type: d.type,
    id: d.id,
  }));
  return auditPromptBatch(root, targets, {
    root,
    outDir: options.outDir,
    format: options.format,
    maxChars: options.maxChars,
    summaryOnly: options.summaryOnly,
    summaryDetail: options.summaryDetail,
  }, graph);
}

// Re-export parseTargetsFile for CLI use
export { parseTargetsFile };
export type { ParseResult, ParseError, TargetRef };
