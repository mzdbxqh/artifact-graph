#!/usr/bin/env node
/**
 * run-packet-prompt-audit.mjs
 *
 * Packet prompt audit 回归测试脚本。运行以下场景并输出中文摘要：
 *  1. discover compact summary-only 全量（不写 prompt 文件）
 *  2. discover limit 5（限制 target 数量）
 *  3. targets-file 写 summary + prompt 文件
 *  4. summary-only 写 summary 不写 prompt 文件
 *  5. 负例：--discover 空 root（exit 1）
 *  6. 负例：--limit -1（exit 1）
 *  7. 负例：--discover 与 --targets-file 互斥（exit 1）
 *  8. 负例：--summary-detail 非法值（exit 1）
 *
 * v1.13: 默认 outDirBase 改为每次唯一目录，避免旧结果干扰
 *
 * 用法: node scripts/run-packet-prompt-audit.mjs [--root <path>] [--out-dir <path>]
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = resolve(__dirname, '../dist/cli.js');

// v1.13: 临时目录前缀，用于识别和清理
const TMP_PREFIX = 'packet-prompt-audit-regression-';
const MAX_KEPT_DIRS = 5;

/**
 * 从脚本位置向上查找同时包含 artifact-graph.config.yaml 和 artifacts/ 的目录。
 */
function discoverRoot(startDir) {
  let dir = resolve(startDir);
  for (let i = 0; i < 10; i++) {
    if (
      existsSync(join(dir, 'artifact-graph.config.yaml')) &&
      existsSync(join(dir, 'artifacts'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * v1.13: 清理旧的临时目录，保留最近 MAX_KEPT_DIRS 个
 */
async function cleanupOldTmpDirs() {
  try {
    const tmpBase = tmpdir();
    const entries = readdirSync(tmpBase, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(TMP_PREFIX))
      .map((e) => ({
        name: e.name,
        path: join(tmpBase, e.name),
        ts: parseInt(e.name.slice(TMP_PREFIX.length), 10) || 0,
      }))
      .sort((a, b) => b.ts - a.ts);

    for (const dir of entries.slice(MAX_KEPT_DIRS)) {
      await rm(dir.path, { recursive: true, force: true });
    }
  } catch {
    // 忽略清理错误
  }
}

async function run(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI, ...args], {
      timeout: 120_000,
      maxBuffer: 50 * 1024 * 1024,
      ...opts,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

function log(msg) {
  process.stdout.write(`[packet-prompt-audit-regression] ${msg}\n`);
}

function pass(msg) {
  log(`✅ ${msg}`);
}

function fail(msg) {
  log(`❌ ${msg}`);
}

async function main() {
  const args = process.argv.slice(2);
  let root = null;
  let outDirBase = null;
  let userSpecifiedOutDir = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i]);
    else if (args[i] === '--out-dir' && args[i + 1]) {
      outDirBase = resolve(args[++i]);
      userSpecifiedOutDir = true;
    }
  }

  // v1.13: 清理旧临时目录
  await cleanupOldTmpDirs();

  // v1.13: 默认使用唯一临时目录
  if (!outDirBase) {
    outDirBase = await mkdtemp(join(tmpdir(), TMP_PREFIX));
  } else {
    await mkdir(outDirBase, { recursive: true });
  }

  if (!root) {
    root = discoverRoot(__dirname);
    if (!root) {
      log('错误：无法自动发现 root 目录（找不到 artifact-graph.config.yaml 和 artifacts/）');
      log('请使用 --root <path> 显式指定');
      process.exit(1);
    }
  }

  const hasConfig = existsSync(join(root, 'artifact-graph.config.yaml'));
  const hasArtifacts = existsSync(join(root, 'artifacts'));
  if (!hasConfig || !hasArtifacts) {
    log(`错误：root=${root} 缺少 ${!hasConfig ? 'artifact-graph.config.yaml' : ''}${!hasConfig && !hasArtifacts ? ' 和 ' : ''}${!hasArtifacts ? 'artifacts/' : ''}`);
    process.exit(1);
  }

  let failures = 0;
  const startTime = Date.now();

  log(`根目录: ${root}`);
  log(`输出目录: ${outDirBase}${userSpecifiedOutDir ? '（用户指定）' : '（自动创建）'}`);
  log('─'.repeat(60));

  // ── 场景 1: discover compact summary-only 全量 ──
  {
    log('场景 1: discover compact summary-only 全量（不写 prompt 文件）');
    const res = await run([
      'packet-prompt-audit', '--root', root, '--discover', '--limit', '0',
      '--summary-only', '--summary-detail', 'compact', '--format', 'json',
    ]);
    if (res.code !== 0) {
      fail(`discover compact summary-only exit ${res.code}，stderr: ${res.stderr.trim().slice(0, 200)}`);
      failures++;
    } else {
      const summary = JSON.parse(res.stdout);
      log(`  总计: ${summary.total} | 通过: ${summary.passed} | 失败: ${summary.failed} | 省略: ${summary.totalOmitted}`);
      log(`  schemaVersion: ${summary.schemaVersion} | countsByType: ${JSON.stringify(summary.countsByType)}`);
      if (summary.total > 0 && summary.failed === 0 && summary.totalOmitted > 0) {
        pass('discover compact summary-only 正常');
      } else {
        fail('discover compact summary-only 结果异常');
        failures++;
      }
    }
  }

  // ── 场景 2: discover limit 5 ──
  {
    log('场景 2: discover limit 5');
    const res = await run([
      'packet-prompt-audit', '--root', root, '--discover', '--limit', '5',
      '--format', 'json',
    ]);
    if (res.code !== 0) {
      fail(`discover limit 5 exit ${res.code}，stderr: ${res.stderr.trim().slice(0, 200)}`);
      failures++;
    } else {
      const summary = JSON.parse(res.stdout);
      log(`  总计: ${summary.total} | 通过: ${summary.passed} | 失败: ${summary.failed}`);
      if (summary.total <= 5 && summary.passed === summary.total) {
        pass('discover limit 5 正常');
      } else {
        fail(`discover limit 5 结果异常: total=${summary.total}`);
        failures++;
      }
    }
  }

  // ── 场景 3: targets-file 写 summary + prompt 文件 ──
  {
    log('场景 3: targets-file 写 summary + prompt 文件');
    const outDir = join(outDirBase, 'targets-file-output');
    await mkdir(outDir, { recursive: true });
    const targetsFile = join(outDir, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\ndecision:D-ARCH-01\n');
    const res = await run([
      'packet-prompt-audit', '--root', root, '--targets-file', targetsFile,
      '--out-dir', outDir, '--format', 'json',
    ]);
    if (res.code !== 0) {
      fail(`targets-file exit ${res.code}，stderr: ${res.stderr.trim().slice(0, 200)}`);
      failures++;
    } else {
      const summary = JSON.parse(res.stdout);
      const files = await readdir(outDir);
      const hasSummary = files.includes('prompt-audit-summary.json') && files.includes('prompt-audit-summary.md');
      const hasPrompts = files.some((f) => f.startsWith('prompt-') && f.endsWith('.md') && f !== 'prompt-audit-summary.md');
      log(`  文件数: ${files.length} | 有 summary: ${hasSummary} | 有 prompt 文件: ${hasPrompts}`);
      if (summary.total === 3 && hasSummary && hasPrompts) {
        pass('targets-file 写 summary + prompt 正常');
      } else {
        fail('targets-file 输出异常');
        failures++;
      }
    }
  }

  // ── 场景 4: summary-only 写 summary 不写 prompt ──
  {
    log('场景 4: summary-only 写 summary 不写 prompt');
    const outDir = join(outDirBase, 'summary-only-output');
    await mkdir(outDir, { recursive: true });
    const targetsFile = join(outDir, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\n');
    const res = await run([
      'packet-prompt-audit', '--root', root, '--targets-file', targetsFile,
      '--out-dir', outDir, '--summary-only', '--format', 'json',
    ]);
    if (res.code !== 0) {
      fail(`summary-only exit ${res.code}，stderr: ${res.stderr.trim().slice(0, 200)}`);
      failures++;
    } else {
      const summary = JSON.parse(res.stdout);
      const files = await readdir(outDir);
      const hasSummary = files.includes('prompt-audit-summary.json') && files.includes('prompt-audit-summary.md');
      const promptFiles = files.filter((f) => f.startsWith('prompt-') && f.endsWith('.md') && f !== 'prompt-audit-summary.md');
      log(`  文件数: ${files.length} | 有 summary: ${hasSummary} | prompt 文件数: ${promptFiles.length}`);
      if (summary.total === 2 && hasSummary && promptFiles.length === 0) {
        pass('summary-only 写 summary 不写 prompt 正常');
      } else {
        fail('summary-only 输出异常');
        failures++;
      }
    }
  }

  // ── 负例 5: --discover 空 root（exit 1）──
  {
    log('负例 5: --discover 空 root（应 exit 1）');
    const tmpDir = await mkdtemp(join(tmpdir(), 'empty-root-'));
    const res = await run([
      'packet-prompt-audit', '--root', tmpDir, '--discover', '--limit', '0', '--format', 'json',
    ]);
    await rm(tmpDir, { recursive: true, force: true });
    if (res.code === 1) {
      pass('空 root 正确 exit 1');
    } else {
      fail(`空 root exit ${res.code}，期望 1，stderr: ${res.stderr.trim().slice(0, 200)}`);
      failures++;
    }
  }

  // ── 负例 6: --limit -1（exit 1）──
  {
    log('负例 6: --limit -1（应 exit 1）');
    const res = await run([
      'packet-prompt-audit', '--root', root, '--discover', '--limit', '-1', '--format', 'json',
    ]);
    if (res.code === 1 && res.stderr.includes('Invalid --limit')) {
      pass('--limit -1 正确 exit 1');
    } else {
      fail(`--limit -1 exit ${res.code}，期望 1，stderr: ${res.stderr.trim().slice(0, 200)}`);
      failures++;
    }
  }

  // ── 负例 7: --discover 与 --targets-file 互斥（exit 1）──
  {
    log('负例 7: --discover 与 --targets-file 互斥（应 exit 1）');
    const res = await run([
      'packet-prompt-audit', '--root', root, '--discover', '--targets-file', '/tmp/fake.txt', '--format', 'json',
    ]);
    if (res.code === 1 && res.stderr.includes('互斥')) {
      pass('互斥参数正确 exit 1');
    } else {
      fail(`互斥参数 exit ${res.code}，期望 1，stderr: ${res.stderr.trim().slice(0, 200)}`);
      failures++;
    }
  }

  // ── 负例 8: --summary-detail 非法值（exit 1）──
  {
    log('负例 8: --summary-detail 非法值（应 exit 1）');
    const res = await run([
      'packet-prompt-audit', '--root', root, '--discover', '--summary-detail', 'verbose', '--format', 'json',
    ]);
    if (res.code === 1 && res.stderr.includes('Invalid --summary-detail')) {
      pass('--summary-detail 非法值正确 exit 1');
    } else {
      fail(`--summary-detail 非法值 exit ${res.code}，期望 1，stderr: ${res.stderr.trim().slice(0, 200)}`);
      failures++;
    }
  }

  // ── 总结 ──
  log('─'.repeat(60));
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  if (failures === 0) {
    log(`全部通过（${elapsed}s）`);
  } else {
    log(`${failures} 个场景失败（${elapsed}s）`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
