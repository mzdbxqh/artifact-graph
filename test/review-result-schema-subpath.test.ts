// @feature ACA16 @decision D-ACA-16
//
// RED phase: prove that package.json exports does NOT include
// "./schemas/review-result.schema.json".
// GREEN phase (after modifying exports): prove that the file exists,
// is valid JSON, and is a well-formed JSON Schema.

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function readPackageJson() {
  const raw = await readFile(resolve(packageRoot, 'package.json'), 'utf-8');
  return JSON.parse(raw);
}

async function readSchema() {
  const raw = await readFile(
    resolve(packageRoot, 'schemas/review-result.schema.json'),
    'utf-8',
  );
  return JSON.parse(raw);
}

describe('Review Result schema subpath export', () => {
  // ── RED: prove the subpath is currently absent ──
  it('RED: package.json exports includes ./schemas/review-result.schema.json', async () => {
    const pkg = await readPackageJson();
    const subpath = './schemas/review-result.schema.json';
    expect(pkg.exports).toBeDefined();
    expect(
      pkg.exports[subpath],
      `exports["${subpath}"] is missing — add it to enable consumer import`,
    ).toBeDefined();
  });

  // ── GREEN: prove the schema file exists and is well-formed ──
  it('GREEN: schema file is valid JSON with $schema and $id', async () => {
    const schema = await readSchema();
    expect(schema['$schema']).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema['$id']).toContain('review-result');
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('schema_version');
    expect(schema.required).toContain('run_id');
    expect(schema.required).toContain('status');
  });
});
