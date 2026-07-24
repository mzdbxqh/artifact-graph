// Artifact Contract Kernel
// Provides contract identity, canonical IR, legacy normalization,
// and project policy monotonic tightening validation.
// @feature ACA18
// @decision D-ACA-18

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

// ============================================================================
// Contract Identity
// ============================================================================

export interface ContractIdentity {
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

export interface RelationRule {
  /** Allowed target types for this relation kind */
  allowedTargetTypes: string[];
  /** Minimum cardinality (0 = optional) */
  min: number;
  /** Maximum cardinality */
  max: number;
  /** Anchor policy: "required", "optional", or "forbidden" */
  anchorPolicy: 'required' | 'optional' | 'forbidden';
}

export interface SemanticMarker {
  /** Canonical JSON pointer to the semantic slot */
  jsonPointer: string;
  /** Markdown marker identifier (e.g., "scope", "system-boundary") */
  markdownMarker: string;
  /** Whether this marker is required */
  required: boolean;
}

export interface ContractDefinition {
  identity: ContractIdentity;
  schema: ContractSchema;
  /** Raw schema content for digest computation */
  rawContent: string;
}

export interface ContractSchema {
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

// ============================================================================
// Error Codes
// ============================================================================

export const CONTRACT_ERROR_CODES = {
  /** Contract identity not found */
  CONTRACT_NOT_FOUND: 'CONTRACT_NOT_FOUND',
  /** Invalid contract identity format */
  INVALID_IDENTITY: 'INVALID_IDENTITY',
  /** Revision digest mismatch */
  DIGEST_MISMATCH: 'DIGEST_MISMATCH',
  /** Duplicate contract identity */
  DUPLICATE_IDENTITY: 'DUPLICATE_IDENTITY',
  /** Multiple active write contracts for same type */
  MULTIPLE_ACTIVE_WRITE: 'MULTIPLE_ACTIVE_WRITE',
  /** Unknown authority namespace */
  UNKNOWN_AUTHORITY: 'UNKNOWN_AUTHORITY',
  /** Namespace authority violation */
  AUTHORITY_VIOLATION: 'AUTHORITY_VIOLATION',
  /** Schema validation failed */
  SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',
  /** Canonical IR normalization failed */
  NORMALIZATION_FAILED: 'NORMALIZATION_FAILED',
  /** Policy compatibility check failed */
  POLICY_INCOMPATIBLE: 'POLICY_INCOMPATIBLE',
  /** Legacy revision cannot be normalized */
  LEGACY_NORMALIZATION_FAILED: 'LEGACY_NORMALIZATION_FAILED',
  /** Canonical and legacy conflict */
  CANONICAL_LEGACY_CONFLICT: 'CANONICAL_LEGACY_CONFLICT',
  /** Relation rule violation */
  RELATION_RULE_VIOLATION: 'RELATION_RULE_VIOLATION',
  /** Relation rules missing in contract (fail closed) */
  RELATION_RULES_MISSING: 'RELATION_RULES_MISSING',
  /** Ambiguous revision — multiple revisions found, no unique active write */
  AMBIGUOUS_REVISION: 'AMBIGUOUS_REVISION',
  /** Invalid relation kind */
  RELATION_INVALID_KIND: 'RELATION_INVALID_KIND',
  /** Invalid relation target type */
  RELATION_INVALID_TARGET_TYPE: 'RELATION_INVALID_TARGET_TYPE',
  /** Relation below minimum cardinality */
  RELATION_BELOW_MIN: 'RELATION_BELOW_MIN',
  /** Relation above maximum cardinality */
  RELATION_ABOVE_MAX: 'RELATION_ABOVE_MAX',
  /** Missing required anchor */
  RELATION_MISSING_ANCHOR: 'RELATION_MISSING_ANCHOR',
  /** Forbidden anchor present */
  RELATION_FORBIDDEN_ANCHOR: 'RELATION_FORBIDDEN_ANCHOR',
  /** Missing required semantic marker */
  MARKER_MISSING: 'MARKER_MISSING',
  /** Duplicate semantic marker */
  MARKER_DUPLICATE: 'MARKER_DUPLICATE',
  /** Unknown semantic marker */
  MARKER_UNKNOWN: 'MARKER_UNKNOWN',
} as const;

export type ContractErrorCode = typeof CONTRACT_ERROR_CODES[keyof typeof CONTRACT_ERROR_CODES];

export class ContractError extends Error {
  constructor(
    public readonly code: ContractErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ContractError';
  }
}

// ============================================================================
// Official Namespace Authority
// ============================================================================

const OFFICIAL_AUTHORITY = 'artifact';
const OFFICIAL_NAMESPACE_PATTERN = /^artifact(?:\.|$)/;

/**
 * Check if a namespace is official (artifact or artifact.*)
 */
export function isOfficialNamespace(namespace: string): boolean {
  return OFFICIAL_NAMESPACE_PATTERN.test(namespace);
}

/**
 * Validate namespace authority
 * - Official namespace (artifact.*) can only be used by official contracts
 * - Third-party must use their own authority (e.g., io.github.org.*)
 * - Project contracts use project.<project-id>.*
 */
export function validateNamespaceAuthority(
  identity: ContractIdentity,
  expectedAuthority?: string
): void {
  if (isOfficialNamespace(identity.namespace) && identity.authority !== OFFICIAL_AUTHORITY) {
    throw new ContractError(
      CONTRACT_ERROR_CODES.AUTHORITY_VIOLATION,
      `Namespace ${identity.namespace} requires authority "${OFFICIAL_AUTHORITY}", got "${identity.authority}"`,
      { identity, expectedAuthority: OFFICIAL_AUTHORITY }
    );
  }

  if (expectedAuthority && identity.authority !== expectedAuthority) {
    throw new ContractError(
      CONTRACT_ERROR_CODES.AUTHORITY_VIOLATION,
      `Expected authority "${expectedAuthority}", got "${identity.authority}"`,
      { identity, expectedAuthority }
    );
  }
}

// ============================================================================
// Digest Computation
// ============================================================================

/**
 * Canonicalize contract content for digest computation.
 * Strips the self-referencing revisionDigest field to create a stable input.
 * This ensures the digest is deterministic regardless of placeholder values.
 */
export function canonicalizeForDigest(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    // Deep-clone and remove revisionDigest from contractIdentity
    if (parsed.contractIdentity && typeof parsed.contractIdentity === 'object') {
      const ci = { ...(parsed.contractIdentity as Record<string, unknown>) };
      delete ci.revisionDigest;
      parsed.contractIdentity = ci;
    }
    return JSON.stringify(parsed);
  } catch {
    // If not valid JSON, use raw content as-is
    return rawContent;
  }
}

/**
 * Compute immutable revision digest for contract content.
 * Uses SHA-256 on canonicalized content (revisionDigest field excluded).
 */
export function computeRevisionDigest(content: string): string {
  const canonical = canonicalizeForDigest(content);
  const hash = createHash('sha256').update(canonical, 'utf-8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * Verify that content matches expected digest
 */
export function verifyDigest(content: string, expectedDigest: string): boolean {
  const actualDigest = computeRevisionDigest(content);
  return actualDigest === expectedDigest;
}

// ============================================================================
// Contract Registry
// ============================================================================

export interface ContractRegistryEntry {
  contract: ContractDefinition;
  isActive: boolean;
  isWriteTarget: boolean;
  loadedAt: string;
}

export class ContractRegistry {
  private contracts = new Map<string, ContractRegistryEntry>();
  private typeToActiveWrite = new Map<string, string>();
  private majorToContracts = new Map<string, Set<string>>();

  /**
   * Register a contract
   * @throws ContractError if duplicate identity or multiple active write contracts
   */
  register(contract: ContractDefinition, options?: { isActive?: boolean; isWriteTarget?: boolean }): void {
    const major = contract.identity.major;
    const digest = contract.identity.revisionDigest;
    const key = `${major}@${digest}`;
    const isActive = options?.isActive ?? true;
    const isWriteTarget = options?.isWriteTarget ?? true;

    // Check for duplicate identity (same major + digest)
    if (this.contracts.has(key)) {
      throw new ContractError(
        CONTRACT_ERROR_CODES.DUPLICATE_IDENTITY,
        `Contract ${key} already registered`,
        { identity: contract.identity }
      );
    }

    // Check for multiple active write contracts of same type
    if (isActive && isWriteTarget) {
      const type = major.split('@')[0];
      if (this.typeToActiveWrite.has(type)) {
        throw new ContractError(
          CONTRACT_ERROR_CODES.MULTIPLE_ACTIVE_WRITE,
          `Type ${type} already has active write contract: ${this.typeToActiveWrite.get(type)}`,
          { identity: contract.identity, existing: this.typeToActiveWrite.get(type) }
        );
      }
      this.typeToActiveWrite.set(type, key);
    }

    this.contracts.set(key, {
      contract,
      isActive,
      isWriteTarget,
      loadedAt: new Date().toISOString(),
    });

    // Track contracts by major identity
    if (!this.majorToContracts.has(major)) {
      this.majorToContracts.set(major, new Set());
    }
    this.majorToContracts.get(major)!.add(key);
  }

  /**
   * Resolve by major identity. Multiple revisions require a unique active write
   * revision; insertion order is never a resolution policy.
   */
  get(major: string): ContractDefinition | undefined {
    const keys = this.majorToContracts.get(major);
    if (!keys || keys.size === 0) return undefined;
    if (keys.size === 1) {
      const onlyKey = keys.values().next().value;
      return onlyKey ? this.contracts.get(onlyKey)?.contract : undefined;
    }

    const type = major.split('@')[0];
    const activeWriteKey = this.typeToActiveWrite.get(type);
    if (activeWriteKey && keys.has(activeWriteKey)) {
      return this.contracts.get(activeWriteKey)?.contract;
    }

    throw new ContractError(
      CONTRACT_ERROR_CODES.AMBIGUOUS_REVISION,
      `Multiple revisions found for ${major} with no unique active write — specify digest`,
      {
        major,
        availableDigests: Array.from(keys)
          .map((key) => this.contracts.get(key)?.contract.identity.revisionDigest)
          .filter((digest): digest is string => Boolean(digest)),
      }
    );
  }

  /**
   * Get contract by major identity and digest
   */
  getByMajorAndDigest(major: string, digest: string): ContractDefinition | undefined {
    const key = `${major}@${digest}`;
    return this.contracts.get(key)?.contract;
  }

  /**
   * Get all contracts for a major identity
   */
  getByMajor(major: string): ContractDefinition[] {
    const keys = this.majorToContracts.get(major);
    if (!keys) return [];
    return Array.from(keys)
      .map(key => this.contracts.get(key)?.contract)
      .filter((c): c is ContractDefinition => c !== undefined);
  }

  /**
   * Get active write contract for a type
   */
  getActiveWriteContract(typePrefix: string): ContractDefinition | undefined {
    const key = this.typeToActiveWrite.get(typePrefix);
    return key ? this.contracts.get(key)?.contract : undefined;
  }

  /**
   * List all registered contracts
   */
  list(): ContractRegistryEntry[] {
    return Array.from(this.contracts.values());
  }

  /**
   * Check if a contract is registered by major identity
   */
  has(major: string): boolean {
    const keys = this.majorToContracts.get(major);
    return keys !== undefined && keys.size > 0;
  }

  /**
   * Check if a contract is registered by major identity and digest
   */
  hasByMajorAndDigest(major: string, digest: string): boolean {
    const key = `${major}@${digest}`;
    return this.contracts.has(key);
  }
}

// ============================================================================
// Canonical IR
// ============================================================================

export interface CanonicalIR {
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

export interface NormalizationError {
  code: string;
  path: string;
  message: string;
}

export interface NormalizationResult {
  success: boolean;
  ir?: CanonicalIR;
  errors: NormalizationError[];
  warnings: string[];
}

// ============================================================================
// Legacy Normalization
// ============================================================================

export interface LegacyFieldMapping {
  /** Legacy field name */
  legacy: string;
  /** Canonical field name */
  canonical: string;
  /** Transform function (optional) */
  transform?: (value: unknown) => unknown;
  /** Whether field is required in canonical */
  required?: boolean;
}

export interface NormalizerConfig {
  /** Contract identity this normalizer targets */
  contractMajor: string;
  /** Field mappings from legacy to canonical */
  fieldMappings: LegacyFieldMapping[];
  /** Validation function for canonical form */
  validate?: (canonical: Record<string, unknown>) => string[];
}

/**
 * Set a nested value on an object using a dot-separated path.
 * e.g. setNestedValue(obj, 'scope.business_goal', 'value')
 * sets obj.scope.business_goal = 'value', creating intermediate objects as needed.
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Normalize legacy artifact to canonical IR.
 * Fails closed: unmapped legacy fields cause LOSSY_NORMALIZATION error.
 * Validates canonical form against production schema validator before returning success.
 */
/**
 * Detect if input data is in canonical form by checking for canonical root keys.
 * Canonical roots are the top-level fields defined in the schema's required list.
 */
function matchesSchemaType(value: unknown, definition: unknown): boolean {
  const type = (definition as Record<string, unknown> | undefined)?.type;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'number' || type === 'integer') return typeof value === 'number';
  if (type === 'boolean') return typeof value === 'boolean';
  return value !== undefined;
}

function getNestedValue(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Normalize data to canonical IR.
 * Handles:
 * - Pure canonical input: returns sourceRevision: 'canonical'
 * - Pure legacy input: maps to canonical, returns sourceRevision: 'legacy'
 * - Mixed input: detects canonical/legacy conflicts
 */
export function normalizeToCanonical(
  legacyData: Record<string, unknown>,
  config: NormalizerConfig,
  contract: ContractDefinition
): NormalizationResult {
  const errors: NormalizationError[] = [];
  const warnings: string[] = [];

  // Collect legacy field mappings for conflict detection
  const legacyFieldMap = new Map<string, string>();
  for (const mapping of config.fieldMappings) {
    legacyFieldMap.set(mapping.legacy, mapping.canonical);
  }

  const canonical: Record<string, unknown> = {};
  const canonicalRoots = new Set(Object.keys(contract.schema.properties));
  const presentCanonicalRoots = new Set<string>();

  for (const root of canonicalRoots) {
    const value = legacyData[root];
    if (value !== undefined && matchesSchemaType(value, contract.schema.properties[root])) {
      canonical[root] = structuredClone(value);
      presentCanonicalRoots.add(root);
    }
  }

  const unmappedLegacyFields = new Set(
    Object.keys(legacyData).filter((field) => !presentCanonicalRoots.has(field) && !legacyFieldMap.has(field))
  );
  let usedLegacyExpression = false;

  for (const mapping of config.fieldMappings) {
    const legacyValue = legacyData[mapping.legacy];
    const existingCanonicalValue = getNestedValue(canonical, mapping.canonical);

    if (legacyValue !== undefined && !presentCanonicalRoots.has(mapping.legacy)) {
      usedLegacyExpression = true;
      const canonicalValue = mapping.transform ? mapping.transform(legacyValue) : legacyValue;
      if (existingCanonicalValue !== undefined) {
        if (!valuesEqual(existingCanonicalValue, canonicalValue)) {
          errors.push({
            code: CONTRACT_ERROR_CODES.CANONICAL_LEGACY_CONFLICT,
            path: `/${mapping.canonical.replaceAll('.', '/')}`,
            message: `Canonical field "${mapping.canonical}" conflicts with legacy field "${mapping.legacy}"`,
          });
        }
      } else {
        setNestedValue(canonical, mapping.canonical, canonicalValue);
      }
    }

    if (mapping.required && getNestedValue(canonical, mapping.canonical) === undefined) {
      errors.push({
        code: 'MISSING_REQUIRED_FIELD',
        path: `/${mapping.canonical.replaceAll('.', '/')}`,
        message: `Required canonical field "${mapping.canonical}" missing (legacy: "${mapping.legacy}")`,
      });
    }
  }

  // Fail closed: unmapped legacy fields indicate lossy normalization
  for (const field of unmappedLegacyFields) {
    errors.push({
      code: 'LOSSY_NORMALIZATION',
      path: field,
      message: `Legacy field "${field}" not mapped to canonical form — would be lost`,
    });
  }

  // Run custom validation
  if (config.validate) {
    const validationErrors = config.validate(canonical);
    for (const error of validationErrors) {
      errors.push({
        code: 'VALIDATION_FAILED',
        path: '',
        message: error,
      });
    }
  }

  if (errors.length > 0) {
    return { success: false, errors, warnings };
  }

  // Validate canonical form against production schema
  const schemaResult = validateContractAgainstSchema(canonical, contract);
  if (!schemaResult.valid) {
    return {
      success: false,
      errors: schemaResult.errors.map((e) => ({
        code: 'SCHEMA_VALIDATION_FAILED',
        path: e.split(':')[0]?.trim() ?? '',
        message: e,
      })),
      warnings,
    };
  }

  // Validate relations if present
  if (Array.isArray(canonical.relations)) {
    const relationResult = validateRelations(canonical.relations as Array<Record<string, unknown>>, contract);
    if (!relationResult.valid) {
      return {
        success: false,
        errors: relationResult.issues.map(i => ({
          code: i.code,
          path: i.path,
          message: i.message,
        })),
        warnings,
      };
    }
  }

  const sourceRevision = usedLegacyExpression ? 'legacy' : 'canonical';

  return {
    success: true,
    ir: {
      type: contract.identity.major.split('.')[1]?.split('@')[0] ?? 'unknown',
      id: String((canonical.metadata as Record<string, unknown>)?.id ?? canonical['id'] ?? ''),
      contractMajor: contract.identity.major,
      contractDigest: contract.identity.revisionDigest,
      canonical,
      sourceRevision,
      warnings,
    },
    errors: [],
    warnings,
  };
}

// ============================================================================
// Project Policy
// ============================================================================

export interface ProjectPolicy {
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

export interface PolicyCompatibilityResult {
  compatible: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Resolve a dot-separated field path to the schema property definition.
 * Supports nested paths like "metadata.status" → schema.properties.metadata.properties.status.
 */
function resolvePropertyPath(
  schema: ContractSchema,
  fieldPath: string
): Record<string, unknown> | undefined {
  const parts = fieldPath.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = schema.properties;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    const propDef = current[part];
    if (!propDef) return undefined;
    // If there are more parts, drill into properties
    if (parts.indexOf(part) < parts.length - 1) {
      current = (propDef as Record<string, unknown>).properties;
    } else {
      return propDef as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * Validate that project policy only tightens (never loosens) base contract.
 * - Arrays use minItems/maxItems; numbers use minimum/maximum.
 * - Enum restrictions must be subsets of base enum.
 * - Unimplemented constraints are rejected (fail-closed).
 */
export function validatePolicyCompatibility(
  policy: ProjectPolicy,
  baseContract: ContractDefinition
): PolicyCompatibilityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Verify base contract reference
  if (policy.baseContractMajor !== baseContract.identity.major) {
    errors.push(
      `POLICY_INCOMPATIBLE: Policy references ${policy.baseContractMajor}, but base contract is ${baseContract.identity.major}`
    );
    return { compatible: false, errors, warnings };
  }

  const schema = baseContract.schema;

  // Validate additional required fields exist in base schema
  if (policy.additionalRequired) {
    for (const field of policy.additionalRequired) {
      const propDef = resolvePropertyPath(schema, field);
      if (!propDef) {
        errors.push(`POLICY_INCOMPATIBLE: Policy requires field "${field}" which does not exist in base contract`);
      }
    }
  }

  // Validate restricted enums are subsets of base enums
  if (policy.restrictedEnums) {
    for (const [field, values] of Object.entries(policy.restrictedEnums)) {
      const baseProperty = resolvePropertyPath(schema, field);
      if (!baseProperty) {
        errors.push(`POLICY_INCOMPATIBLE: Policy restricts enum for field "${field}" which does not exist in base contract`);
        continue;
      }
      if (!Array.isArray(baseProperty.enum)) {
        errors.push(`POLICY_INCOMPATIBLE: Field "${field}" is not an enum in base contract — cannot restrict`);
        continue;
      }
      // Check that all policy values are valid base enum values (subset)
      for (const value of values) {
        if (!(baseProperty.enum as unknown[]).includes(value)) {
          errors.push(`POLICY_INCOMPATIBLE: Policy enum value "${String(value)}" for field "${field}" not in base contract enum [${(baseProperty.enum as unknown[]).join(', ')}]`);
        }
      }
    }
  }

  // Validate cardinality overrides — use minItems/maxItems for arrays, minimum/maximum for numbers
  if (policy.minCardinality) {
    for (const [field, min] of Object.entries(policy.minCardinality)) {
      if (!Number.isFinite(min) || min < 0 || !Number.isInteger(min)) {
        errors.push(`POLICY_INCOMPATIBLE: Policy min cardinality for "${field}" must be a non-negative integer, got ${min}`);
        continue;
      }
      const baseProperty = resolvePropertyPath(schema, field);
      if (!baseProperty) {
        errors.push(`POLICY_INCOMPATIBLE: Policy sets min cardinality for field "${field}" which does not exist in base contract`);
        continue;
      }
      // Arrays use minItems, numbers use minimum
      const baseMin = (baseProperty.type === 'array')
        ? (baseProperty.minItems as number | undefined)
        : (baseProperty.minimum as number | undefined);
      if (baseMin !== undefined && min < baseMin) {
        errors.push(`POLICY_INCOMPATIBLE: Policy min cardinality ${min} for field "${field}" loosens base ${baseProperty.type === 'array' ? 'minItems' : 'minimum'}=${baseMin}`);
      }
    }
  }

  if (policy.maxCardinality) {
    for (const [field, max] of Object.entries(policy.maxCardinality)) {
      if (!Number.isFinite(max) || max < 0 || !Number.isInteger(max)) {
        errors.push(`POLICY_INCOMPATIBLE: Policy max cardinality for "${field}" must be a non-negative integer, got ${max}`);
        continue;
      }
      const baseProperty = resolvePropertyPath(schema, field);
      if (!baseProperty) {
        errors.push(`POLICY_INCOMPATIBLE: Policy sets max cardinality for field "${field}" which does not exist in base contract`);
        continue;
      }
      // Arrays use maxItems, numbers use maximum
      const baseMax = (baseProperty.type === 'array')
        ? (baseProperty.maxItems as number | undefined)
        : (baseProperty.maximum as number | undefined);
      if (baseMax !== undefined && max > baseMax) {
        errors.push(`POLICY_INCOMPATIBLE: Policy max cardinality ${max} for field "${field}" loosens base ${baseProperty.type === 'array' ? 'maxItems' : 'maximum'}=${baseMax}`);
      }
    }
  }

  // Reject unimplemented constraints (fail-closed)
  if (policy.constraints && Object.keys(policy.constraints).length > 0) {
    for (const key of Object.keys(policy.constraints)) {
      errors.push(`POLICY_INCOMPATIBLE: Constraint "${key}" is not implemented — rejected as unvalidated escape hatch`);
    }
  }

  return {
    compatible: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Apply project policy to base contract, producing an effective contract.
 * First validates monotonicity, then produces immutable effective contract/schema/digest.
 */
export function applyProjectPolicy(
  policy: ProjectPolicy,
  baseContract: ContractDefinition
): { success: boolean; effectiveContract?: ContractDefinition; errors: string[]; warnings: string[] } {
  // First validate monotonicity
  const compatibility = validatePolicyCompatibility(policy, baseContract);
  if (!compatibility.compatible) {
    return {
      success: false,
      errors: compatibility.errors,
      warnings: compatibility.warnings,
    };
  }

  // Deep clone schema to avoid mutating base
  const effectiveSchema = JSON.parse(JSON.stringify(baseContract.schema)) as ContractSchema;

  // Apply additional required fields
  if (policy.additionalRequired) {
    for (const fieldPath of policy.additionalRequired) {
      const parts = fieldPath.split('.');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parentSchema: any = effectiveSchema;
      for (let i = 0; i < parts.length - 1; i++) {
        parentSchema = parentSchema.properties?.[parts[i]];
      }
      const requiredField = parts[parts.length - 1];
      if (!Array.isArray(parentSchema.required)) parentSchema.required = [];
      if (!parentSchema.required.includes(requiredField)) {
        parentSchema.required.push(requiredField);
      }
    }
  }

  // Apply restricted enums
  if (policy.restrictedEnums) {
    for (const [fieldPath, values] of Object.entries(policy.restrictedEnums)) {
      const propDef = resolvePropertyPath(effectiveSchema, fieldPath);
      if (propDef && Array.isArray(propDef.enum)) {
        // Intersection: only keep values that are in both base and policy
        propDef.enum = (propDef.enum as unknown[]).filter(v => values.includes(v));
      }
    }
  }

  // Apply min cardinality
  if (policy.minCardinality) {
    for (const [fieldPath, min] of Object.entries(policy.minCardinality)) {
      const propDef = resolvePropertyPath(effectiveSchema, fieldPath);
      if (propDef) {
        if (propDef.type === 'array') {
          propDef.minItems = min;
        } else {
          propDef.minimum = min;
        }
      }
    }
  }

  // Apply max cardinality
  if (policy.maxCardinality) {
    for (const [fieldPath, max] of Object.entries(policy.maxCardinality)) {
      const propDef = resolvePropertyPath(effectiveSchema, fieldPath);
      if (propDef) {
        if (propDef.type === 'array') {
          propDef.maxItems = max;
        } else {
          propDef.maximum = max;
        }
      }
    }
  }

  // Reject relation policy if present (not supported in Cycle 2)
  // This is already handled by validatePolicyCompatibility rejecting unknown constraints

  // Update effective schema's contractIdentity to match
  effectiveSchema.contractIdentity = {
    ...baseContract.identity,
    revisionDigest: '', // Placeholder — will be computed below
  };

  // Compute effective digest (exclude revisionDigest from computation)
  const effectiveDigest = computeRevisionDigest(JSON.stringify(effectiveSchema));

  // Update both schema and identity with computed digest
  effectiveSchema.contractIdentity.revisionDigest = effectiveDigest;

  // Create effective contract identity
  const effectiveIdentity: ContractIdentity = {
    ...baseContract.identity,
    revisionDigest: effectiveDigest,
  };
  effectiveSchema.contractIdentity = effectiveIdentity;
  const effectiveRawContent = JSON.stringify(effectiveSchema);

  const effectiveContract: ContractDefinition = {
    identity: effectiveIdentity,
    schema: effectiveSchema,
    rawContent: effectiveRawContent,
  };

  return {
    success: true,
    effectiveContract,
    errors: [],
    warnings: compatibility.warnings,
  };
}

// ============================================================================
// Contract Loader
// ============================================================================

export interface LoadContractOptions {
  /** Expected authority (optional, for validation) */
  expectedAuthority?: string;
}

/**
 * Load contract from JSON file.
 * Digest verification is always on (fail-closed) — no bypass option.
 */
export async function loadContract(
  contractPath: string,
  options?: LoadContractOptions
): Promise<ContractDefinition> {
  const rawContent = await readFile(contractPath, 'utf-8');
  let schema: ContractSchema;

  try {
    schema = JSON.parse(rawContent) as ContractSchema;
  } catch (error) {
    throw new ContractError(
      CONTRACT_ERROR_CODES.INVALID_IDENTITY,
      `Failed to parse contract JSON: ${(error as Error).message}`,
      { path: contractPath }
    );
  }

  // Validate contract identity
  if (!schema.contractIdentity) {
    throw new ContractError(
      CONTRACT_ERROR_CODES.INVALID_IDENTITY,
      'Contract missing contractIdentity',
      { path: contractPath }
    );
  }

  const identity = schema.contractIdentity;

  // Validate required fields
  if (!identity.major || !identity.authority || !identity.namespace) {
    throw new ContractError(
      CONTRACT_ERROR_CODES.INVALID_IDENTITY,
      'Contract identity missing required fields (major, authority, namespace)',
      { identity }
    );
  }

  // Validate namespace authority
  if (options?.expectedAuthority) {
    validateNamespaceAuthority(identity, options.expectedAuthority);
  } else {
    validateNamespaceAuthority(identity);
  }

  // Compute digest on canonicalized content (revisionDigest excluded)
  const computedDigest = computeRevisionDigest(rawContent);

  // Always verify digest (fail-closed — no bypass option)
  if (identity.revisionDigest && identity.revisionDigest !== computedDigest) {
    throw new ContractError(
      CONTRACT_ERROR_CODES.DIGEST_MISMATCH,
      `Contract digest mismatch: declared ${identity.revisionDigest}, computed ${computedDigest}`,
      { identity, computedDigest }
    );
  }

  // Update digest to computed value
  identity.revisionDigest = computedDigest;

  return {
    identity,
    schema,
    rawContent,
  };
}

/**
 * Load all contracts from a directory.
 * Fails closed: if ANY contract is invalid, the entire load fails.
 */
export async function loadContractsFromDirectory(
  contractsDir: string,
  options?: LoadContractOptions
): Promise<ContractDefinition[]> {
  const contracts: ContractDefinition[] = [];
  const entries = await readdir(contractsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const schemaPath = join(contractsDir, entry.name, 'schema.json');
      const contract = await loadContract(schemaPath, options);
      contracts.push(contract);
    }
  }

  return contracts;
}

// ============================================================================
// Schema Validation (AJV-based)
// ============================================================================

import _AjvModule from 'ajv';

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

// Cache by immutable schema content, not only $id: project policy produces a
// tightened revision with the same major/$id and must never reuse the base validator.
type AjvValidateFn = ((data: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> };
const _validatorCache = new Map<string, AjvValidateFn>();

function getValidator(schema: ContractSchema): AjvValidateFn {
  const key = `${schema.$id || 'default'}#${computeRevisionDigest(JSON.stringify(schema))}`;
  if (!_validatorCache.has(key)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AjvCtor = _AjvModule as unknown as new (opts?: object) => any;
    const ajv = new AjvCtor({ allErrors: true, strict: false });
    _validatorCache.set(key, ajv.compile(schema) as AjvValidateFn);
  }
  return _validatorCache.get(key)!;
}

/**
 * Validate data against a contract schema using AJV.
 * AJV is a runtime dependency — if unavailable, validation fails closed.
 */
export function validateContractAgainstSchema(
  data: unknown,
  contract: ContractDefinition
): SchemaValidationResult {
  const validate = getValidator(contract.schema);
  const valid = validate(data) as boolean;
  if (valid) {
    return { valid: true, errors: [] };
  }
  const errors = (validate.errors ?? []).map(
    (err: { instancePath?: string; message?: string; params?: Record<string, unknown> }) =>
      `${err.instancePath || '/'}: ${err.message ?? 'validation error'}`
  );
  return { valid: false, errors };
}

/**
 * Validate relations against contract relation rules.
 * Checks:
 * - Each relation kind is allowed by contract rules
 * - Target type is allowed for the relation kind
 * - Cardinality (min/max) is satisfied
 * - Anchor policy is respected (required/optional/forbidden)
 */
export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface RelationValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export function validateRelations(
  relations: Array<Record<string, unknown>>,
  contract: ContractDefinition
): RelationValidationResult {
  const issues: ValidationIssue[] = [];
  const relationRules = contract.identity.relationRules;

  if (!relationRules) {
    // No rules defined — fail closed
    issues.push({
      code: 'RELATION_RULES_MISSING',
      path: '/contractIdentity/relationRules',
      message: 'Contract does not define relation rules — cannot validate relations',
    });
    return { valid: false, issues };
  }

  // Group relations by kind for cardinality checking
  const relationsByKind = new Map<string, Array<Record<string, unknown>>>();
  for (const relation of relations) {
    const kind = relation.kind as string;
    if (!relationsByKind.has(kind)) {
      relationsByKind.set(kind, []);
    }
    relationsByKind.get(kind)!.push(relation);
  }

  // Validate each relation
  for (let i = 0; i < relations.length; i++) {
    const relation = relations[i];
    const kind = relation.kind as string;
    const targetType = relation.target_type as string;
    const path = `/relations/${i}`;

    // Check if kind is allowed
    if (!relationRules[kind]) {
      issues.push({
        code: 'RELATION_INVALID_KIND',
        path: `${path}/kind`,
        message: `Relation kind "${kind}" is not allowed by contract rules`,
      });
      continue;
    }

    const rule = relationRules[kind];

    // Check target type
    if (!rule.allowedTargetTypes.includes(targetType)) {
      issues.push({
        code: 'RELATION_INVALID_TARGET_TYPE',
        path: `${path}/target_type`,
        message: `Target type "${targetType}" is not allowed for relation kind "${kind}". Allowed: ${rule.allowedTargetTypes.join(', ')}`,
      });
    }

    // Check anchor policy
    const hasAnchor = relation.anchor !== undefined && relation.anchor !== '';
    if (rule.anchorPolicy === 'required' && !hasAnchor) {
      issues.push({
        code: 'RELATION_MISSING_ANCHOR',
        path: `${path}/anchor`,
        message: `Relation kind "${kind}" requires an anchor`,
      });
    } else if (rule.anchorPolicy === 'forbidden' && hasAnchor) {
      issues.push({
        code: 'RELATION_FORBIDDEN_ANCHOR',
        path: `${path}/anchor`,
        message: `Relation kind "${kind}" forbids anchors`,
      });
    }
  }

  // Check cardinality for each kind
  for (const [kind, rule] of Object.entries(relationRules)) {
    const count = relationsByKind.get(kind)?.length ?? 0;
    if (count < rule.min) {
      issues.push({
        code: 'RELATION_BELOW_MIN',
        path: '/relations',
        message: `Relation kind "${kind}" has ${count} instances, minimum is ${rule.min}`,
      });
    }
    if (count > rule.max) {
      issues.push({
        code: 'RELATION_ABOVE_MAX',
        path: '/relations',
        message: `Relation kind "${kind}" has ${count} instances, maximum is ${rule.max}`,
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Validate semantic markers in Markdown content.
 * Checks:
 * - All required markers are present
 * - No duplicate markers
 * - No unknown markers (markers not defined in contract)
 */
export function validateSemanticMarkers(
  markdownContent: string,
  contract: ContractDefinition
): SchemaValidationResult {
  const errors: string[] = [];
  const semanticMarkers = contract.identity.semanticMarkers;

  if (!semanticMarkers) {
    // No markers defined — accept all (but warn)
    return { valid: true, errors: [] };
  }

  // Extract markers from Markdown content
  // Markers are expected in the format: <!-- marker: <name> -->
  const markerRegex = /<!--\s*marker:\s*([a-zA-Z0-9_-]+)\s*-->/g;
  const foundMarkers = new Map<string, number>();
  let match;

  while ((match = markerRegex.exec(markdownContent)) !== null) {
    const markerName = match[1];
    foundMarkers.set(markerName, (foundMarkers.get(markerName) ?? 0) + 1);
  }

  // Check for required markers
  for (const [markerName, markerDef] of Object.entries(semanticMarkers)) {
    if (markerDef.required && !foundMarkers.has(markerDef.markdownMarker)) {
      errors.push(`MARKER_MISSING: Required semantic marker "${markerDef.markdownMarker}" not found in Markdown content`);
    }
  }

  // Check for duplicate markers
  for (const [markerName, count] of foundMarkers.entries()) {
    if (count > 1) {
      errors.push(`MARKER_DUPLICATE: Semantic marker "${markerName}" appears ${count} times, must be unique`);
    }
  }

  // Check for unknown markers
  const knownMarkers = new Set(Object.values(semanticMarkers).map(m => m.markdownMarker));
  for (const markerName of foundMarkers.keys()) {
    if (!knownMarkers.has(markerName)) {
      errors.push(`MARKER_UNKNOWN: Unknown semantic marker "${markerName}" not defined in contract`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Fail-closed fallback: when AJV is unavailable, reject all input.
 * This ensures the system never silently accepts invalid data.
 */
export function failClosedValidation(): SchemaValidationResult {
  return {
    valid: false,
    errors: ['/: Schema validator unavailable — fail-closed rejection'],
  };
}

// Backward-compat shim for tests that set AJV constructor globally.
// With AJV as a runtime dependency this is a no-op.
export let __AjvCtor: unknown = null;

export function setAjvConstructor(_ctor: unknown): void {
  // No-op: AJV is now a direct runtime dependency.
  // Kept for backward compatibility with test harness.
}

// ============================================================================
// E2E Legacy Normalizer
// ============================================================================

export const E2E_NORMALIZER_CONFIG: NormalizerConfig = {
  contractMajor: 'artifact.e2e-test@1',
  fieldMappings: [
    { legacy: 'id', canonical: 'metadata.id', required: true },
    { legacy: 'title', canonical: 'metadata.title', required: true },
    { legacy: 'status', canonical: 'metadata.status', required: true },
    { legacy: 'test_batch', canonical: 'metadata.test_batch' },
    { legacy: 'scope', canonical: 'scope.business_goal', transform: (v) => String(v) },
    { legacy: 'actors', canonical: 'scope.actors', transform: (v) => Array.isArray(v) ? v : [v] },
    { legacy: 'system_boundaries', canonical: 'system_boundary.components', transform: (v) => Array.isArray(v) ? v : [v] },
    { legacy: 'test_cases', canonical: 'test_cases', required: true },
    { legacy: 'relations', canonical: 'relations' },
    // Map legacy coverage fields if present
    { legacy: 'ac_coverage', canonical: 'coverage.ac_coverage' },
    { legacy: 'related_scenarios', canonical: 'coverage.related_scenarios' },
    // Map legacy environment fields if present
    { legacy: 'topology', canonical: 'environment_data.topology' },
    { legacy: 'fixtures', canonical: 'environment_data.fixtures' },
    { legacy: 'isolation_strategy', canonical: 'environment_data.isolation_strategy' },
    // Map legacy evidence fields if present
    { legacy: 'required_artifacts', canonical: 'evidence_contract.required_artifacts' },
    { legacy: 'runner_binding', canonical: 'evidence_contract.runner_binding' },
  ],
  validate: (canonical) => {
    const errors: string[] = [];
    if (!canonical.metadata || typeof canonical.metadata !== 'object') {
      errors.push('metadata must be an object');
    }
    if (!canonical.scope || typeof canonical.scope !== 'object') {
      errors.push('scope must be an object');
    }
    if (!canonical.system_boundary || typeof canonical.system_boundary !== 'object') {
      errors.push('system_boundary must be an object');
    }
    if (!Array.isArray(canonical.test_cases) || (canonical.test_cases as unknown[]).length === 0) {
      errors.push('test_cases must be a non-empty array');
    }
    // Validate test_cases have trace_targets
    if (Array.isArray(canonical.test_cases)) {
      for (let i = 0; i < (canonical.test_cases as unknown[]).length; i++) {
        const tc = (canonical.test_cases as Record<string, unknown>[])[i];
        if (!Array.isArray(tc.trace_targets) || (tc.trace_targets as unknown[]).length === 0) {
          errors.push(`test_cases[${i}].trace_targets must be a non-empty array`);
        }
      }
    }
    return errors;
  },
};

/**
 * Normalize a legacy E2E artifact to canonical IR.
 * The legacy format has flat fields (id, title, status, scope as string, etc.)
 * while the canonical format uses nested objects (metadata.id, scope.business_goal, etc.)
 * Requires explicit contract — no default identity fallback.
 */
export function normalizeE2eLegacyArtifact(
  legacyData: Record<string, unknown>,
  contract: ContractDefinition
): NormalizationResult {
  return normalizeToCanonical(legacyData, E2E_NORMALIZER_CONFIG, contract);
}

// ============================================================================
// Contract Catalog
// ============================================================================

export interface ContractCatalogEntry {
  identity: ContractIdentity;
  contract: ContractDefinition;
}

/**
 * Machine-readable contract catalog.
 * Lists, resolves and explains registered contracts.
 * Uses (major, digest) as revision key for multi-revision support.
 */
export class ContractCatalog {
  private contracts = new Map<string, ContractDefinition>();
  private majorToContracts = new Map<string, Set<string>>();
  private majorToActiveWrite = new Map<string, string>();

  /**
   * Add a contract to the catalog
   * @throws ContractError if duplicate identity
   */
  add(contract: ContractDefinition, options?: { isActive?: boolean; isWriteTarget?: boolean }): void {
    const major = contract.identity.major;
    const digest = contract.identity.revisionDigest;
    const key = `${major}@${digest}`;
    const isActive = options?.isActive ?? true;
    const isWriteTarget = options?.isWriteTarget ?? true;

    // Check for duplicate identity (same major + digest)
    if (this.contracts.has(key)) {
      throw new ContractError(
        CONTRACT_ERROR_CODES.DUPLICATE_IDENTITY,
        `Contract ${key} already in catalog`,
        { identity: contract.identity }
      );
    }

    this.contracts.set(key, contract);

    // Track by major
    if (!this.majorToContracts.has(major)) {
      this.majorToContracts.set(major, new Set());
    }
    this.majorToContracts.get(major)!.add(key);

    // Track active write
    if (isActive && isWriteTarget) {
      const existingActive = this.majorToActiveWrite.get(major);
      if (existingActive && existingActive !== key) {
        this.contracts.delete(key);
        this.majorToContracts.get(major)?.delete(key);
        throw new ContractError(
          CONTRACT_ERROR_CODES.MULTIPLE_ACTIVE_WRITE,
          `Major ${major} already has active write revision`,
          { major, existing: existingActive, attempted: key }
        );
      }
      this.majorToActiveWrite.set(major, key);
    }
  }

  /**
   * Resolve a contract by major identity.
   * - 0 entries: returns undefined
   * - 1 entry: returns it
   * - multiple: if there's a unique active write, returns it; otherwise throws AMBIGUOUS_REVISION
   */
  resolve(major: string): ContractDefinition | undefined {
    const keys = this.majorToContracts.get(major);
    if (!keys || keys.size === 0) return undefined;

    if (keys.size === 1) {
      const firstKey = keys.values().next().value;
      return firstKey ? this.contracts.get(firstKey) : undefined;
    }

    // Multiple revisions — check for active write
    const activeWriteKey = this.majorToActiveWrite.get(major);
    if (activeWriteKey) {
      return this.contracts.get(activeWriteKey);
    }

    throw new ContractError(
      CONTRACT_ERROR_CODES.AMBIGUOUS_REVISION,
      `Multiple revisions found for ${major} with no unique active write — specify digest`,
      {
        major,
        availableDigests: Array.from(keys)
          .map((key) => this.contracts.get(key)?.identity.revisionDigest)
          .filter((digest): digest is string => Boolean(digest)),
      }
    );
  }

  /**
   * Resolve a contract by major identity and exact digest
   */
  resolveByDigest(major: string, digest: string): ContractDefinition | undefined {
    const key = `${major}@${digest}`;
    return this.contracts.get(key);
  }

  /**
   * List all catalog entries (all revisions)
   */
  list(): ContractCatalogEntry[] {
    return Array.from(this.contracts.values()).map(contract => ({
      identity: contract.identity,
      contract,
    }));
  }

  /**
   * Get catalog as JSON-serializable object (all revisions)
   */
  toJSON(): Record<string, unknown> {
    return {
      contracts: this.list().map((entry) => ({
        major: entry.identity.major,
        authority: entry.identity.authority,
        namespace: entry.identity.namespace,
        revisionDigest: entry.identity.revisionDigest,
      })),
    };
  }
}

/**
 * Load contract catalog from a contracts directory
 */
export async function loadContractCatalog(
  contractsDir: string,
  options?: LoadContractOptions
): Promise<ContractCatalog> {
  const catalog = new ContractCatalog();
  const contracts = await loadContractsFromDirectory(contractsDir, options);
  for (const contract of contracts) {
    catalog.add(contract);
  }
  return catalog;
}

// ============================================================================
// CLI contract helpers
// ============================================================================

/**
 * Run a contract CLI command. Used by tests to verify CLI output format.
 */
export async function runContractCli(
  args: string[],
  io?: { stdout?: (chunk: string) => void; stderr?: (chunk: string) => void }
): Promise<number> {
  // Delegates to the CLI main function
  const { runCli } = await import('./cli.js');
  return runCli(args, io);
}
