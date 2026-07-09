/**
 * packet-prompt-validator.ts
 *
 * Lightweight validator for packet-prompt output.
 * Validates that a generated handoff prompt contains all required sections.
 * Used by both CLI validation and evidence generation.
 */

export interface PromptValidationIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface PromptValidationResult {
  ok: boolean;
  issues: PromptValidationIssue[];
}

/**
 * Required section checks — each checks for a pattern in the prompt text.
 * Returns null if found (pass), or an issue if missing.
 */
const REQUIRED_CHECKS: Array<{
  code: string;
  description: string;
  test: (text: string) => boolean;
  severity: 'error' | 'warning';
}> = [
  {
    code: 'PP-001',
    description: '目标信息',
    test: (t) => /实现任务/.test(t),
    severity: 'error',
  },
  {
    code: 'PP-002',
    description: 'packet 命令或来源引用',
    test: (t) => /packet\s+--root/.test(t) || /packet\.json/.test(t) || /artifact-graph\s+packet/.test(t),
    severity: 'error',
  },
  {
    code: 'PP-003',
    description: '验证命令',
    test: (t) => /验证命令/.test(t) || /artifact-graph\s+(build|test)/.test(t),
    severity: 'error',
  },
  {
    code: 'PP-004',
    description: '提交要求',
    test: (t) => /提交要求/.test(t) || /git\s+diff\s+--check/.test(t),
    severity: 'error',
  },
  {
    code: 'PP-005',
    description: '禁止事项',
    test: (t) => /禁止事项/.test(t),
    severity: 'error',
  },
  {
    code: 'PP-006',
    description: '不得回退规则',
    test: (t) => /不得回退/.test(t) || /不要回退/.test(t) || /no[- ]?revert/i.test(t),
    severity: 'error',
  },
  {
    code: 'PP-007',
    description: 'SEC severity 规则',
    test: (t) => /SEC\s+severity/.test(t) || (/severity/.test(t) && /降级/.test(t)),
    severity: 'error',
  },
];

/**
 * Check that the prompt is primarily in Chinese.
 * Extracts text outside code blocks and checks Chinese character ratio.
 * Only a warning — allows technical terms, paths, commands, and API names in English.
 */
function checkChineseDominance(text: string): PromptValidationIssue | null {
  // Remove code blocks
  const textOutsideCode = text.replace(/```[\s\S]*?```/g, '');
  // Remove markdown headers and links (they may contain English artifact names)
  const cleanText = textOutsideCode.replace(/^[#>]+ .*$/gm, '').replace(/\[.*?\]\(.*?\)/g, '');

  const totalChars = cleanText.replace(/\s/g, '').length;
  if (totalChars === 0) return null;

  // Count CJK characters
  const cjkChars = (cleanText.match(/[一-鿿㐀-䶿]/g) || []).length;
  const ratio = cjkChars / totalChars;

  if (ratio < 0.30) {
    return {
      code: 'PP-008',
      message: `中文字符占比 ${(ratio * 100).toFixed(1)}%，低于 30% 要求`,
      severity: 'warning',
    };
  }
  return null;
}

/**
 * Validate a packet-prompt output string.
 *
 * Checks that the prompt contains all required sections:
 * - 目标信息
 * - packet 命令或来源
 * - 验证命令
 * - 提交要求
 * - 禁止事项
 * - 不得回退规则
 * - SEC severity 规则
 * - 中文主导（warning）
 */
export function validatePacketPrompt(prompt: string): PromptValidationResult {
  const issues: PromptValidationIssue[] = [];

  for (const check of REQUIRED_CHECKS) {
    if (!check.test(prompt)) {
      issues.push({
        code: check.code,
        message: `缺少${check.description}`,
        severity: check.severity,
      });
    }
  }

  // Chinese dominance check (warning only)
  const langIssue = checkChineseDominance(prompt);
  if (langIssue) {
    issues.push(langIssue);
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  return { ok: !hasErrors, issues };
}
