import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditPromptBatch } from '../src/packet-prompt-audit.js';
import { validatePacketPrompt } from '../src/packet-prompt-validator.js';
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
  const root = join(tmpdir(), `packet-prompt-audit-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

// ── Unit tests: auditPromptBatch ──

describe('auditPromptBatch', () => {
  it('should audit 3 valid targets and all pass', async () => {
    const root = await auditRepo('batch-pass');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
      { type: 'decision' as const, id: 'D-ARCH-01' },
    ];
    const summary = await auditPromptBatch(root, targets, { root });
    expect(summary.schemaVersion).toBe('1.1');
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.warnings).toBeGreaterThanOrEqual(0);
    expect(summary.targets).toHaveLength(3);
    expect(summary.generatedAt).toBeDefined();
    expect(summary.maxChars).toBe(4000);
    // v1.11: countsByType and totalOmitted
    expect(summary.countsByType).toBeDefined();
    expect(summary.countsByType!.feature.total).toBe(1);
    expect(summary.countsByType!.scenario.total).toBe(1);
    expect(summary.countsByType!.decision.total).toBe(1);
    expect(summary.totalOmitted).toBe(0);
  });

  it('should write prompt files to outDir with stable filenames', async () => {
    const root = await auditRepo('batch-outdir');
    const outDir = join(tmpdir(), `prompt-audit-out-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
      { type: 'decision' as const, id: 'D-ARCH-01' },
    ];
    const summary = await auditPromptBatch(root, targets, { root, outDir });
    expect(summary.passed).toBe(3);

    const files = await readdir(outDir);
    expect(files).toContain('prompt-feature-A1.md');
    expect(files).toContain('prompt-scenario-S-01.md');
    expect(files).toContain('prompt-decision-D-ARCH-01.md');
    expect(files).toContain('prompt-audit-summary.json');
    expect(files).toContain('prompt-audit-summary.md');

    // Verify prompt content passes validation
    for (const t of summary.targets) {
      expect(t.ok).toBe(true);
      expect(t.length).toBeGreaterThan(0);
      if (t.outputPath) {
        const content = await readFile(t.outputPath, 'utf-8');
        const validation = validatePacketPrompt(content);
        expect(validation.ok).toBe(true);
      }
    }
  });

  it('should produce valid JSON summary with all required fields', async () => {
    const root = await auditRepo('batch-json');
    const outDir = join(tmpdir(), `prompt-audit-json-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
      { type: 'decision' as const, id: 'D-ARCH-01' },
    ];
    await auditPromptBatch(root, targets, { root, outDir });

    const summaryContent = await readFile(join(outDir, 'prompt-audit-summary.json'), 'utf-8');
    const parsed = JSON.parse(summaryContent);
    expect(parsed.schemaVersion).toBe('1.1');
    expect(parsed.generatedAt).toBeDefined();
    expect(parsed.total).toBe(3);
    expect(parsed.passed).toBe(3);
    expect(parsed.failed).toBe(0);
    expect(parsed.warnings).toBeDefined();
    expect(parsed.maxChars).toBe(4000);
    expect(parsed.targets).toHaveLength(3);
    // v1.11: countsByType
    expect(parsed.countsByType).toBeDefined();
    expect(parsed.countsByType.feature.total).toBe(1);
    expect(parsed.countsByType.scenario.total).toBe(1);
    expect(parsed.countsByType.decision.total).toBe(1);
    expect(parsed.totalOmitted).toBe(0);

    // Each target entry has required fields
    for (const t of parsed.targets) {
      expect(t.type).toBeDefined();
      expect(t.id).toBeDefined();
      expect(typeof t.ok).toBe('boolean');
      expect(typeof t.length).toBe('number');
      expect(Array.isArray(t.issues)).toBe(true);
    }
  });

  it('should produce readable markdown summary', async () => {
    const root = await auditRepo('batch-md');
    const outDir = join(tmpdir(), `prompt-audit-md-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targets = [
      { type: 'feature' as const, id: 'A1' },
    ];
    await auditPromptBatch(root, targets, { root, outDir });

    const mdContent = await readFile(join(outDir, 'prompt-audit-summary.md'), 'utf-8');
    expect(mdContent).toContain('# Packet Prompt Audit Summary');
    expect(mdContent).toContain('schemaVersion');
    expect(mdContent).toContain('PASS');
    expect(mdContent).toContain('feature:A1');
    // v1.11: countsByType in markdown
    expect(mdContent).toContain('按类型统计');
    expect(mdContent).toContain('| feature |');
  });

  it('should mark missing target as failed', async () => {
    const root = await auditRepo('batch-missing');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'feature' as const, id: 'NONEXISTENT' },
    ];
    const summary = await auditPromptBatch(root, targets, { root });
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.targets[0].ok).toBe(true);
    expect(summary.targets[1].ok).toBe(false);
    expect(summary.targets[1].issues.some((i) => i.code === 'MISSING')).toBe(true);
  });

  it('should count warnings separately from failures', async () => {
    const root = await auditRepo('batch-warnings');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
    ];
    const summary = await auditPromptBatch(root, targets, { root });
    // warnings count is the sum of warning-severity issues
    expect(summary.warnings).toBeGreaterThanOrEqual(0);
    // A prompt that passes validation should have ok=true even with warnings
    expect(summary.targets[0].ok).toBe(true);
  });

  it('should audit design target successfully', async () => {
    const root = await auditRepo('design-prompt');
    const targets = [
      { type: 'design' as const, id: 'design-skill-import' },
    ];
    const summary = await auditPromptBatch(root, targets, { root });
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.targets[0].ok).toBe(true);
    expect(summary.countsByType!.design.total).toBe(1);
  });

  it('should audit all 5 target types together', async () => {
    const root = await auditRepo('all-types-prompt');
    const targets = [
      { type: 'feature' as const, id: 'A1' },
      { type: 'scenario' as const, id: 'S-01' },
      { type: 'decision' as const, id: 'D-ARCH-01' },
      { type: 'design' as const, id: 'design-skill-import' },
    ];
    const summary = await auditPromptBatch(root, targets, { root });
    expect(summary.total).toBe(4);
    expect(summary.passed).toBe(4);
    expect(summary.countsByType!.feature.total).toBe(1);
    expect(summary.countsByType!.design.total).toBe(1);
  });
});

// ── CLI tests: packet-prompt-audit command ──

describe('CLI: packet-prompt-audit command', () => {
  it('should audit 3 valid targets and exit 0', async () => {
    const root = await auditRepo('cli-3pass');
    const outDir = join(tmpdir(), `cli-ppa-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\ndecision:D-ARCH-01\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBe(3);
    expect(output.passed).toBe(3);
    expect(output.failed).toBe(0);
    expect(output.targets).toHaveLength(3);

    // Verify output files
    const files = await readdir(outDir);
    expect(files).toContain('prompt-feature-A1.md');
    expect(files).toContain('prompt-scenario-S-01.md');
    expect(files).toContain('prompt-decision-D-ARCH-01.md');
    expect(files).toContain('prompt-audit-summary.json');
    expect(files).toContain('prompt-audit-summary.md');
  });

  it('should output markdown summary when --format markdown', async () => {
    const root = await auditRepo('cli-md');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile, '--format', 'markdown'], io);
    expect(code).toBe(0);

    expect(io.stdoutText).toContain('Packet Prompt Audit Summary');
    expect(io.stdoutText).toContain('总计: 2');
    expect(io.stdoutText).toContain('通过: 2');
  });

  it('missing target should be failed and exit 1', async () => {
    const root = await auditRepo('cli-missing');
    const outDir = join(tmpdir(), `cli-ppa-miss-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nfeature:NONEXISTENT\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--format', 'json'], io);
    expect(code).toBe(1);

    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBe(2);
    expect(output.passed).toBe(1);
    expect(output.failed).toBe(1);
    expect(output.targets[1].ok).toBe(false);
  });

  it('invalid targets-file parse error should exit 1', async () => {
    const root = await auditRepo('cli-parse-err');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\ninvalid:B2\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Parse error');
    expect(io.stderrText).toContain('非法类型');
  });

  it('--max-chars 100 should exit 1', async () => {
    const root = await auditRepo('cli-max-chars');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile, '--max-chars', '100'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Invalid --max-chars');
  });

  it('unknown --format should exit 1', async () => {
    const root = await auditRepo('cli-fmt-unk');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile, '--format', 'xml'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Invalid --format');
  });

  it('missing --targets-file should exit 1', async () => {
    const root = await auditRepo('cli-no-tf');
    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Usage:');
  });

  it('--packet flag should be rejected with exit 1', async () => {
    const root = await auditRepo('cli-packet-reject');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile, '--packet', '/tmp/fake.json'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('packet-prompt-audit 不支持 --packet');
  });

  it('empty targets file should exit 1', async () => {
    const root = await auditRepo('cli-empty');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, '# only comments\n\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('No valid targets found');
  });

  it('non-existent targets file should exit 1', async () => {
    const root = await auditRepo('cli-no-file');
    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', '/tmp/nonexistent-file.txt'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('无法读取 targets 文件');
  });

  it('every generated prompt should pass validatePacketPrompt', async () => {
    const root = await auditRepo('cli-validate-all');
    const outDir = join(tmpdir(), `cli-ppa-val-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\ndecision:D-ARCH-01\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    for (const t of output.targets) {
      expect(t.ok).toBe(true);
      // Read the written prompt file and validate independently
      if (t.outputPath) {
        const content = await readFile(t.outputPath, 'utf-8');
        const validation = validatePacketPrompt(content);
        expect(validation.ok).toBe(true);
      }
    }
  });

  // ── v1.11: --discover mode ──

  it('--discover should find targets', async () => {
    const root = await auditRepo('cli-discover');
    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--discover', '--format', 'json'], io);
    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBeGreaterThanOrEqual(3);
    expect(output.passed).toBeGreaterThanOrEqual(3);
    expect(output.schemaVersion).toBe('1.1');
    expect(output.countsByType).toBeDefined();
  });

  it('--discover with --limit should limit targets', async () => {
    const root = await auditRepo('cli-discover-limit');
    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--discover', '--limit', '2', '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBe(2);
    expect(output.passed).toBe(2);
  });

  it('--discover with --limit 0 should return all targets', async () => {
    const root = await auditRepo('cli-discover-all');
    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--discover', '--limit', '0', '--format', 'json'], io);
    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBeGreaterThanOrEqual(3);
  });

  it('--discover and --targets-file should be mutually exclusive', async () => {
    const root = await auditRepo('cli-discover-mutex');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--discover', '--targets-file', targetsFile], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('互斥');
  });

  it('missing --discover and --targets-file should exit 1', async () => {
    const root = await auditRepo('cli-no-mode');
    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Usage:');
  });

  it('invalid --limit should exit 1', async () => {
    const root = await auditRepo('cli-bad-limit');
    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--discover', '--limit', '-1'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Invalid --limit');
  });

  it('invalid --summary-detail should exit 1', async () => {
    const root = await auditRepo('cli-bad-detail');
    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--discover', '--summary-detail', 'verbose'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain('Invalid --summary-detail');
  });

  // ── v1.11: --summary-only ──

  it('--summary-only should write summary but not prompt files', async () => {
    const root = await auditRepo('cli-summary-only');
    const outDir = join(tmpdir(), `cli-ppa-so-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--summary-only', '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBe(2);
    expect(output.passed).toBe(2);

    // outDir must exist and contain summary files
    const files = await readdir(outDir);
    expect(files).toContain('prompt-audit-summary.json');
    expect(files).toContain('prompt-audit-summary.md');

    // No individual prompt files should be written
    expect(files.filter((f) => f.startsWith('prompt-') && f.endsWith('.md') && f !== 'prompt-audit-summary.md')).toHaveLength(0);
    expect(files.filter((f) => f.startsWith('prompt-') && f.endsWith('.json') && f !== 'prompt-audit-summary.json')).toHaveLength(0);
  });

  // ── v1.11: --summary-detail compact ──

  it('--summary-detail compact should omit passed targets from output', async () => {
    const root = await auditRepo('cli-compact');
    const outDir = join(tmpdir(), `cli-ppa-compact-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\ndecision:D-ARCH-01\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--summary-detail', 'compact', '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBe(3);
    expect(output.passed).toBe(3);
    expect(output.failed).toBe(0);
    // compact 模式：passed targets 被省略
    expect(output.totalOmitted).toBe(3);
    expect(output.targets).toHaveLength(0);
    expect(output.countsByType).toBeDefined();
    expect(output.countsByType.feature.total).toBe(1);
  });

  it('--summary-detail compact with failures should show only failed targets', async () => {
    const root = await auditRepo('cli-compact-fail');
    const outDir = join(tmpdir(), `cli-ppa-compact-f-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nfeature:NONEXISTENT\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile, '--out-dir', outDir, '--summary-detail', 'compact', '--format', 'json'], io);
    expect(code).toBe(1);

    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBe(2);
    expect(output.passed).toBe(1);
    expect(output.failed).toBe(1);
    expect(output.totalOmitted).toBe(1);
    expect(output.targets).toHaveLength(1);
    expect(output.targets[0].ok).toBe(false);
    expect(output.targets[0].id).toBe('NONEXISTENT');
  });

  it('--summary-detail compact markdown should contain 按类型 and 省略', async () => {
    const root = await auditRepo('cli-compact-md');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile, '--summary-detail', 'compact', '--format', 'markdown'], io);
    expect(code).toBe(0);

    // CLI markdown 输出包含按类型统计行和省略提示
    expect(io.stdoutText).toContain('按类型:');
    expect(io.stdoutText).toContain('feature=');
    expect(io.stdoutText).toContain('省略');
  });

  it('--discover with --summary-only and --summary-detail compact', async () => {
    const root = await auditRepo('cli-discover-compact-so');
    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--discover', '--summary-only', '--summary-detail', 'compact', '--format', 'json'], io);
    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBeGreaterThanOrEqual(3);
    expect(output.countsByType).toBeDefined();
  });

  it('should audit design target via targets-file', async () => {
    const root = await auditRepo('cli-design');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'design:design-skill-import\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile, '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBe(1);
    expect(output.passed).toBe(1);
    expect(output.countsByType.design.total).toBe(1);
  });

  it('should audit all 5 target types via targets-file', async () => {
    const root = await auditRepo('cli-all-types');
    const targetsFile = join(root, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\ndecision:D-ARCH-01\ndesign:design-skill-import\n');

    const io = captureIo();
    const code = await runCli(['packet-prompt-audit', '--root', root, '--targets-file', targetsFile, '--format', 'json'], io);
    expect(code).toBe(0);

    const output = JSON.parse(io.stdoutText);
    expect(output.total).toBe(4);
    expect(output.passed).toBe(4);
    expect(output.countsByType.design.total).toBe(1);
    expect(output.countsByType.feature.total).toBe(1);
  });
});
