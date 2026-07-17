// @feature ACA16
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateReviewResult } from '../src/review-result-validator.js';

const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, '../schemas/review-result.schema.json'), 'utf8'));
const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(schema);

const valid = {
  schema_version: '1.0',
  run_id: 'review-run-001',
  status: 'SUCCEEDED',
  decision: 'PASS',
  summary: 'Accepted.',
  producer: { executor: 'worker', name: 'review-worker', skill: 'artifact-review' },
};
const { producer: _producer, ...withoutProducer } = valid;

function schemaAccepts(value: unknown): boolean {
  return validateSchema(value) === true;
}

function semanticAccepts(value: unknown): boolean {
  return validateReviewResult(value).length === 0;
}

describe('public Review Result JSON Schema and TypeScript validator consistency', () => {
  it.each([
    ['valid PASS', valid, true],
    ['PASS without producer', withoutProducer, false],
    ['PASS with open block', {
      ...valid,
      review: { findings: [{ id: 'F-1', severity: 'block', message: 'open', status: 'open' }] },
    }, false],
    ['PASS_WITH_RESIDUAL_MINOR with implicit-open block', {
      ...valid,
      decision: 'PASS_WITH_RESIDUAL_MINOR',
      review: { findings: [{ id: 'F-1', severity: 'block', message: 'open' }] },
    }, false],
    ['attempt 4', { ...valid, attempt: 4 }, false],
    ['unknown top-level field', { ...valid, verdict: 'pass' }, false],
  ])('%s has the same public-schema and semantic-validator result', (_name, fixture, accepted) => {
    expect(schemaAccepts(fixture)).toBe(accepted);
    expect(semanticAccepts(fixture)).toBe(accepted);
  });

  it('rejects self-acceptance when executor+name match even if skill metadata differs', () => {
    const fixture = {
      ...valid,
      producer: { executor: 'worker', name: 'same-worker', skill: 'artifact-review' },
      acceptance: {
        reviewer: { executor: 'worker', name: 'same-worker', skill: 'artifact-review' },
        source_result: {
          run_id: 'repair-run-001',
          producer: { executor: 'worker', name: 'same-worker', skill: 'artifact-repair' },
        },
      },
    };
    expect(schemaAccepts(fixture)).toBe(true);
    expect(semanticAccepts(fixture)).toBe(false);
  });
});
