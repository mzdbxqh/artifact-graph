/**
 * packet-prompt.ts
 *
 * Generate a compressed Claude Code task prompt from an implementation packet.
 * Output is designed to be directly pasted into Claude Code as a task instruction.
 * Default max 4000 characters; references packet/evidence paths when content exceeds limit.
 * No LLM involvement — pure template rendering.
 */
import type { ImplementationPacket } from './packet-assembler.js';
import type { ContextManifest } from './index.js';
import { assemblePacket } from './packet-assembler.js';
import { BASELINE_CONSTRAINTS, BASELINE_ITEMS_COUNT } from './packet-constants.js';

/** Map target type to CLI flag name (e.g. e2e_test → --e2e-test) */
const TYPE_CLI_FLAG: Record<string, string> = {
  feature: 'feature',
  scenario: 'scenario',
  decision: 'decision',
  design: 'design',
  e2e_test: 'e2e-test',
};

function cliFlag(type: string): string {
  return TYPE_CLI_FLAG[type] ?? type;
}

/** Options for packet-prompt generation */
export interface PacketPromptOptions {
  /** Max character count for the output prompt. Default: 4000 */
  maxChars?: number;
  /** Fixed ISO 8601 timestamp for reproducible output */
  generatedAt?: string;
  /** Root path for resolving file references */
  root?: string;
}

/** Default max character count */
export const DEFAULT_MAX_CHARS = 4000;

/** Minimum prompt size that can still satisfy validatePacketPrompt() for supported target IDs. */
export const MIN_PROMPT_CHARS = 320;

/** Structured error returned when prompt cannot be compressed to the requested maxChars */
export interface PacketPromptError {
  ok: false;
  reason: string;
  actualLength: number;
  minRequired: number;
}

/** Generate the prompt header with target info */
function renderPromptHeader(packet: ImplementationPacket): string[] {
  const t = packet.target;
  const typeLabelMap: Record<string, string> = { feature: '功能', scenario: '场景', decision: '决策', design: '设计规格', e2e_test: 'E2E 测试' };
  const typeLabel = typeLabelMap[t.type] ?? t.type;
  const lines = [
    `# 实现任务：${typeLabel} ${t.id}`,
    '',
    `**目标**: ${packet.implementationBlueprintDraft.objective.description}`,
  ];
  if (t.title) {
    lines.push(`**标题**: ${t.title}`);
  }
  if (t.sourcePath) {
    lines.push(`**源文件**: \`${t.sourcePath}\``);
  }
  if (t.status) {
    lines.push(`**状态**: ${t.status}`);
  }
  lines.push(
    `**上下文完整性**: Missing=${packet.contextManifestSummary.totalMissing} | Omitted=${packet.contextManifestSummary.totalOmitted}`,
    '',
  );
  return lines;
}

/** Generate the recommended reading order section */
function renderReviewOrder(packet: ImplementationPacket): string[] {
  const steps = packet.implementationBlueprintDraft.recommendedReviewOrder;
  if (steps.length === 0) {
    return [];
  }

  const lines: string[] = [
    '## 推荐审阅步骤',
    '',
  ];
  for (const step of steps) {
    lines.push(`${step.step}. **${step.category}**: ${step.reason}`);
  }
  lines.push('');
  return lines;
}

/** Generate the required reading section */
function renderRequiredReading(packet: ImplementationPacket): string[] {
  const lines: string[] = [
    '## 必读制品',
    '',
    `共 ${BASELINE_ITEMS_COUNT} 个 baseline 制品 + 目标直接关联制品。`,
    '执行者必须先阅读所有标记为必读的 baseline 文件，再结合目标源文件和直接关联制品实现；若 Missing 或 Omitted 非零，先停止并说明阻塞。',
    '运行以下命令获取完整上下文：',
    '',
    '```bash',
    `artifact-graph packet --root <root> --${cliFlag(packet.target.type)} ${packet.target.id} --format markdown`,
    '```',
    '',
  ];
  return lines;
}

/** Generate the constraints section */
function renderConstraints(): string[] {
  const lines: string[] = [
    '## 约束与边界',
    '',
  ];
  for (const c of BASELINE_CONSTRAINTS) {
    lines.push(`- **${c.id}**: ${c.description}`);
  }
  lines.push('');
  return lines;
}

/** Generate the validation commands section */
function renderValidationCommands(packet: ImplementationPacket): string[] {
  const lines: string[] = [
    '## 验证命令',
    '',
    '实现完成后必须运行：',
    '',
    '```bash',
  ];
  for (const cmd of packet.validationCommands) {
    lines.push(cmd);
  }
  lines.push('```');
  lines.push('');
  return lines;
}

/** Generate the commit requirements section */
function renderCommitRequirements(): string[] {
  return [
    '## 提交要求',
    '',
    '- 两个 git 仓库分开提交（parent repo 和 heimdall/）',
    '- 不要回退用户已有改动',
    '- commit message 以 `feat/fix/docs` 开头，说明变更原因',
    '- 提交前运行 `git diff --check` 和 `git status --short`',
    '',
  ];
}

/** Generate the forbidden actions section */
function renderForbidden(): string[] {
  return [
    '## 禁止事项',
    '',
    '- 不得引入 PRD 中未出现的新功能',
    '- 不得修改与目标无关的实现代码',
    '- 不得将废弃 Web Dashboard 设计作为实现依据',
    '- SEC severity 不允许降级',
    '- 不得回退用户已有的 dirty work',
    '',
  ];
}

/** Generate the file change boundary section */
function renderChangeBoundary(packet: ImplementationPacket): string[] {
  const lines: string[] = [
    '## 预期修改边界',
    '',
  ];
  // List context categories as hints
  const categories = packet.implementationBlueprintDraft.contextChecklist.categories;
  if (categories.length > 0) {
    for (const cat of categories) {
      if (cat.name === 'baseline') continue; // baseline is read-only
      lines.push(`- **${cat.name}**（${cat.count} 项）`);
    }
  } else {
    lines.push('> 由实现任务根据目标自行确定修改范围。');
  }
  lines.push('');
  return lines;
}

/**
 * Generate a compressed Claude Code task prompt from a packet.
 *
 * Output is ≤ maxChars characters by default.
 * When content would exceed the limit, context details are replaced with
 * references to the packet command.
 * Returns a PacketPromptError object when the prompt cannot be compressed to maxChars.
 */
export function renderPacketPrompt(
  packet: ImplementationPacket,
  options?: PacketPromptOptions,
): string | PacketPromptError {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;

  // Guard: maxChars below minimum usable length
  if (maxChars < MIN_PROMPT_CHARS) {
    return {
      ok: false,
      reason: 'maxChars 低于最小可用提示词长度',
      actualLength: 0,
      minRequired: MIN_PROMPT_CHARS,
    };
  }

  // Build full prompt sections
  const sections: string[] = [];
  sections.push(...renderPromptHeader(packet));
  sections.push(...renderRequiredReading(packet));
  sections.push(...renderReviewOrder(packet));
  sections.push(...renderConstraints());
  sections.push(...renderChangeBoundary(packet));
  sections.push(...renderValidationCommands(packet));
  sections.push(...renderCommitRequirements());
  sections.push(...renderForbidden());

  // Footer
  sections.push('---');
  sections.push('');
  sections.push(`> 由 artifact-graph packet-prompt 自动生成 (${packet.generatedAt})。细节请运行 packet 命令获取完整上下文。`);
  sections.push('');

  const fullText = sections.join('\n');

  // If within limit, return as-is
  if (fullText.length <= maxChars) {
    return fullText;
  }

  // Truncate strategy 1: keep header, required reading, constraints, validation, commit, forbidden
  // Remove change boundary details, compress constraints
  const compactSections: string[] = [];
  compactSections.push(...renderPromptHeader(packet));
  compactSections.push(...renderRequiredReading(packet));
  compactSections.push(...renderReviewOrder(packet));

  // Compact constraints - just list IDs
  compactSections.push('## 约束与边界', '');
  for (const c of BASELINE_CONSTRAINTS) {
    compactSections.push(`- ${c.id}: ${c.description}`);
  }
  compactSections.push('');

  compactSections.push(...renderValidationCommands(packet));
  compactSections.push(...renderCommitRequirements());
  compactSections.push(...renderForbidden());
  compactSections.push('---', '');
  compactSections.push(`> 由 artifact-graph packet-prompt 自动生成。上下文已压缩，请运行 packet 命令获取完整制品清单。`);
  compactSections.push('');

  const compactText = compactSections.join('\n');
  if (compactText.length <= maxChars) {
    return compactText;
  }

  // Truncate strategy 2: minimal — use <root> placeholders for validation commands
  const t = packet.target;
  const typeLabelMapMinimal: Record<string, string> = { feature: '功能', scenario: '场景', decision: '决策', design: '设计规格', e2e_test: 'E2E 测试' };
  const typeLabel = typeLabelMapMinimal[t.type] ?? t.type;
  const minimalSections: string[] = [];
  minimalSections.push(`# 实现任务：${typeLabel} ${t.id}`, '');
  minimalSections.push(`**目标**: ${packet.implementationBlueprintDraft.objective.description}`, '');
  minimalSections.push('## 必读制品', '');
  minimalSections.push('```bash');
  minimalSections.push(`artifact-graph packet --root <root> --${cliFlag(t.type)} ${t.id} --format markdown`);
  minimalSections.push('```', '');
  minimalSections.push('## 验证命令', '');
  minimalSections.push('```bash');
  minimalSections.push('pnpm build && pnpm test');
  minimalSections.push('artifact-graph validate --root <root> --warning-only');
  minimalSections.push('artifact-graph version-lock audit --root <root> --strict-missing-lock');
  minimalSections.push('```', '');
  minimalSections.push('## 提交要求', '');
  minimalSections.push('- 提交前运行 `git diff --check` 和 `git status --short`');
  minimalSections.push('');
  minimalSections.push('## 禁止事项', '');
  minimalSections.push('- 不得引入 PRD 中未出现的新功能');
  minimalSections.push('- SEC severity 不允许降级');
  minimalSections.push('- 不得回退用户已有的 dirty work', '');
  minimalSections.push('---', '');
  minimalSections.push(`> 由 artifact-graph packet-prompt 自动生成 (${packet.generatedAt})。`);
  minimalSections.push('');

  const minimalText = minimalSections.join('\n');
  if (minimalText.length <= maxChars) {
    return minimalText;
  }

  // Truncate strategy 3: absolute minimum
  const absMin: string[] = [];
  absMin.push(`# 实现任务：${typeLabel} ${t.id}`, '');
  absMin.push('## 必读制品');
  absMin.push('```bash');
  absMin.push(`artifact-graph packet --root <root> --${cliFlag(t.type)} ${t.id}`);
  absMin.push('```', '');
  absMin.push('## 验证命令');
  absMin.push('```bash');
  absMin.push('pnpm build && pnpm test');
  absMin.push('artifact-graph validate --root <root> --warning-only');
  absMin.push('git diff --check');
  absMin.push('```', '');
  absMin.push('## 禁止事项');
  absMin.push('- 不得回退用户已有改动');
  absMin.push('- SEC severity 不允许降级');
  absMin.push('');

  const absMinText = absMin.join('\n');
  if (absMinText.length <= maxChars) {
    return absMinText;
  }

  // All truncation strategies exhausted — return structured error
  return {
    ok: false,
    reason: '无法将提示词压缩到指定长度',
    actualLength: absMinText.length,
    minRequired: absMinText.length,
  };
}
