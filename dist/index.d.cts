export { dirname, extname } from 'node:path';

/**
 * packet-constants.ts
 *
 * Shared constants for packet assembly, validation, and auditing.
 * Extracted here to avoid circular imports between index.ts and packet-validator.ts.
 */
/** Always-present baseline items included in every implementation packet */
declare const ALWAYS_PRESENT_ITEMS: {
    path: string;
    reason: string;
}[];
/** Baseline items count derived from ALWAYS_PRESENT_ITEMS */
declare const BASELINE_ITEMS_COUNT: number;
/** Baseline constraints — well-known constraints derived from baseline artifacts */
declare const BASELINE_CONSTRAINTS: {
    id: string;
    description: string;
    source: string;
}[];
/** Baseline constraints count derived from BASELINE_CONSTRAINTS */
declare const BASELINE_CONSTRAINTS_COUNT: number;

/**
 * packet-assembler.ts
 *
 * Deterministic implementation packet assembly from context manifest.
 * No LLM involvement — pure data transformation.
 */

/** Target information for the packet */
interface PacketTarget {
    type: string;
    id: string;
    uid: string;
    title?: string;
    sourcePath?: string;
    status?: string;
}
/** Single item in a packet category */
interface PacketItem {
    path: string;
    reason: string;
    required: boolean;
    tier?: string;
    reasons?: string[];
}
/** Category section in the packet */
interface PacketCategory {
    category: string;
    total: number;
    items: PacketItem[];
}
/** Omitted item in the packet */
interface PacketOmittedItem {
    path: string;
    reason: string;
    tier?: string;
}
/** Single step in recommended review order */
interface ReviewOrderStep {
    step: number;
    category: string;
    reason: string;
}
/** Single item in risk checklist */
interface RiskChecklistItem {
    id: string;
    description: string;
    checked: boolean;
}
/** Blueprint draft: manifest-derived skeleton for implementation */
interface ImplementationBlueprintDraft {
    objective: {
        featureId: string | null;
        scenarioId: string | null;
        decisionId: string | null;
        designId: string | null;
        e2eTestId: string | null;
        description: string;
        scope: string;
        nonGoals: string[];
    };
    contextChecklist: {
        categories: {
            name: string;
            count: number;
            paths: string[];
        }[];
    };
    fileChanges: {
        path: string;
        action: string;
        description: string;
        source: string;
    }[];
    constraints: {
        id: string;
        description: string;
        source: string;
    }[];
    validationCommands: string[];
    recommendedReviewOrder: ReviewOrderStep[];
    riskChecklist: RiskChecklistItem[];
}
/** AssemblePacket options */
interface PacketOptions {
    /** Override default validation commands */
    validationCommands?: string[];
    /** Context mode used during resolution */
    mode?: ContextMode;
    /** Max per category used during resolution */
    maxPerCategory?: number;
    /** Fixed ISO 8601 timestamp for reproducible output. If omitted, uses current time. */
    generatedAt?: string;
}
/** Top-level implementation packet */
interface ImplementationPacket {
    schemaVersion: '1.0';
    generatedAt: string;
    target: PacketTarget;
    contextManifestSummary: {
        totalCategories: number;
        totalItems: number;
        totalOmitted: number;
        totalMissing: number;
        mode: string;
        maxPerCategory: number;
    };
    requiredBaseline: PacketCategory;
    contextByTier: {
        direct: PacketCategory[];
        matrix: PacketCategory[];
        transitive: PacketCategory[];
    };
    omittedItems: PacketOmittedItem[];
    missing: string[];
    missingDetails?: MissingDetail[];
    implementationBlueprintDraft: ImplementationBlueprintDraft;
    validationCommands: string[];
}
/**
 * Assemble an implementation packet from a context manifest.
 *
 * This is a pure data transformation. Packet content is derived from the
 * manifest; generatedAt is variable unless a fixed value is supplied.
 * No LLM is involved.
 */
declare function assemblePacket(manifest: ContextManifest, options?: PacketOptions): ImplementationPacket;
/**
 * Render an implementation packet as Markdown.
 *
 * Output is designed to be directly usable as a pre-implementation brief
 * for Claude Code or other AI coding agents.
 */
declare function renderPacketMarkdown(packet: ImplementationPacket): string;

/**
 * packet-validator.ts
 *
 * Schema validation for implementation packets.
 * Validates both structured JSON packets and rendered Markdown packets.
 */

/** Valid target types for packets */
declare const VALID_PACKET_TARGET_TYPES: readonly ["feature", "scenario", "decision", "design", "e2e_test"];
type PacketTargetType = typeof VALID_PACKET_TARGET_TYPES[number];
declare function isPacketTargetType(type: string): type is PacketTargetType;
interface PacketValidationIssue {
    severity: 'error' | 'warning';
    code: string;
    message: string;
    path?: string;
}
interface PacketValidationResult {
    ok: boolean;
    issues: PacketValidationIssue[];
}
/**
 * Validate a structured ImplementationPacket against schema rules.
 *
 * Rules:
 * - PKT-001: schemaVersion must be '1.0'
 * - PKT-002: target.type must be a valid packet target type
 * - PKT-003: target.id must be non-empty
 * - PKT-004: requiredBaseline.total must equal baseline items count
 * - PKT-005: constraints must have exactly baseline count and include C-RULE-01
 * - PKT-006: validationCommands must have at least 4 entries
 * - PKT-007: missing.length > 0 is a warning
 */
declare function validatePacket(packet: ImplementationPacket): PacketValidationResult;
/**
 * Validate a rendered Markdown packet for required section structure.
 *
 * Checks that all required section headings are present.
 */
declare function validatePacketMarkdown(markdown: string): PacketValidationResult;

/**
 * packet-audit.ts
 *
 * Batch audit of implementation packets from a targets file.
 * Each target is processed independently — a single failure does not abort the batch.
 */

interface PacketAuditEntry {
    type: string;
    id: string;
    status: 'passed' | 'failed' | 'missing';
    outputPath?: string;
    missingCount: number;
    omittedCount: number;
    itemsCount: number;
    baselineCount: number;
    constraintsCount: number;
    errors: string[];
    validationIssues?: PacketValidationIssue[];
    missingDetailsSummary?: {
        ref: string;
        kind: string;
        suggestedAction: string;
    }[];
}
interface PacketAuditSummary {
    schemaVersion: '1.3';
    total: number;
    passed: number;
    failed: number;
    missing: number;
    totalOmitted: number;
    targets: PacketAuditEntry[];
    generatedAt: string;
    /** Absolute path to the targets file (--targets-file mode only) */
    sourceTargetsPath?: string;
    /** Context mode used for this audit run */
    mode?: ContextMode;
    /** Output format used for this audit run */
    format?: 'json' | 'markdown';
    /** maxPerCategory value used (undefined = default) */
    maxPerCategory?: number;
    /** How packet files were written: 'full' (all), 'summary-only' (none), 'sample' (selected) */
    packetOutputMode?: 'full' | 'summary-only' | 'sample';
    /** Targets for which packet files were written (--sample-targets mode) */
    sampleTargets?: string[];
    /** Paths to sample packet files written */
    sampleOutputPaths?: string[];
    /** Detail level: 'full' includes all targets, 'compact' omits passed targets */
    summaryDetail?: 'full' | 'compact';
    /** Per-type counts (compact mode) */
    countsByType?: Record<string, number>;
}
interface TargetRef {
    type: string;
    id: string;
}
interface AuditOptions {
    root: string;
    outDir?: string;
    format?: 'json' | 'markdown';
    mode?: ContextMode;
    maxPerCategory?: number;
    /** Absolute path to the targets file (--targets-file mode only) */
    sourceTargetsPath?: string;
    /** If true, do not write individual packet files — only summary */
    summaryOnly?: boolean;
    /** List of target keys (type:id) for which to write packet files */
    sampleTargets?: string[];
    /** Detail level: 'full' includes all targets, 'compact' omits passed targets */
    summaryDetail?: 'full' | 'compact';
}
interface ParseError {
    line: number;
    raw: string;
    message: string;
}
interface ParseResult {
    targets: TargetRef[];
    errors: ParseError[];
}
/**
 * Parse a targets file where each line is `type:id`.
 * Blank lines and lines starting with `#` are skipped.
 * Returns structured result with valid targets and parse errors.
 */
declare function parseTargetsFile(content: string): ParseResult;
/**
 * Audit a list of targets by generating packets for each.
 * Each target is processed independently — a single failure does not abort the batch.
 */
declare function auditPackets(root: string, targets: TargetRef[], options: AuditOptions, graph?: ArtifactGraph): Promise<PacketAuditSummary>;
interface DiscoverAuditOptions {
    root: string;
    outDir?: string;
    format?: 'json' | 'markdown';
    mode?: ContextMode;
    maxPerCategory?: number;
    limit?: number;
    summaryOnly?: boolean;
    sampleTargets?: string[];
    summaryDetail?: 'full' | 'compact';
}
/**
 * Scan artifacts, discover targets, then audit packets for each.
 * Single scan is reused for both discovery and audit.
 */
declare function discoverAndAuditPackets(root: string, options: DiscoverAuditOptions): Promise<PacketAuditSummary>;

/**
 * packet-prompt.ts
 *
 * Generate a compressed Claude Code task prompt from an implementation packet.
 * Output is designed to be directly pasted into Claude Code as a task instruction.
 * Default max 4000 characters; references packet/evidence paths when content exceeds limit.
 * No LLM involvement — pure template rendering.
 */

/** Options for packet-prompt generation */
interface PacketPromptOptions {
    /** Max character count for the output prompt. Default: 4000 */
    maxChars?: number;
    /** Fixed ISO 8601 timestamp for reproducible output */
    generatedAt?: string;
    /** Root path for resolving file references */
    root?: string;
}
/** Default max character count */
declare const DEFAULT_MAX_CHARS = 4000;
/** Minimum prompt size that can still satisfy validatePacketPrompt() for supported target IDs. */
declare const MIN_PROMPT_CHARS = 320;
/** Structured error returned when prompt cannot be compressed to the requested maxChars */
interface PacketPromptError {
    ok: false;
    reason: string;
    actualLength: number;
    minRequired: number;
}
/**
 * Generate a compressed Claude Code task prompt from a packet.
 *
 * Output is ≤ maxChars characters by default.
 * When content would exceed the limit, context details are replaced with
 * references to the packet command.
 * Returns a PacketPromptError object when the prompt cannot be compressed to maxChars.
 */
declare function renderPacketPrompt(packet: ImplementationPacket, options?: PacketPromptOptions): string | PacketPromptError;

/**
 * packet-prompt-validator.ts
 *
 * Lightweight validator for packet-prompt output.
 * Validates that a generated handoff prompt contains all required sections.
 * Used by both CLI validation and evidence generation.
 */
interface PromptValidationIssue {
    code: string;
    message: string;
    severity: 'error' | 'warning';
}
interface PromptValidationResult {
    ok: boolean;
    issues: PromptValidationIssue[];
}
/**
 * Validate a packet-prompt output string.
 *
 * Checks that the prompt contains all required sections:
 * - 目标信息
 * - packet 命令或来源
 * - 验证命令
 * - 提交要求
 * - 禁止事项
 * - 不得回退规则
 * - SEC severity 规则
 * - 中文主导（warning）
 */
declare function validatePacketPrompt(prompt: string): PromptValidationResult;

declare const VERSION_LOCK_PATH = "artifacts/traceability-version-lock.json";
declare const VERSION_INDEX_SCHEMA_VERSION = "1.0";
declare const VERSION_LOCK_SCHEMA_VERSION = "1.0";
type VersionSourceKind = 'artifact' | 'code' | 'test';
type VersionEdgeKind = 'references' | 'covers' | 'depends_on' | 'implements' | 'verifies';
type VersionLockStatus = 'fresh' | 'target_not_found' | 'artifact_changed' | 'source_changed' | 'verified_by_changed' | 'missing_lock' | 'orphan_lock';
interface VersionedNode {
    uid: string;
    type: string;
    id: string;
    path: string;
    title: string;
    line: number;
    sourceKind: VersionSourceKind;
    contentHash: string;
}
interface VersionedEdge {
    from: string;
    to: string;
    kind: VersionEdgeKind | string;
    source: string;
    sourcePath: string;
    sourceLine: number;
    fromHash?: string;
    toHash?: string;
}
interface VersionIndex {
    schemaVersion: typeof VERSION_INDEX_SCHEMA_VERSION;
    root: string;
    graph: {
        nodes: number;
        edges: number;
    };
    nodes: VersionedNode[];
    edges: VersionedEdge[];
}
interface VersionLockRef {
    type: string;
    id: string;
    path: string;
    contentHash: string;
}
interface VersionLockSourceRef {
    type: 'code' | 'test';
    path: string;
    contentHash: string;
}
interface VersionLockEntry {
    edgeId: string;
    kind: 'implements' | 'verifies';
    artifact: VersionLockRef;
    source: VersionLockSourceRef;
    verifiedBy?: VersionLockSourceRef[];
}
interface VersionLockFile {
    schemaVersion: typeof VERSION_LOCK_SCHEMA_VERSION;
    locks: VersionLockEntry[];
}
interface VersionLockIssue {
    status: VersionLockStatus;
    edgeId: string;
    message: string;
    artifact?: VersionLockRef;
    source?: VersionLockSourceRef;
    currentArtifactHash?: string;
    currentSourceHash?: string;
    currentVerifiedByHash?: string;
    verifiedByPath?: string;
}
interface VersionLockAuditResult {
    schemaVersion: '1.0';
    root: string;
    lockPath: string;
    totalLocks: number;
    fresh: number;
    issues: VersionLockIssue[];
}
interface TraceVersionResult {
    schemaVersion: '1.0';
    root: string;
    lockPath: string;
    target: {
        uid: string;
        node?: VersionedNode;
    };
    currentEdges: VersionedEdge[];
    locks: VersionLockEntry[];
    issues: VersionLockIssue[];
}
interface VersionLockUpdateOptions {
    target: string;
    source: string;
    verifiedBy?: string[];
    lockPath?: string;
}
interface VersionLockBootstrapOptions {
    lockPath?: string;
    force?: boolean;
}
interface VersionLockRefreshOptions {
    lockPath?: string;
    changedOnly?: boolean;
    changedPaths?: string[];
    all?: boolean;
    removeOrphans?: boolean;
}
interface VersionLockRefreshResult {
    schemaVersion: '1.0';
    root: string;
    lockPath: string;
    mode: 'all' | 'changed-only';
    changedPaths: string[];
    affectedEdges: string[];
    addedLocks: string[];
    updatedLocks: string[];
    retainedOrphans: string[];
    removedOrphans: string[];
    postAudit: VersionLockAuditResult;
    warnings: string[];
}
declare function buildVersionIndex(root: string, graph?: ArtifactGraph): Promise<VersionIndex>;
declare function auditVersionLock(root: string, lockPath?: string, graph?: ArtifactGraph): Promise<VersionLockAuditResult>;
declare function updateVersionLock(root: string, options: VersionLockUpdateOptions): Promise<VersionLockFile>;
declare function bootstrapVersionLock(root: string, options?: VersionLockBootstrapOptions): Promise<VersionLockFile>;
declare function refreshVersionLock(root: string, options?: VersionLockRefreshOptions): Promise<VersionLockRefreshResult>;
declare function traceVersion(root: string, target: string, lockPath?: string): Promise<TraceVersionResult>;
declare function renderVersionLockAuditMarkdown(result: VersionLockAuditResult): string;
declare function renderVersionLockRefreshMarkdown(result: VersionLockRefreshResult): string;
declare function renderTraceVersionMarkdown(result: TraceVersionResult): string;

type ArtifactGraphCliSource = 'node_modules' | 'path' | 'legacy' | 'plugin-bundled';
interface ArtifactGraphCliCandidate {
    source: ArtifactGraphCliSource;
    path: string;
    exists: boolean;
}
interface ArtifactGraphCliResolution {
    path?: string;
    source?: ArtifactGraphCliSource;
    candidates: ArtifactGraphCliCandidate[];
    warnings: string[];
}
interface ResolveArtifactGraphCliOptions {
    projectCliPath?: string;
    fallbackPath?: string;
}
interface ArtifactChainDoctorReport {
    schemaVersion: '1.0';
    root: string;
    cli: ArtifactGraphCliResolution;
    node: {
        version: string;
        compatible: boolean;
        required: '>=22.0.0';
    };
    config: {
        path: string;
        exists: boolean;
    };
    lock: {
        path: string;
        exists: boolean;
    };
    supportedCommands: string[];
    warnings: string[];
}
declare function resolveArtifactGraphCli(root: string, options?: ResolveArtifactGraphCliOptions): Promise<ArtifactGraphCliResolution>;
declare function doctorArtifactChain(root: string, options?: ResolveArtifactGraphCliOptions): Promise<ArtifactChainDoctorReport>;
declare function renderDoctorMarkdown(report: ArtifactChainDoctorReport): string;

type GitChangeMode = 'staged' | 'worktree' | 'base';
interface CollectChangedPathsOptions {
    mode: GitChangeMode;
    base?: string;
}
interface GitChangeResult {
    root: string;
    mode: GitChangeMode;
    base?: string;
    changedPaths: string[];
    unstagedPaths: string[];
    stagedUnstagedConflictPaths: string[];
}
declare function collectChangedPaths(root: string, options: CollectChangedPathsOptions): Promise<GitChangeResult>;

interface ManagedHookBlockOptions {
    hookPath: string;
    block: string;
    markerId?: string;
    uninstall?: boolean;
}
interface HookInstallResult {
    hookPath: string;
    action: 'installed' | 'replaced' | 'uninstalled' | 'unchanged';
    markerId: string;
}
declare function installManagedHookBlock(options: ManagedHookBlockOptions): Promise<HookInstallResult>;

interface ArtifactNode {
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
interface ArtifactEdge {
    from: string;
    to: string;
    kind: string;
    source: string;
    sourcePath: string;
    sourceLine: number;
}
interface ValidationIssue {
    code: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    node?: string;
    edge?: ArtifactEdge;
    path: string;
    line: number;
}
interface ArtifactTypeSchema {
    paths: string[];
    idPattern?: string;
    displayName?: string;
    role?: ArtifactTypeRole;
    layer?: string;
    aliases?: string[];
}
interface ArtifactEdgeRule {
    from: string;
    to: string;
    kind: string;
}
interface ArtifactSchema {
    types: Record<string, ArtifactTypeSchema>;
    idPatterns: Record<string, string>;
    relationFields: Record<string, string[]>;
    allowedEdges: ArtifactEdgeRule[];
    forbiddenEdges: ArtifactEdgeRule[];
    statuses: string[];
    idRanges: Record<string, Record<string, {
        prefix: string;
        start: number;
        end: number;
    }>>;
}
declare const TARGET_ARTIFACT_TYPES: readonly ["feature", "scenario", "decision", "design", "e2e_test"];
type TargetArtifactType = typeof TARGET_ARTIFACT_TYPES[number];
type ArtifactTypeRole = TargetArtifactType | 'context' | 'candidate' | 'not-recommended';
interface ArtifactTypeMetadata {
    type: string;
    displayName: string;
    role: ArtifactTypeRole;
    layer: string;
    aliases: string[];
    targetCapable: boolean;
}
declare function isTargetArtifactType(type: string): type is TargetArtifactType;
declare function getArtifactTypeMetadata(schema: ArtifactSchema, type: string): ArtifactTypeMetadata;
declare function getTargetArtifactTypes(schema?: ArtifactSchema): TargetArtifactType[];
interface ArtifactGraph {
    nodes: ArtifactNode[];
    edges: ArtifactEdge[];
    generatedAt: string;
}
interface QueryOptions {
    from?: string;
    to?: string;
    depth?: number;
}
type ContextTier = 'baseline' | 'target' | 'direct' | 'matrix' | 'transitive';
interface ContextItem {
    path: string;
    reason: string;
    required?: boolean;
    tier?: ContextTier;
    reasons?: string[];
}
interface MissingDetail {
    ref: string;
    from: string;
    kind: 'unresolved-outgoing' | 'unresolved-incoming' | 'target-not-found' | 'multiple-targets';
    message: string;
    suggestedAction: string;
}
interface ContextManifest {
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
}
type ContextMode = 'full' | 'implementation';
interface ContextOptions {
    feature?: string;
    scenario?: string;
    decision?: string;
    design?: string;
    e2e_test?: string;
    mode?: ContextMode;
    maxPerCategory?: number;
}
declare const DEFAULT_SCHEMA: ArtifactSchema;
declare function loadConfig(root: string): Promise<ArtifactSchema>;
declare function buildGraph(nodes: Omit<ArtifactNode, 'uid'>[], edges: ArtifactEdge[]): ArtifactGraph;
declare function scanArtifacts(root: string, schema?: ArtifactSchema): Promise<ArtifactGraph>;
/**
 * Resolve traceability-matrix-v2 edges:
 * 1. Edges pointing to matrix-row targets (traceability-matrix-v2:*) are kept as-is.
 * 2. Unresolved refs (`resolve:BARE_ID`) are resolved to real artifact nodes when possible,
 *    otherwise left as `resolve:BARE_ID` (which becomes a DANGLING_REFERENCE in validateGraph).
 */
declare function resolveMatrixEdges(graph: ArtifactGraph): ArtifactGraph;
declare function validateGraph(graph: ArtifactGraph, schema?: ArtifactSchema): ValidationIssue[];
declare function queryGraph(graph: ArtifactGraph, options: QueryOptions): ArtifactGraph;
declare function renderMermaid(graph: ArtifactGraph): string;
declare function nextId(graph: ArtifactGraph, schema: ArtifactSchema, type: string, rangeName: string): string;
declare function writeGraphCache(root: string, graph: ArtifactGraph): Promise<void>;
declare function validateExecutableTraceability(root: string): Promise<ValidationIssue[]>;
interface DiscoverOptions {
    limit?: number;
    schema?: ArtifactSchema;
}
/**
 * Discover audit targets from an artifact graph.
 * Collects configured target-capable artifact nodes, sorted by id within each type.
 * When the total exceeds `limit`, uses round-robin across configured target types
 * to keep the sample balanced.
 */
declare function discoverTargets(graph: ArtifactGraph, options?: DiscoverOptions): Array<{
    type: string;
    id: string;
}>;

declare function resolveArtifactContext(graph: ArtifactGraph, opts: ContextOptions): ContextManifest;
declare function formatContextMarkdown(manifest: ContextManifest): string;

export { ALWAYS_PRESENT_ITEMS as ALWAYS_PRESENT, type ArtifactChainDoctorReport, type ArtifactEdge, type ArtifactEdgeRule, type ArtifactGraph, type ArtifactGraphCliCandidate, type ArtifactGraphCliResolution, type ArtifactGraphCliSource, type ArtifactNode, type ArtifactSchema, type ArtifactTypeMetadata, type ArtifactTypeRole, type ArtifactTypeSchema, BASELINE_CONSTRAINTS, BASELINE_CONSTRAINTS_COUNT, BASELINE_ITEMS_COUNT, type CollectChangedPathsOptions, type ContextItem, type ContextManifest, type ContextMode, type ContextOptions, type ContextTier, DEFAULT_MAX_CHARS, DEFAULT_SCHEMA, type DiscoverOptions, type GitChangeMode, type GitChangeResult, type HookInstallResult, type ImplementationBlueprintDraft, type ImplementationPacket, MIN_PROMPT_CHARS, type ManagedHookBlockOptions, type MissingDetail, type PacketAuditEntry, type PacketAuditSummary, type PacketCategory, type PacketItem, type PacketOmittedItem, type PacketOptions, type PacketPromptError, type PacketPromptOptions, type PacketTarget, type PacketTargetType, type PacketValidationIssue, type PacketValidationResult, type PromptValidationIssue, type PromptValidationResult, type QueryOptions, type ResolveArtifactGraphCliOptions, type ReviewOrderStep, type RiskChecklistItem, TARGET_ARTIFACT_TYPES, type TargetArtifactType, type TraceVersionResult, VALID_PACKET_TARGET_TYPES, VERSION_INDEX_SCHEMA_VERSION, VERSION_LOCK_PATH, VERSION_LOCK_SCHEMA_VERSION, type ValidationIssue, type VersionEdgeKind, type VersionIndex, type VersionLockAuditResult, type VersionLockBootstrapOptions, type VersionLockEntry, type VersionLockFile, type VersionLockIssue, type VersionLockRef, type VersionLockRefreshOptions, type VersionLockRefreshResult, type VersionLockSourceRef, type VersionLockStatus, type VersionLockUpdateOptions, type VersionSourceKind, type VersionedEdge, type VersionedNode, assemblePacket, auditPackets, auditVersionLock, bootstrapVersionLock, buildGraph, buildVersionIndex, collectChangedPaths, discoverAndAuditPackets, discoverTargets, doctorArtifactChain, formatContextMarkdown, getArtifactTypeMetadata, getTargetArtifactTypes, installManagedHookBlock, isPacketTargetType, isTargetArtifactType, loadConfig, nextId, parseTargetsFile, queryGraph, refreshVersionLock, renderDoctorMarkdown, renderMermaid, renderPacketMarkdown, renderPacketPrompt, renderTraceVersionMarkdown, renderVersionLockAuditMarkdown, renderVersionLockRefreshMarkdown, resolveArtifactContext, resolveArtifactGraphCli, resolveMatrixEdges, scanArtifacts, traceVersion, updateVersionLock, validateExecutableTraceability, validateGraph, validatePacket, validatePacketMarkdown, validatePacketPrompt, writeGraphCache };
