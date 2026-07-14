import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import {
  VERSION_LOCK_PATH,
  auditVersionLock,
  bootstrapVersionLock,
  buildVersionIndex,
  refreshVersionLock,
  updateVersionLock,
} from '../src/versioned-traceability.js';
import { scanArtifacts } from '../src/index.js';

// @scenario S-02 @scenario S-03 @feature ACA2
const execFileAsync = promisify(execFile);

async function write(root: string, path: string, content: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(fullPath.split('/').slice(0, -1).join('/'), { recursive: true });
  await writeFile(fullPath, content);
}

async function versionRepo(name: string): Promise<string> {
  const root = join(tmpdir(), `artifact-graph-versioned-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  await write(
    root,
    'artifact-graph.config.yaml',
    `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  scenario:
    paths: ["artifacts/scenarios/**/*.md"]
  decision:
    paths: ["artifacts/decisions/**/*.md"]
  design:
    paths: ["artifacts/design/**/*.md"]
  test:
    paths:
      - "heimdall/packages/**/*.ts"
      - "heimdall/packages/**/*.tsx"
  traceability-version-lock:
    paths: ["artifacts/traceability-version-lock.json"]
idPatterns:
  test: '^.+\\.(test\\.)?(spec\\.)?(ts|tsx)$'
  traceability-version-lock: "^traceability-version-lock$"
`,
  );
  await write(
    root,
    'artifacts/prd/features/A1-scan.md',
    `---
id: A1
title: Scan
status: done
scenarios: [S-01]
---
# Scan
`,
  );
  await write(
    root,
    'artifacts/scenarios/batch-1.md',
    `## S-01: Run scan

**关联功能**: A1
`,
  );
  await write(
    root,
    'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
    `// @feature A1
export function NewScanPage() {
  return 'scan';
}
`,
  );
  await write(
    root,
    'heimdall/packages/desktop/src/pages/NewScanPage.test.tsx',
    `// @feature A1 @scenario S-01
test('scan', () => {});
`,
  );
  return root;
}

async function capture(argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    cwd,
    stdout: (chunk) => { stdout += chunk; },
    stderr: (chunk) => { stderr += chunk; },
  });
  return { code, stdout, stderr };
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: root });
}

describe('versioned traceability', () => {
  it('builds a version index with artifact and code hashes', async () => {
    const root = await versionRepo('index');
    const index = await buildVersionIndex(root);
    const feature = index.nodes.find((node) => node.uid === 'feature:A1');
    const source = index.nodes.find((node) => node.path.endsWith('NewScanPage.tsx'));
    const test = index.nodes.find((node) => node.path.endsWith('NewScanPage.test.tsx'));

    expect(index.schemaVersion).toBe('1.0');
    expect(feature?.contentHash).toMatch(/^sha256:/);
    expect(source?.sourceKind).toBe('code');
    expect(test?.sourceKind).toBe('test');
    expect(index.edges.some((edge) => edge.from === source?.uid && edge.to === 'feature:A1' && edge.kind === 'implements')).toBe(true);
    expect(index.edges.some((edge) => edge.from === test?.uid && edge.to === 'feature:A1' && edge.kind === 'verifies')).toBe(true);
  });

  it('updates and audits a fresh version lock', async () => {
    const root = await versionRepo('fresh');
    await updateVersionLock(root, {
      target: 'feature:A1',
      source: 'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
      verifiedBy: ['heimdall/packages/desktop/src/pages/NewScanPage.test.tsx'],
    });

    const lock = JSON.parse(await readFile(join(root, VERSION_LOCK_PATH), 'utf-8')) as { locks: unknown[] };
    expect(lock.locks).toHaveLength(1);
    expect(JSON.stringify(lock.locks[0])).toContain('code:heimdall/packages/desktop/src/pages/NewScanPage.tsx#implements#feature:A1');

    const audit = await auditVersionLock(root);
    expect(audit.issues.some((issue) => (
      issue.status === 'missing_lock'
      && issue.edgeId.includes('test:heimdall/packages/desktop/src/pages/NewScanPage.test.tsx#verifies#feature:A1')
    ))).toBe(true);
    expect(audit.fresh).toBe(1);
  });

  it('reports artifact_changed when the target artifact changes after lock update', async () => {
    const root = await versionRepo('artifact-changed');
    await updateVersionLock(root, {
      target: 'feature:A1',
      source: 'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
    });
    await write(
      root,
      'artifacts/prd/features/A1-scan.md',
      `---
id: A1
title: Scan changed
status: done
scenarios: [S-01]
---
# Scan changed
`,
    );

    const audit = await auditVersionLock(root);
    expect(audit.issues.some((issue) => issue.status === 'artifact_changed')).toBe(true);
  });

  it('exposes CLI commands for index, lock update, lock audit, and trace-version', async () => {
    const root = await versionRepo('cli');
    const indexResult = await capture(['version-index', '--root', root], root);
    expect(indexResult.code).toBe(0);
    expect(JSON.parse(indexResult.stdout).schemaVersion).toBe('1.0');

    const updateResult = await capture([
      'version-lock',
      'update',
      '--root',
      root,
      '--target',
      'feature:A1',
      '--source',
      'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
    ], root);
    expect(updateResult.code).toBe(0);

    const auditResult = await capture(['version-lock', 'audit', '--root', root, '--format', 'json'], root);
    expect(auditResult.code).toBe(0);
    expect(JSON.parse(auditResult.stdout).totalLocks).toBe(1);

    const strictAuditResult = await capture(['version-lock', 'audit', '--root', root, '--format', 'json', '--strict-missing-lock'], root);
    expect(strictAuditResult.code).toBe(1);

    const traceResult = await capture(['trace-version', '--root', root, '--target', 'feature:A1', '--format', 'json'], root);
    expect(traceResult.code).toBe(0);
    const trace = JSON.parse(traceResult.stdout);
    expect(trace.target.uid).toBe('feature:A1');
    expect(trace.target.node.contentHash).toMatch(/^sha256:/);
    expect(trace.locks).toHaveLength(1);
    expect(trace.currentEdges.length).toBeGreaterThan(0);

    const missingTrace = await capture(['trace-version', '--root', root, '--target', 'feature:DOES_NOT_EXIST', '--format', 'json'], root);
    expect(missingTrace.code).toBe(1);
    expect(JSON.parse(missingTrace.stdout).issues[0].status).toBe('target_not_found');

    const invalidIndexFormat = await capture(['version-index', '--root', root, '--format', 'markdown'], root);
    expect(invalidIndexFormat.code).toBe(1);

    const invalidAuditFormat = await capture(['version-lock', 'audit', '--root', root, '--format', 'xml'], root);
    expect(invalidAuditFormat.code).toBe(1);

    const invalidTraceFormat = await capture(['trace-version', '--root', root, '--target', 'feature:A1', '--format', 'xml'], root);
    expect(invalidTraceFormat.code).toBe(1);
  });

  it('scans the version lock file as a context node when it exists', async () => {
    const root = await versionRepo('lock-node');
    await updateVersionLock(root, {
      target: 'feature:A1',
      source: 'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
    });

    const graph = await scanArtifacts(root);
    const lockNode = graph.nodes.find((node) => node.uid === 'traceability-version-lock:traceability-version-lock');
    expect(lockNode?.path).toBe(VERSION_LOCK_PATH);
  });

  it('rejects artifact files as verified-by sources', async () => {
    const root = await versionRepo('bad-verifier');
    await expect(updateVersionLock(root, {
      target: 'feature:A1',
      source: 'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
      verifiedBy: ['artifacts/prd/features/A1-scan.md'],
    })).rejects.toThrow(/Verifier must be code or test/);
  });

  it('rejects verified-by sources that do not verify the locked artifact', async () => {
    const root = await versionRepo('bad-verifier-link');
    await write(
      root,
      'artifacts/prd/features/B2-other.md',
      `---
id: B2
title: Other
status: done
---
# Other
`,
    );
    await write(
      root,
      'heimdall/packages/desktop/src/pages/Other.test.tsx',
      `// @feature B2
test('other', () => {});
`,
    );

    await expect(updateVersionLock(root, {
      target: 'feature:A1',
      source: 'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
      verifiedBy: ['heimdall/packages/desktop/src/pages/Other.test.tsx'],
    })).rejects.toThrow(/Verifier .* does not declare a traceability link to feature:A1/);
  });

  it('reports orphan_lock when a locked traceability edge is removed', async () => {
    const root = await versionRepo('orphan-edge');
    await updateVersionLock(root, {
      target: 'feature:A1',
      source: 'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
    });
    await write(
      root,
      'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
      `// @scenario S-01
export function NewScanPage() {
  return 'scan';
}
`,
    );

    const audit = await auditVersionLock(root);
    expect(audit.issues.some((issue) => issue.status === 'orphan_lock' && issue.message.includes('traceability edge'))).toBe(true);
    expect(audit.fresh).toBe(0);
  });

  it('bootstraps initial locks for current implementation traceability edges', async () => {
    const root = await versionRepo('bootstrap');
    const lock = await bootstrapVersionLock(root);

    expect(lock.locks.some((entry) => (
      entry.edgeId.includes('NewScanPage.tsx#implements#feature:A1')
      && entry.kind === 'implements'
    ))).toBe(true);
    expect(lock.locks.some((entry) => (
      entry.edgeId.includes('NewScanPage.test.tsx#verifies#scenario:S-01')
      && entry.kind === 'verifies'
    ))).toBe(true);

    const audit = await auditVersionLock(root);
    expect(audit.fresh).toBe(lock.locks.length);
    expect(audit.issues).toHaveLength(0);
  });

  it('guards lock paths and supports force bootstrap over malformed lock files', async () => {
    const root = await versionRepo('path-and-force');

    await expect(bootstrapVersionLock(root, { lockPath: '../outside.json' })).rejects.toThrow(/Path is outside root/);

    await write(root, VERSION_LOCK_PATH, '{not json');
    await expect(auditVersionLock(root)).rejects.toThrow(/not valid JSON/);

    const lock = await bootstrapVersionLock(root, { force: true });
    expect(lock.locks.length).toBeGreaterThan(0);
  });

  it('validates lock schema entries deterministically', async () => {
    const root = await versionRepo('schema');
    await write(root, VERSION_LOCK_PATH, JSON.stringify({
      schemaVersion: '1.0',
      locks: [
        {
          edgeId: 'bad',
          kind: 'bogus',
          artifact: { type: 'feature', id: 'A1', path: 'artifacts/prd/features/A1-scan.md', contentHash: 'sha256:nothex' },
          source: { type: 'code', path: 'heimdall/packages/desktop/src/pages/NewScanPage.tsx', contentHash: 'sha256:nothex' },
        },
      ],
    }));

    await expect(auditVersionLock(root)).rejects.toThrow(/Invalid version lock entry/);
  });

  it('refreshes missing locks only for affected changed paths and is idempotent', async () => {
    const root = await versionRepo('refresh-missing');

    const first = await refreshVersionLock(root, {
      changedOnly: true,
      changedPaths: ['heimdall/packages/desktop/src/pages/NewScanPage.tsx'],
    });

    expect(first.addedLocks).toContain('code:heimdall/packages/desktop/src/pages/NewScanPage.tsx#implements#feature:A1');
    expect(first.addedLocks.some((edgeId) => edgeId.includes('NewScanPage.test.tsx'))).toBe(false);
    expect(first.updatedLocks).toEqual([]);
    expect(first.retainedOrphans).toEqual([]);

    const lockAfterFirst = await readFile(join(root, VERSION_LOCK_PATH), 'utf-8');
    const second = await refreshVersionLock(root, {
      changedOnly: true,
      changedPaths: ['heimdall/packages/desktop/src/pages/NewScanPage.tsx'],
    });
    const lockAfterSecond = await readFile(join(root, VERSION_LOCK_PATH), 'utf-8');

    expect(second.addedLocks).toEqual([]);
    expect(second.updatedLocks).toEqual([]);
    expect(lockAfterSecond).toBe(lockAfterFirst);
  });

  it('updates affected artifact, source, and verified-by hashes', async () => {
    const root = await versionRepo('refresh-hashes');
    await updateVersionLock(root, {
      target: 'feature:A1',
      source: 'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
      verifiedBy: ['heimdall/packages/desktop/src/pages/NewScanPage.test.tsx'],
    });
    await write(
      root,
      'artifacts/prd/features/A1-scan.md',
      `---
id: A1
title: Scan changed
status: done
scenarios: [S-01]
---
# Scan changed
`,
    );
    await write(
      root,
      'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
      `// @feature A1
export function NewScanPage() {
  return 'scan changed';
}
`,
    );
    await write(
      root,
      'heimdall/packages/desktop/src/pages/NewScanPage.test.tsx',
      `// @feature A1 @scenario S-01
test('scan changed', () => {});
`,
    );

    const refresh = await refreshVersionLock(root, {
      changedOnly: true,
      changedPaths: [
        'artifacts/prd/features/A1-scan.md',
        'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
        'heimdall/packages/desktop/src/pages/NewScanPage.test.tsx',
      ],
    });

    expect(refresh.updatedLocks).toContain('code:heimdall/packages/desktop/src/pages/NewScanPage.tsx#implements#feature:A1');
    const audit = await auditVersionLock(root);
    expect(audit.issues.some((issue) => (
      issue.edgeId === 'code:heimdall/packages/desktop/src/pages/NewScanPage.tsx#implements#feature:A1'
      && ['artifact_changed', 'source_changed', 'verified_by_changed'].includes(issue.status)
    ))).toBe(false);
  });

  it('removes affected orphan verified-by references when requested', async () => {
    const root = await versionRepo('refresh-verified-by-orphan');
    await updateVersionLock(root, {
      target: 'feature:A1',
      source: 'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
      verifiedBy: ['heimdall/packages/desktop/src/pages/NewScanPage.test.tsx'],
    });
    await write(
      root,
      'heimdall/packages/desktop/src/pages/NewScanPage.test.tsx',
      `// @scenario S-01
test('scan still exists but no longer verifies A1', () => {});
`,
    );

    const refresh = await refreshVersionLock(root, {
      changedOnly: true,
      changedPaths: ['heimdall/packages/desktop/src/pages/NewScanPage.test.tsx'],
      removeOrphans: true,
    });

    expect(refresh.removedOrphans).toContain('code:heimdall/packages/desktop/src/pages/NewScanPage.tsx#implements#feature:A1#verifiedBy:heimdall/packages/desktop/src/pages/NewScanPage.test.tsx');
    const audit = await auditVersionLock(root);
    expect(audit.issues.some((issue) => (
      issue.edgeId === 'code:heimdall/packages/desktop/src/pages/NewScanPage.tsx#implements#feature:A1'
      && issue.verifiedByPath === 'heimdall/packages/desktop/src/pages/NewScanPage.test.tsx'
    ))).toBe(false);
  });

  it('retains affected orphan locks by default and removes them explicitly', async () => {
    const root = await versionRepo('refresh-orphans');
    await updateVersionLock(root, {
      target: 'feature:A1',
      source: 'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
    });
    await write(
      root,
      'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
      `// @scenario S-01
export function NewScanPage() {
  return 'scan';
}
`,
    );

    const retained = await refreshVersionLock(root, {
      changedOnly: true,
      changedPaths: ['heimdall/packages/desktop/src/pages/NewScanPage.tsx'],
    });
    expect(retained.retainedOrphans).toContain('code:heimdall/packages/desktop/src/pages/NewScanPage.tsx#implements#feature:A1');
    expect(retained.removedOrphans).toEqual([]);

    const removed = await refreshVersionLock(root, {
      changedOnly: true,
      changedPaths: ['heimdall/packages/desktop/src/pages/NewScanPage.tsx'],
      removeOrphans: true,
    });
    expect(removed.removedOrphans).toContain('code:heimdall/packages/desktop/src/pages/NewScanPage.tsx#implements#feature:A1');

    const lock = JSON.parse(await readFile(join(root, VERSION_LOCK_PATH), 'utf-8')) as { locks: Array<{ edgeId: string }> };
    expect(lock.locks.some((entry) => entry.edgeId.includes('NewScanPage.tsx#implements#feature:A1'))).toBe(false);
  });

  it('requires --all when config changes are included in changed-only refresh', async () => {
    const root = await versionRepo('refresh-config');

    await expect(refreshVersionLock(root, {
      changedOnly: true,
      changedPaths: ['artifact-graph.config.yaml'],
    })).rejects.toThrow(/requires --all/);

    const refresh = await refreshVersionLock(root, {
      changedOnly: true,
      changedPaths: ['artifact-graph.config.yaml'],
      all: true,
    });

    expect(refresh.addedLocks.length).toBeGreaterThan(1);
  });

  it('exposes CLI refresh output in json and markdown formats', async () => {
    const root = await versionRepo('cli-refresh-all');

    const json = await capture(['version-lock', 'refresh', '--root', root, '--all', '--format', 'json'], root);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.mode).toBe('all');
    expect(parsed.addedLocks.length).toBeGreaterThan(1);
    expect(parsed.postAudit.issues).toEqual([]);

    const markdown = await capture(['version-lock', 'refresh', '--root', root, '--all', '--format', 'markdown'], root);
    expect(markdown.code).toBe(0);
    expect(markdown.stdout).toContain('# Version Lock Refresh');

    const invalid = await capture(['version-lock', 'refresh', '--root', root, '--all', '--format', 'xml'], root);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('Invalid --format');
  });

  it('collects worktree changed paths for CLI changed-only refresh', async () => {
    const root = await versionRepo('cli-refresh-worktree');
    await git(root, ['init']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await git(root, ['config', 'user.name', 'Test User']);
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'initial']);
    await write(
      root,
      'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
      `// @feature A1
export function NewScanPage() {
  return 'scan changed';
}
`,
    );

    const result = await capture([
      'version-lock',
      'refresh',
      '--root',
      root,
      '--changed-only',
      '--worktree',
      '--format',
      'json',
    ], root);

    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.changedPaths).toEqual(['heimdall/packages/desktop/src/pages/NewScanPage.tsx']);
    expect(parsed.addedLocks).toContain('code:heimdall/packages/desktop/src/pages/NewScanPage.tsx#implements#feature:A1');
    expect(parsed.postAudit.issues.some((issue: { status: string }) => issue.status === 'missing_lock')).toBe(true);
  });

  it('rejects staged refresh when a relevant staged path also has unstaged changes', async () => {
    const root = await versionRepo('cli-refresh-staged-divergence');
    await git(root, ['init']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await git(root, ['config', 'user.name', 'Test User']);
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'initial']);
    await write(
      root,
      'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
      `// @feature A1
export function NewScanPage() {
  return 'staged change';
}
`,
    );
    await git(root, ['add', 'heimdall/packages/desktop/src/pages/NewScanPage.tsx']);
    await write(
      root,
      'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
      `// @feature A1
export function NewScanPage() {
  return 'unstaged change';
}
`,
    );

    const result = await capture([
      'version-lock',
      'refresh',
      '--root',
      root,
      '--changed-only',
      '--staged',
      '--format',
      'json',
    ], root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('staged and unstaged changes');
  });

  it('rejects staged refresh when other graph-relevant paths have unstaged changes', async () => {
    const root = await versionRepo('cli-refresh-staged-related-unstaged');
    await git(root, ['init']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await git(root, ['config', 'user.name', 'Test User']);
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'initial']);
    await write(
      root,
      'heimdall/packages/desktop/src/pages/NewScanPage.tsx',
      `// @feature A1
export function NewScanPage() {
  return 'staged source';
}
`,
    );
    await git(root, ['add', 'heimdall/packages/desktop/src/pages/NewScanPage.tsx']);
    await write(
      root,
      'artifacts/prd/features/A1-scan.md',
      `---
id: A1
title: Unstaged artifact change
status: done
scenarios: [S-01]
---
# Unstaged artifact change
`,
    );

    const result = await capture([
      'version-lock',
      'refresh',
      '--root',
      root,
      '--changed-only',
      '--staged',
      '--format',
      'json',
    ], root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('graph-relevant unstaged changes');
    expect(result.stderr).toContain('artifacts/prd/features/A1-scan.md');
  });
});

describe('versioned traceability: custom type edges', () => {
  async function customTypeRepo(name: string): Promise<string> {
    const root = join(tmpdir(), `artifact-graph-vt-custom-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    await write(
      root,
      'artifact-graph.config.yaml',
      `types:
  feature:
    paths: ["artifacts/prd/features/**/*.md"]
  api_contract:
    paths: ["artifacts/contracts/api/**/*.md"]
    target: true
  test:
    paths: ["src/**/*.java"]
idPatterns:
  api_contract: "^API-\\\\d+$"
`,
    );
    await write(
      root,
      'artifacts/prd/features/F-001.md',
      `---
id: F-001
title: Order Management
status: active
---
# F-001
`,
    );
    await write(
      root,
      'artifacts/contracts/api/API-001.md',
      `---
id: API-001
title: Create Order API
status: active
related_features: [F-001]
---
# API-001
`,
    );
    await write(
      root,
      'src/OrderController.java',
      `// @api_contract API-001
// @feature F-001
public class OrderController {}
`,
    );
    return root;
  }

  it('detects missing_lock for custom type verifies edge', async () => {
    const root = await customTypeRepo('custom-missing');
    try {
      const audit = await auditVersionLock(root);
      expect(audit.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: 'missing_lock',
          edgeId: expect.stringContaining('api_contract:API-001'),
        }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bootstraps and audits custom type implementation edges', async () => {
    const root = await customTypeRepo('custom-bootstrap');
    try {
      const lock = await bootstrapVersionLock(root);

      // Java .java files are classified as 'code' (not test), so lock kind is 'implements'
      expect(lock.locks.some((entry) => (
        entry.edgeId.includes('OrderController.java')
        && entry.edgeId.includes('api_contract:API-001')
        && entry.kind === 'implements'
      ))).toBe(true);

      const audit = await auditVersionLock(root);
      expect(audit.fresh).toBe(lock.locks.length);
      expect(audit.issues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports artifact_changed when custom type artifact changes after lock update', async () => {
    const root = await customTypeRepo('custom-artifact-changed');
    try {
      await bootstrapVersionLock(root);
      await write(
        root,
        'artifacts/contracts/api/API-001.md',
        `---
id: API-001
title: Create Order API v2
status: active
related_features: [F-001]
---
# API-001 v2
`,
      );

      const audit = await auditVersionLock(root);
      expect(audit.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: 'artifact_changed',
          edgeId: expect.stringContaining('api_contract:API-001'),
        }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports orphan_lock when custom type verifies edge is removed', async () => {
    const root = await customTypeRepo('custom-orphan');
    try {
      await bootstrapVersionLock(root);
      // Remove the traceability comment from the Java file
      await write(
        root,
        'src/OrderController.java',
        `public class OrderController {}
`,
      );

      const audit = await auditVersionLock(root);
      expect(audit.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: 'orphan_lock',
          edgeId: expect.stringContaining('api_contract:API-001'),
        }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refreshes custom type locks with --all mode', async () => {
    const root = await customTypeRepo('custom-refresh');
    try {
      const refresh = await refreshVersionLock(root, { all: true });
      expect(refresh.addedLocks.some((edgeId) => edgeId.includes('api_contract:API-001'))).toBe(true);
      expect(refresh.postAudit.issues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
