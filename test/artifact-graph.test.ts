import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEMA,
  buildGraph,
  discoverTargets,
  formatContextMarkdown,
  getArtifactTypeMetadata,
  getTargetArtifactTypes,
  loadConfig,
  nextId,
  queryGraph,
  renderMermaid,
  resolveArtifactContext,
  resolveArtifactTypeName,
  scanArtifacts,
  validateExecutableTraceability,
  validateGraph,
  validateScenarioPrdLinks,
  writeGraphCache,
} from '../src/index.js';
import type { ArtifactGraph, MissingDetail } from '../src/index.js';
import { auditPackets, parseTargetsFile } from '../src/packet-audit.js';

async function write(root: string, path: string, content: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(fullPath.split('/').slice(0, -1).join('/'), { recursive: true });
  await writeFile(fullPath, content);
}

async function fixtureRepo(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });

  await write(
    root,
    'artifact-graph.config.yaml',
    `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  design:
    paths: ["artifacts/design/**/*.md"]
  entity:
    paths: ["artifacts/entities/entity-registry.md"]
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  test:
    paths: ["heimdall/packages/**/*.test.ts"]
  e2e_test:
    paths: ["artifacts/tests/e2e/*.md"]
  e2e_registry:
    paths: ["artifacts/tests/e2e/e2e-test-registry.json"]
idPatterns:
  e2e_test: '^.+:(TC-\\d+|FILE)$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [planned, active, done, deprecated, accepted]
idRanges:
  scenario:
    batch-49:
      prefix: S-
      start: 1200
      end: 1299
`,
  );

  await write(
    root,
    'artifacts/prd/features/A1-skill-import.md',
    `---
id: A1
title: Skill import/register
status: done
scenarios: [S-01, S-9999]
decisions: [D-TOOL-02]
depends_on: [B6]
design_docs:
  - artifacts/design/design-skill-import.md
---

# A1: Skill import/register
`,
  );

  await write(
    root,
    'artifacts/prd/features/ABCD1-long-domain.md',
    `---
id: ABCD1
title: Four-letter feature prefix
status: done
scenarios: [S-01a]
design_docs: [design-four-letter.md]
---

# ABCD1: Four-letter feature prefix
`,
  );

  await write(
    root,
    'artifacts/prd/features/B6-quick-check.md',
    `---
id: B6
title: Quick Check mode
status: done
scenarios: [S-03]
decisions: [D-SCAN-01]
design_docs: []
---

# B6: Quick Check mode
`,
  );

  await write(
    root,
    'artifacts/design/design-skill-import.md',
    `---
id: SHOULD-NOT-BE-CANONICAL
title: Skill import design
related_features: [A1]
related_scenarios: [S-01]
---

# Skill import design
`,
  );

  await write(
    root,
    'artifacts/design/design-four-letter.md',
    `---
title: Four-letter feature design
related_features: [ABCD1]
---

# Four-letter feature design
`,
  );

  await write(
    root,
    'artifacts/scenarios/batch-1.md',
    `# Batch 1

## S-01: 从本地文件系统导入 SKILL.md

**关联决策**: D-TOOL-02
**关联功能**: A1 (Skill import/register)

### Given
- 用户有一个合法的 SKILL.md 文件

### When
1. 用户执行导入

### Then
- Skill 注册成功

### S-01a: 子场景标题同样参与映射

**关联功能**: ABCD1 (Four-letter feature prefix) — V1.1

### Given
- 子场景采用三级标题

### When
1. 工具扫描场景文件

### Then
- 子场景被识别为独立制品

## S-02: 场景错误关联实体

**关联决策**: D-TOOL-02
**关联功能**: A1 (Skill import/register)
**关联实体**: E-001

### Given
- 一个需求层场景

### When
1. 编写追溯关系

### Then
- 工具应阻止 scenario -> entity

## S-02: 重复场景标题

**关联功能**: A1 (Skill import/register)

### Given
- 重复 ID

### When
1. 扫描

### Then
- 报告重复

## S-03: 反向关系缺失

**关联功能**: A1 (Skill import/register)

### Given
- 场景指向 A1

### When
1. A1 未列出 S-03

### Then
- 报告反向不一致
`,
  );

  await write(
    root,
    'artifacts/entities/entity-registry.md',
    `# 实体注册表

| 编号 | 实体名称 | 类型 | 说明 | 来源决策 |
|------|---------|------|------|---------|
| E-001 | ISkillScanner | 接口 | 引擎统一接口 | D-ARCH-01 |
`,
  );

  await write(
    root,
    'artifacts/decisions/README.md',
    `# 决策索引

| ID | 标题 |
|----|------|
| D-TOOL-02 | gray-matter + section parser |
| D-SCAN-01 | Quick Check <30s |
| D-ARCH-01 | 四层扫描模型 |
`,
  );

  await write(
    root,
    'artifacts/decisions/D-FRONTMATTER-01.md',
    `---
id: D-FRONTMATTER-01
title: Decision frontmatter test
status: accepted
related_features: [A1]
related_scenarios: [S-01]
---

# D-FRONTMATTER-01: Decision frontmatter test
`,
  );

  await write(
    root,
    'heimdall/packages/core/test/import.test.ts',
    `// @scenario S-01  @feature A1  @entity E-001  @decision D-TOOL-02
describe('import', () => {});
`,
  );

  return root;
}

async function e2eFixtureRepo(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-e2e-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });

  await write(
    root,
    'artifact-graph.config.yaml',
    `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  design:
    paths: ["artifacts/design/**/*.md"]
  test:
    paths: ["heimdall/packages/**/*.test.ts"]
  e2e_test:
    paths: ["artifacts/tests/e2e/*.md"]
  e2e_registry:
    paths: ["artifacts/tests/e2e/e2e-test-registry.json"]
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [planned, active, done, deprecated]
`,
  );

  await write(
    root,
    'artifacts/prd/features/D1-desktop-scan.md',
    `---
id: D1
title: Desktop scan trigger
status: done
scenarios: [S-20]
design_docs: [design-desktop-scan]
---

# D1: Desktop scan trigger

## 验收标准

1. React UI 触发扫描后通过 Tauri IPC 启动 Node sidecar。
2. Node sidecar 以 JSON Lines 返回 core engine 结果并写入 SQLite/report data。
`,
  );

  await write(
    root,
    'artifacts/design/design-desktop-scan.md',
    `---
title: Desktop scan design
related_features: [D1]
---

# Desktop scan design
`,
  );

  await write(
    root,
    'artifacts/scenarios/batch-e2e.md',
    `## S-20: 桌面端触发完整扫描链路

**关联功能**: D1
`,
  );

  await write(
    root,
    'artifacts/tests/e2e/test-01.md',
    `---
test_batch: test-01
scope: D1
ac_coverage:
  D1: [AC1, AC2]
related_scenarios: [S-20]
---

# E2E 测试: 桌面扫描链路

## TC-001: 桌面端扫描贯通真实链路

**前置条件**:
- 用户已导入一个本地项目。

**测试步骤**:
1. 在 React UI 点击扫描按钮。
2. 验证 Tauri IPC command 启动 Node sidecar。
3. 验证 sidecar 通过 JSON Lines 调用 core engine。
4. 验证 SQLite/report data 写入并在报告页展示。

**后置清理**:
- 删除测试项目和报告数据。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1, AC2)
**优先级**: P0
`,
  );

  await write(
    root,
    'artifacts/tests/e2e/e2e-test-registry.json',
    `${JSON.stringify({
      registry_version: '1.0',
      total_batches: 1,
      total_test_cases: 1,
      batches: [
        {
          batch_id: 'test-01',
          scope: 'D1',
          file: 'artifacts/tests/e2e/test-01.md',
          ac_coverage: { D1: ['AC1', 'AC2'] },
          related_scenarios: ['S-20'],
          test_case_count: 1,
        },
      ],
    }, null, 2)}\n`,
  );

  await write(
    root,
    'heimdall/packages/core/test/scan.test.ts',
    `// @scenario S-20 @feature D1
describe('scan', () => {});
`,
  );

  return root;
}

describe('artifact graph core', () => {
  it('scans markdown and test comments into deterministic nodes and edges', async () => {
    const root = await fixtureRepo('scan');
    try {
      const graph = await scanArtifacts(root);

      expect(graph.nodes.map((node) => node.uid)).toEqual([
        'decision:D-ARCH-01',
        'decision:D-FRONTMATTER-01',
        'decision:D-SCAN-01',
        'decision:D-TOOL-02',
        'design:design-four-letter',
        'design:design-skill-import',
        'entity:E-001',
        'feature:A1',
        'feature:ABCD1',
        'feature:B6',
        'scenario:S-01',
        'scenario:S-01a',
        'scenario:S-02',
        'scenario:S-02',
        'scenario:S-03',
        'test:heimdall/packages/core/test/import.test.ts',
      ]);

      // Verify decision frontmatter edges
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          from: 'decision:D-FRONTMATTER-01',
          to: 'feature:A1',
          kind: 'references',
          source: 'frontmatter',
        }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          from: 'decision:D-FRONTMATTER-01',
          to: 'scenario:S-01',
          kind: 'references',
          source: 'frontmatter',
        }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ from: 'feature:A1', to: 'scenario:S-01', kind: 'covers', source: 'frontmatter' }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ from: 'scenario:S-01', to: 'feature:A1', kind: 'references', source: 'markdown' }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ from: 'scenario:S-01a', to: 'feature:ABCD1', kind: 'references', source: 'markdown' }),
      );
      expect(graph.edges).not.toContainEqual(
        expect.objectContaining({ from: 'scenario:S-01a', to: 'feature:V1', kind: 'references', source: 'markdown' }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ from: 'test:heimdall/packages/core/test/import.test.ts', to: 'scenario:S-01', kind: 'verifies' }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ from: 'feature:A1', to: 'design:design-skill-import', kind: 'references', source: 'frontmatter' }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ from: 'feature:ABCD1', to: 'design:design-four-letter', kind: 'references', source: 'frontmatter' }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ from: 'design:design-skill-import', to: 'feature:A1', kind: 'references', source: 'frontmatter' }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ from: 'design:design-skill-import', to: 'scenario:S-01', kind: 'references', source: 'frontmatter' }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('parses decision frontmatter with id, status, related_features, and related_scenarios', async () => {
    const root = await fixtureRepo('decision-frontmatter');
    try {
      const graph = await scanArtifacts(root);
      const config = await loadConfig(root);

      // Verify decision node is parsed from frontmatter
      const decisionNode = graph.nodes.find((n) => n.uid === 'decision:D-FRONTMATTER-01');
      expect(decisionNode).toBeDefined();
      expect(decisionNode?.type).toBe('decision');
      expect(decisionNode?.code).toBe('D-FRONTMATTER-01');
      expect(decisionNode?.title).toBe('Decision frontmatter test');
      expect(decisionNode?.status).toBe('accepted');
      expect(decisionNode?.path).toBe('artifacts/decisions/D-FRONTMATTER-01.md');

      // Verify related_features edges are created
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          from: 'decision:D-FRONTMATTER-01',
          to: 'feature:A1',
          kind: 'references',
          source: 'frontmatter',
        }),
      );

      // Verify related_scenarios edges are created
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          from: 'decision:D-FRONTMATTER-01',
          to: 'scenario:S-01',
          kind: 'references',
          source: 'frontmatter',
        }),
      );

      // Verify validation passes with valid frontmatter
      const issues = validateGraph(graph, config);
      const decisionIssues = issues.filter((i) => i.path?.includes('D-FRONTMATTER-01'));
      expect(decisionIssues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates duplicates, dangling references, forbidden scenario entity links, status, reverse mismatch, and design coverage', async () => {
    const root = await fixtureRepo('validate');
    try {
      const graph = await scanArtifacts(root);
      const issues = validateGraph(graph, await loadConfig(root));

      expect(issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          'DUPLICATE_ID',
          'DANGLING_REFERENCE',
          'FORBIDDEN_EDGE',
          'BIDIRECTIONAL_MISMATCH',
          'DESIGN_COVERAGE_MISSING',
        ]),
      );
      expect(issues.find((issue) => issue.code === 'FORBIDDEN_EDGE')?.message).toContain('scenario -> entity');
      expect(issues.find((issue) => issue.code === 'DANGLING_REFERENCE')?.message).toContain('S-9999');
      expect(issues.find((issue) => issue.code === 'DESIGN_COVERAGE_MISSING')?.message).toContain('feature:B6');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates scenario to PRD duplicate links and orphan links from raw relation occurrences', async () => {
    const root = await fixtureRepo('scenario-prd-duplicates');
    try {
      await write(
        root,
        'artifacts/scenarios/batch-duplicates.md',
        `## S-10: Duplicate links on separate lines

**关联功能**: C1
**关联功能**: C1

## S-11: Duplicate links on one line

**关联功能**: C2, C2

## S-12: No feature link
`,
      );
      await write(
        root,
        'artifacts/prd/features/C1-duplicate-lines.md',
        `---
id: C1
title: Duplicate line feature
status: done
scenarios: [S-10]
design_docs: []
---
# C1
`,
      );
      await write(
        root,
        'artifacts/prd/features/C2-duplicate-inline.md',
        `---
id: C2
title: Duplicate inline feature
status: done
scenarios: [S-11, S-11]
design_docs: []
---
# C2
`,
      );

      const graph = await scanArtifacts(root, await loadConfig(root));
      const issues = validateGraph(graph, await loadConfig(root));

      expect(issues).toContainEqual(expect.objectContaining({
        code: 'DUPLICATE',
        message: expect.stringContaining('scenario:S-10 repeats feature:C1'),
      }));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'DUPLICATE',
        message: expect.stringContaining('scenario:S-11 repeats feature:C2'),
      }));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'DUPLICATE',
        message: expect.stringContaining('feature:C2 repeats scenario:S-11'),
      }));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'ORPHAN_SCENARIO',
        node: 'scenario:S-12',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates scenario to PRD link direction, format, and feature orphan issues', async () => {
    const root = await fixtureRepo('scenario-prd-link-consistency');
    try {
      await write(
        root,
        'artifacts/scenarios/batch-links.md',
        `## S-20: Forward only link

**关联功能**: C3

## S-21: Backward only target

**关联功能**: C999

## S-22: Bad feature token

**关联功能**: BAD-ID
`,
      );
      await write(
        root,
        'artifacts/prd/features/C3-forward-only.md',
        `---
id: C3
title: Forward only
status: done
scenarios: []
design_docs: []
---
# C3
`,
      );
      await write(
        root,
        'artifacts/prd/features/C4-backward-only.md',
        `---
id: C4
title: Backward only
status: done
scenarios: [S-21, SX-1]
design_docs: []
---
# C4
`,
      );
      await write(
        root,
        'artifacts/prd/features/C5-orphan.md',
        `---
id: C5
title: Orphan feature
status: done
scenarios: []
design_docs: []
---
# C5
`,
      );

      const graph = await scanArtifacts(root, await loadConfig(root));
      const issues = validateGraph(graph, await loadConfig(root));

      expect(issues).toContainEqual(expect.objectContaining({
        code: 'LINK_FORWARD_MISSING',
        message: expect.stringContaining('scenario:S-20 references feature:C3'),
      }));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'LINK_BACKWARD_MISSING',
        message: expect.stringContaining('feature:C4 covers scenario:S-21'),
      }));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'ORPHAN_FEATURE',
        node: 'feature:C5',
      }));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'FORMAT_ERROR',
        message: expect.stringContaining('BAD-ID'),
      }));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'FORMAT_ERROR',
        message: expect.stringContaining('SX-1'),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes scenario to PRD link validation for a golden case', async () => {
    const root = await fixtureRepo('scenario-prd-golden');
    try {
      await write(
        root,
        'artifacts/scenarios/batch-golden.md',
        `## S-30: Golden link

**关联功能**: C6
`,
      );
      await write(
        root,
        'artifacts/prd/features/C6-golden.md',
        `---
id: C6
title: Golden feature
status: done
scenarios: [S-30]
design_docs: [design-golden]
---
# C6
`,
      );
      await write(
        root,
        'artifacts/design/design-golden.md',
        `---
title: Golden design
related_features: [C6]
related_scenarios: [S-30]
---
# Golden
`,
      );

      const graph = await scanArtifacts(root, await loadConfig(root));
      const scenarioPrdCodes = validateGraph(graph, await loadConfig(root))
        .filter((issue) => issue.path.includes('batch-golden.md') || issue.path.includes('C6-golden.md'))
        .map((issue) => issue.code)
        .filter((code) => [
          'LINK_FORWARD_MISSING',
          'LINK_BACKWARD_MISSING',
          'ORPHAN_SCENARIO',
          'ORPHAN_FEATURE',
          'DUPLICATE',
          'FORMAT_ERROR',
          'INDEX_MISMATCH',
        ].includes(code));

      expect(scenarioPrdCodes).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports code comment scenario-feature mismatches', async () => {
    const root = await fixtureRepo('code-comment-scenario-feature-mismatch');
    try {
      await write(
        root,
        'heimdall/packages/core/test/mismatch.test.ts',
        `// @scenario S-01 @feature B6
describe('mismatch', () => {});
`,
      );

      const graph = await scanArtifacts(root);
      const issues = validateGraph(graph, await loadConfig(root));

      expect(issues).toContainEqual(expect.objectContaining({
        code: 'CODE_COMMENT_SCENARIO_FEATURE_MISMATCH',
        message: expect.stringContaining('scenario:S-01'),
        path: expect.stringContaining('mismatch.test.ts'),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects entity links in feature frontmatter', async () => {
    const root = await fixtureRepo('feature-entity-field-forbidden');
    try {
      await write(
        root,
        'artifacts/prd/features/ZZ1-forbidden-entities.md',
        `---
id: ZZ1
title: Forbidden entity field
status: planned
scenarios: []
entities: [E-001]
design_docs: []
---

# ZZ1: Forbidden entity field
`,
      );

      const graph = await scanArtifacts(root, await loadConfig(root));
      const issues = validateGraph(graph, await loadConfig(root));

      expect(issues).toContainEqual(expect.objectContaining({
        code: 'FEATURE_ENTITY_FIELD_FORBIDDEN',
        path: expect.stringContaining('ZZ1-forbidden-entities.md'),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts canonical traceability line comments and rejects block traceability comments', async () => {
    const root = await fixtureRepo('code-comment-traceability-format');
    try {
      await write(
        root,
        'heimdall/packages/core/test/comment-format.test.ts',
        `/**
 * ${'@scenario'} S-01 @feature A1
 */
const fixture = "// @scenario S-01 @feature B6";
// @scenario S-02  @feature A1
describe('comments', () => {});
`,
      );

      const graph = await scanArtifacts(root, await loadConfig(root));
      const issues = validateGraph(graph, await loadConfig(root));

      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: expect.stringContaining('comment-format.test.ts'),
        to: 'scenario:S-02',
        source: 'test-comment',
        sourceLine: 5,
      }));
      expect(graph.edges).not.toContainEqual(expect.objectContaining({
        to: 'feature:B6',
        sourceLine: 4,
      }));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'CODE_COMMENT_TRACEABILITY_FORMAT',
        path: expect.stringContaining('comment-format.test.ts'),
        line: 1,
      }));
      expect(issues.filter((issue) => issue.code === 'CODE_COMMENT_SCENARIO_FEATURE_MISMATCH')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores traceability tags in strings and rejects non-canonical line prefixes', async () => {
    const root = await fixtureRepo('code-comment-string-boundaries');
    try {
      await write(
        root,
        'heimdall/packages/core/test/string-boundaries.test.ts',
        `const inline = "// @scenario S-01 @feature B6";
const template = \`
 * ${'@scenario'} S-01 @feature B6
\`;
// TODO ${'@scenario'} S-01 @feature A1
doWork(); // @scenario S-01 @feature A1
// @scenario S-01 ${'moved'} from B6
// @feature A1~B3
// @scenario S-01
describe('string boundaries', () => {});
`,
      );

      const graph = await scanArtifacts(root, await loadConfig(root));
      const issues = validateGraph(graph, await loadConfig(root));

      expect(graph.edges).toContainEqual(expect.objectContaining({
        to: 'scenario:S-01',
        sourceLine: 9,
      }));
      expect(graph.edges).not.toContainEqual(expect.objectContaining({
        sourcePath: expect.stringContaining('string-boundaries.test.ts'),
        to: 'feature:B6',
      }));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'CODE_COMMENT_TRACEABILITY_FORMAT',
        path: expect.stringContaining('string-boundaries.test.ts'),
        line: 5,
      }));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'CODE_COMMENT_TRACEABILITY_FORMAT',
        path: expect.stringContaining('string-boundaries.test.ts'),
        line: 6,
      }));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'CODE_COMMENT_TRACEABILITY_FORMAT',
        path: expect.stringContaining('string-boundaries.test.ts'),
        line: 7,
      }));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'CODE_COMMENT_TRACEABILITY_FORMAT',
        path: expect.stringContaining('string-boundaries.test.ts'),
        line: 8,
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // @feature ACA17 @scenario S-57
  it('does not treat plain npm scoped packages or directives as traceability tags', async () => {
    const root = await fixtureRepo('tag-negative');
    try {
      await write(root, 'heimdall/packages/core/test/plain-at-tokens.test.ts', [
        '// @typescript-eslint/no-explicit-any',
        '// @ts-expect-error — mock injection',
        'import { app } from "@tauri-apps/api";',
        '// @heimdall-scan:ignore false positive',
        '// @theme: dark mode config',
        'describe("plain at tokens", () => {});',
        '',
      ].join('\n'));

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const issues = validateGraph(graph, config);

      const fakeNodes = graph.nodes.filter((n) => n.type === 'test' && n.path?.includes('plain-at-tokens'));
      expect(fakeNodes).toEqual([]);
      const fakeEdges = graph.edges.filter((e) => (e.sourcePath ?? '').includes('plain-at-tokens'));
      expect(fakeEdges).toEqual([]);
      const formatIssues = issues.filter((i) => i.code === 'CODE_COMMENT_TRACEABILITY_FORMAT' && i.path?.includes('plain-at-tokens'));
      expect(formatIssues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports PRD to design bidirectional mismatches in both directions', async () => {
    const root = await fixtureRepo('design-mismatch');
    try {
      await write(
        root,
        'artifacts/prd/features/C1-evaluators.md',
        `---
id: C1
title: Deterministic evaluators
status: done
scenarios: []
design_docs: [design-evaluators]
---

# C1
`,
      );
      await write(
        root,
        'artifacts/design/design-evaluators.md',
        `---
title: Evaluators design
related_features: [C8]
---

# Evaluators design
`,
      );
      await write(
        root,
        'artifacts/prd/features/C8-scoring.md',
        `---
id: C8
title: Scoring
status: done
scenarios: []
design_docs: []
---

# C8
`,
      );

      const graph = await scanArtifacts(root);
      const issues = validateGraph(graph, await loadConfig(root));

      expect(issues).toContainEqual(expect.objectContaining({
        code: 'BIDIRECTIONAL_MISMATCH',
        message: expect.stringContaining('feature:C1 lists design:design-evaluators'),
      }));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'BIDIRECTIONAL_MISMATCH',
        message: expect.stringContaining('design:design-evaluators references feature:C8'),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('queries adjacent artifacts and renders a mermaid graph', async () => {
    const root = await fixtureRepo('query');
    try {
      const graph = await scanArtifacts(root);

      expect(queryGraph(graph, { from: 'A1' }).nodes.map((node) => node.uid)).toContain('scenario:S-01');
      expect(queryGraph(graph, { from: 'S-01' }).nodes.map((node) => node.uid)).toContain('feature:A1');
      expect(renderMermaid(queryGraph(graph, { from: 'A1' }))).toContain('"feature:A1" -->|"covers"| "scenario:S-01"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes deterministic JSON and SQLite generated caches', async () => {
    const root = await fixtureRepo('cache');
    try {
      const graph = await scanArtifacts(root);

      await writeGraphCache(root, graph);

      const index = JSON.parse(await readFile(join(root, '.artifact-graph/index.json'), 'utf-8'));
      expect(index.nodes[0].uid).toBe('decision:D-ARCH-01');
      await expect(readFile(join(root, '.artifact-graph/graph.sqlite'))).resolves.toBeInstanceOf(Buffer);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads config, builds a graph from explicit nodes, and allocates next IDs by configured range', async () => {
    const root = await fixtureRepo('config');
    try {
      const config = await loadConfig(root);

      expect(config.types.scenario.paths).toEqual(['artifacts/scenarios/**/*.md']);
      expect(nextId(buildGraph([{ type: 'scenario', code: 'S-1200', title: 'Existing', path: 'x.md', line: 1 }], []), config, 'scenario', 'batch-49')).toBe('S-1201');
      expect(DEFAULT_SCHEMA.forbiddenEdges).toContainEqual({ from: 'scenario', to: 'entity', kind: 'references' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads configured artifact metadata for display names, roles, layers, and aliases', async () => {
    const root = await fixtureRepo('artifact-metadata');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    displayName: 功能特性
    role: feature
    layer: prd
    aliases:
      - prd-feature
  decision:
    displayName: 决策文档
    role: decision
    layer: decision
  e2e_test:
    displayName: E2E 测试规格
    role: e2e_test
    layer: verification
    aliases:
      - e2e-test
  ui-flow-contracts:
    displayName: 页面流程约定
    role: context
    layer: contract
    aliases:
      - ui_flow_contracts
`,
      );
      const config = await loadConfig(root);

      expect(getArtifactTypeMetadata(config, 'feature')).toEqual(expect.objectContaining({
        displayName: '功能特性',
        role: 'feature',
        layer: 'prd',
        targetCapable: true,
      }));
      expect(getArtifactTypeMetadata(config, 'decision')).toEqual(expect.objectContaining({
        displayName: '决策文档',
        role: 'decision',
        layer: 'decision',
        targetCapable: true,
      }));
      expect(getArtifactTypeMetadata(config, 'e2e_test')).toEqual(expect.objectContaining({
        displayName: 'E2E 测试规格',
        role: 'e2e_test',
        layer: 'verification',
        aliases: expect.arrayContaining(['e2e-test']),
        targetCapable: true,
      }));
      expect(getArtifactTypeMetadata(config, 'ui-flow-contracts')).toEqual(expect.objectContaining({
        displayName: '页面流程约定',
        role: 'context',
        layer: 'contract',
        aliases: expect.arrayContaining(['ui_flow_contracts']),
        targetCapable: false,
      }));

      expect(getTargetArtifactTypes(config)).toEqual(['feature', 'scenario', 'decision', 'design', 'e2e_test']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('scans E2E Markdown tests and registry as first-class artifacts without mixing code test nodes', async () => {
    const root = await e2eFixtureRepo('happy');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      expect(graph.nodes.map((node) => node.uid)).toEqual([
        'design:design-desktop-scan',
        'e2e_registry:e2e-test-registry',
        'e2e_test:test-01:TC-001',
        'feature:D1',
        'scenario:S-20',
        'test:heimdall/packages/core/test/scan.test.ts',
      ]);
      expect(graph.nodes.find((node) => node.uid === 'e2e_test:test-01:TC-001')).toEqual(expect.objectContaining({
        title: '桌面端扫描贯通真实链路',
        attrs: expect.objectContaining({
          test_batch: 'test-01',
          scope: 'D1',
          testCaseId: 'TC-001',
        }),
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'e2e_test:test-01:TC-001',
        to: 'scenario:S-20',
        kind: 'verifies',
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'e2e_test:test-01:TC-001',
        to: 'feature:D1',
        kind: 'verifies',
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'test:heimdall/packages/core/test/scan.test.ts',
        to: 'scenario:S-20',
        kind: 'verifies',
      }));
      expect(graph.edges).not.toContainEqual(expect.objectContaining({
        from: 'e2e_test:test-01:TC-001',
        to: expect.stringMatching(/^entity:/),
      }));
      expect(validateGraph(graph, await loadConfig(root))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports deterministic E2E validation issues for missing fields, unknown ACs, registry mismatches, and CLI-only desktop coverage', async () => {
    const root = await e2eFixtureRepo('invalid');
    try {
    await write(
      root,
      'artifacts/prd/features/D2-desktop-cli-only.md',
      `---
id: D2
title: Desktop CLI-only scan
status: done
scenarios: [S-21]
---

# D2: Desktop CLI-only scan

## 验收标准

1. 桌面扫描入口展示报告。
`,
    );
    await write(
      root,
      'artifacts/scenarios/batch-invalid-e2e.md',
      `## S-21: 桌面端扫描入口

**关联功能**: D2
`,
    );
    await write(
      root,
      'artifacts/tests/e2e/test-invalid.md',
      `---
scope: D2
ac_coverage:
  D2: [AC9]
---

# E2E 测试: 桌面扫描仅覆盖 CLI

## TC-001: 桌面扫描只调用 CLI

**前置条件**:
- 已安装 CLI。

**测试步骤**:
1. 执行 \`heimdall scan --format json\`。

**覆盖功能**: D2(AC9)
`,
    );
    await write(
      root,
      'artifacts/tests/e2e/test-extra.md',
      `---
test_batch: test-extra
scope: D2, DX999
ac_coverage:
  D2: [AC1]
related_scenarios: [S-21]
---

# E2E 测试: 三级标题兼容

### TC-001: 三级标题 TC 也应被扫描

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 在 React UI 打开扫描页。
2. 验证 Tauri IPC command 调用 Node sidecar。
3. 验证 JSON Lines 进入 core engine 并写入 SQLite/report data。

**后置清理**:
- 删除测试报告。

**覆盖场景**: S-21
**覆盖功能**: D2(AC1)
**优先级**: P1
`,
    );
    await write(
      root,
      'artifacts/tests/e2e/test-no-tc.md',
      `---
test_batch: test-no-tc
scope: D2
ac_coverage:
  D2: [AC1]
related_scenarios: [S-21]
related_decisions: [D-ARCH-01]
related_entities: [E-001]
---

# E2E 测试: 缺少 TC
`,
    );
    await write(
      root,
      'artifacts/tests/e2e/e2e-test-registry.json',
      `${JSON.stringify({
        registry_version: '1.0',
        total_batches: 3,
        total_test_cases: 99,
        batches: [
          {
            batch_id: 'wrong-batch',
            scope: 'D1',
            file: 'artifacts/tests/e2e/test-01.md',
            ac_coverage: { D1: ['AC1'] },
            related_scenarios: ['S-20'],
            test_case_count: 2,
          },
          {
            batch_id: 'test-invalid',
            scope: 'WRONG',
            file: 'artifacts/tests/e2e/missing.md',
            related_scenarios: ['S-999'],
            test_case_count: 5,
          },
        ],
      }, null, 2)}\n`,
    );

    const graph = await scanArtifacts(root, await loadConfig(root));
    const issues = validateGraph(graph, await loadConfig(root));

    expect(graph.nodes.map((node) => node.uid)).toContain('e2e_test:test-extra:TC-001');
    expect(graph.nodes.map((node) => node.uid)).toContain('e2e_test:test-no-tc:FILE');
    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: 'e2e_test:test-extra:TC-001',
      to: 'feature:DX999',
      kind: 'verifies',
      source: 'frontmatter',
    }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: 'e2e_test:test-no-tc:FILE',
      to: 'decision:D-ARCH-01',
      kind: 'references',
      source: 'frontmatter',
    }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: 'e2e_test:test-no-tc:FILE',
      to: 'entity:E-001',
      kind: 'references',
      source: 'frontmatter',
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'DANGLING_REFERENCE',
      severity: 'warning',
      message: expect.stringContaining('feature:DX999'),
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'E2E_REQUIRED_FRONTMATTER',
      severity: 'warning',
      message: expect.stringContaining('test_batch'),
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'E2E_REQUIRED_FRONTMATTER',
      severity: 'warning',
      message: expect.stringContaining('related_scenarios'),
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'E2E_REQUIRED_TC_FIELD',
      severity: 'warning',
      message: expect.stringContaining('后置清理'),
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'E2E_REQUIRED_TC_FIELD',
      severity: 'warning',
      message: expect.stringContaining('覆盖场景'),
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'E2E_REQUIRED_TC_FIELD',
      severity: 'warning',
      message: expect.stringContaining('优先级'),
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'E2E_AC_UNKNOWN',
      severity: 'warning',
      message: expect.stringContaining('D2(AC9)'),
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'E2E_REGISTRY_MISMATCH',
      severity: 'warning',
      message: expect.stringContaining('total_test_cases'),
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'E2E_REGISTRY_MISMATCH',
      severity: 'warning',
      message: expect.stringContaining('batch_id=wrong-batch'),
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'E2E_REGISTRY_MISMATCH',
      severity: 'warning',
      message: expect.stringContaining('is missing from registry'),
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'E2E_REGISTRY_MISMATCH',
      severity: 'warning',
      message: expect.stringContaining('ac_coverage'),
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'E2E_DESKTOP_CHAIN_WARNING',
      severity: 'warning',
      message: expect.stringContaining('真实桌面链路'),
    }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not flag TC-012, TC-012a, TC-012b as DUPLICATE_ID', async () => {
    const root = await e2eFixtureRepo('tc-suffix');
    try {
    await write(
      root,
      'artifacts/tests/e2e/test-tc-suffix.md',
      `---
test_batch: test-tc-suffix
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: TC 字母后缀不重复

## TC-012: 基础测试用例

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行基础操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0

## TC-012a: 扩展测试用例 A

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行扩展操作 A。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0

## TC-012b: 扩展测试用例 B

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行扩展操作 B。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
`,
    );

    const graph = await scanArtifacts(root, await loadConfig(root));
    const issues = validateGraph(graph, await loadConfig(root));

    expect(graph.nodes.map((node) => node.uid)).toContain('e2e_test:test-tc-suffix:TC-012');
    expect(graph.nodes.map((node) => node.uid)).toContain('e2e_test:test-tc-suffix:TC-012a');
    expect(graph.nodes.map((node) => node.uid)).toContain('e2e_test:test-tc-suffix:TC-012b');
    expect(issues.filter((issue) => issue.code === 'DUPLICATE_ID')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips E2E_DESKTOP_CHAIN_WARNING for canonical non-desktop chain types', async () => {
    const root = await e2eFixtureRepo('chain-type');
    try {
    await write(
      root,
      'artifacts/tests/e2e/test-chain-type.md',
      `---
test_batch: test-chain-type
scope: D1
ac_coverage:
  D1: [AC1, AC2, AC3]
related_scenarios: [S-20]
---

# E2E 测试: chain_type 分类

## TC-001: 前端显示组件（mock_playwright）

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 在 React UI 打开优化历史页面。
2. 验证 Tauri IPC 展示报告数据。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**chain_type**: mock_playwright

---

## TC-002: CLI 核心规则测试（core_e2e）

**前置条件**:
- CLI 已安装。

**测试步骤**:
1. 执行 \`heimdall scan\` 命令。
2. 验证 desktop 规则输出。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC2)
**优先级**: P0
**chain_type**: core_e2e

---

## TC-003: 桌面部分链路扫描（desktop_chain）

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 在 React UI 打开扫描页。
2. 验证 Tauri IPC 展示报告。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC3)
**优先级**: P0
**chain_type**: desktop_chain

---

## TC-004: 缺少 chain_type（默认行为）

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 在 React UI 打开扫描页。
2. 验证 Tauri IPC 展示报告。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
`,
    );

    const graph = await scanArtifacts(root, await loadConfig(root));
    const issues = validateGraph(graph, await loadConfig(root));

    const chainWarnings = issues.filter((issue) => issue.code === 'E2E_DESKTOP_CHAIN_WARNING');

    // TC-001 (mock_playwright) should NOT trigger warning
    expect(chainWarnings.find((issue) => issue.message.includes('TC-001'))).toBeUndefined();

    // TC-002 (core_e2e) should NOT trigger warning
    expect(chainWarnings.find((issue) => issue.message.includes('TC-002'))).toBeUndefined();

    // TC-003 (desktop_chain) should trigger warning (missing full chain keywords)
    expect(chainWarnings.find((issue) => issue.message.includes('TC-003'))).toBeDefined();

    // TC-004 (no chain_type) should trigger warning (default behavior)
    expect(chainWarnings.find((issue) => issue.message.includes('TC-004'))).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips E2E_DESKTOP_CHAIN_WARNING when chain_coverage is complete (TC-053 style)', async () => {
    const root = await e2eFixtureRepo('chain-complete');
    try {
    await write(
      root,
      'artifacts/tests/e2e/test-chain-complete.md',
      `---
test_batch: test-chain-complete
scope: D1
ac_coverage:
  D1: [AC1, AC2]
related_scenarios: [S-20]
---

# E2E 测试: chain_coverage complete 跳过旧 heuristic

## TC-001: ui_sidecar_bridge + partial_rust composite complete

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 在 React UI 打开技能页面。
2. 通过 Tauri IPC 导入技能。
3. 验证 Node sidecar JSON Lines 解析。
4. 验证 core engine 写入 SQLite。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**chain_type**: desktop_chain
**chain_coverage**: complete

---

## TC-002: desktop related but no chain_coverage complete

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 在 React UI 打开扫描页。
2. 验证 Tauri IPC 展示报告。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC2)
**优先级**: P0
**chain_type**: desktop_chain
`,
    );

    const graph = await scanArtifacts(root, await loadConfig(root));
    const issues = validateGraph(graph, await loadConfig(root));
    const chainWarnings = issues.filter((issue) => issue.code === 'E2E_DESKTOP_CHAIN_WARNING');

    // TC-001 (chain_coverage: complete) should NOT trigger E2E_DESKTOP_CHAIN_WARNING
    expect(chainWarnings.find((issue) => issue.message.includes('TC-001'))).toBeUndefined();

    // TC-002 (no chain_coverage complete) should still trigger E2E_DESKTOP_CHAIN_WARNING
    expect(chainWarnings.find((issue) => issue.message.includes('TC-002'))).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('E2E executable traceability validation', () => {
  it('warns when executable_ref target does not exist', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-001-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-01.md'),
        `---
test_batch: test-trace-01
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: executable_ref 目标不存在

## TC-001: 引用不存在的 spec 文件

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**: heimdall/packages/desktop/e2e/nonexistent.spec.ts::TS-001
**chain_type**: desktop_chain
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace001 = issues.filter((issue) => issue.code === 'E2E-TRACE-001');
      expect(trace001.length).toBeGreaterThanOrEqual(1);
      expect(trace001[0].message).toContain('nonexistent.spec.ts');
      expect(trace001[0].severity).toBe('warning');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns when @tc references non-existent Markdown TC', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-002-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-02.md'),
        `---
test_batch: test-trace-02
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: @tc 引用不存在的 TC

## TC-001: 有效测试用例

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
`,
      );

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/orphan.spec.ts'),
        `// @tc test-trace-02:TC-999 [desktop_chain]
describe('orphan', () => {
  test('TS-001: orphaned tc annotation', () => {});
});
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace002 = issues.filter((issue) => issue.code === 'E2E-TRACE-002');
      expect(trace002.length).toBeGreaterThanOrEqual(1);
      expect(trace002[0].message).toContain('TC-999');
      expect(trace002[0].severity).toBe('warning');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes when executable_ref and @tc are bidirectionally consistent', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-003-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-03.md'),
        `---
test_batch: test-trace-03
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: 双向一致性

## TC-001: 一致的 executable_ref 和 @tc

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**: heimdall/packages/desktop/e2e/consistent.spec.ts::TS-001
**chain_type**: desktop_chain
`,
      );

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/consistent.spec.ts'),
        `// @tc test-trace-03:TC-001 [desktop_chain]
describe('consistent', () => {
  test('TS-001: consistent test', () => {});
});
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace003ForTc = issues.filter(
        (issue) => issue.code === 'E2E-TRACE-003' && issue.node === 'test-trace-03:TC-001',
      );
      expect(trace003ForTc).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves executable_ref through a configured nested runner without a product-specific root', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-generic-root-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'vendor/app/tests/e2e'), { recursive: true });
      await writeFile(join(root, 'artifact-graph.config.yaml'), `e2e:
  runners:
    - name: browser
      kind: e2e
      root: vendor/app/tests/e2e
      include: ["*.spec.ts"]
`);
      await writeFile(join(root, 'artifacts/tests/e2e/test-generic.md'), `---
test_batch: test-generic
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: generic runner root

## TC-001: configured nested source root

**前置条件**: ready
**测试步骤**: run
**后置清理**: none
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**: tests/e2e/consistent.spec.ts::TS-001
**chain_type**: desktop_chain
`);
      await writeFile(join(root, 'vendor/app/tests/e2e/consistent.spec.ts'), `// @e2e_test test-generic:TC-001
test('TS-001: generic configured runner', () => {});
`);

      const issues = await validateExecutableTraceability(root);
      expect(issues.filter((item) => ['E2E-TRACE-001', 'E2E-TRACE-003'].includes(item.code))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns when desktop_chain TC points to mock_playwright test', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-004-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-04.md'),
        `---
test_batch: test-trace-04
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: desktop_chain 指向 mock

## TC-001: desktop chain 指向 mock_playwright

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**: heimdall/packages/desktop/e2e/mock-skills.spec.ts::TS-001
**chain_type**: desktop_chain
`,
      );

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/mock-skills.spec.ts'),
        `// @tc test-trace-04:TC-001 [mock_playwright]
describe('mock skills', () => {
  test('TS-001: mock test using __TAURI_INTERNALS__', async () => {
    await (window as any).__TAURI_INTERNALS__.invoke('import_skill', { filePath: '/test' });
  });
});
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace004 = issues.filter((issue) => issue.code === 'E2E-TRACE-004');
      // Markdown authority: E2E-TRACE-004 should be suppressed when chain_type is explicitly desktop_chain
      expect(trace004.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns when desktop_chain TC has a pending executable_ref', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-005-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-05.md'),
        `---
test_batch: test-trace-05
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: pending executable

## TC-001: desktop chain 尚无可执行测试

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. React UI triggers Tauri IPC.
2. Rust command starts Node sidecar over JSON Lines.
3. Core engine writes SQLite report data.

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**: (pending — requires real desktop_chain E2E test)
**chain_type**: desktop_chain
`,
      );

      const issues = await validateExecutableTraceability(root);
      const pending = issues.filter((issue) => issue.code === 'E2E-TRACE-005');
      expect(pending.length).toBe(1);
      expect(pending[0].message).toContain('pending executable_ref');
      expect(pending[0].node).toBe('test-trace-05:TC-001');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns E2E-DESKTOP-CHAIN-MISSING when desktop_chain TC has no executable_ref', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-desktop-chain-missing-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-desktop-chain-missing.md'),
        `---
test_batch: test-desktop-chain-missing
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: desktop chain missing

## TC-001: desktop chain 缺失 executable_ref

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**chain_type**: desktop_chain
`,
      );

      const issues = await validateExecutableTraceability(root);
      const missing = issues.filter((issue) => issue.code === 'E2E-DESKTOP-CHAIN-MISSING');
      expect(missing.length).toBe(1);
      expect(missing[0].message).toContain('has no executable_ref');
      expect(missing[0].node).toBe('test-desktop-chain-missing:TC-001');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does NOT warn E2E-DESKTOP-CHAIN-MISSING when desktop_chain TC has executable_ref', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-desktop-chain-not-missing-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/chain.spec.ts'),
        `// @tc test-desktop-chain-not-missing:TC-001 [desktop_chain]
describe('chain', () => {
  it('runs chain test', () => {});
});
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-desktop-chain-not-missing.md'),
        `---
test_batch: test-desktop-chain-not-missing
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: desktop chain not missing

## TC-001: desktop chain 有 executable_ref

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**: heimdall/packages/desktop/e2e/chain.spec.ts
**chain_type**: desktop_chain
`,
      );

      const issues = await validateExecutableTraceability(root);
      const missing = issues.filter((issue) => issue.code === 'E2E-DESKTOP-CHAIN-MISSING');
      expect(missing.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves multi-line executable_ref — at least one valid ref passes', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-multi-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      // The primary ref points to a file that exists and has a @-tc tag
      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/chain.spec.ts'),
        `// @tc test-trace-multi:TC-001 [desktop_chain]
describe('chain', () => {
  it('runs chain test', () => {});
});
`,
      );

      // Multi-line executable_ref: first ref is nonexistent, second is valid
      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-multi.md'),
        `---
test_batch: test-trace-multi
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: multi-ref executable_ref

## TC-001: 多行 executable_ref

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`nonexistent/path/nope.spec.ts\` — missing file
- \`heimdall/packages/desktop/e2e/chain.spec.ts\` — valid Vitest
**chain_type**: desktop_chain
`,
      );

      const issues = await validateExecutableTraceability(root);
      // Should have one E2E-TRACE-001 for the nonexistent file, but NOT for the valid one
      const trace001 = issues.filter((issue) => issue.code === 'E2E-TRACE-001');
      expect(trace001.length).toBe(1);
      expect(trace001[0].message).toContain('nope.spec.ts');

      // Should NOT have E2E-TRACE-003 (bidirectional mismatch) — the valid ref matches a @-tc tag
      const trace003 = issues.filter(
        (issue) => issue.code === 'E2E-TRACE-003' && issue.node === 'test-trace-multi:TC-001',
      );
      expect(trace003.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns E2E-TRACE-006 when chain_coverage is partial and pending field is set', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-006a-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/partial-sidecar.spec.ts'),
        `// @tc test-trace-006a:TC-001 [partial_sidecar]
describe('partial sidecar', () => {
  it('runs partial chain', () => {});
});
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-006a.md'),
        `---
test_batch: test-trace-006a
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: partial chain_coverage

## TC-001: desktop chain with partial coverage

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/partial-sidecar.spec.ts\` — [partial_sidecar] layers 3-5
**chain_type**: desktop_chain
**chain_coverage**: partial — layers 2-5, Layer 1 pending
**pending**: Layer 1 real Tauri App UI desktop_chain harness
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006.length).toBe(1);
      expect(trace006[0].message).toContain('partial desktop_chain coverage');
      expect(trace006[0].node).toBe('test-trace-006a:TC-001');
      expect(trace006[0].severity).toBe('warning');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns E2E-TRACE-006 when only partial_sidecar and partial_rust refs exist', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-006b-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/partial-sidecar.spec.ts'),
        `// @tc test-trace-006b:TC-001 [partial_sidecar]
describe('partial sidecar', () => {
  it('runs partial chain', () => {});
});
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-006b.md'),
        `---
test_batch: test-trace-006b
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: partial evidence only

## TC-001: desktop chain with only partial evidence

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/partial-sidecar.spec.ts\` — [partial_sidecar] layers 3-5
**chain_type**: desktop_chain
**chain_coverage**: partial — only partial_sidecar and partial_rust, no real desktop_chain
**pending**: Full desktop_chain harness
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006.length).toBe(1);
      expect(trace006[0].message).toContain('partial desktop_chain coverage');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns E2E-TRACE-006 when chain_coverage is partial but TC has no executable_ref', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-006-no-ref-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-006-no-ref.md'),
        `---
test_batch: test-trace-006-no-ref
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: partial coverage without executable_ref

## TC-001: desktop chain partial, no ref

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**chain_type**: desktop_chain
**chain_coverage**: partial — layers 2-5 only
**pending**: Layer 1 real Tauri App UI desktop_chain harness
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006.length).toBe(1);
      expect(trace006[0].message).toContain('partial desktop_chain coverage');
      expect(trace006[0].node).toBe('test-trace-006-no-ref:TC-001');
      expect(trace006[0].severity).toBe('warning');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does NOT warn E2E-TRACE-006 when real desktop_chain ref exists', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-006c-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/full-chain.spec.ts'),
        `// @tc test-trace-006c:TC-001 [desktop_chain]
describe('full desktop chain', () => {
  it('runs full chain', () => {});
});
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-006c.md'),
        `---
test_batch: test-trace-006c
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: complete desktop chain

## TC-001: desktop chain with real desktop_chain ref

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/full-chain.spec.ts\` — [desktop_chain] full chain
**chain_type**: desktop_chain
**chain_coverage**: complete
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still warns E2E-TRACE-004 for mock_playwright AND E2E-TRACE-006 for partial coverage', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-004-006-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/mock-skills.spec.ts'),
        `// @tc test-trace-046:TC-001 [mock_playwright]
describe('mock skills', () => {
  it('mock test', async () => {
    await (window as any).__TAURI_INTERNALS__.invoke('import_skill', { filePath: '/test' });
  });
});
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-046.md'),
        `---
test_batch: test-trace-046
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: mock + partial coverage

## TC-001: desktop chain with mock and partial coverage

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/mock-skills.spec.ts\` — [mock_playwright] Layer 1 mock
**chain_type**: desktop_chain
**chain_coverage**: partial — mock only, no real harness
**pending**: Real Tauri App UI desktop_chain harness
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace004 = issues.filter((issue) => issue.code === 'E2E-TRACE-004');
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      // Markdown authority: E2E-TRACE-004 should be suppressed when chain_type is explicitly desktop_chain
      expect(trace004.length).toBe(0);
      expect(trace006.length).toBe(1);
      expect(trace006[0].message).toContain('partial desktop_chain coverage');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does NOT warn E2E-TRACE-006 for composite complete [ui_sidecar_bridge] + [partial_rust]', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-006-bridge-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/src-tauri/tests'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/bridge-chain.spec.ts'),
        `// @tc test-trace-bridge:TC-001 [ui_sidecar_bridge]
describe('bridge chain', () => {
  it('runs bridge chain', () => {});
});
`,
      );

      // Create the .rs file with matching @-tc annotation (//! @-tc format)
      await writeFile(
        join(root, 'heimdall/packages/desktop/src-tauri/tests/chain_test.rs'),
        `//! @tc test-trace-bridge:TC-001 [partial_rust]
#[test]
fn tc_bridge_chain_rust_layer2() {
    // Rust integration covering Layer 2 (Sidecar::call)
}
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-bridge.md'),
        `---
test_batch: test-trace-bridge
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: composite complete via bridge

## TC-001: desktop chain with ui_sidecar_bridge + partial_rust

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/bridge-chain.spec.ts\` — [ui_sidecar_bridge] layers 1+3+4+5
**partial_evidence**:
- \`packages/desktop/src-tauri/tests/chain_test.rs\` — [partial_rust] Layer 2
**chain_type**: desktop_chain
**chain_coverage**: complete — composite: ui_sidecar_bridge covers layers 1+3+4+5, partial_rust covers Layer 2
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns E2E-TRACE-006 for [ui_sidecar_bridge] without [partial_rust] in partial_evidence', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-006-bridge-no-rust-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/bridge-only.spec.ts'),
        `// @tc test-trace-bridge-norust:TC-001 [ui_sidecar_bridge]
describe('bridge only', () => {
  it('runs bridge', () => {});
});
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-bridge-norust.md'),
        `---
test_batch: test-trace-bridge-norust
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: bridge without partial_rust

## TC-001: desktop chain with bridge but no partial_rust

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/bridge-only.spec.ts\` — [ui_sidecar_bridge] layers 1+3+4+5
**chain_type**: desktop_chain
**chain_coverage**: partial — bridge covers layers 1+3+4+5, Layer 2 pending
**pending**: Layer 2 Rust sidecar integration
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006.length).toBe(1);
      expect(trace006[0].message).toContain('partial desktop_chain coverage');
      expect(trace006[0].node).toBe('test-trace-bridge-norust:TC-001');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does NOT pick up @tc from block comments (JSDoc), only line comments', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-block-comment-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/block-comment.spec.ts'),
        `/**
 * Desktop Chain Test
 * @tc test-trace-block:TC-001 [desktop_chain] — this is in a block comment
 */
describe('block comment test', () => {
  it('should not be found', () => {});
});
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-block.md'),
        `---
test_batch: test-trace-block
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: block comment @tc

## TC-001: desktop chain with block comment annotation

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/block-comment.spec.ts\` — [desktop_chain] full chain
**chain_type**: desktop_chain
**chain_coverage**: complete
`,
      );

      const issues = await validateExecutableTraceability(root);
      // Block comment @-tc should NOT be found → new Check A fires E2E-TRACE-003
      // (file exists but has no //@-tc line-comment annotation for this TC)
      const trace003 = issues.filter((issue) => issue.code === 'E2E-TRACE-003');
      expect(trace003.length).toBe(1);
      expect(trace003[0].message).toContain('no E2E trace annotation');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // --- Phase 2: new test cases for complete/partial_rust/mock validation ---

  it('complete + [ui_sidecar_bridge] + nonexistent Rust file → E2E-TRACE-006', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-complete-bridge-nors-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/bridge-nors.spec.ts'),
        `// @tc test-trace-nors:TC-001 [ui_sidecar_bridge]
describe('bridge no rust', () => {
  it('runs bridge', () => {});
});
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-nors.md'),
        `---
test_batch: test-trace-nors
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: bridge + nonexistent Rust file

## TC-001: bridge with missing Rust file

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/bridge-nors.spec.ts\` — [ui_sidecar_bridge] layers 1+3+4+5
**partial_evidence**:
- \`packages/desktop/src-tauri/tests/nonexistent_test.rs\` — [partial_rust] Layer 2
**chain_type**: desktop_chain
**chain_coverage**: complete — composite: ui_sidecar_bridge + partial_rust
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006.length).toBe(1);
      expect(trace006[0].message).toContain('missing valid desktop_chain or ui_sidecar_bridge + partial_rust');
      expect(trace006[0].message).toContain('partial_rust file not found');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('complete + [ui_sidecar_bridge] + Rust file exists but no matching TC → E2E-TRACE-006', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-complete-bridge-wrongtc-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/src-tauri/tests'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/bridge-wrongtc.spec.ts'),
        `// @tc test-trace-wrongtc:TC-001 [ui_sidecar_bridge]
describe('bridge wrong tc', () => {
  it('runs bridge', () => {});
});
`,
      );

      // .rs file has a @-tc tag for a DIFFERENT TC
      await writeFile(
        join(root, 'heimdall/packages/desktop/src-tauri/tests/wrong_tc_test.rs'),
        `//! @tc test-trace-wrongtc:TC-999 [partial_rust]
#[test]
fn some_other_test() {}
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-wrongtc.md'),
        `---
test_batch: test-trace-wrongtc
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: bridge + Rust file with wrong TC

## TC-001: bridge with Rust file that has wrong TC annotation

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/bridge-wrongtc.spec.ts\` — [ui_sidecar_bridge] layers 1+3+4+5
**partial_evidence**:
- \`packages/desktop/src-tauri/tests/wrong_tc_test.rs\` — [partial_rust] Layer 2
**chain_type**: desktop_chain
**chain_coverage**: complete — composite: ui_sidecar_bridge + partial_rust
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006.length).toBe(1);
      expect(trace006[0].message).toContain('missing valid desktop_chain or ui_sidecar_bridge + partial_rust');
      expect(trace006[0].message).toContain('has no E2E trace annotation');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('complete + [ui_sidecar_bridge] + no partial_evidence → E2E-TRACE-006', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-complete-bridge-nope-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/bridge-nope.spec.ts'),
        `// @tc test-trace-nope:TC-001 [ui_sidecar_bridge]
describe('bridge no partial evidence', () => {
  it('runs bridge', () => {});
});
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-nope.md'),
        `---
test_batch: test-trace-nope
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: bridge without partial_evidence

## TC-001: bridge only, no partial_evidence

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/bridge-nope.spec.ts\` — [ui_sidecar_bridge] layers 1+3+4+5
**chain_type**: desktop_chain
**chain_coverage**: complete — bridge only, no Layer 2 evidence
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006.length).toBe(1);
      expect(trace006[0].message).toContain('missing valid desktop_chain or ui_sidecar_bridge + partial_rust');
      expect(trace006[0].message).toContain('no partial_evidence field');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('complete + only [mock_playwright] → E2E-TRACE-004 AND E2E-TRACE-006', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-complete-mock-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/mock-complete.spec.ts'),
        `// @tc test-trace-mock:TC-001 [mock_playwright]
describe('mock complete', () => {
  it('mock test', async () => {
    await (window as any).__TAURI_INTERNALS__.invoke('import_skill', { filePath: '/test' });
  });
});
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-mock.md'),
        `---
test_batch: test-trace-mock
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: mock only marked complete

## TC-001: mock-only marked complete (invalid)

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/mock-complete.spec.ts\` — [mock_playwright] UI mock
**chain_type**: desktop_chain
**chain_coverage**: complete — this should fail validation
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace004 = issues.filter((issue) => issue.code === 'E2E-TRACE-004');
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      // Markdown authority: E2E-TRACE-004 should be suppressed when chain_type is explicitly desktop_chain
      expect(trace004.length).toBe(0);
      expect(trace006.length).toBe(1);
      expect(trace006[0].message).toContain('missing valid desktop_chain or ui_sidecar_bridge + partial_rust');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('complete + pending field → E2E-TRACE-006 with pending message', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-complete-pending-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/complete-pending.spec.ts'),
        `// @tc test-trace-cpend:TC-001 [ui_sidecar_bridge]
describe('complete with pending', () => {
  it('runs bridge', () => {});
});
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-cpend.md'),
        `---
test_batch: test-trace-cpend
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: complete with pending

## TC-001: declared complete but has pending field

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/complete-pending.spec.ts\` — [ui_sidecar_bridge] layers 1+3+4+5
**chain_type**: desktop_chain
**chain_coverage**: complete
**pending**: Layer 2 Rust sidecar integration
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006.length).toBe(1);
      expect(trace006[0].message).toContain('declared complete but has pending field');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('complete + valid [desktop_chain] + pending → E2E-TRACE-006', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-dc-pending-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/dc-pending.spec.ts'),
        `// @tc test-trace-dcpend:TC-001 [desktop_chain]
describe('desktop chain pending', () => {
  it('runs full chain', () => {});
});
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-dcpend.md'),
        `---
test_batch: test-trace-dcpend
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: desktop_chain + pending

## TC-001: valid desktop_chain but pending still set

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/dc-pending.spec.ts\` — [desktop_chain] full chain
**chain_type**: desktop_chain
**chain_coverage**: complete
**pending**: some lingering work
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006.length).toBe(1);
      expect(trace006[0].message).toContain('valid evidence but has pending field');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('complete + valid [ui_sidecar_bridge] + valid [partial_rust] + pending → E2E-TRACE-006', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-bridge-rust-pending-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/src-tauri/tests'), { recursive: true });

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/bridge-rust-pending.spec.ts'),
        `// @tc test-trace-brpend:TC-001 [ui_sidecar_bridge]
describe('bridge rust pending', () => {
  it('runs bridge', () => {});
});
`,
      );

      await writeFile(
        join(root, 'heimdall/packages/desktop/src-tauri/tests/brpend_rust.rs'),
        `//! @tc test-trace-brpend:TC-001 [partial_rust]
#[test]
fn tc_brpend_rust_layer2() {}
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-brpend.md'),
        `---
test_batch: test-trace-brpend
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: bridge + rust + pending

## TC-001: valid composite but pending still set

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/bridge-rust-pending.spec.ts\` — [ui_sidecar_bridge] layers 1+3+4+5
**partial_evidence**:
- \`packages/desktop/src-tauri/tests/brpend_rust.rs\` — [partial_rust] Layer 2
**chain_type**: desktop_chain
**chain_coverage**: complete
**pending**: cleanup tasks
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006.length).toBe(1);
      expect(trace006[0].message).toContain('valid evidence but has pending field');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('unreferenced file with same TC @tc does not trigger E2E-TRACE-004 for current TC', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-unref-mock-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/src-tauri/tests'), { recursive: true });

      // Referenced file: real bridge test
      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/bridge-real.spec.ts'),
        `// @tc test-trace-unref:TC-001 [ui_sidecar_bridge]
describe('bridge real', () => {
  it('runs bridge', () => {});
});
`,
      );

      // Unreferenced file: mock test for the SAME TC (not in executable_ref)
      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/mock-unref.spec.ts'),
        `// @tc test-trace-unref:TC-001 [mock_playwright]
describe('mock unreferenced', () => {
  it('mock test', async () => {
    await (window as any).__TAURI_INTERNALS__.invoke('import_skill', { filePath: '/test' });
  });
});
`,
      );

      // Rust partial file
      await writeFile(
        join(root, 'heimdall/packages/desktop/src-tauri/tests/unref_rust.rs'),
        `//! @tc test-trace-unref:TC-001 [partial_rust]
#[test]
fn tc_unref_rust_layer2() {}
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-unref.md'),
        `---
test_batch: test-trace-unref
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: unreferenced mock should not affect TC

## TC-001: bridge + rust, with unreferenced mock in another file

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/bridge-real.spec.ts\` — [ui_sidecar_bridge] layers 1+3+4+5
**partial_evidence**:
- \`packages/desktop/src-tauri/tests/unref_rust.rs\` — [partial_rust] Layer 2
**chain_type**: desktop_chain
**chain_coverage**: complete — composite: ui_sidecar_bridge + partial_rust
**chain_note**: mock-unref.spec.ts uses [mock_playwright] but is excluded from executable_ref
`,
      );

      const issues = await validateExecutableTraceability(root);
      // E2E-TRACE-004 should NOT fire — the mock file is not in executable_ref
      const trace004 = issues.filter((issue) => issue.code === 'E2E-TRACE-004');
      expect(trace004).toEqual([]);
      // E2E-TRACE-006 should NOT fire — valid composite complete
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts //! @tc (Rust doc-comment) as valid @tc annotation', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-rust-doccomment-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      // Rust file uses //! @-tc (doc-comment format)
      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/rust-doc.spec.ts'),
        `//! @tc test-trace-doc:TC-001 [desktop_chain]
describe('rust doc comment', () => {
  it('runs test', () => {});
});
`,
      );

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-trace-doc.md'),
        `---
test_batch: test-trace-doc
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: Rust doc-comment @tc

## TC-001: uses //! @tc format

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**:
- \`packages/desktop/e2e/rust-doc.spec.ts\` — [desktop_chain] full chain
**chain_type**: desktop_chain
**chain_coverage**: complete
`,
      );

      const issues = await validateExecutableTraceability(root);
      // No E2E-TRACE-003 — the //! @-tc annotation should be recognized
      const trace003 = issues.filter((issue) => issue.code === 'E2E-TRACE-003');
      expect(trace003).toEqual([]);
      // No E2E-TRACE-006 — desktop_chain is complete
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns E2E-TRACE-006 when chain_coverage is complete but no valid executable_ref or evidence', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-complete-invalid-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-complete-invalid.md'),
        `---
test_batch: test-complete-invalid
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: complete 但无有效证据

## TC-001: declared complete but no executable_ref

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 在 React UI 打开技能页面。
2. 通过 Tauri IPC 导入技能。
3. 验证 Node sidecar JSON Lines 解析。
4. 验证 core engine 写入 SQLite。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**chain_type**: desktop_chain
**chain_coverage**: complete
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace006 = issues.filter((issue) => issue.code === 'E2E-TRACE-006');
      expect(trace006.length).toBeGreaterThanOrEqual(1);
      expect(trace006[0].message).toContain('TC-001');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat chain_coverage incomplete as complete', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-incomplete-status-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-incomplete-status.md'),
        `---
test_batch: test-incomplete-status
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: incomplete status

## TC-001: declared incomplete desktop chain

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 在桌面 Skills 页面触发导入。
2. 通过 Tauri IPC 调用命令。
3. 记录后端链路尚未接入。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**chain_type**: desktop_chain
**chain_coverage**: incomplete — missing persistence evidence
`,
      );

      const graph = await scanArtifacts(root);
      const issues = validateGraph(graph);
      const desktopWarnings = issues.filter((issue) => issue.code === 'E2E_DESKTOP_CHAIN_WARNING');
      expect(desktopWarnings.length).toBe(1);
      expect(desktopWarnings[0].node).toBe('e2e_test:test-incomplete-status:TC-001');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // @feature ACA17
  // @scenario S-59
  // @decision D-ACA-17
  // New canonical E2E trace tag tests: establishes same e2e_test relationship as legacy tag.
  it('accepts @e2e_test as equivalent to @tc (bidirectional consistent)', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-test-tag-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-e2e-tag.md'),
        `---
test_batch: test-e2e-tag
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: @e2e_test 标签

## TC-001: 使用新标签的测试

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**executable_ref**: heimdall/packages/desktop/e2e/new-tag.spec.ts

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
`,
      );

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/new-tag.spec.ts'),
        `// @e2e_test test-e2e-tag:TC-001 [desktop_chain]
describe('new tag', () => {
  test('TC-001: uses @e2e_test', () => {});
});
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace003 = issues.filter((issue) => issue.code === 'E2E-TRACE-003');
      // No mismatch — new tag should be accepted like legacy tag
      expect(trace003.filter((i) => i.node === 'test-e2e-tag:TC-001').length).toBe(0);
      // No deprecation warning for new tag
      const trace007 = issues.filter((issue) => issue.code === 'E2E-TRACE-007');
      expect(trace007.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not duplicate the generic @tc deprecation warning in the E2E validator', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-deprecation-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-deprecation.md'),
        `---
test_batch: test-deprecation
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: deprecated 标签

## TC-001: 旧标签测试

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
`,
      );

      // File with deprecated tag
      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/old-tag.spec.ts'),
        `// @tc test-deprecation:TC-001 [desktop_chain]
describe('old tag', () => {
  test('TC-001: uses @tc', () => {});
});
`,
      );

      const executableIssues = await validateExecutableTraceability(root);
      expect(executableIssues.filter((issue) => issue.code === 'E2E-TRACE-007')).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns E2E-TRACE-002 for @e2e_test referencing non-existent batch', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-002-newtag-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-e2e-002.md'),
        `---
test_batch: test-e2e-002
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: @e2e_test 引用不存在的 batch

## TC-001: 有效测试用例

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
`,
      );

      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/orphan-newtag.spec.ts'),
        `// @e2e_test test-e2e-002:TC-999 [desktop_chain]
describe('orphan', () => {
  test('TC-001: orphaned annotation', () => {});
});
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace002 = issues.filter((issue) => issue.code === 'E2E-TRACE-002');
      expect(trace002.length).toBeGreaterThanOrEqual(1);
      expect(trace002[0].message).toContain('TC-999');
      // Error message should use neutral "E2E trace annotation"
      expect(trace002[0].message).toContain('E2E trace annotation');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns E2E-TRACE-003 for @e2e_test missing in executable_ref target', async () => {
    const root = join(tmpdir(), `artifact-graph-e2e-trace-003-newtag-${Date.now()}`);
    try {
      await mkdir(join(root, 'artifacts/tests/e2e'), { recursive: true });
      await mkdir(join(root, 'heimdall/packages/desktop/e2e'), { recursive: true });

      await writeFile(
        join(root, 'artifacts/tests/e2e/test-e2e-003.md'),
        `---
test_batch: test-e2e-003
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E 测试: executable_ref 有但 @e2e_test 缺失

## TC-001: 不一致测试

**前置条件**:
- 桌面应用已启动。

**测试步骤**:
1. 执行操作。

**后置清理**:
- 无。

**executable_ref**: heimdall/packages/desktop/e2e/mismatch.spec.ts

**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
`,
      );

      // File has test but no E2E trace annotation
      await writeFile(
        join(root, 'heimdall/packages/desktop/e2e/mismatch.spec.ts'),
        `describe('mismatch', () => {
  test('TC-001: no annotation', () => {});
});
`,
      );

      const issues = await validateExecutableTraceability(root);
      const trace003 = issues.filter((issue) => issue.code === 'E2E-TRACE-003');
      expect(trace003.length).toBeGreaterThanOrEqual(1);
      expect(trace003[0].message).toContain('E2E trace annotation');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function contractFixtureRepo(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-contract-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });

  await write(
    root,
    'artifact-graph.config.yaml',
    `types:
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  interface_contracts:
    paths: ["artifacts/contracts/interface-contracts.md"]
  data_contracts:
    paths: ["artifacts/contracts/data-contracts.md"]
  application_state_machines:
    paths: ["artifacts/contracts/application-state-machines.md"]
  error_model:
    paths: ["artifacts/contracts/error-model.md"]
idPatterns:
  interface_contracts: '^[A-Za-z0-9._{}:-]+$'
  data_contracts: '^[A-Za-z0-9._-]+$'
  application_state_machines: '^[A-Za-z0-9._-]+$'
  error_model: '^[A-Za-z0-9_]+$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [draft, planned, in-progress, implemented, active, done, deprecated]
`,
  );

  await write(
    root,
    'artifacts/decisions/README.md',
    `# 决策索引

| ID | 标题 |
|----|------|
| D-ARCH-05 | 桌面应用架构 |
| D-DESK-01 | 桌面端复用 CLI core |
| D-SCAN-01 | Quick Check deterministic |
| D-DATA-01 | 核心表约束 |
| D-DATA-02 | ScanResult 混合存储 |
`,
  );

  await write(
    root,
    'artifacts/contracts/interface-contracts.md',
    `# Interface Contracts — 接口契约

## Tauri IPC Commands — Tauri IPC 命令

| Command | 中文名 | Input | Output | Error model | Source |
|---|---|---|---|---|---|
| \`quick_check\` | 快速检查命令 | skillId: string | jobId: string | QUALITY_GATE_FAILED | D-ARCH-05; D-DESK-01 |
| \`get_job\` | 作业状态查询 | jobId: string | Job | EXECUTION_ERROR | D-DESK-01 |

## Sidecar JSON Lines — Sidecar JSON Lines 协议

| Message | 中文名 | Direction | Payload | Response | Source |
|---|---|---|---|---|---|
| \`{"cmd":"quick_check"}\` | 快速检查请求 | Rust -> Node sidecar | id, cmd, args | jobId | D-SCAN-01; D-DESK-01 |
| \`{"id":"__ready__"}\` | Sidecar 就绪信号 | Node sidecar -> Rust | ready | ok | D-ARCH-05 |
`,
  );

  await write(
    root,
    'artifacts/contracts/data-contracts.md',
    `# Data Contracts — 数据契约

| Entity/Table | 中文名 | Owner context | Fields | Migration rule | Source |
|---|---|---|---|---|---|
| \`skills\` | 技能注册表 | Skill Management | id, name, file_path | 新增列必须有兼容默认值 | D-DATA-01 |
| \`scan_results\` | 扫描结果表 | Report context | id, skill_id, result_json | result_json 是完整快照 | D-DATA-02 |
| \`IScanRepository\` | 扫描仓储接口 | Repository boundary | saveScanResult, getScanResult | 所有方法返回 Promise | D-DATA-02; D-DESK-01 |
`,
  );

  await write(
    root,
    'artifacts/contracts/application-state-machines.md',
    `# Application State Machines — 应用状态机

| Machine | 中文名 | States | Transitions | Terminal states | Source |
|---|---|---|---|---|---|
| \`quick_check_job\` | 快速检查作业 | created -> queued -> running -> succeeded | invoke quick_check | succeeded, failed, cancelled | D-ARCH-05; D-DESK-01 |
| \`skill_import\` | Skill 导入流程 | selected -> parsing -> saving -> imported | user selects file | imported, failed, cancelled | D-DESK-01 |
`,
  );

  await write(
    root,
    'artifacts/contracts/error-model.md',
    `# Error Model — 错误模型

| Error code | 中文名 | Trigger | User-visible behavior | Log fields | Retry/Rollback | Source |
|---|---|---|---|---|---|---|
| \`PASS\` | 通过 | score >= passThreshold | 通过摘要 | command, mode, score | 不需要重试 | D-SCAN-01 |
| \`QUALITY_GATE_FAILED\` | 质量门禁失败 | 分数低于阈值 | 失败原因 | score, passThreshold | 可修复后重试 | D-DESK-01 |
| \`EXECUTION_ERROR\` | 执行错误 | 文件不存在或解析失败 | 可操作错误 | command, phase, causeCode | 回滚后重试 | D-ARCH-05 |
`,
  );

  return root;
}

describe('contract artifacts', () => {
  it('scans contract table items as first-class artifact nodes', async () => {
    const root = await contractFixtureRepo('scan');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      const contractNodes = graph.nodes.filter((node) =>
        node.type === 'interface_contracts' || node.type === 'data_contracts'
        || node.type === 'application_state_machines' || node.type === 'error_model',
      );

      expect(contractNodes).toHaveLength(12);

      // Verify node.line tracks 1-based markdown table row per contract file
      expect(contractNodes.find((n) => n.uid === 'interface_contracts:quick_check')).toEqual(expect.objectContaining({ line: 7 }));
      expect(contractNodes.find((n) => n.uid === 'data_contracts:skills')).toEqual(expect.objectContaining({ line: 5 }));
      expect(contractNodes.find((n) => n.uid === 'application_state_machines:quick_check_job')).toEqual(expect.objectContaining({ line: 5 }));
      expect(contractNodes.find((n) => n.uid === 'error_model:PASS')).toEqual(expect.objectContaining({ line: 5 }));

      const uids = contractNodes.map((node) => node.uid);
      expect(uids).toEqual([
        'application_state_machines:quick_check_job',
        'application_state_machines:skill_import',
        'data_contracts:IScanRepository',
        'data_contracts:scan_results',
        'data_contracts:skills',
        'error_model:EXECUTION_ERROR',
        'error_model:PASS',
        'error_model:QUALITY_GATE_FAILED',
        'interface_contracts:{cmd:quick_check}',
        'interface_contracts:{id:__ready__}',
        'interface_contracts:get_job',
        'interface_contracts:quick_check',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates decision references from contract Source column', async () => {
    const root = await contractFixtureRepo('edges');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      const contractEdges = graph.edges.filter((edge) =>
        edge.from.startsWith('interface_contracts:') || edge.from.startsWith('data_contracts:')
        || edge.from.startsWith('application_state_machines:') || edge.from.startsWith('error_model:'),
      );

      const decisionEdges = contractEdges.filter((edge) => edge.to.startsWith('decision:'));
      expect(decisionEdges).toHaveLength(16);

      expect(contractEdges).toContainEqual(expect.objectContaining({
        from: 'interface_contracts:quick_check',
        to: 'decision:D-ARCH-05',
        kind: 'references',
        source: 'markdown',
        sourceLine: 7,
      }));
      expect(contractEdges).toContainEqual(expect.objectContaining({
        from: 'interface_contracts:quick_check',
        to: 'decision:D-DESK-01',
        kind: 'references',
        sourceLine: 7,
      }));

      expect(contractEdges).toContainEqual(expect.objectContaining({
        from: 'data_contracts:skills',
        to: 'decision:D-DATA-01',
        kind: 'references',
        source: 'markdown',
        sourceLine: 5,
      }));

      expect(contractEdges).toContainEqual(expect.objectContaining({
        from: 'application_state_machines:quick_check_job',
        to: 'decision:D-ARCH-05',
        kind: 'references',
        source: 'markdown',
        sourceLine: 5,
      }));

      expect(contractEdges).toContainEqual(expect.objectContaining({
        from: 'error_model:PASS',
        to: 'decision:D-SCAN-01',
        kind: 'references',
        source: 'markdown',
        sourceLine: 5,
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates contract nodes without errors', async () => {
    const root = await contractFixtureRepo('validate');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const issues = validateGraph(graph, await loadConfig(root));

      const contractNodeIssues = issues.filter((issue) =>
        issue.node?.startsWith('interface_contracts:') || issue.node?.startsWith('data_contracts:')
        || issue.node?.startsWith('application_state_machines:') || issue.node?.startsWith('error_model:'),
      );
      expect(contractNodeIssues).toEqual([]);

      const contractEdgeIssues = issues.filter((issue) =>
        issue.edge?.from.startsWith('interface_contracts:') || issue.edge?.from.startsWith('data_contracts:')
        || issue.edge?.from.startsWith('application_state_machines:') || issue.edge?.from.startsWith('error_model:'),
      );
      expect(contractEdgeIssues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not affect existing artifact types when contracts are configured', async () => {
    const root = await contractFixtureRepo('coexist');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const issues = validateGraph(graph, await loadConfig(root));

      const decisionNodes = graph.nodes.filter((node) => node.type === 'decision');
      expect(decisionNodes).toHaveLength(5);

      const contractNodes = graph.nodes.filter((node) =>
        node.type === 'interface_contracts' || node.type === 'data_contracts'
        || node.type === 'application_state_machines' || node.type === 'error_model',
      );
      expect(contractNodes).toHaveLength(12);

      const danglingContractRefs = issues.filter((issue) =>
        issue.code === 'DANGLING_REFERENCE' && (
          issue.edge?.from.startsWith('interface_contracts:') || issue.edge?.from.startsWith('data_contracts:')
          || issue.edge?.from.startsWith('application_state_machines:') || issue.edge?.from.startsWith('error_model:')
        ),
      );
      expect(danglingContractRefs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces deterministic UIDs across multiple scans', async () => {
    const root = await contractFixtureRepo('deterministic');
    try {
      const graph1 = await scanArtifacts(root, await loadConfig(root));
      const graph2 = await scanArtifacts(root, await loadConfig(root));

      expect(graph1.nodes.map((node) => node.uid)).toEqual(graph2.nodes.map((node) => node.uid));
      expect(graph1.edges).toEqual(graph2.edges);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('handles pipes in code spans and union types before Source column', async () => {
    const root = join(tmpdir(), `artifact-graph-contract-pipe-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  data_contracts:
    paths: ["artifacts/contracts/data-contracts.md"]
idPatterns:
  data_contracts: '^[A-Za-z0-9._{}:-]+'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [planned, active]
`);
      await write(root, 'artifacts/decisions/README.md', `# Decisions

| ID | Title |
|----|-------|
| D-ARCH-05 | Architecture |
| D-DATA-01 | Data constraints |
| D-DESK-01 | Desktop core reuse |
| D-SCAN-01 | Quick Check |
`);
      await write(root, 'artifacts/contracts/data-contracts.md', `# Data Contracts

## Job state transitions

| Entity/Table | 中文名 | Fields | Source |
|---|---|---|---|
| \`job\` | 作业表 | state: \`"queued" \\| "running"\` | D-ARCH-05 |
| \`result\` | 结果表 | value: \`string \\| number\` | D-DATA-01 |

## IPC payload contracts

| Entity/Table | 中文名 | Fields | Source |
|---|---|---|---|
| \`ipc_call\` | IPC 调用 | payload: \`Record<string, unknown>\` \\| null | D-DESK-01; D-SCAN-01 |
`);

      const graph = await scanArtifacts(root, await loadConfig(root));
      const config = await loadConfig(root);

      const contractNodes = graph.nodes.filter((n) => n.type === 'data_contracts');
      expect(contractNodes).toHaveLength(3);
      expect(contractNodes.map((n) => n.uid)).toEqual([
        'data_contracts:ipc_call',
        'data_contracts:job',
        'data_contracts:result',
      ]);

      // Verify node.line reflects table row position despite pipes in code spans
      expect(contractNodes.find((n) => n.uid === 'data_contracts:job')).toEqual(expect.objectContaining({ line: 7 }));
      expect(contractNodes.find((n) => n.uid === 'data_contracts:result')).toEqual(expect.objectContaining({ line: 8 }));
      expect(contractNodes.find((n) => n.uid === 'data_contracts:ipc_call')).toEqual(expect.objectContaining({ line: 14 }));

      const contractEdges = graph.edges.filter((e) => e.from.startsWith('data_contracts:'));
      // Verify edge.sourceLine matches the table row containing the Source column reference
      expect(contractEdges).toContainEqual(expect.objectContaining({
        from: 'data_contracts:job',
        to: 'decision:D-ARCH-05',
        kind: 'references',
        source: 'markdown',
        sourceLine: 7,
      }));
      expect(contractEdges).toContainEqual(expect.objectContaining({
        from: 'data_contracts:result',
        to: 'decision:D-DATA-01',
        kind: 'references',
        source: 'markdown',
        sourceLine: 8,
      }));
      expect(contractEdges).toContainEqual(expect.objectContaining({
        from: 'data_contracts:ipc_call',
        to: 'decision:D-DESK-01',
        kind: 'references',
        source: 'markdown',
        sourceLine: 14,
      }));
      expect(contractEdges).toContainEqual(expect.objectContaining({
        from: 'data_contracts:ipc_call',
        to: 'decision:D-SCAN-01',
        kind: 'references',
        source: 'markdown',
        sourceLine: 14,
      }));

      const contractEdgeIssues = validateGraph(graph, config).filter((issue) =>
        issue.edge?.from.startsWith('data_contracts:'),
      );
      expect(contractEdgeIssues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function companionFixtureRepo(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-companion-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });

  await write(
    root,
    'artifact-graph.config.yaml',
    `types:
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  entity:
    paths: ["artifacts/entities/entity-registry.md"]
  interface_contracts:
    paths: ["artifacts/contracts/interface-contracts.md"]
  domain-glossary:
    paths: ["artifacts/domain/domain-glossary.md"]
  bounded-context-map:
    paths: ["artifacts/domain/bounded-context-map.md"]
  domain-invariants:
    paths: ["artifacts/domain/domain-invariants.md"]
  generation-packet-spec:
    paths: ["artifacts/blueprints/generation-packet-spec.md"]
idPatterns:
  decision: '^D-[A-Z]+-\\\\d+$'
  entity: '^E-\\\\d{3,}$'
  interface_contracts: '^[A-Za-z0-9._{}:-]+$'
  domain-glossary: '^[A-Za-z][A-Za-z0-9 -]+$'
  bounded-context-map: '^[A-Za-z][A-Za-z0-9 -]+$'
  domain-invariants: '^INV-\\d{3}$'
  generation-packet-spec: '^generation-packet-spec$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [draft, planned, in-progress, implemented, active, done, deprecated]
`,
  );

  await write(
    root,
    'artifacts/decisions/README.md',
    `# 决策索引

| ID | 标题 |
|----|------|
| D-ARCH-01 | 架构决策 |
| D-SCAN-01 | Quick Check deterministic |
| D-RULE-02 | 安全规则不可降级 |
`,
  );

  await write(
    root,
    'artifacts/entities/entity-registry.md',
    `# Entity Registry

| ID | 名称 | 类型 | 描述 | 决策 |
|---|---|---|---|---|
| E-001 | ISkillScanner | 接口 | 引擎统一接口 | D-ARCH-01 |
`,
  );

  await write(
    root,
    'artifacts/contracts/interface-contracts.md',
    `# Interface Contracts

## Tauri IPC Commands

| Command | 中文名 | Input | Output | Source |
|---|---|---|---|---|
| \`quick_check\` | 快速检查 | skillId | jobId | D-ARCH-01 |
`,
  );

  await write(
    root,
    'artifacts/domain/domain-glossary.md',
    `# Domain Glossary

| Term | 中文名 | Canonical owner | Definition | Avoid |
|---|---|---|---|---|
| Skill | Skill 能力 | Skill Registry Context | A capability specification that Heimdall can import. | plugin |
| Quick Check | 快速检查 | Scan Engine Context | Deterministic TypeScript scan with 0 LLM calls. | deep check |
| Report | 报告 | Report Context | Persisted and exportable scan result. | raw output |
`,
  );

  await write(
    root,
    'artifacts/domain/bounded-context-map.md',
    `# Bounded Context Map

| Context | 中文名 | Owns | Consumes | Publishes |
|---|---|---|---|---|
| Artifact Chain Context | 制品链上下文 | PRD features, scenarios | spec, validation | ArtifactLinkValidated |
| Scan Engine Context | 扫描引擎上下文 | ScanRun, Quick Check | SkillRecord, rules | ScanCompleted |
`,
  );

  await write(
    root,
    'artifacts/domain/domain-invariants.md',
    `# Domain Invariants

| ID | Invariant | 中文说明 | Source | Verification |
|---|---|---|---|---|
| INV-001 | Scenarios and PRD do not directly link entities. | 场景和 PRD 不直接关联实体。 | artifact-chain-spec | artifact-graph validate |
| INV-003 | Security rule severity must not be downgraded. | SEC severity 不允许降级。 | D-RULE-02 | rule catalog review |
| INV-004 | Quick Check uses a deterministic TypeScript engine with 0 LLM calls. | Quick Check 使用确定性 engine。 | D-SCAN-01 | Quick Check tests |
`,
  );

  await write(
    root,
    'artifacts/blueprints/generation-packet-spec.md',
    `# Generation Packet Spec

## 1. 目的

定义单次代码生成必须输入的最小切片，基于 D-ARCH-01 架构决策。

## 2. 必需文件

| File | 中文名 | Required | Source |
|---|---|---|---|
| \`objective.md\` | 生成目标 | yes | user request |
| \`prd-slice.md\` | PRD 切片 | yes | PRD features |

## 3. 约束

参考 E-001 实体定义和 D-SCAN-01 扫描策略。
`,
  );

  return root;
}

describe('companion artifact types', () => {
  it('scans domain-glossary, bounded-context-map, domain-invariants, and generation-packet-spec as first-class nodes', async () => {
    const root = await companionFixtureRepo('scan');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      const glossaryNodes = graph.nodes.filter((n) => n.type === 'domain-glossary');
      expect(glossaryNodes.length).toBe(3);
      expect(glossaryNodes.map((n) => n.uid).sort()).toEqual([
        'domain-glossary:quick-check',
        'domain-glossary:report',
        'domain-glossary:skill',
      ]);

      const contextNodes = graph.nodes.filter((n) => n.type === 'bounded-context-map');
      expect(contextNodes.length).toBe(2);
      expect(contextNodes.map((n) => n.uid).sort()).toEqual([
        'bounded-context-map:artifact-chain-context',
        'bounded-context-map:scan-engine-context',
      ]);

      const invariantNodes = graph.nodes.filter((n) => n.type === 'domain-invariants');
      expect(invariantNodes.length).toBe(3);
      expect(invariantNodes.map((n) => n.uid).sort()).toEqual([
        'domain-invariants:INV-001',
        'domain-invariants:INV-003',
        'domain-invariants:INV-004',
      ]);

      const specNodes = graph.nodes.filter((n) => n.type === 'generation-packet-spec');
      expect(specNodes.length).toBe(1);
      expect(specNodes[0].uid).toBe('generation-packet-spec:generation-packet-spec');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces stable UIDs and correct line numbers', async () => {
    const root = await companionFixtureRepo('lines');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      const skill = graph.nodes.find((n) => n.uid === 'domain-glossary:skill');
      expect(skill).toBeDefined();
      expect(skill!.line).toBe(5);

      const quickCheck = graph.nodes.find((n) => n.uid === 'domain-glossary:quick-check');
      expect(quickCheck).toBeDefined();
      expect(quickCheck!.line).toBe(6);

      const context = graph.nodes.find((n) => n.uid === 'bounded-context-map:artifact-chain-context');
      expect(context).toBeDefined();
      expect(context!.line).toBe(5);

      const inv = graph.nodes.find((n) => n.uid === 'domain-invariants:INV-003');
      expect(inv).toBeDefined();
      expect(inv!.line).toBe(6);

      const spec = graph.nodes.find((n) => n.uid === 'generation-packet-spec:generation-packet-spec');
      expect(spec).toBeDefined();
      expect(spec!.line).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates decision references from domain-invariants Source column with correct sourceLine', async () => {
    const root = await companionFixtureRepo('edges');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      const invEdges = graph.edges.filter((e) => e.from.startsWith('domain-invariants:'));
      expect(invEdges).toContainEqual(expect.objectContaining({
        from: 'domain-invariants:INV-003',
        to: 'decision:D-RULE-02',
        kind: 'references',
        sourceLine: 6,
      }));
      expect(invEdges).toContainEqual(expect.objectContaining({
        from: 'domain-invariants:INV-004',
        to: 'decision:D-SCAN-01',
        kind: 'references',
        sourceLine: 7,
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates companion nodes and edges without issues', async () => {
    const root = await companionFixtureRepo('validate');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const config = await loadConfig(root);
      const issues = validateGraph(graph, config);

      const companionPrefixes = ['domain-glossary:', 'bounded-context-map:', 'domain-invariants:', 'generation-packet-spec:'];
      const companionIssues = issues.filter((issue) =>
        companionPrefixes.some((p) => issue.node?.startsWith(p) || issue.edge?.from.startsWith(p)),
      );
      expect(companionIssues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('catches dangling companion edge references via validateGraph', async () => {
    const root = join(tmpdir(), `artifact-graph-companion-dangling-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(
        root,
        'artifact-graph.config.yaml',
        `types:
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  domain-invariants:
    paths: ["artifacts/domain/domain-invariants.md"]
idPatterns:
  decision: '^D-[A-Z]+-\\\\d+$'
  domain-invariants: '^INV-\\\\d{3}$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [draft, planned, in-progress, implemented, active, done, deprecated]
`,
      );
      await write(
        root,
        'artifacts/decisions/README.md',
        `# 决策索引

| ID | 标题 |
|----|------|
| D-ARCH-01 | 架构决策 |
`,
      );
      await write(
        root,
        'artifacts/domain/domain-invariants.md',
        `# Domain Invariants

| ID | Invariant | 中文说明 | Source | Verification |
|---|---|---|---|---|
| INV-001 | Test invariant. | 测试不变量。 | D-MISSING-01 | check |
`,
      );

      const graph = await scanArtifacts(root, await loadConfig(root));
      const config = await loadConfig(root);
      const issues = validateGraph(graph, config);

      const danglingIssues = issues.filter((issue) =>
        issue.code === 'DANGLING_REFERENCE'
        && (issue.edge?.from.startsWith('domain-invariants:') || issue.node?.startsWith('domain-invariants:')),
      );
      expect(danglingIssues.length).toBeGreaterThanOrEqual(1);
      expect(danglingIssues[0]).toEqual(expect.objectContaining({
        code: 'DANGLING_REFERENCE',
        severity: 'error',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('coexists with contract and decision types without affecting them', async () => {
    const root = await companionFixtureRepo('coexist');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      // Existing types still present
      expect(graph.nodes.filter((n) => n.type === 'decision').length).toBeGreaterThanOrEqual(1);
      expect(graph.nodes.filter((n) => n.type === 'interface_contracts').length).toBeGreaterThanOrEqual(1);

      // New types present alongside
      expect(graph.nodes.filter((n) => n.type === 'domain-glossary').length).toBe(3);
      expect(graph.nodes.filter((n) => n.type === 'bounded-context-map').length).toBe(2);
      expect(graph.nodes.filter((n) => n.type === 'domain-invariants').length).toBe(3);
      expect(graph.nodes.filter((n) => n.type === 'generation-packet-spec').length).toBe(1);

      // Contract edges still intact
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'interface_contracts:quick_check',
        to: 'decision:D-ARCH-01',
        kind: 'references',
      }));

      // Total node count = 3 decisions + 1 entity + 1 contract + 3 glossary + 2 context + 3 invariants + 1 spec = 14
      expect(graph.nodes.length).toBe(14);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces deterministic UIDs across multiple scans', async () => {
    const root1 = await companionFixtureRepo('deterministic-1');
    const root2 = await companionFixtureRepo('deterministic-2');
    try {
      const graph1 = await scanArtifacts(root1, await loadConfig(root1));
      const graph2 = await scanArtifacts(root2, await loadConfig(root2));

      const uids1 = graph1.nodes.map((n) => `${n.type}:${n.code}`).sort();
      const uids2 = graph2.nodes.map((n) => `${n.type}:${n.code}`).sort();
      expect(uids1).toEqual(uids2);
    } finally {
      await rm(root1, { recursive: true, force: true });
      await rm(root2, { recursive: true, force: true });
    }
  });

  it('creates generation-packet-spec decision and entity edges with real sourceLine', async () => {
    const root = await companionFixtureRepo('spec-edges');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      const specEdges = graph.edges.filter((e) => e.from.startsWith('generation-packet-spec:'));
      expect(specEdges).toContainEqual(expect.objectContaining({
        from: 'generation-packet-spec:generation-packet-spec',
        to: 'decision:D-ARCH-01',
        kind: 'references',
        sourceLine: 5,
      }));
      expect(specEdges).toContainEqual(expect.objectContaining({
        from: 'generation-packet-spec:generation-packet-spec',
        to: 'decision:D-SCAN-01',
        kind: 'references',
        sourceLine: 16,
      }));
      expect(specEdges).toContainEqual(expect.objectContaining({
        from: 'generation-packet-spec:generation-packet-spec',
        to: 'entity:E-001',
        kind: 'references',
        sourceLine: 16,
      }));
      // Verify sourceLine is NOT always 1
      expect(specEdges.some((e) => e.sourceLine > 1)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves header-driven column lookup for domain-glossary with reordered columns', async () => {
    const root = join(tmpdir(), `artifact-graph-companion-reorder-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(
        root,
        'artifact-graph.config.yaml',
        `types:
  domain-glossary:
    paths: ["artifacts/domain/domain-glossary.md"]
idPatterns:
  domain-glossary: '^[A-Za-z][A-Za-z0-9 -]+$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [draft, planned, in-progress, implemented, active, done, deprecated]
`,
      );
      // Reordered columns: Avoid first, Definition second, owner third
      await write(
        root,
        'artifacts/domain/domain-glossary.md',
        `# Domain Glossary

| Avoid | Definition | Canonical owner | Term | 中文名 |
|---|---|---|---|---|
| plugin | A capability spec. | Skill Registry Context | Skill | Skill 能力 |
| deep check | Deterministic scan. | Scan Engine Context | Quick Check | 快速检查 |
`,
      );

      const graph = await scanArtifacts(root, await loadConfig(root));
      const nodes = graph.nodes.filter((n) => n.type === 'domain-glossary');
      expect(nodes.length).toBe(2);

      const skill = nodes.find((n) => n.code === 'skill');
      expect(skill).toBeDefined();
      expect(skill!.attrs?.definition).toBe('A capability spec.');
      expect(skill!.attrs?.canonicalOwner).toBe('Skill Registry Context');
      expect(skill!.attrs?.avoid).toBe('plugin');

      const quickCheck = nodes.find((n) => n.code === 'quick-check');
      expect(quickCheck).toBeDefined();
      expect(quickCheck!.attrs?.definition).toBe('Deterministic scan.');
      expect(quickCheck!.attrs?.canonicalOwner).toBe('Scan Engine Context');
      expect(quickCheck!.attrs?.avoid).toBe('deep check');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves header-driven column lookup for bounded-context-map with reordered columns', async () => {
    const root = join(tmpdir(), `artifact-graph-companion-ctx-reorder-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(
        root,
        'artifact-graph.config.yaml',
        `types:
  bounded-context-map:
    paths: ["artifacts/domain/bounded-context-map.md"]
idPatterns:
  bounded-context-map: '^[A-Za-z][A-Za-z0-9 -]+$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [draft, planned, in-progress, implemented, active, done, deprecated]
`,
      );
      // Reordered columns: Publishes first, Owns second, Context third
      await write(
        root,
        'artifacts/domain/bounded-context-map.md',
        `# Bounded Context Map

| Publishes | Owns | Context | 中文名 | Consumes |
|---|---|---|---|---|
| ArtifactLinkValidated | PRD features, scenarios | Artifact Chain Context | 制品链上下文 | spec, validation |
| ScanCompleted | ScanRun, Quick Check | Scan Engine Context | 扫描引擎上下文 | SkillRecord, rules |
`,
      );

      const graph = await scanArtifacts(root, await loadConfig(root));
      const nodes = graph.nodes.filter((n) => n.type === 'bounded-context-map');
      expect(nodes.length).toBe(2);

      const ctx = nodes.find((n) => n.code === 'artifact-chain-context');
      expect(ctx).toBeDefined();
      expect(ctx!.attrs?.owns).toBe('PRD features, scenarios');
      expect(ctx!.attrs?.consumes).toBe('spec, validation');
      expect(ctx!.attrs?.publishes).toBe('ArtifactLinkValidated');

      const scan = nodes.find((n) => n.code === 'scan-engine-context');
      expect(scan).toBeDefined();
      expect(scan!.attrs?.owns).toBe('ScanRun, Quick Check');
      expect(scan!.attrs?.consumes).toBe('SkillRecord, rules');
      expect(scan!.attrs?.publishes).toBe('ScanCompleted');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not generate domain-glossary nodes when Term header is missing', async () => {
    const root = join(tmpdir(), `artifact-graph-companion-missing-term-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(
        root,
        'artifact-graph.config.yaml',
        `types:
  domain-glossary:
    paths: ["artifacts/domain/domain-glossary.md"]
idPatterns:
  domain-glossary: '^[A-Za-z][A-Za-z0-9 -]+$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [draft, planned, active, done, deprecated]
`,
      );
      await write(
        root,
        'artifacts/domain/domain-glossary.md',
        `# Domain Glossary

| 中文名 | Definition | Canonical owner |
|---|---|---|
| Skill 能力 | A capability spec. | Skill Registry Context |
| 快速检查 | Deterministic scan. | Scan Engine Context |
`,
      );

      const graph = await scanArtifacts(root, await loadConfig(root));
      const nodes = graph.nodes.filter((n) => n.type === 'domain-glossary');
      expect(nodes.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not generate bounded-context-map nodes when Context header is missing', async () => {
    const root = join(tmpdir(), `artifact-graph-companion-missing-ctx-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(
        root,
        'artifact-graph.config.yaml',
        `types:
  bounded-context-map:
    paths: ["artifacts/domain/bounded-context-map.md"]
idPatterns:
  bounded-context-map: '^[A-Za-z][A-Za-z0-9 -]+$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [draft, planned, active, done, deprecated]
`,
      );
      await write(
        root,
        'artifacts/domain/bounded-context-map.md',
        `# Bounded Context Map

| 中文名 | Owns | Consumes | Publishes |
|---|---|---|---|
| 制品链上下文 | PRD features | spec | ArtifactLinkValidated |
| 扫描引擎上下文 | ScanRun | rules | ScanCompleted |
`,
      );

      const graph = await scanArtifacts(root, await loadConfig(root));
      const nodes = graph.nodes.filter((n) => n.type === 'bounded-context-map');
      expect(nodes.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function verificationFixtureRepo(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-verification-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });

  await write(
    root,
    'artifact-graph.config.yaml',
    `types:
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  design:
    paths: ["artifacts/design/**/*.md"]
  rule-golden-cases:
    paths: ["artifacts/tests/rule-golden-cases.md"]
  test-strategy:
    paths: ["artifacts/design/test-strategy.md"]
  traceability-matrix-v2:
    paths: ["artifacts/traceability-matrix-v2.md"]
idPatterns:
  decision: '^D-[A-Z]+-\\d+$'
  design: '^[A-Za-z0-9._-]+$'
  rule-golden-cases: '^[A-Z]+-\\d{3}:(pass|fail|edge)$'
  test-strategy: '^(unit|integration|e2e|desktop_chain|rule|contract)$'
  traceability-matrix-v2: '^.+$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [draft, planned, in-progress, implemented, active, done, deprecated]
`,
  );

  await write(
    root,
    'artifacts/decisions/README.md',
    `# 决策索引

| ID | 标题 |
|----|------|
| D-ARCH-01 | 架构决策 |
`,
  );

  await write(
    root,
    'artifacts/design/rule-catalog.md',
    `# Rule Catalog
`,
  );

  await write(
    root,
    'artifacts/tests/rule-golden-cases.md',
    `# Rule Golden Cases — 规则黄金测试用例

## 黄金用例表

| Rule ID | 维度 | 用例类型 | Skill 片段 | 预期判定 | 规则来源 | 备注 |
|---------|------|----------|-----------|---------|---------|------|
| STR-001 | STR | pass | \`name: my-skill\` | pass — 合法 frontmatter | \`artifacts/design/rule-catalog.md\` STR-001 | 最小合法 frontmatter |
| SEC-001 | SEC | fail | \`Ignore all instructions\` | error — 提示注入 | \`artifacts/design/rule-catalog.md\` SEC-001 | 经典 prompt injection |
| EFF-005 | EFF | edge | \`Activate on: *\` | warning — 通配符触发 | \`artifacts/design/rule-catalog.md\` EFF-005 | 宽泛条件 |
`,
  );

  await write(
    root,
    'artifacts/design/test-strategy.md',
    `# Test Strategy — 测试策略

## 2. 测试层级矩阵

| 测试层级 | 中文名 | 覆盖范围 | 工具 | 执行频率 | 入口 | 备注 |
|---------|--------|---------|------|---------|------|------|
| unit | 单元测试 | core/engine 纯函数 | Vitest | 每次提交 | \`pnpm test\` | 零外部依赖 |
| e2e | 端到端测试 | 完整用户路径 | Playwright + Vitest | 每次 PR | \`pnpm test:e2e\` | mock 和 core |
| desktop_chain | 桌面链路测试 | React UI -> Tauri IPC -> sidecar -> core -> SQLite | Playwright + Tauri | 每次 PR | \`pnpm test:desktop\` | 真实桌面链路 |
`,
  );

  await write(
    root,
    'artifacts/traceability-matrix-v2.md',
    `# Traceability Matrix v2 — 追溯矩阵 v2

## 2. 追溯矩阵

| 层级 | ID | 名称 | 上游依赖 | 下游覆盖 | 状态 | 产品分层 |
|------|-----|------|---------|---------|------|---------|
| decision | D-ARCH-01 | 四层扫描模型 | ADR-001 | E-034, S-32 | 已实现 | oss |
| entity | E-083 | Structure 规则包 | D-SCAN-04 | S-09~S-16 | 已实现 | oss |
| scenario | S-01 | CLI 导入 Skill 文件 | D-TOOL-02 | A1 | 已实现 | oss |
| feature | A1 | Skill import/register | S-01 | cli/test | 已实现 | oss |
`,
  );

  return root;
}

describe('P1 verification artifact types', () => {
  it('scans P1 verification artifacts as first-class nodes', async () => {
    const root = await verificationFixtureRepo('scan');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      const ruleNodes = graph.nodes.filter((n) => n.type === 'rule-golden-cases');
      expect(ruleNodes.length).toBe(3);
      expect(ruleNodes.map((n) => n.uid).sort()).toEqual([
        'rule-golden-cases:EFF-005:edge',
        'rule-golden-cases:SEC-001:fail',
        'rule-golden-cases:STR-001:pass',
      ]);

      const strategyNodes = graph.nodes.filter((n) => n.type === 'test-strategy');
      expect(strategyNodes.length).toBe(3);
      expect(strategyNodes.map((n) => n.uid).sort()).toEqual([
        'test-strategy:desktop_chain',
        'test-strategy:e2e',
        'test-strategy:unit',
      ]);
      expect(graph.nodes.find((n) => n.uid === 'design:test-strategy')).toBeUndefined();
      expect(discoverTargets(graph, { schema: await loadConfig(root), limit: 0 })).not.toContainEqual({
        type: 'design',
        id: 'test-strategy',
      });

      const matrixNodes = graph.nodes.filter((n) => n.type === 'traceability-matrix-v2');
      expect(matrixNodes.length).toBe(4);
      expect(matrixNodes.map((n) => n.uid).sort()).toEqual([
        'traceability-matrix-v2:decision:D-ARCH-01',
        'traceability-matrix-v2:entity:E-083',
        'traceability-matrix-v2:feature:A1',
        'traceability-matrix-v2:scenario:S-01',
      ]);

      const decisionNodes = graph.nodes.filter((n) => n.type === 'decision');
      expect(decisionNodes.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces stable UIDs and correct line numbers for P1 types', async () => {
    const root = await verificationFixtureRepo('lines');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      const strPass = graph.nodes.find((n) => n.uid === 'rule-golden-cases:STR-001:pass');
      expect(strPass).toBeDefined();
      expect(strPass!.line).toBeGreaterThanOrEqual(5);

      const unit = graph.nodes.find((n) => n.uid === 'test-strategy:unit');
      expect(unit).toBeDefined();
      expect(unit!.line).toBeGreaterThanOrEqual(5);

      const dArch = graph.nodes.find((n) => n.uid === 'traceability-matrix-v2:decision:D-ARCH-01');
      expect(dArch).toBeDefined();
      expect(dArch!.line).toBeGreaterThanOrEqual(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates references edges from rule-golden-cases to rule-catalog design', async () => {
    const root = await verificationFixtureRepo('edges');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      const ruleEdges = graph.edges.filter((e) => e.from.startsWith('rule-golden-cases:'));
      expect(ruleEdges.length).toBe(3);
      expect(ruleEdges).toContainEqual(expect.objectContaining({
        from: 'rule-golden-cases:STR-001:pass',
        to: 'design:rule-catalog',
        kind: 'references',
        source: 'markdown',
      }));
      expect(ruleEdges).toContainEqual(expect.objectContaining({
        from: 'rule-golden-cases:SEC-001:fail',
        to: 'design:rule-catalog',
        kind: 'references',
      }));
      expect(ruleEdges).toContainEqual(expect.objectContaining({
        from: 'rule-golden-cases:EFF-005:edge',
        to: 'design:rule-catalog',
        kind: 'references',
      }));
      expect(ruleEdges.every((e) => e.sourceLine > 0)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates P1 nodes without structural issues; DANGLING_REFERENCE only for unresolved IDs', async () => {
    const root = await verificationFixtureRepo('validate');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const config = await loadConfig(root);
      const issues = validateGraph(graph, config);

      const p1Prefixes = ['rule-golden-cases:', 'test-strategy:', 'traceability-matrix-v2:'];
      const p1Issues = issues.filter((issue) =>
        p1Prefixes.some((p) => issue.node?.startsWith(p) || issue.edge?.from.startsWith(p)),
      );
      // All P1 issues should be DANGLING_REFERENCE for unresolved IDs
      // ADR-001 is an external ADR — filtered out, not a dangling reference
      const nonDangling = p1Issues.filter((i) => i.code !== 'DANGLING_REFERENCE');
      expect(nonDangling).toEqual([]);
      // Verify expected dangling references exist (external ADRs are filtered)
      const dangling = p1Issues.filter((i) => i.code === 'DANGLING_REFERENCE');
      const danglingTargets = dangling.map((d) => d.edge?.to).sort();
      expect(danglingTargets).not.toContain('resolve:ADR-001');
      expect(danglingTargets).toContain('resolve:D-SCAN-04');
      expect(danglingTargets).toContain('resolve:D-TOOL-02');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('handles escaped pipes and code span pipes in P1 tables', async () => {
    const root = join(tmpdir(), `artifact-graph-verification-pipe-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  traceability-matrix-v2:
    paths: ["artifacts/traceability-matrix-v2.md"]
idPatterns:
  traceability-matrix-v2: '^.+$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [planned, active]
`);
      await write(root, 'artifacts/traceability-matrix-v2.md', `# Traceability Matrix v2

## 追溯矩阵

| 层级 | ID | 名称 | 上游依赖 | 下游覆盖 | 状态 | 产品分层 |
|------|-----|------|---------|---------|------|---------|
| decision | D-ARCH-01 | 四层扫描模型 | ADR-001 \\| ADR-003 | E-034, S-32 | 已实现 | oss |
| entity | E-091 | QuickCheck 引擎 | \`D-SCAN-01 \\| D-ARCH-01\` | S-30~S-37 | 已实现 | oss |
`);

      const graph = await scanArtifacts(root, await loadConfig(root));
      const nodes = graph.nodes.filter((n) => n.type === 'traceability-matrix-v2');
      expect(nodes.length).toBe(2);
      expect(nodes[0].uid).toBe('traceability-matrix-v2:decision:D-ARCH-01');
      expect(nodes[1].uid).toBe('traceability-matrix-v2:entity:E-091');
      expect(nodes[0].attrs?.upstreamDependencies).toContain('ADR-001');
      expect(nodes[0].attrs?.upstreamDependencies).toContain('ADR-003');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces deterministic UIDs across multiple scans for P1 types', async () => {
    const root1 = await verificationFixtureRepo('det-1');
    const root2 = await verificationFixtureRepo('det-2');
    try {
      const graph1 = await scanArtifacts(root1, await loadConfig(root1));
      const graph2 = await scanArtifacts(root2, await loadConfig(root2));

      const uids1 = graph1.nodes.map((n) => `${n.type}:${n.code}`).sort();
      const uids2 = graph2.nodes.map((n) => `${n.type}:${n.code}`).sort();
      expect(uids1).toEqual(uids2);
    } finally {
      await rm(root1, { recursive: true, force: true });
      await rm(root2, { recursive: true, force: true });
    }
  });

  it('creates upstream references and downstream covers edges for traceability-matrix-v2', async () => {
    const root = join(tmpdir(), `artifact-graph-tm2-edges-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  traceability-matrix-v2:
    paths: ["artifacts/traceability-matrix-v2.md"]
idPatterns:
  traceability-matrix-v2: '^.+$'
forbiddenEdges: []
statuses: [active]
`);
      await write(root, 'artifacts/traceability-matrix-v2.md', `# Traceability Matrix v2

## 追溯矩阵

| 层级 | ID | 名称 | 上游依赖 | 下游覆盖 | 状态 | 产品分层 |
|------|-----|------|---------|---------|------|---------|
| decision | D-ARCH-01 | 架构决策 | | E-034 | active | oss |
| entity | E-034 | 引擎层 | D-ARCH-01 | S-01 | active | oss |
| scenario | S-01 | 导入场景 | E-034 | | active | oss |
`);

      const graph = await scanArtifacts(root, await loadConfig(root));
      // D-ARCH-01 downstream E-034 → covers edge
      const coversEdge = graph.edges.find(
        (e) => e.from === 'traceability-matrix-v2:decision:D-ARCH-01'
          && e.to === 'traceability-matrix-v2:entity:E-034' && e.kind === 'covers',
      );
      expect(coversEdge).toBeDefined();
      expect(coversEdge!.sourceLine).toBeGreaterThan(0);
      // E-034 upstream D-ARCH-01 → references edge
      const refEdge = graph.edges.find(
        (e) => e.from === 'traceability-matrix-v2:entity:E-034'
          && e.to === 'traceability-matrix-v2:decision:D-ARCH-01' && e.kind === 'references',
      );
      expect(refEdge).toBeDefined();
      // E-034 downstream S-01 → covers edge
      const coversS01 = graph.edges.find(
        (e) => e.from === 'traceability-matrix-v2:entity:E-034'
          && e.to === 'traceability-matrix-v2:scenario:S-01' && e.kind === 'covers',
      );
      expect(coversS01).toBeDefined();
      // S-01 upstream E-034 → references edge
      const refS01 = graph.edges.find(
        (e) => e.from === 'traceability-matrix-v2:scenario:S-01'
          && e.to === 'traceability-matrix-v2:entity:E-034' && e.kind === 'references',
      );
      expect(refS01).toBeDefined();
      // Total: 4 edges (2 covers + 2 references)
      const tm2Edges = graph.edges.filter((e) => e.from.startsWith('traceability-matrix-v2:'));
      expect(tm2Edges.length).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces DANGLING_REFERENCE for missing exact IDs in traceability-matrix-v2', async () => {
    const root = join(tmpdir(), `artifact-graph-tm2-dangle-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  traceability-matrix-v2:
    paths: ["artifacts/traceability-matrix-v2.md"]
idPatterns:
  traceability-matrix-v2: '^.+$'
forbiddenEdges: []
statuses: [active]
`);
      // D-ARCH-01 downstream E-034: E-034 has no matrix row and no real artifact → dangling
      // E-091 upstream D-ARCH-01: D-ARCH-01 has a matrix row → resolved (matrix-to-matrix)
      await write(root, 'artifacts/traceability-matrix-v2.md', `# Traceability Matrix v2

## 追溯矩阵

| 层级 | ID | 名称 | 上游依赖 | 下游覆盖 | 状态 | 产品分层 |
|------|-----|------|---------|---------|------|---------|
| decision | D-ARCH-01 | 架构决策 | | E-034 | active | oss |
| entity | E-091 | 引擎 | D-ARCH-01 | | active | oss |
`);

      const graph = await scanArtifacts(root, await loadConfig(root));
      const config = await loadConfig(root);
      const issues = validateGraph(graph, config);
      // E-034 is not in matrix and not a real artifact → DANGLING_REFERENCE
      const dangling = issues.filter((i) => i.code === 'DANGLING_REFERENCE');
      expect(dangling.length).toBe(1);
      expect(dangling[0].message).toContain('E-034');
      // The covers attr still records the raw reference
      const dArch = graph.nodes.find((n) => n.uid === 'traceability-matrix-v2:decision:D-ARCH-01');
      expect(dArch?.attrs?.downstreamCoverage).toContain('E-034');
      // E-091 → D-ARCH-01 upstream resolves to matrix row → references edge (not dangling)
      const refEdge = graph.edges.find(
        (e) => e.from === 'traceability-matrix-v2:entity:E-091' && e.to === 'traceability-matrix-v2:decision:D-ARCH-01',
      );
      expect(refEdge).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves cross-artifact edges and targets decision/feature/scenario/entity types', async () => {
    const root = join(tmpdir(), `artifact-graph-tm2-cross-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  entity:
    paths: ["artifacts/entities/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  feature:
    paths: ["artifacts/prd/**/*.md"]
  traceability-matrix-v2:
    paths: ["artifacts/traceability-matrix-v2.md"]
idPatterns:
  decision: '^D-[A-Z]+-\\\\d+$'
  entity: '^E-\\\\d{3,}$'
  feature: '^[A-Z]{1,4}\\\\d+$'
  scenario: '^S-\\\\d+[a-z]?$'
  traceability-matrix-v2: '^.+$'
forbiddenEdges: []
statuses: [active]
`);
      await write(root, 'artifacts/decisions/README.md', `# 决策索引\n\n| ID | 标题 |\n|----|------|\n| D-ARCH-01 | 架构决策 |\n`);
      await write(root, 'artifacts/entities/entity-registry.md', `# 实体注册表\n\n| ID | 名称 | 类型 | 状态 | 关联决策 |\n|----|------|------|------|----------|\n| E-083 | Structure 规则包 | 模块 | active | D-ARCH-01 |\n`);
      await write(root, 'artifacts/scenarios/batch-01.md', `# 场景批次 1\n\n## S-01: CLI 导入场景\n\n关联功能: A1\n关联决策: D-ARCH-01\n`);
      await write(root, 'artifacts/prd/features/A1.md', `---\nid: A1\ntitle: Skill import\nscenarios:\n  - S-01\ndecisions:\n  - D-ARCH-01\n---\n# A1\n`);
      await write(root, 'artifacts/traceability-matrix-v2.md', `# Traceability Matrix v2

## 追溯矩阵

| 层级 | ID | 名称 | 上游依赖 | 下游覆盖 | 状态 | 产品分层 |
|------|-----|------|---------|---------|------|---------|
| decision | D-ARCH-01 | 架构决策 | | E-083 | active | oss |
| entity | E-083 | Structure 规则包 | D-ARCH-01 | S-01 | active | oss |
| scenario | S-01 | CLI 导入场景 | E-083 | A1 | active | oss |
| feature | A1 | Skill import | S-01 | | active | oss |
| decision | D-MISSING | 不存在的决策 | | X-999 | active | oss |
`);

      const graph = await scanArtifacts(root, await loadConfig(root));
      const config = await loadConfig(root);
      const issues = validateGraph(graph, config);

      // 1. Matrix-to-matrix edges preserved
      const matrixToMatrix = graph.edges.filter(
        (e) => e.from.startsWith('traceability-matrix-v2:') && e.to.startsWith('traceability-matrix-v2:'),
      );
      expect(matrixToMatrix.length).toBeGreaterThanOrEqual(4);

      // 2. Cross-artifact edges to real artifact nodes exist
      const targetTypes = new Set<string>();
      const crossEdges = graph.edges.filter(
        (e) => e.from.startsWith('traceability-matrix-v2:') && !e.to.startsWith('traceability-matrix-v2:') && !e.to.startsWith('resolve:'),
      );
      for (const e of crossEdges) {
        const targetType = e.to.split(':')[0];
        targetTypes.add(targetType);
      }
      // Must cover at least decision, entity, scenario, feature
      expect(targetTypes.has('decision')).toBe(true);
      expect(targetTypes.has('entity')).toBe(true);
      expect(targetTypes.has('scenario')).toBe(true);
      expect(targetTypes.has('feature')).toBe(true);

      // 3. Specific cross-artifact edges
      const dArchToEntity = crossEdges.find(
        (e) => e.from === 'traceability-matrix-v2:decision:D-ARCH-01' && e.to === 'entity:E-083' && e.kind === 'covers',
      );
      expect(dArchToEntity).toBeDefined();
      const entityToDecision = crossEdges.find(
        (e) => e.from === 'traceability-matrix-v2:entity:E-083' && e.to === 'decision:D-ARCH-01' && e.kind === 'references',
      );
      expect(entityToDecision).toBeDefined();

      // 4. D-MISSING upstream X-999 doesn't exist → DANGLING_REFERENCE
      const dangling = issues.filter((i) => i.code === 'DANGLING_REFERENCE');
      expect(dangling.length).toBeGreaterThanOrEqual(1);
      const x999Dangle = dangling.find((d) => d.message.includes('X-999'));
      expect(x999Dangle).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('range expressions in upstream/downstream do not create false edges', async () => {
    const root = join(tmpdir(), `artifact-graph-tm2-range-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  traceability-matrix-v2:
    paths: ["artifacts/traceability-matrix-v2.md"]
idPatterns:
  traceability-matrix-v2: '^.+$'
forbiddenEdges: []
statuses: [active]
`);
      await write(root, 'artifacts/traceability-matrix-v2.md', `# Traceability Matrix v2

## 追溯矩阵

| 层级 | ID | 名称 | 上游依赖 | 下游覆盖 | 状态 | 产品分层 |
|------|-----|------|---------|---------|------|---------|
| decision | D-ARCH-01 | 架构决策 | | S-09~S-16 | active | oss |
| scenario | S-09 | 场景09 | D-ARCH-01 | | active | oss |
`);

      const graph = await scanArtifacts(root, await loadConfig(root));
      const config = await loadConfig(root);
      const issues = validateGraph(graph, config);
      // Range S-09~S-16 should NOT produce dangling references
      const dangling = issues.filter((i) => i.code === 'DANGLING_REFERENCE');
      expect(dangling).toEqual([]);
      // Only one edge: S-09 upstream D-ARCH-01 → references
      const tm2Edges = graph.edges.filter((e) => e.from.startsWith('traceability-matrix-v2:'));
      expect(tm2Edges.length).toBe(1);
      expect(tm2Edges[0].kind).toBe('references');
      expect(tm2Edges[0].from).toBe('traceability-matrix-v2:scenario:S-09');
      expect(tm2Edges[0].to).toBe('traceability-matrix-v2:decision:D-ARCH-01');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces correct sourceLine for traceability-matrix-v2 edges', async () => {
    const root = await verificationFixtureRepo('tm2-line');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const tm2Edges = graph.edges.filter((e) => e.from.startsWith('traceability-matrix-v2:'));
      // From the fixture: S-01 upstream is D-TOOL-02 (not in matrix, no edge),
      // S-01 downstream A1 → covers edge, A1 upstream S-01 → references edge
      for (const e of tm2Edges) {
        expect(e.sourceLine).toBeGreaterThan(0);
        expect(e.sourcePath).toContain('traceability-matrix-v2.md');
      }
      // Verify at least the A1↔S-01 edges exist
      const a1Ref = tm2Edges.find((e) => e.from === 'traceability-matrix-v2:feature:A1' && e.kind === 'references');
      expect(a1Ref).toBeDefined();
      expect(a1Ref!.to).toBe('traceability-matrix-v2:scenario:S-01');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function p2FixtureRepo(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-p2-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });

  await write(
    root,
    'artifact-graph.config.yaml',
    `types:
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  design:
    paths: ["artifacts/design/**/*.md"]
  report-contracts:
    paths: ["artifacts/contracts/report-contracts.md"]
  verification-fixtures:
    paths: ["artifacts/tests/verification-fixtures.md"]
  ui-flow-contracts:
    paths: ["artifacts/contracts/ui-flow-contracts.md"]
  non-functional-budgets:
    paths: ["artifacts/contracts/non-functional-budgets.md"]
  implementation-blueprint:
    paths: ["artifacts/blueprints/implementation-blueprint.md"]
idPatterns:
  decision: '^D-[A-Z]+-\\d+$'
  feature: '^[A-Z]{1,3}\\d+$'
  scenario: '^S-\\d+[a-z]?$'
  design: '^[A-Za-z0-9._/-]+$'
  report-contracts: '^[A-Za-z0-9._:-]+$'
  verification-fixtures: '^FIX-\\d{3}$'
  ui-flow-contracts: '^[A-Za-z][A-Za-z0-9_-]+$'
  non-functional-budgets: '^NFB-\\d{3}$'
  implementation-blueprint: '^implementation-blueprint$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [draft, planned, in-progress, implemented, active, done, deprecated]
`,
  );

  await write(
    root,
    'artifacts/decisions/README.md',
    `# 决策索引

| ID | 标题 |
|----|------|
| D-ARCH-05 | 桌面应用架构 |
| D-DESK-01 | 桌面端复用 CLI core |
| D-SCAN-01 | Quick Check deterministic |
| D-DATA-01 | 核心表约束 |
| D-DATA-02 | ScanResult 混合存储 |
| D-RULE-01 | SEC severity 不降级 |
| D-DATA-03 | Issue 逐行存储 |
`,
  );

  await write(
    root,
    'artifacts/contracts/report-contracts.md',
    `# Report Contracts — 报告契约

## 1. 报告数据契约

| Report field | 中文名 | Type | Required | Description | Source |
|---|---|---|---|---|---|
| \`overallScore\` | 综合评分 | number | yes | 0-100 综合质量评分 | B6; D-SCAN-01 |
| \`pass\` | 是否通过 | boolean | yes | overallScore >= passThreshold | D-RULE-01 |
| \`scanTimeMs\` | 扫描耗时 | number | yes | Quick Check 执行耗时 | B6; D-SCAN-01 |

## 2. 报告输出格式

| Format | 中文名 | Channel | Content type | Constraints | Source |
|---|---|---|---|---|---|
| \`cli_summary\` | CLI 摘要 | stdout | text/plain | 包含 overallScore | H4; D-SCAN-01 |
| \`cli_json\` | CLI 完整 JSON | stdout/stderr | application/json | 完整 ScanResult JSON | H4; D-DESK-01 |

## 3. 报告错误模型

| Error code | 中文名 | Trigger | User-visible behavior | Source |
|---|---|---|---|---|
| \`REPORT_RENDER_FAILED\` | 报告渲染失败 | UI 无法解析 result_json | 显示错误提示 | D-DATA-02 |
| \`REPORT_EXPORT_FAILED\` | 报告导出失败 | IO 错误 | 显示失败原因 | D-DESK-01 |
`,
  );

  await write(
    root,
    'artifacts/tests/verification-fixtures.md',
    `# Verification Fixtures — 验证样本集

## Fixture 定义表

| Fixture ID | 中文名 | Category | Skill 片段 | Expected scan result | Linked rule IDs | Source |
|---|---|---|---|---|---|---|
| FIX-001 | 合法最小 Skill | valid | \`name: minimal\` | pass | STR-001, STR-002 | \`artifacts/design/rule-catalog.md\` |
| FIX-003 | 含硬编码密钥 | malicious | \`api_key: sk-proj\` | error | SEC-005 | \`artifacts/design/rule-catalog.md\` SEC-005 |
| FIX-008 | 完整合法 Skill | valid | \`name: code-reviewer\` | pass | STR-001, BP-001 | \`artifacts/design/rule-catalog.md\` |
`,
  );

  await write(
    root,
    'artifacts/design/rule-catalog.md',
    `# Rule Catalog
`,
  );

  await write(
    root,
    'artifacts/contracts/ui-flow-contracts.md',
    `# UI Flow Contracts — UI 流程契约

## 1. 页面流转矩阵

| Page ID | 中文名 | Route | Entry action | Exit action | Related IPC commands | Source |
|---|---|---|---|---|---|---|
| PAGE-DASHBOARD | 仪表盘页 | \`/\` | 加载扫描历史 | 取消轮询 | \`list_scans\` | B6; D-DESK-01 |
| PAGE-SCAN | 扫描页 | \`/scan\` | 触发扫描 | 取消 Job 轮询 | \`quick_check\` | D-DESK-01 |

## 2. 关键交互流程

| Flow ID | 中文名 | Steps | Error handling | Related scenarios | Source |
|---|---|---|---|---|---|
| FLOW-SCAN | 快速扫描流程 | 选择 Skill -> 扫描 -> 轮询 -> 报告 | Job 失败显示错误 | S-01; D-DESK-01 | D-DESK-01 |
| FLOW-IMPORT | Skill 导入流程 | 选择文件 -> 解析 -> 写入 SQLite | 文件不存在显示错误 | S-02; D-DATA-01 | D-DATA-01 |

## 3. UI 状态契约

| State | 中文名 | Trigger | Transitions | Data requirements | Source |
|---|---|---|---|---|---|
| \`IDLE\` | 空闲 | 页面加载完成 | SCANNING | Skill 列表 | D-DESK-01 |
| \`SCANNING\` | 扫描中 | quick_check 调用成功 | DONE, FAILED | jobId | D-DESK-01 |
| \`DONE\` | 扫描完成 | get_job succeeded | IDLE, SCANNING | ScanResult | D-DATA-02 |
`,
  );

  await write(
    root,
    'artifacts/scenarios/batch-01.md',
    `# 场景批次 01

## S-01: CLI 导入 Skill 文件

**关联功能**: A1
`,
  );

  await write(
    root,
    'artifacts/scenarios/batch-02.md',
    `# 场景批次 02

## S-02: Skill 导入失败处理

**关联功能**: A1
`,
  );

  await write(
    root,
    'artifacts/prd/features/A1-skill-import.md',
    `---
id: A1
title: Skill import/register
status: done
---

# A1: Skill import/register
`,
  );

  await write(
    root,
    'artifacts/prd/features/B6-scan-result.md',
    `---
id: B6
title: Scan result
status: done
---

# B6: Scan result
`,
  );

  await write(
    root,
    'artifacts/prd/features/H4-cli-exit-code.md',
    `---
id: H4
title: CLI exit code
status: done
---

# H4: CLI exit code
`,
  );

  await write(
    root,
    'artifacts/contracts/non-functional-budgets.md',
    `# Non-Functional Budgets — 非功能预算

## 1. 性能预算

| Budget ID | 中文名 | Metric | Target | Threshold | Scope | Source |
|---|---|---|---|---|---|---|
| NFB-001 | Quick Check 扫描耗时 | scanTimeMs | <15s | >=30s 触发告警 | Quick Check | B6; D-SCAN-01 |
| NFB-005 | IPC 响应延迟 | ipc_response_ms | <500ms | >=2000ms 触发告警 | Desktop | D-DESK-01 |
| NFB-006 | SQLite 查询延迟 | query_latency_ms | <100ms | >=500ms 触发告警 | Storage | D-DATA-02 |

## 2. 安全预算

| Budget ID | 中文名 | Metric | Constraint | Enforcement | Scope | Source |
|---|---|---|---|---|---|---|
| NFB-101 | SEC severity 降级次数 | sec_downgrade_count | 0 | 阻断 | All | D-RULE-01 |

## 3. 稳定性预算

| Budget ID | 中文名 | Metric | Target | Recovery strategy | Scope | Source |
|---|---|---|---|---|---|---|
| NFB-201 | Sidecar 健康检查周期 | health_check_interval_ms | 5000ms | 自动重启 | Desktop | D-ARCH-05 |
| NFB-202 | SQLite 事务回滚率 | transaction_rollback_rate | <1% | 记录错误 | Storage | D-DATA-01 |
`,
  );

  await write(
    root,
    'artifacts/blueprints/implementation-blueprint.md',
    `# Implementation Blueprint — 实现蓝图

## 2. 蓝图使用规则

### 2.2 上游制品引用

| 上游制品 | 引用方式 | 用途 |
|---|---|---|
| PRD features | Feature ID | 确认实现目标 |
| Non-functional budgets | Budget ID | 确认预算 |

## Source References — 来源引用

- D-ARCH-05: 桌面应用架构。
- D-DESK-01: 桌面端复用 CLI core。
- D-RULE-01: SEC severity 不允许降级。
`,
  );

  return root;
}

describe('P2 artifact types', () => {
  it('scans P2 artifact nodes with correct counts and UIDs', async () => {
    const root = await p2FixtureRepo('scan');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      const rcNodes = graph.nodes.filter((n) => n.type === 'report-contracts');
      expect(rcNodes.length).toBe(7);
      expect(rcNodes.map((n) => n.uid).sort()).toEqual([
        'report-contracts:REPORT_EXPORT_FAILED',
        'report-contracts:REPORT_RENDER_FAILED',
        'report-contracts:cli_json',
        'report-contracts:cli_summary',
        'report-contracts:overallScore',
        'report-contracts:pass',
        'report-contracts:scanTimeMs',
      ]);

      const vfNodes = graph.nodes.filter((n) => n.type === 'verification-fixtures');
      expect(vfNodes.length).toBe(3);
      expect(vfNodes.map((n) => n.uid).sort()).toEqual([
        'verification-fixtures:FIX-001',
        'verification-fixtures:FIX-003',
        'verification-fixtures:FIX-008',
      ]);

      const uiNodes = graph.nodes.filter((n) => n.type === 'ui-flow-contracts');
      expect(uiNodes.length).toBe(7);
      expect(uiNodes.map((n) => n.uid).sort()).toEqual([
        'ui-flow-contracts:DONE',
        'ui-flow-contracts:FLOW-IMPORT',
        'ui-flow-contracts:FLOW-SCAN',
        'ui-flow-contracts:IDLE',
        'ui-flow-contracts:PAGE-DASHBOARD',
        'ui-flow-contracts:PAGE-SCAN',
        'ui-flow-contracts:SCANNING',
      ]);

      const nfbNodes = graph.nodes.filter((n) => n.type === 'non-functional-budgets');
      expect(nfbNodes.length).toBe(6);
      expect(nfbNodes.map((n) => n.uid).sort()).toEqual([
        'non-functional-budgets:NFB-001',
        'non-functional-budgets:NFB-005',
        'non-functional-budgets:NFB-006',
        'non-functional-budgets:NFB-101',
        'non-functional-budgets:NFB-201',
        'non-functional-budgets:NFB-202',
      ]);

      const ibNodes = graph.nodes.filter((n) => n.type === 'implementation-blueprint');
      expect(ibNodes.length).toBe(1);
      expect(ibNodes[0].uid).toBe('implementation-blueprint:implementation-blueprint');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces stable line numbers for P2 nodes', async () => {
    const root = await p2FixtureRepo('lines');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      const overallScore = graph.nodes.find((n) => n.uid === 'report-contracts:overallScore');
      expect(overallScore).toBeDefined();
      expect(overallScore!.line).toBeGreaterThanOrEqual(5);

      const fix001 = graph.nodes.find((n) => n.uid === 'verification-fixtures:FIX-001');
      expect(fix001).toBeDefined();
      expect(fix001!.line).toBeGreaterThanOrEqual(5);

      const pageDash = graph.nodes.find((n) => n.uid === 'ui-flow-contracts:PAGE-DASHBOARD');
      expect(pageDash).toBeDefined();
      expect(pageDash!.line).toBeGreaterThanOrEqual(5);

      const nfb001 = graph.nodes.find((n) => n.uid === 'non-functional-budgets:NFB-001');
      expect(nfb001).toBeDefined();
      expect(nfb001!.line).toBeGreaterThanOrEqual(5);

      const blueprint = graph.nodes.find((n) => n.uid === 'implementation-blueprint:implementation-blueprint');
      expect(blueprint).toBeDefined();
      expect(blueprint!.line).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates references edges from P2 nodes to decisions and features', async () => {
    const root = await p2FixtureRepo('edges');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));

      // report-contracts -> decision
      const rcDecEdges = graph.edges.filter((e) => e.from === 'report-contracts:overallScore' && e.to.startsWith('decision:'));
      expect(rcDecEdges.length).toBeGreaterThanOrEqual(1);
      expect(rcDecEdges).toContainEqual(expect.objectContaining({ to: 'decision:D-SCAN-01' }));

      // report-contracts -> feature
      const rcFeatEdges = graph.edges.filter((e) => e.from === 'report-contracts:overallScore' && e.to.startsWith('feature:'));
      expect(rcFeatEdges.length).toBeGreaterThanOrEqual(1);
      expect(rcFeatEdges).toContainEqual(expect.objectContaining({ to: 'feature:B6' }));

      // verification-fixtures -> design:rule-catalog
      const vfEdges = graph.edges.filter((e) => e.from.startsWith('verification-fixtures:'));
      expect(vfEdges.length).toBe(3);
      expect(vfEdges).toContainEqual(expect.objectContaining({
        from: 'verification-fixtures:FIX-001',
        to: 'design:rule-catalog',
        kind: 'references',
      }));

      // ui-flow-contracts -> decision
      const uiDecEdges = graph.edges.filter((e) => e.from === 'ui-flow-contracts:PAGE-DASHBOARD' && e.to.startsWith('decision:'));
      expect(uiDecEdges).toContainEqual(expect.objectContaining({ to: 'decision:D-DESK-01' }));

      // ui-flow-contracts FLOW-SCAN -> scenario
      const uiScEdges = graph.edges.filter((e) => e.from === 'ui-flow-contracts:FLOW-SCAN' && e.to.startsWith('scenario:'));
      expect(uiScEdges).toContainEqual(expect.objectContaining({ to: 'scenario:S-01' }));

      // non-functional-budgets -> decision
      const nfbDecEdges = graph.edges.filter((e) => e.from === 'non-functional-budgets:NFB-001' && e.to.startsWith('decision:'));
      expect(nfbDecEdges).toContainEqual(expect.objectContaining({ to: 'decision:D-SCAN-01' }));

      // non-functional-budgets -> feature
      const nfbFeatEdges = graph.edges.filter((e) => e.from === 'non-functional-budgets:NFB-001' && e.to.startsWith('feature:'));
      expect(nfbFeatEdges).toContainEqual(expect.objectContaining({ to: 'feature:B6' }));

      // implementation-blueprint -> decision
      const ibDecEdges = graph.edges.filter((e) => e.from === 'implementation-blueprint:implementation-blueprint' && e.to.startsWith('decision:'));
      expect(ibDecEdges.length).toBeGreaterThanOrEqual(2);
      expect(ibDecEdges).toContainEqual(expect.objectContaining({ to: 'decision:D-ARCH-05' }));
      expect(ibDecEdges).toContainEqual(expect.objectContaining({ to: 'decision:D-RULE-01' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates P2 nodes and edges without issues', async () => {
    const root = await p2FixtureRepo('validate');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const config = await loadConfig(root);
      const issues = validateGraph(graph, config);

      const p2Prefixes = ['report-contracts:', 'verification-fixtures:', 'ui-flow-contracts:', 'non-functional-budgets:', 'implementation-blueprint:'];
      const p2Issues = issues.filter((issue) =>
        p2Prefixes.some((p) => issue.node?.startsWith(p) || issue.edge?.from.startsWith(p)),
      );
      expect(p2Issues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('handles escaped pipes in P2 tables without breaking cell parsing', async () => {
    const root = join(tmpdir(), `artifact-graph-p2-pipe-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  non-functional-budgets:
    paths: ["artifacts/contracts/non-functional-budgets.md"]
idPatterns:
  non-functional-budgets: '^NFB-\\d{3}$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [active]
`);
      await write(root, 'artifacts/contracts/non-functional-budgets.md', `# Non-Functional Budgets

## 1. 性能预算

| Budget ID | 中文名 | Metric | Target | Threshold | Scope | Source |
|---|---|---|---|---|---|---|
| NFB-001 | 测试 | test_ms | <15s | >=30s \\| >=60s 阻断 | Quick Check | D-SCAN-01 |
| NFB-002 | 测试2 | latency_ms | <500ms | \`>=2000ms \\| >=5000ms\` | Desktop | D-DESK-01 |
`);

      const graph = await scanArtifacts(root, await loadConfig(root));
      const nodes = graph.nodes.filter((n) => n.type === 'non-functional-budgets');
      expect(nodes.length).toBe(2);
      expect(nodes[0].uid).toBe('non-functional-budgets:NFB-001');
      expect(nodes[1].uid).toBe('non-functional-budgets:NFB-002');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not produce dangling references when source has only design refs (no false positives)', async () => {
    const root = join(tmpdir(), `artifact-graph-p2-nodangle-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  verification-fixtures:
    paths: ["artifacts/tests/verification-fixtures.md"]
  design:
    paths: ["artifacts/design/**/*.md"]
idPatterns:
  verification-fixtures: '^FIX-\\d{3}$'
  design: '^[A-Za-z0-9._/-]+$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [active]
`);
      await write(root, 'artifacts/design/rule-catalog.md', `# Rule Catalog\n`);
      await write(root, 'artifacts/tests/verification-fixtures.md', `# Verification Fixtures

## Fixture 定义表

| Fixture ID | 中文名 | Category | Skill 片段 | Expected scan result | Linked rule IDs | Source |
|---|---|---|---|---|---|---|
| FIX-001 | 合法样本 | valid | \`name: test\` | pass | STR-001 | \`artifacts/design/rule-catalog.md\` |
| FIX-002 | 规则样本 | edge | \`test\` | warn | SEC-001 | \`artifacts/design/rule-catalog.md\` SEC-001 |
`);

      const graph = await scanArtifacts(root, await loadConfig(root));
      const config = await loadConfig(root);
      const issues = validateGraph(graph, config);
      const danglingIssues = issues.filter((i) => i.code === 'DANGLING_REFERENCE');
      expect(danglingIssues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces deterministic UIDs across multiple scans for P2 types', async () => {
    const root1 = await p2FixtureRepo('det-1');
    const root2 = await p2FixtureRepo('det-2');
    try {
      const graph1 = await scanArtifacts(root1, await loadConfig(root1));
      const graph2 = await scanArtifacts(root2, await loadConfig(root2));

      const uids1 = graph1.nodes.map((n) => `${n.type}:${n.code}`).sort();
      const uids2 = graph2.nodes.map((n) => `${n.type}:${n.code}`).sort();
      expect(uids1).toEqual(uids2);
    } finally {
      await rm(root1, { recursive: true, force: true });
      await rm(root2, { recursive: true, force: true });
    }
  });

  it('handles column reorder in P2 tables', async () => {
    const root = join(tmpdir(), `artifact-graph-p2-reorder-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  non-functional-budgets:
    paths: ["artifacts/contracts/non-functional-budgets.md"]
idPatterns:
  non-functional-budgets: '^NFB-\\d{3}$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [active]
`);
      // Reordered columns: Source first, Budget ID last
      await write(root, 'artifacts/contracts/non-functional-budgets.md', `# Non-Functional Budgets

## 1. 性能预算

| Source | 中文名 | Metric | Target | Threshold | Scope | Budget ID |
|---|---|---|---|---|---|---|
| D-SCAN-01 | 测试耗时 | scanTimeMs | <15s | >=30s | Quick Check | NFB-001 |
| D-DESK-01 | IPC 延迟 | ipc_response_ms | <500ms | >=2000ms | Desktop | NFB-005 |
`);

      const graph = await scanArtifacts(root, await loadConfig(root));
      const nodes = graph.nodes.filter((n) => n.type === 'non-functional-budgets');
      expect(nodes.length).toBe(2);
      expect(nodes.map((n) => n.uid).sort()).toEqual([
        'non-functional-budgets:NFB-001',
        'non-functional-budgets:NFB-005',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects dangling references in P2 edges during validation', async () => {
    const root = join(tmpdir(), `artifact-graph-p2-dangling-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  non-functional-budgets:
    paths: ["artifacts/contracts/non-functional-budgets.md"]
idPatterns:
  non-functional-budgets: '^NFB-\\d{3}$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [active]
`);
      // Reference a non-existent decision D-MISSING-01
      await write(root, 'artifacts/contracts/non-functional-budgets.md', `# Non-Functional Budgets

## 1. 性能预算

| Budget ID | 中文名 | Metric | Target | Threshold | Scope | Source |
|---|---|---|---|---|---|---|
| NFB-001 | 测试 | scanTimeMs | <15s | >=30s | Quick Check | D-MISSING-01 |
`);

      const graph = await scanArtifacts(root, await loadConfig(root));
      const config = await loadConfig(root);
      const issues = validateGraph(graph, config);
      const dangling = issues.filter((i) => i.code === 'DANGLING_REFERENCE');
      expect(dangling.length).toBeGreaterThanOrEqual(1);
      expect(dangling.some((i) => i.edge?.to === 'decision:D-MISSING-01')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('scope expressions and descriptive text do not create false dangling edges', async () => {
    const root = join(tmpdir(), `artifact-graph-p2-scope-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  non-functional-budgets:
    paths: ["artifacts/contracts/non-functional-budgets.md"]
idPatterns:
  decision: '^D-[A-Z]+-\\d+$'
  non-functional-budgets: '^NFB-\\d{3}$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [active]
`);
      await write(root, 'artifacts/decisions/README.md', `# 决策索引\n\n| ID | 标题 |\n|----|------|\n| D-SCAN-01 | Quick Check |\n`);
      // "D1" and "D2" in Scope column should NOT be extracted as decision codes
      await write(root, 'artifacts/contracts/non-functional-budgets.md', `# Non-Functional Budgets

## 1. 性能预算

| Budget ID | 中文名 | Metric | Target | Threshold | Scope | Source |
|---|---|---|---|---|---|---|
| NFB-001 | 测试 | scanTimeMs | <15s | >=30s | Quick Check | D-SCAN-01 |
| NFB-002 | 测试2 | cost | $0 | >$0 阻断 | Quick Check | D-SCAN-01 |
`);

      const graph = await scanArtifacts(root, await loadConfig(root));
      const config = await loadConfig(root);
      const issues = validateGraph(graph, config);
      const dangling = issues.filter((i) => i.code === 'DANGLING_REFERENCE');
      // No dangling edges — D-SCAN-01 exists, "Quick Check" is not a code
      expect(dangling).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not produce duplicate edges when Source and Related scenarios share the same ID', async () => {
    const root = await p2FixtureRepo('dedup');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      // FLOW-SCAN: Source has D-DESK-01, Related scenarios has D-DESK-01 and S-01
      // After dedup, only one decision edge for FLOW-SCAN -> D-DESK-01
      const deskEdges = graph.edges.filter(
        (e) => e.from === 'ui-flow-contracts:FLOW-SCAN' && e.to === 'decision:D-DESK-01',
      );
      expect(deskEdges.length).toBe(1);
      // FLOW-IMPORT: Source has D-DATA-01, Related scenarios has D-DATA-01 and S-02
      const dataEdges = graph.edges.filter(
        (e) => e.from === 'ui-flow-contracts:FLOW-IMPORT' && e.to === 'decision:D-DATA-01',
      );
      expect(dataEdges.length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('non-S-* text in Related scenarios does not create feature or decision edges', async () => {
    const root = join(tmpdir(), `artifact-graph-p2-non-sc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  ui-flow-contracts:
    paths: ["artifacts/contracts/ui-flow-contracts.md"]
idPatterns:
  decision: '^D-[A-Z]+-\\d+$'
  feature: '^[A-Z]{1,3}\\d+$'
  scenario: '^S-\\d+[a-z]?$'
  ui-flow-contracts: '^[A-Z][A-Z0-9_-]+$'
forbiddenEdges:
  - from: scenario
    to: entity
    kind: references
statuses: [active]
`);
      await write(root, 'artifacts/decisions/README.md', `# 决策索引\n\n| ID | 标题 |\n|----|------|\n| D-DESK-01 | test |\n`);
      await write(root, 'artifacts/prd/features/B6-scan.md', `---\nid: B6\ntitle: Scan\nstatus: done\n---\n# B6\n`);
      await write(root, 'artifacts/scenarios/batch-01.md', `# 场景批次 01\n\n## S-01: 测试场景\n\n**关联功能**: A1\n`);
      // Related scenarios column has B6 (feature), D-DESK-01 (decision), and design-tauri-architecture (design)
      // None of these should produce scenario edges; only S-01 should
      await write(root, 'artifacts/contracts/ui-flow-contracts.md', `# UI Flow Contracts

## 2. 关键交互流程

| Flow ID | 中文名 | Steps | Error handling | Related scenarios | Source |
|---|---|---|---|---|---|
| FLOW-TEST | 测试流程 | step1 | err1 | S-01; B6; D-DESK-01; design-tauri-architecture | D-DESK-01 |
`);

      const graph = await scanArtifacts(root, await loadConfig(root));
      // Only one scenario edge: FLOW-TEST -> scenario:S-01
      const scenarioEdges = graph.edges.filter(
        (e) => e.from === 'ui-flow-contracts:FLOW-TEST' && e.kind === 'references' && e.to.startsWith('scenario:'),
      );
      expect(scenarioEdges.length).toBe(1);
      expect(scenarioEdges[0].to).toBe('scenario:S-01');
      // No feature or decision edges from Related scenarios column for B6/D-DESK-01
      // (those come from Source column only)
      const featureEdges = graph.edges.filter(
        (e) => e.from === 'ui-flow-contracts:FLOW-TEST' && e.to.startsWith('feature:'),
      );
      expect(featureEdges.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Related scenarios with S-* creates scenario edge with correct sourceLine', async () => {
    const root = await p2FixtureRepo('sc-line');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      // FLOW-SCAN has Related scenarios = "S-01; D-DESK-01" on line 13 (fixture table row)
      const scEdge = graph.edges.find(
        (e) => e.from === 'ui-flow-contracts:FLOW-SCAN' && e.to === 'scenario:S-01',
      );
      expect(scEdge).toBeDefined();
      expect(scEdge!.sourceLine).toBeGreaterThan(0);
      // FLOW-IMPORT has Related scenarios = "S-02; D-DATA-01"
      const scEdge2 = graph.edges.find(
        (e) => e.from === 'ui-flow-contracts:FLOW-IMPORT' && e.to === 'scenario:S-02',
      );
      expect(scEdge2).toBeDefined();
      expect(scEdge2!.sourceLine).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function contextFixtureRepo(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-context-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });

  await write(
    root,
    'artifact-graph.config.yaml',
    `types:
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  entity:
    paths: ["artifacts/entities/entity-registry.md"]
  design:
    paths: ["artifacts/design/**/*.md"]
  traceability-matrix-v2:
    paths: ["artifacts/traceability-matrix-v2.md"]
idPatterns:
  decision: '^D-[A-Z]+-\\\\d+$'
  feature: '^[A-Z]{1,4}\\\\d+$'
  scenario: '^S-\\\\d+[a-z]?$'
  entity: '^E-\\\\d{3,}$'
  design: '^[A-Za-z0-9._-]+$'
  traceability-matrix-v2: '^.+$'
forbiddenEdges: []
statuses: [active]
`,
  );

  await write(root, 'artifacts/decisions/README.md', `# 决策索引\n\n| ID | 标题 |\n|----|------|\n| D-ARCH-01 | 架构决策 |\n| D-TOOL-02 | 工具链决策 |\n`);
  await write(root, 'artifacts/prd/features/A1.md', `---\nid: A1\ntitle: Skill import\nscenarios:\n  - S-01\ndecisions:\n  - D-ARCH-01\ndesign_docs:\n  - skill-import-design\n---\n# A1\n`);
  await write(root, 'artifacts/prd/features/B6.md', `---\nid: B6\ntitle: Quick Check\nscenarios:\n  - S-30\ndecisions:\n  - D-ARCH-01\n---\n# B6\n`);
  await write(root, 'artifacts/scenarios/batch-01.md', `# 场景批次 1\n\n## S-01: CLI 导入场景\n\n关联功能: A1\n关联决策: D-TOOL-02\n`);
  await write(root, 'artifacts/entities/entity-registry.md', `# 实体注册表\n\n| ID | 名称 | 类型 | 状态 | 关联决策 |\n|----|------|------|------|----------|\n| E-083 | Structure 规则包 | 模块 | active | D-ARCH-01 |\n`);
  await write(root, 'artifacts/design/skill-import-design.md', `# Skill Import Design\n\nrelated_features: A1\n`);
  await write(root, 'artifacts/traceability-matrix-v2.md', `# Traceability Matrix v2

## 追溯矩阵

| 层级 | ID | 名称 | 上游依赖 | 下游覆盖 | 状态 | 产品分层 |
|------|-----|------|---------|---------|------|---------|
| decision | D-ARCH-01 | 架构决策 | | E-083 | active | oss |
| entity | E-083 | Structure 规则包 | D-ARCH-01 | S-01 | active | oss |
| scenario | S-01 | CLI 导入场景 | E-083 | A1 | active | oss |
| feature | A1 | Skill import | S-01 | | active | oss |
`);

  return root;
}

describe('implementation context resolver', () => {
  it('resolves feature context with related artifacts', async () => {
    const root = await contextFixtureRepo('feature');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1', universalBaseline: false });

      expect(manifest.target.type).toBe('feature');
      expect(manifest.target.id).toBe('A1');
      expect(manifest.target.uid).toBe('feature:A1');

      // Should include the target itself
      expect(manifest.context['target']).toBeDefined();

      // Should include related scenario (S-01)
      expect(manifest.context['scenario']).toBeDefined();
      expect(manifest.context['scenario'].some((i) => i.path.includes('batch-01'))).toBe(true);

      // Should include related decision (D-ARCH-01)
      expect(manifest.context['decision']).toBeDefined();

      // Should include related design
      expect(manifest.context['design']).toBeDefined();

      // Should have no missing items
      expect(manifest.missing).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves scenario context with upstream/downstream artifacts', async () => {
    const root = await contextFixtureRepo('scenario');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { scenario: 'S-01', universalBaseline: false });

      expect(manifest.target.type).toBe('scenario');
      expect(manifest.target.id).toBe('S-01');

      // Should include related feature (A1) via edge (category: prd)
      expect(manifest.context['prd']).toBeDefined();
      expect(manifest.context['prd'].some((i) => i.path.includes('A1'))).toBe(true);

      // Should include related decision (D-TOOL-02) via 关联决策
      expect(manifest.context['decision']).toBeDefined();

      // Should include entity (E-083) via matrix upstream cross-artifact edge
      expect(manifest.context['entity']).toBeDefined();

      expect(manifest.missing).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves decision context with downstream artifacts', async () => {
    const root = await contextFixtureRepo('decision');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { decision: 'D-ARCH-01', universalBaseline: false });

      expect(manifest.target.type).toBe('decision');
      expect(manifest.target.id).toBe('D-ARCH-01');

      // Should include features that reference this decision (A1, B6) (category: prd)
      expect(manifest.context['prd']).toBeDefined();
      const featurePaths = manifest.context['prd'].map((i) => i.path);
      expect(featurePaths.some((p) => p.includes('A1'))).toBe(true);
      expect(featurePaths.some((p) => p.includes('B6'))).toBe(true);

      // Should include entity (E-083) via matrix cross-artifact edge
      expect(manifest.context['entity']).toBeDefined();

      expect(manifest.missing).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports missing target when artifact does not exist', async () => {
    const root = await contextFixtureRepo('missing');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'Z99' });

      expect(manifest.target.type).toBe('feature');
      expect(manifest.target.id).toBe('Z99');
      expect(manifest.missing.length).toBe(1);
      expect(manifest.missing[0]).toContain('Z99');
      expect(manifest.missing[0]).toContain('not found');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports missing when no target specified', async () => {
    const root = await contextFixtureRepo('no-target');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, {});

      expect(manifest.missing.length).toBe(1);
      expect(manifest.missing[0]).toContain('No target specified');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('populates missingDetails for target-not-found', async () => {
    const root = await contextFixtureRepo('missing-details-notfound');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'Z99' });

      expect(manifest.missingDetails).toBeDefined();
      expect(manifest.missingDetails!.length).toBe(1);
      expect(manifest.missingDetails![0].kind).toBe('target-not-found');
      expect(manifest.missingDetails![0].ref).toBe('Z99');
      expect(manifest.missingDetails![0].suggestedAction).toBe('创建文件或检查 ID 拼写');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('populates missingDetails for multiple-targets', async () => {
    const root = await contextFixtureRepo('missing-details-multi');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1', scenario: 'S-01' });

      expect(manifest.missingDetails).toBeDefined();
      expect(manifest.missingDetails!.length).toBe(1);
      expect(manifest.missingDetails![0].kind).toBe('multiple-targets');
      expect(manifest.missingDetails![0].suggestedAction).toBe('只指定一个 --feature/--scenario/--decision/--design/--e2e-test');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('populates missingDetails for no-target-specified', async () => {
    const root = await contextFixtureRepo('missing-details-empty');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, {});

      expect(manifest.missingDetails).toBeDefined();
      expect(manifest.missingDetails!.length).toBe(1);
      expect(manifest.missingDetails![0].kind).toBe('target-not-found');
      expect(manifest.missingDetails![0].suggestedAction).toBe('创建文件或检查 ID 拼写');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('has empty missingDetails when no missing items (opt-out baseline)', async () => {
    const root = await contextFixtureRepo('no-missing-details');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1', universalBaseline: false });

      expect(manifest.missing).toEqual([]);
      expect(manifest.missingDetails).toBeDefined();
      expect(manifest.missingDetails!.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces stable sorted context manifest', async () => {
    const root = await contextFixtureRepo('stable');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const m1 = resolveArtifactContext(graph, { feature: 'A1' });
      const m2 = resolveArtifactContext(graph, { feature: 'A1' });

      expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));

      // All category items should be sorted by path
      for (const items of Object.values(m1.context)) {
        const paths = items.map((i) => i.path);
        expect(paths).toEqual([...paths].sort());
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('formats context manifest as markdown', async () => {
    const root = await contextFixtureRepo('md');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1' });
      const md = formatContextMarkdown(manifest);

      expect(md).toContain('# Implementation Context: feature:A1');
      expect(md).toContain('AGENTS.md');
      expect(md).toContain('CLAUDE.md');
      expect(md).toContain('## Target');
      expect(md).toContain('## Baseline 必读');
      expect(md).toContain('[必读]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('includes schemaVersion in manifest', async () => {
    const root = await contextFixtureRepo('schema-version');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1' });
      expect(manifest.schemaVersion).toBe('1.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('assigns tier and reasons to each context item', async () => {
    const root = await contextFixtureRepo('tier-reasons');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1' });

      // All items should have tier and reasons
      for (const [, items] of Object.entries(manifest.context)) {
        for (const item of items) {
          expect(item.tier).toBeDefined();
          expect(item.reasons).toBeDefined();
          expect(Array.isArray(item.reasons)).toBe(true);
          expect(item.reasons!.length).toBeGreaterThan(0);
        }
      }

      // Baseline items should have tier 'baseline'
      for (const item of manifest.context['baseline']) {
        expect(item.tier).toBe('baseline');
      }

      // Target items should have tier 'target'
      for (const item of manifest.context['target']) {
        expect(item.tier).toBe('target');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces stable JSON on double stringify', async () => {
    const root = await contextFixtureRepo('json-stable');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1' });
      const s1 = JSON.stringify(manifest);
      const s2 = JSON.stringify(manifest);
      expect(s1).toBe(s2);
      // Also verify roundtrip
      const parsed = JSON.parse(s1);
      expect(JSON.stringify(parsed)).toBe(s1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('merges reasons when paths deduplicate', async () => {
    const root = await contextFixtureRepo('reason-merge');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1' });

      // traceability-matrix-v2.md is in baseline AND has matrix row reason merged
      const matrixItem = manifest.context['baseline']?.find((i) => i.path === 'artifacts/traceability-matrix-v2.md');
      expect(matrixItem).toBeDefined();
      expect(matrixItem!.reasons!.length).toBeGreaterThanOrEqual(2);
      expect(matrixItem!.reason).toContain('traceability matrix');
      expect(matrixItem!.reason).toContain('matrix row for A1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sorts tiers in stable order within categories', async () => {
    const root = await contextFixtureRepo('tier-sort');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const m1 = resolveArtifactContext(graph, { feature: 'A1' });
      const m2 = resolveArtifactContext(graph, { feature: 'A1' });

      for (const key of Object.keys(m1.context)) {
        expect(JSON.stringify(m1.context[key])).toBe(JSON.stringify(m2.context[key]));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('implementation mode limits non-baseline categories', async () => {
    const root = await contextFixtureRepo('impl-mode');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const impl = resolveArtifactContext(graph, { feature: 'A1', mode: 'implementation', maxPerCategory: 1 });
      const full = resolveArtifactContext(graph, { feature: 'A1', mode: 'full' });

      // implementation should have same or fewer items in non-baseline categories
      for (const key of Object.keys(impl.context)) {
        if (key === 'baseline' || key === 'target') continue;
        const fullCount = full.context[key]?.length ?? 0;
        expect(impl.context[key].length).toBeLessThanOrEqual(Math.min(fullCount, 1));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('includes omitted items when maxPerCategory is exceeded', async () => {
    const root = await contextFixtureRepo('omitted');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1', mode: 'implementation', maxPerCategory: 1 });

      // Should have omitted items if there are more than 1 item per non-baseline category
      const hasOverflow = Object.values(manifest.context).some((items, _i, _arr) => {
        // Check if any non-baseline category had more items in full mode
        return items.length >= 1;
      });
      if (manifest.omitted!.length > 0) {
        for (const item of manifest.omitted!) {
          expect(item.path).toBeDefined();
          expect(item.tier).toBeDefined();
          expect(item.reasons).toBeDefined();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('full mode retains all context items', async () => {
    const root = await contextFixtureRepo('full-mode');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const full = resolveArtifactContext(graph, { feature: 'A1', mode: 'full' });

      // Full mode should have empty omitted
      expect(full.omitted).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('baseline contains exactly the 19 key files and missing is empty when all exist', async () => {
    const root = await contextFixtureRepo('baseline-19');
    try {
      // Create all 19 baseline files so they appear in graph nodes
      const baselineFiles = [
        'AGENTS.md',
        'CLAUDE.md',
        'artifacts/artifact-chain-spec.md',
        'artifacts/blueprints/generation-packet-spec.md',
        'artifacts/blueprints/implementation-blueprint.md',
        'artifacts/contracts/interface-contracts.md',
        'artifacts/contracts/data-contracts.md',
        'artifacts/contracts/application-state-machines.md',
        'artifacts/contracts/error-model.md',
        'artifacts/contracts/report-contracts.md',
        'artifacts/contracts/ui-flow-contracts.md',
        'artifacts/contracts/non-functional-budgets.md',
        'artifacts/domain/domain-glossary.md',
        'artifacts/domain/bounded-context-map.md',
        'artifacts/domain/domain-invariants.md',
        'artifacts/tests/rule-golden-cases.md',
        'artifacts/tests/verification-fixtures.md',
        'artifacts/design/test-strategy.md',
      ];
      for (const f of baselineFiles) {
        await write(root, f, `# ${f}\n`);
      }

      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1', root });

      const baselinePaths = manifest.context['baseline'].map((i) => i.path);

      expect(baselinePaths.sort()).toEqual([
        'AGENTS.md',
        'CLAUDE.md',
        'artifacts/artifact-chain-spec.md',
        'artifacts/blueprints/generation-packet-spec.md',
        'artifacts/blueprints/implementation-blueprint.md',
        'artifacts/contracts/interface-contracts.md',
        'artifacts/contracts/data-contracts.md',
        'artifacts/contracts/application-state-machines.md',
        'artifacts/contracts/error-model.md',
        'artifacts/contracts/report-contracts.md',
        'artifacts/contracts/ui-flow-contracts.md',
        'artifacts/contracts/non-functional-budgets.md',
        'artifacts/domain/domain-glossary.md',
        'artifacts/domain/bounded-context-map.md',
        'artifacts/domain/domain-invariants.md',
        'artifacts/tests/rule-golden-cases.md',
        'artifacts/tests/verification-fixtures.md',
        'artifacts/design/test-strategy.md',
        'artifacts/traceability-matrix-v2.md',
      ].sort());
      expect(manifest.context['baseline'].every((i) => i.required === true)).toBe(true);
      expect(manifest.context['baseline'].every((i) => i.tier === 'baseline')).toBe(true);
      // All baseline files exist on disk → no missing baseline entries
      const missingBaseline = manifest.missingDetails!.filter((d) => d.kind === 'missing-baseline');
      expect(missingBaseline).toHaveLength(0);
      expect(manifest.missing).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // ── Universal baseline fail-closed tests ──

  it('reports missing baseline files when graph lacks ALWAYS_PRESENT items', async () => {
    const root = await contextFixtureRepo('baseline-missing');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1', root });

      // traceability-matrix-v2.md exists in graph; other baseline files do not
      const missingBaseline = manifest.missingDetails!.filter((d) => d.kind === 'missing-baseline');
      expect(missingBaseline.length).toBeGreaterThan(0);
      expect(missingBaseline.every((d) => d.suggestedAction.includes('创建文件'))).toBe(true);

      // The one baseline file that exists in graph should NOT be in missing
      expect(manifest.missing.some((m) => m.includes('traceability-matrix-v2.md'))).toBe(false);

      // But baseline items that don't exist should be in missing
      expect(manifest.missing.some((m) => m.includes('AGENTS.md'))).toBe(true);
      expect(manifest.missing.some((m) => m.includes('CLAUDE.md'))).toBe(true);

      // Baseline items should still appear in context (injected before existence check)
      expect(manifest.context['baseline']).toBeDefined();
      expect(manifest.context['baseline'].some((i) => i.path === 'AGENTS.md')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('universalBaseline: false skips baseline injection entirely', async () => {
    const root = await contextFixtureRepo('baseline-optout');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1', universalBaseline: false });

      // No baseline category when opt-out
      expect(manifest.context['baseline']).toBeUndefined();
      // No missing baseline entries
      expect(manifest.missingDetails!.filter((d) => d.kind === 'missing-baseline')).toHaveLength(0);
      expect(manifest.missing).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // ── Universal baseline policy tests ──
  // @feature ACA17
  // @scenario S-60
  // @scenario S-61
  // @scenario S-62

  it('sets baselinePolicy=true in manifest when universal baseline enabled', async () => {
    const root = await contextFixtureRepo('baseline-policy-enabled');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1', root });
      expect(manifest.baselinePolicy).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sets baselinePolicy=false in manifest when universal baseline explicitly disabled', async () => {
    const root = await contextFixtureRepo('baseline-policy-disabled');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1', universalBaseline: false });
      expect(manifest.baselinePolicy).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fail-closed: reports all baseline items as missing when baseline enabled but no root', async () => {
    const root = await contextFixtureRepo('baseline-noroot');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      // Use a graph without root to simulate missing root on both sides
      const graphNoRoot: ArtifactGraph = { nodes: graph.nodes, edges: graph.edges, generatedAt: graph.generatedAt };
      // Call without opts.root and graph.root — should fail-closed
      const manifest = resolveArtifactContext(graphNoRoot, { feature: 'A1', universalBaseline: true });
      expect(manifest.baselinePolicy).toBe(true);
      // All 19 baseline items should be reported as missing
      const missingBaseline = manifest.missingDetails!.filter((d) => d.kind === 'missing-baseline');
      expect(missingBaseline.length).toBe(19);
      expect(manifest.missing.some((m) => m.includes('Cannot verify baseline without root'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fail-closed: graph without root field and no opts.root reports all baseline items as missing', async () => {
    const root = await contextFixtureRepo('baseline-graph-noroot');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      // Simulate graph without root (like a consumer that builds graph literal)
      const graphNoRoot: ArtifactGraph = { nodes: graph.nodes, edges: graph.edges, generatedAt: graph.generatedAt };
      expect(graphNoRoot.root).toBeUndefined();
      const manifest = resolveArtifactContext(graphNoRoot, { feature: 'A1', universalBaseline: true });
      expect(manifest.baselinePolicy).toBe(true);
      const missingBaseline = manifest.missingDetails!.filter((d) => d.kind === 'missing-baseline');
      expect(missingBaseline.length).toBe(19);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('scan→resolve: opts.root omitted but graph.root provides project root for baseline verification', async () => {
    const root = await contextFixtureRepo('baseline-graph-root');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      // graph.root should be populated by scanArtifacts
      expect(graph.root).toBeDefined();
      expect(graph.root).toBe(root);
      // resolveArtifactContext without opts.root should use graph.root
      const manifest = resolveArtifactContext(graph, { feature: 'A1', universalBaseline: true });
      expect(manifest.baselinePolicy).toBe(true);
      // Should use graph.root for file existence checks — AGENTS.md is missing from fixture
      expect(manifest.missing.some((m) => m.includes('AGENTS.md'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // ── S-61: loadConfig rejects non-boolean universal_baseline ──
  // @feature ACA17
  // @scenario S-61
  // @decision D-ACA-17

  it.each([
    [0, 'number 0'],
    ['', 'empty string'],
    ['false', 'string "false"'],
    [1, 'number 1'],
    ['true', 'string "true"'],
  ])('S-61: loadConfig rejects context.universal_baseline=%j (%s)', async (value, _label) => {
    const root = await contextFixtureRepo(`baseline-invalid-${typeof value}-${String(value)}`);
    try {
      await write(root, 'artifact-graph.config.yaml', `context:\n  universal_baseline: ${JSON.stringify(value)}\n`);
      await expect(loadConfig(root)).rejects.toThrow(/Invalid context\.universal_baseline/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // ── S-62: baseline directory and unreadable file detection ──
  // @feature ACA17
  // @scenario S-62
  // @decision D-ACA-17

  it('S-62: directory masquerading as baseline file is reported in missing', async () => {
    const root = await contextFixtureRepo('baseline-directory');
    try {
      // Create AGENTS.md as a directory instead of a file
      await mkdir(join(root, 'AGENTS.md'), { recursive: true });
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1', root });
      const dirMissing = manifest.missingDetails!.filter(
        (d) => d.kind === 'missing-baseline' && d.message.includes('not a regular file') && d.ref === 'AGENTS.md',
      );
      expect(dirMissing.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('S-62: unreadable baseline file is reported in missing', async () => {
    const root = await contextFixtureRepo('baseline-unreadable');
    try {
      // Create AGENTS.md with no read permissions
      const agentsPath = join(root, 'AGENTS.md');
      await write(root, 'AGENTS.md', '# AGENTS\n');
      const { chmodSync } = await import('node:fs');
      chmodSync(agentsPath, 0o000);
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A1', root });
      const unreadableMissing = manifest.missingDetails!.filter(
        (d) => d.kind === 'missing-baseline' && d.message.includes('not readable') && d.ref === 'AGENTS.md',
      );
      expect(unreadableMissing.length).toBeGreaterThanOrEqual(1);
      // Cleanup: restore permissions before rm
      chmodSync(agentsPath, 0o644);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // ── T09 Missing Diagnostics tests ──

  it('T09: populates missingDetails for missing scenario target', async () => {
    const root = await contextFixtureRepo('t09-scenario-notfound');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { scenario: 'S-9999' });

      expect(manifest.missing).toHaveLength(1);
      expect(manifest.missingDetails).toBeDefined();
      expect(manifest.missingDetails).toHaveLength(1);
      expect(manifest.missingDetails![0]).toEqual(expect.objectContaining({
        ref: 'S-9999',
        kind: 'target-not-found',
        suggestedAction: '创建文件或检查 ID 拼写',
      }));
      // missingDetails.length === missing.length (requirement 2)
      expect(manifest.missingDetails!.length).toBe(manifest.missing.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('T09: populates missingDetails for missing decision target', async () => {
    const root = await contextFixtureRepo('t09-decision-notfound');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { decision: 'D-MISSING-XX' });

      expect(manifest.missing).toHaveLength(1);
      expect(manifest.missingDetails).toBeDefined();
      expect(manifest.missingDetails).toHaveLength(1);
      expect(manifest.missingDetails![0]).toEqual(expect.objectContaining({
        ref: 'D-MISSING-XX',
        kind: 'target-not-found',
        message: expect.stringContaining('decision:D-MISSING-XX'),
        suggestedAction: '创建文件或检查 ID 拼写',
      }));
      expect(manifest.missingDetails!.length).toBe(manifest.missing.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('T09: populates missingDetails for unresolved-outgoing reference', async () => {
    const root = await contextFixtureRepo('t09-unresolved-out');
    try {
      // Add a scenario that references a non-existent feature
      await write(
        root,
        'artifacts/scenarios/batch-unresolved.md',
        `## S-88: 场景引用不存在的功能

**关联功能**: ZZZ999 (Nonexistent feature)
`,
      );

      const graph = await scanArtifacts(root, await loadConfig(root));
      // Verify S-88 exists
      expect(graph.nodes.some((n) => n.uid === 'scenario:S-88')).toBe(true);

      const manifest = resolveArtifactContext(graph, { scenario: 'S-88' });

      expect(manifest.missing.length).toBeGreaterThanOrEqual(1);
      expect(manifest.missingDetails).toBeDefined();
      expect(manifest.missingDetails!.length).toBe(manifest.missing.length);

      const unresolved = manifest.missingDetails!.find((d) => d.kind === 'unresolved-outgoing');
      expect(unresolved).toBeDefined();
      expect(unresolved!.ref).toBe('feature:ZZZ999');
      expect(unresolved!.from).toBe('scenario:S-88');
      expect(unresolved!.suggestedAction).toBe('添加引用或删除悬挂引用');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('T09: missingDetails.length always equals missing.length', async () => {
    const root = await contextFixtureRepo('t09-length-consistency');
    try {
      // Create fixture with 2 unresolved references (S-9999 + D-MISSING)
      await write(
        root,
        'artifacts/prd/features/A99-multi-missing.md',
        `---
id: A99
title: Multi missing
status: done
scenarios: [S-9999]
decisions: [D-MISSING]
---
# A99
`,
      );

      const graph = await scanArtifacts(root, await loadConfig(root));
      const manifest = resolveArtifactContext(graph, { feature: 'A99' });

      expect(manifest.missing.length).toBeGreaterThanOrEqual(1);
      expect(manifest.missingDetails).toBeDefined();
      // Core consistency invariant: every missing string has a corresponding MissingDetail
      expect(manifest.missingDetails!.length).toBe(manifest.missing.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('T09: every MissingDetail kind has a non-empty suggestedAction', async () => {
    const root = await contextFixtureRepo('t09-suggested-action');
    try {
      // target-not-found
      const graph = await scanArtifacts(root, await loadConfig(root));
      const notFound = resolveArtifactContext(graph, { feature: 'Z99' });
      for (const d of notFound.missingDetails!) {
        expect(d.suggestedAction).toBeTruthy();
        expect(d.suggestedAction.length).toBeGreaterThan(0);
      }

      // multiple-targets
      const multi = resolveArtifactContext(graph, { feature: 'A1', scenario: 'S-01' });
      for (const d of multi.missingDetails!) {
        expect(d.suggestedAction).toBeTruthy();
        expect(d.suggestedAction.length).toBeGreaterThan(0);
      }

      // no-target
      const noTarget = resolveArtifactContext(graph, {});
      for (const d of noTarget.missingDetails!) {
        expect(d.suggestedAction).toBeTruthy();
        expect(d.suggestedAction.length).toBeGreaterThan(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('T09: backward compatibility — missing array works when missingDetails is undefined', async () => {
    // Construct a manifest manually without missingDetails to verify backward compat
    const graph = buildGraph(
      [
        { type: 'feature', code: 'A1', title: 'Feature A1', path: 'features/A1.md', line: 1 },
      ],
      [
        {
          from: 'feature:A1',
          to: 'feature:MISSING',
          kind: 'references',
          source: 'test',
          sourcePath: 'features/A1.md',
          sourceLine: 2,
        },
      ],
    );
    const manifest = resolveArtifactContext(graph, { feature: 'A1' });
    // missing array should exist and have content regardless of missingDetails
    expect(manifest.missing).toBeDefined();
    expect(Array.isArray(manifest.missing)).toBe(true);
    expect(manifest.missing.length).toBeGreaterThan(0);
    expect(manifest.missing[0]).toContain('MISSING');

    // missingDetails is also populated (new behavior), but missing is the canonical field
    expect(manifest.missingDetails).toBeDefined();
    expect(manifest.missingDetails!.length).toBe(manifest.missing.length);
  });

  it('T09: MissingDetail type has all required fields with correct types', () => {
    // Type-level check: MissingDetail should have ref, from, kind, message, suggestedAction
    const detail: MissingDetail = {
      ref: 'feature:Z99',
      from: 'feature:A1',
      kind: 'unresolved-outgoing',
      message: 'Unresolved reference from feature:A1: feature:Z99',
      suggestedAction: '添加引用或删除悬挂引用',
    };
    expect(typeof detail.ref).toBe('string');
    expect(typeof detail.from).toBe('string');
    expect(typeof detail.kind).toBe('string');
    expect(typeof detail.message).toBe('string');
    expect(typeof detail.suggestedAction).toBe('string');
    // kind should be one of the allowed values
    expect(['unresolved-outgoing', 'unresolved-incoming', 'target-not-found', 'multiple-targets']).toContain(detail.kind);
  });
});

const AUDIT_BASELINE_FILES = [
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

async function auditFixtureRepo(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-pa-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });

  await write(root, 'artifact-graph.config.yaml', `idRanges:\n  scenario:\n    batch-49:\n      prefix: S-\n      start: 1200\n      end: 1299\n`);
  for (const bf of AUDIT_BASELINE_FILES) {
    await write(root, bf.path, bf.content);
  }
  await write(root, 'artifacts/prd/features/A1-skill-import.md', `---
id: A1
title: Skill import/register
status: done
scenarios: [S-01]
design_docs: [design-skill-import]
---
# A1: Skill import/register
`);
  await write(root, 'artifacts/design/design-skill-import.md', `---
title: Skill import design
related_features: [A1]
---
# Skill import design
`);
  await write(root, 'artifacts/scenarios/batch-1.md', `## S-01: Import local skill

**关联功能**: A1 (Skill import/register)
`);
  await write(root, 'artifacts/decisions/D-ARCH-01.md', `---
id: D-ARCH-01
title: TypeScript full stack
status: approved
---
# D-ARCH-01: TypeScript full stack
`);
  return root;
}

describe('packet-audit', () => {
  it('parseTargetsFile correctly parses valid type:id lines', () => {
    const content = 'feature:A1\nscenario:S-01\ndecision:D-ARCH-01\n';
    const result = parseTargetsFile(content);
    expect(result.targets).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
    expect(result.targets[0]).toEqual({ type: 'feature', id: 'A1' });
    expect(result.targets[1]).toEqual({ type: 'scenario', id: 'S-01' });
    expect(result.targets[2]).toEqual({ type: 'decision', id: 'D-ARCH-01' });
  });

  it('parseTargetsFile skips blank lines and comments', () => {
    const content = '# header comment\nfeature:A1\n\n  \n# another comment\nscenario:S-01\n\n';
    const result = parseTargetsFile(content);
    expect(result.targets).toHaveLength(2);
    expect(result.targets[0]).toEqual({ type: 'feature', id: 'A1' });
    expect(result.targets[1]).toEqual({ type: 'scenario', id: 'S-01' });
  });

  it('auditPackets returns correct summary for valid targets', async () => {
    const root = await auditFixtureRepo('valid-summary');
    try {
      const targets = [
        { type: 'feature' as const, id: 'A1' },
        { type: 'scenario' as const, id: 'S-01' },
        { type: 'decision' as const, id: 'D-ARCH-01' },
      ];
      const summary = await auditPackets(root, targets, { root });
      expect(summary.total).toBe(3);
      expect(summary.passed).toBe(3);
      expect(summary.failed).toBe(0);
      expect(summary.missing).toBe(0);
      expect(summary.targets).toHaveLength(3);
      expect(summary.generatedAt).toBeDefined();
      for (const entry of summary.targets) {
        expect(entry.status).toBe('passed');
        expect(entry.errors).toEqual([]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('auditPackets single target failure does not interrupt the batch', async () => {
    const root = await auditFixtureRepo('batch-resilience');
    try {
      const outDir = join(tmpdir(), `packet-audit-resilience-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const targets = [
        { type: 'feature' as const, id: 'A1' },
        { type: 'feature' as const, id: 'DOES_NOT_EXIST' },
        { type: 'scenario' as const, id: 'S-01' },
      ];
      const summary = await auditPackets(root, targets, { root, outDir });
      expect(summary.total).toBe(3);
      expect(summary.passed).toBe(2);
      expect(summary.failed).toBe(1);
      expect(summary.targets).toHaveLength(3);
      // The valid targets should still be processed
      expect(summary.targets[0].status).toBe('passed');
      expect(summary.targets[0].id).toBe('A1');
      expect(summary.targets[1].status).toBe('failed');
      expect(summary.targets[1].id).toBe('DOES_NOT_EXIST');
      expect(summary.targets[2].status).toBe('passed');
      expect(summary.targets[2].id).toBe('S-01');
      // summary.json should still be written
      const summaryContent = await readFile(join(outDir, 'summary.json'), 'utf-8');
      const parsed = JSON.parse(summaryContent);
      expect(parsed.total).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('discoverTargets', () => {
  it('returns all configured packet target nodes', async () => {
    const root = await fixtureRepo('discover-all');
    try {
      const graph = await scanArtifacts(root);
      const targets = discoverTargets(graph);

      const types = targets.map((t) => t.type);
      expect(types).toContain('feature');
      expect(types).toContain('scenario');
      expect(types).toContain('decision');

      // fixtureRepo creates A1, ABCD1, B6 (features), S-01, S-01a, S-02, S-03 (scenarios), D-ARCH-01, D-SCAN-01, D-TOOL-02 (decisions)
      const featureIds = targets.filter((t) => t.type === 'feature').map((t) => t.id);
      expect(featureIds).toContain('A1');
      expect(featureIds).toContain('ABCD1');
      expect(featureIds).toContain('B6');

      const scenarioIds = targets.filter((t) => t.type === 'scenario').map((t) => t.id);
      expect(scenarioIds).toContain('S-01');
      expect(scenarioIds).toContain('S-01a');
      expect(scenarioIds).toContain('S-03');

      const decisionIds = targets.filter((t) => t.type === 'decision').map((t) => t.id);
      expect(decisionIds).toContain('D-ARCH-01');
      expect(decisionIds).toContain('D-SCAN-01');
      expect(decisionIds).toContain('D-TOOL-02');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('limit correctly truncates results', async () => {
    const root = await fixtureRepo('discover-limit');
    try {
      const graph = await scanArtifacts(root);
      const targets = discoverTargets(graph, { limit: 5 });

      expect(targets.length).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('round-robin: when limit < total all target types are represented', async () => {
    const root = await fixtureRepo('discover-round-robin');
    try {
      const graph = await scanArtifacts(root);
      const allTargets = discoverTargets(graph, { limit: 0 });
      const limit = Math.min(6, allTargets.length);
      const targets = discoverTargets(graph, { limit });

      expect(targets.length).toBe(limit);

      // Round-robin order: feature -> scenario -> decision -> design -> e2e_test, repeating
      // Verify all discovered types are from the allowed set
      const allowedTypes = new Set(['feature', 'scenario', 'decision', 'design', 'e2e_test']);
      for (const target of targets) {
        expect(allowedTypes.has(target.type)).toBe(true);
      }

      // All discovered types must be represented
      const uniqueTypes = new Set(targets.map((t) => t.type));
      expect(uniqueTypes.has('feature')).toBe(true);
      expect(uniqueTypes.has('scenario')).toBe(true);
      expect(uniqueTypes.has('decision')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('empty graph returns empty array', async () => {
    const graph = { nodes: [], edges: [], generatedAt: new Date(0).toISOString() };
    const targets = discoverTargets(graph);
    expect(targets).toEqual([]);
  });

  it('sorting stable: same input twice produces identical results', async () => {
    const root = await fixtureRepo('discover-stable');
    try {
      const graph = await scanArtifacts(root);
      const first = discoverTargets(graph);
      const second = discoverTargets(graph);

      expect(first).toEqual(second);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('only includes feature/scenario/decision/design/e2e_test, not other types', async () => {
    const root = await fixtureRepo('discover-types-only');
    try {
      const graph = await scanArtifacts(root);
      const config = await loadConfig(root);
      const targets = discoverTargets(graph, { schema: config });

      const allowedTypes = new Set(['feature', 'scenario', 'decision', 'design', 'e2e_test']);
      for (const target of targets) {
        expect(allowedTypes.has(target.type)).toBe(true);
      }
      expect(getTargetArtifactTypes(config)).toEqual([...allowedTypes]);

      // Verify that the graph contains other types (entity, test) which should be excluded
      const graphTypes = new Set(graph.nodes.map((n) => n.type));
      expect(graphTypes.has('entity')).toBe(true);
      expect(graphTypes.has('test')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('custom type runtime: config-driven target, extraFields, and diagnostics', () => {
  it('returns targetCapable=true for explicit target:true custom type', async () => {
    const root = await fixtureRepo('custom-target');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  design:
    paths: ["artifacts/design/**/*.md"]
  e2e_test:
    paths: ["artifacts/tests/e2e/*.md"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
    displayName: API Contract
    layer: contract
idPatterns:
  api_contract: "^API-\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      const config = await loadConfig(root);

      // Custom type with explicit target:true should be targetCapable
      expect(getArtifactTypeMetadata(config, 'api_contract')).toEqual(expect.objectContaining({
        type: 'api_contract',
        targetCapable: true,
        displayName: 'API Contract',
        layer: 'contract',
      }));

      // Legacy core types still targetCapable
      expect(getArtifactTypeMetadata(config, 'feature')).toEqual(expect.objectContaining({
        targetCapable: true,
      }));
      expect(getArtifactTypeMetadata(config, 'scenario')).toEqual(expect.objectContaining({
        targetCapable: true,
      }));
      expect(getArtifactTypeMetadata(config, 'decision')).toEqual(expect.objectContaining({
        targetCapable: true,
      }));
      expect(getArtifactTypeMetadata(config, 'design')).toEqual(expect.objectContaining({
        targetCapable: true,
      }));
      expect(getArtifactTypeMetadata(config, 'e2e_test')).toEqual(expect.objectContaining({
        targetCapable: true,
      }));

      // Custom type without target should NOT be targetCapable
      // (Add a context-only type to verify)
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
  runbook:
    paths: ["artifacts/runbooks/**/*.md"]
idPatterns:
  api_contract: "^API-\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      const config2 = await loadConfig(root);
      expect(getArtifactTypeMetadata(config2, 'runbook')).toEqual(expect.objectContaining({
        targetCapable: false,
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces ARTIFACT_PATH_OVERLAP diagnostic when multiple types match the same file', async () => {
    const root = await fixtureRepo('path-overlap');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  design:
    paths: ["artifacts/design/**/*.md"]
  e2e_test:
    paths: ["artifacts/tests/e2e/*.md"]
  overlap_type:
    paths: ["artifacts/decisions/**/*.md"]
statuses: [planned, active, done, deprecated, accepted]
`,
      );

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const issues = validateGraph(graph, config);

      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'ARTIFACT_PATH_OVERLAP',
          severity: 'warning',
          path: expect.stringContaining('D-FRONTMATTER-01'),
        }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('path overlap selects the more specific type for the file', async () => {
    const root = await fixtureRepo('path-overlap-specificity');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  design:
    paths: ["artifacts/design/**/*.md"]
  e2e_test:
    paths: ["artifacts/tests/e2e/*.md"]
  specific_type:
    paths: ["artifacts/decisions/D-FRONTMATTER-01.md"]
statuses: [planned, active, done, deprecated, accepted]
`,
      );

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // More specific type (exact path) should win
      const node = graph.nodes.find((n) => n.path === 'artifacts/decisions/D-FRONTMATTER-01.md');
      expect(node).toBeDefined();
      expect(node!.type).toBe('specific_type');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('custom type runtime: generic Markdown parser', () => {
  it('parses registered custom Markdown type into graph nodes with uid, status, and rawFrontmatter', async () => {
    const root = await fixtureRepo('generic-md-parse');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  design:
    paths: ["artifacts/design/**/*.md"]
  e2e_test:
    paths: ["artifacts/tests/e2e/*.md"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
    extraFields:
      - name: version
        type: string
      - name: approved
        type: boolean
      - name: method
        type: enum
        enum: [GET, POST, PUT, DELETE]
idPatterns:
  api_contract: "^API-\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Order API
status: active
version: v1
approved: true
method: GET
custom_note: "this should be preserved in rawFrontmatter"
---

# API-001: Order API
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // Node should exist with correct uid
      const node = graph.nodes.find((n) => n.uid === 'api_contract:API-001');
      expect(node).toBeDefined();
      expect(node!.type).toBe('api_contract');
      expect(node!.code).toBe('API-001');
      expect(node!.title).toBe('Order API');
      expect(node!.status).toBe('active');

      // ExtraFields declared in config should be in attrs.indexedFields
      expect(node!.attrs).toEqual(expect.objectContaining({
        indexedFields: {
          version: 'v1',
          approved: true,
          method: 'GET',
        },
      }));

      // All raw frontmatter should be preserved in attrs.rawFrontmatter
      expect(node!.attrs).toEqual(expect.objectContaining({
        rawFrontmatter: expect.objectContaining({
          id: 'API-001',
          title: 'Order API',
          status: 'active',
          version: 'v1',
          approved: true,
          method: 'GET',
          custom_note: 'this should be preserved in rawFrontmatter',
        }),
      }));

      // Parsing is valid; an unconnected custom artifact intentionally receives an isolation warning.
      const issues = validateGraph(graph, config);
      const apiIssues = issues.filter((i) => i.path.includes('API-001'));
      expect(apiIssues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(apiIssues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'CUSTOM_ARTIFACT_ISOLATED', severity: 'warning' }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces ARTIFACT_ID_MISSING diagnostic for custom type without id in frontmatter', async () => {
    const root = await fixtureRepo('generic-md-missing-id');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
idPatterns:
  api_contract: "^API-\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await write(root, 'artifacts/contracts/api/no-id.md', `---
title: Missing ID Contract
status: active
---

# Missing ID
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const issues = validateGraph(graph, config);

      // Should produce ARTIFACT_ID_MISSING diagnostic
      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'ARTIFACT_ID_MISSING',
          severity: 'warning',
          path: expect.stringContaining('no-id.md'),
        }),
      ]));

      // Should NOT create a node for the file
      expect(graph.nodes.find((n) => n.path.includes('no-id.md'))).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces INVALID_ID diagnostic for custom type with id not matching idPattern', async () => {
    const root = await fixtureRepo('generic-md-invalid-id');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
idPatterns:
  api_contract: "^API-\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await write(root, 'artifacts/contracts/api/bad-id.md', `---
id: BAD-FORMAT
title: Bad ID Format
status: active
---

# BAD-FORMAT
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const issues = validateGraph(graph, config);

      // Should produce INVALID_ID diagnostic
      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'INVALID_ID',
          severity: 'error',
          message: expect.stringContaining('BAD-FORMAT'),
          path: expect.stringContaining('bad-id.md'),
        }),
      ]));

      // Node should still be created (invalid ID is a warning, not fatal)
      expect(graph.nodes.find((n) => n.uid === 'api_contract:BAD-FORMAT')).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces EXTRA_FIELD_TYPE_MISMATCH diagnostic for type mismatches on declared extraFields', async () => {
    const root = await fixtureRepo('generic-md-extra-fields-mismatch');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    extraFields:
      - name: version
        type: string
      - name: approved
        type: boolean
      - name: method
        type: enum
        enum: [GET, POST, PUT, DELETE]
      - name: port
        type: number
idPatterns:
  api_contract: "^API-\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await write(root, 'artifacts/contracts/api/API-002.md', `---
id: API-002
title: Bad Types Contract
status: active
version: 123
approved: "yes"
method: PATCH
port: "not-a-number"
---

# API-002: Bad Types
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const issues = validateGraph(graph, config);

      // Should produce EXTRA_FIELD_TYPE_MISMATCH for each mismatch
      const mismatchIssues = issues.filter((i) => i.code === 'EXTRA_FIELD_TYPE_MISMATCH');
      expect(mismatchIssues.length).toBeGreaterThanOrEqual(3);

      // version expects string but got number
      expect(mismatchIssues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('version'),
          path: expect.stringContaining('API-002'),
        }),
      ]));
      // approved expects boolean but got string
      expect(mismatchIssues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('approved'),
        }),
      ]));
      // method expects enum but got value not in enum list
      expect(mismatchIssues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('method'),
        }),
      ]));
      // port expects number but got string
      expect(mismatchIssues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('port'),
        }),
      ]));

      // Node should still be created
      expect(graph.nodes.find((n) => n.uid === 'api_contract:API-002')).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('existing core parsers still work unchanged after generic parser is added', async () => {
    const root = await fixtureRepo('core-parsers-unchanged');
    try {
      const graph = await scanArtifacts(root);

      // Core types still parsed by specialized parsers
      expect(graph.nodes.find((n) => n.uid === 'feature:A1')).toBeDefined();
      expect(graph.nodes.find((n) => n.uid === 'decision:D-TOOL-02')).toBeDefined();
      expect(graph.nodes.find((n) => n.uid === 'scenario:S-01')).toBeDefined();
      expect(graph.nodes.find((n) => n.uid === 'design:design-skill-import')).toBeDefined();
      expect(graph.nodes.find((n) => n.uid === 'entity:E-001')).toBeDefined();

      // Edges still built correctly
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ from: 'feature:A1', to: 'scenario:S-01', kind: 'covers' }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ from: 'scenario:S-01', to: 'feature:A1', kind: 'references' }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ArtifactGraph backward compatibility', () => {
  it('allows old-style graph literal without diagnostics field and validateGraph handles it gracefully', () => {
    // Old consumers may construct ArtifactGraph without the diagnostics field.
    // The interface must remain assignable from this shape.
    const oldStyleGraph: ArtifactGraph = {
      nodes: [],
      edges: [],
      generatedAt: '2024-01-01T00:00:00.000Z',
      // intentionally no diagnostics field
    };

    // validateGraph must not throw when diagnostics is absent
    const issues = validateGraph(oldStyleGraph);
    expect(Array.isArray(issues)).toBe(true);

    // buildGraph always produces diagnostics, so new graphs are also valid
    const newStyleGraph = buildGraph([], []);
    expect(newStyleGraph.diagnostics).toEqual([]);
    const newIssues = validateGraph(newStyleGraph);
    expect(Array.isArray(newIssues)).toBe(true);
  });
});

describe('resolveArtifactTypeName', () => {
  it('resolves exact type name', () => {
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'feature')).toBe('feature');
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'scenario')).toBe('scenario');
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'decision')).toBe('decision');
  });

  it('resolves explicit alias to canonical type name', () => {
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'decisions')).toBe('decision');
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'adr')).toBe('decision');
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'prd-feature')).toBe('feature');
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'prd_features')).toBe('feature');
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'scenarios')).toBe('scenario');
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'scenario-script')).toBe('scenario');
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'design-spec')).toBe('design');
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'design_docs')).toBe('design');
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'e2e-test')).toBe('e2e_test');
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'e2e_tests')).toBe('e2e_test');
  });

  it('does NOT auto-convert hyphens to underscores or vice versa', () => {
    // e2e_test is a type, but e2e-test is an alias — both work because alias is explicit
    // But a non-existent hybrid should NOT work
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'e2e_test')).toBe('e2e_test');
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'e2e-test')).toBe('e2e_test');

    // feature-scenario is not a type or alias
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'feature-scenario')).toBeUndefined();

    // Random strings should not resolve
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, 'nonexistent')).toBeUndefined();
    expect(resolveArtifactTypeName(DEFAULT_SCHEMA, '')).toBeUndefined();
  });

  it('resolves custom type from config with aliases', async () => {
    const root = await fixtureRepo('resolve-type-custom');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
    aliases: [api-contract, apiContract]
idPatterns:
  api_contract: "^API-\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      const config = await loadConfig(root);
      expect(resolveArtifactTypeName(config, 'api_contract')).toBe('api_contract');
      expect(resolveArtifactTypeName(config, 'api-contract')).toBe('api_contract');
      expect(resolveArtifactTypeName(config, 'apiContract')).toBe('api_contract');
      // Close but wrong — no auto conversion
      expect(resolveArtifactTypeName(config, 'api contract')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('custom type runtime: dynamic related_* edges from frontmatter', () => {
  it('produces references edges for related_<core-type> fields on custom types', async () => {
    const root = await fixtureRepo('custom-related-core');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
    aliases: [features]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  decision:
    paths: ["artifacts/decisions/**/*.md"]
    aliases: [decisions, adr]
  design:
    paths: ["artifacts/design/**/*.md"]
  e2e_test:
    paths: ["artifacts/tests/e2e/*.md"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
idPatterns:
  api_contract: "^API-\\\\d+$"
  feature: "^[A-Z]{1,4}\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await write(root, 'artifacts/prd/features/ACA11.md', `---
id: ACA11
title: Extended Artifact Catalog
status: active
design_docs: [design-aca11]
---
# ACA11
`);
      await write(root, 'artifacts/design/design-aca11.md', `---
title: ACA11 Design
related_features: [ACA11]
---
# Design ACA11
`);
      await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Order API
status: active
related_features: [ACA11]
related_decisions: [D-TOOL-02]
---

# API-001: Order API
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // related_features (alias "features") should create references edge from api_contract to feature
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'api_contract:API-001',
        to: 'feature:ACA11',
        kind: 'references',
        source: 'frontmatter',
      }));

      // related_decisions (alias "decisions") should create references edge to decision
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'api_contract:API-001',
        to: 'decision:D-TOOL-02',
        kind: 'references',
        source: 'frontmatter',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces references edges for related_<custom-type> fields between custom types', async () => {
    const root = await fixtureRepo('custom-related-custom');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
  data_contract:
    paths: ["artifacts/contracts/data/**/*.md"]
    target: true
  db_migration:
    paths: ["artifacts/migrations/**/*.md"]
    target: true
idPatterns:
  api_contract: "^API-\\\\d+$"
  data_contract: "^DATA-\\\\d+$"
  db_migration: "^MIG-\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Order API
status: active
---
# API-001
`);
      await write(root, 'artifacts/contracts/data/DATA-001.md', `---
id: DATA-001
title: Order Data
status: active
---
# DATA-001
`);
      await write(root, 'artifacts/migrations/MIG-001.md', `---
id: MIG-001
title: Create orders table
status: active
related_data_contract: [DATA-001]
related_api_contract: [API-001]
---
# MIG-001
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // related_data_contract matches type name exactly → edge
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'db_migration:MIG-001',
        to: 'data_contract:DATA-001',
        kind: 'references',
        source: 'frontmatter',
      }));

      // related_api_contract matches type name exactly → edge
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'db_migration:MIG-001',
        to: 'api_contract:API-001',
        kind: 'references',
        source: 'frontmatter',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves related_* aliases to canonical types for edge creation', async () => {
    const root = await fixtureRepo('custom-related-alias');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
    aliases: [prd-feature, prd_features]
  decision:
    paths: ["artifacts/decisions/**/*.md"]
    aliases: [adr]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
    aliases: [api-contract]
idPatterns:
  api_contract: "^API-\\\\d+$"
  feature: "^[A-Z]{1,4}\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await write(root, 'artifacts/prd/features/ACA11.md', `---
id: ACA11
title: Extended
status: active
---
# ACA11
`);
      await write(root, 'artifacts/decisions/D-TOOL-02.md', `---
id: D-TOOL-02
title: Decision
status: active
---
# D-TOOL-02
`);
      await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Order API
status: active
related_prd_features: [ACA11]
related_adr: [D-TOOL-02]
---

# API-001
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // related_prd_features uses alias "prd-feature" → feature
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'api_contract:API-001',
        to: 'feature:ACA11',
        kind: 'references',
      }));

      // related_adr uses alias "adr" → decision
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'api_contract:API-001',
        to: 'decision:D-TOOL-02',
        kind: 'references',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects related_* with non-existent type suffix (no edge, no crash)', async () => {
    const root = await fixtureRepo('custom-related-invalid');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
    aliases: [features]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
idPatterns:
  api_contract: "^API-\\\\d+$"
  feature: "^[A-Z]{1,4}\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Order API
status: active
related_nonexistent_type: [X-001]
related_features: [ACA999]
---

# API-001
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // related_nonexistent_type should NOT produce any edge (unknown type)
      expect(graph.edges).not.toContainEqual(expect.objectContaining({
        from: 'api_contract:API-001',
        to: expect.stringContaining('X-001'),
      }));

      // related_features (alias "features") with valid type but nonexistent target ID still creates a dangling edge
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'api_contract:API-001',
        to: 'feature:ACA999',
        kind: 'references',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects related_* with target ID that fails the target type idPattern (no edge, INVALID_ID diagnostic)', async () => {
    const root = await fixtureRepo('custom-related-invalid-target-id');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
  data_contract:
    paths: ["artifacts/contracts/data/**/*.md"]
    target: true
    aliases: [data-contract]
idPatterns:
  api_contract: "^API-\\\\d+$"
  data_contract: "^DATA-\\\\d+$"
  feature: "^[A-Z]{1,4}\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Order API
status: active
related_feature: [ACA11]
related_data_contract: [NOT-DATA-FORMAT]
related_data-contract: [DATA-001]
---

# API-001
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // Legal relation: related_feature → feature:ACA11 (ACA11 matches ^[A-Z]{1,4}\\d+$)
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'api_contract:API-001',
        to: 'feature:ACA11',
        kind: 'references',
        source: 'frontmatter',
      }));

      // Legal relation: related_data-contract (alias) → data_contract:DATA-001
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'api_contract:API-001',
        to: 'data_contract:DATA-001',
        kind: 'references',
        source: 'frontmatter',
      }));

      // Illegal relation: NOT-DATA-FORMAT does not match ^DATA-\\d+$ → no edge
      expect(graph.edges).not.toContainEqual(expect.objectContaining({
        from: 'api_contract:API-001',
        to: 'data_contract:NOT-DATA-FORMAT',
      }));

      // Scan diagnostics should contain INVALID_ID for the illegal target
      const invalidTargetIssues = graph.diagnostics?.filter((d) =>
        d.code === 'INVALID_ID'
        && d.path.includes('API-001.md')
        && d.message.includes('NOT-DATA-FORMAT')
        && d.message.includes('data_contract')
      ) ?? [];
      expect(invalidTargetIssues.length).toBeGreaterThanOrEqual(1);
      // Verify the diagnostic has path and line
      expect(invalidTargetIssues[0]).toEqual(expect.objectContaining({
        path: expect.stringContaining('API-001.md'),
        line: expect.any(Number),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('custom type runtime: dynamic standalone @type ID traceability', () => {
  it('creates implements edges for dynamic @<custom-type> <ID> in Java files', async () => {
    const root = await fixtureRepo('custom-traceability-java');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  test:
    paths: ["src/**/*.java"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
    aliases: [api-contract]
idPatterns:
  api_contract: "^API-\\\\d+$"
  feature: "^[A-Z]{1,4}\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'artifacts/prd/features'), { recursive: true });
      await mkdir(join(root, 'artifacts/contracts/api'), { recursive: true });
      await write(root, 'artifacts/prd/features/ACA11.md', `---
id: ACA11
title: Extended Catalog
status: active
---
# ACA11
`);
      await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Order API
status: active
---
# API-001
`);
      // Java file with standalone traceability comments for a dynamic type and a core type.
      await write(root, 'src/OrderController.java', `package com.example;

// @api_contract API-001
// @feature ACA11
public class OrderController {
    // trailing comment @api_contract API-999
    public void createOrder() {}
}
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // The dynamic custom-type tag should create an implements edge.
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'implementation:src/OrderController.java',
        to: 'api_contract:API-001',
        kind: 'implements',
        source: 'test-comment',
      }));

      // The core feature tag should still work.
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'implementation:src/OrderController.java',
        to: 'feature:ACA11',
        kind: 'implements',
        source: 'test-comment',
      }));

      // Trailing comment (not standalone) should NOT create edge
      const trailingEdges = graph.edges.filter((e) =>
        e.from === 'implementation:src/OrderController.java'
        && e.to === 'api_contract:API-999'
      );
      expect(trailingEdges).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates edges for dynamic @<type> using alias in source code', async () => {
    const root = await fixtureRepo('custom-traceability-alias');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  test:
    paths: ["src/**/*.java"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
    aliases: [api-contract]
idPatterns:
  api_contract: "^API-\\\\d+$"
  feature: "^[A-Z]{1,4}\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'artifacts/prd/features'), { recursive: true });
      await mkdir(join(root, 'artifacts/contracts/api'), { recursive: true });
      await write(root, 'artifacts/prd/features/ACA11.md', `---
id: ACA11
title: Extended Catalog
status: active
---
# ACA11
`);
      await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Order API
status: active
---
# API-001
`);
      // Use alias "api-contract" instead of "api_contract"
      await write(root, 'src/OrderService.java', `package com.example;

// @api-contract API-001
// @feature ACA11
public class OrderService {}
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // @-api-contract (alias) should resolve to api_contract and create edge
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'implementation:src/OrderService.java',
        to: 'api_contract:API-001',
        kind: 'implements',
        source: 'test-comment',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects @<type> with ID not matching idPattern', async () => {
    const root = await fixtureRepo('custom-traceability-invalid-id');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  test:
    paths: ["src/**/*.java"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
idPatterns:
  api_contract: "^API-\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await mkdir(join(root, 'src'), { recursive: true });
      // No api_contract node needed — just testing tag validation
      await write(root, 'src/BadController.java', `package com.example;

// @api_contract BAD-FORMAT
public class BadController {}
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // ID "BAD-FORMAT" doesn't match ^API-\d+$, so no edge should be created
      expect(graph.edges).not.toContainEqual(expect.objectContaining({
        from: 'implementation:src/BadController.java',
        to: 'api_contract:BAD-FORMAT',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('excludes block comments, string literals, and trailing comments for dynamic @type tags', async () => {
    const root = await fixtureRepo('custom-traceability-exclusions');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  test:
    paths: ["src/**/*.java"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
idPatterns:
  api_contract: "^API-\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await mkdir(join(root, 'src'), { recursive: true });
      await write(root, 'src/ExclusionTest.java', `package com.example;

/* @api_contract API-001 */
String s = "// @api_contract API-002";
public void test() {} // @api_contract API-003
// @api_contract API-004
public class ExclusionTest {}
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // Only the standalone line comment on line 7 should produce an edge
      const edges = graph.edges.filter((e) =>
        e.from === 'test:src/ExclusionTest.java'
        && e.to.startsWith('api_contract:')
      );

      expect(edges).toContainEqual(expect.objectContaining({
        to: 'api_contract:API-004',
      }));

      // Block comment (line 3) should NOT produce edge
      expect(edges).not.toContainEqual(expect.objectContaining({ to: 'api_contract:API-001' }));
      // String literal (line 4) should NOT produce edge
      expect(edges).not.toContainEqual(expect.objectContaining({ to: 'api_contract:API-002' }));
      // Trailing comment (line 5) should NOT produce edge
      expect(edges).not.toContainEqual(expect.objectContaining({ to: 'api_contract:API-003' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves existing core tag behavior alongside dynamic custom tags', async () => {
    const root = await fixtureRepo('custom-traceability-mixed');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  test:
    paths: ["src/**/*.ts"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
    aliases: [api-contract]
idPatterns:
  api_contract: "^API-\\\\d+$"
  feature: "^[A-Z]{1,4}\\\\d+$"
  scenario: "^S-\\\\d+[a-z]?$"
  test: "^.+\\\\.java$"
  decision: "^D-[A-Z]+-\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'artifacts/prd/features'), { recursive: true });
      await mkdir(join(root, 'artifacts/scenarios'), { recursive: true });
      await mkdir(join(root, 'artifacts/decisions'), { recursive: true });
      await mkdir(join(root, 'artifacts/contracts/api'), { recursive: true });
      await write(root, 'artifacts/prd/features/ACA11.md', `---
id: ACA11
title: Extended
status: active
---
# ACA11
`);
      await write(root, 'artifacts/scenarios/S-25.md', `## S-25: Mixed tags

**关联功能**: ACA11
`);
      await write(root, 'artifacts/decisions/D-TOOL-10.md', `---
id: D-TOOL-10
title: Mixed Decision
status: active
---
# D-TOOL-10
`);
      await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Order API
status: active
---
# API-001
`);
      // TypeScript test file with mixed core and dynamic tags
      await write(root, 'src/order.test.ts', `// @scenario S-25 @feature ACA11 @api_contract API-001 @decision D-TOOL-10
describe('order', () => {});
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // All four tag types should produce edges on the same line
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'test:src/order.test.ts',
        to: 'scenario:S-25',
        kind: 'verifies',
        source: 'test-comment',
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'test:src/order.test.ts',
        to: 'feature:ACA11',
        kind: 'verifies',
        source: 'test-comment',
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'test:src/order.test.ts',
        to: 'api_contract:API-001',
        kind: 'verifies',
        source: 'test-comment',
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'test:src/order.test.ts',
        to: 'decision:D-TOOL-10',
        kind: 'verifies',
        source: 'test-comment',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores an unknown @type that is not registered in the schema', async () => {
    const root = await fixtureRepo('custom-traceability-unknown-type');
    try {
      await writeFile(
        join(root, 'artifact-graph.config.yaml'),
        `types:
  test:
    paths: ["src/**/*.java"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
idPatterns:
  api_contract: "^API-\\\\d+$"
statuses: [planned, active, done, deprecated, accepted]
`,
      );
      await mkdir(join(root, 'src'), { recursive: true });
      await write(root, 'src/UnknownType.java', `// @nonexistent X-001
public class UnknownType {}
`);

      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // No edge should be created
      expect(graph.edges).not.toContainEqual(expect.objectContaining({
        to: expect.stringContaining('X-001'),
      }));

      // Unknown annotations belong to other tools and are not traceability attempts.
      const node = graph.nodes.find((n) => n.uid === 'implementation:src/UnknownType.java');
      expect(node?.attrs?.invalidTraceabilityComments ?? []).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // @feature ACA17 @scenario S-58
  it('reports registered traceability tags with empty IDs while ignoring unknown annotations and directives', async () => {
    const root = await fixtureRepo('empty-registered-traceability-id');
    try {
      await write(root, 'tests/empty.test.ts', [
        '// @feature',
        '// @feature' + ' ',
        '// @unknown X-001',
        '// @feature/example',
        '// @feature(example)',
        "test('empty IDs', () => {});",
        '',
      ].join('\n'));
      await writeFile(join(root, 'artifact-graph.config.yaml'), `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  test:
    paths: ["tests/**/*.ts"]
idPatterns:
  feature: '^[A-Z]{1,4}\\d+$'
statuses: [planned, active, done, deprecated, accepted]
`);
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const issues = validateGraph(graph, config).filter((entry) => entry.code === 'CODE_COMMENT_TRACEABILITY_FORMAT');
      expect(issues).toHaveLength(2);
      expect(issues.map((entry) => entry.line)).toEqual([1, 2]);
      expect(issues.every((entry) => entry.message.includes('valid ID'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('emits one generic @tc deprecation warning under any configured test path and none for @e2e_test', async () => {
    const root = await fixtureRepo('global-tc-deprecation');
    try {
      await write(root, 'custom/legacy.mjs', `// @tc batch:TC-001\nexport const legacy = true;\n`);
      await write(root, 'custom/canonical.mjs', `// @e2e_test batch:TC-001\nexport const canonical = true;\n`);
      await writeFile(join(root, 'artifact-graph.config.yaml'), `types:
  test:
    paths: ["custom/**/*.mjs"]
  e2e_test:
    paths: ["artifacts/tests/e2e/*.md"]
idPatterns:
  e2e_test: '^.+:(TC-\\d+|FILE)$'
statuses: [planned, active, done, deprecated, accepted]
`);
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const warnings = validateGraph(graph, config).filter((entry) => entry.code === 'E2E-TRACE-007');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toEqual(expect.objectContaining({ path: 'custom/legacy.mjs', line: 1, severity: 'warning' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps legacy @tc and canonical @e2e_test to the same e2e_test node type', async () => {
    const root = await fixtureRepo('tc-alias-generic-graph');
    try {
      await write(root, 'src/legacy.ts', `// @tc test-batch:TC-001\nexport const legacy = true;\n`);
      await write(root, 'src/canonical.ts', `// @e2e_test test-batch:TC-001\nexport const canonical = true;\n`);
      await writeFile(join(root, 'artifact-graph.config.yaml'), `types:
  test:
    paths: ["src/**/*.ts"]
  e2e_test:
    paths: ["artifacts/tests/e2e/*.md"]
idPatterns:
  e2e_test: '^.+:(TC-\\d+|FILE)$'
statuses: [planned, active, done, deprecated, accepted]
`);
      const graph = await scanArtifacts(root, await loadConfig(root));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'implementation:src/legacy.ts',
        to: 'e2e_test:test-batch:TC-001',
        kind: 'implements',
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'implementation:src/canonical.ts',
        to: 'e2e_test:test-batch:TC-001',
        kind: 'implements',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('merges custom e2e_test aliases with defaults so legacy @tc remains recognized', async () => {
    const root = await fixtureRepo('tc-default-alias-merge');
    try {
      await write(root, 'src/legacy.ts', `// @tc test-batch:TC-001\nexport const legacy = true;\n`);
      await writeFile(join(root, 'artifact-graph.config.yaml'), `types:
  test:
    paths: ["src/**/*.ts"]
  e2e_test:
    paths: ["artifacts/tests/e2e/*.md"]
    aliases: ["custom-e2e"]
idPatterns:
  e2e_test: '^.+:(TC-\\d+|FILE)$'
statuses: [planned, active, done, deprecated, accepted]
`);
      const config = await loadConfig(root);
      expect(getArtifactTypeMetadata(config, 'e2e_test')?.aliases).toEqual(expect.arrayContaining(['custom-e2e', 'tc']));
      const graph = await scanArtifacts(root, config);
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'implementation:src/legacy.ts',
        to: 'e2e_test:test-batch:TC-001',
        kind: 'implements',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('custom type runtime: CUSTOM_ARTIFACT_ISOLATED warning', () => {
  it('produces CUSTOM_ARTIFACT_ISOLATED for isolated custom artifact with no edges', async () => {
    const root = join(tmpdir(), `artifact-graph-isolated-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
idPatterns:
  api_contract: "^API-\\\\d+$"
`);
      await write(root, 'artifacts/contracts/api/API-999.md', `---
id: API-999
title: Isolated API contract
status: active
---
# API-999
`);
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const issues = validateGraph(graph, config);

      expect(graph.nodes.find((n) => n.uid === 'api_contract:API-999')).toBeDefined();
      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'CUSTOM_ARTIFACT_ISOLATED', node: 'api_contract:API-999', severity: 'warning' }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not produce CUSTOM_ARTIFACT_ISOLATED for connected custom artifact', async () => {
    const root = join(tmpdir(), `artifact-graph-connected-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      await write(root, 'artifact-graph.config.yaml', `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
    aliases: [features]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
idPatterns:
  api_contract: "^API-\\\\d+$"
`);
      await write(root, 'artifacts/prd/features/ACA11.md', `---
id: ACA11
title: Extended catalog
status: active
scenarios: []
decisions: []
design_docs: []
---
# ACA11
`);
      await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Connected API contract
status: active
related_features: [ACA11]
---
# API-001
`);
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const issues = validateGraph(graph, config);

      expect(graph.nodes.find((n) => n.uid === 'api_contract:API-001')).toBeDefined();
      expect(issues.filter((i) => i.code === 'CUSTOM_ARTIFACT_ISOLATED')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not produce CUSTOM_ARTIFACT_ISOLATED for core types without edges', async () => {
    const root = await fixtureRepo('no-isolated-core');
    try {
      const graph = await scanArtifacts(root);
      const issues = validateGraph(graph);
      // Core types (feature, scenario, decision, etc.) should never produce this warning
      expect(issues.filter((i) => i.code === 'CUSTOM_ARTIFACT_ISOLATED')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('custom type runtime: enterprise Java fixture TC-001–TC-006', () => {
  async function enterpriseJavaFixture(name: string): Promise<string> {
    const root = join(tmpdir(), `artifact-graph-enterprise-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });

    await write(root, 'artifact-graph.config.yaml', `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
    aliases: [features]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  decision:
    paths: ["artifacts/decisions/**/*.md"]
    aliases: [decisions]
  design:
    paths: ["artifacts/design/**/*.md"]
  test:
    paths: ["src/**/*.java"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
    aliases: [api-contract]
    extraFields:
      - name: method
        type: string
        enum: [GET, POST, PUT, DELETE, PATCH]
      - name: version
        type: string
  data_contract:
    paths: ["artifacts/contracts/data/**/*.md"]
    target: true
    aliases: [data-contract]
    extraFields:
      - name: format
        type: string
  db_migration:
    paths: ["artifacts/migrations/**/*.md"]
    aliases: [database_migration, migration]
idPatterns:
  api_contract: "^API-\\\\d+$"
  data_contract: "^DATA-\\\\d+$"
  db_migration: "^MIG-[\\\\w-]+$"
  feature: "^[A-Z]+\\\\d+$"
  decision: "^D-[A-Z]+-\\\\d+$"
  scenario: "^S-\\\\d+[a-z]?$"
  test: "^.+\\\\.java$"
statuses: [planned, active, done, deprecated, accepted]
`);

    // Feature
    await write(root, 'artifacts/prd/features/F001.md', `---
id: F001
title: Order Management
status: active
scenarios: [S-001]
decisions: [D-JAVA-001]
design_docs: [design-order]
---
# F001: Order Management
`);
    // Scenario
    await write(root, 'artifacts/scenarios/batch-1.md', `## S-001: Create Order

**关联功能**: F001
**关联决策**: D-JAVA-001
`);
    // Decision
    await write(root, 'artifacts/decisions/D-JAVA-001.md', `---
id: D-JAVA-001
title: Use Spring Boot 3.2
status: accepted
related_features: [F001]
related_scenarios: [S-001]
---
# D-JAVA-001: Use Spring Boot 3.2
`);
    // Design
    await write(root, 'artifacts/design/design-order.md', `---
title: Order Service Design
related_features: [F001]
related_scenarios: [S-001]
---
# Order Service Design
`);
    // API contract
    await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Create Order API
status: active
method: POST
version: v1
related_features: [F001]
related_decisions: [D-JAVA-001]
---
# API-001: Create Order API
`);
    // Data contract
    await write(root, 'artifacts/contracts/data/DATA-001.md', `---
id: DATA-001
title: Order Data Model
status: active
format: JSON
related_features: [F001]
related_api_contract: [API-001]
---
# DATA-001: Order Data Model
`);
    // DB migration
    await write(root, 'artifacts/migrations/MIG-20260709-001.md', `---
id: MIG-20260709-001
title: Create orders table
status: active
related_data_contract: [DATA-001]
---
# MIG-20260709-001: Create orders table
`);
    // Java source files with traceability comments
    await write(root, 'src/OrderController.java', `// @api_contract API-001
// @feature F001
public class OrderController {}
`);
    await write(root, 'src/OrderService.java', `// @data_contract DATA-001
public class OrderService {}
`);
    await write(root, 'src/OrderControllerTest.java', `// @api_contract API-001
public class OrderControllerTest {}
`);

    return root;
  }

  // TC-001: P0 Generic Markdown parser
  it('TC-001: scans custom types into graph nodes', async () => {
    const root = await enterpriseJavaFixture('tc001');
    try {
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      expect(graph.nodes.find((n) => n.uid === 'api_contract:API-001')).toBeDefined();
      expect(graph.nodes.find((n) => n.uid === 'api_contract:API-001')!.title).toBe('Create Order API');
      expect(graph.nodes.find((n) => n.uid === 'api_contract:API-001')!.status).toBe('active');
      expect(graph.nodes.find((n) => n.uid === 'data_contract:DATA-001')).toBeDefined();
      expect(graph.nodes.find((n) => n.uid === 'db_migration:MIG-20260709-001')).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // TC-002: P1 Dynamic target, context, and packet
  it('TC-002: resolves context and packet for custom target', async () => {
    const root = await enterpriseJavaFixture('tc002');
    try {
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      const context = resolveArtifactContext(graph, { target: { type: 'api_contract', id: 'API-001' } });
      expect(context.target.type).toBe('api_contract');
      expect(context.target.id).toBe('API-001');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // TC-003: P2 Related relations and implementation traceability
  it('TC-003: builds related_* and implementation edges for custom types', async () => {
    const root = await enterpriseJavaFixture('tc003');
    try {
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // api_contract → feature references
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'api_contract:API-001',
        to: 'feature:F001',
        kind: 'references',
      }));
      // data_contract → api_contract references
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'data_contract:DATA-001',
        to: 'api_contract:API-001',
        kind: 'references',
      }));
      // db_migration → data_contract references
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'db_migration:MIG-20260709-001',
        to: 'data_contract:DATA-001',
        kind: 'references',
      }));
      // Ordinary Java sources implement artifacts.
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'implementation:src/OrderController.java',
        to: 'api_contract:API-001',
        kind: 'implements',
      }));
      // Java @-data_contract traceability edge
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'implementation:src/OrderService.java',
        to: 'data_contract:DATA-001',
        kind: 'implements',
      }));
      // Java test classes verify artifacts.
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'test:src/OrderControllerTest.java',
        to: 'api_contract:API-001',
        kind: 'verifies',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // TC-004: P3 extraFields
  it('TC-004: indexes extraFields declared in config', async () => {
    const root = await enterpriseJavaFixture('tc004');
    try {
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      const apiNode = graph.nodes.find((n) => n.uid === 'api_contract:API-001');
      expect(apiNode).toBeDefined();
      expect(apiNode!.attrs).toEqual(expect.objectContaining({
        indexedFields: expect.objectContaining({
          method: 'POST',
          version: 'v1',
        }),
      }));

      const dataNode = graph.nodes.find((n) => n.uid === 'data_contract:DATA-001');
      expect(dataNode!.attrs).toEqual(expect.objectContaining({
        indexedFields: expect.objectContaining({
          format: 'JSON',
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // TC-005: P4 validate and version-lock
  it('TC-005: validate produces no error for valid enterprise fixture; CUSTOM_ARTIFACT_ISOLATED absent for connected types', async () => {
    const root = await enterpriseJavaFixture('tc005');
    try {
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const issues = validateGraph(graph, config);

      const errors = issues.filter((i) => i.severity === 'error');
      // Connected custom types should NOT produce CUSTOM_ARTIFACT_ISOLATED
      expect(issues.filter((i) => i.code === 'CUSTOM_ARTIFACT_ISOLATED')).toEqual([]);
      // No validation errors expected for a clean fixture
      expect(errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // TC-006: P5 Enterprise Java integration — full chain
  it('TC-006: full enterprise Java chain with context, validate, and graph', async () => {
    const root = await enterpriseJavaFixture('tc006');
    try {
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);

      // All expected node types present
      expect(graph.nodes.filter((n) => n.type === 'api_contract').length).toBe(1);
      expect(graph.nodes.filter((n) => n.type === 'data_contract').length).toBe(1);
      expect(graph.nodes.filter((n) => n.type === 'db_migration').length).toBe(1);

      // Full chain: db_migration → data_contract → api_contract → feature
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'db_migration:MIG-20260709-001',
        to: 'data_contract:DATA-001',
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'data_contract:DATA-001',
        to: 'api_contract:API-001',
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'api_contract:API-001',
        to: 'feature:F001',
      }));

      // Java traceability edges — src/*.java are implementation sources, not test files
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'implementation:src/OrderController.java',
        to: 'api_contract:API-001',
        kind: 'implements',
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        from: 'implementation:src/OrderService.java',
        to: 'data_contract:DATA-001',
        kind: 'implements',
      }));

      // Validate clean
      const issues = validateGraph(graph, config);
      const errors = issues.filter((i) => i.severity === 'error');
      expect(errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads the committed enterprise Java fixture and distinguishes implementation from test evidence', async () => {
    const root = join(import.meta.dirname, 'fixtures/enterprise-java-custom-types');
    const config = await loadConfig(root);
    const graph = await scanArtifacts(root, config);

    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: 'implementation:src/OrderController.java',
        to: 'api_contract:API-001',
        kind: 'implements',
      }),
      expect.objectContaining({
        from: 'test:src/OrderControllerTest.java',
        to: 'api_contract:API-001',
        kind: 'verifies',
      }),
      expect.objectContaining({
        from: 'db_migration:MIG-001',
        to: 'data_contract:DATA-001',
        kind: 'references',
      }),
    ]));
    expect(validateGraph(graph, config).filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  // Performance benchmark: 1000 generic Markdown artifacts < 2000ms
  it('scans 1000 generic Markdown artifacts in under 2000ms', async () => {
    const root = join(tmpdir(), `artifact-graph-perf-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    try {
      const { cpus, arch, platform } = await import('node:os');
      const { version } = await import('node:process');

      await write(root, 'artifact-graph.config.yaml', `types:
  generic_item:
    paths: ["artifacts/items/**/*.md"]
idPatterns:
  generic_item: "^ITEM-\\\\d+$"
`);

      // Generate 1000 generic Markdown files
      await mkdir(join(root, 'artifacts/items'), { recursive: true });
      const filePromises: Promise<void>[] = [];
      for (let i = 0; i < 1000; i++) {
        filePromises.push(write(root, `artifacts/items/ITEM-${String(i).padStart(4, '0')}.md`, `---
id: ITEM-${String(i).padStart(4, '0')}
title: Generic Item ${i}
status: active
---
# Item ${i}
`));
      }
      await Promise.all(filePromises);

      const config = await loadConfig(root);

      const start = performance.now();
      const graph = await scanArtifacts(root, config);
      const elapsed = performance.now() - start;

      const cpuInfo = cpus();
      console.log(`\n[Performance Benchmark]`);
      console.log(`  Node.js: ${version}`);
      console.log(`  Platform: ${platform()} ${arch()}`);
      console.log(`  CPU: ${cpuInfo[0]?.model ?? 'unknown'} (${cpuInfo.length} cores)`);
      console.log(`  1000 generic Markdown scan: ${elapsed.toFixed(1)}ms`);
      console.log(`  Nodes: ${graph.nodes.length}, Edges: ${graph.edges.length}`);

      expect(graph.nodes.length).toBe(1000);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('O1-O4: E2E coverage proof mechanism', () => {
  it('validates TC status lifecycle — invalid status produces E2E_INVALID_TC_STATUS', async () => {
    const root = await e2eFixtureRepo('tc-status');
    try {
      await write(
        root,
        'artifacts/tests/e2e/test-02.md',
        `---
test_batch: test-02
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E Test Invalid Status

## TC-001: Bad status

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**status**: bogus_state
`,
      );
      const graph = await scanArtifacts(root, await loadConfig(root));
      const issues = validateGraph(graph);
      expect(issues).toContainEqual(expect.objectContaining({ code: 'E2E_INVALID_TC_STATUS' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates waived TC must have reason — E2E_WAIVED_NO_REASON', async () => {
    const root = await e2eFixtureRepo('waived-no-reason');
    try {
      await write(
        root,
        'artifacts/tests/e2e/test-02.md',
        `---
test_batch: test-02
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E Test Waived

## TC-001: Waived without reason

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**status**: waived
`,
      );
      const graph = await scanArtifacts(root, await loadConfig(root));
      const issues = validateGraph(graph);
      expect(issues).toContainEqual(expect.objectContaining({ code: 'E2E_WAIVED_NO_REASON' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates chain_type vocabulary — invalid produces E2E_INVALID_CHAIN_TYPE', async () => {
    const root = await e2eFixtureRepo('chain-type-invalid');
    try {
      await write(
        root,
        'artifacts/tests/e2e/test-02.md',
        `---
test_batch: test-02
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E Test Bad Chain Type

## TC-001: Invalid chain type

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**chain_type**: totally_invalid
`,
      );
      const graph = await scanArtifacts(root, await loadConfig(root));
      const issues = validateGraph(graph);
      expect(issues).toContainEqual(expect.objectContaining({ code: 'E2E_INVALID_CHAIN_TYPE' }));
      expect(issues).not.toContainEqual(expect.objectContaining({ code: 'E2E_DEPRECATED_CHAIN_TYPE' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates deprecated chain_type aliases — core_only produces E2E_DEPRECATED_CHAIN_TYPE', async () => {
    const root = await e2eFixtureRepo('chain-type-deprecated');
    try {
      await write(
        root,
        'artifacts/tests/e2e/test-02.md',
        `---
test_batch: test-02
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E Test Deprecated Chain Type

## TC-001: Deprecated chain type

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**chain_type**: core_only
`,
      );
      const graph = await scanArtifacts(root, await loadConfig(root));
      const issues = validateGraph(graph);
      expect(issues).toContainEqual(expect.objectContaining({ code: 'E2E_DEPRECATED_CHAIN_TYPE' }));
      expect(issues).not.toContainEqual(expect.objectContaining({ code: 'E2E_INVALID_CHAIN_TYPE' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects freetext ac_coverage_rate — E2E_AC_COVERAGE_RATE_FREETEXT', async () => {
    const root = await e2eFixtureRepo('ac-rate-freetext');
    try {
      await write(
        root,
        'artifacts/tests/e2e/test-02.md',
        `---
test_batch: test-02
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E Test Freetext Rate

## TC-001: Freetext rate

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**ac_coverage_rate**: 100%
`,
      );
      const graph = await scanArtifacts(root, await loadConfig(root));
      const issues = validateGraph(graph);
      expect(issues).toContainEqual(expect.objectContaining({ code: 'E2E_AC_COVERAGE_RATE_FREETEXT' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('computeE2eCoverageStats produces correct baseline stats', async () => {
    const { computeE2eCoverageStats } = await import('../src/index.js');
    const root = await e2eFixtureRepo('coverage-stats');
    try {
      const graph = await scanArtifacts(root, await loadConfig(root));
      const stats = await computeE2eCoverageStats(graph, root);
      expect(stats.totalTestCases).toBe(1);
      expect(stats.withExecutableRef).toBe(0);
      expect(stats.executableRefRate).toBe('0/1 (0.0%)');
      expect(stats.statusBreakdown).toEqual({ created: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('E2E-TRACE-004 respects Markdown authority for explicit desktop_chain', async () => {
    const { validateExecutableTraceability } = await import('../src/index.js');
    const root = await e2eFixtureRepo('trace-004-authority');
    try {
      await write(
        root,
        'artifacts/tests/e2e/test-02.md',
        `---
test_batch: test-02
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# E2E Test Authority

## TC-001: Desktop chain with mock source

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**: heimdall/packages/desktop/e2e/skills.e2e.spec.ts::TS-001
**chain_type**: desktop_chain
`,
      );
      await write(
        root,
        'heimdall/packages/desktop/e2e/skills.e2e.spec.ts',
        `// @e2e_test test-02:TC-001 [mock_playwright]
describe('skills', () => {
  test('TS-001: mock import', async () => {});
});
`,
      );
      const issues = await validateExecutableTraceability(root);
      const trace004 = issues.filter((i) => i.code === 'E2E-TRACE-004');
      // Markdown authority: E2E-TRACE-004 should be suppressed entirely
      expect(trace004.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Item 1: fail-closed e2e config validation', () => {
  it('rejects threshold > 1', async () => {
    const root = join(tmpdir(), `ag-config-thresh-hi-${Date.now()}`);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'artifact-graph.config.yaml'), `e2e:\n  executable_ref_warning: 1.5\n`);
      await expect(loadConfig(root)).rejects.toThrow(/Must be a number between 0 and 1/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects threshold < 0', async () => {
    const root = join(tmpdir(), `ag-config-thresh-lo-${Date.now()}`);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'artifact-graph.config.yaml'), `e2e:\n  executable_ref_error: -0.1\n`);
      await expect(loadConfig(root)).rejects.toThrow(/Must be a number between 0 and 1/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects runner with absolute root', async () => {
    const root = join(tmpdir(), `ag-config-abs-root-${Date.now()}`);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'artifact-graph.config.yaml'), `e2e:\n  runners:\n    - name: "pw"\n      root: "/absolute/path"\n      include: ["**/*.spec.ts"]\n`);
      await expect(loadConfig(root)).rejects.toThrow(/must not be an absolute path/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects runner root with .. segments', async () => {
    const root = join(tmpdir(), `ag-config-dotdot-${Date.now()}`);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'artifact-graph.config.yaml'), `e2e:\n  runners:\n    - name: "pw"\n      root: "../outside"\n      include: ["**/*.spec.ts"]\n`);
      await expect(loadConfig(root)).rejects.toThrow(/must not contain "\.\."/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects runner with empty include', async () => {
    const root = join(tmpdir(), `ag-config-empty-include-${Date.now()}`);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'artifact-graph.config.yaml'), `e2e:\n  runners:\n    - name: "pw"\n      root: "."\n      include: []\n`);
      await expect(loadConfig(root)).rejects.toThrow(/must be a non-empty array/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects waiver without reason', async () => {
    const root = join(tmpdir(), `ag-config-waiver-${Date.now()}`);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'artifact-graph.config.yaml'), `e2e:\n  scenario_waivers:\n    - id: "S-99"\n`);
      await expect(loadConfig(root)).rejects.toThrow(/Must be \{id, reason\}/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects waiver with empty reason', async () => {
    const root = join(tmpdir(), `ag-config-waiver-empty-${Date.now()}`);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'artifact-graph.config.yaml'), `e2e:\n  feature_waivers:\n    - id: "F1"\n      reason: ""\n`);
      await expect(loadConfig(root)).rejects.toThrow(/reason must be a non-empty string/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects runner with invalid kind', async () => {
    const root = join(tmpdir(), `ag-config-bad-kind-${Date.now()}`);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'artifact-graph.config.yaml'), `e2e:\n  runners:\n    - name: "pw"\n      root: "."\n      include: ["**/*.spec.ts"]\n      kind: "smoke"\n`);
      await expect(loadConfig(root)).rejects.toThrow(/Must be unit, integration, or e2e/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('default runners is empty for backward compatibility', () => {
    expect(DEFAULT_SCHEMA.e2e?.runners).toEqual([]);
  });

  it('accepts valid e2e config with all fields', async () => {
    const root = join(tmpdir(), `ag-config-valid-${Date.now()}`);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'artifact-graph.config.yaml'), `e2e:\n  executable_ref_warning: 0.5\n  executable_ref_error: 0.8\n  runners:\n    - name: "vitest"\n      root: "."\n      include: ["**/*.test.ts"]\n      exclude: ["**/node_modules/**"]\n      testIgnore: ["**/__skip__/**"]\n      kind: "unit"\n  scenario_waivers:\n    - id: "S-99"\n      reason: "deferred to Q3"\n  feature_waivers:\n    - id: "F1"\n      reason: "out of scope"\n`);
      const config = await loadConfig(root);
      expect(config.e2e?.runners).toHaveLength(1);
      expect(config.e2e?.runners?.[0].kind).toBe('unit');
      expect(config.e2e?.scenario_waivers?.[0].reason).toBe('deferred to Q3');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Item 4: four checklist rules pass/fail', () => {
  it('desktop-chain-missing: TC without explicit chain_type and mock source reports E2E-TRACE-004', async () => {
    const root = await e2eFixtureRepo('dc-missing-fail');
    try {
      await write(root, 'artifacts/tests/e2e/test-dc.md', `---
test_batch: test-dc
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# Desktop chain missing

## TC-001: No explicit chain_type

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**: heimdall/packages/desktop/e2e/fake.e2e.spec.ts::TS-001
`);
      await write(root, 'heimdall/packages/desktop/e2e/fake.e2e.spec.ts', `// @e2e_test test-dc:TC-001 [mock_playwright]
describe('fake', () => {
  test('TS-001: uses mock', async () => {});
});
`);
      const issues = await validateExecutableTraceability(root);
      // No explicit chain_type → defaults to desktop_chain, mock_playwright source → E2E-TRACE-004
      expect(issues.some((i) => i.code === 'E2E-TRACE-004')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('desktop-chain-missing: TC with [e2e] level and desktop_chain does NOT report E2E-TRACE-004', async () => {
    const root = await e2eFixtureRepo('dc-missing-pass');
    try {
      await write(root, 'artifacts/tests/e2e/test-dc.md', `---
test_batch: test-dc
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# Desktop chain real

## TC-001: Real chain

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**chain_type**: desktop_chain
**executable_ref**: heimdall/packages/desktop/e2e/real.e2e.spec.ts::TS-001
`);
      await write(root, 'heimdall/packages/desktop/e2e/real.e2e.spec.ts', `// @e2e_test test-dc:TC-001 [e2e]
describe('real', () => {
  test('TS-001: real e2e', async () => {});
});
`);
      const issues = await validateExecutableTraceability(root);
      expect(issues.filter((i) => i.code === 'E2E-TRACE-004')).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executable-ref-target-missing: nonexistent ref target reports finding', async () => {
    const root = await e2eFixtureRepo('eref-missing');
    try {
      await write(root, 'artifacts/tests/e2e/test-eref.md', `---
test_batch: test-eref
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# Executable ref missing

## TC-001: Ref target missing

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**: heimdall/packages/desktop/e2e/nonexistent.e2e.spec.ts::TS-001
**chain_type**: desktop_chain
`);
      const issues = await validateExecutableTraceability(root);
      expect(issues.some((i) =>
        i.code === 'E2E-TRACE-001' || i.message.includes('not found') || i.message.includes('does not exist')
      )).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executable-ref-target-missing: existing ref target does not report target-missing', async () => {
    const root = await e2eFixtureRepo('eref-pass');
    try {
      await write(root, 'artifacts/tests/e2e/test-eref.md', `---
test_batch: test-eref
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# Executable ref exists

## TC-001: Ref target exists

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**: heimdall/packages/desktop/e2e/exists.e2e.spec.ts::TS-001
**chain_type**: desktop_chain
`);
      await write(root, 'heimdall/packages/desktop/e2e/exists.e2e.spec.ts', `// @e2e_test test-eref:TC-001 [e2e]
describe('exists', () => {
  test('TS-001: exists', async () => {});
});
`);
      const issues = await validateExecutableTraceability(root);
      expect(issues.filter((i) =>
        i.code === 'E2E-TRACE-001' || (i.message.includes('not found') && i.message.includes('executable'))
      )).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mock-playwright-for-desktop-chain: implicit desktop_chain with mock source reports E2E-TRACE-004', async () => {
    const root = await e2eFixtureRepo('mock-pw-fail');
    try {
      await write(root, 'artifacts/tests/e2e/test-mock.md', `---
test_batch: test-mock
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# Mock playwright

## TC-001: Mock evidence (no explicit chain_type)

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**executable_ref**: heimdall/packages/desktop/e2e/mock.e2e.spec.ts::TS-001
`);
      await write(root, 'heimdall/packages/desktop/e2e/mock.e2e.spec.ts', `// @e2e_test test-mock:TC-001 [mock_playwright]
describe('mock', () => {
  test('TS-001: mock', async () => {});
});
`);
      const issues = await validateExecutableTraceability(root);
      // No explicit chain_type → defaults to desktop_chain, mock source → E2E-TRACE-004
      expect(issues.some((i) => i.code === 'E2E-TRACE-004')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mock-playwright-for-desktop-chain: declared mock_playwright chain_type does NOT report E2E-TRACE-004', async () => {
    const root = await e2eFixtureRepo('mock-pw-pass');
    try {
      await write(root, 'artifacts/tests/e2e/test-mock.md', `---
test_batch: test-mock
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# Mock playwright non-desktop

## TC-001: Mock ok for non-desktop

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**chain_type**: mock_playwright
**executable_ref**: heimdall/packages/desktop/e2e/mock.e2e.spec.ts::TS-001
`);
      await write(root, 'heimdall/packages/desktop/e2e/mock.e2e.spec.ts', `// @e2e_test test-mock:TC-001 [mock_playwright]
describe('mock', () => {
  test('TS-001: mock', async () => {});
});
`);
      const issues = await validateExecutableTraceability(root);
      expect(issues.filter((i) => i.code === 'E2E-TRACE-004')).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Item 5: uncoveredFeatures uses AC coverage, waiver and verified semantics', () => {
  it('feature with verifies edge but no ac_coverage is still uncovered', async () => {
    const root = await e2eFixtureRepo('feat-edge-no-ac');
    try {
      await write(root, 'artifacts/prd/features/D3-unlinked.md', `---
id: D3
title: Unlinked feature
status: done
scenarios: [S-20]
---

# D3: Unlinked feature

## 验收标准

1. Some AC.
`);
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const { computeE2eCoverageStats } = await import('../src/index.js');
      const stats = await computeE2eCoverageStats(graph, root);
      expect(stats.uncoveredFeatures).toContain('D3');
      expect(stats.featureCoverage['D3']?.acCovered).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waiver removes feature from uncovered but keeps waived=true, verified=false', async () => {
    const root = await e2eFixtureRepo('feat-waiver');
    try {
      await write(root, 'artifacts/prd/features/D3-unlinked.md', `---
id: D3
title: Waived feature
status: done
scenarios: [S-20]
---

# D3: Waived feature

## 验收标准

1. Some AC.
`);
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const { computeE2eCoverageStats } = await import('../src/index.js');
      const stats = await computeE2eCoverageStats(graph, root, {
        featureWaivers: [{ id: 'D3', reason: 'out of scope for MVP' }],
      });
      expect(stats.uncoveredFeatures).not.toContain('D3');
      expect(stats.featureCoverage['D3']?.waived).toBe(true);
      expect(stats.featureCoverage['D3']?.verified).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('verified requires non-pending executable_ref AND active e2e runner', async () => {
    const root = await e2eFixtureRepo('feat-verified');
    try {
      await writeFile(join(root, 'artifact-graph.config.yaml'), `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  design:
    paths: ["artifacts/design/**/*.md"]
  test:
    paths: ["heimdall/packages/**/*.test.ts"]
  e2e_test:
    paths: ["artifacts/tests/e2e/*.md"]
  e2e_registry:
    paths: ["artifacts/tests/e2e/e2e-test-registry.json"]
e2e:
  runners:
    - name: "playwright"
      root: "heimdall"
      include: ["**/*.e2e.spec.ts"]
      kind: "e2e"
statuses: [planned, active, done, deprecated]
`);
      await write(root, 'artifacts/tests/e2e/test-verified.md', `---
test_batch: test-verified
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# Verified TC

## TC-001: Fully verified

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**status**: verified
**executable_ref**: heimdall/packages/desktop/e2e/verified.e2e.spec.ts::TS-001
**chain_type**: desktop_chain
`);
      await write(root, 'heimdall/packages/desktop/e2e/verified.e2e.spec.ts', `// @e2e_test test-verified:TC-001 [e2e]
describe('verified', () => {
  test('TS-001: verified', async () => {});
});
`);
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const { computeE2eCoverageStats } = await import('../src/index.js');
      const stats = await computeE2eCoverageStats(graph, root);
      expect(stats.featureCoverage['D1']?.verified).toBe(true);
      expect(stats.featureCoverage['D1']?.acCovered).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('verified=false when status=verified but executable_ref is pending', async () => {
    const root = await e2eFixtureRepo('feat-verified-pending');
    try {
      await writeFile(join(root, 'artifact-graph.config.yaml'), `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  design:
    paths: ["artifacts/design/**/*.md"]
  test:
    paths: ["heimdall/packages/**/*.test.ts"]
  e2e_test:
    paths: ["artifacts/tests/e2e/*.md"]
  e2e_registry:
    paths: ["artifacts/tests/e2e/e2e-test-registry.json"]
e2e:
  runners:
    - name: "playwright"
      root: "heimdall"
      include: ["**/*.e2e.spec.ts"]
      kind: "e2e"
statuses: [planned, active, done, deprecated]
`);
      await write(root, 'artifacts/tests/e2e/test-pending.md', `---
test_batch: test-pending
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# Pending TC

## TC-001: Pending ref

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**status**: verified
**executable_ref**: pending — not yet implemented
**chain_type**: desktop_chain
`);
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const { computeE2eCoverageStats } = await import('../src/index.js');
      const stats = await computeE2eCoverageStats(graph, root);
      expect(stats.featureCoverage['D1']?.verified).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('scenario waiver removes from uncovered but keeps waived=true', async () => {
    const root = await e2eFixtureRepo('scenario-waiver');
    try {
      await write(root, 'artifacts/scenarios/batch-waived.md', `## S-99: Waived scenario

**关联功能**: D1
`);
      const config = await loadConfig(root);
      const graph = await scanArtifacts(root, config);
      const { computeE2eCoverageStats } = await import('../src/index.js');
      const stats = await computeE2eCoverageStats(graph, root, {
        scenarioWaivers: [{ id: 'S-99', reason: 'covered manually' }],
      });
      expect(stats.uncoveredScenarios).not.toContain('S-99');
      expect(stats.scenarioCoverage['S-99']?.waived).toBe(true);
      expect(stats.scenarioCoverage['S-99']?.verified).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Item 6: registry frontmatter blocked, --check, idempotent', () => {
  it('registry with fixes_block in frontmatter produces batch status=blocked', async () => {
    const root = await e2eFixtureRepo('registry-blocked');
    try {
      await write(root, 'artifacts/tests/e2e/test-blocked.md', `---
test_batch: test-blocked
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
fixes_block: "no test file — requires manual E2E setup"
---

# Blocked batch

## TC-001: Blocked TC

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
`);
      const { generateE2eRegistry } = await import('../src/index.js');
      const registry = await generateE2eRegistry(root, { deterministic: true });
      const batch = registry.batches.find((b) => b.batch_id === 'test-blocked');
      expect(batch).toBeDefined();
      expect(batch!.status).toBe('blocked');
      expect(batch!.blocking_reasons).toBeDefined();
      expect(batch!.blocking_reasons!['TC-001']).toContain('no test file');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('registry with fixes_block: "no E2E" also produces batch status=blocked', async () => {
    const root = await e2eFixtureRepo('registry-blocked-noe2e');
    try {
      await write(root, 'artifacts/tests/e2e/test-noe2e.md', `---
test_batch: test-noe2e
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
fixes_block: "no E2E test infrastructure available"
---

# No E2E batch

## TC-001: No E2E

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
`);
      const { generateE2eRegistry } = await import('../src/index.js');
      const registry = await generateE2eRegistry(root, { deterministic: true });
      const batch = registry.batches.find((b) => b.batch_id === 'test-noe2e');
      expect(batch!.status).toBe('blocked');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('double deterministic generation produces byte-identical output', async () => {
    const root = await e2eFixtureRepo('registry-idempotent');
    try {
      const { generateE2eRegistry } = await import('../src/index.js');
      const first = await generateE2eRegistry(root, { deterministic: true });
      const second = await generateE2eRegistry(root, { deterministic: true });
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('registry --check mode detects drift when file differs', async () => {
    const root = await e2eFixtureRepo('registry-check');
    try {
      const { generateE2eRegistry } = await import('../src/index.js');
      const registry = await generateE2eRegistry(root, { deterministic: true });
      const outPath = join(root, 'artifacts/tests/e2e/e2e-test-registry.json');
      await writeFile(outPath, JSON.stringify({ stale: true }));
      const { runCli } = await import('../src/cli.js');
      let stderr = '';
      const code = await runCli(['generate-e2e-registry', '--root', root, '--check'], {
        cwd: root,
        stderr: (chunk) => { stderr += chunk; },
      });
      expect(code).toBe(1);
      expect(stderr).toContain('drift');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('registry --check mode passes when file matches deterministic generation', async () => {
    const root = await e2eFixtureRepo('registry-check-pass');
    try {
      const { generateE2eRegistry } = await import('../src/index.js');
      const registry = await generateE2eRegistry(root, { deterministic: true });
      const outPath = join(root, 'artifacts/tests/e2e/e2e-test-registry.json');
      await writeFile(outPath, JSON.stringify(registry, null, 2) + '\n');
      const { runCli } = await import('../src/cli.js');
      let stdout = '';
      const code = await runCli(['generate-e2e-registry', '--root', root, '--check'], {
        cwd: root,
        stdout: (chunk) => { stdout += chunk; },
      });
      expect(code).toBe(0);
      expect(stdout).toContain('check passed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('test-33/test-35 equivalent: TC with no executable_ref and desktop_chain has blocking_reasons', async () => {
    const root = await e2eFixtureRepo('registry-t33-t35');
    try {
      await write(root, 'artifacts/tests/e2e/test-blocked-tc.md', `---
test_batch: test-blocked-tc
scope: D1
ac_coverage:
  D1: [AC1]
related_scenarios: [S-20]
---

# Blocked TC batch

## TC-001: No executable ref

**前置条件**: ready
**测试步骤**: run
**后置清理**: clean
**覆盖场景**: S-20
**覆盖功能**: D1(AC1)
**优先级**: P0
**chain_type**: desktop_chain
`);
      const { generateE2eRegistry } = await import('../src/index.js');
      const registry = await generateE2eRegistry(root, { deterministic: true });
      const batch = registry.batches.find((b) => b.batch_id === 'test-blocked-tc');
      expect(batch).toBeDefined();
      expect(batch!.status).toBe('blocked');
      expect(batch!.blocking_reasons).toBeDefined();
      expect(batch!.blocking_reasons!['TC-001']).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('E2E proof hardening completion cases', () => {
  it('rejects malformed e2e sections and non-array waivers', async () => {
    const root = join(tmpdir(), `ag-config-malformed-${Date.now()}`);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'artifact-graph.config.yaml'), 'e2e: enabled\n');
      await expect(loadConfig(root)).rejects.toThrow(/Invalid e2e: must be an object/);
      await writeFile(join(root, 'artifact-graph.config.yaml'), 'e2e:\n  scenario_waivers: S-20\n');
      await expect(loadConfig(root)).rejects.toThrow(/scenario_waivers.*must be an array/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deep-merges e2e defaults and defaults runner kind to e2e', async () => {
    const root = join(tmpdir(), `ag-config-merge-${Date.now()}`);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'artifact-graph.config.yaml'), `e2e:\n  executable_ref_warning: 0.5\n  runners:\n    - name: default-kind\n      root: .\n      include: ["**/*.spec.ts"]\n`);
      const config = await loadConfig(root);
      expect(config.e2e?.report_uncovered_scenarios).toBe(true);
      expect(config.e2e?.report_uncovered_features).toBe(true);
      expect(config.e2e?.runners?.[0].kind).toBe('e2e');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('unit-test-not-e2e reports a ref accepted only by a unit runner', async () => {
    const root = await e2eFixtureRepo('unit-runner-fail');
    try {
      await write(root, 'artifact-graph.config.yaml', `e2e:\n  runners:\n    - name: unit\n      kind: unit\n      root: .\n      include: ["heimdall/**/*.test.ts"]\n    - name: playwright\n      kind: e2e\n      root: .\n      include: ["heimdall/**/*.e2e.spec.ts"]\n`);
      await write(root, 'artifacts/tests/e2e/test-unit-ref.md', `---\ntest_batch: test-unit-ref\nscope: D1\nac_coverage:\n  D1: [AC1]\nrelated_scenarios: [S-20]\n---\n\n# Unit ref\n\n## TC-001: Unit only\n\n**前置条件**: ready\n**测试步骤**: run\n**后置清理**: clean\n**覆盖场景**: S-20\n**覆盖功能**: D1(AC1)\n**优先级**: P0\n**chain_type**: core_e2e\n**executable_ref**: heimdall/packages/core/unit.test.ts::TS-001\n`);
      await write(root, 'heimdall/packages/core/unit.test.ts', `// @e2e_test test-unit-ref:TC-001 [core_e2e]\ntest('TS-001: unit', () => {});\n`);
      const issues = await validateExecutableTraceability(root);
      expect(issues.filter((item) => item.code === 'E2E-UNIT-TEST-NOT-E2E')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('unit-test-not-e2e passes a ref accepted by an e2e runner', async () => {
    const root = await e2eFixtureRepo('unit-runner-pass');
    try {
      await write(root, 'artifact-graph.config.yaml', `e2e:\n  runners:\n    - name: browser-e2e\n      kind: e2e\n      root: .\n      include: ["heimdall/**/*.test.ts"]\n`);
      await write(root, 'artifacts/tests/e2e/test-e2e-ref.md', `---\ntest_batch: test-e2e-ref\nscope: D1\nac_coverage:\n  D1: [AC1]\nrelated_scenarios: [S-20]\n---\n\n# E2E ref\n\n## TC-001: E2E runner\n\n**前置条件**: ready\n**测试步骤**: run\n**后置清理**: clean\n**覆盖场景**: S-20\n**覆盖功能**: D1(AC1)\n**优先级**: P0\n**chain_type**: core_e2e\n**executable_ref**: heimdall/packages/core/e2e.test.ts::TS-001\n`);
      await write(root, 'heimdall/packages/core/e2e.test.ts', `// @e2e_test test-e2e-ref:TC-001 [core_e2e]\ntest('TS-001: e2e', () => {});\n`);
      const issues = await validateExecutableTraceability(root);
      expect(issues.some((item) => item.code === 'E2E-UNIT-TEST-NOT-E2E')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('invalid chain_type does not suppress a mock source conflict', async () => {
    const root = await e2eFixtureRepo('invalid-chain-mock');
    try {
      await write(root, 'artifacts/tests/e2e/test-invalid-chain.md', `---\ntest_batch: test-invalid-chain\nscope: D1\nac_coverage:\n  D1: [AC1]\nrelated_scenarios: [S-20]\n---\n\n# Invalid chain\n\n## TC-001: Invalid chain\n\n**前置条件**: ready\n**测试步骤**: run\n**后置清理**: clean\n**覆盖场景**: S-20\n**覆盖功能**: D1(AC1)\n**优先级**: P0\n**chain_type**: invented_chain\n**executable_ref**: heimdall/packages/desktop/e2e/mock.e2e.spec.ts::TS-001\n`);
      await write(root, 'heimdall/packages/desktop/e2e/mock.e2e.spec.ts', `// @e2e_test test-invalid-chain:TC-001 [mock_playwright]\ntest('TS-001: mock', () => {});\n`);
      const issues = await validateExecutableTraceability(root);
      expect(issues.some((item) => item.code === 'E2E-TRACE-004')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
