/**
 * packet-assembler.ts
 *
 * Deterministic implementation packet assembly from context manifest.
 * No LLM involvement — pure data transformation.
 */
import type { ContextItem, ContextManifest, ContextMode, MissingDetail } from './index.js';
import { ALWAYS_PRESENT_ITEMS, BASELINE_CONSTRAINTS } from './packet-constants.js';

/** Target information for the packet */
export interface PacketTarget {
  type: string;
  id: string;
  uid: string;
  title?: string;
  sourcePath?: string;
  status?: string;
}

/** Single item in a packet category */
export interface PacketItem {
  path: string;
  reason: string;
  required: boolean;
  tier?: string;
  reasons?: string[];
}

/** Category section in the packet */
export interface PacketCategory {
  category: string;
  total: number;
  items: PacketItem[];
}

/** Omitted item in the packet */
export interface PacketOmittedItem {
  path: string;
  reason: string;
  tier?: string;
}

/** Single step in recommended review order */
export interface ReviewOrderStep {
  step: number;
  category: string;
  reason: string;
}

/** Single item in risk checklist */
export interface RiskChecklistItem {
  id: string;
  description: string;
  checked: boolean;
}

/** Blueprint draft: manifest-derived skeleton for implementation */
export interface ImplementationBlueprintDraft {
  objective: {
    featureId: string | null;
    scenarioId: string | null;
    decisionId: string | null;
    designId: string | null;
    e2eTestId: string | null;
    description: string;
    scope: string;
    nonGoals: string[];
  };
  contextChecklist: {
    categories: { name: string; count: number; paths: string[] }[];
  };
  fileChanges: { path: string; action: string; description: string; source: string }[];
  constraints: { id: string; description: string; source: string }[];
  validationCommands: string[];
  recommendedReviewOrder: ReviewOrderStep[];
  riskChecklist: RiskChecklistItem[];
}

/** AssemblePacket options */
export interface PacketOptions {
  /** Override default validation commands */
  validationCommands?: string[];
  /** Context mode used during resolution */
  mode?: ContextMode;
  /** Max per category used during resolution */
  maxPerCategory?: number;
  /** Fixed ISO 8601 timestamp for reproducible output. If omitted, uses current time. */
  generatedAt?: string;
}

/** Top-level implementation packet */
export interface ImplementationPacket {
  schemaVersion: '1.0';
  generatedAt: string;
  target: PacketTarget;
  contextManifestSummary: {
    totalCategories: number;
    totalItems: number;
    totalOmitted: number;
    totalMissing: number;
    mode: string;
    maxPerCategory: number;
  };
  requiredBaseline: PacketCategory;
  contextByTier: {
    direct: PacketCategory[];
    matrix: PacketCategory[];
    transitive: PacketCategory[];
  };
  omittedItems: PacketOmittedItem[];
  missing: string[];
  missingDetails?: MissingDetail[];
  implementationBlueprintDraft: ImplementationBlueprintDraft;
  validationCommands: string[];
}

/** Well-known baseline constraints derived from baseline artifacts — imported from packet-constants.ts */

/** Default validation commands for this project */
const DEFAULT_VALIDATION_COMMANDS = [
  'pnpm build',
  'pnpm test',
  'artifact-graph validate --root . --warning-only',
  'artifact-graph version-lock audit --root . --strict-missing-lock',
];

/** Convert manifest ContextItem to PacketItem */
function toPacketItem(item: ContextItem): PacketItem {
  const pi: PacketItem = {
    path: item.path,
    reason: item.reason,
    required: item.required ?? false,
  };
  if (item.tier !== undefined) pi.tier = item.tier;
  if (item.reasons !== undefined) pi.reasons = item.reasons;
  return pi;
}

/** Convert manifest ContextItem to PacketOmittedItem */
function toOmittedItem(item: ContextItem): PacketOmittedItem {
  const oi: PacketOmittedItem = {
    path: item.path,
    reason: item.reason,
  };
  if (item.tier !== undefined) oi.tier = item.tier;
  return oi;
}

/** Return fixed baseline constraints (always 7, including C-RULE-01) */
function deriveConstraints(): { id: string; description: string; source: string }[] {
  return [...BASELINE_CONSTRAINTS];
}

// ── Derivation helpers ──

/** Derive objective description based on target type */
function deriveObjectiveDescription(type: string, id: string, title?: string): string {
  const titleSuffix = title ? `：${title}` : '';
  switch (type) {
    case 'feature': return `功能 ${id}${titleSuffix} 的实现与集成`;
    case 'scenario': return `场景 ${id}${titleSuffix} 的验证与测试`;
    case 'decision': return `决策 ${id}${titleSuffix} 的落地与合规检查`;
    case 'design': return `设计规格 ${id}${titleSuffix} 的实现与验证`;
    case 'e2e_test': return `E2E 测试 ${id}${titleSuffix} 的补全与验证`;
    default: return `${type} ${id}${titleSuffix} 实现目标`;
  }
}

/** Derive recommended review order from tier classification */
function deriveRecommendedReviewOrder(hasBaseline: boolean, hasTarget: boolean, hasDirect: boolean, hasMatrix: boolean, hasTransitive: boolean): ReviewOrderStep[] {
  const steps: ReviewOrderStep[] = [];
  let step = 1;
  if (hasBaseline) {
    steps.push({ step: step++, category: 'baseline', reason: '必读基础制品，建立项目规范和约束的基线认知' });
  }
  if (hasTarget) {
    steps.push({ step: step++, category: 'target', reason: '目标本身，理解本次实现要交付的具体内容' });
  }
  if (hasDirect) {
    steps.push({ step: step++, category: 'direct', reason: '直接关联制品，影响实现方案的关键输入' });
  }
  if (hasMatrix) {
    steps.push({ step: step++, category: 'matrix', reason: '矩阵交叉引用，识别跨维度依赖和一致性要求' });
  }
  if (hasTransitive) {
    steps.push({ step: step++, category: 'transitive', reason: '传递关联制品，补充背景知识和领域术语' });
  }
  return steps;
}

/** Derive risk checklist based on manifest content */
function deriveRiskChecklist(
  context: Record<string, ContextItem[]>,
  missingCount: number,
  categories: { name: string; count: number; paths: string[] }[],
): RiskChecklistItem[] {
  const allPaths = Object.values(context).flat().map(i => i.path).join('\n');

  const items: RiskChecklistItem[] = [
    {
      id: 'RISK-001',
      description: '是否触碰 artifacts/ 下的制品文件（场景、PRD、决策、设计规格、实体注册表）',
      checked: allPaths.includes('artifacts/'),
    },
    {
      id: 'RISK-002',
      description: '是否涉及 desktop E2E 链路（React UI -> Tauri IPC -> Node sidecar -> core/engine）',
      checked: categories.some(c => c.name === 'e2e_test'),
    },
    {
      id: 'RISK-003',
      description: '是否修改 Quick Check 规则（确定性 TypeScript 引擎，0 LLM，<30s）',
      checked: allPaths.includes('rules/') || allPaths.includes('rule-'),
    },
    {
      id: 'RISK-004',
      description: '是否影响 security severity（SEC severity 不允许降级）',
      checked: allPaths.includes('security') || allPaths.includes('SEC-'),
    },
    {
      id: 'RISK-005',
      description: '是否引用已废弃的 Web Dashboard 作为实现依据',
      checked: false,
    },
  ];

  // Conditional: e2e_test category present
  if (categories.some(c => c.name === 'e2e_test')) {
    items.push({
      id: 'RISK-006',
      description: '需更新或复跑相关 E2E 测试',
      checked: true,
    });
  }

  // Conditional: missing artifacts
  if (missingCount > 0) {
    items.push({
      id: 'RISK-007',
      description: '追溯缺失需先修复',
      checked: false,
    });
  }

  return items;
}

// ── Rendering helpers ──

/** Count required and optional items in a PacketCategory */
function countRequired(cat: PacketCategory): { required: number; optional: number } {
  let required = 0;
  let optional = 0;
  for (const item of cat.items) {
    if (item.required) required++; else optional++;
  }
  return { required, optional };
}

/** Build a summary line with optional required/optional breakdown */
function categorySummaryLine(cat: PacketCategory): string {
  const { required, optional } = countRequired(cat);
  const total = cat.total;
  if (optional > 0) {
    return `共 ${total} 项（必读: ${required} | 选读: ${optional}）`;
  }
  if (required > 0) {
    return `共 ${total} 项（全部必读）`;
  }
  return `共 ${total} 项`;
}

/** Render a single context item as a markdown list entry */
function renderItem(item: PacketItem): string {
  const req = item.required ? ' [必读]' : '';
  const tier = item.tier ? ` [${item.tier}]` : '';
  return `- \`${item.path}\` —${req} ${item.reason}${tier}`;
}

/** Render all items of a PacketCategory */
function renderItems(items: PacketItem[]): string[] {
  return items.map(renderItem);
}

/** Render a full context category with summary line */
function renderContextCategory(
  cat: PacketCategory,
  opts?: { includeRequiredMark?: boolean },
): string[] {
  const lines: string[] = [];
  lines.push(`### ${cat.category}（${cat.total} 项）`);
  lines.push('');
  lines.push(`> ${categorySummaryLine(cat)}`);
  lines.push('');
  for (const item of cat.items) {
    const req = (opts?.includeRequiredMark && item.required) ? '[必读]' : '';
    const tier = item.tier ? ` [${item.tier}]` : '';
    lines.push(`- \`${item.path}\` — ${req}${item.reason}${tier}`);
  }
  return lines;
}

/** Map of default validation command descriptions */
const COMMAND_COMMENTS: Record<string, string> = {
  'pnpm build': '构建项目',
  'pnpm test': '运行项目测试',
  'artifact-graph validate --root . --warning-only': '制品链一致性校验（warning-only）',
  'artifact-graph version-lock audit --root . --strict-missing-lock': '制品链版本锁严格审计',
};

/** Classify context categories into tiers */
function classifyCategories(manifest: ContextManifest): {
  baseline: PacketCategory;
  direct: PacketCategory[];
  matrix: PacketCategory[];
  transitive: PacketCategory[];
} {
  let baseline: PacketCategory = { category: 'baseline', total: 0, items: [] };
  const direct: PacketCategory[] = [];
  const matrix: PacketCategory[] = [];
  const transitive: PacketCategory[] = [];

  for (const [category, items] of Object.entries(manifest.context)) {
    if (category === 'baseline') {
      baseline = { category, total: items.length, items: items.map(toPacketItem) };
      continue;
    }
    if (category === 'target') {
      // Target goes into its own virtual category under direct
      direct.push({ category, total: items.length, items: items.map(toPacketItem) });
      continue;
    }

    // Classify by predominant tier of items
    const tierCounts = new Map<string, number>();
    for (const item of items) {
      const tier = item.tier ?? 'direct';
      tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
    }
    // Pick the predominant tier
    let predominantTier = 'direct';
    let maxCount = 0;
    for (const [tier, count] of tierCounts) {
      if (count > maxCount) { maxCount = count; predominantTier = tier; }
    }

    const pc: PacketCategory = { category, total: items.length, items: items.map(toPacketItem) };
    if (predominantTier === 'matrix') {
      matrix.push(pc);
    } else if (predominantTier === 'transitive') {
      transitive.push(pc);
    } else {
      direct.push(pc);
    }
  }

  if (baseline.items.length >= ALWAYS_PRESENT_ITEMS.length - 1) {
    const baselineByPath = new Map(baseline.items.map((item) => [item.path, item]));
    const itemsByPath = new Map<string, PacketItem>();
    for (const items of Object.values(manifest.context)) {
      for (const item of items) {
        itemsByPath.set(item.path, toPacketItem(item));
      }
    }
    for (const item of ALWAYS_PRESENT_ITEMS) {
      if (baselineByPath.has(item.path)) continue;
      const existing = itemsByPath.get(item.path);
      if (!existing) continue;
      const baselineItem: PacketItem = { ...existing, reason: item.reason, required: true, tier: 'baseline' };
      baseline.items.push(baselineItem);
      baselineByPath.set(baselineItem.path, baselineItem);
    }
    baseline.total = baseline.items.length;
  }

  return { baseline, direct, matrix, transitive };
}

/**
 * Assemble an implementation packet from a context manifest.
 *
 * This is a pure data transformation. Packet content is derived from the
 * manifest; generatedAt is variable unless a fixed value is supplied.
 * No LLM is involved.
 */
export function assemblePacket(
  manifest: ContextManifest,
  options?: PacketOptions,
): ImplementationPacket {
  const validationCommands = options?.validationCommands ?? DEFAULT_VALIDATION_COMMANDS;
  const mode = options?.mode ?? 'implementation';
  const maxPerCategory = options?.maxPerCategory ?? 20;
  const constraints = deriveConstraints();
  const { baseline, direct, matrix, transitive } = classifyCategories(manifest);

  // Compute summary stats
  let totalItems = 0;
  for (const items of Object.values(manifest.context)) {
    totalItems += items.length;
  }

  // Omitted items
  const omittedItems = (manifest.omitted ?? []).map(toOmittedItem);

  // Build context checklist for blueprint draft
  const categories: { name: string; count: number; paths: string[] }[] = [];
  for (const [category, items] of Object.entries(manifest.context)) {
    categories.push({ name: category, count: items.length, paths: items.map(i => i.path) });
  }

  // Derive new fields
  const recommendedReviewOrder = deriveRecommendedReviewOrder(
    'baseline' in manifest.context,
    'target' in manifest.context,
    direct.length > 0,
    matrix.length > 0,
    transitive.length > 0,
  );
  const riskChecklist = deriveRiskChecklist(manifest.context, manifest.missing.length, categories);

  const blueprintDraft: ImplementationBlueprintDraft = {
    objective: {
      featureId: manifest.target.type === 'feature' ? manifest.target.id : null,
      scenarioId: manifest.target.type === 'scenario' ? manifest.target.id : null,
      decisionId: manifest.target.type === 'decision' ? manifest.target.id : null,
      designId: manifest.target.type === 'design' ? manifest.target.id : null,
      e2eTestId: manifest.target.type === 'e2e_test' ? manifest.target.id : null,
      description: deriveObjectiveDescription(manifest.target.type, manifest.target.id, manifest.target.title),
      scope: '（由实现任务填写）',
      nonGoals: ['不得引入 PRD 中未出现的新功能', '不得修改与目标无关的实现代码'],
    },
    contextChecklist: { categories },
    fileChanges: [],
    constraints,
    validationCommands,
    recommendedReviewOrder,
    riskChecklist,
  };

  const packet: ImplementationPacket = {
    schemaVersion: '1.0',
    generatedAt: options?.generatedAt ?? new Date().toISOString(),
    target: {
      type: manifest.target.type,
      id: manifest.target.id,
      uid: manifest.target.uid,
      title: manifest.target.title,
      sourcePath: manifest.target.sourcePath,
      status: manifest.target.status,
    },
    contextManifestSummary: {
      totalCategories: Object.keys(manifest.context).length,
      totalItems,
      totalOmitted: omittedItems.length,
      totalMissing: manifest.missing.length,
      mode,
      maxPerCategory,
    },
    requiredBaseline: baseline,
    contextByTier: { direct, matrix, transitive },
    omittedItems,
    missing: [...manifest.missing],
    missingDetails: manifest.missingDetails ? [...manifest.missingDetails] : undefined,
    implementationBlueprintDraft: blueprintDraft,
    validationCommands,
  };

  return packet;
}

/**
 * Render an implementation packet as Markdown.
 *
 * Output is designed to be directly usable as a pre-implementation brief
 * for Claude Code or other AI coding agents.
 */
export function renderPacketMarkdown(packet: ImplementationPacket): string {
  const lines: string[] = [];
  const b = packet.implementationBlueprintDraft;
  const s = packet.contextManifestSummary;

  // Header
  lines.push(`# Implementation Packet — ${packet.target.type.toUpperCase()} ${packet.target.id}`);
  lines.push('');
  lines.push(`> schemaVersion: ${packet.schemaVersion} | generatedAt: ${packet.generatedAt}`);
  lines.push(`> mode: ${s.mode} | maxPerCategory: ${s.maxPerCategory}`);
  lines.push('');

  // Target
  lines.push('## 1. 实现目标');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Type | ${packet.target.type} |`);
  lines.push(`| ID | ${packet.target.id} |`);
  lines.push(`| UID | \`${packet.target.uid}\` |`);
  lines.push(`| Description | ${b.objective.description} |`);
  lines.push(`| Scope | ${b.objective.scope} |`);
  lines.push(`| Non-goals | ${b.objective.nonGoals.join('; ')} |`);
  lines.push('');
  lines.push(`> **Context items: ${s.totalItems}** | **Missing: ${s.totalMissing}** | **Omitted: ${s.totalOmitted}**`);
  lines.push('');

  // Context manifest summary
  lines.push('## 2. 上下文清单摘要');
  lines.push('');
  lines.push('| 类别 | 数量 |');
  lines.push('|---|---|');
  lines.push(`| Categories（类别） | ${s.totalCategories} |`);
  lines.push(`| Total items（条目） | ${s.totalItems} |`);
  lines.push(`| Omitted（截断） | ${s.totalOmitted} |`);
  lines.push(`| Missing（缺失） | ${s.totalMissing} |`);
  lines.push('');

  // Execution instructions
  lines.push('> **执行指令：**');
  lines.push('> 1. 先阅读 Required Baseline 中标记 `[必读]` 的制品');
  lines.push('> 2. 若 Missing 非空，先修复追溯再实现');
  lines.push('> 3. 若 Omitted 非空，判断是否需要 `--mode full` 获取完整上下文');
  lines.push('> 4. 修改 artifacts 后必须运行 artifact-graph validate 和 version-lock audit');
  lines.push('');

  // Baseline
  const baselineSummary = categorySummaryLine(packet.requiredBaseline);
  const { required: baselineRequired, optional: baselineOptional } = countRequired(packet.requiredBaseline);
  lines.push('## 3. Required Baseline（必读制品）');
  lines.push('');
  lines.push(`> 必读: ${baselineRequired} 项 | 选读: ${baselineOptional} 项`);
  lines.push('');
  lines.push(baselineSummary);
  lines.push('');
  for (const item of packet.requiredBaseline.items) {
    const req = item.required ? '[必读]' : '[选读]';
    lines.push(`- ${req} \`${item.path}\` — ${item.reason}`);
  }
  lines.push('');

  // Direct context
  if (packet.contextByTier.direct.length > 0) {
    lines.push('## 4. Direct Context（直接关联）');
    lines.push('');
    for (const cat of packet.contextByTier.direct) {
      lines.push(...renderContextCategory(cat, { includeRequiredMark: true }));
      lines.push('');
    }
  }

  // Matrix context
  if (packet.contextByTier.matrix.length > 0) {
    lines.push('## 5. Matrix Context（矩阵关联）');
    lines.push('');
    for (const cat of packet.contextByTier.matrix) {
      lines.push(...renderContextCategory(cat));
      lines.push('');
    }
  }

  // Transitive context
  if (packet.contextByTier.transitive.length > 0) {
    lines.push('## 6. Transitive Context（传递关联）');
    lines.push('');
    for (const cat of packet.contextByTier.transitive) {
      lines.push(...renderContextCategory(cat));
      lines.push('');
    }
  }

  // Omitted
  if (packet.omittedItems.length > 0) {
    lines.push('## 7. Omitted Items（截断条目）');
    lines.push('');
    lines.push(`> 共 ${packet.omittedItems.length} 项被截断。可用 \`--mode full\` 查看完整上下文，或增大 \`--max-per-category\` 上限。`);
    lines.push('');
    for (const item of packet.omittedItems) {
      const tier = item.tier ? ` [${item.tier}]` : '';
      lines.push(`- \`${item.path}\` — ${item.reason}${tier}`);
    }
    lines.push('');
  }

  // Missing
  if (packet.missing.length > 0) {
    lines.push('## ⚠️ Missing Artifacts（缺失制品）');
    lines.push('');
    lines.push(`> 共 ${packet.missing.length} 项缺失。必须先修复追溯再实现。`);
    lines.push('');
    for (const m of packet.missing) {
      lines.push(`- ${m}`);
    }
    lines.push('');
  }

  // Missing details (structured diagnostics)
  if (packet.missingDetails && packet.missingDetails.length > 0) {
    lines.push('### Missing Details（缺失诊断）');
    lines.push('');
    lines.push('| ref | kind | suggestedAction |');
    lines.push('|---|---|---|');
    for (const d of packet.missingDetails) {
      lines.push(`| \`${d.ref}\` | ${d.kind} | ${d.suggestedAction} |`);
    }
    lines.push('');
  }

  // Blueprint draft
  lines.push('## 8. Implementation Blueprint Draft（实现蓝图草案）');
  lines.push('');

  lines.push('### 8.1 上下文清单');
  lines.push('');
  for (const cat of b.contextChecklist.categories) {
    lines.push(`- **${cat.name}**（${cat.count} 项）`);
    for (const p of cat.paths) {
      lines.push(`  - \`${p}\``);
    }
  }
  lines.push('');

  lines.push('### 8.2 文件变更清单');
  lines.push('');
  if (b.fileChanges.length === 0) {
    lines.push('> （空）由实现任务填写。每个变更必须能追溯到上方某个 context 条目。');
  } else {
    lines.push('| File path | Action | Description | Source |');
    lines.push('|---|---|---|---|');
    for (const fc of b.fileChanges) {
      lines.push(`| \`${fc.path}\` | ${fc.action} | ${fc.description} | ${fc.source} |`);
    }
  }
  lines.push('');

  lines.push('### 8.3 约束与边界');
  lines.push('');
  lines.push('| ID | Description | Source |');
  lines.push('|---|---|---|');
  for (const c of b.constraints) {
    lines.push(`| ${c.id} | ${c.description} | \`${c.source}\` |`);
  }
  lines.push('');

  lines.push('### 8.4 验证命令');
  lines.push('');
  lines.push('```bash');
  for (const cmd of b.validationCommands) {
    const comment = COMMAND_COMMENTS[cmd];
    lines.push(comment ? `${cmd} # ${comment}` : cmd);
  }
  lines.push('```');
  lines.push('');

  lines.push('### 8.5 推荐审阅顺序');
  lines.push('');
  lines.push('| 步骤 | 类别 | 理由 |');
  lines.push('|---|---|---|');
  for (const step of b.recommendedReviewOrder) {
    lines.push(`| ${step.step} | ${step.category} | ${step.reason} |`);
  }
  lines.push('');

  lines.push('### 8.6 风险检查清单');
  lines.push('');
  for (const risk of b.riskChecklist) {
    const mark = risk.checked ? '[x]' : '[ ]';
    lines.push(`- ${mark} **${risk.id}**: ${risk.description}`);
  }
  lines.push('');

  // Footer
  lines.push('---');
  lines.push('');
  lines.push('> 本 packet 由 `artifact-graph packet` 命令自动生成。除 `generatedAt` 时间戳外，内容由 manifest 确定；需要完全可复现时可传入固定 `generatedAt`（内部 API）。不涉及 LLM。');
  lines.push('');
  lines.push('> 提示：使用 Ctrl+F 搜索 `[必读]` 快速定位必读制品。');

  return lines.join('\n');
}
