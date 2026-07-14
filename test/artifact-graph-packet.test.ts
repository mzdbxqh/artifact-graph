import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import {
  ALWAYS_PRESENT,
  assemblePacket,
  BASELINE_CONSTRAINTS,
  BASELINE_CONSTRAINTS_COUNT,
  BASELINE_ITEMS_COUNT,
  renderPacketMarkdown,
  renderPacketPrompt,
  validatePacket,
  validatePacketMarkdown,
  validatePacketPrompt,
  MIN_PROMPT_CHARS,
} from '../src/index.js';
import type { ContextItem, ContextManifest, ImplementationPacket, PacketPromptError } from '../src/index.js';
import type { PacketValidationIssue, PacketValidationResult } from '../src/packet-validator.js';

// ── Helpers ──

async function write(root: string, path: string, content: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(fullPath.split('/').slice(0, -1).join('/'), { recursive: true });
  await writeFile(fullPath, content);
}

const BASELINE_FILES = [
  { path: 'AGENTS.md', content: '# Agent instructions' },
  { path: 'CLAUDE.md', content: '# Claude instructions' },
  { path: 'artifacts/artifact-chain-spec.md', content: '# Artifact chain spec' },
  { path: 'artifacts/blueprints/generation-packet-spec.md', content: '# Generation packet spec' },
  { path: 'artifacts/blueprints/implementation-blueprint.md', content: '# Implementation blueprint' },
  { path: 'artifacts/contracts/interface-contracts.md', content: '# Interface contracts' },
  { path: 'artifacts/contracts/data-contracts.md', content: '# Data contracts' },
  { path: 'artifacts/contracts/application-state-machines.md', content: '# State machines' },
  { path: 'artifacts/contracts/error-model.md', content: '# Error model' },
  { path: 'artifacts/contracts/report-contracts.md', content: '# Report contracts' },
  { path: 'artifacts/contracts/ui-flow-contracts.md', content: '# UI flow contracts' },
  { path: 'artifacts/contracts/non-functional-budgets.md', content: '# Non-functional budgets' },
  { path: 'artifacts/domain/domain-glossary.md', content: '# Domain glossary' },
  { path: 'artifacts/domain/bounded-context-map.md', content: '# Bounded context map' },
  { path: 'artifacts/domain/domain-invariants.md', content: '# Domain invariants' },
  { path: 'artifacts/tests/rule-golden-cases.md', content: '# Rule golden cases' },
  { path: 'artifacts/tests/verification-fixtures.md', content: '# Verification fixtures' },
  { path: 'artifacts/design/test-strategy.md', content: '# Test strategy' },
  { path: 'artifacts/traceability-matrix-v2.md', content: '# Traceability matrix' },
];

async function packetRepo(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-packet-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });

  // Config
  await write(root, 'artifact-graph.config.yaml', `idRanges:\n  scenario:\n    batch-49:\n      prefix: S-\n      start: 1200\n      end: 1299\n`);

  // Baseline files
  for (const bf of BASELINE_FILES) {
    await write(root, bf.path, bf.content);
  }

  // Feature
  await write(root, 'artifacts/prd/features/A1-skill-import.md', `---
id: A1
title: Skill import/register
status: done
scenarios: [S-01]
design_docs: [design-skill-import]
---
# A1: Skill import/register
`);

  // Design
  await write(root, 'artifacts/design/design-skill-import.md', `---
title: Skill import design
related_features: [A1]
---
# Skill import design
`);

  // Scenario
  await write(root, 'artifacts/scenarios/batch-1.md', `## S-01: Import local skill

**关联功能**: A1 (Skill import/register)
`);

  // Decision
  await write(root, 'artifacts/decisions/D-ARCH-01.md', `---
id: D-ARCH-01
title: TypeScript full stack
status: approved
---
# D-ARCH-01: TypeScript full stack
`);

  return root;
}

function captureIo() {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  return {
    stdout: (chunk: string) => stdoutChunks.push(chunk),
    stderr: (chunk: string) => stderrChunks.push(chunk),
    get stdoutText() { return stdoutChunks.join(''); },
    get stderrText() { return stderrChunks.join(''); },
  };
}

// ── Unit tests: assemblePacket ──

describe('assemblePacket', () => {
  const mockManifest: ContextManifest = {
    schemaVersion: '1.0',
    target: { type: 'feature', id: 'A1', uid: 'feature:A1' },
    context: {
      baseline: [
        { path: 'AGENTS.md', reason: 'project agent instructions', required: true, tier: 'baseline' },
        { path: 'CLAUDE.md', reason: 'project instructions', required: true, tier: 'baseline' },
      ],
      target: [
        { path: 'artifacts/prd/features/A1-skill-import.md', reason: 'feature:A1', required: true, tier: 'target' },
      ],
      prd: [
        { path: 'artifacts/prd/features/A2.md', reason: 'references → feature:A2', tier: 'direct' },
      ],
      scenario: [
        { path: 'artifacts/scenarios/batch-1.md', reason: 'covers ← scenario:S-01', tier: 'direct' },
      ],
    },
    missing: [],
    omitted: [],
  };

  it('should include schemaVersion 1.0', () => {
    const packet = assemblePacket(mockManifest);
    expect(packet.schemaVersion).toBe('1.0');
  });

  it('should include all baseline items', () => {
    const packet = assemblePacket(mockManifest);
    expect(packet.requiredBaseline.total).toBe(2);
    expect(packet.requiredBaseline.items).toHaveLength(2);
    expect(packet.requiredBaseline.items[0].path).toBe('AGENTS.md');
    expect(packet.requiredBaseline.items[0].required).toBe(true);
  });

  it('should populate target from manifest', () => {
    const packet = assemblePacket(mockManifest);
    expect(packet.target.type).toBe('feature');
    expect(packet.target.id).toBe('A1');
    expect(packet.target.uid).toBe('feature:A1');
  });

  it('should include contextManifestSummary with correct stats', () => {
    const packet = assemblePacket(mockManifest);
    expect(packet.contextManifestSummary.totalCategories).toBe(4);
    expect(packet.contextManifestSummary.totalItems).toBe(5);
    expect(packet.contextManifestSummary.totalOmitted).toBe(0);
    expect(packet.contextManifestSummary.totalMissing).toBe(0);
    expect(packet.contextManifestSummary.mode).toBe('implementation');
    expect(packet.contextManifestSummary.maxPerCategory).toBe(20);
  });

  it('should pass mode and maxPerCategory from options', () => {
    const packet = assemblePacket(mockManifest, { mode: 'full', maxPerCategory: 5 });
    expect(packet.contextManifestSummary.mode).toBe('full');
    expect(packet.contextManifestSummary.maxPerCategory).toBe(5);
  });

  it('should classify categories into tiers correctly', () => {
    const packet = assemblePacket(mockManifest);
    // baseline is separate
    expect(packet.requiredBaseline.category).toBe('baseline');
    // target and other direct items go into contextByTier.direct
    const directCategories = packet.contextByTier.direct.map(c => c.category);
    expect(directCategories).toContain('target');
    expect(directCategories).toContain('prd');
    expect(directCategories).toContain('scenario');
    expect(packet.contextByTier.matrix).toHaveLength(0);
    expect(packet.contextByTier.transitive).toHaveLength(0);
  });

  it('should populate missing from manifest', () => {
    const manifestWithMissing: ContextManifest = {
      ...mockManifest,
      missing: ['Unresolved reference from feature:A1: feature:MISSING'],
    };
    const packet = assemblePacket(manifestWithMissing);
    expect(packet.missing).toHaveLength(1);
    expect(packet.missing[0]).toContain('MISSING');
  });

  it('should propagate missingDetails from manifest', () => {
    const manifestWithDetails: ContextManifest = {
      ...mockManifest,
      missing: ['Unresolved reference from feature:A1: feature:MISSING'],
      missingDetails: [{
        ref: 'feature:MISSING',
        from: 'feature:A1',
        kind: 'unresolved-outgoing',
        message: 'Unresolved reference from feature:A1: feature:MISSING',
        suggestedAction: '添加引用或删除悬挂引用',
      }],
    };
    const packet = assemblePacket(manifestWithDetails);
    expect(packet.missingDetails).toBeDefined();
    expect(packet.missingDetails).toHaveLength(1);
    expect(packet.missingDetails![0].ref).toBe('feature:MISSING');
    expect(packet.missingDetails![0].kind).toBe('unresolved-outgoing');
    expect(packet.missingDetails![0].suggestedAction).toBe('添加引用或删除悬挂引用');
  });

  it('should have undefined missingDetails when manifest has none', () => {
    const packet = assemblePacket(mockManifest);
    expect(packet.missingDetails).toBeUndefined();
  });

  it('should populate omittedItems from manifest', () => {
    const manifestWithOmitted: ContextManifest = {
      ...mockManifest,
      omitted: [
        { path: 'artifacts/prd/features/A99.md', reason: 'overflow', tier: 'direct' },
      ],
    };
    const packet = assemblePacket(manifestWithOmitted);
    expect(packet.omittedItems).toHaveLength(1);
    expect(packet.omittedItems[0].path).toBe('artifacts/prd/features/A99.md');
  });

  it('should include blueprint draft with objective, contextChecklist, constraints, validationCommands', () => {
    const packet = assemblePacket(mockManifest);
    const b = packet.implementationBlueprintDraft;

    expect(b.objective.featureId).toBe('A1');
    expect(b.objective.scenarioId).toBeNull();
    expect(b.objective.decisionId).toBeNull();
    expect(b.objective.description).toContain('功能 A1');
    expect(b.objective.nonGoals).toContain('不得引入 PRD 中未出现的新功能');

    expect(b.contextChecklist.categories.length).toBeGreaterThan(0);
    expect(b.fileChanges).toHaveLength(0); // empty by default
    expect(b.constraints.length).toBeGreaterThan(0);
    expect(b.validationCommands.length).toBeGreaterThan(0);
  });

  it('should always include C-RULE-01 and total 7 baseline constraints', () => {
    const packet = assemblePacket(mockManifest);
    const secConstraint = packet.implementationBlueprintDraft.constraints.find(c => c.id === 'C-RULE-01');
    expect(secConstraint).toBeDefined();
    expect(secConstraint!.description).toBe('SEC severity 不允许降级');
    expect(packet.implementationBlueprintDraft.constraints).toHaveLength(7);
  });

  it('should include C-RULE-01 even with security paths present', () => {
    const manifestWithSec: ContextManifest = {
      ...mockManifest,
      context: {
        ...mockManifest.context,
        security: [
          { path: 'artifacts/design/security-rules.md', reason: 'security', tier: 'direct' },
        ],
      },
    };
    const packet = assemblePacket(manifestWithSec);
    const secConstraint = packet.implementationBlueprintDraft.constraints.find(c => c.id === 'C-RULE-01');
    expect(secConstraint).toBeDefined();
    expect(packet.implementationBlueprintDraft.constraints).toHaveLength(7);
  });

  it('should include default validation commands', () => {
    const packet = assemblePacket(mockManifest);
    expect(packet.validationCommands).toContain('pnpm build');
    expect(packet.validationCommands).toContain('pnpm test');
  });

  it('should include recommendedReviewOrder with 5 steps for full manifest', () => {
    const fullManifest: ContextManifest = {
      ...mockManifest,
      context: {
        ...mockManifest.context,
        entity: [
          { path: 'artifacts/entities/entity-registry.md', reason: 'entity', tier: 'matrix' },
        ],
        domain: [
          { path: 'artifacts/domain/domain-glossary.md', reason: 'domain', tier: 'transitive' },
        ],
      },
    };
    const packet = assemblePacket(fullManifest);
    const order = packet.implementationBlueprintDraft.recommendedReviewOrder;
    expect(order).toHaveLength(5);
    expect(order[0]).toEqual({ step: 1, category: 'baseline', reason: expect.stringContaining('必读基础') });
    expect(order[1]).toEqual({ step: 2, category: 'target', reason: expect.stringContaining('目标本身') });
    expect(order[2]).toEqual({ step: 3, category: 'direct', reason: expect.stringContaining('直接关联') });
    expect(order[3]).toEqual({ step: 4, category: 'matrix', reason: expect.stringContaining('矩阵交叉') });
    expect(order[4]).toEqual({ step: 5, category: 'transitive', reason: expect.stringContaining('传递关联') });
  });

  it('should include recommendedReviewOrder with only baseline when minimal manifest', () => {
    const minimalManifest: ContextManifest = {
      schemaVersion: '1.0',
      target: { type: 'feature', id: 'A1', uid: 'feature:A1' },
      context: {
        baseline: [
          { path: 'AGENTS.md', reason: 'agent instructions', required: true, tier: 'baseline' },
        ],
      },
      missing: [],
      omitted: [],
    };
    const packet = assemblePacket(minimalManifest);
    const order = packet.implementationBlueprintDraft.recommendedReviewOrder;
    expect(order).toHaveLength(1);
    expect(order[0].category).toBe('baseline');
  });

  it('should include riskChecklist with fixed items', () => {
    const packet = assemblePacket(mockManifest);
    const risks = packet.implementationBlueprintDraft.riskChecklist;
    expect(risks.length).toBeGreaterThanOrEqual(5);
    const ids = risks.map(r => r.id);
    expect(ids).toContain('RISK-001');
    expect(ids).toContain('RISK-002');
    expect(ids).toContain('RISK-003');
    expect(ids).toContain('RISK-004');
    expect(ids).toContain('RISK-005');
  });

  it('should add RISK-006 when e2e_test category is present', () => {
    const manifestWithE2e: ContextManifest = {
      ...mockManifest,
      context: {
        ...mockManifest.context,
        e2e_test: [
          { path: 'tests/e2e/skill-import.spec.ts', reason: 'e2e test', tier: 'direct' },
        ],
      },
    };
    const packet = assemblePacket(manifestWithE2e);
    const risks = packet.implementationBlueprintDraft.riskChecklist;
    const risk006 = risks.find(r => r.id === 'RISK-006');
    expect(risk006).toBeDefined();
    expect(risk006!.description).toContain('E2E 测试');
  });

  it('should add RISK-007 when missing > 0', () => {
    const manifestWithMissing: ContextManifest = {
      ...mockManifest,
      missing: ['Unresolved reference'],
    };
    const packet = assemblePacket(manifestWithMissing);
    const risks = packet.implementationBlueprintDraft.riskChecklist;
    const risk007 = risks.find(r => r.id === 'RISK-007');
    expect(risk007).toBeDefined();
    expect(risk007!.description).toContain('追溯缺失');
  });

  it('should differentiate objective.description by target type', () => {
    const scenarioManifest: ContextManifest = {
      ...mockManifest,
      target: { type: 'scenario', id: 'S-01', uid: 'scenario:S-01' },
    };
    const decisionManifest: ContextManifest = {
      ...mockManifest,
      target: { type: 'decision', id: 'D-ARCH-01', uid: 'decision:D-ARCH-01' },
    };
    const featurePacket = assemblePacket(mockManifest);
    const scenarioPacket = assemblePacket(scenarioManifest);
    const decisionPacket = assemblePacket(decisionManifest);

    expect(featurePacket.implementationBlueprintDraft.objective.description).toBe('功能 A1 的实现与集成');
    expect(scenarioPacket.implementationBlueprintDraft.objective.description).toBe('场景 S-01 的验证与测试');
    expect(decisionPacket.implementationBlueprintDraft.objective.description).toBe('决策 D-ARCH-01 的落地与合规检查');
  });

  it('should produce correct objective for design target type', () => {
    const designManifest: ContextManifest = {
      ...mockManifest,
      target: { type: 'design', id: 'design-skill-import', uid: 'design:design-skill-import' },
    };
    const packet = assemblePacket(designManifest);
    const obj = packet.implementationBlueprintDraft.objective;
    expect(obj.featureId).toBeNull();
    expect(obj.scenarioId).toBeNull();
    expect(obj.decisionId).toBeNull();
    expect(obj.designId).toBe('design-skill-import');
    expect(obj.e2eTestId).toBeNull();
    expect(obj.description).toBe('设计规格 design-skill-import 的实现与验证');
  });

  it('should produce correct objective for e2e_test target type', () => {
    const e2eManifest: ContextManifest = {
      ...mockManifest,
      target: { type: 'e2e_test', id: 'test-01:TC-001', uid: 'e2e_test:test-01:TC-001' },
    };
    const packet = assemblePacket(e2eManifest);
    const obj = packet.implementationBlueprintDraft.objective;
    expect(obj.featureId).toBeNull();
    expect(obj.scenarioId).toBeNull();
    expect(obj.decisionId).toBeNull();
    expect(obj.designId).toBeNull();
    expect(obj.e2eTestId).toBe('test-01:TC-001');
    expect(obj.description).toBe('E2E 测试 test-01:TC-001 的补全与验证');
  });

  it('should use custom validation commands when provided', () => {
    const custom = ['echo "custom test"'];
    const packet = assemblePacket(mockManifest, { validationCommands: custom });
    expect(packet.validationCommands).toEqual(custom);
  });

  it('should derive stable content fields from the same manifest', () => {
    const p1 = assemblePacket(mockManifest);
    const p2 = assemblePacket(mockManifest);
    expect(p1.contextManifestSummary).toEqual(p2.contextManifestSummary);
    expect(p1.requiredBaseline).toEqual(p2.requiredBaseline);
    expect(p1.contextByTier).toEqual(p2.contextByTier);
    expect(p1.implementationBlueprintDraft.objective).toEqual(p2.implementationBlueprintDraft.objective);
    expect(p1.implementationBlueprintDraft.constraints).toEqual(p2.implementationBlueprintDraft.constraints);
    expect(p1.implementationBlueprintDraft.recommendedReviewOrder).toEqual(p2.implementationBlueprintDraft.recommendedReviewOrder);
    expect(p1.implementationBlueprintDraft.riskChecklist).toEqual(p2.implementationBlueprintDraft.riskChecklist);
  });

  it('should produce fully equal packets when generatedAt is fixed', () => {
    const fixedTs = '2026-01-15T10:30:00.000Z';
    const p1 = assemblePacket(mockManifest, { generatedAt: fixedTs });
    const p2 = assemblePacket(mockManifest, { generatedAt: fixedTs });
    expect(p1).toEqual(p2);
    expect(p1.generatedAt).toBe(fixedTs);
  });
});

// ── Unit tests: renderPacketMarkdown ──

describe('renderPacketMarkdown', () => {
  const mockManifest: ContextManifest = {
    schemaVersion: '1.0',
    target: { type: 'feature', id: 'A1', uid: 'feature:A1' },
    context: {
      baseline: [
        { path: 'AGENTS.md', reason: 'project agent instructions', required: true, tier: 'baseline' },
      ],
      target: [
        { path: 'artifacts/prd/features/A1.md', reason: 'feature:A1', required: true, tier: 'target' },
      ],
    },
    missing: [],
    omitted: [],
  };

  it('should render header with target info', () => {
    const packet = assemblePacket(mockManifest);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('# Implementation Packet — FEATURE A1');
    expect(md).toContain('schemaVersion: 1.0');
  });

  it('should render prominent summary line with context stats', () => {
    const packet = assemblePacket(mockManifest);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('**Context items: 2**');
    expect(md).toContain('**Missing: 0**');
    expect(md).toContain('**Omitted: 0**');
  });

  it('should render all sections', () => {
    const packet = assemblePacket(mockManifest);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('## 1. 实现目标');
    expect(md).toContain('## 2. 上下文清单摘要');
    expect(md).toContain('## 3. Required Baseline');
    expect(md).toContain('## 8. Implementation Blueprint Draft');
    expect(md).toContain('### 8.1 上下文清单');
    expect(md).toContain('### 8.2 文件变更清单');
    expect(md).toContain('### 8.3 约束与边界');
    expect(md).toContain('### 8.4 验证命令');
    expect(md).toContain('### 8.5 推荐审阅顺序');
    expect(md).toContain('### 8.6 风险检查清单');
  });

  it('should render execution instructions section', () => {
    const packet = assemblePacket(mockManifest);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('执行指令');
    expect(md).toContain('先阅读 Required Baseline');
    expect(md).toContain('若 Missing 非空，先修复追溯再实现');
    expect(md).toContain('--mode full');
    expect(md).toContain('artifact-graph validate 和 version-lock audit');
  });

  it('should render baseline grading summary', () => {
    const packet = assemblePacket(mockManifest);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('必读: 1 项 | 选读: 0 项');
  });

  it('should render missing section when present', () => {
    const manifestWithMissing: ContextManifest = {
      ...mockManifest,
      missing: ['Unresolved reference'],
    };
    const packet = assemblePacket(manifestWithMissing);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('## ⚠️ Missing Artifacts');
    expect(md).toContain('Unresolved reference');
  });

  it('should render missingDetails table when present', () => {
    const manifestWithDetails: ContextManifest = {
      ...mockManifest,
      missing: ['Unresolved reference from feature:A1: feature:MISSING'],
      missingDetails: [{
        ref: 'feature:MISSING',
        from: 'feature:A1',
        kind: 'unresolved-outgoing',
        message: 'Unresolved reference from feature:A1: feature:MISSING',
        suggestedAction: '添加引用或删除悬挂引用',
      }],
    };
    const packet = assemblePacket(manifestWithDetails);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('### Missing Details（缺失诊断）');
    expect(md).toContain('| ref | kind | suggestedAction |');
    expect(md).toContain('unresolved-outgoing');
    expect(md).toContain('添加引用或删除悬挂引用');
    expect(md).toContain('feature:MISSING');
  });

  it('should not render missingDetails table when absent', () => {
    const manifestWithMissing: ContextManifest = {
      ...mockManifest,
      missing: ['Unresolved reference'],
    };
    const packet = assemblePacket(manifestWithMissing);
    const md = renderPacketMarkdown(packet);
    expect(md).not.toContain('Missing Details');
  });

  it('should render omitted section when present', () => {
    const manifestWithOmitted: ContextManifest = {
      ...mockManifest,
      omitted: [
        { path: 'artifacts/prd/features/A99.md', reason: 'overflow', tier: 'direct' },
      ],
    };
    const packet = assemblePacket(manifestWithOmitted);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('## 7. Omitted Items');
    expect(md).toContain('A99.md');
  });

  it('should hint --mode full and not --max-per-category 0 for omitted items', () => {
    const manifestWithOmitted: ContextManifest = {
      ...mockManifest,
      omitted: [
        { path: 'artifacts/prd/features/A99.md', reason: 'overflow', tier: 'direct' },
        { path: 'artifacts/prd/features/A98.md', reason: 'overflow', tier: 'direct' },
      ],
    };
    const packet = assemblePacket(manifestWithOmitted);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('--mode full');
    expect(md).not.toContain('--max-per-category 0');
  });

  it('should render footer with determinism note', () => {
    const packet = assemblePacket(mockManifest);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('artifact-graph packet');
    expect(md).toContain('不涉及 LLM');
    expect(md).toContain('generatedAt');
  });

  it('should render footer search hint', () => {
    const packet = assemblePacket(mockManifest);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('Ctrl+F 搜索 `[必读]`');
  });

  it('should render validation command comments', () => {
    const packet = assemblePacket(mockManifest);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('# 构建项目');
    expect(md).toContain('# 运行项目测试');
    expect(md).toContain('# 制品链一致性校验');
    expect(md).toContain('# 制品链版本锁严格审计');
  });

  it('should render recommendedReviewOrder section', () => {
    const packet = assemblePacket(mockManifest);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('### 8.5 推荐审阅顺序');
    expect(md).toContain('| 步骤 | 类别 | 理由 |');
    expect(md).toContain('| 1 | baseline |');
    expect(md).toContain('| 2 | target |');
  });

  it('should render riskChecklist section', () => {
    const packet = assemblePacket(mockManifest);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('### 8.6 风险检查清单');
    expect(md).toContain('RISK-001');
    expect(md).toContain('RISK-005');
  });

  it('should render riskChecklist with checkboxes', () => {
    const packet = assemblePacket(mockManifest);
    const md = renderPacketMarkdown(packet);
    // Should contain both checked and unchecked items
    expect(md).toMatch(/\[x\].*RISK-/);
    expect(md).toMatch(/\[ \].*RISK-/);
  });

  it('should render differentiated objective.description for feature', () => {
    const packet = assemblePacket(mockManifest);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('功能 A1 的实现与集成');
  });
});

// ── T04 Markdown Quality: context group summary & baseline completeness ──

describe('renderPacketMarkdown: T04 quality additions', () => {
  /** Rich manifest with all 19 baseline items and multiple tier categories */
  const richBaseline: ContextItem[] = ALWAYS_PRESENT.map((ap) => ({
    path: ap.path,
    reason: ap.reason,
    required: true,
    tier: 'baseline' as const,
  }));

  const richManifest: ContextManifest = {
    schemaVersion: '1.0',
    target: { type: 'feature', id: 'A1', uid: 'feature:A1' },
    context: {
      baseline: richBaseline,
      target: [
        { path: 'artifacts/prd/features/A1-skill-import.md', reason: 'feature:A1', required: true, tier: 'target' },
      ],
      prd: [
        { path: 'artifacts/prd/features/A2.md', reason: 'references feature:A2', tier: 'direct' },
      ],
      scenario: [
        { path: 'artifacts/scenarios/batch-1.md', reason: 'covers scenario:S-01', tier: 'direct' },
        { path: 'artifacts/scenarios/batch-2.md', reason: 'covers scenario:S-02', tier: 'direct' },
      ],
      design: [
        { path: 'artifacts/design/design-skill-import.md', reason: 'design for feature:A1', tier: 'direct' },
      ],
      decision: [
        { path: 'artifacts/decisions/D-ARCH-01.md', reason: 'decision D-ARCH-01', tier: 'direct' },
      ],
      security: [
        { path: 'artifacts/design/security-rules.md', reason: 'security rules', tier: 'direct' },
      ],
      entity: [
        { path: 'artifacts/entities/entity-registry.md', reason: 'entity registry', tier: 'matrix' },
      ],
      contracts: [
        { path: 'artifacts/contracts/interface-contracts.md', reason: 'interface contracts', tier: 'matrix' },
      ],
      domain: [
        { path: 'artifacts/domain/domain-glossary.md', reason: 'domain glossary', tier: 'transitive' },
      ],
      reference: [
        { path: 'references/skill-spec.md', reason: 'external reference', tier: 'transitive' },
      ],
    },
    missing: [],
    omitted: [],
  };

  // Requirement 4: context group summary lines
  it('should render summary line for each direct context category', () => {
    const packet = assemblePacket(richManifest);
    const md = renderPacketMarkdown(packet);

    // Direct context section exists
    expect(md).toContain('## 4. Direct Context（直接关联）');

    // Each direct category should have a summary line with count
    const directCategories = ['target', 'prd', 'scenario', 'design', 'decision', 'security'];
    for (const cat of directCategories) {
      // The category header includes the count, e.g. "### target（1 项）"
      expect(md).toMatch(new RegExp(`### ${cat}（\\d+ 项）`));
      // The summary line uses the "共 N 项" format
      expect(md).toMatch(new RegExp(`> 共 \\d+ 项`));
    }
  });

  it('should render summary line for matrix context category', () => {
    const packet = assemblePacket(richManifest);
    const md = renderPacketMarkdown(packet);

    expect(md).toContain('## 5. Matrix Context（矩阵关联）');
    expect(md).toContain('### entity（1 项）');
    expect(md).toContain('### contracts（1 项）');
  });

  it('should render summary line for transitive context category', () => {
    const packet = assemblePacket(richManifest);
    const md = renderPacketMarkdown(packet);

    expect(md).toContain('## 6. Transitive Context（传递关联）');
    expect(md).toContain('### domain（1 项）');
    expect(md).toContain('### reference（1 项）');
  });

  it('should render required/optional breakdown when mix exists', () => {
    const mixedManifest: ContextManifest = {
      ...richManifest,
      context: {
        ...richManifest.context,
        prd: [
          { path: 'artifacts/prd/features/A2.md', reason: 'required ref', required: true, tier: 'direct' },
          { path: 'artifacts/prd/features/A3.md', reason: 'optional ref', tier: 'direct' },
        ],
      },
    };
    const packet = assemblePacket(mixedManifest);
    const md = renderPacketMarkdown(packet);
    // Should show required/optional breakdown for the prd category
    expect(md).toContain('必读: 1 | 选读: 1');
  });

  it('should render "全部必读" when all items in category are required', () => {
    const packet = assemblePacket(richManifest);
    const md = renderPacketMarkdown(packet);
    // scenario has 2 items, both required=false (no explicit required field)
    // target has 1 item, required=true
    // The target category should show "全部必读"
    // But scenario items don't have required=true explicitly, so they show as optional
    // Let's check target specifically
    const targetSection = md.substring(md.indexOf('### target'), md.indexOf('### prd'));
    expect(targetSection).toContain('全部必读');
  });

  // Requirement 7: all 19 baseline items rendered
  it('should render all 19 baseline items in the Required Baseline section', () => {
    const packet = assemblePacket(richManifest);
    const md = renderPacketMarkdown(packet);

    for (const item of ALWAYS_PRESENT) {
      expect(md).toContain(item.path);
    }

    // Verify the baseline section specifically lists 19 items
    const baselineSection = md.substring(
      md.indexOf('## 3. Required Baseline'),
      md.indexOf('## 4.'),
    );
    for (const item of ALWAYS_PRESENT) {
      expect(baselineSection).toContain(item.path);
    }
  });

  it('baseline total in rendered markdown matches ALWAYS_PRESENT length', () => {
    const packet = assemblePacket(richManifest);
    expect(packet.requiredBaseline.total).toBe(ALWAYS_PRESENT.length);
    expect(packet.requiredBaseline.items).toHaveLength(ALWAYS_PRESENT.length);
  });

  it('keeps baseline count when a required baseline file is also the target', () => {
    const overlappingTargetManifest: ContextManifest = {
      schemaVersion: '1.0',
      target: {
        type: 'design',
        id: 'test-strategy',
        uid: 'design:test-strategy',
        sourcePath: 'artifacts/design/test-strategy.md',
      },
      context: {
        baseline: ALWAYS_PRESENT
          .filter((item) => item.path !== 'artifacts/design/test-strategy.md')
          .map((item) => ({
            path: item.path,
            reason: item.reason,
            required: true,
            tier: 'baseline',
          })),
        target: [
          {
            path: 'artifacts/design/test-strategy.md',
            reason: 'design:test-strategy',
            required: true,
            tier: 'target',
          },
        ],
      },
      missing: [],
      omitted: [],
    };

    const packet = assemblePacket(overlappingTargetManifest);

    expect(packet.requiredBaseline.total).toBe(ALWAYS_PRESENT.length);
    expect(packet.requiredBaseline.items).toHaveLength(ALWAYS_PRESENT.length);
    expect(packet.requiredBaseline.items).toContainEqual(expect.objectContaining({
      path: 'artifacts/design/test-strategy.md',
      reason: 'test strategy',
      required: true,
      tier: 'baseline',
    }));
    expect(packet.contextByTier.direct).toContainEqual(expect.objectContaining({
      category: 'target',
      items: expect.arrayContaining([
        expect.objectContaining({
          path: 'artifacts/design/test-strategy.md',
          reason: 'design:test-strategy',
          required: true,
          tier: 'target',
        }),
      ]),
    }));
  });

  // Requirement 8: existing rendering tests are not broken by quality additions
  it('rendering a minimal manifest still produces all required sections', () => {
    const minimalManifest: ContextManifest = {
      schemaVersion: '1.0',
      target: { type: 'feature', id: 'X1', uid: 'feature:X1' },
      context: {
        baseline: [
          { path: 'AGENTS.md', reason: 'agent instructions', required: true, tier: 'baseline' },
        ],
        target: [
          { path: 'artifacts/prd/features/X1.md', reason: 'target', required: true, tier: 'target' },
        ],
      },
      missing: [],
      omitted: [],
    };
    const packet = assemblePacket(minimalManifest);
    const md = renderPacketMarkdown(packet);

    // All section headers survive
    expect(md).toContain('# Implementation Packet — FEATURE X1');
    expect(md).toContain('## 1. 实现目标');
    expect(md).toContain('## 2. 上下文清单摘要');
    expect(md).toContain('## 3. Required Baseline');
    expect(md).toContain('## 4. Direct Context');
    expect(md).toContain('## 8. Implementation Blueprint Draft');
    expect(md).toContain('### 8.1 上下文清单');
    expect(md).toContain('### 8.2 文件变更清单');
    expect(md).toContain('### 8.3 约束与边界');
    expect(md).toContain('### 8.4 验证命令');
    expect(md).toContain('### 8.5 推荐审阅顺序');
    expect(md).toContain('### 8.6 风险检查清单');

    // New quality elements also present
    expect(md).toContain('**Context items:');
    expect(md).toContain('**Missing:');
    expect(md).toContain('**Omitted:');
    expect(md).toContain('执行指令');
    expect(md).toContain('Ctrl+F 搜索');
  });

  it('validatePacketMarkdown still passes for rich manifest rendered output', () => {
    const packet = assemblePacket(richManifest);
    const md = renderPacketMarkdown(packet);
    const result = validatePacketMarkdown(md);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('CLI markdown output for real repo includes T04 quality elements', async () => {
    const root = await packetRepo('t04-quality');
    const io = captureIo();
    const code = await runCli(['packet', '--root', root, '--feature', 'A1', '--format', 'markdown'], io);
    expect(code).toBe(0);

    const md = io.stdoutText;
    // Header summary
    expect(md).toContain('**Context items:');
    expect(md).toContain('**Missing:');
    // Execution instructions
    expect(md).toContain('执行指令');
    // Baseline grading
    expect(md).toMatch(/必读: \d+ 项 \| 选读: \d+ 项/);
    // Validation comments
    expect(md).toContain('# 构建项目');
    // Footer hint
    expect(md).toContain('Ctrl+F 搜索');
  });
});

// ── CLI tests: packet command ──

describe('CLI: packet command', () => {
  it('packet --feature A1 --format json', async () => {
    const root = await packetRepo('feature-json');
    const io = captureIo();
    const code = await runCli(['packet', '--root', root, '--feature', 'A1', '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    expect(output.schemaVersion).toBe('1.0');
    expect(output.target.type).toBe('feature');
    expect(output.target.id).toBe('A1');
    expect(output.requiredBaseline.total).toBe(19);
    expect(output.implementationBlueprintDraft).toBeDefined();
    expect(output.implementationBlueprintDraft.objective.featureId).toBe('A1');
  });

  it('packet --scenario S-01 --format markdown', async () => {
    const root = await packetRepo('scenario-md');
    const io = captureIo();
    const code = await runCli(['packet', '--root', root, '--scenario', 'S-01', '--format', 'markdown'], io);
    expect(code).toBe(0);

    expect(io.stdoutText).toContain('# Implementation Packet — SCENARIO S-01');
    expect(io.stdoutText).toContain('schemaVersion: 1.0');
    expect(io.stdoutText).toContain('## 3. Required Baseline');
    expect(io.stdoutText).toContain('AGENTS.md');
  });

  it('packet --decision D-ARCH-01 --max-per-category 5', async () => {
    const root = await packetRepo('decision-max5');
    const io = captureIo();
    const code = await runCli(['packet', '--root', root, '--decision', 'D-ARCH-01', '--max-per-category', '5', '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    expect(output.target.type).toBe('decision');
    expect(output.target.id).toBe('D-ARCH-01');
    expect(output.contextManifestSummary.maxPerCategory).toBe(5);
  });

  it('packet --out writes to file', async () => {
    const root = await packetRepo('out-file');
    const outPath = join(tmpdir(), `packet-out-${Date.now()}.json`);
    const io = captureIo();
    const code = await runCli(['packet', '--root', root, '--feature', 'A1', '--format', 'json', '--out', outPath], io);
    expect(code).toBe(0);
    expect(io.stdoutText).toContain('Packet written to');

    const content = await readFile(outPath, 'utf-8');
    const output = JSON.parse(content);
    expect(output.schemaVersion).toBe('1.0');
    expect(output.target.id).toBe('A1');
  });

  it('packet missing target exits 1', async () => {
    const root = await packetRepo('missing-target');
    const io = captureIo();
    const code = await runCli(['packet', '--root', root, '--feature', 'NONEXISTENT', '--format', 'json'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Missing artifacts detected');
  });

  it('packet no target exits 1', async () => {
    const root = await packetRepo('no-target');
    const io = captureIo();
    const code = await runCli(['packet', '--root', root], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Usage:');
  });

  it('packet invalid --mode exits 1', async () => {
    const root = await packetRepo('invalid-mode');
    const io = captureIo();
    const code = await runCli(['packet', '--root', root, '--feature', 'A1', '--mode', 'invalid'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Invalid --mode');
  });

  it('packet invalid --format exits 1', async () => {
    const root = await packetRepo('invalid-format');
    const io = captureIo();
    const code = await runCli(['packet', '--root', root, '--feature', 'A1', '--format', 'xml'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Invalid --format');
  });
});

// ── Unit tests: validatePacket ──

describe('validatePacket', () => {
  /** Build a minimal valid packet for mutation tests */
  function validPacket(overrides?: Partial<ImplementationPacket>): ImplementationPacket {
    const base: ImplementationPacket = {
      schemaVersion: '1.0',
      generatedAt: '2026-06-29T00:00:00.000Z',
      target: { type: 'feature', id: 'A1', uid: 'feature:A1' },
      contextManifestSummary: {
        totalCategories: 1,
        totalItems: 1,
        totalOmitted: 0,
        totalMissing: 0,
        mode: 'implementation',
        maxPerCategory: 20,
      },
      requiredBaseline: {
        category: 'baseline',
        total: BASELINE_ITEMS_COUNT,
        items: ALWAYS_PRESENT.map((ap) => ({
          path: ap.path,
          reason: ap.reason,
          required: true,
        })),
      },
      contextByTier: { direct: [], matrix: [], transitive: [] },
      omittedItems: [],
      missing: [],
      implementationBlueprintDraft: {
        objective: {
          featureId: 'A1',
          scenarioId: null,
          decisionId: null,
          description: 'test objective',
          scope: 'test scope',
          nonGoals: [],
        },
        contextChecklist: { categories: [] },
        fileChanges: [],
        constraints: [...BASELINE_CONSTRAINTS],
        validationCommands: [
          'pnpm build',
          'pnpm test',
          'node validate',
          'node links',
        ],
        recommendedReviewOrder: [
          { step: 1, category: 'baseline', reason: '必读基础制品' },
          { step: 2, category: 'target', reason: '目标本身' },
        ],
        riskChecklist: [
          { id: 'RISK-001', description: '是否触碰 artifacts/ 下的制品文件', checked: true },
          { id: 'RISK-002', description: '是否涉及 desktop E2E 链路', checked: false },
        ],
      },
      validationCommands: [
        'pnpm build',
        'pnpm test',
        'node validate',
        'node links',
      ],
    };
    return overrides ? { ...base, ...overrides } : base;
  }

  it('should pass for a valid packet (ok=true, issues=[])', () => {
    const result = validatePacket(validPacket());
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  // PKT-001
  it('PKT-001: schemaVersion not "1.0" produces error', () => {
    const result = validatePacket(validPacket({ schemaVersion: '2.0' as ImplementationPacket['schemaVersion'] }));
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-001');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.message).toContain('2.0');
  });

  // PKT-002
  it('PKT-002: invalid target.type produces error', () => {
    const packet = validPacket();
    packet.target = { type: 'invalid-type', id: 'A1', uid: 'invalid-type:A1' };
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-002');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.message).toContain('invalid-type');
  });

  it('PKT-002: context-only target.type produces error', () => {
    const packet = validPacket();
    packet.target = { type: 'entity', id: 'E-001', uid: 'entity:E-001' };
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-002');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.message).toContain('feature, scenario, decision, design, e2e_test');
    expect(issue!.message).toContain('entity');
  });

  it('PKT-002: schema role can make a legacy core type context-only', () => {
    const packet = validPacket();
    const schema = {
      types: {
        feature: { role: 'context' },
        scenario: { role: 'scenario' },
      },
      idPatterns: {},
    };

    const result = validatePacket(packet, schema);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PKT-002', path: 'target.type' }),
    ]));
  });

  // PKT-003
  it('PKT-003: empty target.id produces error', () => {
    const packet = validPacket();
    packet.target = { type: 'feature', id: '', uid: 'feature:' };
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-003');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  it('PKT-003: whitespace-only target.id produces error', () => {
    const packet = validPacket();
    packet.target = { type: 'feature', id: '   ', uid: 'feature:   ' };
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-003');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  // PKT-004
  it('PKT-004: requiredBaseline.total not equal to baseline count produces error', () => {
    const packet = validPacket();
    packet.requiredBaseline = { ...packet.requiredBaseline, total: 5 };
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-004');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.message).toContain(String(BASELINE_ITEMS_COUNT));
  });

  // PKT-005
  it('PKT-005: constraints missing C-RULE-01 produces error', () => {
    const packet = validPacket();
    packet.implementationBlueprintDraft = {
      ...packet.implementationBlueprintDraft,
      constraints: packet.implementationBlueprintDraft.constraints.filter((c) => c.id !== 'C-RULE-01'),
    };
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-005' && i.message.includes('C-RULE-01'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  it('PKT-005: constraints count != baseline count produces error', () => {
    const packet = validPacket();
    packet.implementationBlueprintDraft = {
      ...packet.implementationBlueprintDraft,
      constraints: [{ id: 'C-RULE-01', description: 'test', source: 'test' }],
    };
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-005' && i.message.includes('exactly'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  // PKT-006
  it('PKT-006: fewer than 4 validationCommands produces error', () => {
    const packet = validPacket();
    packet.validationCommands = ['echo 1'];
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-006');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.message).toContain('4');
  });

  // PKT-007
  it('PKT-007: non-empty missing produces error (ok is false)', () => {
    const packet = validPacket();
    packet.missing = ['artifacts/decisions/D-MISSING.md'];
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-007');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.message).toContain('D-MISSING.md');
  });

  it('PKT-007: multiple missing entries are reported', () => {
    const packet = validPacket();
    packet.missing = ['a.md', 'b.md', 'c.md'];
    const result = validatePacket(packet);
    const issue = result.issues.find((i) => i.code === 'PKT-007');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('3');
  });

  // PKT-009
  it('PKT-009: empty recommendedReviewOrder produces error', () => {
    const packet = validPacket();
    packet.implementationBlueprintDraft = {
      ...packet.implementationBlueprintDraft,
      recommendedReviewOrder: [],
    };
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-009');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  it('PKT-009: missing recommendedReviewOrder produces error', () => {
    const packet = validPacket();
    const { recommendedReviewOrder: _, ...rest } = packet.implementationBlueprintDraft;
    packet.implementationBlueprintDraft = rest as typeof packet.implementationBlueprintDraft;
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-009');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  it('PKT-009: invalid entry shape produces error', () => {
    const packet = validPacket();
    packet.implementationBlueprintDraft = {
      ...packet.implementationBlueprintDraft,
      recommendedReviewOrder: [{ step: 'bad' as unknown as number, category: '', reason: '' }],
    };
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-009');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  // PKT-010
  it('PKT-010: empty riskChecklist produces error', () => {
    const packet = validPacket();
    packet.implementationBlueprintDraft = {
      ...packet.implementationBlueprintDraft,
      riskChecklist: [],
    };
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-010');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  it('PKT-010: missing riskChecklist produces error', () => {
    const packet = validPacket();
    const { riskChecklist: _, ...rest } = packet.implementationBlueprintDraft;
    packet.implementationBlueprintDraft = rest as typeof packet.implementationBlueprintDraft;
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-010');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  it('PKT-010: invalid entry shape produces error', () => {
    const packet = validPacket();
    packet.implementationBlueprintDraft = {
      ...packet.implementationBlueprintDraft,
      riskChecklist: [{ id: '', description: '', checked: 'yes' as unknown as boolean }],
    };
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PKT-010');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  // Issue code uniqueness
  it('each distinct rule violation produces a unique code', () => {
    const packet = validPacket({
      schemaVersion: '9.0' as ImplementationPacket['schemaVersion'],
    });
    packet.target = { type: 'bogus', id: '', uid: '' };
    packet.requiredBaseline = { ...packet.requiredBaseline, total: 0 };
    packet.implementationBlueprintDraft = {
      ...packet.implementationBlueprintDraft,
      constraints: [],
      recommendedReviewOrder: [],
      riskChecklist: [],
    };
    packet.validationCommands = [];
    packet.missing = ['x.md'];

    const result = validatePacket(packet);
    const codes = result.issues.map((i) => i.code);
    // All codes should be present
    expect(codes).toContain('PKT-001');
    expect(codes).toContain('PKT-002');
    expect(codes).toContain('PKT-003');
    expect(codes).toContain('PKT-004');
    expect(codes).toContain('PKT-005');
    expect(codes).toContain('PKT-006');
    expect(codes).toContain('PKT-007');
    expect(codes).toContain('PKT-009');
    expect(codes).toContain('PKT-010');
    expect(result.ok).toBe(false);
  });

  // Compound: ok=false when multiple errors
  it('ok=false when multiple errors are present simultaneously', () => {
    const packet = validPacket({ schemaVersion: '9.0' as ImplementationPacket['schemaVersion'] });
    packet.validationCommands = [];
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    const errorIssues = result.issues.filter((i) => i.severity === 'error');
    expect(errorIssues.length).toBeGreaterThanOrEqual(2);
  });

  // Compound: ok=false when only PKT-007 errors are present
  it('ok=false when PKT-007 errors (missing) are present', () => {
    const packet = validPacket();
    packet.missing = ['some-missing.md'];
    const result = validatePacket(packet);
    expect(result.ok).toBe(false);
    expect(result.issues.every((i) => i.severity === 'error')).toBe(true);
  });
});

// ── Unit tests: validatePacketMarkdown ──

describe('validatePacketMarkdown', () => {
  it('should pass for a complete rendered packet markdown', () => {
    const manifest: ContextManifest = {
      schemaVersion: '1.0',
      target: { type: 'feature', id: 'A1', uid: 'feature:A1' },
      context: {
        baseline: [
          { path: 'AGENTS.md', reason: 'agent instructions', required: true, tier: 'baseline' },
        ],
        target: [
          { path: 'artifacts/prd/features/A1.md', reason: 'target', required: true, tier: 'target' },
        ],
      },
      missing: [],
      omitted: [],
    };
    const packet = assemblePacket(manifest);
    const md = renderPacketMarkdown(packet);
    const result = validatePacketMarkdown(md);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('PKT-008: missing "## 1. 实现目标" produces error', () => {
    const md = '## 2. 上下文清单摘要\n## 3. Required Baseline（必读制品）\n## 8. Implementation Blueprint Draft（实现蓝图草案）\n### 8.3 约束与边界\n### 8.4 验证命令\n### 8.5 推荐审阅顺序\n### 8.6 风险检查清单\n';
    const result = validatePacketMarkdown(md);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.message.includes('实现目标'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.code).toBe('PKT-008');
    expect(result.issues).toHaveLength(1);
  });

  it('PKT-008: missing "## 2. 上下文清单摘要" produces error', () => {
    const md = '## 1. 实现目标\n## 3. Required Baseline（必读制品）\n## 8. Implementation Blueprint Draft（实现蓝图草案）\n### 8.3 约束与边界\n### 8.4 验证命令\n### 8.5 推荐审阅顺序\n### 8.6 风险检查清单\n';
    const result = validatePacketMarkdown(md);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.message.includes('上下文清单摘要'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(result.issues).toHaveLength(1);
  });

  it('PKT-008: missing "## 3. Required Baseline（必读制品）" produces error', () => {
    const md = '## 1. 实现目标\n## 2. 上下文清单摘要\n## 8. Implementation Blueprint Draft（实现蓝图草案）\n### 8.3 约束与边界\n### 8.4 验证命令\n### 8.5 推荐审阅顺序\n### 8.6 风险检查清单\n';
    const result = validatePacketMarkdown(md);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.message.includes('Required Baseline'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(result.issues).toHaveLength(1);
  });

  it('PKT-008: missing "## 8. Implementation Blueprint Draft" produces error', () => {
    const md = '## 1. 实现目标\n## 2. 上下文清单摘要\n## 3. Required Baseline（必读制品）\n### 8.3 约束与边界\n### 8.4 验证命令\n### 8.5 推荐审阅顺序\n### 8.6 风险检查清单\n';
    const result = validatePacketMarkdown(md);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.message.includes('Implementation Blueprint'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(result.issues).toHaveLength(1);
  });

  it('PKT-008: missing "### 8.3 约束与边界" produces error', () => {
    const md = '## 1. 实现目标\n## 2. 上下文清单摘要\n## 3. Required Baseline（必读制品）\n## 8. Implementation Blueprint Draft（实现蓝图草案）\n### 8.4 验证命令\n### 8.5 推荐审阅顺序\n### 8.6 风险检查清单\n';
    const result = validatePacketMarkdown(md);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.message.includes('8.3'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(result.issues).toHaveLength(1);
  });

  it('PKT-008: missing "### 8.4 验证命令" produces error', () => {
    const md = '## 1. 实现目标\n## 2. 上下文清单摘要\n## 3. Required Baseline（必读制品）\n## 8. Implementation Blueprint Draft（实现蓝图草案）\n### 8.3 约束与边界\n### 8.5 推荐审阅顺序\n### 8.6 风险检查清单\n';
    const result = validatePacketMarkdown(md);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.message.includes('8.4'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(result.issues).toHaveLength(1);
  });

  it('PKT-008: missing "### 8.5 推荐审阅顺序" produces error', () => {
    const md = '## 1. 实现目标\n## 2. 上下文清单摘要\n## 3. Required Baseline（必读制品）\n## 8. Implementation Blueprint Draft（实现蓝图草案）\n### 8.3 约束与边界\n### 8.4 验证命令\n### 8.6 风险检查清单\n';
    const result = validatePacketMarkdown(md);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.message.includes('8.5'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(result.issues).toHaveLength(1);
  });

  it('PKT-008: missing "### 8.6 风险检查清单" produces error', () => {
    const md = '## 1. 实现目标\n## 2. 上下文清单摘要\n## 3. Required Baseline（必读制品）\n## 8. Implementation Blueprint Draft（实现蓝图草案）\n### 8.3 约束与边界\n### 8.4 验证命令\n### 8.5 推荐审阅顺序\n';
    const result = validatePacketMarkdown(md);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.message.includes('8.6'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(result.issues).toHaveLength(1);
  });

  it('PKT-008: empty markdown produces 8 errors', () => {
    const result = validatePacketMarkdown('');
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(8);
    expect(result.issues.every((i) => i.code === 'PKT-008')).toBe(true);
    expect(result.issues.every((i) => i.severity === 'error')).toBe(true);
  });

  it('PKT-008: partial markdown produces only missing section errors', () => {
    const md = '## 1. 实现目标\n## 2. 上下文清单摘要\n';
    const result = validatePacketMarkdown(md);
    expect(result.ok).toBe(false);
    // Missing: 3, 8, 8.3, 8.4, 8.5, 8.6 => 6 errors
    expect(result.issues).toHaveLength(6);
    expect(result.issues.every((i) => i.code === 'PKT-008')).toBe(true);
  });
});

// ── Constant assertions ──

describe('packet-constants', () => {
  it('ALWAYS_PRESENT contains exactly 19 items', () => {
    expect(ALWAYS_PRESENT).toHaveLength(19);
  });

  it('BASELINE_ITEMS_COUNT equals 19', () => {
    expect(BASELINE_ITEMS_COUNT).toBe(19);
  });

  it('BASELINE_ITEMS_COUNT matches ALWAYS_PRESENT.length', () => {
    expect(BASELINE_ITEMS_COUNT).toBe(ALWAYS_PRESENT.length);
  });

  it('BASELINE_CONSTRAINTS contains exactly 7 items', () => {
    expect(BASELINE_CONSTRAINTS).toHaveLength(7);
  });

  it('BASELINE_CONSTRAINTS_COUNT equals 7', () => {
    expect(BASELINE_CONSTRAINTS_COUNT).toBe(7);
  });

  it('BASELINE_CONSTRAINTS_COUNT matches BASELINE_CONSTRAINTS.length', () => {
    expect(BASELINE_CONSTRAINTS_COUNT).toBe(BASELINE_CONSTRAINTS.length);
  });

  it('ALWAYS_PRESENT items have path and reason fields', () => {
    for (const item of ALWAYS_PRESENT) {
      expect(item.path).toBeTruthy();
      expect(item.reason).toBeTruthy();
    }
  });

  it('BASELINE_CONSTRAINTS items have id, description, and source fields', () => {
    for (const constraint of BASELINE_CONSTRAINTS) {
      expect(constraint.id).toBeTruthy();
      expect(constraint.description).toBeTruthy();
      expect(constraint.source).toBeTruthy();
    }
  });

  it('BASELINE_CONSTRAINTS includes C-RULE-01', () => {
    const cRule01 = BASELINE_CONSTRAINTS.find((c) => c.id === 'C-RULE-01');
    expect(cRule01).toBeDefined();
    expect(cRule01!.description).toContain('SEC severity');
  });
});

// ── Integration: audit summary includes validation issues ──

describe('integration: packet-audit validation issues', () => {
  it('audit entry should include validationIssues when packet has warnings', async () => {
    const root = await packetRepo('audit-validation');
    // Use a real target — assemble a packet to verify validation runs
    const { auditPackets: runAudit } = await import('../src/packet-audit.js');
    const targets = [{ type: 'feature' as const, id: 'A1' }];
    const summary = await runAudit(root, targets, { root });
    expect(summary.total).toBe(1);
    const entry = summary.targets[0];
    // A fully valid packet from a real repo should have no errors
    expect(entry.status).toBe('passed');
    // Either no issues or only warnings — validationIssues should be defined or undefined
    if (entry.validationIssues) {
      expect(entry.validationIssues.every((i: PacketValidationIssue) => i.severity === 'warning')).toBe(true);
    }
  });

  it('audit entry has validationIssues only when issues exist, and entry type matches PacketAuditEntry', async () => {
    // Verify the audit pipeline runs validation and produces the correct entry shape
    const root = await packetRepo('audit-validation-shape');
    const { auditPackets: runAudit } = await import('../src/packet-audit.js');
    const targets = [{ type: 'feature' as const, id: 'A1' }];
    const summary = await runAudit(root, targets, { root });
    const entry = summary.targets[0];
    // For a well-formed packet, status is 'passed' and validationIssues is absent
    expect(entry.status).toBe('passed');
    expect(entry.type).toBe('feature');
    expect(entry.id).toBe('A1');
    // validationIssues is optional — only present when issues exist
    if (entry.validationIssues) {
      expect(entry.validationIssues.length).toBeGreaterThan(0);
      expect(entry.validationIssues.every((i: PacketValidationIssue) =>
        i.severity === 'error' || i.severity === 'warning',
      )).toBe(true);
    }
  });
});

// ── CLI: packet --no-validate ──

describe('CLI: packet --no-validate', () => {
  it('packet --no-validate skips validation (exit 0)', async () => {
    const root = await packetRepo('no-validate');
    const io = captureIo();
    const code = await runCli(['packet', '--root', root, '--feature', 'A1', '--format', 'json', '--no-validate'], io);
    expect(code).toBe(0);
    const output = JSON.parse(io.stdoutText);
    expect(output.schemaVersion).toBe('1.0');
  });

  it('packet without --no-validate runs validation normally', async () => {
    const root = await packetRepo('with-validate');
    const io = captureIo();
    const code = await runCli(['packet', '--root', root, '--feature', 'A1', '--format', 'json'], io);
    expect(code).toBe(0);
    const output = JSON.parse(io.stdoutText);
    expect(output.schemaVersion).toBe('1.0');
  });
});

describe('renderPacketPrompt', () => {
  function makeManifest(type: string, id: string): ContextManifest {
    const context: Record<string, ContextItem[]> = {};
    context['baseline'] = ALWAYS_PRESENT.map((f) => ({
      path: f.path,
      reason: f.reason,
      required: true,
      tier: 'baseline' as const,
      reasons: ['always-present'],
    }));
    context['target'] = [
      { path: `artifacts/prd/features/${id}.md`, reason: `${type} target`, required: true, tier: 'target' as const, reasons: ['target'] },
    ];
    return {
      target: { type, id, uid: `${type}:${id}` },
      context,
      omitted: [],
      missing: [],
      missingDetails: [],
      mode: 'implementation',
      maxPerCategory: 20,
    };
  }

  it('renders prompt within default 4000 char limit', () => {
    const manifest = makeManifest('feature', 'A1');
    const packet = assemblePacket(manifest);
    const prompt = renderPacketPrompt(packet);
    expect(prompt.length).toBeLessThanOrEqual(4000);
  });

  it('contains all required sections', () => {
    const manifest = makeManifest('feature', 'A1');
    const packet = assemblePacket(manifest);
    const prompt = renderPacketPrompt(packet);
    expect(prompt).toContain('实现任务：功能 A1');
    expect(prompt).toContain('必读制品');
    expect(prompt).toContain('约束与边界');
    expect(prompt).toContain('验证命令');
    expect(prompt).toContain('提交要求');
    expect(prompt).toContain('禁止事项');
  });

  it('contains baseline constraints', () => {
    const manifest = makeManifest('feature', 'A1');
    const packet = assemblePacket(manifest);
    const prompt = renderPacketPrompt(packet);
    expect(prompt).toContain('C-ARCH-01');
    expect(prompt).toContain('C-RULE-01');
    expect(prompt).toContain('SEC severity');
  });

  it('contains packet command reference', () => {
    const manifest = makeManifest('scenario', 'S-01');
    const packet = assemblePacket(manifest);
    const prompt = renderPacketPrompt(packet);
    expect(prompt).toContain('packet --root');
    expect(prompt).toContain('--scenario S-01');
  });

  it('includes target metadata, context completeness, and review order for consumption', () => {
    const manifest = makeManifest('feature', 'A1');
    manifest.target = {
      ...manifest.target,
      title: 'Skill import/register',
      sourcePath: 'artifacts/prd/features/A1-skill-import.md',
      status: 'accepted',
    };
    const packet = assemblePacket(manifest);
    const prompt = renderPacketPrompt(packet);

    expect(prompt).toContain('Skill import/register');
    expect(prompt).toContain('artifacts/prd/features/A1-skill-import.md');
    expect(prompt).toContain('Missing=0');
    expect(prompt).toContain('Omitted=0');
    expect(prompt).toContain('推荐审阅步骤');
  });

  it('contains no-revert rule', () => {
    const manifest = makeManifest('feature', 'A1');
    const packet = assemblePacket(manifest);
    const prompt = renderPacketPrompt(packet);
    expect(prompt).toContain('不要回退用户已有改动');
    expect(prompt).toContain('不得回退用户已有的 dirty work');
  });

  it('respects custom --max-chars', () => {
    const manifest = makeManifest('feature', 'A1');
    const packet = assemblePacket(manifest);
    const prompt = renderPacketPrompt(packet, { maxChars: 500 });
    expect(prompt.length).toBeLessThanOrEqual(500);
    // Key elements survive even in ultra-compact mode
    expect(prompt).toContain('packet --root');
    expect(prompt).toContain('禁止事项');
  });

  it('decision type renders correctly', () => {
    const manifest = makeManifest('decision', 'D-ARCH-01');
    const packet = assemblePacket(manifest);
    const prompt = renderPacketPrompt(packet);
    expect(prompt).toContain('实现任务：决策 D-ARCH-01');
    expect(prompt).toContain('--decision D-ARCH-01');
  });

  it('no large English paragraphs outside code blocks', () => {
    const manifest = makeManifest('feature', 'A1');
    const packet = assemblePacket(manifest);
    const prompt = renderPacketPrompt(packet);
    const textOutsideCodeBlocks = prompt.replace(/```[\s\S]*?```/g, '');
    const longEnglishRun = /[a-zA-Z\s]{100,}/;
    expect(longEnglishRun.test(textOutsideCodeBlocks)).toBe(false);
  });

  it('includes validation commands', () => {
    const manifest = makeManifest('feature', 'A1');
    const packet = assemblePacket(manifest);
    const prompt = renderPacketPrompt(packet);
    expect(prompt).toContain('pnpm build');
    expect(prompt).toContain('pnpm test');
    expect(prompt).toContain('validate');
    expect(prompt).toContain('version-lock audit');
  });

  it('output is deterministic with fixed generatedAt', () => {
    const manifest = makeManifest('feature', 'A1');
    const fixed = '2026-06-29T12:00:00.000Z';
    const packet1 = assemblePacket(manifest, { generatedAt: fixed });
    const packet2 = assemblePacket(manifest, { generatedAt: fixed });
    const prompt1 = renderPacketPrompt(packet1, { generatedAt: fixed });
    const prompt2 = renderPacketPrompt(packet2, { generatedAt: fixed });
    expect(prompt1).toBe(prompt2);
  });

  it('e2e_test prompt uses --e2e-test flag (not --e2e_test)', () => {
    const manifest = makeManifest('e2e_test', 'test-01:TC-001');
    const packet = assemblePacket(manifest);
    const prompt = renderPacketPrompt(packet) as string;
    expect(prompt).toContain('--e2e-test test-01:TC-001');
    expect(prompt).not.toContain('--e2e_test');
  });
});

// ── v1.9: renderPacketPrompt length contract tests ──

describe('renderPacketPrompt: v1.9 length contract', () => {
  function makeManifest(type: string, id: string): ContextManifest {
    const context: Record<string, ContextItem[]> = {};
    context['baseline'] = ALWAYS_PRESENT.map((f) => ({
      path: f.path,
      reason: f.reason,
      required: true,
      tier: 'baseline' as const,
      reasons: ['always-present'],
    }));
    context['target'] = [
      { path: `artifacts/prd/features/${id}.md`, reason: `${type} target`, required: true, tier: 'target' as const, reasons: ['target'] },
    ];
    return {
      target: { type, id, uid: `${type}:${id}` },
      context,
      omitted: [],
      missing: [],
      missingDetails: [],
      mode: 'implementation',
      maxPerCategory: 20,
    };
  }

  it('returns PacketPromptError when maxChars below MIN_PROMPT_CHARS', () => {
    const manifest = makeManifest('feature', 'A1');
    const packet = assemblePacket(manifest);
    const result = renderPacketPrompt(packet, { maxChars: 100 });
    expect(typeof result).toBe('object');
    const err = result as PacketPromptError;
    expect(err.ok).toBe(false);
    expect(err.reason).toContain('最小可用提示词长度');
    expect(err.minRequired).toBe(MIN_PROMPT_CHARS);
  });

  it('returns string when maxChars equals MIN_PROMPT_CHARS', () => {
    const manifest = makeManifest('feature', 'A1');
    const packet = assemblePacket(manifest);
    const result = renderPacketPrompt(packet, { maxChars: MIN_PROMPT_CHARS });
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeLessThanOrEqual(MIN_PROMPT_CHARS);
  });

  it('MIN_PROMPT_CHARS is the smallest supported validator-passing prompt size', () => {
    expect(MIN_PROMPT_CHARS).toBe(320);
  });

  it('default 4000 char prompt contains all 6 sections', () => {
    const manifest = makeManifest('feature', 'A1');
    const packet = assemblePacket(manifest);
    const result = renderPacketPrompt(packet);
    expect(typeof result).toBe('string');
    const prompt = result as string;
    expect(prompt).toContain('实现任务');
    expect(prompt).toContain('必读制品');
    expect(prompt).toContain('约束与边界');
    expect(prompt).toContain('验证命令');
    expect(prompt).toContain('提交要求');
    expect(prompt).toContain('禁止事项');
  });

  it('prompt at MIN_PROMPT_CHARS still contains critical elements', () => {
    const manifest = makeManifest('feature', 'A1');
    const packet = assemblePacket(manifest);
    const result = renderPacketPrompt(packet, { maxChars: MIN_PROMPT_CHARS });
    expect(typeof result).toBe('string');
    const prompt = result as string;
    expect(prompt).toContain('artifact-graph packet');
    expect(prompt).toContain('pnpm build');
    expect(prompt).toContain('git diff --check');
    expect(prompt).toContain('禁止事项');
    expect(prompt).toContain('不得回退');
    expect(prompt).toContain('SEC severity');
    expect(validatePacketPrompt(prompt).ok).toBe(true);
  });

  it('returns PacketPromptError when maxChars=1 (extreme edge)', () => {
    const manifest = makeManifest('feature', 'A1');
    const packet = assemblePacket(manifest);
    const result = renderPacketPrompt(packet, { maxChars: 1 });
    expect(typeof result).toBe('object');
    expect((result as PacketPromptError).ok).toBe(false);
  });
});

// ── v1.9: validatePacketPrompt tests ──

describe('validatePacketPrompt', () => {
  const VALID_PROMPT = `# 实现任务：功能 A1

**目标**: 测试目标

## 必读制品

运行以下命令获取完整上下文：

\`\`\`bash
artifact-graph packet --root <root> --feature A1 --format markdown
\`\`\`

## 验证命令

\`\`\`bash
pnpm build && pnpm test
\`\`\`

## 提交要求

- 两个 git 仓库分开提交
- 不要回退用户已有改动
- 提交前运行 \`git diff --check\`

## 禁止事项

- 不得引入 PRD 中未出现的新功能
- SEC severity 不允许降级
- 不得回退用户已有的 dirty work
`;

  it('passes for a valid prompt with all required sections', () => {
    const result = validatePacketPrompt(VALID_PROMPT);
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('PP-001: missing target info produces error', () => {
    const prompt = VALID_PROMPT.replace(/实现任务/g, '目标');
    const result = validatePacketPrompt(prompt);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PP-001');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  it('PP-002: missing packet reference produces error', () => {
    const prompt = VALID_PROMPT.replace(/packet\s+--root\s+<root>/g, 'echo hello');
    const result = validatePacketPrompt(prompt);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PP-002');
    expect(issue).toBeDefined();
  });

  it('PP-003: missing validation commands produces error', () => {
    const prompt = VALID_PROMPT.replace(/验证命令/g, '执行步骤').replace(/artifact-graph\s+build/g, 'echo done');
    const result = validatePacketPrompt(prompt);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PP-003');
    expect(issue).toBeDefined();
  });

  it('PP-004: missing commit requirements produces error', () => {
    const prompt = VALID_PROMPT.replace(/提交要求/g, '操作步骤').replace(/git\s+diff\s+--check/g, 'echo check');
    const result = validatePacketPrompt(prompt);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PP-004');
    expect(issue).toBeDefined();
  });

  it('PP-005: missing forbidden section produces error', () => {
    const prompt = VALID_PROMPT.replace(/禁止事项/g, '注意');
    const result = validatePacketPrompt(prompt);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PP-005');
    expect(issue).toBeDefined();
  });

  it('PP-006: missing no-revert rule produces error', () => {
    const prompt = VALID_PROMPT.replace(/不要回退用户已有改动/g, '可以修改').replace(/不得回退用户已有的 dirty work/g, '允许覆盖');
    const result = validatePacketPrompt(prompt);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PP-006');
    expect(issue).toBeDefined();
  });

  it('PP-007: missing SEC severity rule produces error', () => {
    const prompt = VALID_PROMPT.replace(/SEC\s+severity\s+不允许降级/g, '允许调整级别');
    const result = validatePacketPrompt(prompt);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'PP-007');
    expect(issue).toBeDefined();
  });

  it('PP-008: all-English prompt produces warning', () => {
    const englishPrompt = `# Implementation Task: Feature A1

**Objective**: Test objective

## Required Reading

Run the following command:

\`\`\`bash
artifact-graph packet --root <root> --feature A1
\`\`\`

## Validation Commands

\`\`\`bash
pnpm build && pnpm test
\`\`\`

## Commit Requirements

- Two git repos must be committed separately
- Do not revert user changes
- Run \`git diff --check\` before commit

## Forbidden Actions

- No new features not in PRD
- SEC severity must not be downgraded
- Do not revert user dirty work
`;
    const result = validatePacketPrompt(englishPrompt);
    const warning = result.issues.find((i) => i.code === 'PP-008');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
  });

  it('passes for renderPacketPrompt output', () => {
    const manifest: ContextManifest = {
      target: { type: 'feature', id: 'A1', uid: 'feature:A1' },
      context: {
        baseline: ALWAYS_PRESENT.map((f) => ({
          path: f.path,
          reason: f.reason,
          required: true,
          tier: 'baseline' as const,
        })),
        target: [
          { path: 'artifacts/prd/features/A1.md', reason: 'target', required: true, tier: 'target' as const },
        ],
      },
      omitted: [],
      missing: [],
    };
    const packet = assemblePacket(manifest);
    const promptResult = renderPacketPrompt(packet);
    expect(typeof promptResult).toBe('string');
    const vResult = validatePacketPrompt(promptResult as string);
    expect(vResult.ok).toBe(true);
    expect(vResult.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('empty prompt produces all error codes', () => {
    const result = validatePacketPrompt('');
    expect(result.ok).toBe(false);
    const codes = result.issues.filter((i) => i.severity === 'error').map((i) => i.code);
    expect(codes).toContain('PP-001');
    expect(codes).toContain('PP-002');
    expect(codes).toContain('PP-003');
    expect(codes).toContain('PP-004');
    expect(codes).toContain('PP-005');
    expect(codes).toContain('PP-006');
    expect(codes).toContain('PP-007');
  });
});

describe('custom target: packet with --target flag', () => {
  async function customTargetPacketRepo(): Promise<string> {
    const root = join(tmpdir(), `packet-custom-target-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    await write(root, 'artifact-graph.config.yaml', `types:
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
    displayName: "API Contract"
idPatterns:
  api_contract: "^API-\\\\d+$"
`);
    // Baseline files
    for (const bf of BASELINE_FILES) {
      await write(root, bf.path, bf.content);
    }
    // Feature for traceability
    await write(root, 'artifacts/prd/features/A1-skill-import.md', `---
id: A1
title: Skill import/register
status: done
scenarios: [S-01]
design_docs: [design-skill-import]
---
# A1: Skill import/register
`);
    // Custom target artifact
    await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Order API
status: active
related_features: [A1]
---
# Order API
`);
    return root;
  }

  it('packet --target api_contract:API-001 generates valid packet via CLI', async () => {
    const root = await customTargetPacketRepo();
    let stdout = '';
    let stderr = '';
    const code = await runCli(['packet', '--root', root, '--target', 'api_contract:API-001', '--format', 'json', '--no-validate'], {
      stdout: (c) => { stdout += c; },
      stderr: (c) => { stderr += c; },
    });
    expect(code).toBe(0);
    const packet = JSON.parse(stdout);
    expect(packet.target.type).toBe('api_contract');
    expect(packet.target.id).toBe('API-001');
  });

  it('packet --target with colon in ID works', async () => {
    const root = await customTargetPacketRepo();
    // Add an e2e_test artifact with colon in ID
    await write(root, 'artifacts/tests/e2e/test-batch.md', `---
test_batch: batch-001
scope: test
related_scenarios: []
---
# E2E Test Batch

## TC-001: Test case
`);
    let stdout = '';
    let stderr = '';
    const code = await runCli(['packet', '--root', root, '--target', 'e2e_test:batch-001:TC-001', '--format', 'json', '--no-validate'], {
      cwd: root,
      stdout: (c) => { stdout += c; },
      stderr: (c) => { stderr += c; },
    });
    // Hard-assert exit 0 — no silent pass on failure
    expect(code).toBe(0);
    const packet = JSON.parse(stdout);
    expect(packet.target.type).toBe('e2e_test');
    expect(packet.target.id).toBe('batch-001:TC-001');
  });
});
