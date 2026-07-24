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
 * target-selector.ts
 *
 * Unified target selector for the artifact-graph CLI.
 * Parses `--target <type>:<id>` and resolves from legacy flags,
 * enforcing mutual exclusivity between the two forms.
 */

/**
 * Parse a `<type>:<id>` selector string, splitting only on the first colon.
 * Colons within the ID portion are preserved (e.g. `e2e_test:batch:TC-001` → `{ type: 'e2e_test', id: 'batch:TC-001' }`).
 */
declare function parseTargetSelector(value: string): ArtifactTarget;
/**
 * Resolve the effective target from CLI flags.
 *
 * Accepts either `--target <type>:<id>` OR one of the legacy flags (`--feature`, `--scenario`, etc.).
 * Mixing both forms is a hard error.
 *
 * @param flags  Parsed CLI flags (Record<string, string | boolean>)
 * @param schema Loaded artifact schema — used to verify target capability
 * @returns Resolved ArtifactTarget
 * @throws Error on invalid/mutually-exclusive/unsupported flags
 */
declare function resolveCliTarget(flags: Record<string, string | boolean>, schema: ArtifactSchema): ArtifactTarget;

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
    /** Explicit universal baseline policy: true=enabled, false=disabled. Absent=legacy (pre-0.5) packet. */
    baselinePolicy?: boolean;
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
 *
 * v1.12: accepts optional schema to derive valid target types dynamically.
 * Without schema, falls back to the static VALID_PACKET_TARGET_TYPES list.
 *
 * v0.5: PKT-004 no longer infers opt-out from missingDetails or total=0.
 *       baselinePolicy=true|absent → must match ALWAYS_PRESENT_ITEMS exactly.
 *       baselinePolicy=false       → must be total=0, items=[].
 */

/** Valid target types for packets (legacy static fallback) */
declare const VALID_PACKET_TARGET_TYPES: readonly ["feature", "scenario", "decision", "design", "e2e_test"];
type PacketTargetType = typeof VALID_PACKET_TARGET_TYPES[number];
declare function isPacketTargetType(type: string): type is PacketTargetType;
/**
 * Check whether a type is a valid packet target, optionally using a loaded schema.
 * When a schema is provided, uses dynamic target-capable types.
 * Without schema, uses the static VALID_PACKET_TARGET_TYPES.
 */
type PacketTargetSchema = {
    types: Record<string, {
        target?: boolean;
        role?: string;
    }>;
    idPatterns?: Record<string, string>;
};
declare function isPacketTargetTypeDynamic(type: string, schema?: PacketTargetSchema): boolean;
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
declare function validatePacket(packet: ImplementationPacket, schema?: PacketTargetSchema): PacketValidationResult;
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
    /** When true (default), check universal baseline files. When false, skip. */
    universalBaseline?: boolean;
    /** Absolute path to the targets file (--targets-file mode only) */
    sourceTargetsPath?: string;
    /** If true, do not write individual packet files — only summary */
    summaryOnly?: boolean;
    /** List of target keys (type:id) for which to write packet files */
    sampleTargets?: string[];
    /** Detail level: 'full' includes all targets, 'compact' omits passed targets */
    summaryDetail?: 'full' | 'compact';
    /** Artifact schema for dynamic target type validation in validatePacket */
    schema?: ArtifactSchema;
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
 *
 * When a schema is provided, target types are validated against the schema's
 * target-capable types (dynamic). Without a schema, falls back to the static
 * VALID_PACKET_TARGET_TYPES list for backward compatibility.
 */
declare function parseTargetsFile(content: string, schema?: ArtifactSchema): ParseResult;
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
    /** Artifact schema for dynamic target type validation */
    schema?: ArtifactSchema;
    /** When true (default), check universal baseline files. When false, skip. */
    universalBaseline?: boolean;
}
/**
 * Scan artifacts, discover targets, then audit packets for each.
 * Single scan is reused for both discovery and audit.
 *
 * When options.universalBaseline is undefined, falls back to config.context?.universal_baseline.
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
declare function auditVersionLock(root: string, lockPath?: string, graph?: ArtifactGraph, config?: ArtifactSchema): Promise<VersionLockAuditResult>;
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

type GitHookName = 'pre-commit' | 'pre-push';
declare function resolveGitHookPath(root: string, hookName: GitHookName): Promise<string>;

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
type HookEntryKind = 'missing' | 'file' | 'symlink' | 'other';
interface HookSnapshot {
    kind: HookEntryKind;
    bytes: Buffer;
    dev?: bigint;
    ino?: bigint;
    size?: bigint;
    mtimeNs?: bigint;
    mode?: bigint;
    linkTarget?: string;
}
interface DesiredHookState {
    exists: boolean;
    bytes: Buffer;
    mode?: number;
}
interface PreparedManagedHookBlock {
    readonly hookPath: string;
    readonly result: HookInstallResult;
    readonly snapshot: HookSnapshot;
    readonly desired: DesiredHookState;
    readonly writeRequired: boolean;
}
declare function prepareManagedHookBlock(options: ManagedHookBlockOptions): Promise<PreparedManagedHookBlock>;
declare function applyPreparedManagedHookBlocks(prepared: readonly PreparedManagedHookBlock[]): Promise<HookInstallResult[]>;
declare function installManagedHookBlock(options: ManagedHookBlockOptions): Promise<HookInstallResult>;

/**
 * Review Result Protocol validator.
 *
 * Validates a JSON object against the review-result.schema.json constraints.
 * Does NOT use ajv or any JSON-schema library — pure deterministic checks
 * for zero-dependency CLI use.
 */
interface ValidationError {
    path: string;
    message: string;
}
/**
 * Validate a review result object against the v1.0 protocol.
 *
 * @param input - Parsed JSON to validate (not a string).
 * @returns Array of validation errors. Empty = valid.
 */
declare function validateReviewResult(input: unknown): ValidationError[];

/**
 * Review Result Protocol v1.0 — TypeScript types.
 *
 * Canonical schema: schemas/review-result.schema.json
 * These types are the programmatic equivalent; keep both in sync.
 */
type ReviewStatus = 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'NEEDS_INPUT' | 'SKIPPED';
type ReviewDecision = 'PASS' | 'FAIL' | 'PASS_WITH_RESIDUAL_MINOR' | 'BLOCKED' | 'NEEDS_INPUT' | 'NOT_APPLICABLE';
type FindingSeverity = 'block' | 'warn' | 'info';
type FindingStatus = 'open' | 'resolved' | 'accepted' | 'superseded';
type ExecutorType = 'script' | 'worker' | 'agent' | 'manual' | 'cli';
interface FindingLocation {
    file?: string;
    line?: number;
    column?: number;
}
interface Finding {
    id: string;
    severity: FindingSeverity;
    category?: string;
    message: string;
    location?: FindingLocation;
    artifact_id?: string;
    evidence?: string;
    suggested_fix?: string;
    status?: FindingStatus;
    resolved_by?: string;
}
interface EvidenceObject {
    type: string;
    path: string;
    status?: string;
    decision?: string;
    summary?: string;
    command?: string;
    result?: string;
}
type Evidence = string | EvidenceObject;
interface Producer {
    executor: ExecutorType;
    name: string;
    skill?: string;
}
interface AcceptanceSourceResult {
    run_id: string;
    stage_id?: string;
    producer: Producer;
}
interface AcceptanceData {
    reviewer: Producer;
    source_result: AcceptanceSourceResult;
}
interface BatchDefinition {
    id: string;
    files: string[];
    chars?: number;
}
interface ReviewMetrics {
    files_reviewed?: number;
    files_scanned?: number;
    findings_count?: number;
    deterministic_findings_count?: number;
    semantic_findings_count?: number;
    block_count?: number;
    warn_count?: number;
    info_count?: number;
    resolved_count?: number;
    batch_count?: number;
    scenario_count?: number;
}
interface ReviewData {
    source_files?: string[];
    files?: string[];
    batches?: BatchDefinition[];
    metrics?: ReviewMetrics;
    findings?: Finding[];
    resolved_findings?: Finding[];
    repair_worker_needed?: boolean;
}
interface RepairValidation {
    command?: string;
    exit_code?: number;
    findings_remaining?: number;
}
interface RepairData {
    source_review_run_id?: string;
    source_review_stage_id?: string;
    findings_addressed?: Finding[];
    files_modified?: string[];
    validation_after_repair?: RepairValidation;
}
interface ReviewResult {
    schema_version: '1.0';
    run_id: string;
    stage_id?: string;
    attempt?: number;
    status: ReviewStatus;
    decision: ReviewDecision;
    summary: string;
    outputs?: string[];
    warnings?: string[];
    blocking_reason?: string | null;
    degradation?: string | null;
    producer?: Producer;
    acceptance?: AcceptanceData;
    evidence?: Evidence[];
    review?: ReviewData;
    repair?: RepairData;
}

interface ContractIdentity {
    /** Major identity (e.g., "artifact.e2e-test@1") */
    major: string;
    /** Authority namespace (e.g., "artifact", "project", "io.github.org") */
    authority: string;
    /** Namespace for ID resolution */
    namespace: string;
    /** Immutable revision digest (sha256:...) */
    revisionDigest: string;
    /** Machine-readable relation rules for this contract */
    relationRules?: Record<string, RelationRule>;
    /** Machine-readable semantic markers for this contract */
    semanticMarkers?: Record<string, SemanticMarker>;
}
interface RelationRule {
    /** Allowed target types for this relation kind */
    allowedTargetTypes: string[];
    /** Minimum cardinality (0 = optional) */
    min: number;
    /** Maximum cardinality */
    max: number;
    /** Anchor policy: "required", "optional", or "forbidden" */
    anchorPolicy: 'required' | 'optional' | 'forbidden';
}
interface SemanticMarker {
    /** Canonical JSON pointer to the semantic slot */
    jsonPointer: string;
    /** Markdown marker identifier (e.g., "scope", "system-boundary") */
    markdownMarker: string;
    /** Whether this marker is required */
    required: boolean;
}
interface ContractDefinition {
    identity: ContractIdentity;
    schema: ContractSchema;
    /** Raw schema content for digest computation */
    rawContent: string;
}
interface ContractSchema {
    $id: string;
    title: string;
    version: string;
    contractIdentity: ContractIdentity;
    type: string;
    required: string[];
    properties: Record<string, unknown>;
    definitions?: Record<string, unknown>;
    additionalProperties?: boolean;
}
declare const CONTRACT_ERROR_CODES: {
    /** Contract identity not found */
    readonly CONTRACT_NOT_FOUND: "CONTRACT_NOT_FOUND";
    /** Invalid contract identity format */
    readonly INVALID_IDENTITY: "INVALID_IDENTITY";
    /** Revision digest mismatch */
    readonly DIGEST_MISMATCH: "DIGEST_MISMATCH";
    /** Duplicate contract identity */
    readonly DUPLICATE_IDENTITY: "DUPLICATE_IDENTITY";
    /** Multiple active write contracts for same type */
    readonly MULTIPLE_ACTIVE_WRITE: "MULTIPLE_ACTIVE_WRITE";
    /** Unknown authority namespace */
    readonly UNKNOWN_AUTHORITY: "UNKNOWN_AUTHORITY";
    /** Namespace authority violation */
    readonly AUTHORITY_VIOLATION: "AUTHORITY_VIOLATION";
    /** Schema validation failed */
    readonly SCHEMA_VALIDATION_FAILED: "SCHEMA_VALIDATION_FAILED";
    /** Canonical IR normalization failed */
    readonly NORMALIZATION_FAILED: "NORMALIZATION_FAILED";
    /** Policy compatibility check failed */
    readonly POLICY_INCOMPATIBLE: "POLICY_INCOMPATIBLE";
    /** Legacy revision cannot be normalized */
    readonly LEGACY_NORMALIZATION_FAILED: "LEGACY_NORMALIZATION_FAILED";
    /** Canonical and legacy conflict */
    readonly CANONICAL_LEGACY_CONFLICT: "CANONICAL_LEGACY_CONFLICT";
    /** Relation rule violation */
    readonly RELATION_RULE_VIOLATION: "RELATION_RULE_VIOLATION";
    /** Relation rules missing in contract (fail closed) */
    readonly RELATION_RULES_MISSING: "RELATION_RULES_MISSING";
    /** Ambiguous revision — multiple revisions found, no unique active write */
    readonly AMBIGUOUS_REVISION: "AMBIGUOUS_REVISION";
    /** Invalid relation kind */
    readonly RELATION_INVALID_KIND: "RELATION_INVALID_KIND";
    /** Invalid relation target type */
    readonly RELATION_INVALID_TARGET_TYPE: "RELATION_INVALID_TARGET_TYPE";
    /** Relation below minimum cardinality */
    readonly RELATION_BELOW_MIN: "RELATION_BELOW_MIN";
    /** Relation above maximum cardinality */
    readonly RELATION_ABOVE_MAX: "RELATION_ABOVE_MAX";
    /** Missing required anchor */
    readonly RELATION_MISSING_ANCHOR: "RELATION_MISSING_ANCHOR";
    /** Forbidden anchor present */
    readonly RELATION_FORBIDDEN_ANCHOR: "RELATION_FORBIDDEN_ANCHOR";
    /** Missing required semantic marker */
    readonly MARKER_MISSING: "MARKER_MISSING";
    /** Duplicate semantic marker */
    readonly MARKER_DUPLICATE: "MARKER_DUPLICATE";
    /** Unknown semantic marker */
    readonly MARKER_UNKNOWN: "MARKER_UNKNOWN";
};
type ContractErrorCode = typeof CONTRACT_ERROR_CODES[keyof typeof CONTRACT_ERROR_CODES];
declare class ContractError extends Error {
    readonly code: ContractErrorCode;
    readonly details?: Record<string, unknown> | undefined;
    constructor(code: ContractErrorCode, message: string, details?: Record<string, unknown> | undefined);
}
/**
 * Check if a namespace is official (artifact or artifact.*)
 */
declare function isOfficialNamespace(namespace: string): boolean;
/**
 * Validate namespace authority
 * - Official namespace (artifact.*) can only be used by official contracts
 * - Third-party must use their own authority (e.g., io.github.org.*)
 * - Project contracts use project.<project-id>.*
 */
declare function validateNamespaceAuthority(identity: ContractIdentity, expectedAuthority?: string): void;
/**
 * Compute immutable revision digest for contract content.
 * Uses SHA-256 on canonicalized content (revisionDigest field excluded).
 */
declare function computeRevisionDigest(content: string): string;
/**
 * Verify that content matches expected digest
 */
declare function verifyDigest(content: string, expectedDigest: string): boolean;
interface ContractRegistryEntry {
    contract: ContractDefinition;
    isActive: boolean;
    isWriteTarget: boolean;
    loadedAt: string;
}
declare class ContractRegistry {
    private contracts;
    private typeToActiveWrite;
    private majorToContracts;
    /**
     * Register a contract
     * @throws ContractError if duplicate identity or multiple active write contracts
     */
    register(contract: ContractDefinition, options?: {
        isActive?: boolean;
        isWriteTarget?: boolean;
    }): void;
    /**
     * Resolve by major identity. Multiple revisions require a unique active write
     * revision; insertion order is never a resolution policy.
     */
    get(major: string): ContractDefinition | undefined;
    /**
     * Get contract by major identity and digest
     */
    getByMajorAndDigest(major: string, digest: string): ContractDefinition | undefined;
    /**
     * Get all contracts for a major identity
     */
    getByMajor(major: string): ContractDefinition[];
    /**
     * Get active write contract for a type
     */
    getActiveWriteContract(typePrefix: string): ContractDefinition | undefined;
    /**
     * List all registered contracts
     */
    list(): ContractRegistryEntry[];
    /**
     * Check if a contract is registered by major identity
     */
    has(major: string): boolean;
    /**
     * Check if a contract is registered by major identity and digest
     */
    hasByMajorAndDigest(major: string, digest: string): boolean;
}
interface CanonicalIR {
    /** Artifact type */
    type: string;
    /** Artifact ID */
    id: string;
    /** Contract major identity used */
    contractMajor: string;
    /** Contract revision digest */
    contractDigest: string;
    /** Normalized canonical data */
    canonical: Record<string, unknown>;
    /** Source revision (legacy or canonical) */
    sourceRevision: 'canonical' | 'legacy';
    /** Normalization warnings */
    warnings: string[];
}
interface NormalizationError {
    code: string;
    path: string;
    message: string;
}
interface NormalizationResult {
    success: boolean;
    ir?: CanonicalIR;
    errors: NormalizationError[];
    warnings: string[];
}
interface LegacyFieldMapping {
    /** Legacy field name */
    legacy: string;
    /** Canonical field name */
    canonical: string;
    /** Transform function (optional) */
    transform?: (value: unknown) => unknown;
    /** Whether field is required in canonical */
    required?: boolean;
}
interface NormalizerConfig {
    /** Contract identity this normalizer targets */
    contractMajor: string;
    /** Field mappings from legacy to canonical */
    fieldMappings: LegacyFieldMapping[];
    /** Validation function for canonical form */
    validate?: (canonical: Record<string, unknown>) => string[];
}
/**
 * Normalize data to canonical IR.
 * Handles:
 * - Pure canonical input: returns sourceRevision: 'canonical'
 * - Pure legacy input: maps to canonical, returns sourceRevision: 'legacy'
 * - Mixed input: detects canonical/legacy conflicts
 */
declare function normalizeToCanonical(legacyData: Record<string, unknown>, config: NormalizerConfig, contract: ContractDefinition): NormalizationResult;
interface ProjectPolicy {
    /** Policy identity */
    id: string;
    /** Base contract this policy tightens */
    baseContractMajor: string;
    /** Additional required fields */
    additionalRequired?: string[];
    /** Restricted enum values (subset of base) */
    restrictedEnums?: Record<string, unknown[]>;
    /** Minimum cardinality overrides */
    minCardinality?: Record<string, number>;
    /** Maximum cardinality overrides */
    maxCardinality?: Record<string, number>;
    /** Additional constraints */
    constraints?: Record<string, unknown>;
}
interface PolicyCompatibilityResult {
    compatible: boolean;
    errors: string[];
    warnings: string[];
}
/**
 * Validate that project policy only tightens (never loosens) base contract.
 * - Arrays use minItems/maxItems; numbers use minimum/maximum.
 * - Enum restrictions must be subsets of base enum.
 * - Unimplemented constraints are rejected (fail-closed).
 */
declare function validatePolicyCompatibility(policy: ProjectPolicy, baseContract: ContractDefinition): PolicyCompatibilityResult;
interface LoadContractOptions {
    /** Expected authority (optional, for validation) */
    expectedAuthority?: string;
}
/**
 * Load contract from JSON file.
 * Digest verification is always on (fail-closed) — no bypass option.
 */
declare function loadContract(contractPath: string, options?: LoadContractOptions): Promise<ContractDefinition>;
/**
 * Load all contracts from a directory.
 * Fails closed: if ANY contract is invalid, the entire load fails.
 */
declare function loadContractsFromDirectory(contractsDir: string, options?: LoadContractOptions): Promise<ContractDefinition[]>;
interface SchemaValidationResult {
    valid: boolean;
    errors: string[];
}
/**
 * Validate data against a contract schema using AJV.
 * AJV is a runtime dependency — if unavailable, validation fails closed.
 */
declare function validateContractAgainstSchema(data: unknown, contract: ContractDefinition): SchemaValidationResult;
declare const E2E_NORMALIZER_CONFIG: NormalizerConfig;
/**
 * Normalize a legacy E2E artifact to canonical IR.
 * The legacy format has flat fields (id, title, status, scope as string, etc.)
 * while the canonical format uses nested objects (metadata.id, scope.business_goal, etc.)
 * Requires explicit contract — no default identity fallback.
 */
declare function normalizeE2eLegacyArtifact(legacyData: Record<string, unknown>, contract: ContractDefinition): NormalizationResult;
interface ContractCatalogEntry {
    identity: ContractIdentity;
    contract: ContractDefinition;
}
/**
 * Machine-readable contract catalog.
 * Lists, resolves and explains registered contracts.
 * Uses (major, digest) as revision key for multi-revision support.
 */
declare class ContractCatalog {
    private contracts;
    private majorToContracts;
    private majorToActiveWrite;
    /**
     * Add a contract to the catalog
     * @throws ContractError if duplicate identity
     */
    add(contract: ContractDefinition, options?: {
        isActive?: boolean;
        isWriteTarget?: boolean;
    }): void;
    /**
     * Resolve a contract by major identity.
     * - 0 entries: returns undefined
     * - 1 entry: returns it
     * - multiple: if there's a unique active write, returns it; otherwise throws AMBIGUOUS_REVISION
     */
    resolve(major: string): ContractDefinition | undefined;
    /**
     * Resolve a contract by major identity and exact digest
     */
    resolveByDigest(major: string, digest: string): ContractDefinition | undefined;
    /**
     * List all catalog entries (all revisions)
     */
    list(): ContractCatalogEntry[];
    /**
     * Get catalog as JSON-serializable object (all revisions)
     */
    toJSON(): Record<string, unknown>;
}
/**
 * Load contract catalog from a contracts directory
 */
declare function loadContractCatalog(contractsDir: string, options?: LoadContractOptions): Promise<ContractCatalog>;

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
interface ArtifactExtraFieldSchema {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'enum';
    enum?: Array<string | number | boolean>;
}
interface ArtifactTypeSchema {
    paths: string[];
    idPattern?: string;
    displayName?: string;
    role?: ArtifactTypeRole;
    layer?: string;
    aliases?: string[];
    target?: boolean;
    extraFields?: ArtifactExtraFieldSchema[];
}
interface ArtifactTarget {
    type: string;
    id: string;
}
interface ArtifactEdgeRule {
    from: string;
    to: string;
    kind: string;
}
/** E2E test runner configuration */
interface E2eRunnerConfig {
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
interface E2eWaiver {
    id: string;
    reason: string;
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
declare function getTargetArtifactTypes(schema?: ArtifactSchema): string[];
/**
 * Resolve a token (which may be an exact type name or an explicit alias) to
 * the canonical artifact type name. Returns `undefined` if no match.
 *
 * Strict matching only — no automatic hyphen/underscore conversion.
 */
declare function resolveArtifactTypeName(schema: ArtifactSchema, token: string): string | undefined;
interface ArtifactGraph {
    nodes: ArtifactNode[];
    edges: ArtifactEdge[];
    generatedAt: string;
    /** Normalized absolute project root passed to scanArtifacts. Optional for backward compatibility. */
    root?: string;
    /** Scan-time diagnostics. Optional for backward compatibility with consumers that build graph literals without this field. */
    diagnostics?: ValidationIssue[];
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
    kind: 'unresolved-outgoing' | 'unresolved-incoming' | 'target-not-found' | 'multiple-targets' | 'missing-baseline';
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
    /** Explicit universal baseline policy: true=enabled, false=disabled. Used by validatePacket to prevent inferring opt-out from total=0. */
    baselinePolicy?: boolean;
}
type ContextMode = 'full' | 'implementation';
interface ContextOptions {
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
declare const DEFAULT_SCHEMA: ArtifactSchema;
declare function loadConfig(root: string): Promise<ArtifactSchema>;
declare function buildGraph(nodes: Omit<ArtifactNode, 'uid'>[], edges: ArtifactEdge[], diagnostics?: ValidationIssue[], root?: string): ArtifactGraph;
declare function scanArtifacts(root: string, schema?: ArtifactSchema): Promise<ArtifactGraph>;
/**
 * Resolve traceability-matrix-v2 edges:
 * 1. Edges pointing to matrix-row targets (traceability-matrix-v2:*) are kept as-is.
 * 2. Unresolved refs (`resolve:BARE_ID`) are resolved to real artifact nodes when possible,
 *    otherwise left as `resolve:BARE_ID` (which becomes a DANGLING_REFERENCE in validateGraph).
 */
declare function resolveMatrixEdges(graph: ArtifactGraph): ArtifactGraph;
declare function validateGraph(graph: ArtifactGraph, schema?: ArtifactSchema): ValidationIssue[];
declare function validateScenarioPrdLinks(graph: ArtifactGraph, schema?: ArtifactSchema): ValidationIssue[];
declare function validateScenarioPrdLinkIndex(root: string, graph: ArtifactGraph): Promise<ValidationIssue[]>;
declare function queryGraph(graph: ArtifactGraph, options: QueryOptions): ArtifactGraph;
declare function renderMermaid(graph: ArtifactGraph): string;
declare function nextId(graph: ArtifactGraph, schema: ArtifactSchema, type: string, rangeName: string): string;
declare function writeGraphCache(root: string, graph: ArtifactGraph): Promise<void>;
declare function validateExecutableTraceability(root: string, config?: ArtifactSchema): Promise<ValidationIssue[]>;
/** O2: E2E coverage statistics and blackhole diagnostics */
interface E2eCoverageStats {
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
    acCoverageRateByFeature: Record<string, {
        numerator: number;
        denominator: number;
        rate: number;
    }>;
    /** Multi-dimensional scenario coverage */
    scenarioCoverage: Record<string, {
        linked: boolean;
        acCovered: boolean;
        waived: boolean;
        verified: boolean;
    }>;
    /** Multi-dimensional feature coverage */
    featureCoverage: Record<string, {
        linked: boolean;
        acCovered: boolean;
        waived: boolean;
        verified: boolean;
    }>;
}
interface E2eCoverageThresholds {
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
declare function computeE2eCoverageStats(graph: ArtifactGraph, root: string, thresholds?: E2eCoverageThresholds): Promise<E2eCoverageStats>;
/** O4: Deterministic, idempotent E2E registry generation from Markdown sources */
interface E2eRegistryBatch {
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
interface E2eRegistry {
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
declare function generateE2eRegistry(root: string, opts?: {
    deterministic?: boolean;
}): Promise<E2eRegistry>;
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

export { ALWAYS_PRESENT_ITEMS as ALWAYS_PRESENT, type ArtifactChainDoctorReport, type ArtifactEdge, type ArtifactEdgeRule, type ArtifactExtraFieldSchema, type ArtifactGraph, type ArtifactGraphCliCandidate, type ArtifactGraphCliResolution, type ArtifactGraphCliSource, type ArtifactNode, type ArtifactSchema, type ArtifactTarget, type ArtifactTypeMetadata, type ArtifactTypeRole, type ArtifactTypeSchema, BASELINE_CONSTRAINTS, BASELINE_CONSTRAINTS_COUNT, BASELINE_ITEMS_COUNT, type BatchDefinition, CONTRACT_ERROR_CODES, type CanonicalIR, type CollectChangedPathsOptions, type ContextItem, type ContextManifest, type ContextMode, type ContextOptions, type ContextTier, ContractCatalog, type ContractCatalogEntry, type ContractDefinition, ContractError, type ContractErrorCode, type ContractIdentity, ContractRegistry, type ContractRegistryEntry, type ContractSchema, DEFAULT_MAX_CHARS, DEFAULT_SCHEMA, type DiscoverOptions, E2E_NORMALIZER_CONFIG, type E2eCoverageStats, type E2eCoverageThresholds, type E2eRegistry, type E2eRegistryBatch, type E2eRunnerConfig, type E2eWaiver, type Evidence, type EvidenceObject, type ExecutorType, type Finding, type FindingLocation, type FindingSeverity, type FindingStatus, type GitChangeMode, type GitChangeResult, type GitHookName, type HookInstallResult, type ImplementationBlueprintDraft, type ImplementationPacket, type LegacyFieldMapping, type LoadContractOptions, MIN_PROMPT_CHARS, type ManagedHookBlockOptions, type MissingDetail, type NormalizationResult, type NormalizerConfig, type PacketAuditEntry, type PacketAuditSummary, type PacketCategory, type PacketItem, type PacketOmittedItem, type PacketOptions, type PacketPromptError, type PacketPromptOptions, type PacketTarget, type PacketTargetType, type PacketValidationIssue, type PacketValidationResult, type PolicyCompatibilityResult, type PreparedManagedHookBlock, type Producer, type ProjectPolicy, type PromptValidationIssue, type PromptValidationResult, type QueryOptions, type RepairData, type RepairValidation, type ResolveArtifactGraphCliOptions, type ReviewData, type ReviewDecision, type ReviewMetrics, type ReviewOrderStep, type ReviewResult, type ReviewStatus, type RiskChecklistItem, type SchemaValidationResult, TARGET_ARTIFACT_TYPES, type TargetArtifactType, type TraceVersionResult, VALID_PACKET_TARGET_TYPES, VERSION_INDEX_SCHEMA_VERSION, VERSION_LOCK_PATH, VERSION_LOCK_SCHEMA_VERSION, type ValidationError, type ValidationIssue, type VersionEdgeKind, type VersionIndex, type VersionLockAuditResult, type VersionLockBootstrapOptions, type VersionLockEntry, type VersionLockFile, type VersionLockIssue, type VersionLockRef, type VersionLockRefreshOptions, type VersionLockRefreshResult, type VersionLockSourceRef, type VersionLockStatus, type VersionLockUpdateOptions, type VersionSourceKind, type VersionedEdge, type VersionedNode, applyPreparedManagedHookBlocks, assemblePacket, auditPackets, auditVersionLock, bootstrapVersionLock, buildGraph, buildVersionIndex, collectChangedPaths, computeE2eCoverageStats, computeRevisionDigest, discoverAndAuditPackets, discoverTargets, doctorArtifactChain, formatContextMarkdown, generateE2eRegistry, getArtifactTypeMetadata, getTargetArtifactTypes, installManagedHookBlock, isOfficialNamespace, isPacketTargetType, isPacketTargetTypeDynamic, isTargetArtifactType, loadConfig, loadContract, loadContractCatalog, loadContractsFromDirectory, nextId, normalizeE2eLegacyArtifact, normalizeToCanonical, parseTargetSelector, parseTargetsFile, prepareManagedHookBlock, queryGraph, refreshVersionLock, renderDoctorMarkdown, renderMermaid, renderPacketMarkdown, renderPacketPrompt, renderTraceVersionMarkdown, renderVersionLockAuditMarkdown, renderVersionLockRefreshMarkdown, resolveArtifactContext, resolveArtifactGraphCli, resolveArtifactTypeName, resolveCliTarget, resolveGitHookPath, resolveMatrixEdges, scanArtifacts, traceVersion, updateVersionLock, validateContractAgainstSchema, validateExecutableTraceability, validateGraph, validateNamespaceAuthority, validatePacket, validatePacketMarkdown, validatePacketPrompt, validatePolicyCompatibility, validateReviewResult, validateScenarioPrdLinkIndex, validateScenarioPrdLinks, verifyDigest, writeGraphCache };
