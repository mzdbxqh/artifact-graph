// @feature ACA17
import { readFile } from 'node:fs/promises';
import { existsSync, globSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateReviewResult } from '../src/review-result-validator.js';

const skillsRoot = resolve(import.meta.dirname, '../../../plugins/artifact-chain-assistant/skills-src');
const hasSkillsRoot = existsSync(skillsRoot);

function fencedJson(content: string): unknown[] {
  return [...content.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
}

describe.skipIf(!hasSkillsRoot)('Review Result examples in public skills', () => {
  it('parses every JSON fence and validates every result-shaped example with the real validator', async () => {
    for (const path of globSync(join(skillsRoot, '**/*.md'))) {
      const examples = fencedJson(await readFile(path, 'utf8'));
      for (const example of examples) {
        if (typeof example !== 'object' || example === null || Array.isArray(example)) continue;
        const object = example as Record<string, unknown>;
        if (object.schema_version === '1.0') {
          expect(validateReviewResult(object), `${path} Review Result example`).toEqual([]);
        }
        if (typeof object.input_result === 'object' && object.input_result !== null) {
          expect(validateReviewResult(object.input_result), `${path} input_result`).toEqual([]);
        }
      }
    }
  });

  it.each(['prd-feature/repair', 'scenario-script/repair', 'artifact-repair'])(
    '%s passes a complete validated review result into repair',
    async (skill) => {
      const examples = fencedJson(await readFile(join(skillsRoot, skill, 'SKILL.md'), 'utf8'));
      const task = examples.find((example) => typeof example === 'object' && example !== null
        && (example as Record<string, unknown>).intent === 'repair') as Record<string, unknown>;
      expect(task).toBeDefined();
      expect(validateReviewResult(task.input_result)).toEqual([]);
    },
  );
});
