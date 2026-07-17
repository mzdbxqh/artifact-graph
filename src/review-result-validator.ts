// @feature ACA16 @scenario S-46
/**
 * Review Result Protocol validator.
 *
 * Validates a JSON object against the review-result.schema.json constraints.
 * Does NOT use ajv or any JSON-schema library — pure deterministic checks
 * for zero-dependency CLI use.
 */

import type { Finding, ReviewResult, ReviewStatus, ReviewDecision, FindingSeverity, FindingStatus } from './review-result-types.js';

const VALID_STATUSES: ReadonlySet<string> = new Set<ReviewStatus>([
  'SUCCEEDED', 'FAILED', 'BLOCKED', 'NEEDS_INPUT', 'SKIPPED',
]);

const VALID_DECISIONS: ReadonlySet<string> = new Set<ReviewDecision>([
  'PASS', 'FAIL', 'PASS_WITH_RESIDUAL_MINOR', 'BLOCKED', 'NEEDS_INPUT', 'NOT_APPLICABLE',
]);

const VALID_SEVERITIES: ReadonlySet<string> = new Set<FindingSeverity>(['block', 'warn', 'info']);
const VALID_FINDING_STATUSES: ReadonlySet<string> = new Set<FindingStatus>(['open', 'resolved', 'accepted', 'superseded']);
const VALID_EXECUTORS: ReadonlySet<string> = new Set<string>(['script', 'worker', 'agent', 'manual', 'cli']);
const TOP_LEVEL_FIELDS = new Set([
  'schema_version', 'run_id', 'stage_id', 'attempt', 'status', 'decision', 'summary',
  'outputs', 'warnings', 'blocking_reason', 'degradation', 'producer', 'acceptance',
  'evidence', 'review', 'repair',
]);

export interface ValidationError {
  path: string;
  message: string;
}

/**
 * Validate a review result object against the v1.0 protocol.
 *
 * @param input - Parsed JSON to validate (not a string).
 * @returns Array of validation errors. Empty = valid.
 */
export function validateReviewResult(input: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [{ path: '$', message: 'Root must be a non-null object' }];
  }

  const obj = input as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!TOP_LEVEL_FIELDS.has(key)) {
      errors.push({ path: `$.${key}`, message: 'Unknown top-level property' });
    }
  }

  // ── Required fields ──────────────────────────────────────────────────────

  if (obj.schema_version !== '1.0') {
    errors.push({ path: '$.schema_version', message: `Must be "1.0", got ${JSON.stringify(obj.schema_version)}` });
  }

  if (typeof obj.run_id !== 'string' || obj.run_id.length === 0) {
    errors.push({ path: '$.run_id', message: 'Must be a non-empty string' });
  }

  if (!VALID_STATUSES.has(String(obj.status))) {
    errors.push({ path: '$.status', message: `Must be one of ${[...VALID_STATUSES].join(', ')}, got ${JSON.stringify(obj.status)}` });
  }

  if (!VALID_DECISIONS.has(String(obj.decision))) {
    errors.push({ path: '$.decision', message: `Must be one of ${[...VALID_DECISIONS].join(', ')}, got ${JSON.stringify(obj.decision)}` });
  }

  if (typeof obj.summary !== 'string') {
    errors.push({ path: '$.summary', message: 'Must be a string' });
  }

  // ── Optional typed fields ────────────────────────────────────────────────

  if (obj.stage_id !== undefined && typeof obj.stage_id !== 'string') {
    errors.push({ path: '$.stage_id', message: 'Must be a string if present' });
  }

  if (obj.attempt !== undefined && (!Number.isInteger(obj.attempt) || (obj.attempt as number) < 1 || (obj.attempt as number) > 3)) {
    errors.push({ path: '$.attempt', message: 'Must be an integer from 1 through 3 if present' });
  }

  if (obj.outputs !== undefined) {
    checkStringArray(obj.outputs, '$.outputs', errors);
  }

  if (obj.warnings !== undefined) {
    checkStringArray(obj.warnings, '$.warnings', errors);
  }

  checkOptionalNullableString(obj.blocking_reason, '$.blocking_reason', errors);
  checkOptionalNullableString(obj.degradation, '$.degradation', errors);

  // ── Producer ─────────────────────────────────────────────────────────────

  if (obj.producer !== undefined) {
    validateProducer(obj.producer, '$.producer', errors);
  }

  const successfulAcceptance = obj.status === 'SUCCEEDED'
    && (obj.decision === 'PASS' || obj.decision === 'PASS_WITH_RESIDUAL_MINOR');
  if (successfulAcceptance && obj.producer === undefined) {
    errors.push({ path: '$.producer', message: 'Successful acceptance requires producer identity' });
  }

  if (obj.acceptance !== undefined) {
    validateAcceptance(obj.acceptance, obj.producer, '$.acceptance', errors);
  }

  // ── Evidence ─────────────────────────────────────────────────────────────

  if (obj.evidence !== undefined) {
    if (!Array.isArray(obj.evidence)) {
      errors.push({ path: '$.evidence', message: 'Must be an array' });
    } else for (let i = 0; i < obj.evidence.length; i++) {
      const e = obj.evidence[i];
      if (typeof e === 'string') continue;
      if (isPlainObject(e)) {
        const ev = e;
        if (typeof ev.type !== 'string') {
          errors.push({ path: `$.evidence[${i}].type`, message: 'Must be a string' });
        }
        if (typeof ev.path !== 'string') {
          errors.push({ path: `$.evidence[${i}].path`, message: 'Must be a string' });
        }
        for (const key of ['status', 'decision', 'summary', 'command', 'result']) {
          checkOptionalString(ev[key], `$.evidence[${i}].${key}`, errors);
        }
      } else {
        errors.push({ path: `$.evidence[${i}]`, message: 'Must be a string or object' });
      }
    }
  }

  // ── Review ───────────────────────────────────────────────────────────────

  if (obj.review !== undefined) {
    validateReviewData(obj.review, '$.review', errors);
    if (obj.decision === 'PASS' || obj.decision === 'PASS_WITH_RESIDUAL_MINOR') {
      const findings = isPlainObject(obj.review) && Array.isArray(obj.review.findings) ? obj.review.findings : [];
      findings.forEach((finding, index) => {
        if (isPlainObject(finding) && finding.severity === 'block' && (finding.status === undefined || finding.status === 'open')) {
          errors.push({
            path: `$.review.findings[${index}]`,
            message: `${obj.decision} cannot contain an open block finding`,
          });
        }
      });
    }
  }

  // ── Repair ───────────────────────────────────────────────────────────────

  if (obj.repair !== undefined) {
    if (!isPlainObject(obj.repair)) {
      errors.push({ path: '$.repair', message: 'Must be an object' });
    } else {
      const r = obj.repair;
      checkOptionalString(r.source_review_run_id, '$.repair.source_review_run_id', errors);
      checkOptionalString(r.source_review_stage_id, '$.repair.source_review_stage_id', errors);
      if (r.findings_addressed !== undefined) {
        validateFindingArray(r.findings_addressed, '$.repair.findings_addressed', errors);
      }
      if (r.files_modified !== undefined) {
        checkStringArray(r.files_modified, '$.repair.files_modified', errors);
      }
      if (r.validation_after_repair !== undefined) {
        validateRepairValidation(r.validation_after_repair, '$.repair.validation_after_repair', errors);
      }
    }
  }

  return errors;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function checkStringArray(val: unknown, path: string, errors: ValidationError[]): void {
  if (!Array.isArray(val)) {
    errors.push({ path, message: 'Must be an array' });
    return;
  }
  for (let i = 0; i < val.length; i++) {
    if (typeof val[i] !== 'string') {
      errors.push({ path: `${path}[${i}]`, message: 'Must be a string' });
    }
  }
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function validateProducer(val: unknown, path: string, errors: ValidationError[]): void {
  if (!isPlainObject(val)) {
    errors.push({ path, message: 'Must be an object' });
    return;
  }
  if (typeof val.executor !== 'string') {
    errors.push({ path: `${path}.executor`, message: 'Must be a string' });
  } else if (!VALID_EXECUTORS.has(val.executor)) {
    errors.push({ path: `${path}.executor`, message: `Must be one of ${[...VALID_EXECUTORS].join(', ')}; got ${JSON.stringify(val.executor)}` });
  }
  if (typeof val.name !== 'string' || val.name.length === 0) {
    errors.push({ path: `${path}.name`, message: 'Must be a non-empty string' });
  }
  checkOptionalString(val.skill, `${path}.skill`, errors);
}

function producerIdentity(val: Record<string, unknown>): string {
  return JSON.stringify([val.executor, val.name]);
}

function validateAcceptance(val: unknown, resultProducer: unknown, path: string, errors: ValidationError[]): void {
  if (!isPlainObject(val)) {
    errors.push({ path, message: 'Must be an object' });
    return;
  }
  validateProducer(val.reviewer, `${path}.reviewer`, errors);
  if (!isPlainObject(val.source_result)) {
    errors.push({ path: `${path}.source_result`, message: 'Must be an object' });
    return;
  }
  const source = val.source_result;
  if (typeof source.run_id !== 'string' || source.run_id.length === 0) {
    errors.push({ path: `${path}.source_result.run_id`, message: 'Must be a non-empty string' });
  }
  checkOptionalString(source.stage_id, `${path}.source_result.stage_id`, errors);
  validateProducer(source.producer, `${path}.source_result.producer`, errors);

  if (isPlainObject(val.reviewer) && isPlainObject(resultProducer)
    && producerIdentity(val.reviewer) !== producerIdentity(resultProducer)) {
    errors.push({ path: `${path}.reviewer`, message: 'Acceptance reviewer must match the result producer' });
  }
  if (isPlainObject(val.reviewer) && isPlainObject(source.producer)
    && producerIdentity(val.reviewer) === producerIdentity(source.producer)) {
    errors.push({ path: `${path}.reviewer`, message: 'Repair producer cannot accept its own result' });
  }
}

function checkOptionalString(val: unknown, path: string, errors: ValidationError[]): void {
  if (val !== undefined && typeof val !== 'string') {
    errors.push({ path, message: 'Must be a string if present' });
  }
}

function checkOptionalNullableString(val: unknown, path: string, errors: ValidationError[]): void {
  if (val !== undefined && val !== null && typeof val !== 'string') {
    errors.push({ path, message: 'Must be a string or null if present' });
  }
}

function checkOptionalInteger(val: unknown, path: string, errors: ValidationError[], minimum?: number): void {
  if (val === undefined) return;
  if (!Number.isInteger(val) || (minimum !== undefined && (val as number) < minimum)) {
    errors.push({ path, message: minimum === undefined ? 'Must be an integer if present' : `Must be an integer >= ${minimum} if present` });
  }
}

function validateFinding(val: unknown, path: string, errors: ValidationError[]): void {
  if (!isPlainObject(val)) {
    errors.push({ path, message: 'Must be a non-null object' });
    return;
  }
  const f = val as Record<string, unknown>;
  if (typeof f.id !== 'string' || f.id.length === 0) {
    errors.push({ path: `${path}.id`, message: 'Must be a non-empty string' });
  }
  if (!VALID_SEVERITIES.has(String(f.severity))) {
    errors.push({ path: `${path}.severity`, message: `Must be one of block, warn, info; got ${JSON.stringify(f.severity)}` });
  }
  if (typeof f.message !== 'string') {
    errors.push({ path: `${path}.message`, message: 'Must be a string' });
  }
  if (f.status !== undefined && !VALID_FINDING_STATUSES.has(String(f.status))) {
    errors.push({ path: `${path}.status`, message: `Must be one of ${[...VALID_FINDING_STATUSES].join(', ')}; got ${JSON.stringify(f.status)}` });
  }
  for (const key of ['category', 'artifact_id', 'evidence', 'suggested_fix', 'resolved_by']) {
    checkOptionalString(f[key], `${path}.${key}`, errors);
  }
  if (f.location !== undefined) {
    if (!isPlainObject(f.location)) {
      errors.push({ path: `${path}.location`, message: 'Must be an object if present' });
    } else {
      checkOptionalString(f.location.file, `${path}.location.file`, errors);
      checkOptionalInteger(f.location.line, `${path}.location.line`, errors);
      checkOptionalInteger(f.location.column, `${path}.location.column`, errors);
    }
  }
}

function validateFindingArray(val: unknown, path: string, errors: ValidationError[]): void {
  if (!Array.isArray(val)) {
    errors.push({ path, message: 'Must be an array' });
    return;
  }
  for (let i = 0; i < val.length; i++) validateFinding(val[i], `${path}[${i}]`, errors);
}

function validateReviewData(val: unknown, path: string, errors: ValidationError[]): void {
  if (!isPlainObject(val)) {
    errors.push({ path, message: 'Must be a non-null object' });
    return;
  }
  const r = val;
  if (r.source_files !== undefined) checkStringArray(r.source_files, `${path}.source_files`, errors);
  if (r.files !== undefined) checkStringArray(r.files, `${path}.files`, errors);
  if (r.findings !== undefined) validateFindingArray(r.findings, `${path}.findings`, errors);
  if (r.resolved_findings !== undefined) validateFindingArray(r.resolved_findings, `${path}.resolved_findings`, errors);
  if (r.batches !== undefined) validateBatches(r.batches, `${path}.batches`, errors);
  if (r.metrics !== undefined) validateMetrics(r.metrics, `${path}.metrics`, errors);
  if (r.repair_worker_needed !== undefined && typeof r.repair_worker_needed !== 'boolean') {
    errors.push({ path: `${path}.repair_worker_needed`, message: 'Must be a boolean if present' });
  }
}

function validateBatches(val: unknown, path: string, errors: ValidationError[]): void {
  if (!Array.isArray(val)) {
    errors.push({ path, message: 'Must be an array' });
    return;
  }
  for (let i = 0; i < val.length; i++) {
    const itemPath = `${path}[${i}]`;
    const b = val[i];
    if (!isPlainObject(b)) {
      errors.push({ path: itemPath, message: 'Must be an object' });
      continue;
    }
    if (typeof b.id !== 'string') errors.push({ path: `${itemPath}.id`, message: 'Must be a string' });
    checkStringArray(b.files, `${itemPath}.files`, errors);
    checkOptionalInteger(b.chars, `${itemPath}.chars`, errors);
  }
}

const METRIC_FIELDS = [
  'files_reviewed', 'files_scanned', 'findings_count', 'deterministic_findings_count',
  'semantic_findings_count', 'block_count', 'warn_count', 'info_count',
  'resolved_count', 'batch_count', 'scenario_count',
] as const;

function validateMetrics(val: unknown, path: string, errors: ValidationError[]): void {
  if (!isPlainObject(val)) {
    errors.push({ path, message: 'Must be an object' });
    return;
  }
  for (const key of METRIC_FIELDS) checkOptionalInteger(val[key], `${path}.${key}`, errors, 0);
}

function validateRepairValidation(val: unknown, path: string, errors: ValidationError[]): void {
  if (!isPlainObject(val)) {
    errors.push({ path, message: 'Must be an object' });
    return;
  }
  checkOptionalString(val.command, `${path}.command`, errors);
  checkOptionalInteger(val.exit_code, `${path}.exit_code`, errors);
  checkOptionalInteger(val.findings_remaining, `${path}.findings_remaining`, errors, 0);
}
