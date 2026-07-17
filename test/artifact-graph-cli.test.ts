import { access, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
context:
  universal_baseline: false
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

/** cliRepo variant with universal_baseline enabled and all 19 baseline files on disk. */
async function cliRepoWithBaseline(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-cli-baseline-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  await write(root, 'artifact-graph.config.yaml', `idRanges:\n  scenario:\n    batch-49:\n      prefix: S-\n      start: 1200\n      end: 1299\n`);
  await write(root, 'artifacts/prd/features/A1-skill-import.md', `---\nid: A1\ntitle: Skill import/register\nstatus: done\nscenarios: [S-01]\ndesign_docs: [design-skill-import]\n---\n# A1: Skill import/register\n`);
  await write(root, 'artifacts/design/design-skill-import.md', `---\ntitle: Skill import design\nrelated_features: [A1]\nrelated_scenarios: [S-01]\n---\n# Skill import design\n`);
  await write(root, 'artifacts/scenarios/batch-1.md', `## S-01: Import local skill\n\n**关联功能**: A1 (Skill import/register)\n`);
  await write(root, 'artifacts/tests/e2e/test-01.md', `---\ntest_batch: test-01\nscope: A1\nac_coverage:\n  A1: [AC1, AC2]\nrelated_scenarios: [S-01]\n---\n\n# E2E 测试: Import\n`);
  await write(root, 'artifacts/tests/e2e/e2e-test-registry.json', JSON.stringify({ registry_version: '1.0', total_batches: 1, total_test_cases: 1, batches: [{ batch_id: 'test-01', scope: 'A1', file: 'artifacts/tests/e2e/test-01.md', ac_coverage: { A1: ['AC1', 'AC2'] }, related_scenarios: ['S-01'], test_case_count: 1 }] }, null, 2) + '\n');
  // All 19 baseline files
  for (const bf of ['AGENTS.md', 'CLAUDE.md', 'artifacts/artifact-chain-spec.md', 'artifacts/blueprints/generation-packet-spec.md', 'artifacts/blueprints/implementation-blueprint.md', 'artifacts/contracts/interface-contracts.md', 'artifacts/contracts/data-contracts.md', 'artifacts/contracts/application-state-machines.md', 'artifacts/contracts/error-model.md', 'artifacts/contracts/report-contracts.md', 'artifacts/contracts/ui-flow-contracts.md', 'artifacts/contracts/non-functional-budgets.md', 'artifacts/domain/domain-glossary.md', 'artifacts/domain/bounded-context-map.md', 'artifacts/domain/domain-invariants.md', 'artifacts/tests/rule-golden-cases.md', 'artifacts/tests/verification-fixtures.md', 'artifacts/design/test-strategy.md', 'artifacts/traceability-matrix-v2.md']) {
    await write(root, bf, `# ${bf}\n`);
  }
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
  it.each([['--help'], ['-h'], ['help']])('explicit help %j returns exit 0 with usage', async (args) => {
    const root = await cliRepo(`help-${args[0]}`);
    const result = await capture([args], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('artifact-graph <command>');
    expect(result.stdout).toContain('version-lock');
  });

  it('no arguments returns non-zero and prints usage to stderr', async () => {
    const root = await cliRepo('no-args');
    const result = await capture([], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('artifact-graph <command>');
  });

  it('unknown command returns non-zero', async () => {
    const root = await cliRepo('unknown');
    const result = await capture(['bogus'], root);
    expect(result.code).toBe(1);
  });

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

  it('exposes scenario to PRD link validation through validate --include scenario-prd-links', async () => {
    const root = await cliRepo('scenario-prd-include');
    await write(
      root,
      'artifacts/scenarios/batch-1.md',
      `## S-01: Import local skill

**关联功能**: A1, A1
`,
    );
    await write(
      root,
      'artifacts/prd/feature-index.md',
      `| Feature | Title | Domain | Status | Scenarios |
| --- | --- | --- | --- | --- |
| [A1](features/A1-skill-import.md) | Skill import/register | A | done | 2 |
`,
    );

    const validate = await capture(['validate', '--root', root, '--include', 'scenario-prd-links', '--warning-only', '--format', 'json'], root);
    const issues = JSON.parse(validate.stdout) as Array<{ code: string; message: string }>;

    expect(validate.code).toBe(0);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'DUPLICATE' }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'INDEX_MISMATCH' }));
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
    const root = await cliRepoWithBaseline('context-feature');

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
      title: 'Use TypeScript full stack',
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
    const root = await cliRepoWithBaseline('context-impl-mode');

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
    const root = await cliRepoWithBaseline('context-baseline-19');

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
    // All 19 baseline files exist in cliRepo fixture → no missing
    expect(manifest.missing).toEqual([]);
  });

  it('markdown output groups items by tier', async () => {
    const root = await cliRepoWithBaseline('context-md-tiers');

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

  it('reports missing baseline files and returns exit 1 when baseline files absent', async () => {
    // Create a repo WITHOUT baseline files
    const root = join(tmpdir(), `artifact-graph-cli-baseline-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    await write(root, 'artifact-graph.config.yaml', `idRanges:\n  scenario:\n    batch-49:\n      prefix: S-\n      start: 1200\n      end: 1299\n`);
    await write(root, 'artifacts/prd/features/A1-skill-import.md', `---\nid: A1\ntitle: Skill import\nstatus: done\n---\n# A1\n`);
    await write(root, 'artifacts/scenarios/batch-1.md', `## S-01: Test\n\n关联功能: A1\n`);

    const result = await capture(['context', '--root', root, '--feature', 'A1', '--format', 'json'], root);
    expect(result.code).toBe(1);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.missing.length).toBeGreaterThan(0);
    expect(manifest.missingDetails.some((d: { kind: string }) => d.kind === 'missing-baseline')).toBe(true);
  });

  it('universal_baseline: false in config skips baseline and returns exit 0', async () => {
    const root = join(tmpdir(), `artifact-graph-cli-optout-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    await write(root, 'artifact-graph.config.yaml', `context:\n  universal_baseline: false\nidRanges:\n  scenario:\n    batch-49:\n      prefix: S-\n      start: 1200\n      end: 1299\n`);
    await write(root, 'artifacts/prd/features/A1-skill-import.md', `---\nid: A1\ntitle: Skill import\nstatus: done\n---\n# A1\n`);
    await write(root, 'artifacts/scenarios/batch-1.md', `## S-01: Test\n\n关联功能: A1\n`);

    const result = await capture(['context', '--root', root, '--feature', 'A1', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.missing).toEqual([]);
    // Baseline should not be present when opt-out
    expect(manifest.context.baseline).toBeUndefined();
  });

  // @feature ACA17
  // @decision D-ACA-17
  // Reject non-boolean universal_baseline (e.g. 0, "", "false")
  it('rejects non-boolean universal_baseline in config (0, "", "false")', async () => {
    const root = join(tmpdir(), `artifact-graph-cli-ub-type-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    await write(root, 'artifact-graph.config.yaml', `context:\n  universal_baseline: 0\n`);
    await write(root, 'artifacts/prd/features/A1-skill-import.md', `---\nid: A1\ntitle: Skill import\nstatus: done\n---\n# A1\n`);
    const result = await capture(['context', '--root', root, '--feature', 'A1', '--format', 'json'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid context.universal_baseline');
  });

  // Reject directory masquerading as baseline file
  it('reports directory-as-baseline as missing (not a regular file)', async () => {
    const root = join(tmpdir(), `artifact-graph-cli-dir-bl-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    await write(root, 'artifact-graph.config.yaml', `idRanges:\n  scenario:\n    batch-49:\n      prefix: S-\n      start: 1200\n      end: 1299\n`);
    await write(root, 'artifacts/prd/features/A1-skill-import.md', `---\nid: A1\ntitle: Skill import\nstatus: done\n---\n# A1\n`);
    await write(root, 'artifacts/scenarios/batch-1.md', `## S-01: Test\n\n关联功能: A1\n`);
    // Create AGENTS.md as a directory instead of a file
    await mkdir(join(root, 'AGENTS.md'), { recursive: true });
    const result = await capture(['context', '--root', root, '--feature', 'A1', '--format', 'json'], root);
    expect(result.code).toBe(1);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.missing.some((m: string) => m.includes('AGENTS.md') && m.includes('not a regular file'))).toBe(true);
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

describe('target-selector: parseTargetSelector', () => {
  it('splits on first colon, preserving colons in ID', async () => {
    const { parseTargetSelector } = await import('../src/target-selector.js');
    expect(parseTargetSelector('e2e_test:batch:TC-001')).toEqual({
      type: 'e2e_test',
      id: 'batch:TC-001',
    });
  });

  it('parses simple type:id', async () => {
    const { parseTargetSelector } = await import('../src/target-selector.js');
    expect(parseTargetSelector('feature:A1')).toEqual({
      type: 'feature',
      id: 'A1',
    });
  });

  it('rejects missing colon', async () => {
    const { parseTargetSelector } = await import('../src/target-selector.js');
    expect(() => parseTargetSelector('featureA1')).toThrow('target must use <type>:<id>');
  });

  it('rejects empty type', async () => {
    const { parseTargetSelector } = await import('../src/target-selector.js');
    expect(() => parseTargetSelector(':A1')).toThrow('target must use <type>:<id>');
  });

  it('rejects empty id', async () => {
    const { parseTargetSelector } = await import('../src/target-selector.js');
    expect(() => parseTargetSelector('feature:')).toThrow('target must use <type>:<id>');
  });
});

describe('--target CLI integration', () => {
  // Helper to create a repo with custom target types
  async function customTargetRepo(name: string): Promise<string> {
    const root = join(tmpdir(), `artifact-graph-custom-target-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    await write(root, 'artifact-graph.config.yaml', `types:
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
    displayName: "API Contract"
idPatterns:
  api_contract: "^API-\\\\d+$"
context:
  universal_baseline: false
`);
    await write(root, 'artifacts/prd/features/A1-skill-import.md', `---
id: A1
title: Skill import/register
status: done
---
# A1: Skill import/register
`);
    await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Order API
status: active
---
# Order API
`);
    return root;
  }

  // Helper to create a repo with target:false type
  async function noTargetRepo(name: string): Promise<string> {
    const root = join(tmpdir(), `artifact-graph-no-target-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    await write(root, 'artifact-graph.config.yaml', `types:
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: false
    displayName: "API Contract"
idPatterns:
  api_contract: "^API-\\\\d+$"
`);
    await write(root, 'artifacts/contracts/api/API-001.md', `---
id: API-001
title: Order API
status: active
---
# Order API
`);
    return root;
  }

  it('context --target api_contract:API-001 works for custom target type', async () => {
    const root = await customTargetRepo('context-custom');
    const result = await capture(['context', '--root', root, '--target', 'api_contract:API-001', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.target.type).toBe('api_contract');
    expect(manifest.target.id).toBe('API-001');
  });

  it('context --target with colon in ID (e2e_test:batch:TC-001)', async () => {
    const root = await cliRepo('context-colon-id');
    const result = await capture(['context', '--root', root, '--target', 'e2e_test:test-01:TC-001', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.target.type).toBe('e2e_test');
    expect(manifest.target.id).toBe('test-01:TC-001');
  });

  it('--target and --feature are mutually exclusive', async () => {
    const root = await customTargetRepo('context-mutex');
    const result = await capture(['context', '--root', root, '--target', 'api_contract:API-001', '--feature', 'A1'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('互斥');
  });

  it('packet --target and --feature are mutually exclusive', async () => {
    const root = await customTargetRepo('packet-mutex');
    const result = await capture(['packet', '--root', root, '--target', 'api_contract:API-001', '--feature', 'A1'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('互斥');
  });

  it('rejects --target with unregistered type', async () => {
    const root = await customTargetRepo('context-unreg');
    const result = await capture(['context', '--root', root, '--target', 'unknown_type:X-001'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('不是合法的 target 类型');
  });

  it('rejects --target with target:false type', async () => {
    const root = await noTargetRepo('context-no-target');
    const result = await capture(['context', '--root', root, '--target', 'api_contract:API-001'], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('不是合法的 target 类型');
  });

  it('legacy --feature still works', async () => {
    const root = await cliRepo('context-legacy');
    const result = await capture(['context', '--root', root, '--feature', 'A1', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.target.type).toBe('feature');
    expect(manifest.target.id).toBe('A1');
  });

  it('packet --target works for custom target type', async () => {
    const root = await customTargetRepo('packet-custom');
    const result = await capture(['packet', '--root', root, '--target', 'api_contract:API-001', '--format', 'json'], root);
    expect(result.code).toBe(0);
    const packet = JSON.parse(result.stdout);
    expect(packet.target.type).toBe('api_contract');
    expect(packet.target.id).toBe('API-001');
  });

  it('no target flag gives error', async () => {
    const root = await cliRepo('context-no-flag');
    const result = await capture(['context', '--root', root], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('未指定 target');
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

  // @scenario S-09
  // @feature ACA8
  describe('CLI --help/-h safety: no command side effects', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
      for (const root of tempRoots) {
        await rm(root, { recursive: true, force: true });
      }
      tempRoots.length = 0;
    });

    async function gitRepo(name: string): Promise<string> {
      const root = join(tmpdir(), `artifact-graph-cli-help-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      await mkdir(root, { recursive: true });
      execSync('git init -q', { cwd: root });
      tempRoots.push(root);
      return root;
    }

    async function hookExists(hookPath: string): Promise<boolean> {
      try {
        await lstat(hookPath);
        return true;
      } catch {
        return false;
      }
    }

    async function cliRepoTracked(name: string): Promise<string> {
      const root = await cliRepo(name);
      tempRoots.push(root);
      return root;
    }

    async function configExists(configPath: string): Promise<boolean> {
      try {
        await lstat(configPath);
        return true;
      } catch {
        return false;
      }
    }

    // hooks install-git --help/-h does not create hooks
    it.each([[['hooks', 'install-git', '--help']], [['hooks', 'install-git', '-h']], [['hooks', '--help']], [['hooks', '-h']]])(
      'hooks %j returns exit 0, prints usage, and does not create hooks',
      async (args: string[]) => {
        const root = await gitRepo(`help-${args.join('-')}`);
        const result = await capture(args, root);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('artifact-graph <command>');
        const hooksDir = join(root, '.git', 'hooks');
        expect(await hookExists(join(hooksDir, 'pre-commit'))).toBe(false);
        expect(await hookExists(join(hooksDir, 'pre-push'))).toBe(false);
      },
    );

    // version-lock --help/-h returns usage without executing
    it.each([[['version-lock', '--help']], [['version-lock', '-h']]])(
      'version-lock %j returns exit 0 and prints usage',
      async (args: string[]) => {
        const root = await cliRepoTracked(`vl-help-${args.join('-')}`);
        const result = await capture(args, root);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('artifact-graph <command>');
      },
    );

    // version-lock refresh --all --help/-h returns usage without executing
    it.each([[['version-lock', 'refresh', '--all', '--help']], [['version-lock', 'refresh', '--all', '-h']]])(
      'version-lock refresh %j returns exit 0 and prints usage',
      async (args: string[]) => {
        const root = await cliRepoTracked(`vl-refresh-help-${args.join('-')}`);
        const result = await capture(args, root);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('artifact-graph <command>');
      },
    );

    // init --help/-h does not create config
    it.each([[['init', '--help']], [['init', '-h']]])(
      'init %j returns exit 0, prints usage, and does not create config',
      async (args: string[]) => {
        const root = await gitRepo(`init-help-${args.join('-')}`);
        const result = await capture(args, root);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('artifact-graph <command>');
        expect(await configExists(join(root, 'artifact-graph.config.yaml'))).toBe(false);
      },
    );

    // scan --help/-h does not create cache
    it.each([[['scan', '--help']], [['scan', '-h']]])(
      'scan %j returns exit 0, prints usage, and does not create cache',
      async (args: string[]) => {
        const root = await cliRepoTracked(`scan-help-${args.join('-')}`);
        const result = await capture(args, root);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('artifact-graph <command>');
        // Scan should not create cache when --help is passed
        expect(await configExists(join(root, '.artifact-graph', 'index.json'))).toBe(false);
      },
    );

    // hooks install-git without --help installs hooks normally
    it('hooks install-git without --help installs hooks normally', async () => {
      const root = await gitRepo('normal-install');
      const result = await capture(['hooks', 'install-git'], root);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('installed:');
      expect(await hookExists(join(root, '.git', 'hooks', 'pre-commit'))).toBe(true);
      expect(await hookExists(join(root, '.git', 'hooks', 'pre-push'))).toBe(true);
    });

    // init without --help creates config normally
    it('init without --help creates config normally', async () => {
      const root = await gitRepo('normal-init');
      const result = await capture(['init', '--root', root], root);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Created');
      expect(await configExists(join(root, 'artifact-graph.config.yaml'))).toBe(true);
    });
  });
});
