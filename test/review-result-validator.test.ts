import { describe, it, expect } from 'vitest';
import { validateReviewResult } from '../src/review-result-validator.js';
import type { ReviewResult } from '../src/review-result-types.js';

describe('validateReviewResult', () => {
  const validMinimal: ReviewResult = {
    schema_version: '1.0',
    run_id: 'test-run-001',
    status: 'SUCCEEDED',
    decision: 'PASS',
    summary: 'All checks passed.',
  };

  it('accepts a minimal valid result', () => {
    expect(validateReviewResult(validMinimal)).toEqual([]);
  });

  it('accepts a full result with all optional fields', () => {
    const full: ReviewResult = {
      ...validMinimal,
      stage_id: 'review-prd/batch-01',
      attempt: 2,
      outputs: ['runs/test/result.json'],
      warnings: ['Non-blocking warning'],
      blocking_reason: null,
      degradation: null,
      producer: { executor: 'worker', name: 'prd-review-worker', skill: 'artifact-review-prd' },
      evidence: [
        'runs/test/summary.md',
        { type: 'deterministic-result', path: 'runs/test/result.json', status: 'SUCCEEDED', decision: 'PASS' },
      ],
      review: {
        source_files: ['artifacts/prd/features/A1.md'],
        files: ['artifacts/prd/features/A1.md'],
        batches: [{ id: 'batch-01', files: ['artifacts/prd/features/A1.md'], chars: 5000 }],
        metrics: { files_reviewed: 1, findings_count: 0, block_count: 0, warn_count: 0, info_count: 0 },
        findings: [
          { id: 'F-001', severity: 'warn', message: 'Minor issue', status: 'open' },
        ],
        resolved_findings: [],
        repair_worker_needed: false,
      },
      repair: {
        source_review_run_id: 'test-run-001',
        source_review_stage_id: 'review-prd/batch-01',
        findings_addressed: [{ id: 'F-001', severity: 'warn', message: 'Fixed', status: 'resolved', resolved_by: 'repair' }],
        files_modified: ['artifacts/prd/features/A1.md'],
        validation_after_repair: { command: 'artifact-graph validate', exit_code: 0, findings_remaining: 0 },
      },
    };
    expect(validateReviewResult(full)).toEqual([]);
  });

  it('rejects null input', () => {
    const errors = validateReviewResult(null);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].path).toBe('$');
  });

  it('rejects non-object input', () => {
    expect(validateReviewResult('string').length).toBeGreaterThan(0);
    expect(validateReviewResult([1, 2]).length).toBeGreaterThan(0);
  });

  it('rejects wrong schema_version', () => {
    const errors = validateReviewResult({ ...validMinimal, schema_version: '2.0' });
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.schema_version' }));
  });

  it('rejects missing run_id', () => {
    const { run_id, ...rest } = validMinimal;
    const errors = validateReviewResult(rest);
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.run_id' }));
  });

  it('rejects invalid status', () => {
    const errors = validateReviewResult({ ...validMinimal, status: 'UNKNOWN' });
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.status' }));
  });

  it('rejects invalid decision', () => {
    const errors = validateReviewResult({ ...validMinimal, decision: 'MAYBE' });
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.decision' }));
  });

  it('rejects non-string summary', () => {
    const errors = validateReviewResult({ ...validMinimal, summary: 42 });
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.summary' }));
  });

  it('rejects attempt < 1', () => {
    const errors = validateReviewResult({ ...validMinimal, attempt: 0 });
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.attempt' }));
  });

  it('rejects invalid finding severity', () => {
    const result = {
      ...validMinimal,
      review: {
        findings: [{ id: 'F-1', severity: 'critical', message: 'bad' }],
      },
    };
    const errors = validateReviewResult(result);
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.review.findings[0].severity' }));
  });

  it('rejects finding without required fields', () => {
    const result = {
      ...validMinimal,
      review: {
        findings: [{ severity: 'warn' }],
      },
    };
    const errors = validateReviewResult(result);
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.review.findings[0].id' }));
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.review.findings[0].message' }));
  });

  it('rejects evidence object without required fields', () => {
    const result = {
      ...validMinimal,
      evidence: [{ notatype: 'x', notapath: 'y' }],
    };
    const errors = validateReviewResult(result);
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.evidence[0].type' }));
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.evidence[0].path' }));
  });

  it('accepts all valid statuses', () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'BLOCKED', 'NEEDS_INPUT', 'SKIPPED']) {
      expect(validateReviewResult({ ...validMinimal, status })).toEqual([]);
    }
  });

  it('accepts all valid decisions', () => {
    for (const decision of ['PASS', 'FAIL', 'PASS_WITH_RESIDUAL_MINOR', 'BLOCKED', 'NEEDS_INPUT', 'NOT_APPLICABLE']) {
      expect(validateReviewResult({ ...validMinimal, decision })).toEqual([]);
    }
  });

  it('rejects invalid producer executor enum', () => {
    const result = {
      ...validMinimal,
      producer: { executor: 'magic', name: 'test' },
    };
    const errors = validateReviewResult(result);
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.producer.executor' }));
  });

  it('rejects invalid finding status', () => {
    const result = {
      ...validMinimal,
      review: {
        findings: [{ id: 'F-1', severity: 'warn', message: 'test', status: 'invalid_status' }],
      },
    };
    const errors = validateReviewResult(result);
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.review.findings[0].status' }));
  });

  it('rejects evidence item that is neither string nor object', () => {
    const result = {
      ...validMinimal,
      evidence: [42],
    };
    const errors = validateReviewResult(result);
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.evidence[0]' }));
  });

  it('rejects repair.findings_addressed with invalid finding', () => {
    const result = {
      ...validMinimal,
      repair: {
        findings_addressed: [{ id: '', severity: 'warn', message: 'test' }],
      },
    };
    const errors = validateReviewResult(result);
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.repair.findings_addressed[0].id' }));
  });

  it('rejects repair.files_modified with non-string array', () => {
    const result = {
      ...validMinimal,
      repair: {
        files_modified: [123],
      },
    };
    const errors = validateReviewResult(result);
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.repair.files_modified[0]' }));
  });

  it('rejects review.batches with missing id', () => {
    const result = {
      ...validMinimal,
      review: {
        batches: [{ files: ['test.md'] }],
      },
    };
    const errors = validateReviewResult(result);
    expect(errors).toContainEqual(expect.objectContaining({ path: '$.review.batches[0].id' }));
  });

  it.each([
    ['outputs', { outputs: 'not-array' }, '$.outputs'],
    ['warnings', { warnings: [1] }, '$.warnings[0]'],
    ['blocking_reason', { blocking_reason: 1 }, '$.blocking_reason'],
    ['degradation', { degradation: false }, '$.degradation'],
    ['producer array', { producer: [] }, '$.producer'],
    ['producer skill', { producer: { executor: 'cli', name: 'x', skill: 1 } }, '$.producer.skill'],
    ['evidence array', { evidence: 'not-array' }, '$.evidence'],
    ['evidence status', { evidence: [{ type: 'x', path: 'x', status: 1 }] }, '$.evidence[0].status'],
    ['review source_files', { review: { source_files: [1] } }, '$.review.source_files[0]'],
    ['review files', { review: { files: 'not-array' } }, '$.review.files'],
    ['review findings array', { review: { findings: 'not-array' } }, '$.review.findings'],
    ['review resolved_findings array', { review: { resolved_findings: {} } }, '$.review.resolved_findings'],
    ['review batches array', { review: { batches: {} } }, '$.review.batches'],
    ['batch object', { review: { batches: [null] } }, '$.review.batches[0]'],
    ['batch files item', { review: { batches: [{ id: 'b', files: [1] }] } }, '$.review.batches[0].files[0]'],
    ['batch chars', { review: { batches: [{ id: 'b', files: [], chars: 1.5 }] } }, '$.review.batches[0].chars'],
    ['metrics object', { review: { metrics: [] } }, '$.review.metrics'],
    ['metrics integer', { review: { metrics: { files_reviewed: 1.5 } } }, '$.review.metrics.files_reviewed'],
    ['metrics minimum', { review: { metrics: { findings_count: -1 } } }, '$.review.metrics.findings_count'],
    ['repair worker flag', { review: { repair_worker_needed: 'yes' } }, '$.review.repair_worker_needed'],
    ['repair source run', { repair: { source_review_run_id: 1 } }, '$.repair.source_review_run_id'],
    ['repair addressed array', { repair: { findings_addressed: {} } }, '$.repair.findings_addressed'],
    ['repair validation object', { repair: { validation_after_repair: [] } }, '$.repair.validation_after_repair'],
    ['repair exit code', { repair: { validation_after_repair: { exit_code: 1.5 } } }, '$.repair.validation_after_repair.exit_code'],
    ['repair findings remaining', { repair: { validation_after_repair: { findings_remaining: -1 } } }, '$.repair.validation_after_repair.findings_remaining'],
  ])('rejects schema-incompatible %s', (_name, extra, expectedPath) => {
    const errors = validateReviewResult({ ...validMinimal, ...extra });
    expect(errors).toContainEqual(expect.objectContaining({ path: expectedPath }));
  });

  it.each([
    ['category', { category: 1 }, '$.review.findings[0].category'],
    ['location object', { location: [] }, '$.review.findings[0].location'],
    ['location file', { location: { file: 1 } }, '$.review.findings[0].location.file'],
    ['location line', { location: { line: 1.5 } }, '$.review.findings[0].location.line'],
    ['artifact_id', { artifact_id: 1 }, '$.review.findings[0].artifact_id'],
    ['evidence', { evidence: 1 }, '$.review.findings[0].evidence'],
    ['suggested_fix', { suggested_fix: 1 }, '$.review.findings[0].suggested_fix'],
    ['resolved_by', { resolved_by: 1 }, '$.review.findings[0].resolved_by'],
  ])('rejects schema-incompatible finding %s', (_name, extra, expectedPath) => {
    const errors = validateReviewResult({
      ...validMinimal,
      review: { findings: [{ id: 'F-1', severity: 'warn', message: 'x', ...extra }] },
    });
    expect(errors).toContainEqual(expect.objectContaining({ path: expectedPath }));
  });
});
