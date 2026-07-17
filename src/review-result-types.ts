/**
 * Review Result Protocol v1.0 — TypeScript types.
 *
 * Canonical schema: schemas/review-result.schema.json
 * These types are the programmatic equivalent; keep both in sync.
 */

// ── Enums ────────────────────────────────────────────────────────────────────

export type ReviewStatus = 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'NEEDS_INPUT' | 'SKIPPED';
export type ReviewDecision = 'PASS' | 'FAIL' | 'PASS_WITH_RESIDUAL_MINOR' | 'BLOCKED' | 'NEEDS_INPUT' | 'NOT_APPLICABLE';
export type FindingSeverity = 'block' | 'warn' | 'info';
export type FindingStatus = 'open' | 'resolved' | 'accepted' | 'superseded';
export type ExecutorType = 'script' | 'worker' | 'agent' | 'manual' | 'cli';

// ── Finding ──────────────────────────────────────────────────────────────────

export interface FindingLocation {
  file?: string;
  line?: number;
  column?: number;
}

export interface Finding {
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

// ── Evidence ─────────────────────────────────────────────────────────────────

export interface EvidenceObject {
  type: string;
  path: string;
  status?: string;
  decision?: string;
  summary?: string;
  command?: string;
  result?: string;
}

export type Evidence = string | EvidenceObject;

// ── Producer ─────────────────────────────────────────────────────────────────

export interface Producer {
  executor: ExecutorType;
  name: string;
  skill?: string;
}

export interface AcceptanceSourceResult {
  run_id: string;
  stage_id?: string;
  producer: Producer;
}

export interface AcceptanceData {
  reviewer: Producer;
  source_result: AcceptanceSourceResult;
}

// ── Review Data ──────────────────────────────────────────────────────────────

export interface BatchDefinition {
  id: string;
  files: string[];
  chars?: number;
}

export interface ReviewMetrics {
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

export interface ReviewData {
  source_files?: string[];
  files?: string[];
  batches?: BatchDefinition[];
  metrics?: ReviewMetrics;
  findings?: Finding[];
  resolved_findings?: Finding[];
  repair_worker_needed?: boolean;
}

// ── Repair Data ──────────────────────────────────────────────────────────────

export interface RepairValidation {
  command?: string;
  exit_code?: number;
  findings_remaining?: number;
}

export interface RepairData {
  source_review_run_id?: string;
  source_review_stage_id?: string;
  findings_addressed?: Finding[];
  files_modified?: string[];
  validation_after_repair?: RepairValidation;
}

// ── Top-Level Result ─────────────────────────────────────────────────────────

export interface ReviewResult {
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
