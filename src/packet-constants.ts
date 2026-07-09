/**
 * packet-constants.ts
 *
 * Shared constants for packet assembly, validation, and auditing.
 * Extracted here to avoid circular imports between index.ts and packet-validator.ts.
 */

/** Always-present baseline items included in every implementation packet */
export const ALWAYS_PRESENT_ITEMS: { path: string; reason: string }[] = [
  { path: 'AGENTS.md', reason: 'project agent instructions' },
  { path: 'CLAUDE.md', reason: 'project instructions' },
  { path: 'artifacts/artifact-chain-spec.md', reason: 'artifact chain specification' },
  { path: 'artifacts/blueprints/generation-packet-spec.md', reason: 'generation packet spec' },
  { path: 'artifacts/blueprints/implementation-blueprint.md', reason: 'implementation blueprint' },
  { path: 'artifacts/contracts/interface-contracts.md', reason: 'interface contracts' },
  { path: 'artifacts/contracts/data-contracts.md', reason: 'data contracts' },
  { path: 'artifacts/contracts/application-state-machines.md', reason: 'application state machines' },
  { path: 'artifacts/contracts/error-model.md', reason: 'error model' },
  { path: 'artifacts/contracts/report-contracts.md', reason: 'report contracts' },
  { path: 'artifacts/contracts/ui-flow-contracts.md', reason: 'UI flow contracts' },
  { path: 'artifacts/contracts/non-functional-budgets.md', reason: 'non-functional budgets' },
  { path: 'artifacts/domain/domain-glossary.md', reason: 'domain glossary' },
  { path: 'artifacts/domain/bounded-context-map.md', reason: 'bounded context map' },
  { path: 'artifacts/domain/domain-invariants.md', reason: 'domain invariants' },
  { path: 'artifacts/tests/rule-golden-cases.md', reason: 'rule golden cases' },
  { path: 'artifacts/tests/verification-fixtures.md', reason: 'verification fixtures' },
  { path: 'artifacts/design/test-strategy.md', reason: 'test strategy' },
  { path: 'artifacts/traceability-matrix-v2.md', reason: 'traceability matrix' },
];

/** Baseline items count derived from ALWAYS_PRESENT_ITEMS */
export const BASELINE_ITEMS_COUNT = ALWAYS_PRESENT_ITEMS.length;

/** Baseline constraints — well-known constraints derived from baseline artifacts */
export const BASELINE_CONSTRAINTS: { id: string; description: string; source: string }[] = [
  { id: 'C-ARCH-01', description: '技术栈必须为 TypeScript 全栈', source: 'artifacts/decisions/D-ARCH-01.md' },
  { id: 'C-ARCH-03', description: '不可在 Quick Check 路径引入 LLM', source: 'artifacts/decisions/D-ARCH-03.md' },
  { id: 'C-ARCH-05', description: '产品形态为 Tauri v2 桌面应用，不使用已废弃的 Web Dashboard', source: 'artifacts/decisions/D-ARCH-05.md' },
  { id: 'C-RULE-01', description: 'SEC severity 不允许降级', source: 'artifacts/decisions/D-RULE-01.md' },
  { id: 'C-GEN-01', description: '实现蓝图不得引入 PRD 中未出现的新功能', source: 'artifacts/blueprints/implementation-blueprint.md' },
  { id: 'C-GEN-02', description: '文件变更必须先检查 interface-contracts、data-contracts、error-model 是否需要同步', source: 'artifacts/blueprints/implementation-blueprint.md' },
  { id: 'C-GEN-03', description: '不得将废弃 Web Dashboard 设计作为实现依据', source: 'artifacts/blueprints/implementation-blueprint.md' },
];

/** Baseline constraints count derived from BASELINE_CONSTRAINTS */
export const BASELINE_CONSTRAINTS_COUNT = BASELINE_CONSTRAINTS.length;
