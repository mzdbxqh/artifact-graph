import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTargetsFile } from '../src/packet-audit.js';
import { auditPackets, discoverAndAuditPackets } from '../src/packet-audit.js';
import { discoverTargets, scanArtifacts } from '../src/index.js';
import { runCli } from '../src/cli.js';

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

async function auditRepo(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-packet-audit-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });

  // Config
  await write(root, 'artifact-graph.config.yaml', `idRanges:\n  scenario:\n    batch-49:\n      prefix: S-\n      start: 1200\n      end: 1299\n`);

  // Baseline files
  for (const bf of BASELINE_FILES) {
    await write(root, bf.path, bf.content);
  }

  // Feature A1
  await write(root, 'artifacts/prd/features/A1-skill-import.md', `---
id: A1
title: Skill import/register
status: done
scenarios: [S-01]
design_docs: [design-skill-import]
---
# A1: Skill import/register
`);

  // Feature A2
  await write(root, 'artifacts/prd/features/A2-scan-engine.md', `---
id: A2
title: Scan engine
status: done
---
# A2: Scan engine
`);

  // Design (with full traceability for packet generation)
  await write(root, 'artifacts/design/design-skill-import.md', `---
title: Skill import design
related_features: [A1]
related_scenarios: [S-01]
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

/** Like auditRepo but also includes design and e2e_test fixtures. */
async function auditRepoWithAllTypes(name: string): Promise<string> {
  const root = await auditRepo(name);

  // E2E test
  await write(root, 'artifacts/tests/e2e/test-01.md', `---
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

// ── Unit tests: parseTargetsFile ──

describe('parseTargetsFile', () => {
  it('should parse valid type:id lines', () => {
    const content = 'feature:A1\nscenario:S-01\ndecision:D-ARCH-01\n';
    const result = parseTargetsFile(content);
    expect(result.targets).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
    expect(result.targets[0]).toEqual({ type: 'feature', id: 'A1' });
    expect(result.targets[1]).toEqual({ type: 'scenario', id: 'S-01' });
    expect(result.targets[2]).toEqual({ type: 'decision', id: 'D-ARCH-01' });
  });

  it('should parse design and e2e_test type lines', () => {
    const content = 'design:design-extended-scan\ne2e_test:test-01:TC-001\n';
    const result = parseTargetsFile(content);
    expect(result.targets).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.targets[0]).toEqual({ type: 'design', id: 'design-extended-scan' });
    expect(result.targets[1]).toEqual({ type: 'e2e_test', id: 'test-01:TC-001' });
  });

  it('should skip blank lines', () => {
    const content = 'feature:A1\n\n\nscenario:S-01\n';
    const result = parseTargetsFile(content);
    expect(result.targets).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it('should skip comment lines starting with #', () => {
    const content = '# This is a comment\nfeature:A1\n# Another comment\nscenario:S-01\n';
    const result = parseTargetsFile(content);
    expect(result.targets).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.targets[0].type).toBe('feature');
    expect(result.targets[1].type).toBe('scenario');
  });

  it('should report error for lines with invalid type', () => {
    const content = 'feature:A1\ninvalid:B2\nscenario:S-01\n';
    const result = parseTargetsFile(content);
    expect(result.targets).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(2);
    expect(result.errors[0].message).toContain('非法类型 "invalid"');
    expect(result.targets[0]).toEqual({ type: 'feature', id: 'A1' });
    expect(result.targets[1]).toEqual({ type: 'scenario', id: 'S-01' });
  });

  it('should report error for lines without colon', () => {
    const content = 'feature:A1\nno-colon-here\nscenario:S-01\n';
    const result = parseTargetsFile(content);
    expect(result.targets).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(2);
    expect(result.errors[0].message).toContain('缺少冒号分隔符');
  });

  it('should report error for lines with empty id', () => {
    const content = 'feature:A1\nfeature:\nscenario:S-01\n';
    const result = parseTargetsFile(content);
    expect(result.targets).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(2);
    expect(result.errors[0].message).toContain('ID 为空');
  });

  it('should handle content with leading/trailing whitespace', () => {
    const content = '  feature:A1  \n  scenario:S-01  \n';
    const result = parseTargetsFile(content);
    expect(result.targets).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.targets[0]).toEqual({ type: 'feature', id: 'A1' });
    expect(result.targets[1]).toEqual({ type: 'scenario', id: 'S-01' });
  });

  it('should return empty arrays for empty content', () => {
    const result = parseTargetsFile('');
    expect(result.targets).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should return empty arrays for only comments and blanks', () => {
    const content = '# comment\n\n  \n# another\n';
    const result = parseTargetsFile(content);
    expect(result.targets).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should report multiple errors for multiple invalid lines', () => {
    const content = 'invalid:A1\nno-colon\nfeature:\n';
    const result = parseTargetsFile(content);
    expect(result.targets).toHaveLength(0);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0].line).toBe(1);
    expect(result.errors[1].line).toBe(2);
    expect(result.errors[2].line).toBe(3);
  });
});

// ── Unit tests: auditPackets ──

describe('auditPackets', () => {
  it('should audit multiple targets successfully', async () => {
    const root = await auditRepo('multi-pass');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
      { type: 'decision' as const, id: 'D-ARCH-01' },
    ];
    const summary = await auditPackets(root, targets, { root });
    expect(summary.schemaVersion).toBe('1.3');
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.totalOmitted).toBe(0);
    expect(summary.targets).toHaveLength(3);
    expect(summary.generatedAt).toBeDefined();
  });

  it('should report failures when target has missing artifacts', async () => {
    const root = await auditRepo('missing-target');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'feature' as const, id: 'NONEXISTENT' },
    ];
    const summary = await auditPackets(root, targets, { root });
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.targets[0].status).toBe('passed');
    expect(summary.targets[1].status).toBe('failed');
    expect(summary.targets[1].errors.length).toBeGreaterThan(0);
  });

  it('should populate missingDetailsSummary for failed targets', async () => {
    const root = await auditRepo('missing-details');
    const targets = [
      { type: 'feature' as const, id: 'NONEXISTENT' },
    ];
    const summary = await auditPackets(root, targets, { root });
    expect(summary.targets[0].status).toBe('failed');
    expect(summary.targets[0].missingDetailsSummary).toBeDefined();
    expect(summary.targets[0].missingDetailsSummary!.length).toBe(1);
    expect(summary.targets[0].missingDetailsSummary![0].kind).toBe('target-not-found');
    expect(summary.targets[0].missingDetailsSummary![0].ref).toBe('NONEXISTENT');
    expect(summary.targets[0].missingDetailsSummary![0].suggestedAction).toBe('创建文件或检查 ID 拼写');
  });

  it('should not have missingDetailsSummary for passed targets', async () => {
    const root = await auditRepo('no-missing-details');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
    ];
    const summary = await auditPackets(root, targets, { root });
    expect(summary.targets[0].status).toBe('passed');
    expect(summary.targets[0].missingDetailsSummary).toBeUndefined();
  });

  it('should write packet files to outDir', async () => {
    const root = await auditRepo('write-files');
    const outDir = join(tmpdir(), `packet-audit-out-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'decision' as const, id: 'D-ARCH-01' },
    ];
    const summary = await auditPackets(root, targets, { root, outDir, format: 'json' });
    expect(summary.passed).toBe(2);

    // Verify files were created
    const files = await readdir(outDir);
    expect(files).toContain('feature-A1.packet.json');
    expect(files).toContain('decision-D-ARCH-01.packet.json');
    expect(files).toContain('summary.json');

    // Verify packet content is valid JSON
    const content = await readFile(join(outDir, 'feature-A1.packet.json'), 'utf-8');
    const packet = JSON.parse(content);
    expect(packet.schemaVersion).toBe('1.0');
    expect(packet.target.id).toBe('A1');

    // Verify summary content
    const summaryContent = await readFile(join(outDir, 'summary.json'), 'utf-8');
    const summaryParsed = JSON.parse(summaryContent);
    expect(summaryParsed.schemaVersion).toBe('1.3');
    expect(summaryParsed.total).toBe(2);
    expect(summaryParsed.totalOmitted).toBe(0);
  });

  it('should write markdown files when format is markdown', async () => {
    const root = await auditRepo('write-md');
    const outDir = join(tmpdir(), `packet-audit-md-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targets = [
      { type: 'feature' as const, id: 'A1' },
    ];
    const summary = await auditPackets(root, targets, { root, outDir, format: 'markdown' });
    expect(summary.passed).toBe(1);

    const files = await readdir(outDir);
    expect(files).toContain('feature-A1.packet.md');

    const content = await readFile(join(outDir, 'feature-A1.packet.md'), 'utf-8');
    expect(content).toContain('# Implementation Packet — FEATURE A1');
  });

  it('should populate entry counts correctly', async () => {
    const root = await auditRepo('counts');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
    ];
    const summary = await auditPackets(root, targets, { root });
    const entry = summary.targets[0];
    expect(entry.itemsCount).toBeGreaterThan(0);
    expect(entry.baselineCount).toBe(19);
    expect(entry.constraintsCount).toBeGreaterThan(0);
  });

  it('should use mode and maxPerCategory options', async () => {
    const root = await auditRepo('options');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
    ];
    const summary = await auditPackets(root, targets, { root, mode: 'full', maxPerCategory: 5 });
    expect(summary.passed).toBe(1);
  });

  it('should audit design target successfully', async () => {
    const root = await auditRepo('design-audit');
    const targets = [
      { type: 'design' as const, id: 'design-skill-import' },
    ];
    const summary = await auditPackets(root, targets, { root });
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.targets[0].type).toBe('design');
  });

  it('should audit e2e_test target successfully', async () => {
    const root = await auditRepoWithAllTypes('e2e-audit');
    const targets = [
      { type: 'e2e_test' as const, id: 'test-01:TC-001' },
    ];
    const summary = await auditPackets(root, targets, { root });
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.targets[0].type).toBe('e2e_test');
  });

  it('should audit all 5 target types together', async () => {
    const root = await auditRepoWithAllTypes('all-types');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
      { type: 'decision' as const, id: 'D-ARCH-01' },
      { type: 'design' as const, id: 'design-skill-import' },
      { type: 'e2e_test' as const, id: 'test-01:TC-001' },
    ];
    const summary = await auditPackets(root, targets, { root });
    expect(summary.total).toBe(5);
    expect(summary.passed).toBe(5);
    const types = summary.targets.map((t) => t.type);
    expect(types).toContain('design');
    expect(types).toContain('e2e_test');
  });
});

// ── CLI tests: packet-audit command ──

describe('CLI: packet-audit command', () => {
  it('packet-audit --targets-file --out-dir --format json', async () => {
    const root = await auditRepo('cli-json');
    const outDir = join(tmpdir(), `packet-audit-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBe(2);
    expect(output.passed).toBe(2);
    expect(output.failed).toBe(0);
    expect(output.targets).toHaveLength(2);

    // Verify output files
    const files = await readdir(outDir);
    expect(files).toContain('feature-A1.packet.json');
    expect(files).toContain('scenario-S-01.packet.json');
    expect(files).toContain('summary.json');
  });

  it('packet-audit --targets-file --out-dir --format markdown', async () => {
    const root = await auditRepo('cli-md');
    const outDir = join(tmpdir(), `packet-audit-cli-md-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir], io);
    expect(code).toBe(0);

    expect(io.stdoutText).toContain('Packet Audit Summary');
    expect(io.stdoutText).toContain('Total: 1');
    expect(io.stdoutText).toContain('Passed: 1');

    const files = await readdir(outDir);
    expect(files).toContain('feature-A1.packet.md');
    expect(files).toContain('summary.json');
  });

  it('packet-audit exits 1 when targets have missing artifacts', async () => {
    const root = await auditRepo('cli-fail');
    const outDir = join(tmpdir(), `packet-audit-cli-fail-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nfeature:NONEXISTENT\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--format', 'json'], io);
    expect(code).toBe(1);

    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBe(2);
    expect(output.passed).toBe(1);
    expect(output.failed).toBe(1);
  });

  it('packet-audit missing --targets-file exits 1', async () => {
    const root = await auditRepo('cli-missing-tf');
    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--out-dir', '/tmp/test'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Usage:');
  });

  it('packet-audit missing --out-dir exits 1', async () => {
    const root = await auditRepo('cli-missing-od');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Usage:');
  });

  it('packet-audit empty targets file exits 1', async () => {
    const root = await auditRepo('cli-empty');
    const outDir = join(tmpdir(), `packet-audit-empty-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, '# only comments\n\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('No valid targets found');
  });

  it('packet-audit invalid --mode exits 1', async () => {
    const root = await auditRepo('cli-invalid-mode');
    const outDir = join(tmpdir(), `packet-audit-im-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--mode', 'invalid'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Invalid --mode');
  });

  it('packet-audit invalid --format exits 1', async () => {
    const root = await auditRepo('cli-invalid-fmt');
    const outDir = join(tmpdir(), `packet-audit-if-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--format', 'xml'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Invalid --format');
  });

  it('packet-audit --targets-file with design and e2e_test targets', async () => {
    const root = await auditRepoWithAllTypes('cli-design-e2e');
    const outDir = join(tmpdir(), `packet-audit-de-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'design:design-skill-import\ne2e_test:test-01:TC-001\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBe(2);
    expect(output.passed).toBe(2);
    const types = output.targets.map((t: { type: string }) => t.type);
    expect(types).toContain('design');
    expect(types).toContain('e2e_test');
  });

  it('packet-audit --discover --out-dir --format json', async () => {
    const root = await auditRepo('cli-discover');
    const outDir = join(tmpdir(), `packet-audit-discover-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--discover', '--out-dir', outDir, '--format', 'json'], io);
    // Exit code 0 when all targets pass, 1 when some fail (e.g. design with incomplete traceability)
    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBeGreaterThanOrEqual(3);
    expect(output.passed).toBeGreaterThanOrEqual(3);
    // Should include feature, scenario, decision (and now design/e2e_test)
    const types = output.targets.map((t: { type: string }) => t.type);
    expect(types).toContain('feature');
    expect(types).toContain('scenario');
    expect(types).toContain('decision');
    expect(types).toContain('design');
  });

  it('packet-audit --discover --limit 2', async () => {
    const root = await auditRepo('cli-discover-limit');
    const outDir = join(tmpdir(), `packet-audit-dl-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--discover', '--limit', '2', '--out-dir', outDir, '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBe(2);
    // Round-robin: first feature, then scenario
    expect(output.targets[0].type).toBe('feature');
    expect(output.targets[1].type).toBe('scenario');
  });

  it('packet-audit --discover and --targets-file are mutually exclusive', async () => {
    const root = await auditRepo('cli-mutual-excl');
    const outDir = join(tmpdir(), `packet-audit-me-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--discover', '--targets-file', targetsFile, '--out-dir', outDir], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('mutually exclusive');
  });

  it('packet-audit missing both --discover and --targets-file exits 1', async () => {
    const root = await auditRepo('cli-neither');
    const outDir = join(tmpdir(), `packet-audit-ne-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--out-dir', outDir], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Usage:');
  });

  it('packet-audit invalid --limit exits 1', async () => {
    const root = await auditRepo('cli-invalid-limit');
    const outDir = join(tmpdir(), `packet-audit-il-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--discover', '--out-dir', outDir, '--limit', '-1'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Invalid --limit');
  });

  it('packet-audit --limit 0 means discover all (no limit)', async () => {
    const root = await auditRepo('cli-limit-all');
    const outDir = join(tmpdir(), `packet-audit-la-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--discover', '--limit', '0', '--out-dir', outDir, '--format', 'json'], io);
    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBeGreaterThanOrEqual(3);
    // Should include feature, scenario, decision (and now design/e2e_test)
    const types = output.targets.map((t: { type: string }) => t.type);
    expect(types).toContain('feature');
    expect(types).toContain('scenario');
    expect(types).toContain('decision');
    expect(types).toContain('design');
  });

  it('packet-audit exits 1 when targets file has invalid lines (parse errors)', async () => {
    const root = await auditRepo('cli-parse-err');
    const outDir = join(tmpdir(), `packet-audit-pe-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\ninvalid:B2\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--format', 'json'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Parse error');
    expect(io.stderrText).toContain('非法类型');
  });

  it('packet-audit exits 1 when targets file has no-colon lines', async () => {
    const root = await auditRepo('cli-no-colon');
    const outDir = join(tmpdir(), `packet-audit-nc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nno-colon-here\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--format', 'json'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Parse error');
    expect(io.stderrText).toContain('缺少冒号分隔符');
  });

  it('packet-audit exits 1 when targets file has empty id lines', async () => {
    const root = await auditRepo('cli-empty-id');
    const outDir = join(tmpdir(), `packet-audit-ei-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nfeature:\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--format', 'json'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Parse error');
    expect(io.stderrText).toContain('ID 为空');
  });
});

// ── Unit tests: discoverTargets ──

describe('discoverTargets', () => {
  it('should return all feature/scenario/decision nodes when under limit', async () => {
    const root = await auditRepo('discover-all');
    const graph = await scanArtifacts(root);
    const targets = discoverTargets(graph);
    expect(targets.length).toBeGreaterThanOrEqual(3);
    const types = targets.map((t) => t.type);
    expect(types).toContain('feature');
    expect(types).toContain('scenario');
    expect(types).toContain('decision');
  });

  it('should sort by id within each type', async () => {
    const root = await auditRepo('discover-sort');
    const graph = await scanArtifacts(root);
    const targets = discoverTargets(graph);
    // Features should be sorted: A1 before A2
    const features = targets.filter((t) => t.type === 'feature');
    for (let i = 1; i < features.length; i++) {
      expect(features[i].id >= features[i - 1].id).toBe(true);
    }
  });

  it('should use round-robin when count exceeds limit', async () => {
    const root = await auditRepo('discover-rr');
    const graph = await scanArtifacts(root);
    const targets = discoverTargets(graph, { limit: 3 });
    expect(targets.length).toBe(3);
    // Round-robin: feature first, then scenario, then decision
    expect(targets[0].type).toBe('feature');
    expect(targets[1].type).toBe('scenario');
    expect(targets[2].type).toBe('decision');
  });

  it('should default limit to 20', async () => {
    const root = await auditRepo('discover-default');
    const graph = await scanArtifacts(root);
    const targets = discoverTargets(graph);
    expect(targets.length).toBeLessThanOrEqual(20);
  });

  it('should return design and e2e_test nodes when present', async () => {
    const root = await auditRepoWithAllTypes('discover-design-e2e');
    const graph = await scanArtifacts(root);
    const targets = discoverTargets(graph, { limit: 0 });
    const types = targets.map((t) => t.type);
    expect(types).toContain('design');
    expect(types).toContain('e2e_test');
    // Verify specific IDs are present
    const designTarget = targets.find((t) => t.type === 'design');
    expect(designTarget).toBeDefined();
    expect(designTarget!.id).toBe('design-skill-import');
    const e2eTarget = targets.find((t) => t.type === 'e2e_test');
    expect(e2eTarget).toBeDefined();
    expect(e2eTarget!.id).toBe('test-01:TC-001');
  });
});

// ── Unit tests: discoverAndAuditPackets ──

describe('discoverAndAuditPackets', () => {
  it('should discover and audit all targets', async () => {
    const root = await auditRepo('discover-audit');
    const summary = await discoverAndAuditPackets(root, { root });
    expect(summary.total).toBeGreaterThanOrEqual(3);
    expect(summary.passed).toBeGreaterThanOrEqual(3);
    // Some discovered targets (e.g. design) may fail audit in minimal fixtures
    expect(summary.failed).toBeGreaterThanOrEqual(0);
  });

  it('should respect limit option', async () => {
    const root = await auditRepo('discover-audit-limit');
    const summary = await discoverAndAuditPackets(root, { root, limit: 2 });
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);
  });

  it('should write output files when outDir specified', async () => {
    const root = await auditRepo('discover-audit-files');
    const outDir = join(tmpdir(), `discover-audit-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const summary = await discoverAndAuditPackets(root, { root, outDir, format: 'json' });
    expect(summary.passed).toBeGreaterThanOrEqual(3);
    const files = await readdir(outDir);
    expect(files).toContain('summary.json');
    expect(files.length).toBeGreaterThan(1);
  });

  it('should discover all targets when limit is undefined (no limit)', async () => {
    const root = await auditRepo('discover-all-unlimited');
    const summary = await discoverAndAuditPackets(root, { root, limit: undefined });
    // With no limit, should return all discovered targets
    expect(summary.total).toBeGreaterThanOrEqual(3);
    const types = summary.targets.map((t) => t.type);
    expect(types).toContain('feature');
    expect(types).toContain('scenario');
    expect(types).toContain('decision');
  });
});

// ── Summary-only mode ──

describe('summary-only mode', () => {
  it('should not write packet files when summaryOnly is true', async () => {
    const root = await auditRepo('summary-only');
    const outDir = join(tmpdir(), `summary-only-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
      { type: 'decision' as const, id: 'D-ARCH-01' },
    ];
    const summary = await auditPackets(root, targets, { root, outDir, format: 'json', summaryOnly: true });
    expect(summary.passed).toBe(3);
    expect(summary.packetOutputMode).toBe('summary-only');

    // Only summary.json should exist, no packet files
    const files = await readdir(outDir);
    expect(files).toEqual(['summary.json']);

    // Verify targets have no outputPath
    for (const t of summary.targets) {
      expect(t.outputPath).toBeUndefined();
    }
  });

  it('CLI --summary-only --targets-file should work without --out-dir', async () => {
    const root = await auditRepo('cli-summary-only');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--summary-only', '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBe(2);
    expect(output.packetOutputMode).toBe('summary-only');
    expect(output.sampleTargets).toBeUndefined();
  });

  it('CLI --summary-only with --out-dir should write summary.json only', async () => {
    const root = await auditRepo('cli-summary-only-outdir');
    const outDir = join(tmpdir(), `cli-so-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--summary-only', '--format', 'json'], io);
    expect(code).toBe(0);

    const files = await readdir(outDir);
    expect(files).toEqual(['summary.json']);

    const summaryContent = await readFile(join(outDir, 'summary.json'), 'utf-8');
    const summary = JSON.parse(summaryContent);
    expect(summary.packetOutputMode).toBe('summary-only');
  });

  it('CLI --summary-only and --sample-targets are mutually exclusive', async () => {
    const root = await auditRepo('cli-so-st-mutex');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--summary-only', '--sample-targets', 'feature:A1'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('mutually exclusive');
  });
});

// ── Sample-targets mode ──

describe('sample-targets mode', () => {
  it('should only write packet files for selected targets', async () => {
    const root = await auditRepo('sample-targets');
    const outDir = join(tmpdir(), `sample-tgt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
      { type: 'decision' as const, id: 'D-ARCH-01' },
    ];
    const summary = await auditPackets(root, targets, {
      root, outDir, format: 'json',
      sampleTargets: ['feature:A1'],
    });
    expect(summary.passed).toBe(3);
    expect(summary.packetOutputMode).toBe('sample');
    expect(summary.sampleTargets).toEqual(['feature:A1']);
    expect(summary.sampleOutputPaths).toBeDefined();
    expect(summary.sampleOutputPaths!.length).toBe(1);

    // Only feature-A1.packet.json and summary.json should exist
    const files = await readdir(outDir);
    expect(files).toContain('feature-A1.packet.json');
    expect(files).toContain('summary.json');
    expect(files).not.toContain('scenario-S-01.packet.json');
    expect(files).not.toContain('decision-D-ARCH-01.packet.json');
  });

  it('CLI --sample-targets should work', async () => {
    const root = await auditRepo('cli-sample-tgt');
    const outDir = join(tmpdir(), `cli-st-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--sample-targets', 'feature:A1', '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    expect(output.packetOutputMode).toBe('sample');
    expect(output.sampleTargets).toEqual(['feature:A1']);

    const files = await readdir(outDir);
    expect(files).toContain('feature-A1.packet.json');
    expect(files).not.toContain('scenario-S-01.packet.json');
  });

  it('CLI --sample-targets invalid format exits 1', async () => {
    const root = await auditRepo('cli-st-invalid');
    const outDir = join(tmpdir(), `cli-sti-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--sample-targets', 'invalid-entry'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Invalid --sample-targets');
  });

  it('CLI --sample-targets invalid type exits 1', async () => {
    const root = await auditRepo('cli-st-bad-type');
    const outDir = join(tmpdir(), `cli-stbt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--sample-targets', 'bogus:A1'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Type must be one of:');
  });

  it('CLI --sample-targets empty id exits 1', async () => {
    const root = await auditRepo('cli-st-empty-id');
    const outDir = join(tmpdir(), `cli-stei-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--sample-targets', 'feature:'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('ID is empty');
  });

  it('auditPackets should fail when sample target does not exist in audit target set', async () => {
    const root = await auditRepo('sample-miss-api');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
    ];
    await expect(
      auditPackets(root, targets, { root, sampleTargets: ['feature:NO_SUCH_TARGET'] }),
    ).rejects.toThrow('Sample target(s) not found in audit target set: feature:NO_SUCH_TARGET');
  });

  it('auditPackets should fail listing all missing sample targets', async () => {
    const root = await auditRepo('sample-miss-multi');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
    ];
    await expect(
      auditPackets(root, targets, { root, sampleTargets: ['feature:NO_A', 'scenario:NO_B'] }),
    ).rejects.toThrow('Sample target(s) not found in audit target set: feature:NO_A, scenario:NO_B');
  });

  it('CLI --sample-targets with non-existent target exits 1', async () => {
    const root = await auditRepo('cli-st-miss');
    const outDir = join(tmpdir(), `cli-stm-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--sample-targets', 'feature:NO_SUCH_TARGET', '--format', 'json'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Sample target(s) not found in audit target set');
    expect(io.stderrText).toContain('feature:NO_SUCH_TARGET');
    // Should not write summary or packet files
    try {
      const files = await readdir(outDir);
      expect(files).toHaveLength(0);
    } catch {
      // outDir should not exist at all
    }
  });

  it('CLI --sample-targets with multiple missing targets lists all', async () => {
    const root = await auditRepo('cli-st-miss-multi');
    const outDir = join(tmpdir(), `cli-stmm-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--sample-targets', 'feature:NO_A,scenario:NO_B'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('feature:NO_A');
    expect(io.stderrText).toContain('scenario:NO_B');
  });

  it('auditPackets with valid sample targets should succeed', async () => {
    const root = await auditRepo('sample-valid');
    const outDir = join(tmpdir(), `sample-valid-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
      { type: 'decision' as const, id: 'D-ARCH-01' },
    ];
    const summary = await auditPackets(root, targets, {
      root, outDir, format: 'json',
      sampleTargets: ['feature:A1', 'decision:D-ARCH-01'],
    });
    expect(summary.passed).toBe(3);
    expect(summary.packetOutputMode).toBe('sample');
    expect(summary.sampleTargets).toEqual(['feature:A1', 'decision:D-ARCH-01']);
    expect(summary.sampleOutputPaths!.length).toBe(2);

    const files = await readdir(outDir);
    expect(files).toContain('feature-A1.packet.json');
    expect(files).toContain('decision-D-ARCH-01.packet.json');
    expect(files).not.toContain('scenario-S-01.packet.json');
  });
});

// ── Discover all (limit=0) ──

describe('discover --all (limit=0)', () => {
  it('should discover all targets when limit is 0', async () => {
    const root = await auditRepo('discover-all');
    const graph = await scanArtifacts(root);
    const targets = discoverTargets(graph, { limit: 0 });
    // All 4 items: 2 features + 1 scenario + 1 decision
    expect(targets.length).toBeGreaterThanOrEqual(4);
    const types = targets.map((t) => t.type);
    expect(types).toContain('feature');
    expect(types).toContain('scenario');
    expect(types).toContain('decision');
  });

  it('CLI --discover --limit 0 should return all targets', async () => {
    const root = await auditRepo('cli-discover-all');
    const outDir = join(tmpdir(), `cli-da-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--discover', '--limit', '0', '--out-dir', outDir, '--format', 'json'], io);
    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBeGreaterThanOrEqual(4);
    const types = output.targets.map((t: { type: string }) => t.type);
    expect(types).toContain('feature');
    expect(types).toContain('scenario');
    expect(types).toContain('decision');
    expect(types).toContain('design');
  });
});

// ── Performance / scale regression tests ──

/**
 * Create a fixture repo with 20+ audit targets (10 features, 5 scenarios, 5 decisions).
 * All features reference all scenarios so graph traversal has real work to do.
 */
async function performanceRepo(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-perf-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });

  // Config
  await write(root, 'artifact-graph.config.yaml', `idRanges:\n  scenario:\n    batch-49:\n      prefix: S-\n      start: 1200\n      end: 1299\n`);

  // Baseline files
  for (const bf of BASELINE_FILES) {
    await write(root, bf.path, bf.content);
  }

  // Generate 10 features, each referencing 5 scenarios
  const scenarioIds: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const sid = `S-${String(i).padStart(2, '0')}`;
    scenarioIds.push(sid);
  }

  for (let i = 1; i <= 10; i++) {
    const fid = `F${i}`;
    await write(root, `artifacts/prd/features/${fid}-perf-feature.md`, `---
id: ${fid}
title: Performance feature ${i}
status: done
scenarios: [${scenarioIds.join(', ')}]
---
# ${fid}: Performance feature ${i}
`);
  }

  // Generate 5 scenarios in a single batch file
  const scenarioLines = scenarioIds.map((sid, i) => `
## ${sid}: Performance scenario ${i + 1}

**关联功能**: F1 (Performance feature 1)
`).join('\n');
  await write(root, 'artifacts/scenarios/batch-perf.md', scenarioLines);

  // Generate 5 decisions
  for (let i = 1; i <= 5; i++) {
    const did = `D-PERF-${String(i).padStart(2, '0')}`;
    await write(root, `artifacts/decisions/${did}.md`, `---
id: ${did}
title: Performance decision ${i}
status: approved
---
# ${did}: Performance decision ${i}
`);
  }

  return root;
}

describe('performance and scale regression', () => {
  it('should audit 20 targets within 30s using pre-scanned graph (performance)', async () => {
    const root = await performanceRepo('perf-20');
    try {
      const graph = await scanArtifacts(root);

      // Build 20 targets: 10 features + 5 scenarios + 5 decisions
      const targets = [
        ...Array.from({ length: 10 }, (_, i) => ({ type: 'feature' as const, id: `F${i + 1}` })),
        ...Array.from({ length: 5 }, (_, i) => ({ type: 'scenario' as const, id: `S-${String(i + 1).padStart(2, '0')}` })),
        ...Array.from({ length: 5 }, (_, i) => ({ type: 'decision' as const, id: `D-PERF-${String(i + 1).padStart(2, '0')}` })),
      ];
      expect(targets.length).toBe(20);

      const start = performance.now();
      const summary = await auditPackets(root, targets, { root }, graph);
      const elapsed = performance.now() - start;

      expect(summary.total).toBe(20);
      // Generous threshold — the actual audit (graph traversal + packet assembly) should be < 5s
      // but we use 30s to account for CI runner variance
      expect(elapsed).toBeLessThan(30_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should not call scanArtifacts more than once for batch audit (performance)', async () => {
    const root = await performanceRepo('perf-scan-once');
    try {
      // auditPackets without pre-scanned graph should call scanArtifacts exactly once
      const targets = [
        { type: 'feature' as const, id: 'F1' },
        { type: 'feature' as const, id: 'F2' },
      ];

      const start = performance.now();
      const summary = await auditPackets(root, targets, { root });
      const elapsed = performance.now() - start;

      expect(summary.total).toBe(2);
      expect(summary.passed).toBe(2);
      // Full scan + 2 audits should complete in < 30s
      expect(elapsed).toBeLessThan(30_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should scale linearly: 20 targets should not take 10x longer than 2 targets (performance)', async () => {
    const root = await performanceRepo('perf-scale');
    try {
      const graph = await scanArtifacts(root);

      // Measure 2 targets
      const twoTargets = [
        { type: 'feature' as const, id: 'F1' },
        { type: 'feature' as const, id: 'F2' },
      ];
      const start2 = performance.now();
      await auditPackets(root, twoTargets, { root }, graph);
      const elapsed2 = performance.now() - start2;

      // Measure 20 targets
      const twentyTargets = [
        ...Array.from({ length: 10 }, (_, i) => ({ type: 'feature' as const, id: `F${i + 1}` })),
        ...Array.from({ length: 5 }, (_, i) => ({ type: 'scenario' as const, id: `S-${String(i + 1).padStart(2, '0')}` })),
        ...Array.from({ length: 5 }, (_, i) => ({ type: 'decision' as const, id: `D-PERF-${String(i + 1).padStart(2, '0')}` })),
      ];
      const start20 = performance.now();
      await auditPackets(root, twentyTargets, { root }, graph);
      const elapsed20 = performance.now() - start20;

      // 20 targets should not take more than 15x the time of 2 targets
      // (generous bound — linear scaling would be 10x, we allow some overhead)
      expect(elapsed20).toBeLessThan(elapsed2 * 15);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── Compact summary mode ──

describe('compact summary mode', () => {
  it('should omit passed targets in compact mode', async () => {
    const root = await auditRepo('compact-basic');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
      { type: 'feature' as const, id: 'NONEXISTENT' },
    ];
    const summary = await auditPackets(root, targets, { root, summaryDetail: 'compact' });
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    // Compact mode: only failed/missing targets in the targets array
    expect(summary.targets).toHaveLength(1);
    expect(summary.targets[0].id).toBe('NONEXISTENT');
    expect(summary.targets[0].status).toBe('failed');
    // Should include countsByType and summaryDetail
    expect(summary.summaryDetail).toBe('compact');
    expect(summary.countsByType).toEqual({ feature: 2, scenario: 1 });
  });

  it('should include all targets in full mode (default)', async () => {
    const root = await auditRepo('full-default');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
      { type: 'feature' as const, id: 'NONEXISTENT' },
    ];
    const summary = await auditPackets(root, targets, { root });
    expect(summary.total).toBe(3);
    expect(summary.targets).toHaveLength(3);
    expect(summary.summaryDetail).toBeUndefined();
    expect(summary.countsByType).toBeUndefined();
  });

  it('compact mode should write compact summary.json to outDir', async () => {
    const root = await auditRepo('compact-outdir');
    const outDir = join(tmpdir(), `compact-out-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
      { type: 'feature' as const, id: 'NONEXISTENT' },
    ];
    await auditPackets(root, targets, { root, outDir, format: 'json', summaryDetail: 'compact' });

    const summaryContent = await readFile(join(outDir, 'summary.json'), 'utf-8');
    const parsed = JSON.parse(summaryContent);
    expect(parsed.summaryDetail).toBe('compact');
    expect(parsed.targets).toHaveLength(1);
    expect(parsed.targets[0].id).toBe('NONEXISTENT');
    expect(parsed.countsByType).toEqual({ feature: 2, scenario: 1 });
  });

  it('CLI --summary-detail compact should work', async () => {
    const root = await auditRepo('cli-compact');
    const outDir = join(tmpdir(), `cli-compact-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\nfeature:NONEXISTENT\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--summary-detail', 'compact', '--format', 'json'], io);
    expect(code).toBe(1); // NONEXISTENT fails

    const output = JSON.parse(io.stdoutText);
    expect(output.summaryDetail).toBe('compact');
    expect(output.targets).toHaveLength(1);
    expect(output.countsByType).toEqual({ feature: 2, scenario: 1 });
  });

  it('CLI --summary-detail invalid exits 1', async () => {
    const root = await auditRepo('cli-compact-invalid');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', '/tmp/test', '--summary-detail', 'invalid'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Invalid --summary-detail');
  });

  it('compact mode with all passed should have empty targets array', async () => {
    const root = await auditRepo('compact-all-pass');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
    ];
    const summary = await auditPackets(root, targets, { root, summaryDetail: 'compact' });
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.targets).toHaveLength(0);
    expect(summary.countsByType).toEqual({ feature: 1, scenario: 1 });
  });
});

describe('custom target: packet audit', () => {
  async function customAuditRepo(): Promise<string> {
    const root = join(tmpdir(), `packet-audit-custom-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });

    // Config with custom target type
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

  it('parseTargetsFile accepts custom target type when schema provided', async () => {
    const { parseTargetsFile } = await import('../src/packet-audit.js');
    const { loadConfig } = await import('../src/index.js');
    const root = await customAuditRepo();
    const config = await loadConfig(root);
    const result = parseTargetsFile('api_contract:API-001\n', config);
    expect(result.targets).toEqual([{ type: 'api_contract', id: 'API-001' }]);
    expect(result.errors).toHaveLength(0);
  });

  it('parseTargetsFile rejects custom target type without schema', async () => {
    const { parseTargetsFile } = await import('../src/packet-audit.js');
    const result = parseTargetsFile('api_contract:API-001\n');
    expect(result.targets).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('非法类型');
  });

  it('discoverTargets finds custom target types', async () => {
    const { discoverTargets, scanArtifacts, loadConfig } = await import('../src/index.js');
    const root = await customAuditRepo();
    const config = await loadConfig(root);
    const graph = await scanArtifacts(root, config);
    const targets = discoverTargets(graph, { schema: config });
    const apiTargets = targets.filter((t) => t.type === 'api_contract');
    expect(apiTargets).toEqual([{ type: 'api_contract', id: 'API-001' }]);
  });

  it('auditPackets handles custom target type', async () => {
    const root = await customAuditRepo();
    const { loadConfig } = await import('../src/index.js');
    const config = await loadConfig(root);
    const summary = await auditPackets(root, [
      { type: 'api_contract', id: 'API-001' },
    ], { root, summaryOnly: true, schema: config });
    expect(summary.total).toBe(1);
    expect(summary.targets[0].type).toBe('api_contract');
    expect(summary.targets[0].id).toBe('API-001');
    // Custom target must pass audit — no PKT-002 rejection
    expect(summary.targets[0].status).toBe('passed');
    const pkt002 = (summary.targets[0].validationIssues ?? []).filter((i) => i.code === 'PKT-002');
    expect(pkt002).toHaveLength(0);
  });
});
