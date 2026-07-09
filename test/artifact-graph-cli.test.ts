import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { MIN_PROMPT_CHARS } from '../src/packet-prompt.js';

async function write(root: string, path: string, content: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(fullPath.split('/').slice(0, -1).join('/'), { recursive: true });
  await writeFile(fullPath, content);
}

async function cliRepo(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-cli-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  await write(
    root,
    'artifact-graph.config.yaml',
    `idRanges:
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
scenarios: [S-01]
design_docs: [design-skill-import]
---
# A1: Skill import/register

## 验收标准

1. React UI import action reaches the Tauri IPC command.
2. Node sidecar emits JSON Lines results from core engine into SQLite/report data.
`,
  );
  await write(
    root,
    'artifacts/design/design-skill-import.md',
    `---
title: Skill import design
related_features: [A1]
related_scenarios: [S-01]
---
# Skill import design
`,
  );
  await write(
    root,
    'artifacts/scenarios/batch-1.md',
    `## S-01: Import local skill

**关联功能**: A1 (Skill import/register)
`,
  );
  await write(
    root,
    'artifacts/tests/e2e/test-01.md',
    `---
test_batch: test-01
scope: A1
ac_coverage:
  A1: [AC1, AC2]
related_scenarios: [S-01]
---

# E2E 测试: Import

## TC-001: Desktop import uses the full chain

**前置条件**:
- Importable skill exists.

**测试步骤**:
1. Trigger import in the React UI.
2. Verify Tauri IPC starts the Node sidecar.
3. Verify JSON Lines from core engine are persisted to SQLite/report data.

**后置清理**:
- Remove imported skill.

**覆盖场景**: S-01
**覆盖功能**: A1(AC1, AC2)
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
          scope: 'A1',
          file: 'artifacts/tests/e2e/test-01.md',
          ac_coverage: { A1: ['AC1', 'AC2'] },
          related_scenarios: ['S-01'],
          test_case_count: 1,
        },
      ],
    }, null, 2)}\n`,
  );
  return root;
}

async function capture(argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    cwd,
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
  });
  return { code, stdout, stderr };
}

describe('artifact-graph CLI', () => {
  it('scans and validates a repository while writing generated caches', async () => {
    const root = await cliRepo('scan');

    const scan = await capture(['scan', '--root', root], root);
    expect(scan.code).toBe(0);
    expect(scan.stdout).toContain('Scanned 5 artifacts');
    await expect(stat(join(root, '.artifact-graph/index.json'))).resolves.toBeTruthy();

    const validate = await capture(['validate', '--root', root, '--format', 'json'], root);
    expect(validate.code).toBe(0);
    expect(JSON.parse(validate.stdout)).toEqual([]);
  });

  it('queries, renders, allocates next IDs, diagnoses config, and initializes defaults', async () => {
    const root = await cliRepo('query');

    const query = await capture(['query', '--root', root, '--from', 'A1', '--format', 'json'], root);
    expect(query.code).toBe(0);
    expect(JSON.parse(query.stdout).nodes.map((node: { uid: string }) => node.uid)).toContain('scenario:S-01');

    const render = await capture(['render', '--root', root, '--format', 'mermaid'], root);
    expect(render.stdout).toContain('graph LR');

    const next = await capture(['next-id', 'scenario', '--range', 'batch-49', '--root', root], root);
    expect(next.stdout.trim()).toBe('S-1200');

    const doctor = await capture(['doctor', '--root', root], root);
    expect(doctor.stdout).toContain('artifact-graph.config.yaml');

    const fresh = join(tmpdir(), `artifact-graph-init-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(fresh, { recursive: true });
    const init = await capture(['init', '--root', fresh], fresh);
    expect(init.code).toBe(0);
    expect(await readFile(join(fresh, 'artifact-graph.config.yaml'), 'utf-8')).toContain('forbiddenEdges');
  });

  it('returns a failing exit code for validation issues unless warning-only is selected', async () => {
    const root = await cliRepo('validate-fail');
    await write(
      root,
      'artifacts/prd/features/B6-quick-check.md',
      `---
id: B6
title: Quick Check
status: done
scenarios: [S-404]
---
# B6
`,
    );

    const strict = await capture(['validate', '--root', root], root);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain('DANGLING_REFERENCE');

    const warningOnly = await capture(['validate', '--root', root, '--warning-only'], root);
    expect(warningOnly.code).toBe(0);
    expect(warningOnly.stdout).toContain('DANGLING_REFERENCE');
  });

  it('includes executable traceability warnings in validate output', async () => {
    const root = await cliRepo('traceability');
    await write(
      root,
      'artifacts/tests/e2e/test-01.md',
      `---
test_batch: test-01
scope: A1
ac_coverage:
  A1: [AC1, AC2]
related_scenarios: [S-01]
---

# E2E 测试: Import

## TC-001: Desktop import points to mock coverage

**前置条件**:
- Importable skill exists.

**测试步骤**:
1. Trigger import in the React UI.
2. Verify Tauri IPC starts the Node sidecar.
3. Verify JSON Lines from core engine are persisted to SQLite/report data.

**后置清理**:
- Remove imported skill.

**覆盖场景**: S-01
**覆盖功能**: A1(AC1, AC2)
**优先级**: P0
**executable_ref**: heimdall/packages/desktop/e2e/skills.e2e.spec.ts::TS-001
**chain_type**: desktop_chain
`,
    );
    await write(
      root,
      'heimdall/packages/desktop/e2e/skills.e2e.spec.ts',
      `// @tc test-01:TC-001 [mock_playwright]
describe('skills', () => {
  test('TS-001: mock import uses __TAURI_INTERNALS__', async () => {});
});
`,
    );

    const validate = await capture(['validate', '--root', root, '--warning-only', '--format', 'json'], root);
    const issues = JSON.parse(validate.stdout) as Array<{ code: string; message: string }>;

    expect(validate.code).toBe(0);
    expect(issues.some((issue) => issue.code === 'E2E-TRACE-004')).toBe(true);
  });

  it('resolves implementation context for a feature with --format json', async () => {
    const root = await cliRepo('context-feature');

    const result = await capture(['context', '--root', root, '--feature', 'A1', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.target).toMatchObject({
      type: 'feature',
      id: 'A1',
      uid: 'feature:A1',
      title: 'Skill import/register',
      sourcePath: 'artifacts/prd/features/A1-skill-import.md',
      status: 'done',
    });
    expect(manifest.context.baseline).toBeDefined();
    expect(manifest.context.baseline.length).toBeGreaterThan(0);
    expect(manifest.missing).toEqual([]);
  });

  it('resolves implementation context for a scenario with --format json', async () => {
    const root = await cliRepo('context-scenario');

    const result = await capture(['context', '--root', root, '--scenario', 'S-01', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.target).toMatchObject({
      type: 'scenario',
      id: 'S-01',
      uid: 'scenario:S-01',
      title: 'Import local skill',
      sourcePath: 'artifacts/scenarios/batch-1.md',
    });
    expect(manifest.missing).toEqual([]);
  });

  it('resolves implementation context for a decision with --format json', async () => {
    const root = await cliRepo('context-decision');
    await write(
      root,
      'artifacts/decisions/D-ARCH-01.md',
      `---
id: D-ARCH-01
title: Use TypeScript full stack
status: accepted
---
# D-ARCH-01: Use TypeScript full stack
`,
    );

    const result = await capture(['context', '--root', root, '--decision', 'D-ARCH-01', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.target).toMatchObject({
      type: 'decision',
      id: 'D-ARCH-01',
      uid: 'decision:D-ARCH-01',
      title: 'D-ARCH-01',
      sourcePath: 'artifacts/decisions/D-ARCH-01.md',
    });
    expect(manifest.missing).toEqual([]);
  });

  it('resolves implementation context for a design with --format json', async () => {
    const root = await cliRepo('context-design');

    const result = await capture(['context', '--root', root, '--design', 'design-skill-import', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.target).toMatchObject({
      type: 'design',
      id: 'design-skill-import',
      uid: 'design:design-skill-import',
      title: 'Skill import design',
      sourcePath: 'artifacts/design/design-skill-import.md',
    });
    expect(manifest.missing).toEqual([]);
  });

  it('resolves implementation context for an e2e_test with --format json', async () => {
    const root = await cliRepo('context-e2e-test');

    const result = await capture(['context', '--root', root, '--e2e-test', 'test-01:TC-001', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.target).toMatchObject({
      type: 'e2e_test',
      id: 'test-01:TC-001',
      uid: 'e2e_test:test-01:TC-001',
    });
    expect(manifest.missing).toEqual([]);
  });

  it('outputs markdown format by default for context command', async () => {
    const root = await cliRepo('context-markdown');

    const result = await capture(['context', '--root', root, '--feature', 'A1'], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Implementation Context');
    expect(result.stdout).toContain('feature:A1');
  });

  it('returns exit code 1 with usage when no context target is specified', async () => {
    const root = await cliRepo('context-no-target');

    const result = await capture(['context', '--root', root], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('returns exit code 1 with usage when multiple context targets are specified', async () => {
    const root = await cliRepo('context-multi-target');

    const result = await capture(['context', '--root', root, '--feature', 'A1', '--scenario', 'S-01'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('returns exit code 1 with not found in missing for non-existent target', async () => {
    const root = await cliRepo('context-not-found');

    const result = await capture(['context', '--root', root, '--feature', 'ZZ999', '--format', 'json'], root);
    expect(result.code).toBe(1);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.missing.length).toBeGreaterThan(0);
    expect(manifest.missing[0]).toContain('not found');
  });

  it('resolves context with --mode implementation --format json', async () => {
    const root = await cliRepo('context-impl-mode');

    const result = await capture(['context', '--root', root, '--feature', 'A1', '--mode', 'implementation', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.schemaVersion).toBe('1.0');
    expect(manifest.target).toMatchObject({
      type: 'feature',
      id: 'A1',
      uid: 'feature:A1',
      title: 'Skill import/register',
      sourcePath: 'artifacts/prd/features/A1-skill-import.md',
      status: 'done',
    });
    expect(manifest.context.baseline).toBeDefined();
    expect(manifest.context.baseline.length).toBe(19);
    expect(manifest.omitted).toBeDefined();
    // Baseline items should have tier and reasons
    for (const item of manifest.context.baseline) {
      expect(item.tier).toBe('baseline');
      expect(Array.isArray(item.reasons)).toBe(true);
    }
  });

  it('resolves context with --decision D-ARCH-01 --mode implementation --max-per-category 5', async () => {
    const root = await cliRepo('context-impl-max');
    await write(
      root,
      'artifacts/decisions/D-ARCH-01.md',
      `---
id: D-ARCH-01
title: Use TypeScript full stack
status: accepted
---
# D-ARCH-01: Use TypeScript full stack
`,
    );

    const result = await capture(['context', '--root', root, '--decision', 'D-ARCH-01', '--mode', 'implementation', '--max-per-category', '5', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.schemaVersion).toBe('1.0');
    // Non-baseline categories should have at most 5 items
    for (const [cat, items] of Object.entries(manifest.context)) {
      if (cat === 'baseline' || cat === 'target') continue;
      expect((items as unknown[]).length).toBeLessThanOrEqual(5);
    }
  });

  it('full mode retains more or equal context than implementation mode', async () => {
    const root = await cliRepo('context-full-vs-impl');

    const fullResult = await capture(['context', '--root', root, '--feature', 'A1', '--mode', 'full', '--format', 'json'], root);
    const implResult = await capture(['context', '--root', root, '--feature', 'A1', '--mode', 'implementation', '--format', 'json'], root);

    const full = JSON.parse(fullResult.stdout);
    const impl = JSON.parse(implResult.stdout);

    // Full mode should have same or more items in each category
    for (const cat of Object.keys(full.context)) {
      const fullCount = full.context[cat].length;
      const implCount = impl.context[cat]?.length ?? 0;
      expect(fullCount).toBeGreaterThanOrEqual(implCount);
    }
    // Full mode omitted should be empty or smaller
    expect(full.omitted.length).toBeLessThanOrEqual(impl.omitted.length);
  });

  it('baseline contains exactly 19 key files in implementation mode', async () => {
    const root = await cliRepo('context-baseline-19');

    const result = await capture(['context', '--root', root, '--feature', 'A1', '--mode', 'implementation', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    const baselinePaths = manifest.context.baseline.map((i: { path: string }) => i.path).sort();
    const expectedPaths = [
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
    ].sort();

    expect(baselinePaths).toEqual(expectedPaths);
    expect(manifest.context.baseline.every((i: { required: boolean }) => i.required === true)).toBe(true);
  });

  it('markdown output groups items by tier', async () => {
    const root = await cliRepo('context-md-tiers');

    const result = await capture(['context', '--root', root, '--feature', 'A1', '--mode', 'implementation', '--format', 'markdown'], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('# Implementation Context: feature:A1');

    // Assert section order: baseline before target
    const lines = result.stdout.split('\n');
    const h2Lines = lines.filter(l => l.startsWith('## '));
    const h2Texts = h2Lines.map(l => l.replace(/^## /, ''));
    const baselineIdx = h2Texts.indexOf('Baseline 必读');
    const targetIdx = h2Texts.indexOf('Target');
    expect(baselineIdx).toBeGreaterThanOrEqual(0);
    expect(targetIdx).toBeGreaterThanOrEqual(0);
    expect(baselineIdx).toBeLessThan(targetIdx);
  });

  it('returns exit code 1 for invalid --mode', async () => {
    const root = await cliRepo('context-mode-invalid');

    const result = await capture(['context', '--root', root, '--feature', 'A1', '--mode', 'typo'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid --mode');
  });

  it('returns exit code 1 for --max-per-category non-numeric', async () => {
    const root = await cliRepo('context-max-nan');

    const result = await capture(['context', '--root', root, '--feature', 'A1', '--max-per-category', 'nope'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid --max-per-category');
  });

  it('returns exit code 1 for --max-per-category 0', async () => {
    const root = await cliRepo('context-max-zero');

    const result = await capture(['context', '--root', root, '--feature', 'A1', '--max-per-category', '0'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid --max-per-category');
  });

  it('returns exit code 1 for --max-per-category negative', async () => {
    const root = await cliRepo('context-max-neg');

    const result = await capture(['context', '--root', root, '--feature', 'A1', '--max-per-category', '-1'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid --max-per-category');
  });

  it('accepts valid --max-per-category 5', async () => {
    const root = await cliRepo('context-max-valid');

    const result = await capture(['context', '--root', root, '--feature', 'A1', '--max-per-category', '5', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.schemaVersion).toBe('1.0');
  });

  it('generates packet --design design-skill-import --format json', async () => {
    const root = await cliRepo('packet-design');

    const result = await capture(['packet', '--root', root, '--design', 'design-skill-import', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const packet = JSON.parse(result.stdout);
    expect(packet.schemaVersion).toBe('1.0');
    expect(packet.target.type).toBe('design');
    expect(packet.target.id).toBe('design-skill-import');
    expect(packet.implementationBlueprintDraft.objective.designId).toBe('design-skill-import');
    expect(packet.implementationBlueprintDraft.objective.description).toContain('设计规格');
  });

  it('generates packet --e2e-test test-01:TC-001 --format json', async () => {
    const root = await cliRepo('packet-e2e-test');

    const result = await capture(['packet', '--root', root, '--e2e-test', 'test-01:TC-001', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const packet = JSON.parse(result.stdout);
    expect(packet.schemaVersion).toBe('1.0');
    expect(packet.target.type).toBe('e2e_test');
    expect(packet.target.id).toBe('test-01:TC-001');
    expect(packet.implementationBlueprintDraft.objective.e2eTestId).toBe('test-01:TC-001');
    expect(packet.implementationBlueprintDraft.objective.description).toContain('E2E 测试');
  });

  it('returns exit code 1 when both --feature and --design specified', async () => {
    const root = await cliRepo('context-mutual-excl');

    const result = await capture(['context', '--root', root, '--feature', 'A1', '--design', 'design-skill-import'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Usage');
  });
});

describe('packet-audit CLI', () => {
  it('batch audit succeeds with 3 valid targets (feature, scenario, decision)', async () => {
    const root = await cliRepo('audit-batch');
    const outDir = join(tmpdir(), `packet-audit-cli-batch-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\ndecision:D-ARCH-01\n');
    await write(root, 'artifacts/decisions/D-ARCH-01.md', `---
id: D-ARCH-01
title: TypeScript full stack
status: approved
---
# D-ARCH-01: TypeScript full stack
`);

    const result = await capture(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--format', 'json'], root);
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.targets).toHaveLength(3);
    expect(summary.targets.map((t: { type: string; id: string }) => `${t.type}:${t.id}`).sort()).toEqual([
      'decision:D-ARCH-01',
      'feature:A1',
      'scenario:S-01',
    ]);
  });

  it('records missing targets but continues the batch', async () => {
    const root = await cliRepo('audit-missing');
    const outDir = join(tmpdir(), `packet-audit-cli-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nfeature:ZZZZZ_NONEXISTENT\nscenario:S-01\n');

    const result = await capture(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--format', 'json'], root);
    expect(result.code).toBe(1);
    const summary = JSON.parse(result.stdout);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    const failedEntry = summary.targets.find((t: { status: string }) => t.status === 'failed');
    expect(failedEntry).toBeDefined();
    expect(failedEntry.errors.length).toBeGreaterThan(0);
  });

  it('returns exit code 1 with error for targets-file not found', async () => {
    const root = await cliRepo('audit-file-not-found');
    const nonExistentFile = join(root, 'no-such-file.txt');

    const result = await capture(['packet-audit', '--root', root, '--targets-file', nonExistentFile, '--out-dir', '/tmp/test'], root);
    expect(result.code).toBe(1);
  });

  it('returns exit code 1 when --out-dir is missing', async () => {
    const root = await cliRepo('audit-no-outdir');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const result = await capture(['packet-audit', '--root', root, '--targets-file', targetsFile], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('returns exit code 1 when --targets-file is missing', async () => {
    const root = await cliRepo('audit-no-tf');

    const result = await capture(['packet-audit', '--root', root, '--out-dir', '/tmp/test'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('summary.json structure contains total, passed, failed, targets', async () => {
    const root = await cliRepo('audit-summary');
    const outDir = join(tmpdir(), `packet-audit-cli-summary-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const result = await capture(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--format', 'json'], root);
    expect(result.code).toBe(0);

    const summaryFile = await readFile(join(outDir, 'summary.json'), 'utf-8');
    const summary = JSON.parse(summaryFile);
    expect(summary.schemaVersion).toBe('1.3');
    expect(summary).toHaveProperty('total');
    expect(summary).toHaveProperty('passed');
    expect(summary).toHaveProperty('failed');
    expect(summary).toHaveProperty('targets');
    expect(summary).toHaveProperty('generatedAt');
    expect(summary).toHaveProperty('totalOmitted');
    expect(summary).toHaveProperty('sourceTargetsPath');
    expect(summary).toHaveProperty('mode');
    expect(summary).toHaveProperty('format');
    expect(typeof summary.total).toBe('number');
    expect(typeof summary.passed).toBe('number');
    expect(typeof summary.failed).toBe('number');
    expect(typeof summary.totalOmitted).toBe('number');
    expect(Array.isArray(summary.targets)).toBe(true);
    expect(summary.sourceTargetsPath).toBe(targetsFile);
    expect(summary.mode).toBe('implementation');
    expect(summary.format).toBe('json');
  });

  it('outputs markdown summary by default', async () => {
    const root = await cliRepo('audit-md-default');
    const outDir = join(tmpdir(), `packet-audit-cli-md-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const result = await capture(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Packet Audit Summary');
    expect(result.stdout).toContain('Total:');
    expect(result.stdout).toContain('Passed:');
  });

  it('returns exit code 1 for empty targets file', async () => {
    const root = await cliRepo('audit-empty');
    const outDir = join(tmpdir(), `packet-audit-cli-empty-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, '# only comments\n\n');

    const result = await capture(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No valid targets found');
  });
});

describe('packet-audit --discover', () => {
  it('--discover works and generates packets and summary', async () => {
    const root = await cliRepo('discover-work');
    // Add a decision so discover finds all three types
    await write(root, 'artifacts/decisions/D-ARCH-01.md', `---
id: D-ARCH-01
title: TypeScript full stack
status: approved
---
# D-ARCH-01: TypeScript full stack
`);
    const outDir = join(tmpdir(), `packet-audit-discover-work-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const result = await capture(['packet-audit', '--root', root, '--discover', '--out-dir', outDir, '--format', 'json'], root);
    const summary = JSON.parse(result.stdout);
    expect(summary.schemaVersion).toBe('1.3');
    expect(summary.total).toBeGreaterThanOrEqual(3);
    expect(summary.passed).toBeGreaterThanOrEqual(3);
    expect(typeof summary.totalOmitted).toBe('number');
    // --discover mode does not use targets file
    expect(summary.sourceTargetsPath).toBeUndefined();

    // Should discover feature, scenario, decision (and now design/e2e_test)
    const types = summary.targets.map((t: { type: string }) => t.type);
    expect(types).toContain('feature');
    expect(types).toContain('scenario');
    expect(types).toContain('decision');

    // Verify summary.json was written
    const summaryFile = await readFile(join(outDir, 'summary.json'), 'utf-8');
    const parsed = JSON.parse(summaryFile);
    expect(parsed.total).toBe(summary.total);
  });

  it('--discover and --targets-file are mutually exclusive', async () => {
    const root = await cliRepo('discover-mutex');
    const outDir = join(tmpdir(), `packet-audit-discover-mutex-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const result = await capture(['packet-audit', '--root', root, '--discover', '--targets-file', targetsFile, '--out-dir', outDir], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('--limit takes effect with --discover', async () => {
    const root = await cliRepo('discover-limit');
    const outDir = join(tmpdir(), `packet-audit-discover-limit-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const result = await capture(['packet-audit', '--root', root, '--discover', '--limit', '2', '--out-dir', outDir, '--format', 'json'], root);
    expect(result.code).toBe(0);

    const summary = JSON.parse(result.stdout);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);

    // Round-robin: first is feature, second is scenario
    expect(summary.targets[0].type).toBe('feature');
    expect(summary.targets[1].type).toBe('scenario');
  });
});

describe('packet-prompt CLI', () => {
  it('generates prompt for feature A1', async () => {
    const root = await cliRepo('prompt-feature');
    const result = await capture(['packet-prompt', '--root', root, '--feature', 'A1'], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('实现任务：功能 A1');
    expect(result.stdout).toContain('必读制品');
    expect(result.stdout).toContain('验证命令');
    expect(result.stdout).toContain('禁止事项');
    expect(result.stdout).toContain('提交要求');
    expect(result.stdout).toContain('约束与边界');
    expect(result.stdout.length).toBeLessThanOrEqual(4000);
  });

  it('generates prompt for scenario S-01', async () => {
    const root = await cliRepo('prompt-scenario');
    const result = await capture(['packet-prompt', '--root', root, '--scenario', 'S-01'], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('实现任务：场景 S-01');
    expect(result.stdout).toContain('packet --root');
    expect(result.stdout).toContain('--scenario S-01');
    expect(result.stdout.length).toBeLessThanOrEqual(4000);
  });

  it('generates prompt for decision D-ARCH-01', async () => {
    const root = await cliRepo('prompt-decision');
    // Add a decision artifact to the test repo
    await write(root, 'artifacts/decisions/D-ARCH-01.md', `---
id: D-ARCH-01
title: TypeScript full stack
status: accepted
---

# D-ARCH-01: TypeScript full stack

技术栈必须为 TypeScript 全栈。
`);
    const result = await capture(['packet-prompt', '--root', root, '--decision', 'D-ARCH-01'], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('实现任务：决策 D-ARCH-01');
    expect(result.stdout).toContain('packet --root');
    expect(result.stdout).toContain('--decision D-ARCH-01');
    expect(result.stdout.length).toBeLessThanOrEqual(4000);
  });

  it('default length is <= 4000 characters', async () => {
    const root = await cliRepo('prompt-length');
    const result = await capture(['packet-prompt', '--root', root, '--feature', 'A1'], root);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(4000);
  });

  it('contains required baseline reference, validation commands, commit requirements, and no-revert rule', async () => {
    const root = await cliRepo('prompt-content');
    const result = await capture(['packet-prompt', '--root', root, '--feature', 'A1'], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('必读制品');
    expect(result.stdout).toContain('pnpm build');
    expect(result.stdout).toContain('pnpm test');
    expect(result.stdout).toContain('validate');
    expect(result.stdout).toContain('不要回退用户已有改动');
    expect(result.stdout).toContain('不得回退用户已有的 dirty work');
  });

  it('returns exit code 1 for missing target', async () => {
    const root = await cliRepo('prompt-missing');
    const result = await capture(['packet-prompt', '--root', root, '--feature', 'ZZ999'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Missing artifacts');
    expect(result.stderr).toContain('not found');
  });

  it('returns exit code 1 with usage when no target specified', async () => {
    const root = await cliRepo('prompt-no-target');
    const result = await capture(['packet-prompt', '--root', root], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('writes output to --out file', async () => {
    const root = await cliRepo('prompt-out');
    const outPath = join(root, 'prompt-output.md');
    const result = await capture(['packet-prompt', '--root', root, '--feature', 'A1', '--out', outPath], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Prompt written to');
    const content = await readFile(outPath, 'utf-8');
    expect(content).toContain('实现任务：功能 A1');
    expect(content).toContain('必读制品');
  });

  it('--max-chars truncates but retains key commands and packet reference', async () => {
    const root = await cliRepo('prompt-max-chars');
    const result = await capture(['packet-prompt', '--root', root, '--feature', 'A1', '--max-chars', '800'], root);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(800);
    // Key elements must survive truncation
    expect(result.stdout).toContain('packet --root');
    expect(result.stdout).toContain('验证命令');
    expect(result.stdout).toContain('pnpm build');
  });

  it('prompt text is primarily Chinese with technical terms in English', async () => {
    const root = await cliRepo('prompt-lang');
    const result = await capture(['packet-prompt', '--root', root, '--feature', 'A1'], root);
    expect(result.code).toBe(0);
    // Chinese content markers
    expect(result.stdout).toContain('实现任务');
    expect(result.stdout).toContain('必读制品');
    expect(result.stdout).toContain('约束与边界');
    expect(result.stdout).toContain('验证命令');
    expect(result.stdout).toContain('提交要求');
    expect(result.stdout).toContain('禁止事项');
    // No large English paragraphs (no 100+ consecutive ASCII letter sequences excluding code blocks)
    const textOutsideCodeBlocks = result.stdout.replace(/```[\s\S]*?```/g, '');
    const longEnglishRun = /[a-zA-Z\s]{100,}/;
    expect(longEnglishRun.test(textOutsideCodeBlocks)).toBe(false);
  });

  it('returns exit code 1 for --max-chars below MIN_PROMPT_CHARS', async () => {
    const root = await cliRepo('prompt-max-chars-invalid');
    const result = await capture(['packet-prompt', '--root', root, '--feature', 'A1', '--max-chars', '100'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid --max-chars');
  });

  it('--max-chars at MIN_PROMPT_CHARS boundary succeeds', async () => {
    const root = await cliRepo('prompt-max-chars-boundary');
    const result = await capture(['packet-prompt', '--root', root, '--feature', 'A1', '--max-chars', String(MIN_PROMPT_CHARS)], root);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(MIN_PROMPT_CHARS);
    expect(result.stdout).toContain('artifact-graph packet');
    expect(result.stdout).toContain('pnpm build');
    expect(result.stdout).toContain('git diff --check');
    expect(result.stdout).toContain('禁止事项');
    expect(result.stdout).toContain('不得回退');
    expect(result.stdout).toContain('SEC severity');
  });

  // ── v1.9: --packet JSON input tests ──

  it('--packet reads from JSON file and generates prompt', async () => {
    const root = await cliRepo('prompt-packet-json');
    // First generate a packet JSON
    const packetOut = join(root, 'test-packet.json');
    const genResult = await runCli(['packet', '--root', root, '--feature', 'A1', '--format', 'json', '--out', packetOut], {
      cwd: root,
      stdout: () => {},
      stderr: () => {},
    });
    expect(genResult).toBe(0);
    // Now use --packet to generate prompt
    const result = await capture(['packet-prompt', '--root', root, '--packet', packetOut], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('实现任务');
    expect(result.stdout).toContain('packet');
  });

  it('--packet with --feature is mutually exclusive', async () => {
    const root = await cliRepo('prompt-packet-mutual');
    const result = await capture(['packet-prompt', '--root', root, '--packet', '/tmp/fake.json', '--feature', 'A1'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('互斥');
  });

  it('--packet with missing file exits 1', async () => {
    const root = await cliRepo('prompt-packet-missing');
    const result = await capture(['packet-prompt', '--root', root, '--packet', '/tmp/nonexistent-packet-xyz.json'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('无法读取');
  });

  it('--packet with invalid JSON exits 1', async () => {
    const root = await cliRepo('prompt-packet-invalid');
    const badFile = join(root, 'bad-packet.json');
    await writeFile(badFile, 'not json {{{');
    const result = await capture(['packet-prompt', '--root', root, '--packet', badFile], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('不是有效的 JSON');
  });

  it('--packet with missing required fields exits 1', async () => {
    const root = await cliRepo('prompt-packet-schema');
    const partialFile = join(root, 'partial-packet.json');
    await writeFile(partialFile, JSON.stringify({ schemaVersion: '1.0', target: { type: 'feature', id: 'A1', uid: 'feature:A1' } }));
    const result = await capture(['packet-prompt', '--root', root, '--packet', partialFile], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('缺失或无效字段');
  });

  // ── v1.9: --format validation tests ──

  it('--format markdown is accepted', async () => {
    const root = await cliRepo('prompt-format-md');
    const result = await capture(['packet-prompt', '--root', root, '--feature', 'A1', '--format', 'markdown'], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('实现任务');
  });

  it('--format json exits 1', async () => {
    const root = await cliRepo('prompt-format-json');
    const result = await capture(['packet-prompt', '--root', root, '--feature', 'A1', '--format', 'json'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('不支持');
  });

  it('--format unknown exits 1', async () => {
    const root = await cliRepo('prompt-format-unknown');
    const result = await capture(['packet-prompt', '--root', root, '--feature', 'A1', '--format', 'yaml'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('不支持');
  });
});

describe('packet source file integrity', () => {
  const PKG_ROOT = resolve(import.meta.dirname, '..');
  const SRC = join(PKG_ROOT, 'src');

  const CRITICAL_FILES = [
    'index.ts',
    'cli.ts',
    'packet-constants.ts',
    'packet-assembler.ts',
    'packet-audit.ts',
    'packet-validator.ts',
    'packet-prompt.ts',
  ];

  for (const file of CRITICAL_FILES) {
    it(`${file} exists on disk`, async () => {
      const filePath = join(SRC, file);
      await expect(access(filePath)).resolves.toBeUndefined();
    });
  }

  it('packet-constants.ts exports ALWAYS_PRESENT_ITEMS', async () => {
    const mod = await import('../src/packet-constants.js');
    expect(mod.ALWAYS_PRESENT_ITEMS).toBeDefined();
    expect(Array.isArray(mod.ALWAYS_PRESENT_ITEMS)).toBe(true);
    expect(mod.ALWAYS_PRESENT_ITEMS.length).toBeGreaterThan(0);
  });

  it('packet-constants.ts exports BASELINE_CONSTRAINTS', async () => {
    const mod = await import('../src/packet-constants.js');
    expect(mod.BASELINE_CONSTRAINTS).toBeDefined();
    expect(Array.isArray(mod.BASELINE_CONSTRAINTS)).toBe(true);
    expect(mod.BASELINE_CONSTRAINTS.length).toBeGreaterThan(0);
  });
});
