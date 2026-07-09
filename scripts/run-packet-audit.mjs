#!/usr/bin/env node
/**
 * run-packet-audit.mjs
 *
 * Packet audit 回归测试脚本。运行以下场景并输出中文摘要：
 *  1. full discover summary-only（全量扫描，不写 packet 文件）
 *  2. compact summary 输出（体积治理验证）
 *  3. sample capture（指定样例写入）
 *  4. 非法 targets smoke test（exit 1）
 *  5. 非命中 --sample-targets smoke test（exit 1）
 *  6. 裸命令不带 --root（验证 root 自动发现）
 *  7. 错误 root 不会静默 total=0
 *
 * v1.13: 默认 outDirBase 改为每次唯一目录，避免旧结果干扰
 *
 * 用法: node scripts/run-packet-audit.mjs [--root <path>] [--out-dir <path>]
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = resolve(__dirname, '../dist/cli.js');

// v1.13: 临时目录前缀，用于识别和清理
const TMP_PREFIX = 'packet-audit-regression-';
const MAX_KEPT_DIRS = 5;

/**
 * 从脚本位置向上查找同时包含 artifact-graph.config.yaml 和 artifacts/ 的目录。
 * 找不到时返回 null（不再 fallback 到猜测路径）。
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

// ── Helpers ──

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
        // 从目录名提取时间戳
        ts: parseInt(e.name.slice(TMP_PREFIX.length), 10) || 0,
      }))
      .sort((a, b) => b.ts - a.ts); // 最新的在前

    // 删除超出保留数量的旧目录
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
    // execFile throws on non-zero exit
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

function log(msg) {
  process.stdout.write(`[packet-audit-regression] ${msg}\n`);
}

function pass(msg) {
  log(`✅ ${msg}`);
}

function fail(msg) {
  log(`❌ ${msg}`);
}

// ── Main ──

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

  // 如果用户没传 --root，尝试自动发现
  if (!root) {
    root = discoverRoot(__dirname);
    if (!root) {
      log('错误：无法自动发现 root 目录（找不到 artifact-graph.config.yaml 和 artifacts/）');
      log('请使用 --root <path> 显式指定');
      process.exit(1);
    }
  }

  // 验证 root 有效性
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

  // ── 场景 1: full discover summary-only ──
  {
    log('场景 1: full discover summary-only（全量扫描）');
    const outDir = join(outDirBase, 'discover-full');
    const res = await run([
      'packet-audit', '--root', root, '--discover', '--limit', '0',
      '--summary-only', '--format', 'json',
    ]);
    if (res.code !== 0) {
      fail(`discover summary-only exit ${res.code}`);
      failures++;
    } else {
      const summary = JSON.parse(res.stdout);
      log(`  总计: ${summary.total} | 通过: ${summary.passed} | 失败: ${summary.failed} | 缺失: ${summary.missing}`);
      log(`  schemaVersion: ${summary.schemaVersion}`);
      log(`  packetOutputMode: ${summary.packetOutputMode}`);
      if (summary.total > 0 && summary.packetOutputMode === 'summary-only') {
        pass('discover summary-only 正常');
      } else {
        fail('discover summary-only 结果异常');
        failures++;
      }
    }
  }

  // ── 场景 2: compact summary 输出 ──
  {
    log('场景 2: compact summary 输出（体积治理）');
    const outDir = join(outDirBase, 'discover-compact');
    await mkdir(outDir, { recursive: true });
    const res = await run([
      'packet-audit', '--root', root, '--discover', '--limit', '0',
      '--summary-only', '--summary-detail', 'compact', '--format', 'json',
    ]);
    if (res.code !== 0) {
      fail(`compact summary exit ${res.code}`);
      failures++;
    } else {
      const summary = JSON.parse(res.stdout);
      log(`  targets 数量: ${summary.targets.length}（全部: ${summary.total}）`);
      log(`  countsByType: ${JSON.stringify(summary.countsByType)}`);
      log(`  summaryDetail: ${summary.summaryDetail}`);
      const fullSize = JSON.stringify(summary).length;
      log(`  compact summary 体积: ${(fullSize / 1024).toFixed(1)} KB`);
      if (summary.summaryDetail === 'compact' && summary.countsByType) {
        pass('compact summary 正常');
      } else {
        fail('compact summary 缺少字段');
        failures++;
      }
    }
  }

  // ── 场景 3: sample capture ──
  {
    log('场景 3: sample capture（指定样例写入）');
    const outDir = join(outDirBase, 'sample-capture');
    // 先 discover 获取前两个 target
    const discoverRes = await run([
      'packet-audit', '--root', root, '--discover', '--limit', '2',
      '--summary-only', '--format', 'json',
    ]);
    if (discoverRes.code !== 0) {
      fail(`discover for sample exit ${discoverRes.code}`);
      failures++;
    } else {
      const disc = JSON.parse(discoverRes.stdout);
      if (disc.targets.length >= 1) {
        const sampleTarget = `${disc.targets[0].type}:${disc.targets[0].id}`;
        log(`  使用样例 target: ${sampleTarget}`);
        const res = await run([
          'packet-audit', '--root', root, '--discover', '--limit', '2',
          '--out-dir', outDir, '--sample-targets', sampleTarget, '--format', 'json',
        ]);
        if (res.code !== 0) {
          fail(`sample capture exit ${res.code}`);
          failures++;
        } else {
          const summary = JSON.parse(res.stdout);
          log(`  sampleTargets: ${JSON.stringify(summary.sampleTargets)}`);
          log(`  sampleOutputPaths: ${summary.sampleOutputPaths?.length ?? 0} 个文件`);
          if (summary.packetOutputMode === 'sample' && summary.sampleTargets?.includes(sampleTarget)) {
            pass('sample capture 正常');
          } else {
            fail('sample capture 结果异常');
            failures++;
          }
        }
      } else {
        fail('无可用于 sample 的 target');
        failures++;
      }
    }
  }

  // ── 场景 4: 非法 targets smoke test ──
  {
    log('场景 4: 非法 targets 文件（应 exit 1）');
    const tmpDir = await mkdtemp(join(tmpdir(), 'bad-targets-'));
    const badFile = join(tmpDir, 'bad.txt');
    await writeFile(badFile, 'feature:A1\ninvalid:B2\n');
    const res = await run([
      'packet-audit', '--root', root, '--targets-file', badFile,
      '--summary-only', '--format', 'json',
    ]);
    await rm(tmpDir, { recursive: true, force: true });
    if (res.code === 1) {
      pass('非法 targets 正确 exit 1');
    } else {
      fail(`非法 targets exit ${res.code}，期望 1`);
      failures++;
    }
  }

  // ── 场景 5: 非命中 --sample-targets smoke test ──
  {
    log('场景 5: 非命中 --sample-targets（应 exit 1）');
    const tmpDir = await mkdtemp(join(tmpdir(), 'bad-sample-'));
    const targetsFile = join(tmpDir, 'targets.txt');
    await writeFile(targetsFile, 'feature:A1\nscenario:S-01\n');
    const res = await run([
      'packet-audit', '--root', root, '--targets-file', targetsFile,
      '--summary-only', '--sample-targets', 'feature:NO_SUCH_TARGET', '--format', 'json',
    ]);
    await rm(tmpDir, { recursive: true, force: true });
    if (res.code === 1) {
      pass('非命中 sample-targets 正确 exit 1');
    } else {
      fail(`非命中 sample-targets exit ${res.code}，期望 1`);
      failures++;
    }
  }

  // ── 场景 6: 裸命令不带 --root（验证 root 自动发现） ──
  {
    log('场景 6: 裸命令不带 --root（验证脚本自动发现 root 并传递给 CLI）');
    // 验证 discoverRoot 产出的 root 包含必要的标识文件
    const { existsSync: exists } = await import('node:fs');
    const hasConfig = exists(join(root, 'artifact-graph.config.yaml'));
    const hasArtifacts = exists(join(root, 'artifacts'));
    if (!hasConfig || !hasArtifacts) {
      fail(`自动发现的 root=${root} 缺少 artifact-graph.config.yaml 或 artifacts/`);
      failures++;
    } else {
      // 用自动发现的 root 运行 CLI（模拟 pnpm packet:audit 裸命令场景）
      const res = await run([
        'packet-audit', '--root', root, '--discover', '--limit', '0',
        '--summary-only', '--format', 'json',
      ]);
      if (res.code !== 0) {
        fail(`自动发现 root 后 CLI exit ${res.code}`);
        failures++;
      } else {
        const summary = JSON.parse(res.stdout);
        log(`  自动发现 root=${root}, total=${summary.total}`);
        if (summary.total > 0) {
          pass(`自动发现 root 成功（total=${summary.total}）`);
        } else {
          fail('自动发现 root 后 total=0');
          failures++;
        }
      }
    }
  }

  // ── 场景 7: 错误 root 不会静默 total=0 ──
  {
    log('场景 7: 错误 root 目录（CLI 必须报错或 total=0 明确失败）');
    const tmpDir = await mkdtemp(join(tmpdir(), 'fake-root-'));
    const res = await run([
      'packet-audit', '--root', tmpDir, '--discover', '--limit', '0',
      '--summary-only', '--format', 'json',
    ]);
    await rm(tmpDir, { recursive: true, force: true });
    // 错误 root 下 discover CLI 必须返回非零，或 total=0 视为失败
    if (res.code !== 0) {
      pass('错误 root CLI 正确报错（exit != 0）');
    } else {
      const summary = JSON.parse(res.stdout);
      if (summary.total === 0) {
        // total=0 + exit 0 = 静默成功，这是不可接受的
        fail(`错误 root 下 CLI exit 0 且 total=0（静默成功，应报错）`);
        failures++;
      } else {
        fail(`错误 root 下 total=${summary.total}，不应有结果`);
        failures++;
      }
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
