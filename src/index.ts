import Database from 'better-sqlite3';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { ALWAYS_PRESENT_ITEMS as ALWAYS_PRESENT } from './packet-constants.js';
import { VALID_PACKET_TARGET_TYPES, isPacketTargetType } from './packet-validator.js';
import { matchesRunnerGlob } from './glob-matcher.js';

export interface ArtifactNode {
  uid: string;
  type: string;
  code: string;
  title: string;
  path: string;
  line: number;
  status?: string;
  attrs?: Record<string, unknown>;
  aliases?: string[];
}

export interface ArtifactEdge {
  from: string;
  to: string;
  kind: string;
  source: string;
  sourcePath: string;
  sourceLine: number;
}

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  node?: string;
  edge?: ArtifactEdge;
  path: string;
  line: number;
}

interface RelationOccurrence {
  field: string;
  targetType: string;
  target: string;
  path: string;
  line: number;
  raw?: string;
}

export interface ArtifactExtraFieldSchema {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  enum?: Array<string | number | boolean>;
}

export interface ArtifactTypeSchema {
  paths: string[];
  idPattern?: string;
  displayName?: string;
  role?: ArtifactTypeRole;
  layer?: string;
  aliases?: string[];
  target?: boolean;
  extraFields?: ArtifactExtraFieldSchema[];
}

export interface ArtifactTarget {
  type: string;
  id: string;
}

export interface ArtifactEdgeRule {
  from: string;
  to: string;
  kind: string;
}

/** E2E test runner configuration */
export interface E2eRunnerConfig {
  /** Runner name (e.g., 'playwright', 'vitest', 'jest') */
  name: string;
  /** Test kind accepted by this runner: 'unit', 'integration', or 'e2e' */
  kind?: 'unit' | 'integration' | 'e2e';
  /** Root directory for test discovery (relative to project root) */
  root: string;
  /** Include glob patterns for test files */
  include: string[];
  /** Exclude glob patterns for test files */
  exclude?: string[];
  /** Test ignore patterns (files that should not be considered as tests) */
  testIgnore?: string[];
}

/** Waiver entry with mandatory reason */
export interface E2eWaiver {
  id: string;
  reason: string;
}

export interface ArtifactSchema {
  types: Record<string, ArtifactTypeSchema>;
  idPatterns: Record<string, string>;
  relationFields: Record<string, string[]>;
  allowedEdges: ArtifactEdgeRule[];
  forbiddenEdges: ArtifactEdgeRule[];
  statuses: string[];
  idRanges: Record<string, Record<string, { prefix: string; start: number; end: number }>>;
  /** Context resolution overrides */
  context?: {
    /** When false, skip universal baseline injection. Default: true. */
    universal_baseline?: boolean;
  };
  /** E2E coverage proof configuration */
  e2e?: {
    /** Minimum executable_ref coverage rate (0-1) for warning */
    executable_ref_warning?: number;
    /** Minimum executable_ref coverage rate (0-1) for error */
    executable_ref_error?: number;
    /** Whether to report uncovered scenarios. Default true. */
    report_uncovered_scenarios?: boolean;
    /** Whether to report uncovered features. Default true. */
    report_uncovered_features?: boolean;
    /** Scenario waivers (id + reason) from coverage requirements */
    scenario_waivers?: E2eWaiver[];
    /** Feature waivers (id + reason) from coverage requirements */
    feature_waivers?: E2eWaiver[];
    /** E2E test runner configurations */
    runners?: E2eRunnerConfig[];
  };
}

export const TARGET_ARTIFACT_TYPES = VALID_PACKET_TARGET_TYPES;
export type TargetArtifactType = typeof TARGET_ARTIFACT_TYPES[number];
export type ArtifactTypeRole = TargetArtifactType | 'context' | 'candidate' | 'not-recommended';

export interface ArtifactTypeMetadata {
  type: string;
  displayName: string;
  role: ArtifactTypeRole;
  layer: string;
  aliases: string[];
  targetCapable: boolean;
}

const NON_TARGET_ROLES = ['context', 'candidate', 'not-recommended'] as const;

export function isTargetArtifactType(type: string): type is TargetArtifactType {
  return isPacketTargetType(type);
}

function normalizeArtifactTypeRole(role: unknown): ArtifactTypeRole {
  if (typeof role === 'string') {
    if (isTargetArtifactType(role)) return role;
    if ((NON_TARGET_ROLES as readonly string[]).includes(role)) return role as ArtifactTypeRole;
  }
  return 'context';
}

export function getArtifactTypeMetadata(schema: ArtifactSchema, type: string): ArtifactTypeMetadata {
  const definition = schema.types[type];
  const role = normalizeArtifactTypeRole(definition?.role);
  const aliases = Array.isArray(definition?.aliases)
    ? definition.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
    : [];

  // Explicit target flag takes precedence for custom types;
  // legacy five core types retain their implicit targetCapable behavior.
  const legacyCoreRoleMatch = isTargetArtifactType(type) && role === type;
  const targetCapable = definition?.target === true || legacyCoreRoleMatch;

  return {
    type,
    displayName: definition?.displayName?.trim() || type,
    role,
    layer: definition?.layer?.trim() || 'context',
    aliases,
    targetCapable,
  };
}

export function getTargetArtifactTypes(schema: ArtifactSchema = DEFAULT_SCHEMA): string[] {
  // Preserve the canonical order of legacy core types first,
  // then append any additional config-driven target-capable types.
  const legacy = TARGET_ARTIFACT_TYPES.filter((type) => getArtifactTypeMetadata(schema, type).targetCapable);
  const extras = Object.keys(schema.types).filter(
    (type) => getArtifactTypeMetadata(schema, type).targetCapable && !legacy.includes(type as TargetArtifactType),
  );
  return [...legacy, ...extras];
}

/**
 * Resolve a token (which may be an exact type name or an explicit alias) to
 * the canonical artifact type name. Returns `undefined` if no match.
 *
 * Strict matching only — no automatic hyphen/underscore conversion.
 */
export function resolveArtifactTypeName(schema: ArtifactSchema, token: string): string | undefined {
  if (!token) return undefined;
  // Exact type name match
  if (schema.types[token]) return token;
  // Explicit alias match
  for (const [type, definition] of Object.entries(schema.types)) {
    if (definition.aliases?.includes(token)) return type;
  }
  return undefined;
}

export interface ArtifactGraph {
  nodes: ArtifactNode[];
  edges: ArtifactEdge[];
  generatedAt: string;
  /** Normalized absolute project root passed to scanArtifacts. Optional for backward compatibility. */
  root?: string;
  /** Scan-time diagnostics. Optional for backward compatibility with consumers that build graph literals without this field. */
  diagnostics?: ValidationIssue[];
}

export interface QueryOptions {
  from?: string;
  to?: string;
  depth?: number;
}

export type ContextTier = 'baseline' | 'target' | 'direct' | 'matrix' | 'transitive';

export interface ContextItem {
  path: string;
  reason: string;
  required?: boolean;
  tier?: ContextTier;
  reasons?: string[];
}

export interface MissingDetail {
  ref: string;
  from: string;
  kind: 'unresolved-outgoing' | 'unresolved-incoming' | 'target-not-found' | 'multiple-targets' | 'missing-baseline';
  message: string;
  suggestedAction: string;
}

export interface ContextManifest {
  schemaVersion?: string;
  target: {
    type: string;
    id: string;
    uid: string;
    title?: string;
    sourcePath?: string;
    status?: string;
  };
  context: Record<string, ContextItem[]>;
  missing: string[];
  missingDetails?: MissingDetail[];
  omitted?: ContextItem[];
  /** Explicit universal baseline policy: true=enabled, false=disabled. Used by validatePacket to prevent inferring opt-out from total=0. */
  baselinePolicy?: boolean;
}

export type ContextMode = 'full' | 'implementation';

export interface ContextOptions {
  feature?: string;
  scenario?: string;
  decision?: string;
  design?: string;
  e2e_test?: string;
  /** Unified target (type + id) resolved from `--target <type>:<id>`. Additive — old fields preserved. */
  target?: ArtifactTarget;
  mode?: ContextMode;
  maxPerCategory?: number;
  /**
   * When true (default), inject all ALWAYS_PRESENT_ITEMS as required baseline
   * and report missing ones in manifest.missing. When false, skip baseline
   * injection entirely for lightweight projects.
   */
  universalBaseline?: boolean;
  /** Project root for baseline file existence checks. Required when universalBaseline is true. */
  root?: string;
}

export const DEFAULT_SCHEMA: ArtifactSchema = {
  types: {
    decision: { paths: ['artifacts/decisions/**/*.md'], displayName: '决策文档', role: 'decision', layer: 'decision', aliases: ['decisions', 'adr'] },
    entity: { paths: ['artifacts/entities/entity-registry.md'], displayName: '实体注册表', role: 'context', layer: 'domain', aliases: ['entity-registry'] },
    feature: { paths: ['artifacts/prd/features/**/*.md'], displayName: '功能特性', role: 'feature', layer: 'prd', aliases: ['prd-feature', 'prd_features'] },
    scenario: { paths: ['artifacts/scenarios/**/*.md'], displayName: '场景剧本', role: 'scenario', layer: 'scenario', aliases: ['scenarios', 'scenario-script'] },
    design: { paths: ['artifacts/design/**/*.md'], displayName: '设计规格', role: 'design', layer: 'design', aliases: ['design-spec', 'design_docs'] },
    test: { paths: ['heimdall/packages/**/*.test.ts'], displayName: '代码注释追溯', role: 'context', layer: 'implementation', aliases: ['code-test', 'code-trace', 'unit-test'] },
    e2e_test: { paths: ['artifacts/tests/e2e/*.md'], displayName: 'E2E 测试规格', role: 'e2e_test', layer: 'verification', aliases: ['e2e-test', 'e2e_tests', 'tc'] },
    e2e_registry: { paths: ['artifacts/tests/e2e/e2e-test-registry.json'], displayName: 'E2E 测试注册表', role: 'context', layer: 'verification', aliases: ['e2e-registry'] },
    'rule-golden-cases': { paths: ['artifacts/tests/rule-golden-cases.md'], displayName: '规则黄金测试用例', role: 'context', layer: 'verification', aliases: ['rule_golden_cases'] },
    'test-strategy': { paths: ['artifacts/design/test-strategy.md'], displayName: '测试策略', role: 'context', layer: 'verification', aliases: ['test_strategy'] },
    'traceability-matrix-v2': { paths: ['artifacts/traceability-matrix-v2.md'], displayName: '追溯矩阵 v2', role: 'context', layer: 'traceability', aliases: ['traceability_matrix_v2'] },
  },
  idPatterns: {
    decision: '^D-[A-Z]+-\\d+$',
    entity: '^E-\\d{3,}$',
    feature: '^[A-Z]{1,4}\\d+$',
    scenario: '^S-\\d+[a-z]?$',
    design: '^[A-Za-z0-9._-]+$',
    test: '^.+\\.test\\.ts$',
    e2e_test: '^.+:(TC-\\d+[a-z]?|FILE)$',
    e2e_registry: '^e2e-test-registry$',
    'rule-golden-cases': '^[A-Z]+-\\d{3}:(pass|fail|edge)$',
    'test-strategy': '^(unit|integration|e2e|desktop_chain|rule|contract)$',
    'traceability-matrix-v2': '^.+$',
  },
  relationFields: {
    feature: ['scenarios', 'decisions', 'depends_on', 'design_docs'],
    scenario: ['关联功能', '关联决策'],
    design: ['related_features', 'related_scenarios'],
    test: ['@scenario', '@feature', '@entity', '@decision'],
    e2e_test: ['test_batch', 'scope', 'ac_coverage', 'related_scenarios', 'related_decisions', 'related_entities', '覆盖场景', '覆盖功能'],
    e2e_registry: ['batches'],
  },
  allowedEdges: [],
  forbiddenEdges: [{ from: 'scenario', to: 'entity', kind: 'references' }],
  statuses: ['planned', 'active', 'done', 'deprecated'],
  idRanges: {},
  e2e: {
    report_uncovered_scenarios: true,
    report_uncovered_features: true,
    runners: [],
  },
};

export async function loadConfig(root: string): Promise<ArtifactSchema> {
  const configPath = join(root, 'artifact-graph.config.yaml');
  let parsed: Partial<ArtifactSchema> = {};
  try {
    const raw = await readFile(configPath, 'utf-8');
    parsed = (yaml.load(raw) as Partial<ArtifactSchema>) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // @feature ACA17
  // @decision D-ACA-17
  // Validate universal_baseline type: must be boolean if present
  const ub = parsed.context?.universal_baseline;
  if (ub !== undefined && typeof ub !== 'boolean') {
    throw new Error(
      `Invalid context.universal_baseline: ${JSON.stringify(ub)}. Must be boolean (true or false).`
    );
  }

  // Fail-closed validation for e2e configuration
  if (parsed.e2e !== undefined) {
    if (typeof parsed.e2e !== 'object' || parsed.e2e === null || Array.isArray(parsed.e2e)) {
      throw new Error('Invalid e2e: must be an object.');
    }
    validateE2eConfig(parsed.e2e);
  }

  const mergedE2e = parsed.e2e === undefined
    ? DEFAULT_SCHEMA.e2e
    : {
        ...DEFAULT_SCHEMA.e2e,
        ...parsed.e2e,
        runners: (parsed.e2e.runners ?? DEFAULT_SCHEMA.e2e?.runners ?? []).map((runner) => ({
          kind: 'e2e' as const,
          ...runner,
        })),
      };

  const merged = {
    ...DEFAULT_SCHEMA,
    ...parsed,
    types: mergeArtifactTypes(DEFAULT_SCHEMA.types, parsed.types),
    idPatterns: mergeRecord(DEFAULT_SCHEMA.idPatterns, parsed.idPatterns),
    relationFields: mergeRecord(DEFAULT_SCHEMA.relationFields, parsed.relationFields),
    allowedEdges: parsed.allowedEdges ?? DEFAULT_SCHEMA.allowedEdges,
    forbiddenEdges: parsed.forbiddenEdges ?? DEFAULT_SCHEMA.forbiddenEdges,
    statuses: parsed.statuses ?? DEFAULT_SCHEMA.statuses,
    idRanges: mergeRecord(DEFAULT_SCHEMA.idRanges, parsed.idRanges),
    e2e: mergedE2e,
  };

  return merged;
}

/**
 * Fail-closed validation for e2e configuration.
 * Throws on invalid config to prevent silent misconfiguration.
 */
function validateE2eConfig(e2e: NonNullable<ArtifactSchema['e2e']>): void {
  for (const field of ['report_uncovered_scenarios', 'report_uncovered_features'] as const) {
    if (e2e[field] !== undefined && typeof e2e[field] !== 'boolean') {
      throw new Error(`Invalid e2e.${field}: must be boolean.`);
    }
  }
  // Validate thresholds are in 0..1
  if (e2e.executable_ref_warning !== undefined) {
    if (typeof e2e.executable_ref_warning !== 'number' || e2e.executable_ref_warning < 0 || e2e.executable_ref_warning > 1) {
      throw new Error(`Invalid e2e.executable_ref_warning: ${JSON.stringify(e2e.executable_ref_warning)}. Must be a number between 0 and 1.`);
    }
  }
  if (e2e.executable_ref_error !== undefined) {
    if (typeof e2e.executable_ref_error !== 'number' || e2e.executable_ref_error < 0 || e2e.executable_ref_error > 1) {
      throw new Error(`Invalid e2e.executable_ref_error: ${JSON.stringify(e2e.executable_ref_error)}. Must be a number between 0 and 1.`);
    }
  }

  // Validate waivers must be {id, reason} with non-empty reason
  const validateWaivers = (waivers: unknown, field: string) => {
    if (waivers === undefined) return;
    if (!Array.isArray(waivers)) {
      throw new Error(`Invalid ${field}: must be an array of {id, reason} objects.`);
    }
    for (const w of waivers) {
      if (typeof w !== 'object' || w === null || !('id' in w) || !('reason' in w)) {
        throw new Error(`Invalid ${field} entry: ${JSON.stringify(w)}. Must be {id, reason} object.`);
      }
      if (typeof (w as { id: unknown }).id !== 'string' || !(w as { id: string }).id.trim()) {
        throw new Error(`Invalid ${field} entry: id must be a non-empty string. Got: ${JSON.stringify((w as { id: unknown }).id)}`);
      }
      if (typeof (w as { reason: unknown }).reason !== 'string' || !(w as { reason: string }).reason.trim()) {
        throw new Error(`Invalid ${field} entry: reason must be a non-empty string. Got: ${JSON.stringify((w as { reason: unknown }).reason)}`);
      }
    }
  };
  validateWaivers(e2e.scenario_waivers, 'e2e.scenario_waivers');
  validateWaivers(e2e.feature_waivers, 'e2e.feature_waivers');

  // Validate runners
  if (e2e.runners !== undefined) {
    if (!Array.isArray(e2e.runners)) {
      throw new Error(`Invalid e2e.runners: must be an array.`);
    }
    for (const runner of e2e.runners) {
      if (typeof runner !== 'object' || runner === null) {
        throw new Error(`Invalid e2e.runners entry: must be an object.`);
      }
      if (typeof runner.name !== 'string' || !runner.name.trim()) {
        throw new Error(`Invalid e2e.runners entry: name must be a non-empty string.`);
      }
      if (typeof runner.root !== 'string' || !runner.root.trim()) {
        throw new Error(`Invalid e2e.runners[${runner.name}].root: must be a non-empty string.`);
      }
      // Root must not be absolute
      if (isAbsolute(runner.root)) {
        throw new Error(`Invalid e2e.runners[${runner.name}].root: "${runner.root}" must not be an absolute path.`);
      }
      // Root must not escape project (no ..)
      if (runner.root.replace(/\\/g, '/').split('/').includes('..')) {
        throw new Error(`Invalid e2e.runners[${runner.name}].root: "${runner.root}" must not contain ".." segments.`);
      }
      if (!Array.isArray(runner.include) || runner.include.length === 0) {
        throw new Error(`Invalid e2e.runners[${runner.name}].include: must be a non-empty array of glob patterns.`);
      }
      for (const pattern of runner.include) {
        if (typeof pattern !== 'string' || !pattern.trim()) {
          throw new Error(`Invalid e2e.runners[${runner.name}].include: pattern must be a non-empty string.`);
        }
      }
      if (runner.exclude !== undefined) {
        if (!Array.isArray(runner.exclude)) {
          throw new Error(`Invalid e2e.runners[${runner.name}].exclude: must be an array.`);
        }
        for (const pattern of runner.exclude) {
          if (typeof pattern !== 'string' || !pattern.trim()) {
            throw new Error(`Invalid e2e.runners[${runner.name}].exclude: pattern must be a non-empty string.`);
          }
        }
      }
      if (runner.testIgnore !== undefined) {
        if (!Array.isArray(runner.testIgnore)) {
          throw new Error(`Invalid e2e.runners[${runner.name}].testIgnore: must be an array.`);
        }
        for (const pattern of runner.testIgnore) {
          if (typeof pattern !== 'string' || !pattern.trim()) {
            throw new Error(`Invalid e2e.runners[${runner.name}].testIgnore: pattern must be a non-empty string.`);
          }
        }
      }
      // Validate kind if present
      if (runner.kind !== undefined) {
        if (!['unit', 'integration', 'e2e'].includes(runner.kind)) {
          throw new Error(`Invalid e2e.runners[${runner.name}].kind: "${runner.kind}". Must be unit, integration, or e2e.`);
        }
      }
    }
  }
}

export function buildGraph(nodes: Omit<ArtifactNode, 'uid'>[], edges: ArtifactEdge[], diagnostics: ValidationIssue[] = [], root?: string): ArtifactGraph {
  const graphNodes = nodes.map((node) => ({ ...node, uid: toUid(node.type, node.code) }));
  graphNodes.sort(compareNode);
  edges.sort(compareEdge);
  // Deduplicate edges by (from, to, kind, source, sourcePath, sourceLine) — preserve different evidence sources
  const seen = new Set<string>();
  const dedupedEdges: ArtifactEdge[] = [];
  for (const e of edges) {
    const key = `${e.from}\t${e.to}\t${e.kind}\t${e.source}\t${e.sourcePath}\t${e.sourceLine}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedEdges.push(e);
    }
  }
  return {
    nodes: graphNodes,
    edges: dedupedEdges,
    generatedAt: new Date(0).toISOString(),
    ...(root ? { root } : {}),
    diagnostics: diagnostics.sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path) || left.line - right.line),
  };
}

export async function scanArtifacts(root: string, schema?: ArtifactSchema): Promise<ArtifactGraph> {
  const config = schema ?? await loadConfig(root);
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  const scanDiagnostics: ValidationIssue[] = [];
  const scannedFiles = new Map<string, string>(); // file → type that claimed it

  for (const [type, definition] of artifactTypeEntriesBySpecificity(config)) {
    const files = await findFiles(root, definition.paths);
    for (const file of files) {
      if (scannedFiles.has(file)) {
        const existingType = scannedFiles.get(file)!;
        scanDiagnostics.push(issue(
          'ARTIFACT_PATH_OVERLAP',
          `File ${file} matched by both ${existingType} and ${type}; using most specific type`,
          file,
          1,
          { severity: 'warning' },
        ));
        continue;
      }
      scannedFiles.set(file, type);
      const raw = await readFile(join(root, file), 'utf-8');
      const parsed = parseFile(type, file, raw, config);
      nodes.push(...parsed.nodes);
      edges.push(...parsed.edges);
      scanDiagnostics.push(...parsed.diagnostics);
    }
  }

  const absoluteRoot = isAbsolute(root) ? root : resolve(root);
  const graph = buildGraph(nodes, edges, scanDiagnostics, absoluteRoot);
  return resolveMatrixEdges(graph);
}

function artifactTypeEntriesBySpecificity(schema: ArtifactSchema): Array<[string, ArtifactTypeSchema]> {
  return Object.entries(schema.types).sort((left, right) => {
    const specificity = artifactTypePathSpecificity(right[1]) - artifactTypePathSpecificity(left[1]);
    return specificity !== 0 ? specificity : left[0].localeCompare(right[0]);
  });
}

function artifactTypePathSpecificity(definition: ArtifactTypeSchema): number {
  return Math.max(...definition.paths.map((pathPattern: string) => {
    const wildcardPenalty = (pathPattern.match(/\*/g) ?? []).length * 1000;
    const exactBonus = pathPattern.includes('*') ? 0 : 100000;
    return exactBonus + pathPattern.length - wildcardPenalty;
  }), 0);
}

/**
 * Resolve traceability-matrix-v2 edges:
 * 1. Edges pointing to matrix-row targets (traceability-matrix-v2:*) are kept as-is.
 * 2. Unresolved refs (`resolve:BARE_ID`) are resolved to real artifact nodes when possible,
 *    otherwise left as `resolve:BARE_ID` (which becomes a DANGLING_REFERENCE in validateGraph).
 */
export function resolveMatrixEdges(graph: ArtifactGraph): ArtifactGraph {
  // Build lookup: bare ID -> real artifact UID
  const idToArtifact = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.type === 'traceability-matrix-v2') continue;
    const bare = node.code;
    if (bare && !idToArtifact.has(bare)) {
      idToArtifact.set(bare, node.uid);
    }
  }

  // Also build matrix bare-ID lookup: matrix row code "layer:id" → bare ID
  const matrixCodeToBareId = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.type === 'traceability-matrix-v2') {
      const attrs = node.attrs as Record<string, string> | undefined;
      if (attrs?.id) {
        matrixCodeToBareId.set(node.code, attrs.id);
      }
    }
  }

  const resolved: ArtifactEdge[] = [];
  for (const e of graph.edges) {
    // 1. Resolve `resolve:` prefixed edges to real artifacts or classify as external
    if (e.to.startsWith('resolve:')) {
      const bareId = e.to.slice('resolve:'.length);
      // External ADR references (ADR-NNN) are not artifact graph nodes — skip edge
      if (/^ADR-\d+$/i.test(bareId)) continue;
      // Bare filenames with extensions are file refs, not artifact edges — skip edge
      if (/\.\w+$/.test(bareId)) continue;
      // Try to resolve to a real artifact UID
      const artifactUid = idToArtifact.get(bareId);
      resolved.push({ ...e, to: artifactUid ?? e.to });
      continue;
    }
    resolved.push(e);

    // 2. For matrix-to-matrix edges, add cross-artifact edges to real artifact nodes
    if (e.from.startsWith('traceability-matrix-v2:') && e.to.startsWith('traceability-matrix-v2:')) {
      const targetMatrixCode = e.to.slice('traceability-matrix-v2:'.length);
      const targetBareId = matrixCodeToBareId.get(targetMatrixCode);
      if (targetBareId) {
        const artifactUid = idToArtifact.get(targetBareId);
        if (artifactUid) {
          resolved.push({ ...e, to: artifactUid });
        }
      }
    }
  }

  return { ...graph, edges: resolved };
}

export function validateGraph(graph: ArtifactGraph, schema: ArtifactSchema = DEFAULT_SCHEMA): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byUid = new Map<string, ArtifactNode[]>();
  for (const node of graph.nodes) {
    const bucket = byUid.get(node.uid) ?? [];
    bucket.push(node);
    byUid.set(node.uid, bucket);
  }

  for (const duplicates of byUid.values()) {
    if (duplicates.length > 1) {
      for (const node of duplicates) {
        issues.push(issue('DUPLICATE_ID', `Duplicate artifact ID ${node.uid}`, node.path, node.line, {
          node: node.uid,
          severity: node.type.startsWith('e2e_') ? 'warning' : 'error',
        }));
      }
    }
  }

  for (const node of graph.nodes) {
    const pattern = schema.idPatterns[node.type];
    if (pattern && !new RegExp(pattern).test(node.code)) {
      issues.push(issue('INVALID_ID', `Artifact ${node.uid} does not match ${pattern}`, node.path, node.line, { node: node.uid }));
    }
    if (node.status && schema.statuses.length > 0 && !schema.statuses.includes(node.status)) {
      issues.push(issue('INVALID_STATUS', `Artifact ${node.uid} has invalid status "${node.status}"`, node.path, node.line, { node: node.uid }));
    }
    if (node.type === 'feature' && Object.prototype.hasOwnProperty.call(node.attrs ?? {}, 'entities')) {
      issues.push(issue(
        'FEATURE_ENTITY_FIELD_FORBIDDEN',
        'Feature frontmatter must not declare entities; entity traceability belongs in design specs and code comments',
        node.path,
        node.line,
        { node: node.uid },
      ));
    }
  }

  for (const edge of graph.edges) {
    if (!byUid.has(edge.to)) {
      issues.push(issue('DANGLING_REFERENCE', `Reference target ${edge.to} does not exist`, edge.sourcePath, edge.sourceLine, {
        edge,
        severity: edge.from.startsWith('e2e_test:') ? 'warning' : 'error',
      }));
    }
    const fromType = edge.from.split(':', 1)[0] ?? '';
    const toType = edge.to.split(':', 1)[0] ?? '';
    if (schema.forbiddenEdges.some((rule) => rule.from === fromType && rule.to === toType && rule.kind === edge.kind)) {
      issues.push(issue('FORBIDDEN_EDGE', `Forbidden ${fromType} -> ${toType} ${edge.kind} relation`, edge.sourcePath, edge.sourceLine, { edge }));
    }
  }

  issues.push(...validateE2eTests(graph));
  issues.push(...validateE2eRegistry(graph));
  issues.push(...validateScenarioPrdLinks(graph, schema));
  issues.push(...validateCodeCommentTraceabilityFormat(graph));
  issues.push(...validateCodeCommentScenarioFeatureConsistency(graph));

  for (const edge of graph.edges) {
    if (edge.kind !== 'covers' || !edge.from.startsWith('feature:') || !edge.to.startsWith('scenario:')) {
      continue;
    }
    const reverseExists = graph.edges.some((candidate) => (
      candidate.from === edge.to
      && candidate.to === edge.from
      && candidate.kind === 'references'
    ));
    if (!reverseExists) {
      issues.push(issue('BIDIRECTIONAL_MISMATCH', `${edge.from} lists ${edge.to}, but reverse scenario relation is missing`, edge.sourcePath, edge.sourceLine, { edge }));
    }
  }

  for (const edge of graph.edges) {
    if (edge.kind !== 'references' || !edge.from.startsWith('scenario:') || !edge.to.startsWith('feature:')) {
      continue;
    }
    const reverseExists = graph.edges.some((candidate) => (
      candidate.from === edge.to
      && candidate.to === edge.from
      && candidate.kind === 'covers'
    ));
    if (!reverseExists) {
      issues.push(issue('BIDIRECTIONAL_MISMATCH', `${edge.from} references ${edge.to}, but PRD feature does not list the scenario`, edge.sourcePath, edge.sourceLine, { edge }));
    }
  }

  for (const edge of graph.edges) {
    if (edge.kind !== 'references' || !edge.from.startsWith('feature:') || !edge.to.startsWith('design:')) {
      continue;
    }
    const reverseExists = graph.edges.some((candidate) => (
      candidate.from === edge.to
      && candidate.to === edge.from
      && candidate.kind === 'references'
    ));
    if (!reverseExists) {
      issues.push(issue('BIDIRECTIONAL_MISMATCH', `${edge.from} lists ${edge.to}, but reverse design relation is missing`, edge.sourcePath, edge.sourceLine, { edge }));
    }
  }

  for (const edge of graph.edges) {
    if (edge.kind !== 'references' || !edge.from.startsWith('design:') || !edge.to.startsWith('feature:')) {
      continue;
    }
    const reverseExists = graph.edges.some((candidate) => (
      candidate.from === edge.to
      && candidate.to === edge.from
      && candidate.kind === 'references'
    ));
    if (!reverseExists) {
      issues.push(issue('BIDIRECTIONAL_MISMATCH', `${edge.from} references ${edge.to}, but PRD feature does not list the design doc`, edge.sourcePath, edge.sourceLine, { edge }));
    }
  }

  for (const node of graph.nodes) {
    if (node.type !== 'feature') {
      continue;
    }
    const hasDesignLink = graph.edges.some((edgeValue) => (
      edgeValue.kind === 'references'
      && (
        (edgeValue.from === node.uid && edgeValue.to.startsWith('design:'))
        || (edgeValue.to === node.uid && edgeValue.from.startsWith('design:'))
      )
    ));
    if (!hasDesignLink) {
      issues.push(issue('DESIGN_COVERAGE_MISSING', `${node.uid} has no linked design spec`, node.path, node.line, { node: node.uid, severity: 'warning' }));
    }
  }

  for (const cycle of findDependsOnCycles(graph)) {
    issues.push(issue('CYCLE_DETECTED', `depends_on cycle detected: ${cycle.join(' -> ')}`, '', 1, { node: cycle[0] }));
  }

  // Check for isolated custom artifacts (config-registered types without dedicated parsers and with no edges)
  const defaultTypeKeys = new Set(Object.keys(DEFAULT_SCHEMA.types));
  const specializedParserTypes = new Set([
    'feature', 'scenario', 'entity', 'decision', 'test', 'design',
    'e2e_test', 'e2e_registry',
    'rule-golden-cases', 'test-strategy', 'traceability-matrix-v2',
    'traceability-version-lock',
    'interface_contracts', 'data_contracts', 'application_state_machines', 'error_model',
    'domain-glossary', 'bounded-context-map', 'domain-invariants',
    'generation-packet-spec',
    'report-contracts', 'verification-fixtures', 'ui-flow-contracts',
    'non-functional-budgets',
    'implementation-blueprint',
  ]);
  const uidsWithEdges = new Set<string>();
  for (const edge of graph.edges) {
    uidsWithEdges.add(edge.from);
    uidsWithEdges.add(edge.to);
  }
  for (const node of graph.nodes) {
    if (defaultTypeKeys.has(node.type)) continue;
    if (specializedParserTypes.has(node.type)) continue;
    // Only flag types that are registered in the current schema (i.e. config-registered custom types)
    if (!schema.types[node.type]) continue;
    if (!uidsWithEdges.has(node.uid)) {
      issues.push(issue(
        'CUSTOM_ARTIFACT_ISOLATED',
        `Custom artifact ${node.uid} has no incoming or outgoing traceability edges`,
        node.path,
        node.line,
        { node: node.uid, severity: 'warning' },
      ));
    }
  }

  // Merge scan diagnostics from the graph
  issues.push(...(graph.diagnostics ?? []));

  issues.sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path) || left.line - right.line);
  return issues;
}

export function validateScenarioPrdLinks(graph: ArtifactGraph, schema: ArtifactSchema = DEFAULT_SCHEMA): ValidationIssue[] {
  if (!schema.relationFields.scenario?.includes('关联功能') || !schema.relationFields.feature?.includes('scenarios')) {
    return [];
  }

  const issues: ValidationIssue[] = [];
  const featurePattern = new RegExp(schema.idPatterns.feature ?? DEFAULT_SCHEMA.idPatterns.feature);
  const scenarioPattern = new RegExp(schema.idPatterns.scenario ?? DEFAULT_SCHEMA.idPatterns.scenario);
  const scenarioNodes = graph.nodes.filter((node) => node.type === 'scenario');
  const featureNodes = graph.nodes.filter((node) => node.type === 'feature');
  const scenarioMap = new Map(scenarioNodes.map((node) => [node.uid, node]));
  const featureMap = new Map(featureNodes.map((node) => [node.uid, node]));
  const scenarioFeatureRefs = new Map<string, RelationOccurrence[]>();
  const featureScenarioRefs = new Map<string, RelationOccurrence[]>();

  for (const node of scenarioNodes) {
    scenarioFeatureRefs.set(node.uid, relationOccurrences(node, '关联功能', 'feature'));
    if (!scenarioPattern.test(node.code)) {
      issues.push(issue('FORMAT_ERROR', `scenario ID ${node.code} does not match ${schema.idPatterns.scenario}`, node.path, node.line, { node: node.uid }));
    }
  }
  for (const node of featureNodes) {
    featureScenarioRefs.set(node.uid, relationOccurrences(node, 'scenarios', 'scenario'));
    if (!featurePattern.test(node.code)) {
      issues.push(issue('FORMAT_ERROR', `feature ID ${node.code} does not match ${schema.idPatterns.feature}`, node.path, node.line, { node: node.uid }));
    }
  }

  for (const [scenarioUid, refs] of scenarioFeatureRefs) {
    const node = scenarioMap.get(scenarioUid);
    if (!node) continue;
    const validRefs = refs.filter((ref) => featurePattern.test(ref.target));
    if (validRefs.length === 0) {
      issues.push(issue('ORPHAN_SCENARIO', `${scenarioUid} has no linked PRD feature`, node.path, node.line, { node: scenarioUid, severity: 'warning' }));
    }
    pushDuplicateIssues(issues, scenarioUid, validRefs, 'feature');
    for (const ref of refs) {
      if (!featurePattern.test(ref.target)) {
        issues.push(issue('FORMAT_ERROR', `scenario ${scenarioUid} has invalid feature reference ${ref.target}`, ref.path, ref.line, { node: scenarioUid }));
      }
    }
  }

  for (const [featureUid, refs] of featureScenarioRefs) {
    const node = featureMap.get(featureUid);
    if (!node) continue;
    const validRefs = refs.filter((ref) => scenarioPattern.test(ref.target));
    if (validRefs.length === 0 && node.status !== 'planned' && node.status !== 'deprecated') {
      issues.push(issue('ORPHAN_FEATURE', `${featureUid} has no linked scenario`, node.path, node.line, { node: featureUid, severity: 'warning' }));
    }
    pushDuplicateIssues(issues, featureUid, validRefs, 'scenario');
    for (const ref of refs) {
      if (!scenarioPattern.test(ref.target)) {
        issues.push(issue('FORMAT_ERROR', `feature ${featureUid} has invalid scenario reference ${ref.target}`, ref.path, ref.line, { node: featureUid }));
      }
    }
  }

  for (const [scenarioUid, refs] of scenarioFeatureRefs) {
    for (const ref of refs) {
      if (!featurePattern.test(ref.target)) continue;
      const featureUid = toUid('feature', ref.target);
      if (!featureMap.has(featureUid)) continue;
      const reverseRefs = featureScenarioRefs.get(featureUid) ?? [];
      if (!reverseRefs.some((reverse) => toUid('scenario', reverse.target) === scenarioUid)) {
        issues.push(issue(
          'LINK_FORWARD_MISSING',
          `${scenarioUid} references ${featureUid}, but ${featureUid}.scenarios does not include ${scenarioUid}`,
          ref.path,
          ref.line,
          { node: scenarioUid },
        ));
      }
    }
  }

  for (const [featureUid, refs] of featureScenarioRefs) {
    for (const ref of refs) {
      if (!scenarioPattern.test(ref.target)) continue;
      const scenarioUid = toUid('scenario', ref.target);
      if (!scenarioMap.has(scenarioUid)) continue;
      const reverseRefs = scenarioFeatureRefs.get(scenarioUid) ?? [];
      if (!reverseRefs.some((reverse) => toUid('feature', reverse.target) === featureUid)) {
        issues.push(issue(
          'LINK_BACKWARD_MISSING',
          `${featureUid} covers ${scenarioUid}, but ${scenarioUid} does not reference ${featureUid}`,
          ref.path,
          ref.line,
          { node: featureUid },
        ));
      }
    }
  }

  return issues;
}

export async function validateScenarioPrdLinkIndex(root: string, graph: ArtifactGraph): Promise<ValidationIssue[]> {
  const indexPath = 'artifacts/prd/feature-index.md';
  let raw = '';
  try {
    raw = await readFile(join(root, indexPath), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const featureNodes = new Map(graph.nodes.filter((node) => node.type === 'feature').map((node) => [node.code, node]));
  const issues: ValidationIssue[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    const match = /\|\s*\[([A-Z]{1,4}\d+)\]\([^)]*\)\s*\|[^|]*\|[^|]*\|[^|]*\|\s*(\d+)\s*\|/.exec(line);
    if (!match) {
      return;
    }
    const featureCode = match[1];
    const expectedCount = Number(match[2]);
    const feature = featureNodes.get(featureCode);
    if (!feature) {
      return;
    }
    const actualCount = relationOccurrences(feature, 'scenarios', 'scenario').length;
    if (actualCount !== expectedCount) {
      issues.push(issue(
        'INDEX_MISMATCH',
        `feature:${featureCode} index scenario count=${expectedCount}, actual=${actualCount}`,
        indexPath,
        index + 1,
        { node: feature.uid, severity: 'warning' },
      ));
    }
  });

  return issues;
}


function validateCodeCommentTraceabilityFormat(graph: ArtifactGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const node of graph.nodes) {
    if (node.type !== 'test' && node.type !== 'implementation') {
      continue;
    }
    const invalidComments = node.attrs?.invalidTraceabilityComments;
    if (Array.isArray(invalidComments)) {
      for (const invalid of invalidComments) {
        const line = typeof invalid?.line === 'number' ? invalid.line : node.line;
        const reason = typeof invalid?.reason === 'string' ? invalid.reason : 'traceability tags must use standalone // comments';
        issues.push(issue(
          'CODE_COMMENT_TRACEABILITY_FORMAT',
          `${reason}: ${typeof invalid?.text === 'string' ? invalid.text : ''}`.trim(),
          node.path,
          line,
          { node: node.uid },
        ));
      }
    }
    const deprecatedComments = node.attrs?.deprecatedTraceabilityComments;
    if (Array.isArray(deprecatedComments)) {
      for (const deprecated of deprecatedComments) {
        issues.push(issue(
          'E2E-TRACE-007',
          '@tc is deprecated; use @e2e_test instead',
          node.path,
          typeof deprecated?.line === 'number' ? deprecated.line : node.line,
          { node: node.uid, severity: 'warning' },
        ));
      }
    }
  }
  return issues;
}

function validateCodeCommentScenarioFeatureConsistency(graph: ArtifactGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const scenarioToFeatures = new Map<string, Set<string>>();

  for (const edgeValue of graph.edges) {
    if (edgeValue.kind === 'references' && edgeValue.from.startsWith('scenario:') && edgeValue.to.startsWith('feature:')) {
      const features = scenarioToFeatures.get(edgeValue.from) ?? new Set<string>();
      features.add(edgeValue.to);
      scenarioToFeatures.set(edgeValue.from, features);
    }
    if (edgeValue.kind === 'covers' && edgeValue.from.startsWith('feature:') && edgeValue.to.startsWith('scenario:')) {
      const features = scenarioToFeatures.get(edgeValue.to) ?? new Set<string>();
      features.add(edgeValue.from);
      scenarioToFeatures.set(edgeValue.to, features);
    }
  }

  const groups = new Map<string, { path: string; line: number; scenarios: ArtifactEdge[]; features: ArtifactEdge[] }>();
  for (const edgeValue of graph.edges) {
    if (edgeValue.source !== 'test-comment' || edgeValue.kind !== 'verifies') {
      continue;
    }
    const targetType = edgeValue.to.split(':', 1)[0] ?? '';
    if (targetType !== 'scenario' && targetType !== 'feature') {
      continue;
    }
    const key = `${edgeValue.sourcePath}:${edgeValue.sourceLine}`;
    const group = groups.get(key) ?? { path: edgeValue.sourcePath, line: edgeValue.sourceLine, scenarios: [], features: [] };
    if (targetType === 'scenario') {
      group.scenarios.push(edgeValue);
    } else {
      group.features.push(edgeValue);
    }
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.scenarios.length === 0 || group.features.length === 0) {
      continue;
    }
    const annotatedFeatures = new Set(group.features.map((edgeValue) => edgeValue.to));
    if (group.scenarios.length > 1 && annotatedFeatures.size > 1) {
      issues.push(issue(
        'CODE_COMMENT_AMBIGUOUS_TRACEABILITY',
        'Code traceability comment must not mix multiple scenarios with multiple features on one line; split into one mapping per line',
        group.path,
        group.line,
        { edge: group.scenarios[0] },
      ));
      continue;
    }
    for (const scenarioEdge of group.scenarios) {
      const expectedFeatures = scenarioToFeatures.get(scenarioEdge.to);
      if (!expectedFeatures || expectedFeatures.size === 0) {
        continue;
      }
      const hasMatchingFeature = [...expectedFeatures].some((featureUid) => annotatedFeatures.has(featureUid));
      if (!hasMatchingFeature) {
        issues.push(issue(
          'CODE_COMMENT_SCENARIO_FEATURE_MISMATCH',
          `${scenarioEdge.to} is linked to ${[...expectedFeatures].join(', ')}, but code comment lists ${[...annotatedFeatures].join(', ')}`,
          group.path,
          group.line,
          { edge: scenarioEdge },
        ));
      }
    }
  }

  return issues;
}

export function queryGraph(graph: ArtifactGraph, options: QueryOptions): ArtifactGraph {
  const depth = options.depth ?? 1;
  const start = normalizeUid(options.from ?? options.to ?? '');
  const reverse = Boolean(options.to && !options.from);
  const selected = new Set<string>([start]);
  let frontier = new Set<string>([start]);

  for (let level = 0; level < depth; level += 1) {
    const next = new Set<string>();
    for (const edge of graph.edges) {
      if (!reverse && frontier.has(edge.from)) {
        next.add(edge.to);
      }
      if (!reverse && frontier.has(edge.to)) {
        next.add(edge.from);
      }
      if (reverse && frontier.has(edge.to)) {
        next.add(edge.from);
      }
    }
    for (const uid of next) {
      selected.add(uid);
    }
    frontier = next;
  }

  const nodes = graph.nodes.filter((node) => selected.has(node.uid));
  const edges = graph.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to));
  return { ...graph, nodes, edges };
}

export function renderMermaid(graph: ArtifactGraph): string {
  const lines = ['graph LR'];
  for (const node of graph.nodes) {
    lines.push(`  "${node.uid}"["${node.uid}<br/>${escapeMermaid(node.title)}"]`);
  }
  for (const edge of graph.edges) {
    lines.push(`  "${edge.from}" -->|"${edge.kind}"| "${edge.to}"`);
  }
  return `${lines.join('\n')}\n`;
}

export function nextId(graph: ArtifactGraph, schema: ArtifactSchema, type: string, rangeName: string): string {
  const range = schema.idRanges[type]?.[rangeName];
  if (!range) {
    throw new Error(`Unknown ID range ${type}.${rangeName}`);
  }
  const used = new Set(
    graph.nodes
      .filter((node) => node.type === type && node.code.startsWith(range.prefix))
      .map((node) => Number(node.code.slice(range.prefix.length).replace(/\D+$/, ''))),
  );
  for (let id = range.start; id <= range.end; id += 1) {
    if (!used.has(id)) {
      return `${range.prefix}${id}`;
    }
  }
  throw new Error(`ID range ${type}.${rangeName} is exhausted`);
}

export async function writeGraphCache(root: string, graph: ArtifactGraph): Promise<void> {
  const cacheDir = join(root, '.artifact-graph');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, 'index.json'), `${JSON.stringify(graph, null, 2)}\n`);

  const db = new Database(join(cacheDir, 'graph.sqlite'));
  try {
    db.exec(`
      DROP TABLE IF EXISTS nodes;
      DROP TABLE IF EXISTS edges;
      CREATE TABLE nodes (
        uid TEXT NOT NULL,
        type TEXT NOT NULL,
        code TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        status TEXT,
        attrs TEXT,
        aliases TEXT
      );
      CREATE TABLE edges (
        from_uid TEXT NOT NULL,
        to_uid TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_line INTEGER NOT NULL
      );
    `);
    const insertNode = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertEdge = db.prepare('INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
      for (const node of graph.nodes) {
        insertNode.run(node.uid, node.type, node.code, node.title, node.path, node.line, node.status ?? null, JSON.stringify(node.attrs ?? {}), JSON.stringify(node.aliases ?? []));
      }
      for (const edge of graph.edges) {
        insertEdge.run(edge.from, edge.to, edge.kind, edge.source, edge.sourcePath, edge.sourceLine);
      }
    });
    tx();
  } finally {
    db.close();
  }
}

interface ParsedArtifactFile {
  nodes: Omit<ArtifactNode, 'uid'>[];
  edges: ArtifactEdge[];
  diagnostics: ValidationIssue[];
}

function parseFile(type: string, path: string, raw: string, schema: ArtifactSchema = DEFAULT_SCHEMA): ParsedArtifactFile {
  if (type === 'feature') {
    return { ...parseFeature(path, raw), diagnostics: [] };
  }
  if (type === 'scenario') {
    return { ...parseScenarios(path, raw, schema), diagnostics: [] };
  }
  if (type === 'entity') {
    return { ...parseEntityRegistry(path, raw), diagnostics: [] };
  }
  if (type === 'decision') {
    return { ...parseDecisions(path, raw), diagnostics: [] };
  }
  if (type === 'test') {
    return { ...parseTest(path, raw, schema), diagnostics: [] };
  }
  if (type === 'design') {
    return { ...parseDesign(path, raw), diagnostics: [] };
  }
  if (type === 'e2e_test') {
    return { ...parseE2eTest(path, raw), diagnostics: [] };
  }
  if (type === 'e2e_registry') {
    return { ...parseE2eRegistry(path, raw), diagnostics: [] };
  }
  if (type === 'interface_contracts' || type === 'data_contracts' || type === 'application_state_machines' || type === 'error_model') {
    return { ...parseContractTable(type, path, raw), diagnostics: [] };
  }
  if (type === 'domain-glossary') {
    return { ...parseDomainGlossary(path, raw), diagnostics: [] };
  }
  if (type === 'bounded-context-map') {
    return { ...parseBoundedContextMap(path, raw), diagnostics: [] };
  }
  if (type === 'domain-invariants') {
    return { ...parseContractTable(type, path, raw), diagnostics: [] };
  }
  if (type === 'generation-packet-spec') {
    return { ...parseGenerationPacketSpec(path, raw), diagnostics: [] };
  }
  if (type === 'rule-golden-cases') {
    return { ...parseRuleGoldenCases(path, raw), diagnostics: [] };
  }
  if (type === 'test-strategy') {
    return { ...parseTestStrategy(path, raw), diagnostics: [] };
  }
  if (type === 'traceability-matrix-v2') {
    return { ...parseTraceabilityMatrixV2(path, raw), diagnostics: [] };
  }
  if (type === 'traceability-version-lock') {
    return { ...parseTraceabilityVersionLock(path, raw), diagnostics: [] };
  }
  if (type === 'report-contracts') {
    return { ...parseReportContracts(path, raw), diagnostics: [] };
  }
  if (type === 'verification-fixtures') {
    return { ...parseVerificationFixtures(path, raw), diagnostics: [] };
  }
  if (type === 'ui-flow-contracts') {
    return { ...parseUIFlowContracts(path, raw), diagnostics: [] };
  }
  if (type === 'non-functional-budgets') {
    return { ...parseNonFunctionalBudgets(path, raw), diagnostics: [] };
  }
  if (type === 'implementation-blueprint') {
    return { ...parseImplementationBlueprint(path, raw), diagnostics: [] };
  }
  // Generic fallback for registered types without a dedicated parser
  return parseGenericMarkdown(type, path, raw, schema);
}

function parseGenericMarkdown(type: string, path: string, raw: string, schema: ArtifactSchema): ParsedArtifactFile {
  const diagnostics: ValidationIssue[] = [];
  const ext = extname(path).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') {
    diagnostics.push(issue(
      'UNSUPPORTED_FORMAT',
      `Generic parser only supports .md/.markdown files, got ${ext}`,
      path,
      1,
      { severity: 'warning' },
    ));
    return { nodes: [], edges: [], diagnostics };
  }

  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const code = String(data.id ?? '').trim();

  if (!code) {
    diagnostics.push(issue(
      'ARTIFACT_ID_MISSING',
      `Artifact of type ${type} at ${path} has no id in frontmatter`,
      path,
      1,
      { severity: 'warning' },
    ));
    return { nodes: [], edges: [], diagnostics };
  }

  const idPattern = schema.idPatterns[type];
  if (idPattern && !new RegExp(idPattern).test(code)) {
    diagnostics.push(issue(
      'INVALID_ID',
      `Artifact ${type}:${code} does not match ${idPattern}`,
      path,
      1,
      { node: toUid(type, code) },
    ));
  }

  const title = String(data.title ?? headingTitle(raw, code) ?? code);
  const typeDef = schema.types[type];
  const extraFields = typeDef?.extraFields ?? [];
  const indexedFields: Record<string, unknown> = {};

  for (const field of extraFields) {
    const value = data[field.name];
    if (value === undefined) continue;

    let mismatch = false;
    switch (field.type) {
      case 'string':
        if (typeof value !== 'string') mismatch = true;
        break;
      case 'number':
        if (typeof value !== 'number') mismatch = true;
        break;
      case 'boolean':
        if (typeof value !== 'boolean') mismatch = true;
        break;
      case 'enum':
        if (!field.enum?.includes(value as string | number | boolean)) mismatch = true;
        break;
    }

    if (mismatch) {
      diagnostics.push(issue(
        'EXTRA_FIELD_TYPE_MISMATCH',
        `Field ${field.name} expects ${field.type}${field.type === 'enum' ? ` [${field.enum?.join(', ')}]` : ''} but got ${JSON.stringify(value)}`,
        path,
        1,
        { node: toUid(type, code), severity: 'warning' },
      ));
    } else {
      indexedFields[field.name] = value;
    }
  }

  // Build edges from related_* frontmatter fields
  const edges: ArtifactEdge[] = [];
  for (const [fieldKey, fieldValue] of Object.entries(data)) {
    if (!fieldKey.startsWith('related_')) continue;
    const suffix = fieldKey.slice('related_'.length);
    const resolvedType = resolveArtifactTypeName(schema, suffix);
    if (!resolvedType) continue;
    const targets = toArray(fieldValue);
    const targetPattern = schema.idPatterns[resolvedType];
    for (const target of targets) {
      const targetCode = String(target).trim();
      if (!targetCode) continue;
      if (targetPattern && !new RegExp(targetPattern).test(targetCode)) {
        diagnostics.push(issue(
          'INVALID_ID',
          `Relation target ${resolvedType}:${targetCode} in ${fieldKey} does not match ${targetPattern}`,
          path,
          1,
          { node: toUid(type, code) },
        ));
        continue;
      }
      edges.push(edge(toUid(type, code), toUid(resolvedType, targetCode), 'references', 'frontmatter', path, 1));
    }
  }

  const node: Omit<ArtifactNode, 'uid'> = {
    type,
    code,
    title,
    path,
    line: 1,
    status: typeof data.status === 'string' ? data.status : undefined,
    attrs: {
      rawFrontmatter: data,
      indexedFields,
    },
  };

  return { nodes: [node], edges, diagnostics };
}

function parseFeature(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const code = String(data.id ?? '').trim();
  if (!code) {
    return { nodes: [], edges: [] };
  }
  const title = String(data.title ?? headingTitle(raw, code) ?? code);
  const node = {
    type: 'feature',
    code,
    title,
    path,
    line: 1,
    status: typeof data.status === 'string' ? data.status : undefined,
    attrs: {
      ...data,
      acceptanceCriteria: parseAcceptanceCriteria(raw),
      relationOccurrences: {
        scenarios: frontmatterRelationOccurrences(path, 'scenarios', data.scenarios, 'scenario'),
      },
    },
  };
  const edges: ArtifactEdge[] = [
    ...frontmatterEdges(path, code, data.scenarios, 'scenario', 'covers'),
    ...frontmatterEdges(path, code, data.decisions, 'decision', 'references'),
    ...frontmatterEdges(path, code, data.depends_on, 'feature', 'depends_on'),
    ...frontmatterEdges(path, code, data.design_docs, 'design', 'references', normalizeDesignCode),
  ];
  return { nodes: [node], edges };
}

function parseScenarios(path: string, raw: string, schema: ArtifactSchema = DEFAULT_SCHEMA): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const lines = raw.split(/\r?\n/);
  const starts: Array<{ code: string; title: string; line: number; index: number }> = [];
  lines.forEach((line, index) => {
    const match = /^#{2,3}\s+(S-\d+[a-z]?)\s*[:：]\s*(.+?)\s*$/.exec(line);
    if (match) {
      starts.push({ code: match[1], title: match[2], line: index + 1, index });
    }
  });

  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = starts[i + 1]?.index ?? lines.length;
    const block = lines.slice(start.index, end);
    const featureRefs = markdownRelationOccurrences(path, start, block, '关联功能', 'feature');
    const decisionRefs = markdownRelationOccurrences(path, start, block, '关联决策', 'decision');
    const entityRefs = markdownRelationOccurrences(path, start, block, '关联实体', 'entity');
    nodes.push({
      type: 'scenario',
      code: start.code,
      title: start.title,
      path,
      line: start.line,
      attrs: {
        relationOccurrences: {
          '关联功能': featureRefs,
          '关联决策': decisionRefs,
          '关联实体': entityRefs,
        },
      },
    });
    edges.push(...featureRefs.filter(isValidRelationOccurrence).map((ref) => edge(toUid('scenario', start.code), toUid('feature', ref.target), 'references', 'markdown', path, ref.line)));
    edges.push(...decisionRefs.filter(isValidRelationOccurrence).map((ref) => edge(toUid('scenario', start.code), toUid('decision', ref.target), 'references', 'markdown', path, ref.line)));
    edges.push(...entityRefs.filter(isValidRelationOccurrence).map((ref) => edge(toUid('scenario', start.code), toUid('entity', ref.target), 'references', 'markdown', path, ref.line)));
  }
  return { nodes, edges };
}

function parseEntityRegistry(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    const match = /^\|\s*(E-\d{3,})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|.*?\|\s*([^|]+?)\s*\|/.exec(line);
    if (!match) {
      return;
    }
    const code = match[1].trim();
    nodes.push({ type: 'entity', code, title: match[2].trim(), path, line: index + 1, attrs: { entityType: match[3].trim() } });
    for (const decision of extractCodes(match[4], 'decision')) {
      edges.push(edge(toUid('entity', code), toUid('decision', decision), 'references', 'markdown', path, index + 1));
    }
  });
  return { nodes, edges };
}

function parseDecisions(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const code = String(data.id ?? '').trim();
  if (code) {
    const title = String(data.title ?? headingTitle(raw, code) ?? code);
    const node = {
      type: 'decision' as const,
      code,
      title,
      path,
      line: 1,
      status: typeof data.status === 'string' ? data.status : undefined,
      attrs: { ...data },
    };
    const edges: ArtifactEdge[] = [
      ...decisionFrontmatterEdges(path, code, data.related_features, 'feature', 'references'),
      ...decisionFrontmatterEdges(path, code, data.related_scenarios, 'scenario', 'references'),
    ];
    return { nodes: [node], edges };
  }

  const seen = new Set<string>();
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    for (const decisionCode of extractCodes(line, 'decision')) {
      if (seen.has(decisionCode)) {
        continue;
      }
      seen.add(decisionCode);
      nodes.push({ type: 'decision', code: decisionCode, title: titleNearCode(line, decisionCode), path, line: index + 1 });
    }
  });
  return { nodes, edges: [] };
}

/**
 * Deterministic path classifier: is this file a test or an implementation source?
 * Test indicators:
 *   - `.test.*` or `.spec.*` extension suffix (e.g. `foo.test.ts`, `bar.spec.js`)
 *   - lives under `tests/`, `test/`, or `__tests__/` directory
 *   - filename matches `*Test.java` or `*Tests.java` (Java convention)
 * Everything else → implementation source.
 */
function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const name = basename(normalized);
  // .test.* or .spec.* suffix
  if (/\.(test|spec)\.[^.]+$/.test(name)) return true;
  // directory-based: tests/, test/, __tests__/
  if (/(^|\/)(tests|test|__tests__)\//.test(normalized)) return true;
  // Java convention: *Test.java or *Tests.java
  if (/\w+Tests?\.java$/.test(name)) return true;
  return false;
}

function parseTest(path: string, raw: string, schema: ArtifactSchema = DEFAULT_SCHEMA): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  const traceabilityComments = scanTraceabilityComments(raw, schema);
  const isTest = isTestFile(path);
  const nodeType = isTest ? 'test' : 'implementation';
  const edgeKind = isTest ? 'verifies' : 'implements';
  const attrs: Record<string, unknown> = {};
  if (traceabilityComments.invalid.length > 0) attrs.invalidTraceabilityComments = traceabilityComments.invalid;
  if (traceabilityComments.deprecated.length > 0) attrs.deprecatedTraceabilityComments = traceabilityComments.deprecated;
  const node = {
    type: nodeType,
    code: path,
    title: path.split('/').at(-1) ?? path,
    path,
    line: 1,
    attrs,
  };
  let hasTags = false;
  for (const { tags, lineNumber } of traceabilityComments.canonical) {
    hasTags = true;
    for (const [tagType, codes] of Object.entries(tags)) {
      for (const code of codes ?? []) {
        edges.push(edge(toUid(nodeType, path), toUid(tagType, code), edgeKind, 'test-comment', path, lineNumber));
      }
    }
  }
  if (hasTags || traceabilityComments.invalid.length > 0 || traceabilityComments.deprecated.length > 0) {
    nodes.push(node);
  }
  return { nodes, edges };
}

function scanTraceabilityComments(raw: string, schema: ArtifactSchema = DEFAULT_SCHEMA): {
  canonical: Array<{ tags: Partial<Record<string, string[]>>; lineNumber: number }>;
  invalid: Array<{ line: number; text: string; reason: string }>;
  deprecated: Array<{ line: number; text: string }>;
} {
  const canonical: Array<{ tags: Partial<Record<string, string[]>>; lineNumber: number }> = [];
  const invalid: Array<{ line: number; text: string; reason: string }> = [];
  const deprecated: Array<{ line: number; text: string }> = [];

  for (const comment of scanCodeComments(raw)) {
    if (!containsTraceabilityTag(comment.text, schema)) {
      continue;
    }
    if (comment.kind === 'block') {
      invalid.push({ line: comment.lineNumber, text: comment.text.trim(), reason: 'traceability tags must use standalone // comments' });
      continue;
    }
    if (!comment.standalone) {
      invalid.push({ line: comment.lineNumber, text: comment.text.trim(), reason: 'traceability tags must use standalone // comments' });
      continue;
    }
    const parsed = parseTraceabilityTagLine(comment.text.trim(), schema);
    if (parsed.valid) {
      canonical.push({ tags: parsed.tags, lineNumber: comment.lineNumber });
      if (/(?:^|\s)@tc(?=\s|$)/.test(comment.text.trim())) {
        deprecated.push({ line: comment.lineNumber, text: comment.text.trim() });
      }
    } else {
      invalid.push({ line: comment.lineNumber, text: comment.text.trim(), reason: parsed.reason });
    }
  }

  for (const comment of scanMarkdownComments(raw)) {
    if (!containsTraceabilityTag(comment.text, schema)) {
      continue;
    }
    if (!comment.standalone) {
      invalid.push({ line: comment.lineNumber, text: comment.text.trim(), reason: 'traceability tags in markdown must use standalone HTML comments' });
      continue;
    }
    const parsed = parseTraceabilityTagLine(comment.text.trim(), schema);
    if (parsed.valid) {
      canonical.push({ tags: parsed.tags, lineNumber: comment.lineNumber });
      if (/(?:^|\s)@tc(?=\s|$)/.test(comment.text.trim())) {
        deprecated.push({ line: comment.lineNumber, text: comment.text.trim() });
      }
    } else {
      invalid.push({ line: comment.lineNumber, text: comment.text.trim(), reason: parsed.reason });
    }
  }

  return { canonical, invalid, deprecated };
}

function scanCodeComments(raw: string): Array<{ kind: 'line' | 'block'; text: string; lineNumber: number; standalone: boolean }> {
  const comments: Array<{ kind: 'line' | 'block'; text: string; lineNumber: number; standalone: boolean }> = [];
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  let lineNumber = 1;
  let lineStart = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      if (char === '\n') {
        lineNumber += 1;
        lineStart = index + 1;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '/' && next === '/') {
      const startLine = lineNumber;
      const standalone = raw.slice(lineStart, index).trim() === '';
      const start = index + 2;
      let end = start;
      while (end < raw.length && raw[end] !== '\n') {
        end += 1;
      }
      comments.push({ kind: 'line', text: raw.slice(start, end), lineNumber: startLine, standalone });
      index = end - 1;
      continue;
    }

    if (char === '/' && next === '*') {
      const startLine = lineNumber;
      const standalone = raw.slice(lineStart, index).trim() === '';
      const start = index + 2;
      let end = start;
      while (end < raw.length - 1 && !(raw[end] === '*' && raw[end + 1] === '/')) {
        if (raw[end] === '\n') {
          lineNumber += 1;
          lineStart = end + 1;
        }
        end += 1;
      }
      comments.push({ kind: 'block', text: raw.slice(start, end), lineNumber: startLine, standalone });
      index = end + 1;
      continue;
    }

    if (char === '\n') {
      lineNumber += 1;
      lineStart = index + 1;
    }
  }

  return comments;
}

function scanMarkdownComments(raw: string): Array<{ text: string; lineNumber: number; standalone: boolean }> {
  const comments: Array<{ text: string; lineNumber: number; standalone: boolean }> = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    const match = /^(\s*)<!--\s*([\s\S]*?)\s*-->\s*$/.exec(line);
    if (!match) {
      return;
    }
    comments.push({ text: match[2], lineNumber: index + 1, standalone: true });
  });
  return comments;
}

function parseTraceabilityTagLine(text: string, schema: ArtifactSchema = DEFAULT_SCHEMA): { valid: true; tags: Partial<Record<string, string[]>> } | { valid: false; reason: string } {
  const trimmed = text.trim();
  // Build a regex that matches @<known-core-tag> or @<any-registered-type-or-alias>
  const coreTags = ['scenario', 'feature', 'entity', 'decision'];
  const allTypeAndAliasTokens = new Set<string>(coreTags);
  for (const [type, definition] of Object.entries(schema.types)) {
    allTypeAndAliasTokens.add(type);
    for (const alias of definition.aliases ?? []) {
      allTypeAndAliasTokens.add(alias);
    }
  }
  // Escape tokens for regex, match longest first
  const escapedTokens = [...allTypeAndAliasTokens]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'));
  const tagPattern = new RegExp(`@(${escapedTokens.join('|')})\\b`, 'g');

  const firstMatch = tagPattern.exec(trimmed);
  if (!firstMatch || firstMatch.index !== 0) {
    return { valid: false, reason: 'traceability line must start with a recognized @type tag' };
  }

  const tags: Partial<Record<string, string[]>> = {};
  const allMatches = [...trimmed.matchAll(new RegExp(tagPattern.source, tagPattern.flags))];
  for (let index = 0; index < allMatches.length; index += 1) {
    const match = allMatches[index];
    const rawTag = match[1];
    const resolvedType = resolveArtifactTypeName(schema, rawTag);
    if (!resolvedType) {
      return { valid: false, reason: `unknown traceability type @${rawTag}` };
    }
    const valueStart = (match.index ?? 0) + match[0].length;
    const valueEnd = index + 1 < allMatches.length ? allMatches[index + 1].index ?? trimmed.length : trimmed.length;
    const value = trimmed.slice(valueStart, valueEnd);
    const codes = extractTraceabilityCodes(value, resolvedType, schema);
    if (codes.length === 0) {
      return { valid: false, reason: `traceability tag @${rawTag} must contain at least one valid ID` };
    }
    tags[resolvedType] = [...(tags[resolvedType] ?? []), ...codes];
  }

  return { valid: true, tags };
}

function extractTraceabilityCodes(text: string, resolvedType: string, schema: ArtifactSchema = DEFAULT_SCHEMA): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
  const expanded = tokens.flatMap((value) => expandTraceabilityToken(value, resolvedType, schema));
  if (expanded.length === 0 || expanded.includes('')) {
    return [];
  }
  return [...new Set(expanded)];
}

function expandTraceabilityToken(value: string, resolvedType: string, schema: ArtifactSchema = DEFAULT_SCHEMA): string[] {
  if (!traceabilityTokenPattern(resolvedType, schema).test(value)) {
    return [''];
  }
  return expandCodeRange(value);
}

function traceabilityTokenPattern(resolvedType: string, schema: ArtifactSchema = DEFAULT_SCHEMA): RegExp {
  const corePatterns: Record<string, RegExp> = {
    decision: /^D-[A-Z]+-\d+$/,
    entity: /^E-\d{3,}(?:~(?:E-)?\d{3,})?$/,
    feature: /^(?!AC\d+$)[A-Z]{1,4}\d+(?:~(?:[A-Z]{1,4})?\d+)?$/,
    scenario: /^S-\d+[a-z]?(?:~(?:S-)?\d+[a-z]?)?$/,
  };
  // If schema overrides idPattern for a core type, use the project pattern
  const schemaOverride = schema.idPatterns[resolvedType];
  const defaultPattern = DEFAULT_SCHEMA.idPatterns[resolvedType];
  if (schemaOverride && schemaOverride !== defaultPattern) {
    return new RegExp(schemaOverride);
  }
  // Core types use hardcoded patterns for backward compatibility
  if (corePatterns[resolvedType]) {
    return corePatterns[resolvedType];
  }
  // Custom types use idPatterns from schema
  if (schemaOverride) {
    return new RegExp(schemaOverride);
  }
  // No pattern available — reject all tokens
  return /(?!)/;
}

function expandCodeRange(value: string): string[] {
  const range = value.match(/^([A-Z-]+)(\d+)([a-z]?)~([A-Z-]+)?(\d+)([a-z]?)$/);
  if (!range || range[3] || range[6]) {
    return [value];
  }
  const [, prefix, startRaw,, endPrefix, endRaw] = range;
  if (endPrefix && endPrefix !== prefix) {
    return [''];
  }
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || end - start > 200) {
    return [value];
  }
  const width = startRaw.length;
  return Array.from({ length: end - start + 1 }, (_, index) => `${prefix}${String(start + index).padStart(width, '0')}`);
}

function containsTraceabilityTag(value: string, schema: ArtifactSchema = DEFAULT_SCHEMA): boolean {
  // @feature ACA17
  // @scenario S-57
  // @scenario S-58
  // @scenario S-59
  // @decision D-ACA-17
  // Only registered canonical types and explicit aliases enter traceability parsing.
  // Unknown annotations belong to other tools and must not create false diagnostics.
  const tokens = new Set<string>();
  for (const [type, definition] of Object.entries(schema.types)) {
    tokens.add(type);
    for (const alias of definition.aliases ?? []) tokens.add(alias);
  }
  if (tokens.size === 0) return false;
  const alternatives = [...tokens]
    .sort((a, b) => b.length - a.length)
    .map(token => token.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'))
    .join('|');
  return new RegExp(`(?:^|\\s)@(?:${alternatives})(?=\\s|$)`).test(value);
}

function parseDesign(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const code = normalizeDesignCode(path);
  const title = String(data.title ?? raw.match(/^#\s+(.+)$/m)?.[1] ?? code);
  const nodes = [{ type: 'design', code, title, path, line: 1, attrs: data }];
  const edges: ArtifactEdge[] = [
    ...designFrontmatterEdges(path, code, data.related_features, 'feature', 'references'),
    ...designFrontmatterEdges(path, code, data.related_scenarios, 'scenario', 'references'),
  ];
  raw.split(/\r?\n/).forEach((line, index) => {
    for (const codeValue of extractCodes(line, 'entity')) {
      edges.push(edge(toUid('design', code), toUid('entity', codeValue), 'references', 'markdown', path, index + 1));
    }
    for (const codeValue of extractCodes(line, 'decision')) {
      edges.push(edge(toUid('design', code), toUid('decision', codeValue), 'references', 'markdown', path, index + 1));
    }
  });
  return { nodes, edges };
}

function parseE2eTest(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const lines = raw.split(/\r?\n/);
  const starts: Array<{ id: string; title: string; line: number; index: number }> = [];
  lines.forEach((line, index) => {
    const match = /^#{2,3}\s+(TC-\d+[a-z]?)\s*[:：]?\s*(.*?)\s*$/.exec(line);
    if (match) {
      starts.push({ id: match[1], title: match[2].trim(), line: index + 1, index });
    }
  });

  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  const batch = String(data.test_batch ?? basename(path, extname(path))).trim();
  const frontmatterScenarios = toArray(data.related_scenarios).map((value) => String(value).trim()).filter(Boolean);
  const scopeFeatures = extractCodes(String(data.scope ?? ''), 'feature');
  const frontmatterFeatures = [...new Set([...Object.keys(asRecord(data.ac_coverage)), ...scopeFeatures])];
  const frontmatterDecisions = toArray(data.related_decisions).map((value) => String(value).trim()).filter(Boolean);
  const frontmatterEntities = toArray(data.related_entities).map((value) => String(value).trim()).filter(Boolean);

  if (starts.length === 0) {
    const code = `${batch}:FILE`;
    nodes.push({
      type: 'e2e_test',
      code,
      title: raw.match(/^#\s+(.+)$/m)?.[1] ?? batch,
      path,
      line: 1,
      attrs: {
        ...data,
        testCaseId: 'FILE',
        fileLevelOnly: true,
        tcFields: {},
        blockText: raw,
        coveredFeatures: [],
        coveredScenarios: [],
      },
    });
    addE2eFrontmatterEdges(edges, code, path, frontmatterScenarios, frontmatterFeatures, frontmatterDecisions, frontmatterEntities);
  }

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1]?.index ?? lines.length;
    const block = lines.slice(start.index, end);
    const fields = extractE2eTcFields(block);
    const code = `${batch}:${start.id}`;
    const attrs = {
      ...data,
      testCaseId: start.id,
      tcFields: fields,
      blockText: block.join('\n'),
      coveredFeatures: extractFeatureAcRefs(fields['覆盖功能'] ?? ''),
      coveredScenarios: extractCodes(fields['覆盖场景'] ?? '', 'scenario'),
    };
    nodes.push({ type: 'e2e_test', code, title: start.title, path, line: start.line, attrs });
    addE2eFrontmatterEdges(edges, code, path, frontmatterScenarios, frontmatterFeatures, frontmatterDecisions, frontmatterEntities);
    for (const scenario of extractCodes(fields['覆盖场景'] ?? '', 'scenario')) {
      edges.push(edge(toUid('e2e_test', code), toUid('scenario', scenario), 'verifies', 'markdown', path, start.line));
    }
    for (const feature of extractCodes(fields['覆盖功能'] ?? '', 'feature')) {
      edges.push(edge(toUid('e2e_test', code), toUid('feature', feature), 'verifies', 'markdown', path, start.line));
    }
  }

  return { nodes, edges };
}

function addE2eFrontmatterEdges(
  edges: ArtifactEdge[],
  code: string,
  path: string,
  scenarios: string[],
  features: string[],
  decisions: string[],
  entities: string[],
): void {
  for (const scenario of scenarios) {
    edges.push(edge(toUid('e2e_test', code), toUid('scenario', scenario), 'verifies', 'frontmatter', path, 1));
  }
  for (const feature of features) {
    edges.push(edge(toUid('e2e_test', code), toUid('feature', feature), 'verifies', 'frontmatter', path, 1));
  }
  for (const decision of decisions) {
    edges.push(edge(toUid('e2e_test', code), toUid('decision', decision), 'references', 'frontmatter', path, 1));
  }
  for (const entityValue of entities) {
    edges.push(edge(toUid('e2e_test', code), toUid('entity', entityValue), 'references', 'frontmatter', path, 1));
  }
}

function parseE2eRegistry(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    data = { parseError: (error as Error).message };
  }
  return {
    nodes: [{ type: 'e2e_registry', code: basename(path, extname(path)), title: 'E2E Test Registry', path, line: 1, attrs: data }],
    edges: [],
  };
}

function parseContractTable(type: string, path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let sourceCol = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headerCols = splitMarkdownCells(line).map((c) => c.trim());
      sourceCol = headerCols.findIndex((c) => /source/i.test(c));
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line)) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const rawItemCode = cells[0]?.replace(/"/g, '') ?? '';
      const backtickMatch = /`([^`]+)`/.exec(rawItemCode);
      const itemCode = backtickMatch ? backtickMatch[1] : rawItemCode.replace(/`/g, '').trim().split(/\s+/)[0];
      if (!itemCode) {
        continue;
      }
      const title = cells[1] ?? itemCode;
      nodes.push({ type, code: itemCode, title, path, line: i + 1 });
      if (sourceCol >= 0 && sourceCol < cells.length) {
        const sourceText = cells[sourceCol].replace(/`/g, '');
        for (const decisionCode of extractCodes(sourceText, 'decision')) {
          edges.push(edge(toUid(type, itemCode), toUid('decision', decisionCode), 'references', 'markdown', path, i + 1));
        }
        for (const entityCode of extractCodes(sourceText, 'entity')) {
          edges.push(edge(toUid(type, itemCode), toUid('entity', entityCode), 'references', 'markdown', path, i + 1));
        }
      }
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
    }
  }
  return { nodes, edges };
}

function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '-');
}

function parseDomainGlossary(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex: Record<string, number> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => { colIndex[h] = idx; });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && 'term' in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const termIdx = colIndex['term']!;
      const term = cells[termIdx]?.trim() ?? '';
      if (!term) {
        continue;
      }
      const code = slugify(term);
      const lookup = (header: string) => cells[colIndex[header] ?? -1] ?? '';
      nodes.push({ type: 'domain-glossary', code, title: term, path, line: i + 1, attrs: { definition: lookup('definition'), canonicalOwner: lookup('canonical owner'), avoid: lookup('avoid') } });
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}

function parseBoundedContextMap(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex: Record<string, number> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => { colIndex[h] = idx; });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && 'context' in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const contextIdx = colIndex['context']!;
      const context = cells[contextIdx]?.trim() ?? '';
      if (!context) {
        continue;
      }
      const code = slugify(context);
      const lookup = (header: string) => cells[colIndex[header] ?? -1] ?? '';
      nodes.push({ type: 'bounded-context-map', code, title: context, path, line: i + 1, attrs: { owns: lookup('owns'), consumes: lookup('consumes'), publishes: lookup('publishes') } });
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}

function parseGenerationPacketSpec(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const nodes: Omit<ArtifactNode, 'uid'>[] = [{ type: 'generation-packet-spec', code: 'generation-packet-spec', title: 'Generation Packet Spec', path, line: 1 }];
  const edges: ArtifactEdge[] = [];
  const seen = new Set<string>();
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const decisionCode of extractCodes(line, 'decision')) {
      const key = `decision:${decisionCode}:${i}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(edge(toUid('generation-packet-spec', 'generation-packet-spec'), toUid('decision', decisionCode), 'references', 'markdown', path, i + 1));
      }
    }
    for (const entityCode of extractCodes(line, 'entity')) {
      const key = `entity:${entityCode}:${i}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(edge(toUid('generation-packet-spec', 'generation-packet-spec'), toUid('entity', entityCode), 'references', 'markdown', path, i + 1));
      }
    }
  }
  return { nodes, edges };
}

function parseRuleGoldenCases(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex: Record<string, number> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => { colIndex[h] = idx; });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && 'rule id' in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const ruleIdIdx = colIndex['rule id']!;
      const caseTypeIdx = colIndex['用例类型'] ?? -1;
      const ruleId = cells[ruleIdIdx]?.trim() ?? '';
      const caseType = cells[caseTypeIdx]?.trim().toLowerCase() ?? '';
      if (!ruleId || !['pass', 'fail', 'edge'].includes(caseType)) {
        continue;
      }
      const code = `${ruleId}:${caseType}`;
      const dimensionIdx = colIndex['维度'] ?? -1;
      const sourceIdx = colIndex['规则来源'] ?? -1;
      const noteIdx = colIndex['备注'] ?? -1;
      const skillIdx = colIndex['skill 片段'] ?? -1;
      const expectedIdx = colIndex['预期判定'] ?? -1;

      nodes.push({
        type: 'rule-golden-cases',
        code,
        title: `${ruleId} ${caseType}`,
        path,
        line: i + 1,
        attrs: {
          dimension: cells[dimensionIdx] ?? '',
          skillSnippet: cells[skillIdx] ?? '',
          expectedVerdict: cells[expectedIdx] ?? '',
          ruleSource: cells[sourceIdx] ?? '',
          note: cells[noteIdx] ?? '',
        },
      });

      if (sourceIdx >= 0 && sourceIdx < cells.length) {
        const sourceText = cells[sourceIdx] ?? '';
        if (/rule-catalog/.test(sourceText)) {
          edges.push(edge(toUid('rule-golden-cases', code), toUid('design', 'rule-catalog'), 'references', 'markdown', path, i + 1));
        }
      }
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}

function parseTestStrategy(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex: Record<string, number> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => { colIndex[h] = idx; });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && '测试层级' in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const tierIdx = colIndex['测试层级']!;
      const tier = cells[tierIdx]?.trim() ?? '';
      if (!tier) {
        continue;
      }
      const nameIdx = colIndex['中文名'] ?? -1;
      const scopeIdx = colIndex['覆盖范围'] ?? -1;
      const toolIdx = colIndex['工具'] ?? -1;
      const freqIdx = colIndex['执行频率'] ?? -1;
      const entryIdx = colIndex['入口'] ?? -1;
      const noteIdx = colIndex['备注'] ?? -1;

      nodes.push({
        type: 'test-strategy',
        code: tier,
        title: cells[nameIdx] ?? tier,
        path,
        line: i + 1,
        attrs: {
          coverage: cells[scopeIdx] ?? '',
          tool: cells[toolIdx] ?? '',
          frequency: cells[freqIdx] ?? '',
          entry: cells[entryIdx] ?? '',
          note: cells[noteIdx] ?? '',
        },
      });
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}

function parseTraceabilityMatrixV2(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  // Two-pass: first collect all nodes, then resolve upstream/downstream edges.
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex: Record<string, number> = {};

  // Pass 1: collect nodes and raw cell data
  type RawRow = { code: string; layer: string; id: string; upstreamRaw: string; downstreamRaw: string; line: number };
  const rawRows: RawRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => { colIndex[h] = idx; });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && '层级' in colIndex && 'id' in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const layerIdx = colIndex['层级']!;
      const idIdx = colIndex['id']!;
      const layer = cells[layerIdx]?.trim() ?? '';
      const id = cells[idIdx]?.trim() ?? '';
      if (!layer || !id) {
        continue;
      }
      const nameIdx = colIndex['名称'] ?? -1;
      const upstreamIdx = colIndex['上游依赖'] ?? -1;
      const downstreamIdx = colIndex['下游覆盖'] ?? -1;
      const statusIdx = colIndex['状态'] ?? -1;
      const productIdx = colIndex['产品分层'] ?? -1;

      const code = `${layer}:${id}`;
      nodes.push({
        type: 'traceability-matrix-v2',
        code,
        title: cells[nameIdx] ?? id,
        path,
        line: i + 1,
        attrs: {
          layer,
          id,
          upstreamDependencies: cells[upstreamIdx] ?? '',
          downstreamCoverage: cells[downstreamIdx] ?? '',
          status: cells[statusIdx] ?? '',
          productLayer: cells[productIdx] ?? '',
        },
      });
      rawRows.push({
        code,
        layer,
        id,
        upstreamRaw: upstreamIdx >= 0 && upstreamIdx < cells.length ? cells[upstreamIdx] : '',
        downstreamRaw: downstreamIdx >= 0 && downstreamIdx < cells.length ? cells[downstreamIdx] : '',
        line: i + 1,
      });
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }

  // Pass 2: resolve upstream/downstream edges
  // Build a lookup map: bare ID -> matrix node code (across all layers)
  const idToCode = new Map<string, string>();
  for (const node of nodes) {
    const attrs = node.attrs as Record<string, string>;
    const bareId = attrs.id;
    if (bareId) {
      idToCode.set(bareId, node.code);
    }
  }

  const parseRefs = (raw: string): string[] => {
    // Split by comma or semicolon, trim, filter empty.
    // Skip ranges (contain ~), file paths (contain /), globs (contain *), and placeholders (—)
    return raw.split(/[,;]+/)
      .map((s) => s.replace(/`/g, '').trim())
      .filter((s) => s.length > 0 && !s.includes('~') && !s.includes('/') && !s.includes('*') && s !== '—' && s !== '--');
  };

  for (const row of rawRows) {
    const fromUid = toUid('traceability-matrix-v2', row.code);
    // Upstream → references edges
    for (const ref of parseRefs(row.upstreamRaw)) {
      const matrixCode = idToCode.get(ref);
      // Always create edge: matrix-row target if exists, otherwise bare ID (will be resolved or dangling)
      const targetUid = matrixCode
        ? toUid('traceability-matrix-v2', matrixCode)
        : `resolve:${ref}`;
      edges.push(edge(fromUid, targetUid, 'references', 'markdown', path, row.line));
    }
    // Downstream → covers edges
    for (const ref of parseRefs(row.downstreamRaw)) {
      const matrixCode = idToCode.get(ref);
      const targetUid = matrixCode
        ? toUid('traceability-matrix-v2', matrixCode)
        : `resolve:${ref}`;
      edges.push(edge(fromUid, targetUid, 'covers', 'markdown', path, row.line));
    }
  }

  return { nodes, edges };
}

function parseTraceabilityVersionLock(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  let attrs: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    attrs = {
      schemaVersion: parsed.schemaVersion,
      lockCount: Array.isArray(parsed.locks) ? parsed.locks.length : 0,
    };
  } catch (error) {
    attrs = { parseError: (error as Error).message };
  }
  return {
    nodes: [{
      type: 'traceability-version-lock',
      code: 'traceability-version-lock',
      title: '追溯版本锁',
      path,
      line: 1,
      attrs,
    }],
    edges: [],
  };
}

// --- P2 parsers ---

function parseReportContracts(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let sourceCol = -1;
  let idCol = -1;
  let section = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+\d+\./.test(line)) {
      section += 1;
      inTable = false;
      headerParsed = false;
      continue;
    }
    if (/^#\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim());
      sourceCol = headers.findIndex((c) => /source/i.test(c));
      // Section 1: Report field, Section 2: Format, Section 3: Error code
      idCol = section === 1 ? headers.findIndex((c) => /report field/i.test(c))
        : section === 2 ? headers.findIndex((c) => /^format$/i.test(c))
          : headers.findIndex((c) => /error code/i.test(c));
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && idCol >= 0) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const rawCode = cells[idCol]?.replace(/`/g, '').trim() ?? '';
      if (!rawCode || /\(/.test(rawCode)) continue;
      const code = rawCode;
      const title = cells[1] ?? code;
      nodes.push({ type: 'report-contracts', code, title, path, line: i + 1 });
      if (sourceCol >= 0 && sourceCol < cells.length) {
        const sourceText = cells[sourceCol].replace(/`/g, '');
        for (const ref of extractCodes(sourceText, 'decision')) {
          edges.push(edge(toUid('report-contracts', code), toUid('decision', ref), 'references', 'markdown', path, i + 1));
        }
        for (const ref of extractCodes(sourceText, 'entity')) {
          edges.push(edge(toUid('report-contracts', code), toUid('entity', ref), 'references', 'markdown', path, i + 1));
        }
        for (const ref of extractCodes(sourceText, 'feature')) {
          edges.push(edge(toUid('report-contracts', code), toUid('feature', ref), 'references', 'markdown', path, i + 1));
        }
      }
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
    }
  }
  return { nodes, edges };
}

function parseVerificationFixtures(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex: Record<string, number> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => { colIndex[h] = idx; });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && 'fixture id' in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const idIdx = colIndex['fixture id']!;
      const code = cells[idIdx]?.trim() ?? '';
      if (!code || !/^FIX-\d{3}$/.test(code)) continue;
      const nameIdx = colIndex['中文名'] ?? -1;
      const catIdx = colIndex['category'] ?? -1;
      const sourceIdx = colIndex['source'] ?? -1;

      nodes.push({
        type: 'verification-fixtures',
        code,
        title: cells[nameIdx] ?? code,
        path,
        line: i + 1,
        attrs: {
          category: cells[catIdx] ?? '',
        },
      });

      if (sourceIdx >= 0 && sourceIdx < cells.length) {
        const sourceText = cells[sourceIdx].replace(/`/g, '');
        if (/rule-catalog/.test(sourceText)) {
          edges.push(edge(toUid('verification-fixtures', code), toUid('design', 'rule-catalog'), 'references', 'markdown', path, i + 1));
        }
      }
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}

function parseUIFlowContracts(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex: Record<string, number> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => { colIndex[h] = idx; });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line)) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());

      if ('page id' in colIndex) {
        const idIdx = colIndex['page id']!;
        const code = cells[idIdx]?.trim() ?? '';
        if (!code) { continue; }
        const nameIdx = colIndex['中文名'] ?? -1;
        const sourceIdx = colIndex['source'] ?? -1;
        nodes.push({ type: 'ui-flow-contracts', code, title: cells[nameIdx] ?? code, path, line: i + 1 });
        if (sourceIdx >= 0 && sourceIdx < cells.length) {
          const src = cells[sourceIdx].replace(/`/g, '');
          for (const ref of extractCodes(src, 'decision')) edges.push(edge(toUid('ui-flow-contracts', code), toUid('decision', ref), 'references', 'markdown', path, i + 1));
          for (const ref of extractCodes(src, 'entity')) edges.push(edge(toUid('ui-flow-contracts', code), toUid('entity', ref), 'references', 'markdown', path, i + 1));
          for (const ref of extractCodes(src, 'feature')) edges.push(edge(toUid('ui-flow-contracts', code), toUid('feature', ref), 'references', 'markdown', path, i + 1));
        }
      } else if ('flow id' in colIndex) {
        const idIdx = colIndex['flow id']!;
        const code = cells[idIdx]?.trim() ?? '';
        if (!code) { continue; }
        const nameIdx = colIndex['中文名'] ?? -1;
        const sourceIdx = colIndex['source'] ?? -1;
        const relatedScIdx = colIndex['related scenarios'] ?? -1;
        nodes.push({ type: 'ui-flow-contracts', code, title: cells[nameIdx] ?? code, path, line: i + 1 });
        // Source column: extract decision, entity, feature edges
        if (sourceIdx >= 0 && sourceIdx < cells.length) {
          const src = cells[sourceIdx].replace(/`/g, '');
          for (const ref of extractCodes(src, 'decision')) edges.push(edge(toUid('ui-flow-contracts', code), toUid('decision', ref), 'references', 'markdown', path, i + 1));
          for (const ref of extractCodes(src, 'entity')) edges.push(edge(toUid('ui-flow-contracts', code), toUid('entity', ref), 'references', 'markdown', path, i + 1));
          for (const ref of extractCodes(src, 'feature')) edges.push(edge(toUid('ui-flow-contracts', code), toUid('feature', ref), 'references', 'markdown', path, i + 1));
        }
        // Related scenarios column: only extract scenario edges
        if (relatedScIdx >= 0 && relatedScIdx < cells.length) {
          const scText = cells[relatedScIdx].replace(/`/g, '');
          for (const ref of extractCodes(scText, 'scenario')) edges.push(edge(toUid('ui-flow-contracts', code), toUid('scenario', ref), 'references', 'markdown', path, i + 1));
        }
      } else if ('state' in colIndex && 'trigger' in colIndex) {
        const idIdx = colIndex['state']!;
        const rawCode = cells[idIdx]?.replace(/`/g, '').trim() ?? '';
        if (!rawCode) { continue; }
        const code = rawCode;
        const nameIdx = colIndex['中文名'] ?? -1;
        const sourceIdx = colIndex['source'] ?? -1;
        nodes.push({ type: 'ui-flow-contracts', code, title: cells[nameIdx] ?? code, path, line: i + 1 });
        if (sourceIdx >= 0 && sourceIdx < cells.length) {
          const src = cells[sourceIdx].replace(/`/g, '');
          for (const ref of extractCodes(src, 'decision')) edges.push(edge(toUid('ui-flow-contracts', code), toUid('decision', ref), 'references', 'markdown', path, i + 1));
          for (const ref of extractCodes(src, 'entity')) edges.push(edge(toUid('ui-flow-contracts', code), toUid('entity', ref), 'references', 'markdown', path, i + 1));
          for (const ref of extractCodes(src, 'feature')) edges.push(edge(toUid('ui-flow-contracts', code), toUid('feature', ref), 'references', 'markdown', path, i + 1));
        }
      }
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}

function parseNonFunctionalBudgets(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const nodes: Omit<ArtifactNode, 'uid'>[] = [];
  const edges: ArtifactEdge[] = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex: Record<string, number> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => { colIndex[h] = idx; });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && 'budget id' in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const idIdx = colIndex['budget id']!;
      const code = cells[idIdx]?.trim() ?? '';
      if (!code || !/^NFB-\d{3}$/.test(code)) continue;
      const nameIdx = colIndex['中文名'] ?? -1;
      const metricIdx = colIndex['metric'] ?? -1;
      const sourceIdx = colIndex['source'] ?? -1;

      nodes.push({
        type: 'non-functional-budgets',
        code,
        title: cells[nameIdx] ?? code,
        path,
        line: i + 1,
        attrs: { metric: cells[metricIdx] ?? '' },
      });

      if (sourceIdx >= 0 && sourceIdx < cells.length) {
        const sourceText = cells[sourceIdx].replace(/`/g, '');
        for (const ref of extractCodes(sourceText, 'decision')) {
          edges.push(edge(toUid('non-functional-budgets', code), toUid('decision', ref), 'references', 'markdown', path, i + 1));
        }
        for (const ref of extractCodes(sourceText, 'feature')) {
          edges.push(edge(toUid('non-functional-budgets', code), toUid('feature', ref), 'references', 'markdown', path, i + 1));
        }
      }
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}

function parseImplementationBlueprint(path: string, raw: string): { nodes: Omit<ArtifactNode, 'uid'>[]; edges: ArtifactEdge[] } {
  const nodes: Omit<ArtifactNode, 'uid'>[] = [
    { type: 'implementation-blueprint', code: 'implementation-blueprint', title: 'Implementation Blueprint', path, line: 1 },
  ];
  const edges: ArtifactEdge[] = [];
  const seen = new Set<string>();
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const decisionCode of extractCodes(line, 'decision')) {
      const key = `decision:${decisionCode}:${i}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(edge(toUid('implementation-blueprint', 'implementation-blueprint'), toUid('decision', decisionCode), 'references', 'markdown', path, i + 1));
      }
    }
    for (const featureCode of extractCodes(line, 'feature')) {
      const key = `feature:${featureCode}:${i}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(edge(toUid('implementation-blueprint', 'implementation-blueprint'), toUid('feature', featureCode), 'references', 'markdown', path, i + 1));
      }
    }
  }
  return { nodes, edges };
}

function frontmatterEdges(
  path: string,
  featureCode: string,
  value: unknown,
  targetType: string,
  kind: string,
  normalize: (value: unknown) => string = (target) => String(target).trim(),
): ArtifactEdge[] {
  return toArray(value).flatMap((target) => {
    const code = normalize(target);
    if (!code) {
      return [];
    }
    return [edge(toUid('feature', featureCode), toUid(targetType, code), kind, 'frontmatter', path, 1)];
  });
}

function frontmatterRelationOccurrences(path: string, field: string, value: unknown, targetType: string): RelationOccurrence[] {
  return toArray(value)
    .map((target) => String(target).trim())
    .filter(Boolean)
    .map((target) => ({ field, targetType, target, path, line: 1 }));
}

function designFrontmatterEdges(path: string, designCode: string, value: unknown, targetType: string, kind: string): ArtifactEdge[] {
  return toArray(value).flatMap((target) => {
    const code = String(target).trim();
    if (!code) {
      return [];
    }
    return [edge(toUid('design', designCode), toUid(targetType, code), kind, 'frontmatter', path, 1)];
  });
}

function decisionFrontmatterEdges(path: string, decisionCode: string, value: unknown, targetType: string, kind: string): ArtifactEdge[] {
  return toArray(value).flatMap((target) => {
    const code = String(target).trim();
    if (!code) {
      return [];
    }
    return [edge(toUid('decision', decisionCode), toUid(targetType, code), kind, 'frontmatter', path, 1)];
  });
}

function markdownLineEdges(
  path: string,
  scenario: { code: string; index: number },
  block: string[],
  label: string,
  targetType: string,
  kind: string,
): ArtifactEdge[] {
  const result: ArtifactEdge[] = [];
  block.forEach((line, index) => {
    if (!line.includes(label)) {
      return;
    }
    const relationText = line.split(/[:：]/).slice(1).join(':').split(/\s+[—-]\s+/)[0] ?? line;
    for (const code of extractCodes(relationText, targetType)) {
      result.push(edge(toUid('scenario', scenario.code), toUid(targetType, code), kind, 'markdown', path, scenario.index + index + 1));
    }
  });
  return result;
}

function markdownRelationOccurrences(
  path: string,
  scenario: { code: string; index: number },
  block: string[],
  label: string,
  targetType: string,
  schema?: ArtifactSchema,
): RelationOccurrence[] {
  const result: RelationOccurrence[] = [];
  block.forEach((line, index) => {
    if (!line.includes(label)) {
      return;
    }
    const relationText = line.split(/[:：]/).slice(1).join(':').split(/\s+[—-]\s+/)[0] ?? line;
    const lineNumber = scenario.index + index + 1;
    const codes = extractCodes(relationText, targetType, schema);
    for (const code of codes) {
      result.push({ field: label, targetType, target: code, path, line: lineNumber, raw: relationText.trim() });
    }
    for (const invalid of invalidRelationCandidates(relationText, targetType, codes)) {
      result.push({ field: label, targetType, target: invalid, path, line: lineNumber, raw: relationText.trim() });
    }
  });
  return result;
}

function relationOccurrences(node: ArtifactNode, field: string, targetType: string): RelationOccurrence[] {
  const relationRecord = asRecord(node.attrs?.relationOccurrences);
  const rawOccurrences = toArray(relationRecord[field]);
  return rawOccurrences.flatMap((value) => {
    if (typeof value === 'string') {
      return [{ field, targetType, target: value, path: node.path, line: node.line }];
    }
    const record = asRecord(value);
    const target = String(record.target ?? '').trim();
    if (!target) {
      return [];
    }
    return [{
      field: String(record.field ?? field),
      targetType: String(record.targetType ?? targetType),
      target,
      path: typeof record.path === 'string' ? record.path : node.path,
      line: typeof record.line === 'number' ? record.line : node.line,
      raw: typeof record.raw === 'string' ? record.raw : undefined,
    }];
  });
}

function pushDuplicateIssues(issues: ValidationIssue[], nodeUid: string, refs: RelationOccurrence[], targetType: string): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    const targetUid = toUid(targetType, ref.target);
    if (seen.has(targetUid)) {
      issues.push(issue('DUPLICATE', `${nodeUid} repeats ${targetUid}`, ref.path, ref.line, { node: nodeUid }));
    }
    seen.add(targetUid);
  }
}

function isValidRelationOccurrence(ref: RelationOccurrence): boolean {
  return relationTargetPattern(ref.targetType).test(ref.target);
}

function invalidRelationCandidates(text: string, targetType: string, validCodes: string[]): string[] {
  const valid = new Set(validCodes);
  const candidates = text
    .split(/[\s,，、;；()[\]（）]+/)
    .map((token) => token.trim().replace(/^["'`]+|["'`.:：]+$/g, ''))
    .filter(Boolean);
  const pattern = relationTargetPattern(targetType);
  return [...new Set(candidates.filter((candidate) => (
    looksLikeRelationId(candidate, targetType)
    && !valid.has(candidate)
    && !pattern.test(candidate)
  )))];
}

function looksLikeRelationId(candidate: string, targetType: string): boolean {
  if (targetType === 'feature') {
    return /^[A-Z][A-Z0-9-]*$/.test(candidate) && (/\d/.test(candidate) || candidate.includes('-')) && !/^AC\d+$/.test(candidate);
  }
  if (targetType === 'scenario') {
    return /^S[-A-Z0-9]+[a-z]?$/.test(candidate);
  }
  if (targetType === 'decision') {
    return /^D[-A-Z0-9]+$/.test(candidate);
  }
  if (targetType === 'entity') {
    return /^E[-0-9]+$/.test(candidate);
  }
  return false;
}

function relationTargetPattern(targetType: string): RegExp {
  const patterns: Record<string, RegExp> = {
    decision: /^D-[A-Z]+-\d+$/,
    entity: /^E-\d{3,}$/,
    feature: /^(?!AC\d+$)[A-Z]{1,4}\d+$/,
    scenario: /^S-\d+[a-z]?$/,
  };
  return patterns[targetType] ?? /^.+$/;
}

function findDependsOnCycles(graph: ArtifactGraph): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edgeValue of graph.edges) {
    if (edgeValue.kind === 'depends_on') {
      adjacency.set(edgeValue.from, [...(adjacency.get(edgeValue.from) ?? []), edgeValue.to]);
    }
  }
  const cycles: string[][] = [];
  const visit = (node: string, stack: string[]) => {
    if (stack.includes(node)) {
      cycles.push([...stack.slice(stack.indexOf(node)), node]);
      return;
    }
    for (const next of adjacency.get(node) ?? []) {
      visit(next, [...stack, node]);
    }
  };
  for (const node of adjacency.keys()) {
    visit(node, []);
  }
  return cycles;
}

function validateE2eTests(graph: ArtifactGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const featureAcs = new Map(
    graph.nodes
      .filter((node) => node.type === 'feature')
      .map((node) => [node.code, toArray(node.attrs?.acceptanceCriteria).map((value) => String(value))]),
  );
  const e2eNodes = graph.nodes.filter((node) => node.type === 'e2e_test');
  const nodesByPath = groupBy(e2eNodes, (node) => node.path);

  for (const node of e2eNodes) {
    const attrs = node.attrs ?? {};
    for (const field of ['test_batch', 'scope', 'ac_coverage', 'related_scenarios']) {
      if (isEmptyValue(attrs[field])) {
        issues.push(issue('E2E_REQUIRED_FRONTMATTER', `${node.uid} missing required frontmatter ${field}`, node.path, 1, { node: node.uid, severity: 'warning' }));
      }
    }

    const fields = asRecord(attrs.tcFields);
    const requiredTcFields = [
      ['标题', node.title],
      ['前置条件', fields['前置条件']],
      ['测试步骤', fields['测试步骤']],
      ['后置清理', fields['后置清理']],
      ['覆盖场景', fields['覆盖场景']],
      ['覆盖功能', fields['覆盖功能']],
      ['优先级', fields['优先级']],
    ];
    for (const [field, value] of requiredTcFields) {
      if (isEmptyValue(value)) {
        issues.push(issue('E2E_REQUIRED_TC_FIELD', `${node.uid} missing required TC field ${field}`, node.path, node.line, { node: node.uid, severity: 'warning' }));
      }
    }

    for (const reference of extractFeatureAcRefs(String(fields['覆盖功能'] ?? ''))) {
      const accepted = featureAcs.get(reference.feature);
      if (!accepted || accepted.length === 0 || !accepted.includes(reference.ac)) {
        issues.push(issue('E2E_AC_UNKNOWN', `${node.uid} references unknown AC ${reference.feature}(${reference.ac})`, node.path, node.line, { node: node.uid, severity: 'warning' }));
      }
    }

    // O1: TC status lifecycle validation
    const tcStatus = String(fields['status'] ?? '').trim().toLowerCase();
    if (tcStatus && !VALID_TC_STATUSES.has(tcStatus)) {
      issues.push(issue('E2E_INVALID_TC_STATUS', `${node.uid} has invalid TC status "${tcStatus}"; allowed: ${[...VALID_TC_STATUSES].join(', ')}`, node.path, node.line, { node: node.uid, severity: 'warning' }));
    }
    if (tcStatus === 'waived') {
      const reason = String(fields['waived_reason'] ?? '').trim();
      if (!reason) {
        issues.push(issue('E2E_WAIVED_NO_REASON', `${node.uid} has status "waived" but no waived_reason`, node.path, node.line, { node: node.uid, severity: 'warning' }));
      }
    }

    // O1: chain_type vocabulary validation
    const rawChainType = String(fields['chain_type'] ?? '').trim();
    const chainType = rawChainType.toLowerCase();
    if (rawChainType) {
      if (!VALID_CHAIN_TYPES.has(chainType) && !(chainType in DEPRECATED_CHAIN_TYPE_ALIASES)) {
        issues.push(issue('E2E_INVALID_CHAIN_TYPE', `${node.uid} has invalid chain_type "${rawChainType}"; allowed: ${[...VALID_CHAIN_TYPES].join(', ')}`, node.path, node.line, { node: node.uid, severity: 'warning' }));
      } else if (chainType in DEPRECATED_CHAIN_TYPE_ALIASES) {
        issues.push(issue('E2E_DEPRECATED_CHAIN_TYPE', `${node.uid} uses deprecated chain_type "${rawChainType}"; migrate to "${DEPRECATED_CHAIN_TYPE_ALIASES[chainType]}"`, node.path, node.line, { node: node.uid, severity: 'warning' }));
      }
    }

    // O1: ac_coverage_rate validation — must be derived, not freetext.
    // Any handwritten ac_coverage_rate is rejected; coverage is computed from ac_coverage
    // declarations and the feature acceptance-criteria inventory.
    const rawAcCoverageRate = String(fields['ac_coverage_rate'] ?? '').trim();
    if (rawAcCoverageRate) {
      issues.push(issue('E2E_AC_COVERAGE_RATE_FREETEXT', `${node.uid} has handwritten ac_coverage_rate "${rawAcCoverageRate}"; this field must be derived from ac_coverage and the feature acceptance-criteria inventory`, node.path, node.line, { node: node.uid, severity: 'warning' }));
    }

    // O3: deterministic checklist rules
    if (needsDesktopChainWarning(node)) {
      issues.push(issue('E2E_DESKTOP_CHAIN_WARNING', `${node.uid} appears desktop-related but does not cover the full React/UI -> Tauri/IPC -> Node sidecar/JSON Lines -> core/engine -> SQLite/report data 真实桌面链路`, node.path, node.line, { node: node.uid, severity: 'warning' }));
    }
  }

  for (const [path, nodes] of nodesByPath) {
    const first = nodes[0];
    const declared = flattenAcCoverage(asRecord(first.attrs?.ac_coverage));
    const covered = new Set(nodes.flatMap((node) => toArray(node.attrs?.coveredFeatures).map((value) => {
      const ref = value as { feature?: unknown; ac?: unknown };
      return `${String(ref.feature)}:${String(ref.ac)}`;
    })));
    for (const reference of declared) {
      if (!covered.has(`${reference.feature}:${reference.ac}`)) {
        issues.push(issue('E2E_AC_UNVERIFIED', `${path} declares ${reference.feature}(${reference.ac}) but no TC verifies it`, path, 1, { severity: 'warning' }));
      }
    }
  }

  return issues;
}

function validateE2eRegistry(graph: ArtifactGraph): ValidationIssue[] {
  const registry = graph.nodes.find((node) => node.type === 'e2e_registry');
  if (!registry) {
    return [];
  }
  const attrs = registry.attrs ?? {};
  const e2eNodes = graph.nodes.filter((node) => node.type === 'e2e_test');
  const e2eTestCaseNodes = e2eNodes.filter((node) => node.attrs?.fileLevelOnly !== true);
  const actualBatches = new Set(e2eNodes.map((node) => String(node.attrs?.test_batch ?? node.code.split(':')[0])));
  const byPath = groupBy(e2eNodes, (node) => node.path);
  const issues: ValidationIssue[] = [];

  compareRegistryNumber(issues, registry, 'total_batches', actualBatches.size);
  compareRegistryNumber(issues, registry, 'total_test_cases', e2eTestCaseNodes.length);

  const batches = toArray(attrs.batches).filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null);
  const registeredFiles = new Set<string>();
  for (const batch of batches) {
    const file = String(batch.file ?? '');
    if (file) {
      registeredFiles.add(file);
    }
    const actualNodes = byPath.get(file) ?? [];
    if (actualNodes.length === 0) {
      issues.push(issue('E2E_REGISTRY_MISMATCH', `registry batch ${String(batch.batch_id ?? file)} file ${file || '<missing>'} does not match any E2E test file`, registry.path, registry.line, { node: registry.uid, severity: 'warning' }));
      continue;
    }
    const first = actualNodes[0];
    compareRegistryValue(issues, registry, batch, 'batch_id', first.attrs?.test_batch);
    compareRegistryValue(issues, registry, batch, 'scope', first.attrs?.scope);
    compareRegistryAcCoverage(issues, registry, batch, asRecord(first.attrs?.ac_coverage));
    compareRegistryArray(issues, registry, batch, 'related_scenarios', toArray(first.attrs?.related_scenarios).map((value) => String(value)));
    compareRegistryValue(issues, registry, batch, 'test_case_count', actualNodes.filter((node) => node.attrs?.fileLevelOnly !== true).length);
  }
  for (const path of byPath.keys()) {
    if (!registeredFiles.has(path)) {
      issues.push(issue('E2E_REGISTRY_MISMATCH', `${path} is missing from registry`, registry.path, registry.line, { node: registry.uid, severity: 'warning' }));
    }
  }

  return issues;
}

export async function validateExecutableTraceability(root: string, config?: ArtifactSchema): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const schema = config ?? await loadConfig(root);
  const e2eDir = join(root, 'artifacts', 'tests', 'e2e');

  let e2eFiles: string[];
  try {
    e2eFiles = (await readdir(e2eDir)).filter((name) => /^test-.*\.md$/.test(name)).map((name) => join(e2eDir, name));
  } catch {
    return [];
  }

  const mdToRef = new Map<string, { ref: string; chainType: string; path: string; line: number }>();
  const allMdTcInfo = new Map<string, { chainType: string; path: string; line: number }>();
  const tcKeyToFields = new Map<string, Record<string, string>>();
  const mdBatches = new Set<string>();

  for (const filePath of e2eFiles) {
    const raw = await readFile(filePath, 'utf-8');
    const relPath = relative(root, filePath).split('\\').join('/');
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    const batch = String(data.test_batch ?? basename(filePath, extname(filePath))).trim();
    const lines = raw.split(/\r?\n/);
    const tcStarts: Array<{ id: string; line: number; index: number }> = [];
    lines.forEach((line, index) => {
      const match = /^#{2,3}\s+(TC-\d+[a-z]?)\s*[:：]?\s*.*$/.exec(line);
      if (match) {
        tcStarts.push({ id: match[1], line: index + 1, index });
      }
    });

    for (let i = 0; i < tcStarts.length; i += 1) {
      const start = tcStarts[i];
      const end = tcStarts[i + 1]?.index ?? lines.length;
      const block = lines.slice(start.index, end);
      const fields = extractE2eTcFields(block);
      const tcKey = `${batch}:${start.id}`;
      mdBatches.add(batch);
      tcKeyToFields.set(tcKey, fields);

      const execRef = String(fields['executable_ref'] ?? '').trim();
      const chainType = String(fields['chain_type'] ?? 'desktop_chain').trim();
      allMdTcInfo.set(tcKey, { chainType, path: relPath, line: start.line });
      if (execRef) {
        mdToRef.set(tcKey, { ref: execRef, chainType, path: relPath, line: start.line });
      }
    }
  }

  const allFiles = await walk(root);
  const specFiles = new Set<string>();
  const configuredRunners = schema.e2e?.runners ?? [];
  if (configuredRunners.length > 0) {
    for (const file of allFiles) {
      if (configuredRunners.some((runner) => isRunnerIncludeCandidate(file, runner))) {
        specFiles.add(file);
      }
    }
  } else {
    // Backward-compatible annotation discovery without assuming a product-specific source root.
    for (const file of allFiles) {
      if (/\.(?:e2e\.)?spec\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file)) {
        specFiles.add(file);
      }
    }
  }

  interface TcAnnotation {
    batch: string;
    tcId: string;
    level: string;
    file: string;
    testName: string;
    line: number;
  }
  const refToSource = new Map<string, TcAnnotation[]>();
  // Match both @e2e_test (new canonical) and @tc (deprecated) tags
  const tcAnnotationRegex = /\/\/!?\s*@(?:e2e_test|tc)\s+(\S+?)\s+\[(\w+)\]/;
  const tcAnnotationNoLevelRegex = /\/\/!?\s*@(?:e2e_test|tc)\s+(\S+)/;

  for (const specFile of specFiles) {
    const fullSpecPath = join(root, specFile);
    let content: string;
    try {
      content = await readFile(fullSpecPath, 'utf-8');
    } catch {
      continue;
    }

    const level = detectTestLevel(specFile, content);
    const specLines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < specLines.length; lineIndex += 1) {
      const line = specLines[lineIndex];
      let match = tcAnnotationRegex.exec(line);
      let annotatedLevel = '';
      if (match) {
        annotatedLevel = match[2];
      } else {
        match = tcAnnotationNoLevelRegex.exec(line);
      }
      if (!match) {
        continue;
      }
      const tcRef = match[1];
      const colonIndex = tcRef.indexOf(':');
      if (colonIndex < 0) {
        continue;
      }
      const batch = tcRef.substring(0, colonIndex);
      const tcId = tcRef.substring(colonIndex + 1);
      const effectiveLevel = annotatedLevel || level;
      let testName = '';
      for (let j = lineIndex + 1; j < Math.min(lineIndex + 5, specLines.length); j += 1) {
        const testMatch = /^\s*(?:test|it)\s*\(\s*['"](.+?)['"]/.exec(specLines[j]);
        if (testMatch) {
          testName = testMatch[1];
          break;
        }
      }
      const annotation: TcAnnotation = {
        batch,
        tcId,
        level: effectiveLevel,
        file: specFile,
        testName,
        line: lineIndex + 1,
      };
      const key = `${batch}:${tcId}`;
      const existing = refToSource.get(key) ?? [];
      existing.push(annotation);
      refToSource.set(key, existing);
    }
  }

  // Check A: executable_ref target exists in spec files
  // Supports multi-line executable_ref (one ref per line)
  const tcValidRefFiles = new Map<string, string[]>(); // tcKey → normalized files that passed
  for (const [tcKey, { ref, chainType, path, line }] of mdToRef) {
    if (isPendingExecutableRef(ref)) {
      if (isDesktopChainType(chainType)) {
        issues.push(issue('E2E-TRACE-005', `desktop_chain TC ${tcKey} has pending executable_ref`, path, line, { node: tcKey, severity: 'warning' }));
      }
      continue;
    }
    const refEntries = parseExecutableRefLines(ref);
    const validFiles: string[] = [];
    for (const entry of refEntries) {
      const normalizedRefFile = resolveExecutableRefFile(entry.file, allFiles);
      const fileExists = normalizedRefFile !== undefined && specFiles.has(normalizedRefFile);
      if (!fileExists) {
        issues.push(issue('E2E-TRACE-001', `executable_ref target file not found: ${entry.file}`, path, line, { node: tcKey, severity: 'warning' }));
        continue;
      }
      // O3: unit-test-not-e2e — check if executable_ref is only accepted by unit runners
      // Use runner configuration to determine if the file is only a unit test
      const runners = schema.e2e?.runners ?? [];
      if (runners.length > 0) {
        const acceptingRunners = await getAcceptingRunners(root, normalizedRefFile, runners);
        const hasE2eRunner = acceptingRunners.some((r) => r.kind === 'e2e' || r.kind === 'integration');
        const hasUnitRunner = acceptingRunners.some((r) => r.kind === 'unit');
        if (hasUnitRunner && !hasE2eRunner && acceptingRunners.length > 0) {
          issues.push(issue('E2E-UNIT-TEST-NOT-E2E', `executable_ref target ${entry.file} is only accepted by unit runner(s) [${acceptingRunners.map((r) => r.name).join(', ')}], not by any e2e/integration runner`, path, line, { node: tcKey, severity: 'warning' }));
        }
      }
      if (entry.testId) {
        let content: string;
        try {
          content = await readFile(join(root, normalizedRefFile), 'utf-8');
        } catch {
          continue;
        }
        const testIdPattern = new RegExp(`(?:test|it)\\s*\\(\\s*['"].*?${escapeRegExp(entry.testId)}.*?['"]`);
        if (!testIdPattern.test(content)) {
          issues.push(issue('E2E-TRACE-001', `executable_ref target test "${entry.testId}" not found in ${entry.file}`, path, line, { node: tcKey, severity: 'warning' }));
          continue;
        }
      }
      // Check that the referenced file has a @e2e_test or @tc line-comment annotation for this TC.
      // Block-comment annotations (e.g. JSDoc) are NOT recognized — only `// @e2e_test` or `// @tc` is valid.
      const annotationsForTc = refToSource.get(tcKey);
      const hasAnnotationInFile = annotationsForTc?.some((ann) => ann.file === normalizedRefFile) ?? false;
      if (!hasAnnotationInFile) {
        issues.push(issue('E2E-TRACE-003', `executable_ref target ${entry.file} has no E2E trace annotation ${tcKey}`, path, line, { node: tcKey, severity: 'warning' }));
        continue;
      }
      validFiles.push(normalizedRefFile);
    }
    tcValidRefFiles.set(tcKey, validFiles);
  }

  // Check B: E2E trace annotation references non-existent Markdown TC
  for (const [tcKey, annotations] of refToSource) {
    const batch = tcKey.split(':')[0];
    if (!mdBatches.has(batch)) {
      for (const ann of annotations) {
        issues.push(issue('E2E-TRACE-002', `E2E trace annotation ${tcKey} references non-existent E2E batch "${batch}"`, ann.file, ann.line, { node: tcKey, severity: 'warning' }));
      }
      continue;
    }
    if (!mdToRef.has(tcKey) && !await hasMarkdownTc(tcKey, e2eDir)) {
      for (const ann of annotations) {
        issues.push(issue('E2E-TRACE-002', `E2E trace annotation ${tcKey} references non-existent Markdown TC`, ann.file, ann.line, { node: tcKey, severity: 'warning' }));
      }
    }
  }

  // Check C: bidirectional consistency
  // Check C: bidirectional consistency (supports multi-line executable_ref)
  for (const [tcKey, { ref, path, line }] of mdToRef) {
    if (isPendingExecutableRef(ref)) {
      continue;
    }
    const sourceAnnotations = refToSource.get(tcKey);
    if (!sourceAnnotations || sourceAnnotations.length === 0) {
      continue;
    }
    const validFiles = tcValidRefFiles.get(tcKey) ?? [];
    const refEntries = parseExecutableRefLines(ref);
    for (const ann of sourceAnnotations) {
      // For multi-ref: annotation matches if it corresponds to ANY validated ref file
      const matchesAnyRef = validFiles.some((vf) => ann.file === vf);
      if (matchesAnyRef) {
        continue;
      }
      // Check against all ref entries for detail reporting
      const detail = `file: MD refs=[${refEntries.map((e) => e.file).join(', ')}] vs source=${ann.file}`;
      issues.push(issue('E2E-TRACE-003', `executable_ref ↔ E2E trace annotation mismatch for ${tcKey}: ${detail}`, path, line, { node: tcKey, severity: 'warning' }));
    }
  }

  // Check D: desktop_chain TC points to mock_playwright test
  // Only check annotations in files that are actually referenced by this TC's executable_ref.
  // Per artifact-chain-spec §5.2: evidence level authority is the Markdown TC side, not source annotations.
  // When Markdown explicitly declares desktop_chain via chain_type field, suppress E2E-TRACE-004 entirely.

  // Check D0: desktop_chain TC without executable_ref
  // Only check TCs that explicitly declare chain_type as desktop_chain (not default)
  for (const [tcKey, { chainType, path, line }] of allMdTcInfo) {
    const tcFields = tcKeyToFields.get(tcKey);
    const explicitChainType = String(tcFields?.['chain_type'] ?? '').trim().toLowerCase();
    if (explicitChainType !== 'desktop_chain') {
      continue; // Only check explicitly declared desktop_chain TCs
    }
    if (!mdToRef.has(tcKey)) {
      issues.push(issue('E2E-DESKTOP-CHAIN-MISSING', `desktop_chain TC ${tcKey} has no executable_ref`, path, line, { node: tcKey, severity: 'warning' }));
    }
  }
  for (const [tcKey, { chainType, path, line }] of mdToRef) {
    const normalizedDeclaredChainType = chainType.trim().toLowerCase();
    const hasLegalNonDesktopDeclaration = normalizedDeclaredChainType.length > 0
      && VALID_CHAIN_TYPES.has(normalizedDeclaredChainType)
      && normalizedDeclaredChainType !== 'desktop_chain';
    if (hasLegalNonDesktopDeclaration) continue;
    const validFiles = new Set(tcValidRefFiles.get(tcKey) ?? []);
    const sourceAnnotations = refToSource.get(tcKey);
    if (!sourceAnnotations) {
      continue;
    }
    // Check if the TC explicitly declared desktop_chain (not just default empty)
    const tcFields = tcKeyToFields.get(tcKey);
    const explicitChainType = String(tcFields?.['chain_type'] ?? '').trim().toLowerCase();
    const hasExplicitDesktopChain = explicitChainType === 'desktop_chain';
    // Skip E2E-TRACE-004 when Markdown explicitly declares desktop_chain (Markdown authority)
    if (hasExplicitDesktopChain) {
      continue;
    }
    for (const ann of sourceAnnotations) {
      if (!validFiles.has(ann.file)) {
        continue; // Skip annotations from files not in this TC's executable_ref
      }
      if (ann.level === 'mock_playwright') {
        issues.push(issue('E2E-TRACE-004', `desktop_chain TC ${tcKey} points to mock_playwright test in ${ann.file}`, path, line, { node: tcKey, severity: 'warning' }));
      }
    }
  }

  // Check E: desktop_chain coverage validation — complete, partial, and pending
  for (const [tcKey, { chainType, path, line }] of allMdTcInfo) {
    if (!isDesktopChainType(chainType)) {
      continue;
    }
    const tcFields = tcKeyToFields.get(tcKey);
    if (!tcFields) {
      continue;
    }
    const chainCoverage = String(tcFields['chain_coverage'] ?? '').trim().toLowerCase();
    const chainCoverageStatus = parseChainCoverageStatus(chainCoverage);
    const pendingField = String(tcFields['pending'] ?? '').trim();
    const isComplete = chainCoverageStatus === 'complete';
    const hasPartialCoverage = chainCoverageStatus === 'partial';
    const hasPendingField = pendingField.length > 0;

    if (!isComplete && !hasPartialCoverage && !hasPendingField) {
      continue;
    }

    // Filter annotations to only files validated in this TC's executable_ref.
    const validFiles = new Set(tcValidRefFiles.get(tcKey) ?? []);
    const sourceAnnotations = refToSource.get(tcKey)?.filter((ann) => validFiles.has(ann.file));

    const hasDesktopChain = sourceAnnotations?.some((ann) => ann.level === 'desktop_chain') ?? false;
    const hasBridge = sourceAnnotations?.some((ann) => ann.level === 'ui_sidecar_bridge') ?? false;

    if (isComplete) {
      // Validate composite complete per artifact-chain-spec §5.3:
      //  - [desktop_chain] alone → covers all 5 layers (real Tauri runtime), suppress IF no pending.
      //  - [ui_sidecar_bridge] + verified [partial_rust] → composite complete, suppress IF no pending.
      //  - [ui_sidecar_bridge] without valid [partial_rust] → incomplete, warn.
      //  - [mock_playwright] only → never counts toward complete, warn.
      //  - pending field → always warn, even with valid evidence.
      let evidenceDetail = '';
      let hasValidEvidence = false;

      if (hasDesktopChain) {
        hasValidEvidence = true;
      } else if (hasBridge) {
        const partialResult = await validatePartialRustEvidence(tcFields, tcKey, root, allFiles);
        if (partialResult.hasValidPartialRust) {
          hasValidEvidence = true;
        } else {
          evidenceDetail = partialResult.detail;
        }
      }

      if (hasValidEvidence && hasPendingField) {
        // Valid evidence but pending field still set — warn
        issues.push(issue(
          'E2E-TRACE-006',
          `desktop_chain TC ${tcKey} declared complete with valid evidence but has pending field: "${pendingField}"`,
          path,
          line,
          { node: tcKey, severity: 'warning' },
        ));
      } else if (hasValidEvidence) {
        continue; // complete and valid, no pending
      } else if (hasPendingField) {
        issues.push(issue(
          'E2E-TRACE-006',
          `desktop_chain TC ${tcKey} declared complete but has pending field: "${pendingField}"${evidenceDetail ? `; ${evidenceDetail}` : ''}`,
          path,
          line,
          { node: tcKey, severity: 'warning' },
        ));
      } else {
        issues.push(issue(
          'E2E-TRACE-006',
          `desktop_chain TC ${tcKey} declared complete but missing valid desktop_chain or ui_sidecar_bridge + partial_rust evidence${evidenceDetail ? `; ${evidenceDetail}` : ''}`,
          path,
          line,
          { node: tcKey, severity: 'warning' },
        ));
      }
    } else {
      // partial / pending path — check for suppress conditions
      if (hasDesktopChain) {
        continue;
      }
      let partialDetail = '';
      if (hasBridge) {
        const partialResult = await validatePartialRustEvidence(tcFields, tcKey, root, allFiles);
        if (partialResult.hasValidPartialRust) {
          continue; // composite complete: ui_sidecar_bridge + verified partial_rust
        }
        partialDetail = partialResult.detail;
      }
      issues.push(issue(
        'E2E-TRACE-006',
        `partial desktop_chain coverage — full desktop_chain harness pending for ${tcKey}${partialDetail ? `; ${partialDetail}` : ''}`,
        path,
        line,
        { node: tcKey, severity: 'warning' },
      ));
    }
  }

  return issues;
}

/** O2: E2E coverage statistics and blackhole diagnostics */
export interface E2eCoverageStats {
  totalTestCases: number;
  withExecutableRef: number;
  executableRefRate: string;
  /** TCs by status */
  statusBreakdown: Record<string, number>;
  /** TCs by chain_type */
  chainTypeBreakdown: Record<string, number>;
  /** Scenarios with zero E2E coverage */
  uncoveredScenarios: string[];
  /** Features with zero E2E coverage */
  uncoveredFeatures: string[];
  /** Configurable thresholds */
  thresholdWarnings: string[];
  thresholdErrors: string[];
  /** Derived ac_coverage_rate per feature */
  acCoverageRateByFeature: Record<string, { numerator: number; denominator: number; rate: number }>;
  /** Multi-dimensional scenario coverage */
  scenarioCoverage: Record<string, { linked: boolean; acCovered: boolean; waived: boolean; verified: boolean }>;
  /** Multi-dimensional feature coverage */
  featureCoverage: Record<string, { linked: boolean; acCovered: boolean; waived: boolean; verified: boolean }>;
}

export interface E2eCoverageThresholds {
  /** Minimum executable_ref coverage rate (0-1). Below this triggers warning. */
  executableRefWarning?: number;
  /** Minimum executable_ref coverage rate (0-1). Below this triggers error. */
  executableRefError?: number;
  /** Whether to report uncovered scenarios as warnings. Default true. */
  reportUncoveredScenarios?: boolean;
  /** Whether to report uncovered features as warnings. Default true. */
  reportUncoveredFeatures?: boolean;
  /** Explicit waivers: scenario IDs that are waived from coverage requirements */
  scenarioWaivers?: E2eWaiver[];
  /** Explicit waivers: feature IDs that are waived from coverage requirements */
  featureWaivers?: E2eWaiver[];
}

export async function computeE2eCoverageStats(
  graph: ArtifactGraph,
  root: string,
  thresholds: E2eCoverageThresholds = {},
): Promise<E2eCoverageStats> {
  const e2eNodes = graph.nodes.filter((n) => n.type === 'e2e_test' && n.attrs?.fileLevelOnly !== true);
  const totalTestCases = e2eNodes.length;

  // Count executable_ref coverage
  let withExecutableRef = 0;
  const statusBreakdown: Record<string, number> = {};
  const chainTypeBreakdown: Record<string, number> = {};

  const e2eDir = join(root, 'artifacts', 'tests', 'e2e');
  const tcFieldsMap = new Map<string, Record<string, string>>();

  // Parse TC fields for all e2e test files
  let e2eFiles: string[];
  try {
    e2eFiles = (await readdir(e2eDir)).filter((name) => /^test-.*\.md$/.test(name)).map((name) => join(e2eDir, name));
  } catch {
    e2eFiles = [];
  }

  for (const filePath of e2eFiles) {
    const raw = await readFile(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const tcStarts: Array<{ id: string; index: number }> = [];
    lines.forEach((line, index) => {
      const match = /^#{2,3}\s+(TC-\d+[a-z]?)\s*[:：]?\s*.*$/.exec(line);
      if (match) {
        tcStarts.push({ id: match[1], index });
      }
    });
    const parsed = matter(raw);
    const batch = String((parsed.data as Record<string, unknown>).test_batch ?? basename(filePath, extname(filePath))).trim();
    for (let i = 0; i < tcStarts.length; i++) {
      const start = tcStarts[i];
      const end = tcStarts[i + 1]?.index ?? lines.length;
      const block = lines.slice(start.index, end);
      const fields = extractE2eTcFields(block);
      tcFieldsMap.set(`${batch}:${start.id}`, fields);
    }
  }

  for (const node of e2eNodes) {
    const tcKey = node.code;
    const fields = tcFieldsMap.get(tcKey) ?? asRecord(node.attrs?.tcFields);
    const execRef = String(fields['executable_ref'] ?? '').trim();
    if (execRef && !isPendingExecutableRef(execRef)) {
      withExecutableRef++;
    }

    const status = String(fields['status'] ?? 'created').trim().toLowerCase();
    statusBreakdown[status] = (statusBreakdown[status] ?? 0) + 1;

    const chainType = String(fields['chain_type'] ?? '').trim().toLowerCase() || 'unspecified';
    chainTypeBreakdown[chainType] = (chainTypeBreakdown[chainType] ?? 0) + 1;
  }

  const executableRefRate = totalTestCases > 0
    ? `${withExecutableRef}/${totalTestCases} (${(withExecutableRef / totalTestCases * 100).toFixed(1)}%)`
    : '0/0';

  // O2: Scenario and feature coverage gap detection
  const scenarioNodes = graph.nodes.filter((n) => n.type === 'scenario');
  const featureNodes = graph.nodes.filter((n) => n.type === 'feature');

  // Multi-dimensional coverage tracking
  const linkedScenarios = new Set<string>();
  const linkedFeatures = new Set<string>();
  const acCoveredScenarios = new Set<string>();
  const acCoveredFeatures = new Set<string>();
  const verifiedScenarios = new Set<string>();
  const verifiedFeatures = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.kind === 'verifies' && edge.from.startsWith('e2e_test:')) {
      if (edge.to.startsWith('scenario:')) {
        linkedScenarios.add(edge.to.replace('scenario:', ''));
      }
      if (edge.to.startsWith('feature:')) {
        linkedFeatures.add(edge.to.replace('feature:', ''));
      }
    }
  }

  // Check AC coverage from e2e_test ac_coverage declarations
  for (const node of e2eNodes) {
    const fields = tcFieldsMap.get(node.code) ?? asRecord(node.attrs?.tcFields);
    const acCoverage = asRecord(fields['ac_coverage'] ?? node.attrs?.ac_coverage);
    for (const feature of Object.keys(acCoverage)) {
      acCoveredFeatures.add(feature);
    }
    // Check if TC covers scenarios via ac_coverage
    const relatedScenarios = toArray(fields['related_scenarios'] ?? node.attrs?.related_scenarios).map(String);
    for (const scenario of relatedScenarios) {
      acCoveredScenarios.add(scenario);
    }
  }

  // Check verified status from TC fields
  // Verified requires: status=verified AND non-pending executable_ref AND target active in e2e runner
  const runners = (await loadConfig(root)).e2e?.runners ?? [];
  const allProjectFiles = await walk(root);
  for (const node of e2eNodes) {
    const fields = tcFieldsMap.get(node.code) ?? asRecord(node.attrs?.tcFields);
    const status = String(fields['status'] ?? '').trim().toLowerCase();
    const execRef = String(fields['executable_ref'] ?? '').trim();
    if (status !== 'verified') continue;
    // Must have non-pending executable_ref
    if (!execRef || isPendingExecutableRef(execRef)) continue;
    // Check that executable_ref target is active in at least one e2e runner
    if (runners.length === 0) continue;
    let hasActiveE2eRef = false;
    for (const entry of parseExecutableRefLines(execRef)) {
      const normalized = resolveExecutableRefFile(entry.file, allProjectFiles);
      if (!normalized || !existsSync(join(root, normalized))) continue;
      const accepting = await getAcceptingRunners(root, normalized, runners);
      if (accepting.some((runner) => runner.kind === 'e2e')) {
        hasActiveE2eRef = true;
        break;
      }
    }
    if (!hasActiveE2eRef) continue;
    // Mark all related scenarios and features as verified
    const relatedScenarios = toArray(fields['related_scenarios'] ?? node.attrs?.related_scenarios).map(String);
    for (const scenario of relatedScenarios) {
      verifiedScenarios.add(scenario);
    }
    const acCoverage = asRecord(fields['ac_coverage'] ?? node.attrs?.ac_coverage);
    for (const feature of Object.keys(acCoverage)) {
      verifiedFeatures.add(feature);
    }
  }

  const scenarioWaivers = new Set((thresholds.scenarioWaivers ?? []).map((w) => w.id));
  const featureWaivers = new Set((thresholds.featureWaivers ?? []).map((w) => w.id));

  const uncoveredScenarios = scenarioNodes
    .map((n) => n.code)
    .filter((code) => !linkedScenarios.has(code) && !scenarioWaivers.has(code));

  // Gap 5: uncoveredFeatures uses AC coverage, not just linked edges.
  // A feature is covered if it has ac_coverage declarations from e2e tests.
  const uncoveredFeatures = featureNodes
    .map((n) => n.code)
    .filter((code) => !acCoveredFeatures.has(code) && !featureWaivers.has(code));

  // Build multi-dimensional coverage maps
  const scenarioCoverage: Record<string, { linked: boolean; acCovered: boolean; waived: boolean; verified: boolean }> = {};
  for (const node of scenarioNodes) {
    scenarioCoverage[node.code] = {
      linked: linkedScenarios.has(node.code),
      acCovered: acCoveredScenarios.has(node.code),
      waived: scenarioWaivers.has(node.code),
      verified: !scenarioWaivers.has(node.code) && verifiedScenarios.has(node.code),
    };
  }

  const featureCoverage: Record<string, { linked: boolean; acCovered: boolean; waived: boolean; verified: boolean }> = {};
  for (const node of featureNodes) {
    featureCoverage[node.code] = {
      linked: linkedFeatures.has(node.code),
      acCovered: acCoveredFeatures.has(node.code),
      waived: featureWaivers.has(node.code),
      verified: !featureWaivers.has(node.code) && verifiedFeatures.has(node.code),
    };
  }

  // Threshold checks
  const thresholdWarnings: string[] = [];
  const thresholdErrors: string[] = [];

  const warningRate = thresholds.executableRefWarning;
  const errorRate = thresholds.executableRefError;
  const actualRate = totalTestCases > 0 ? withExecutableRef / totalTestCases : 1;

  if (warningRate !== undefined && actualRate < warningRate) {
    thresholdWarnings.push(`executable_ref coverage ${executableRefRate} < warning threshold ${(warningRate * 100).toFixed(0)}%`);
  }
  if (errorRate !== undefined && actualRate < errorRate) {
    thresholdErrors.push(`executable_ref coverage ${executableRefRate} < error threshold ${(errorRate * 100).toFixed(0)}%`);
  }

  if (thresholds.reportUncoveredScenarios !== false && uncoveredScenarios.length > 0) {
    thresholdWarnings.push(`${uncoveredScenarios.length} scenario(s) have no E2E coverage: ${uncoveredScenarios.join(', ')}`);
  }
  if (thresholds.reportUncoveredFeatures !== false && uncoveredFeatures.length > 0) {
    thresholdWarnings.push(`${uncoveredFeatures.length} feature(s) have no E2E coverage: ${uncoveredFeatures.join(', ')}`);
  }

  // O1: Derive ac_coverage_rate per feature from ac_coverage declarations
  const acCoverageRateByFeature: Record<string, { numerator: number; denominator: number; rate: number }> = {};

  // Get all feature ACs from PRD features
  const featureAcMap = new Map<string, Set<string>>();
  for (const node of featureNodes) {
    const acs = parseAcceptanceCriteria(await readFile(join(root, node.path), 'utf-8'));
    featureAcMap.set(node.code, new Set(acs));
  }

  // Count covered ACs per feature from e2e_test ac_coverage declarations
  const coveredAcByFeature = new Map<string, Set<string>>();
  for (const node of e2eNodes) {
    const fields = tcFieldsMap.get(node.code) ?? asRecord(node.attrs?.tcFields);
    const acCoverage = asRecord(fields['ac_coverage'] ?? node.attrs?.ac_coverage);
    for (const [feature, acs] of Object.entries(acCoverage)) {
      const existing = coveredAcByFeature.get(feature) ?? new Set<string>();
      for (const ac of toArray(acs)) {
        existing.add(String(ac));
      }
      coveredAcByFeature.set(feature, existing);
    }
  }

  // Calculate coverage rate per feature
  for (const [feature, allAcs] of featureAcMap) {
    const denominator = allAcs.size;
    if (denominator === 0) continue;
    const coveredAcs = coveredAcByFeature.get(feature) ?? new Set<string>();
    const numerator = [...coveredAcs].filter((ac) => allAcs.has(ac)).length;
    acCoverageRateByFeature[feature] = {
      numerator,
      denominator,
      rate: denominator > 0 ? numerator / denominator : 0,
    };
  }

  return {
    totalTestCases,
    withExecutableRef,
    executableRefRate,
    statusBreakdown,
    chainTypeBreakdown,
    uncoveredScenarios,
    uncoveredFeatures,
    thresholdWarnings,
    thresholdErrors,
    acCoverageRateByFeature,
    scenarioCoverage,
    featureCoverage,
  };
}

/** O4: Deterministic, idempotent E2E registry generation from Markdown sources */
export interface E2eRegistryBatch {
  batch_id: string;
  file: string;
  scope: string;
  ac_coverage: Record<string, string[]>;
  related_scenarios: string[];
  test_case_count: number;
  status_summary?: Record<string, number>;
  /** Batch-level status: 'blocked' when frontmatter fixes_block indicates blocking */
  status?: string;
  /** Blocking reasons from frontmatter fixes_block */
  blocking_reasons?: Record<string, string>;
}

export interface E2eRegistry {
  registry_version: string;
  generated_at: string;
  total_batches: number;
  total_test_cases: number;
  batches: E2eRegistryBatch[];
}

/**
 * Generate E2E registry from Markdown test files.
 * Deterministic: same input always produces same output (except generated_at).
 * Use `--deterministic` to set generated_at to epoch for idempotent diff checks.
 */
export async function generateE2eRegistry(root: string, opts?: { deterministic?: boolean }): Promise<E2eRegistry> {
  const e2eDir = join(root, 'artifacts', 'tests', 'e2e');
  let files: string[];
  try {
    files = (await readdir(e2eDir))
      .filter((name) => /^test-.*\.md$/.test(name))
      .sort();
  } catch {
    return {
      registry_version: '1.0',
      generated_at: opts?.deterministic ? '1970-01-01T00:00:00.000Z' : new Date().toISOString(),
      total_batches: 0,
      total_test_cases: 0,
      batches: [],
    };
  }

  const batches: E2eRegistryBatch[] = [];
  let totalTestCases = 0;

  for (const file of files) {
    const filePath = join(e2eDir, file);
    const raw = await readFile(filePath, 'utf-8');
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    const batch = String(data.test_batch ?? basename(file, extname(file))).trim();
    const relPath = `artifacts/tests/e2e/${file}`;

    const scope = String(data.scope ?? '').trim();
    const acCoverage = normalizeAcCoverageForRegistry(data.ac_coverage);
    const relatedScenarios = toArray(data.related_scenarios).map(String).filter(Boolean);

    const lines = raw.split(/\r?\n/);
    const tcStarts: Array<{ id: string; index: number }> = [];
    lines.forEach((line, index) => {
      const match = /^#{2,3}\s+(TC-\d+[a-z]?)\s*[:：]?\s*.*$/.exec(line);
      if (match) {
        tcStarts.push({ id: match[1], index });
      }
    });

    const statusSummary: Record<string, number> = {};
    const blockingReasons: Record<string, string> = {};

    // Check frontmatter-level blocking (fixes_block is in frontmatter, not TC fields)
    const frontmatterFixesBlock = String(data.fixes_block ?? '').trim();
    if (frontmatterFixesBlock && /no\s+(test\s+file|e2e)/i.test(frontmatterFixesBlock)) {
      // All TCs in this batch are blocked by frontmatter declaration
      for (const tc of tcStarts) {
        blockingReasons[tc.id] = frontmatterFixesBlock;
      }
    }

    for (const start of tcStarts) {
      const end = tcStarts[tcStarts.indexOf(start) + 1]?.index ?? lines.length;
      const block = lines.slice(start.index, end);
      const fields = extractE2eTcFields(block);
      const status = String(fields['status'] ?? 'created').trim().toLowerCase() || 'created';
      statusSummary[status] = (statusSummary[status] ?? 0) + 1;

      // Check for TC-level blocking conditions when status is 'created'
      if (status === 'created' && !blockingReasons[start.id]) {
        const executableRef = String(fields['executable_ref'] ?? '').trim();
        const chainType = String(fields['chain_type'] ?? '').trim().toLowerCase();

        if (!executableRef && chainType === 'desktop_chain') {
          blockingReasons[start.id] = 'desktop_chain TC requires executable_ref';
        } else if (isPendingExecutableRef(executableRef)) {
          blockingReasons[start.id] = `pending: ${executableRef}`;
        }
      }
    }

    const testCaseCount = tcStarts.length;
    totalTestCases += testCaseCount;

    // Batch status: 'blocked' when frontmatter has blocking fixes_block, otherwise undefined
    const batchStatus = Object.keys(blockingReasons).length > 0 ? 'blocked' : undefined;

    batches.push({
      batch_id: batch,
      file: relPath,
      scope,
      ac_coverage: acCoverage,
      related_scenarios: relatedScenarios,
      test_case_count: testCaseCount,
      status_summary: statusSummary,
      status: batchStatus,
      blocking_reasons: Object.keys(blockingReasons).length > 0 ? blockingReasons : undefined,
    });
  }

  return {
    registry_version: '1.0',
    generated_at: opts?.deterministic ? '1970-01-01T00:00:00.000Z' : new Date().toISOString(),
    total_batches: batches.length,
    total_test_cases: totalTestCases,
    batches,
  };
}

function normalizeAcCoverageForRegistry(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, string[]> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(val)) {
      result[key] = val.map(String);
    } else if (typeof val === 'string') {
      result[key] = val.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return result;
}

function isPendingExecutableRef(ref: string): boolean {
  // "pending" must appear as a line-level status marker, not inside file paths.
  // Convention: "pending — reason", "(pending — ...)", or "- pending" as the first meaningful word.
  const stripped = ref.replace(/^[\s-*()]+/, '').trim();
  return /^pending\b/i.test(stripped);
}

/**
 * Parse a multi-line `executable_ref` value into individual ref entries.
 *
 * Supports two formats:
 *  - Single-line: `"path/to/file.spec.ts::test-id"`
 *  - Multi-line list (one ref per line, with optional `- ` prefix):
 *    ```
 *    - `path/to/file1.spec.ts::test-id` — note
 *    - `path/to/file2.rs::test-id` — note
 *    ```
 */
function parseExecutableRefLines(ref: string): Array<{ file: string; testId?: string }> {
  const lines = ref.split('\n').filter((l) => l.trim().length > 0);
  const results: Array<{ file: string; testId?: string }> = [];
  for (const line of (lines.length === 0 ? [ref] : lines)) {
    // Strip list prefix and extract inline code (`...`)
    const codeMatch = /`([^`]+)`/.exec(line);
    const raw = codeMatch ? codeMatch[1] : line.replace(/^[-*]\s*/, '').trim();
    const parts = raw.split('::');
    const file = parts[0]?.trim();
    if (!file) continue;
    results.push({ file, testId: parts[1]?.trim() || undefined });
  }
  return results;
}

// O1: TC status lifecycle and chain_type vocabulary
const VALID_TC_STATUSES = new Set(['created', 'automated', 'verified', 'waived']);
const VALID_CHAIN_TYPES = new Set([
  'desktop_chain', 'mock_playwright', 'core_e2e', 'cli_e2e',
  'ui_sidecar_bridge', 'partial_sidecar', 'partial_rust',
]);
// Legacy aliases → canonical mapping (accepted with migration warning)
const DEPRECATED_CHAIN_TYPE_ALIASES: Record<string, string> = {
  core_only: 'core_e2e',
  frontend_only: 'mock_playwright',
};

function isDesktopChainType(chainType: string): boolean {
  const normalizedChainType = chainType.trim().toLowerCase();
  return normalizedChainType === 'desktop_chain' || normalizedChainType === '';
}

function parseChainCoverageStatus(chainCoverage: string): string {
  return chainCoverage.trim().toLowerCase().match(/^[a-z_]+/)?.[0] ?? '';
}

/**
 * Validate that `partial_evidence` references a real `.rs` file with a matching `// @tc` annotation.
 *
 * Parses backtick-wrapped file paths from the `partial_evidence` field, checks that each
 * `.rs` file exists on disk, and verifies it contains a `// @tc` or `//! @tc` line-comment
 * annotation matching the given TC key at the `[partial_rust]` level.
 */
async function validatePartialRustEvidence(
  tcFields: Record<string, string>,
  tcKey: string,
  root: string,
  allFiles: string[],
): Promise<{ hasValidPartialRust: boolean; detail: string }> {
  const partialEvidence = String(tcFields['partial_evidence'] ?? '');
  if (!partialEvidence.trim()) {
    return { hasValidPartialRust: false, detail: 'no partial_evidence field' };
  }

  // Parse backtick-wrapped file paths, same pattern as parseExecutableRefLines
  const refEntries: Array<{ file: string }> = [];
  for (const line of partialEvidence.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const codeMatch = /`([^`]+)`/.exec(trimmed);
    const raw = codeMatch ? codeMatch[1] : trimmed.replace(/^[-*]\s*/, '').trim();
    const filePath = raw.split('::')[0]?.split('—')[0]?.split('–')[0]?.trim();
    if (filePath) {
      refEntries.push({ file: filePath });
    }
  }

  if (refEntries.length === 0) {
    return { hasValidPartialRust: false, detail: 'no file paths found in partial_evidence' };
  }

  // Check each .rs file
  const rustRefs = refEntries.filter((e) => e.file.endsWith('.rs'));
  if (rustRefs.length === 0) {
    return { hasValidPartialRust: false, detail: 'no .rs file in partial_evidence' };
  }

  for (const ref of rustRefs) {
    const normalizedPath = resolveExecutableRefFile(ref.file, allFiles);
    if (!normalizedPath) {
      return { hasValidPartialRust: false, detail: `partial_rust file not found: ${ref.file}` };
    }
    const fullPath = join(root, normalizedPath);
    let content: string;
    try {
      content = await readFile(fullPath, 'utf-8');
    } catch {
      return { hasValidPartialRust: false, detail: `partial_rust file not found: ${ref.file}` };
    }

    // Check for @e2e_test or @tc annotation matching this TC key.
    // Support both `// @tc` / `// @e2e_test` and `//! @tc` / `//! @e2e_test` (Rust doc-comment line).
    // Also require the annotation level to be [partial_rust].
    const tcAnnotationPattern = new RegExp(
      `//[/!]?\\s*@(?:e2e_test|tc)\\s+${escapeRegExp(tcKey)}\\s+\\[partial_rust\\]`,
    );
    if (!tcAnnotationPattern.test(content)) {
      // Also check without explicit level — if file only has `// @tc` or `// @e2e_test` without level
      const noLevelPattern = new RegExp(`//[/!]?\\s*@(?:e2e_test|tc)\\s+${escapeRegExp(tcKey)}\\b`);
      if (noLevelPattern.test(content)) {
        return { hasValidPartialRust: false, detail: `partial_rust file ${ref.file} has E2E trace annotation ${tcKey} but not tagged [partial_rust]` };
      }
      return { hasValidPartialRust: false, detail: `partial_rust file ${ref.file} has no E2E trace annotation ${tcKey}` };
    }
  }

  return { hasValidPartialRust: true, detail: 'ok' };
}

function detectTestLevel(specFile: string, content: string): string {
  const isInCore = /packages\/core\//.test(specFile) || /packages\/engine-/.test(specFile);
  if (isInCore) {
    return 'core_e2e';
  }
  const isInCli = /packages\/cli\//.test(specFile);
  if (isInCli) {
    return 'cli_e2e';
  }
  const usesMock = /setupTauriMock|setupEmptyTauriMock|__TAURI_INTERNALS__/.test(content);
  if (usesMock) {
    return 'mock_playwright';
  }
  return 'desktop_chain';
}

/**
 * Resolve an executable reference without assuming a product-specific source root.
 * Project-relative paths win; references relative to a nested consumer repository are
 * accepted only when their normalized suffix identifies exactly one project file.
 */
function resolveExecutableRefFile(refFile: string, allFiles: string[]): string | undefined {
  const normalized = refFile.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || isAbsolute(refFile) || normalized.split('/').includes('..')) {
    return undefined;
  }
  if (allFiles.includes(normalized)) {
    return normalized;
  }
  const suffix = `/${normalized}`;
  const matches = allFiles.filter((file) => file.endsWith(suffix));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Return whether a file is in a runner's root and matches an include pattern. */
function isRunnerIncludeCandidate(filePath: string, runner: E2eRunnerConfig): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const runnerRoot = runner.root.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.';
  if (runnerRoot !== '.' && !normalizedPath.startsWith(`${runnerRoot}/`)) {
    return false;
  }
  const relativePath = runnerRoot === '.'
    ? normalizedPath
    : normalizedPath.slice(runnerRoot.length + 1);
  return runner.include.some((pattern) => matchesRunnerGlob(relativePath, pattern));
}

/**
 * Get all runners that accept a given file path based on include/exclude/testIgnore patterns.
 */
async function getAcceptingRunners(
  root: string,
  filePath: string,
  runners: E2eRunnerConfig[],
): Promise<E2eRunnerConfig[]> {
  const accepting: E2eRunnerConfig[] = [];
  for (const runner of runners) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const runnerRoot = runner.root.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.';
    const relativePath = runnerRoot === '.'
      ? normalizedPath
      : normalizedPath.startsWith(runnerRoot + '/')
        ? normalizedPath.slice(runnerRoot.length + 1)
        : normalizedPath;
    if (runnerRoot !== '.' && !normalizedPath.startsWith(`${runnerRoot}/`)) {
      continue;
    }
    const matchesInclude = runner.include.some((p) => matchesRunnerGlob(relativePath, p));
    if (!matchesInclude) continue;
    const matchesExclude = (runner.exclude ?? []).some((p) => matchesRunnerGlob(relativePath, p));
    if (matchesExclude) continue;
    const matchesTestIgnore = (runner.testIgnore ?? []).some((p) => matchesRunnerGlob(relativePath, p));
    if (matchesTestIgnore) continue;
    accepting.push(runner);
  }
  return accepting;
}

function splitMarkdownCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length && line[i + 1] === '|' && !inCode) {
      current += '|';
      i++;
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  if (cells.length > 0 && cells[0].trim() === '') {
    cells.shift();
  }
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') {
    cells.pop();
  }
  return cells;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function hasMarkdownTc(tcKey: string, e2eDir: string): Promise<boolean> {
  const [batch, tcId] = tcKey.split(':');
  const filePath = join(e2eDir, `${batch}.md`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const tcRegex = new RegExp(`^#{2,3}\\s+${escapeRegExp(tcId)}\\s*[:：]?`, 'm');
    return tcRegex.test(raw);
  } catch {
    return false;
  }
}

async function findFiles(root: string, patterns: string[]): Promise<string[]> {
  const all = await walk(root);
  const matched = new Set<string>();
  for (const pattern of patterns) {
    for (const file of all) {
      if (matchesPattern(file, pattern)) {
        matched.add(file);
      }
    }
  }
  return [...matched].sort();
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || entry.name === '.artifact-graph') {
      continue;
    }
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(root, fullPath));
    } else {
      files.push(relative(root, fullPath).split('\\').join('/'));
    }
  }
  return files;
}

function matchesPattern(file: string, pattern: string): boolean {
  if (!pattern.includes('*')) {
    return file === pattern;
  }
  return globToRegExp(pattern).test(file);
}

function extractCodes(text: string, type: string, schema?: ArtifactSchema): string[] {
  const corePatterns: Record<string, RegExp> = {
    decision: /\bD-[A-Z]+-\d+\b/g,
    entity: /\bE-\d{3,}\b/g,
    feature: /\b(?!AC\d+\b)[A-Z]{1,4}\d+\b/g,
    scenario: /\bS-\d+[a-z]?\b/g,
  };
  // If schema overrides idPattern for a core type, use the project pattern
  if (schema) {
    const defaultPattern = DEFAULT_SCHEMA.idPatterns[type];
    const schemaOverride = schema.idPatterns[type];
    if (schemaOverride && schemaOverride !== defaultPattern) {
      return [...text.matchAll(new RegExp(schemaOverride, 'g'))].map((match) => match[0]);
    }
  }
  return [...text.matchAll(corePatterns[type] ?? /$a/g)].map((match) => match[0]);
}

function extractE2eTcFields(block: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  let current = '';
  for (const line of block) {
    const match = /^\*\*([^*]+?)\*\*\s*[:：]\s*(.*)$/.exec(line);
    if (match) {
      current = match[1].trim();
      fields[current] = match[2].trim();
      continue;
    }
    if (/^---\s*$/.test(line) || /^#{2,3}\s+/.test(line)) {
      current = '';
      continue;
    }
    if (current) {
      fields[current] = [fields[current], line.trim()].filter(Boolean).join('\n');
    }
  }
  return fields;
}

function parseAcceptanceCriteria(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+验收标准\s*$/.test(line.trim()));
  if (start < 0) {
    return [];
  }
  const result = new Set<string>();
  let numbered = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) {
      break;
    }
    if (/^\s*\d+[.)、]\s+/.test(line)) {
      numbered += 1;
      result.add(`AC${numbered}`);
    }
    for (const match of line.matchAll(/\bAC[-\s]?(\d+)\b/g)) {
      result.add(`AC${Number(match[1])}`);
    }
  }
  return [...result].sort((left, right) => Number(left.slice(2)) - Number(right.slice(2)));
}

function extractFeatureAcRefs(text: string): Array<{ feature: string; ac: string }> {
  const refs: Array<{ feature: string; ac: string }> = [];
  for (const match of text.matchAll(/\b((?!AC\d+\b)[A-Z]{1,4}\d+)\s*[（(]([^）)]+)[）)]/g)) {
    for (const acMatch of match[2].matchAll(/\bAC[-\s]?(\d+)\b/g)) {
      refs.push({ feature: match[1], ac: `AC${Number(acMatch[1])}` });
    }
  }
  return refs;
}

function flattenAcCoverage(value: Record<string, unknown>): Array<{ feature: string; ac: string }> {
  return Object.entries(value).flatMap(([feature, refs]) => (
    toArray(refs).map((ac) => ({ feature, ac: String(ac).replace(/^AC[-\s]?(\d+)$/i, (_match, digits) => `AC${Number(digits)}`) }))
  ));
}

function needsDesktopChainWarning(node: ArtifactNode): boolean {
  const tcFields = asRecord(node.attrs?.tcFields);
  const chainType = String(tcFields['chain_type'] ?? '').trim().toLowerCase();
  if ((chainType && VALID_CHAIN_TYPES.has(chainType) && chainType !== 'desktop_chain')
    || chainType in DEPRECATED_CHAIN_TYPE_ALIASES) {
    return false;
  }

  // TC declares chain_coverage: complete — delegate to validateExecutableTraceability()
  // which checks §5.3 composite complete rules via E2E-TRACE-006.
  const chainCoverage = String(tcFields['chain_coverage'] ?? '').trim().toLowerCase();
  if (parseChainCoverageStatus(chainCoverage) === 'complete') {
    return false;
  }

  const text = `${node.title}\n${String(node.attrs?.blockText ?? '')}`;
  if (!/(desktop|桌面|Tauri|IPC|React UI)/i.test(text)) {
    return false;
  }
  const checks = [
    /(React|UI|界面|页面)/i,
    /(Tauri|IPC)/i,
    /(Node sidecar|sidecar|JSON Lines)/i,
    /(core|engine|核心|引擎)/i,
    /(SQLite|report data|报告)/i,
  ];
  return checks.some((check) => !check.test(text)) || (/\bCLI\b|heimdall scan|纯函数/i.test(text) && checks.some((check) => !check.test(text)));
}

function compareRegistryNumber(issues: ValidationIssue[], registry: ArtifactNode, field: string, actual: number): void {
  const expected = registry.attrs?.[field];
  if (typeof expected !== 'number') {
    issues.push(issue('E2E_REGISTRY_MISMATCH', `registry ${field} cannot be determined`, registry.path, registry.line, { node: registry.uid, severity: 'warning' }));
    return;
  }
  if (expected !== actual) {
    issues.push(issue('E2E_REGISTRY_MISMATCH', `registry ${field}=${expected} does not match actual ${actual}`, registry.path, registry.line, { node: registry.uid, severity: 'warning' }));
  }
}

function compareRegistryValue(issues: ValidationIssue[], registry: ArtifactNode, batch: Record<string, unknown>, field: string, actual: unknown): void {
  if (!(field in batch)) {
    issues.push(issue('E2E_REGISTRY_MISMATCH', `registry batch ${String(batch.batch_id ?? '')} ${field} cannot be determined`, registry.path, registry.line, { node: registry.uid, severity: 'warning' }));
    return;
  }
  if (String(batch[field]) !== String(actual)) {
    issues.push(issue('E2E_REGISTRY_MISMATCH', `registry batch ${String(batch.batch_id ?? '')} ${field}=${String(batch[field])} does not match actual ${String(actual)}`, registry.path, registry.line, { node: registry.uid, severity: 'warning' }));
  }
}

function compareRegistryArray(issues: ValidationIssue[], registry: ArtifactNode, batch: Record<string, unknown>, field: string, actual: string[]): void {
  if (!(field in batch)) {
    issues.push(issue('E2E_REGISTRY_MISMATCH', `registry batch ${String(batch.batch_id ?? '')} ${field} cannot be determined`, registry.path, registry.line, { node: registry.uid, severity: 'warning' }));
    return;
  }
  const expected = toArray(batch[field]).map((value) => String(value));
  if (expected.slice().sort().join(',') !== actual.slice().sort().join(',')) {
    issues.push(issue('E2E_REGISTRY_MISMATCH', `registry batch ${String(batch.batch_id ?? '')} ${field} does not match actual file`, registry.path, registry.line, { node: registry.uid, severity: 'warning' }));
  }
}

function compareRegistryAcCoverage(issues: ValidationIssue[], registry: ArtifactNode, batch: Record<string, unknown>, actual: Record<string, unknown>): void {
  if (!('ac_coverage' in batch)) {
    issues.push(issue('E2E_REGISTRY_MISMATCH', `registry batch ${String(batch.batch_id ?? '')} ac_coverage cannot be determined`, registry.path, registry.line, { node: registry.uid, severity: 'warning' }));
    return;
  }
  if (normalizeAcCoverage(asRecord(batch.ac_coverage)) !== normalizeAcCoverage(actual)) {
    issues.push(issue('E2E_REGISTRY_MISMATCH', `registry batch ${String(batch.batch_id ?? '')} ac_coverage does not match actual file`, registry.path, registry.line, { node: registry.uid, severity: 'warning' }));
  }
}

function normalizeAcCoverage(value: Record<string, unknown>): string {
  return flattenAcCoverage(value)
    .map((reference) => `${reference.feature}:${reference.ac}`)
    .sort()
    .join(',');
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    result.set(groupKey, [...(result.get(groupKey) ?? []), value]);
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim() === '';
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length === 0;
  }
  return false;
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (char === '*' && next === '*' && afterNext === '/') {
      source += '(?:.*/)?';
      index += 2;
    } else if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += char.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function normalizeUid(value: string): string {
  if (value.includes(':')) {
    return value;
  }
  if (/^S-\d+[a-z]?$/.test(value)) {
    return toUid('scenario', value);
  }
  if (/^D-[A-Z]+-\d+$/.test(value)) {
    return toUid('decision', value);
  }
  if (/^E-\d{3,}$/.test(value)) {
    return toUid('entity', value);
  }
  if (/^[A-Z]{1,4}\d+$/.test(value)) {
    return toUid('feature', value);
  }
  return value;
}

function normalizeDesignCode(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  return basename(raw, extname(raw));
}

function toUid(type: string, code: string): string {
  return `${type}:${code}`;
}

function edge(from: string, to: string, kind: string, source: string, sourcePath: string, sourceLine: number): ArtifactEdge {
  return { from, to, kind, source, sourcePath, sourceLine };
}

function issue(
  code: string,
  message: string,
  path: string,
  line: number,
  extra: Pick<ValidationIssue, 'node' | 'edge'> & Partial<Pick<ValidationIssue, 'severity'>> = {},
): ValidationIssue {
  return { code, severity: 'error', message, path, line, ...extra };
}

function compareNode(left: ArtifactNode, right: ArtifactNode): number {
  return left.uid.localeCompare(right.uid) || left.path.localeCompare(right.path) || left.line - right.line;
}

function compareEdge(left: ArtifactEdge, right: ArtifactEdge): number {
  return left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind);
}

function mergeRecord<T>(base: Record<string, T>, override?: Record<string, T>): Record<string, T> {
  return { ...base, ...(override ?? {}) };
}

function mergeArtifactTypes(
  base: Record<string, ArtifactTypeSchema>,
  override?: Record<string, ArtifactTypeSchema>,
): Record<string, ArtifactTypeSchema> {
  const result: Record<string, ArtifactTypeSchema> = { ...base };
  for (const [type, definition] of Object.entries(override ?? {})) {
    const aliases = [
      ...(base[type]?.aliases ?? []),
      ...(definition.aliases ?? []),
    ].filter((alias, index, all) => all.indexOf(alias) === index);
    result[type] = {
      ...(base[type] ?? {}),
      ...definition,
      ...(aliases.length > 0 ? { aliases } : {}),
    };
  }
  return result;
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function headingTitle(raw: string, code: string): string | undefined {
  return raw.match(new RegExp(`^#\\s+${code}:\\s+(.+)$`, 'm'))?.[1];
}

function titleNearCode(line: string, code: string): string {
  const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
  const index = cells.indexOf(code);
  if (index >= 0 && cells[index + 1]) {
    return cells[index + 1];
  }
  return line.split(code).at(1)?.replace(/^[:\s|-]+/, '').trim() || code;
}

function escapeMermaid(value: string): string {
  return value.replace(/"/g, '\\"');
}

// --- Target Discovery ---

export interface DiscoverOptions {
  limit?: number;
  schema?: ArtifactSchema;
}

/**
 * Discover audit targets from an artifact graph.
 * Collects configured target-capable artifact nodes, sorted by id within each type.
 * When the total exceeds `limit`, uses round-robin across configured target types
 * to keep the sample balanced.
 */
export function discoverTargets(graph: ArtifactGraph, options?: DiscoverOptions): Array<{ type: string; id: string }> {
  // limit=undefined → default 20; limit=0 → no limit (return all)
  const limit = options?.limit === undefined ? 20 : options.limit === 0 ? Infinity : options.limit;
  const targetTypes = getTargetArtifactTypes(options?.schema ?? DEFAULT_SCHEMA);

  // Group by type, sorted by id alphabetically within each group
  const groups = new Map<string, Array<{ type: string; id: string }>>();
  for (const t of targetTypes) {
    groups.set(t, []);
  }
  for (const node of graph.nodes) {
    if ((targetTypes as readonly string[]).includes(node.type)) {
      groups.get(node.type)!.push({ type: node.type, id: node.code });
    }
  }
  for (const [, group] of groups) {
    group.sort((a, b) => a.id.localeCompare(b.id));
  }

  // Total discovered items
  const allItems = targetTypes.flatMap((type) => groups.get(type) ?? []);
  if (allItems.length <= limit) {
    return allItems;
  }

  // Round-robin across configured packet target types.
  const result: Array<{ type: string; id: string }> = [];
  const indices = new Map<string, number>();
  for (const t of targetTypes) {
    indices.set(t, 0);
  }

  while (result.length < limit) {
    let added = false;
    for (const t of targetTypes) {
      const group = groups.get(t) ?? [];
      const idx = indices.get(t) ?? 0;
      if (idx < group.length && result.length < limit) {
        result.push(group[idx]);
        indices.set(t, idx + 1);
        added = true;
      }
    }
    if (!added) break;
  }

  return result;
}

// --- Context Resolver ---

const CONTEXT_CATEGORIES: Record<string, string> = {
  feature: 'prd',
  scenario: 'scenario',
  decision: 'decision',
  design: 'design',
  entity: 'entity',
  'interface_contracts': 'contract',
  'data_contracts': 'contract',
  'application_state_machines': 'contract',
  'error_model': 'contract',
  'report-contracts': 'contract',
  'ui-flow-contracts': 'contract',
  'non-functional-budgets': 'contract',
  'domain-glossary': 'domain',
  'bounded-context-map': 'domain',
  'domain-invariants': 'domain',
  'generation-packet-spec': 'domain',
  'rule-golden-cases': 'verification',
  'test-strategy': 'verification',
  'verification-fixtures': 'verification',
  'implementation-blueprint': 'blueprint',
  'traceability-matrix-v2': 'matrix',
};

export { ALWAYS_PRESENT_ITEMS as ALWAYS_PRESENT, BASELINE_ITEMS_COUNT, BASELINE_CONSTRAINTS, BASELINE_CONSTRAINTS_COUNT } from './packet-constants.js';

// Re-export target selector
export { parseTargetSelector, resolveCliTarget } from './target-selector.js';

const TIER_ORDER: ContextTier[] = ['baseline', 'target', 'direct', 'matrix', 'transitive'];

export function resolveArtifactContext(graph: ArtifactGraph, opts: ContextOptions): ContextManifest {
  const mode: ContextMode = opts.mode ?? 'full';
  const maxPerCategory = opts.maxPerCategory ?? 20;
  const universalBaseline = opts.universalBaseline ?? true;
  const root = opts.root ?? graph.root;

  // Determine target — unified `target` field OR exactly one legacy field
  const legacyCount = [opts.feature, opts.scenario, opts.decision, opts.design, opts.e2e_test].filter(Boolean).length;
  if (opts.target && legacyCount > 0) {
    return {
      schemaVersion: '1.0',
      target: { type: '', id: '', uid: '' },
      context: {},
      missing: ['互斥：target 与 --feature/--scenario/--decision/--design/--e2e-test 不能同时使用'],
      missingDetails: [{
        ref: [opts.target.type + ':' + opts.target.id, opts.feature, opts.scenario, opts.decision, opts.design, opts.e2e_test].filter(Boolean).join(', '),
        from: 'cli-options',
        kind: 'multiple-targets',
        message: '互斥：target 与 --feature/--scenario/--decision/--design/--e2e-test 不能同时使用',
        suggestedAction: '只指定一种 target 形式',
      }],
      omitted: [],
    };
  }
  if (legacyCount > 1) {
    return {
      schemaVersion: '1.0',
      target: { type: '', id: '', uid: '' },
      context: {},
      missing: ['Only one of --feature, --scenario, --decision, --design, or --e2e-test may be specified'],
      missingDetails: [{
        ref: [opts.feature, opts.scenario, opts.decision, opts.design, opts.e2e_test].filter(Boolean).join(', '),
        from: 'cli-options',
        kind: 'multiple-targets',
        message: 'Only one of --feature, --scenario, --decision, --design, or --e2e-test may be specified',
        suggestedAction: '只指定一个 --feature/--scenario/--decision/--design/--e2e-test',
      }],
      omitted: [],
    };
  }

  let targetType: string | undefined;
  let targetId: string | undefined;
  if (opts.target) { targetType = opts.target.type; targetId = opts.target.id; }
  else if (opts.feature) { targetType = 'feature'; targetId = opts.feature; }
  else if (opts.scenario) { targetType = 'scenario'; targetId = opts.scenario; }
  else if (opts.decision) { targetType = 'decision'; targetId = opts.decision; }
  else if (opts.design) { targetType = 'design'; targetId = opts.design; }
  else if (opts.e2e_test) { targetType = 'e2e_test'; targetId = opts.e2e_test; }

  if (!targetType || !targetId) {
    return {
      schemaVersion: '1.0',
      target: { type: '', id: '', uid: '' },
      context: {},
      missing: ['No target specified (use --feature, --scenario, --decision, --design, or --e2e-test)'],
      missingDetails: [{
        ref: '',
        from: 'cli-options',
        kind: 'target-not-found',
        message: 'No target specified (use --feature, --scenario, --decision, --design, or --e2e-test)',
        suggestedAction: '创建文件或检查 ID 拼写',
      }],
      omitted: [],
    };
  }

  const targetUid = toUid(targetType, targetId);
  const targetNode = graph.nodes.find((n) => n.uid === targetUid);
  if (!targetNode) {
    return {
      schemaVersion: '1.0',
      target: { type: targetType, id: targetId, uid: targetUid },
      context: {},
      missing: [`Target artifact ${targetUid} not found in graph`],
      missingDetails: [{
        ref: targetId,
        from: targetType,
        kind: 'target-not-found',
        message: `Target artifact ${targetUid} not found in graph`,
        suggestedAction: '创建文件或检查 ID 拼写',
      }],
      omitted: [],
    };
  }

  // Collect related nodes via edge traversal
  const related = new Map<string, { node: ArtifactNode; reason: string }>();
  const missing: string[] = [];
  const missingDetails: MissingDetail[] = [];

  // Outgoing edges: target → related
  for (const e of graph.edges) {
    if (e.from === targetUid) {
      const nodes = graph.nodes.filter((n) => n.uid === e.to);
      for (const n of nodes) {
        if (!related.has(n.uid)) {
          related.set(n.uid, { node: n, reason: `${e.kind} → ${n.uid}` });
        }
      }
      // Track unresolved outgoing refs
      if (!graph.nodes.some((n) => n.uid === e.to) && !related.has(e.to)) {
        const msg = `Unresolved reference from ${e.from}: ${e.to}`;
        if (!missing.includes(msg)) {
          missing.push(msg);
          missingDetails.push({
            ref: e.to,
            from: e.from,
            kind: 'unresolved-outgoing',
            message: msg,
            suggestedAction: '添加引用或删除悬挂引用',
          });
        }
      }
    }
    // Incoming edges: related → target
    if (e.to === targetUid) {
      const nodes = graph.nodes.filter((n) => n.uid === e.from);
      for (const n of nodes) {
        if (!related.has(n.uid)) {
          related.set(n.uid, { node: n, reason: `${e.kind} ← ${n.uid}` });
        }
      }
    }
  }

  // Direct edges — tier: direct
  const directUids = new Set(related.keys());

  // Find traceability-matrix-v2 rows that reference the target by bare ID
  for (const n of graph.nodes) {
    if (n.type !== 'traceability-matrix-v2') continue;
    const attrs = n.attrs as Record<string, string> | undefined;
    if (attrs?.id === targetId && !related.has(n.uid)) {
      related.set(n.uid, { node: n, reason: `matrix row for ${targetId}` });
    }
  }

  // For matrix nodes that represent real artifacts, also add the real artifact node
  const transitiveUids = new Set<string>();
  for (const [, { node }] of [...related]) {
    if (node.type !== 'traceability-matrix-v2') continue;
    const attrs = node.attrs as Record<string, string> | undefined;
    if (!attrs?.layer || !attrs?.id) continue;
    const realUid = toUid(attrs.layer, attrs.id);
    if (realUid !== targetUid && !related.has(realUid)) {
      const realNode = graph.nodes.find((n) => n.uid === realUid);
      if (realNode) {
        related.set(realUid, { node: realNode, reason: `represented by ${node.uid}` });
        transitiveUids.add(realUid);
      }
    }
  }

  // Determine tier for each related uid
  function tierFor(uid: string): ContextTier {
    if (directUids.has(uid)) return 'direct';
    // Matrix rows are those whose node type is traceability-matrix-v2
    const node = graph.nodes.find((n) => n.uid === uid);
    if (node?.type === 'traceability-matrix-v2') return 'matrix';
    if (transitiveUids.has(uid)) return 'transitive';
    return 'direct'; // fallback
  }

  // Deduplicate by path: merge reasons for same file path
  const pathMap = new Map<string, { path: string; reasons: string[]; category: string; required: boolean; tier: ContextTier }>();

  // Always-present baseline files (required) — skipped when universalBaseline === false
  // @feature ACA17
  // @decision D-ACA-17
  if (universalBaseline) {
    for (const ap of ALWAYS_PRESENT) {
      const existing = pathMap.get(ap.path);
      if (existing) {
        if (!existing.reasons.includes(ap.reason)) existing.reasons.push(ap.reason);
      } else {
        pathMap.set(ap.path, { path: ap.path, reasons: [ap.reason], category: 'baseline', required: true, tier: 'baseline' });
      }
    }

    // Fail-closed: report required baseline files that are not present on disk
    if (root) {
      for (const ap of ALWAYS_PRESENT) {
        const fullPath = join(root, ap.path);
        let stat;
        try { stat = statSync(fullPath); } catch { stat = null; }
        if (!stat) {
          const msg = `Required baseline artifact not found: ${ap.path}`;
          if (!missing.includes(msg)) {
            missing.push(msg);
            missingDetails.push({
              ref: ap.path,
              from: 'baseline',
              kind: 'missing-baseline',
              message: msg,
              suggestedAction: `创建文件 ${ap.path} 或配置跳过 universal baseline`,
            });
          }
        } else if (!stat.isFile()) {
          const msg = `Required baseline artifact is not a regular file: ${ap.path}`;
          if (!missing.includes(msg)) {
            missing.push(msg);
            missingDetails.push({
              ref: ap.path,
              from: 'baseline',
              kind: 'missing-baseline',
              message: msg,
              suggestedAction: `将 ${ap.path} 从目录改为文件，或配置跳过 universal baseline`,
            });
          }
        } else {
          // Check readability: stat.isFile() passes but file may not be readable
          try {
            accessSync(fullPath, fsConstants.R_OK);
          } catch {
            const msg = `Required baseline artifact is not readable: ${ap.path}`;
            if (!missing.includes(msg)) {
              missing.push(msg);
              missingDetails.push({
                ref: ap.path,
                from: 'baseline',
                kind: 'missing-baseline',
                message: msg,
                suggestedAction: `修复 ${ap.path} 的文件权限，或配置跳过 universal baseline`,
              });
            }
          }
        }
      }
    } else {
      // Fail-closed: baseline enabled but no root to verify file existence
      for (const ap of ALWAYS_PRESENT) {
        const msg = `Cannot verify baseline without root: ${ap.path}`;
        if (!missing.includes(msg)) {
          missing.push(msg);
          missingDetails.push({
            ref: ap.path,
            from: 'baseline',
            kind: 'missing-baseline',
            message: msg,
            suggestedAction: `传递 root 参数或配置跳过 universal baseline`,
          });
        }
      }
    }
  }

  // Target itself (required)
  pathMap.set(targetNode.path, {
    path: targetNode.path,
    reasons: [`${targetType}:${targetId}`],
    category: 'target',
    required: true,
    tier: 'target',
  });

  // Related nodes (graph-traced, not required)
  // Baseline files stay in baseline category; graph-traced reasons are merged in.
  // Non-baseline paths use the graph-traced category.
  for (const [uid, { node, reason }] of related) {
    const category = CONTEXT_CATEGORIES[node.type] ?? node.type;
    const tier = tierFor(uid);
    const existing = pathMap.get(node.path);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      // Baseline files stay in baseline; only upgrade non-baseline to graph-traced
      if (existing.category !== 'baseline') {
        existing.category = category;
        // Upgrade tier only if the new tier is higher priority
        const existingTierIdx = TIER_ORDER.indexOf(existing.tier);
        const newTierIdx = TIER_ORDER.indexOf(tier);
        if (newTierIdx < existingTierIdx) existing.tier = tier;
      }
    } else {
      pathMap.set(node.path, { path: node.path, reasons: [reason], category, required: false, tier });
    }
  }

  // Implementation mode: apply per-category limit, move overflow to omitted
  const omitted: ContextItem[] = [];
  if (mode === 'implementation') {
    // Group entries by category for counting
    const categoryCounts = new Map<string, number>();
    // Count baseline and target entries first (they are always kept)
    for (const [, entry] of pathMap) {
      if (entry.category === 'baseline' || entry.category === 'target') {
        categoryCounts.set(entry.category, (categoryCounts.get(entry.category) ?? 0) + 1);
      }
    }
    // For non-baseline categories, apply maxPerCategory limit respecting tier priority
    const categoryBuckets = new Map<string, { entry: { path: string; reasons: string[]; category: string; required: boolean; tier: ContextTier }; uid: string }[]>();
    for (const [path, entry] of pathMap) {
      if (entry.category === 'baseline' || entry.category === 'target') continue;
      const cat = entry.category;
      if (!categoryBuckets.has(cat)) categoryBuckets.set(cat, []);
      categoryBuckets.get(cat)!.push({ entry, uid: path });
    }

    for (const [cat, bucket] of categoryBuckets) {
      // Sort by tier priority (direct before matrix before transitive), then by path
      bucket.sort((a, b) => {
        const tierDiff = TIER_ORDER.indexOf(a.entry.tier) - TIER_ORDER.indexOf(b.entry.tier);
        if (tierDiff !== 0) return tierDiff;
        return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0;
      });

      const limit = maxPerCategory;
      if (bucket.length > limit) {
        // Keep first `limit`, move rest to omitted
        for (let i = limit; i < bucket.length; i++) {
          const entry = bucket[i].entry;
          pathMap.delete(bucket[i].uid);
          omitted.push({
            path: entry.path,
            reason: entry.reasons.join('; '),
            required: false,
            tier: entry.tier,
            reasons: [...entry.reasons],
          });
        }
        categoryCounts.set(cat, limit);
      }
    }
  }

  // Sort omitted by tier priority then path for stable output
  omitted.sort((a, b) => {
    const tierDiff = TIER_ORDER.indexOf(a.tier!) - TIER_ORDER.indexOf(b.tier!);
    if (tierDiff !== 0) return tierDiff;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  // Build context from deduplicated path map
  const context: Record<string, ContextItem[]> = {};
  for (const [, entry] of pathMap) {
    const category = entry.category;
    if (!context[category]) context[category] = [];
    context[category].push({
      path: entry.path,
      reason: entry.reasons.join('; '),
      required: entry.required,
      tier: entry.tier,
      reasons: [...entry.reasons],
    });
  }

  // Sort all categories for stable output (case-sensitive path sort for deterministic ordering)
  for (const key of Object.keys(context)) {
    context[key].sort((a, b) => {
      const tierDiff = TIER_ORDER.indexOf(a.tier!) - TIER_ORDER.indexOf(b.tier!);
      if (tierDiff !== 0) return tierDiff;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
    });
  }

  return {
    schemaVersion: '1.0',
    target: {
      type: targetType,
      id: targetId,
      uid: targetUid,
      title: targetNode.title,
      sourcePath: targetNode.path,
      status: targetNode.status,
    },
    context,
    missing,
    missingDetails,
    omitted,
    baselinePolicy: universalBaseline,
  };
}

export function formatContextMarkdown(manifest: ContextManifest): string {
  const lines: string[] = [];
  lines.push(`# Implementation Context: ${manifest.target.type}:${manifest.target.id}`);
  lines.push('');

  // Determine if manifest uses tier-based grouping (v2 schema)
  const hasTiers = manifest.schemaVersion === '1.0';

  if (hasTiers) {
    // Group by tier
    const tierLabels: Record<string, string> = {
      baseline: 'Baseline 必读',
      direct: 'Direct context',
      matrix: 'Matrix context',
      transitive: 'Transitive / tests',
      target: 'Target',
    };

    // Collect all items across categories, group by tier
    const tierGroups = new Map<string, ContextItem[]>();
    for (const items of Object.values(manifest.context)) {
      for (const item of items) {
        const tier = item.tier ?? (item.required ? 'baseline' : 'direct');
        if (!tierGroups.has(tier)) tierGroups.set(tier, []);
        tierGroups.get(tier)!.push(item);
      }
    }

    // Emit tiers in order: baseline, target, direct, matrix, transitive
    const emitOrder = ['baseline', 'target', 'direct', 'matrix', 'transitive'];
    for (const tier of emitOrder) {
      const items = tierGroups.get(tier);
      if (!items || items.length === 0) continue;
      lines.push(`## ${tierLabels[tier] ?? tier}`);
      // Deduplicate by path (target may overlap with baseline)
      const seen = new Set<string>();
      for (const item of items) {
        const key = `${tier}:${item.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const req = item.required ? '[必读] ' : '';
        lines.push(`- \`${item.path}\` — ${req}${item.reason}`);
      }
      lines.push('');
    }
  } else {
    // Legacy format: group by category
    for (const [category, items] of Object.entries(manifest.context)) {
      lines.push(`## ${category}`);
      for (const item of items) {
        const req = item.required ? '[必读] ' : '';
        lines.push(`- \`${item.path}\` — ${req}${item.reason}`);
      }
      lines.push('');
    }
  }

  if (manifest.omitted && manifest.omitted.length > 0) {
    lines.push('## Omitted');
    for (const item of manifest.omitted) {
      const tierLabel = item.tier ? ` (${item.tier})` : '';
      lines.push(`- \`${item.path}\` — ${item.reason}${tierLabel}`);
    }
    lines.push('');
  }

  if (manifest.missing.length > 0) {
    lines.push('## Missing');
    for (const m of manifest.missing) {
      lines.push(`- ${m}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export { dirname, extname };

// Re-export packet assembler
export {
  assemblePacket,
  renderPacketMarkdown,
} from './packet-assembler.js';
export type {
  ImplementationPacket,
  ImplementationBlueprintDraft,
  PacketTarget,
  PacketCategory,
  PacketItem,
  PacketOmittedItem,
  PacketOptions,
  ReviewOrderStep,
  RiskChecklistItem,
} from './packet-assembler.js';

// Re-export packet audit
export {
  auditPackets,
  discoverAndAuditPackets,
  parseTargetsFile,
} from './packet-audit.js';
export type {
  PacketAuditEntry,
  PacketAuditSummary,
} from './packet-audit.js';

// Re-export packet validator
export {
  VALID_PACKET_TARGET_TYPES,
  isPacketTargetType,
  isPacketTargetTypeDynamic,
  validatePacket,
  validatePacketMarkdown,
} from './packet-validator.js';
export type {
  PacketTargetType,
  PacketValidationIssue,
  PacketValidationResult,
} from './packet-validator.js';

// Re-export packet prompt
export {
  renderPacketPrompt,
  DEFAULT_MAX_CHARS,
  MIN_PROMPT_CHARS,
} from './packet-prompt.js';
export type {
  PacketPromptOptions,
  PacketPromptError,
} from './packet-prompt.js';

// Re-export packet prompt validator
export { validatePacketPrompt } from './packet-prompt-validator.js';
export type {
  PromptValidationIssue,
  PromptValidationResult,
} from './packet-prompt-validator.js';

// Re-export versioned traceability
export {
  VERSION_INDEX_SCHEMA_VERSION,
  VERSION_LOCK_PATH,
  VERSION_LOCK_SCHEMA_VERSION,
  auditVersionLock,
  bootstrapVersionLock,
  buildVersionIndex,
  refreshVersionLock,
  renderTraceVersionMarkdown,
  renderVersionLockAuditMarkdown,
  renderVersionLockRefreshMarkdown,
  traceVersion,
  updateVersionLock,
} from './versioned-traceability.js';
export type {
  VersionEdgeKind,
  VersionIndex,
  VersionLockAuditResult,
  VersionLockEntry,
  VersionLockFile,
  VersionLockIssue,
  VersionLockRef,
  VersionLockSourceRef,
  VersionLockStatus,
  VersionLockUpdateOptions,
  VersionLockBootstrapOptions,
  VersionLockRefreshOptions,
  VersionLockRefreshResult,
  VersionSourceKind,
  VersionedEdge,
  VersionedNode,
  TraceVersionResult,
} from './versioned-traceability.js';

// Re-export artifact chain toolkit helpers
export {
  doctorArtifactChain,
  renderDoctorMarkdown,
  resolveArtifactGraphCli,
} from './cli-resolver.js';
export type {
  ArtifactChainDoctorReport,
  ArtifactGraphCliCandidate,
  ArtifactGraphCliResolution,
  ArtifactGraphCliSource,
  ResolveArtifactGraphCliOptions,
} from './cli-resolver.js';
export {
  collectChangedPaths,
} from './git-changes.js';
export type {
  CollectChangedPathsOptions,
  GitChangeMode,
  GitChangeResult,
} from './git-changes.js';
export { resolveGitHookPath } from './git-hook-path.js';
export type { GitHookName } from './git-hook-path.js';
export {
  applyPreparedManagedHookBlocks,
  installManagedHookBlock,
  prepareManagedHookBlock,
} from './hook-installer.js';
export type {
  HookInstallResult,
  ManagedHookBlockOptions,
  PreparedManagedHookBlock,
} from './hook-installer.js';

// Review Result Protocol
export { validateReviewResult } from './review-result-validator.js';
export type { ValidationError } from './review-result-validator.js';
export type {
  ReviewResult,
  ReviewStatus,
  ReviewDecision,
  Finding,
  FindingSeverity,
  FindingStatus,
  FindingLocation,
  Evidence,
  EvidenceObject,
  Producer,
  ExecutorType,
  BatchDefinition,
  ReviewMetrics,
  ReviewData,
  RepairData,
  RepairValidation,
} from './review-result-types.js';

// Re-export contract kernel public API
export {
  type ContractIdentity,
  type ContractDefinition,
  type ContractSchema,
  type ContractRegistryEntry,
  type CanonicalIR,
  type NormalizationResult,
  type LegacyFieldMapping,
  type NormalizerConfig,
  type ProjectPolicy,
  type PolicyCompatibilityResult,
  type LoadContractOptions,
  type ContractCatalogEntry,
  type SchemaValidationResult,
  ContractError,
  CONTRACT_ERROR_CODES,
  type ContractErrorCode,
  isOfficialNamespace,
  validateNamespaceAuthority,
  computeRevisionDigest,
  verifyDigest,
  ContractRegistry,
  normalizeToCanonical,
  normalizeE2eLegacyArtifact,
  E2E_NORMALIZER_CONFIG,
  validatePolicyCompatibility,
  loadContract,
  loadContractsFromDirectory,
  validateContractAgainstSchema,
  ContractCatalog,
  loadContractCatalog,
} from './contract-kernel.js';
