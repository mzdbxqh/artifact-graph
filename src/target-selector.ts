/**
 * target-selector.ts
 *
 * Unified target selector for the artifact-graph CLI.
 * Parses `--target <type>:<id>` and resolves from legacy flags,
 * enforcing mutual exclusivity between the two forms.
 */
import type { ArtifactSchema, ArtifactTarget } from './index.js';
import { getTargetArtifactTypes } from './index.js';

// ── Parsing ──

/**
 * Parse a `<type>:<id>` selector string, splitting only on the first colon.
 * Colons within the ID portion are preserved (e.g. `e2e_test:batch:TC-001` → `{ type: 'e2e_test', id: 'batch:TC-001' }`).
 */
export function parseTargetSelector(value: string): ArtifactTarget {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('target must use <type>:<id>');
  }
  return { type: value.slice(0, separator), id: value.slice(separator + 1) };
}

// ── CLI resolution ──

/** Names of the five legacy target flags. */
const LEGACY_FLAGS = ['feature', 'scenario', 'decision', 'design', 'e2e-test'] as const;

/** Map from CLI flag name to artifact type. */
const LEGACY_FLAG_TO_TYPE: Record<string, string> = {
  feature: 'feature',
  scenario: 'scenario',
  decision: 'decision',
  design: 'design',
  'e2e-test': 'e2e_test',
};

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
export function resolveCliTarget(
  flags: Record<string, string | boolean>,
  schema: ArtifactSchema,
): ArtifactTarget {
  const hasTarget = typeof flags.target === 'string';
  const legacyEntries = LEGACY_FLAGS
    .filter((flag) => typeof flags[flag] === 'string')
    .map((flag) => flag);

  // Mutual exclusivity
  if (hasTarget && legacyEntries.length > 0) {
    throw new Error(
      `互斥：--target 与 --${legacyEntries[0]} 不能同时使用`,
    );
  }

  if (hasTarget) {
    const target = parseTargetSelector(flags.target as string);
    // Validate target type is registered and target-capable
    const targetTypes = getTargetArtifactTypes(schema);
    if (!(targetTypes as string[]).includes(target.type)) {
      throw new Error(
        `类型 "${target.type}" 不是合法的 target 类型或未启用 target: true。合法类型: ${targetTypes.join(', ')}`,
      );
    }
    return target;
  }

  if (legacyEntries.length > 1) {
    throw new Error(
      `互斥：--${legacyEntries[0]} 与 --${legacyEntries[1]} 不能同时使用`,
    );
  }

  if (legacyEntries.length === 1) {
    const flag = legacyEntries[0];
    const type = LEGACY_FLAG_TO_TYPE[flag];
    return { type, id: flags[flag] as string };
  }

  throw new Error(
    '未指定 target：请使用 --target <type>:<id> 或 --feature/--scenario/--decision/--design/--e2e-test <id>',
  );
}
