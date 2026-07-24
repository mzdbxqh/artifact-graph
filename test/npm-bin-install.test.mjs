#!/usr/bin/env node
// @scenario S-40 @feature ACA10
// @decision D-ACA-14
//
// Packed npm consumer test: verifies that artifact-graph installed from a
// local tarball (with lifecycle scripts enabled for better-sqlite3) passes
// a real smoke matrix through .bin, npx, and import().
//
// Build/pack/install happens once; all assertions reuse the same consumer dir.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function command(binary, args, options = {}) {
  try {
    const result = await execFileAsync(binary, args, { maxBuffer: 10 * 1024 * 1024, ...options });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function buildAndPack(testRoot) {
  console.log('Building artifact-graph...');
  const build = await command('pnpm', ['build'], { cwd: packageRoot });
  assert.equal(build.code, 0, `Build failed: ${build.stderr}`);

  console.log('Packing tarball...');
  const packDir = join(testRoot, 'pack');
  await mkdir(packDir, { recursive: true });
  const packed = await command('pnpm', ['pack', '--pack-destination', packDir], { cwd: packageRoot });
  assert.equal(packed.code, 0, `Pack failed: ${packed.stderr}`);
  const entries = await readdir(packDir);
  const tarball = entries.find((e) => e.endsWith('.tgz'));
  assert.ok(tarball, `No tarball found in ${packDir}`);
  return join(packDir, tarball);
}

async function installTarball(consumerDir, tarball) {
  console.log(`Installing tarball into ${consumerDir}...`);
  // Write a minimal package.json so npm install works
  await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
    name: 'npm-consumer-smoke',
    version: '1.0.0',
    private: true,
    type: 'module',
  }, null, 2) + '\n');

  // Install with lifecycle scripts enabled (no --ignore-scripts) for better-sqlite3 binding
  const install = await command('npm', [
    'install', '--no-audit', '--no-fund', '--no-package-lock', tarball,
  ], { cwd: consumerDir });
  assert.equal(install.code, 0, `npm install failed (exit ${install.code}): ${install.stderr}\nstdout: ${install.stdout}`);
  console.log('Tarball installed successfully.');
}

// --- Smoke matrix ---

async function smokeBinHelp(consumerDir) {
  const bin = join(consumerDir, 'node_modules/.bin/artifact-graph');
  const result = await command('node', [bin, '--help'], { cwd: consumerDir });
  assert.equal(result.code, 0, `--help exit ${result.code}: ${result.stderr}`);
  assert.match(result.stdout, /artifact-graph <command>/, 'missing usage header');
  assert.match(result.stdout, /version-lock/, 'missing version-lock in help');
  assert.match(result.stdout, /scan/, 'missing scan in help');
  assert.match(result.stdout, /validate/, 'missing validate in help');
  console.log('  .bin/artifact-graph --help: OK');
}

async function smokeNpxHelp(consumerDir) {
  const result = await command('npx', ['--no-install', 'artifact-graph', '--help'], { cwd: consumerDir });
  assert.equal(result.code, 0, `npx --help exit ${result.code}: ${result.stderr}`);
  assert.match(result.stdout, /artifact-graph <command>/, 'npx missing usage header');
  console.log('  npx --no-install artifact-graph --help: OK');
}

async function smokeInit(consumerDir) {
  const initDir = join(consumerDir, 'init-test');
  const result = await command('npx', ['--no-install', 'artifact-graph', 'init', '--root', initDir], { cwd: consumerDir });
  assert.equal(result.code, 0, `init exit ${result.code}: ${result.stderr}`);
  const configContent = await readFile(join(initDir, 'artifact-graph.config.yaml'), 'utf-8');
  assert.ok(configContent.length > 0, 'init did not create config');
  console.log('  init: OK');
}

async function smokeScan(consumerDir) {
  // scan on an empty dir is valid (0 artifacts)
  const scanDir = join(consumerDir, 'scan-test');
  await mkdir(scanDir, { recursive: true });
  await writeFile(join(scanDir, 'artifact-graph.config.yaml'), '');
  const result = await command('npx', ['--no-install', 'artifact-graph', 'scan', '--root', scanDir], { cwd: consumerDir });
  assert.equal(result.code, 0, `scan exit ${result.code}: ${result.stderr}`);
  console.log('  scan: OK');
}

async function smokeValidateJson(consumerDir) {
  const valDir = join(consumerDir, 'validate-test');
  await mkdir(valDir, { recursive: true });
  await writeFile(join(valDir, 'artifact-graph.config.yaml'), '');
  const result = await command('npx', ['--no-install', 'artifact-graph', 'validate', '--root', valDir, '--format', 'json'], { cwd: consumerDir });
  assert.equal(result.code, 0, `validate exit ${result.code}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed), 'validate --format json did not return array');
  console.log('  validate --format json: OK');
}

async function smokeDoctorJson(consumerDir) {
  const docDir = join(consumerDir, 'doctor-test');
  await mkdir(docDir, { recursive: true });
  await writeFile(join(docDir, 'artifact-graph.config.yaml'), '');
  const result = await command('npx', ['--no-install', 'artifact-graph', 'doctor', '--root', docDir, '--format', 'json'], { cwd: consumerDir });
  assert.equal(result.code, 0, `doctor exit ${result.code}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.cli !== undefined, 'doctor missing cli');
  assert.ok(parsed.config !== undefined, 'doctor missing config');
  assert.ok(parsed.lock !== undefined, 'doctor missing lock');
  assert.ok(parsed.supportedCommands !== undefined, 'doctor missing supportedCommands');
  console.log('  doctor --format json: OK');
}

async function smokeImport(consumerDir) {
  const result = await command('node', [
    '--input-type=module',
    '-e',
    `
    import { scanArtifacts, validateGraph, loadConfig, VERSION_LOCK_PATH } from 'artifact-graph';
    const apis = { scanArtifacts: typeof scanArtifacts, validateGraph: typeof validateGraph, loadConfig: typeof loadConfig, VERSION_LOCK_PATH: typeof VERSION_LOCK_PATH };
    console.log(JSON.stringify(apis));
    `,
  ], { cwd: consumerDir });
  assert.equal(result.code, 0, `import() exit ${result.code}: ${result.stderr}`);
  const apis = JSON.parse(result.stdout.trim());
  assert.equal(apis.scanArtifacts, 'function', 'scanArtifacts missing');
  assert.equal(apis.validateGraph, 'function', 'validateGraph missing');
  assert.equal(apis.loadConfig, 'function', 'loadConfig missing');
  assert.equal(apis.VERSION_LOCK_PATH, 'string', 'VERSION_LOCK_PATH missing');
  console.log('  import(): OK');
}

async function smokeSchemaSubpath(consumerDir) {
  const result = await command('node', [
    '--input-type=module',
    '-e',
    `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const schema = require('artifact-graph/schemas/review-result.schema.json');
    console.log(JSON.stringify({
      hasDollarId: typeof schema['$id'] === 'string',
      hasType: schema.type === 'object',
      hasSchemaVersion: Array.isArray(schema.required) && schema.required.includes('schema_version'),
      rejectsUnknownTopLevel: schema.additionalProperties === false,
      maxAttempt: schema.properties?.attempt?.maximum,
      hasAcceptance: schema.properties?.acceptance?.properties?.reviewer?.['$ref'] === '#/$defs/producer',
    }));
    `,
  ], { cwd: consumerDir });
  assert.equal(result.code, 0, `schema subpath import exit ${result.code}: ${result.stderr}`);
  const check = JSON.parse(result.stdout.trim());
  assert.equal(check.hasDollarId, true, 'schema missing $id');
  assert.equal(check.hasType, true, 'schema missing type=object');
  assert.equal(check.hasSchemaVersion, true, 'schema missing required schema_version');
  assert.equal(check.rejectsUnknownTopLevel, true, 'schema must reject unknown top-level fields');
  assert.equal(check.maxAttempt, 3, 'schema attempt maximum must be 3');
  assert.equal(check.hasAcceptance, true, 'schema missing independent acceptance identity');
  console.log('  schema subpath import: OK');
}

async function smokeContractList(consumerDir) {
  const result = await command('npx', ['--no-install', 'artifact-graph', 'contract', 'list', '--format', 'json'], { cwd: consumerDir });
  assert.equal(result.code, 0, `contract list exit ${result.code}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true, 'contract list envelope not ok');
  assert.ok(Array.isArray(parsed.data.contracts), 'contract list missing contracts array');
  assert.ok(parsed.data.contracts.length > 0, 'contract list has no contracts');
  console.log('  contract list --format json: OK');
}

async function smokeContractExplain(consumerDir) {
  const result = await command('npx', ['--no-install', 'artifact-graph', 'contract', 'explain', '--contract', 'artifact.e2e-test@1', '--format', 'json'], { cwd: consumerDir });
  assert.equal(result.code, 0, `contract explain exit ${result.code}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true, 'contract explain envelope not ok');
  assert.ok(parsed.data.identity !== undefined, 'contract explain missing identity');
  assert.ok(parsed.data.schema !== undefined, 'contract explain missing schema');
  assert.equal(parsed.data.identity.major, 'artifact.e2e-test@1', 'contract explain wrong major');
  console.log('  contract explain --format json: OK');
}

async function smokeContractValidate(consumerDir) {
  // Valid data should pass
  const validData = JSON.stringify({
    metadata: { id: 'batch-1:TC-001', title: 'Test', status: 'planned' },
    scope: { business_goal: 'Test', actors: ['user'] },
    system_boundary: { components: ['comp1'] },
    coverage: {},
    environment_data: {},
    relations: [
      { kind: 'derives_from', target_type: 'scenario', target_id: 'S-12' },
      { kind: 'verifies', target_type: 'feature', target_id: 'ACA11', anchor: 'AC1' },
    ],
    test_cases: [{
      case_id: 'TC-001',
      goal: 'Test',
      preconditions: ['Pre'],
      actions: [{ step: 1, action: 'Act' }],
      oracles: [{ observable: 'Obs', criterion: 'Crit' }],
      cleanup: [],
      priority: 'critical',
      trace_targets: ['S-12'],
    }],
    evidence_contract: { required_artifacts: ['artifact1'] },
  });
  const result = await command('npx', ['--no-install', 'artifact-graph', 'contract', 'validate', '--contract', 'artifact.e2e-test@1', '--data', validData, '--format', 'json'], { cwd: consumerDir });
  assert.equal(result.code, 0, `contract validate exit ${result.code}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true, 'contract validate should be ok');
  assert.equal(parsed.data.valid, true, 'contract validate should be valid');
  console.log('  contract validate valid data: OK');

  // Invalid data should fail
  const invalidData = JSON.stringify({ metadata: { id: 'INVALID' } });
  const result2 = await command('npx', ['--no-install', 'artifact-graph', 'contract', 'validate', '--contract', 'artifact.e2e-test@1', '--data', invalidData, '--format', 'json'], { cwd: consumerDir });
  assert.equal(result2.code, 1, `contract validate invalid should exit 1, got ${result2.code}`);
  const parsed2 = JSON.parse(result2.stdout);
  assert.equal(parsed2.ok, false, 'contract validate invalid should not be ok');
  assert.ok(parsed2.errors.length > 0, 'contract validate invalid should have errors');
  console.log('  contract validate invalid data: OK');
}

async function smokeContractNormalize(consumerDir) {
  const legacyData = JSON.stringify({
    id: 'batch-1:TC-001',
    title: 'Test',
    status: 'planned',
    test_batch: 'batch-1',
    scope: 'Test scope',
    actors: ['user'],
    system_boundaries: ['boundary'],
    test_cases: [{
      case_id: 'TC-001',
      goal: 'Goal',
      preconditions: ['Pre'],
      actions: [{ step: 1, action: 'Act' }],
      oracles: [{ observable: 'Obs', criterion: 'Crit' }],
      cleanup: [],
      priority: 'critical',
      trace_targets: ['S-12'],
    }],
    relations: [
      { kind: 'derives_from', target_type: 'scenario', target_id: 'S-12' },
      { kind: 'verifies', target_type: 'feature', target_id: 'ACA11', anchor: 'AC1' },
    ],
    ac_coverage: { ACA11: ['AC1'] },
    related_scenarios: ['S-12'],
    topology: 'docker-compose',
    fixtures: ['test-user-db'],
    isolation_strategy: 'per-test',
    required_artifacts: ['auth-service-logs'],
    runner_binding: 'playwright',
  });
  const result = await command('npx', ['--no-install', 'artifact-graph', 'contract', 'normalize', '--contract', 'artifact.e2e-test@1', '--data', legacyData, '--format', 'json'], { cwd: consumerDir });
  assert.equal(result.code, 0, `contract normalize exit ${result.code}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true, 'contract normalize envelope not ok');
  assert.equal(parsed.data.success, true, 'contract normalize should succeed');
  assert.ok(parsed.data.ir !== undefined, 'contract normalize missing ir');
  assert.equal(parsed.data.ir.sourceRevision, 'legacy', 'contract normalize wrong sourceRevision');
  console.log('  contract normalize: OK');
}

// --- Main ---

const testRoot = await mkdtemp(join(tmpdir(), 'artifact-graph-npm-consumer-'));
const tarball = await buildAndPack(testRoot);
const consumerDir = join(testRoot, 'consumer');
await mkdir(consumerDir, { recursive: true });
await installTarball(consumerDir, tarball);

console.log('\nRunning smoke matrix...');
await smokeBinHelp(consumerDir);
await smokeNpxHelp(consumerDir);
await smokeInit(consumerDir);
await smokeScan(consumerDir);
await smokeValidateJson(consumerDir);
await smokeDoctorJson(consumerDir);
await smokeImport(consumerDir);
await smokeSchemaSubpath(consumerDir);
await smokeContractList(consumerDir);
await smokeContractExplain(consumerDir);
await smokeContractValidate(consumerDir);
await smokeContractNormalize(consumerDir);

console.log('\npacked npm consumer: all smoke checks passed');
