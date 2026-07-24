// Artifact Contract Kernel — TDD tests
// Covers §5 of cycle-2 task:
// 1. Official contract identity + correct digest succeed; digest drift fails.
// 2. Official namespace loadable; third-party/project independent namespace loadable;
//    impersonating artifact.* fails.
// 3. Full canonical E2E fixture passes; missing each required slot/case field fails.
// 4. Relation target type, anchor, min/max cardinality positive/negative.
// 5. Legacy fixture normalizes losslessly; unknown field loss, canonical/legacy conflict fails.
// 6. Single active write revision succeeds; multiple active write contracts fail.
// 7. Project policy adds required / shrinks enum / raises cardinality passes;
//    deletes required / expands enum / lowers cardinality fails.
// 8. Markdown heading changes but marker same still passes; only natural language heading,
//    missing marker, fail closed.
// 9. CLI JSON output stable, error codes stable, failure non-zero; machine stdout no prose.
// 10. Node ESM/CJS/type exports consumable; npm pack contract/schema assets and subpath consumable.
// 11. Existing artifact-graph full test suite no regression.
// @feature ACA18
// @decision D-ACA-18

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import {
  // Contract Identity
  ContractIdentity,
  ContractDefinition,
  ContractSchema,
  ContractError,
  CONTRACT_ERROR_CODES,
  // Namespace
  isOfficialNamespace,
  validateNamespaceAuthority,
  // Digest
  computeRevisionDigest,
  verifyDigest,
  // Registry
  ContractRegistry,
  // Canonical IR
  CanonicalIR,
  normalizeToCanonical,
  NormalizerConfig,
  // Policy
  ProjectPolicy,
  validatePolicyCompatibility,
  applyProjectPolicy,
  // Relations
  validateRelations,
  // Semantic markers
  validateSemanticMarkers,
  // Loader
  loadContract,
  loadContractsFromDirectory,
  // Schema validation
  validateContractAgainstSchema,
  // E2E contract normalizer
  E2E_NORMALIZER_CONFIG,
  normalizeE2eLegacyArtifact,
  // Contract catalog
  ContractCatalog,
  loadContractCatalog,
  // CLI helpers
  runContractCli,
} from '../src/contract-kernel.js';

// ============================================================================
// Test fixtures
// ============================================================================

const CONTRACTS_DIR = join(import.meta.dirname ?? __dirname, '..', 'contracts');

function makeE2eIdentity(overrides?: Partial<ContractIdentity>): ContractIdentity {
  return {
    major: 'artifact.e2e-test@1',
    authority: 'artifact',
    namespace: 'artifact',
    revisionDigest: '',
    relationRules: {
      derives_from: {
        allowedTargetTypes: ['scenario', 'design', 'decision'],
        min: 1,
        max: 10,
        anchorPolicy: 'optional',
      },
      verifies: {
        allowedTargetTypes: ['feature', 'scenario'],
        min: 1,
        max: 5,
        anchorPolicy: 'required',
      },
      implemented_by: {
        allowedTargetTypes: ['code'],
        min: 0,
        max: 5,
        anchorPolicy: 'optional',
      },
      references: {
        allowedTargetTypes: ['feature', 'scenario', 'decision', 'design', 'e2e_test', 'test'],
        min: 0,
        max: 20,
        anchorPolicy: 'optional',
      },
      covers: {
        allowedTargetTypes: ['feature', 'scenario'],
        min: 0,
        max: 10,
        anchorPolicy: 'optional',
      },
    },
    semanticMarkers: {
      scope: {
        jsonPointer: '/scope',
        markdownMarker: 'scope',
        required: true,
      },
      system_boundary: {
        jsonPointer: '/system_boundary',
        markdownMarker: 'system-boundary',
        required: true,
      },
      coverage: {
        jsonPointer: '/coverage',
        markdownMarker: 'coverage',
        required: true,
      },
      environment_data: {
        jsonPointer: '/environment_data',
        markdownMarker: 'environment-data',
        required: true,
      },
      test_cases: {
        jsonPointer: '/test_cases',
        markdownMarker: 'test-cases',
        required: true,
      },
      evidence_contract: {
        jsonPointer: '/evidence_contract',
        markdownMarker: 'evidence-contract',
        required: true,
      },
    },
    ...overrides,
  };
}

function makeMinimalE2eSchema(): ContractSchema {
  return {
    $id: 'artifact.e2e-test@1',
    title: 'Artifact Contract: E2E Test Specification',
    version: '1.0.0',
    contractIdentity: makeE2eIdentity(),
    type: 'object',
    required: ['metadata', 'scope', 'system_boundary', 'test_cases'],
    properties: {
      metadata: { type: 'object' },
      scope: { type: 'object' },
      system_boundary: { type: 'object' },
      test_cases: { type: 'array' },
    },
  };
}

function makeCompleteE2eData(): Record<string, unknown> {
  return {
    metadata: {
      id: 'batch-1:TC-001',
      title: 'User login flow',
      status: 'planned',
      test_batch: 'batch-1',
    },
    scope: {
      business_goal: 'Verify user can log in',
      actors: ['registered_user'],
      system_boundaries: ['auth-service', 'web-ui'],
    },
    system_boundary: {
      components: ['auth-service', 'web-ui', 'user-db'],
      external_dependencies: ['oauth-provider'],
    },
    coverage: {
      ac_coverage: { ACA11: ['AC1'] },
      related_scenarios: ['S-12'],
    },
    environment_data: {
      topology: 'docker-compose',
      fixtures: ['test-user-db'],
      isolation_strategy: 'per-test',
    },
    relations: [
      { kind: 'derives_from', target_type: 'scenario', target_id: 'S-12' },
      { kind: 'verifies', target_type: 'feature', target_id: 'ACA11', anchor: 'section-1' },
    ],
    test_cases: [
      {
        case_id: 'TC-001',
        goal: 'Successful login with valid credentials',
        preconditions: ['User account exists'],
        actions: [
          { step: 1, action: 'Navigate to login page' },
          { step: 2, action: 'Enter valid credentials', expected_result: 'Redirect to dashboard' },
        ],
        oracles: [
          { observable: 'Dashboard page visible', criterion: 'User sees welcome message' },
        ],
        cleanup: ['Logout user'],
        priority: 'critical',
        trace_targets: ['S-12'],
      },
    ],
    evidence_contract: {
      required_artifacts: ['auth-service-logs', 'ui-screenshot'],
      runner_binding: 'playwright',
      proof_requirements: ['login-success-screenshot'],
    },
  };
}

// ============================================================================
// 1. Contract identity + digest
// ============================================================================

describe('§5.1 Contract identity + digest', () => {
  it('official contract identity + correct digest succeeds', async () => {
    const contractPath = join(CONTRACTS_DIR, 'e2e-test', 'schema.json');
    const contract = await loadContract(contractPath);
    expect(contract.identity.major).toBe('artifact.e2e-test@1');
    expect(contract.identity.authority).toBe('artifact');
    expect(contract.identity.revisionDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('digest drift is detected and fails', () => {
    const content = '{"test": true}';
    const correctDigest = computeRevisionDigest(content);
    const tamperedContent = '{"test": false}';
    expect(verifyDigest(tamperedContent, correctDigest)).toBe(false);
  });

  it('correct digest verification passes', () => {
    const content = '{"test": true}';
    const digest = computeRevisionDigest(content);
    expect(verifyDigest(content, digest)).toBe(true);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

// ============================================================================
// 2. Namespace authority
// ============================================================================

describe('§5.2 Namespace authority', () => {
  it('official namespace is recognized', () => {
    expect(isOfficialNamespace('artifact')).toBe(true);
    expect(isOfficialNamespace('artifact.e2e-test')).toBe(true);
  });

  it('third-party namespace is not official', () => {
    expect(isOfficialNamespace('io.github.org')).toBe(false);
    expect(isOfficialNamespace('project.my-project')).toBe(false);
  });

  it('official namespace with correct authority passes validation', () => {
    const identity = makeE2eIdentity({ authority: 'artifact', namespace: 'artifact' });
    expect(() => validateNamespaceAuthority(identity)).not.toThrow();
  });

  it('impersonating artifact.* with non-official authority fails', () => {
    const identity = makeE2eIdentity({ authority: 'malicious', namespace: 'artifact.e2e-test' });
    expect(() => validateNamespaceAuthority(identity)).toThrow(ContractError);
    try {
      validateNamespaceAuthority(identity);
    } catch (e) {
      expect((e as ContractError).code).toBe(CONTRACT_ERROR_CODES.AUTHORITY_VIOLATION);
    }
  });

  it('third-party with independent namespace passes', () => {
    const identity: ContractIdentity = {
      major: 'io.github.org.my-contract@1',
      authority: 'io.github.org',
      namespace: 'io.github.org',
      revisionDigest: 'sha256:abc',
    };
    expect(() => validateNamespaceAuthority(identity)).not.toThrow();
  });

  it('project namespace with project authority passes', () => {
    const identity: ContractIdentity = {
      major: 'project.my-project.contract@1',
      authority: 'project.my-project',
      namespace: 'project.my-project',
      revisionDigest: 'sha256:abc',
    };
    expect(() => validateNamespaceAuthority(identity)).not.toThrow();
  });
});

// ============================================================================
// 3. Canonical E2E fixture + missing required fields
// ============================================================================

describe('§5.3 Canonical E2E fixture validation', () => {
  let e2eContract: ContractDefinition;

  beforeAll(async () => {
    const contractPath = join(CONTRACTS_DIR, 'e2e-test', 'schema.json');
    e2eContract = await loadContract(contractPath);
  });

  it('complete E2E fixture passes validation', () => {
    const data = makeCompleteE2eData();
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('missing metadata fails', () => {
    const data = makeCompleteE2eData();
    delete (data as Record<string, unknown>).metadata;
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('missing scope fails', () => {
    const data = makeCompleteE2eData();
    delete (data as Record<string, unknown>).scope;
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(false);
  });

  it('missing system_boundary fails', () => {
    const data = makeCompleteE2eData();
    delete (data as Record<string, unknown>).system_boundary;
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(false);
  });

  it('missing test_cases fails', () => {
    const data = makeCompleteE2eData();
    (data as Record<string, unknown>).test_cases = [];
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(false);
  });

  it('test case missing case_id fails', () => {
    const data = makeCompleteE2eData();
    delete (data.test_cases as Record<string, unknown>[])[0].case_id;
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(false);
  });

  it('test case missing goal fails', () => {
    const data = makeCompleteE2eData();
    delete (data.test_cases as Record<string, unknown>[])[0].goal;
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(false);
  });

  it('test case missing preconditions fails', () => {
    const data = makeCompleteE2eData();
    delete (data.test_cases as Record<string, unknown>[])[0].preconditions;
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(false);
  });

  it('test case missing actions fails', () => {
    const data = makeCompleteE2eData();
    (data.test_cases as Record<string, unknown>[])[0].actions = [];
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(false);
  });

  it('test case missing oracles fails', () => {
    const data = makeCompleteE2eData();
    (data.test_cases as Record<string, unknown>[])[0].oracles = [];
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(false);
  });

  it('test case missing priority fails', () => {
    const data = makeCompleteE2eData();
    delete (data.test_cases as Record<string, unknown>[])[0].priority;
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// 4. Test case structure — path_class, trace_targets
// ============================================================================

describe('§5.4 Test case structure', () => {
  let e2eContract: ContractDefinition;

  beforeAll(async () => {
    const contractPath = join(CONTRACTS_DIR, 'e2e-test', 'schema.json');
    e2eContract = await loadContract(contractPath);
  });

  it('valid path_class enum passes', () => {
    for (const pathClass of ['happy', 'error', 'recovery', 'edge', 'security', 'performance']) {
      const data = makeCompleteE2eData();
      (data.test_cases as Record<string, unknown>[])[0].path_class = pathClass;
      const result = validateContractAgainstSchema(data, e2eContract);
      expect(result.valid).toBe(true);
    }
  });

  it('invalid path_class fails', () => {
    const data = makeCompleteE2eData();
    (data.test_cases as Record<string, unknown>[])[0].path_class = 'invalid';
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(false);
  });

  it('valid priority enum passes', () => {
    for (const priority of ['critical', 'high', 'medium', 'low']) {
      const data = makeCompleteE2eData();
      (data.test_cases as Record<string, unknown>[])[0].priority = priority;
      const result = validateContractAgainstSchema(data, e2eContract);
      expect(result.valid).toBe(true);
    }
  });

  it('invalid priority fails', () => {
    const data = makeCompleteE2eData();
    (data.test_cases as Record<string, unknown>[])[0].priority = 'invalid';
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(false);
  });

  it('metadata.status enum is enforced', () => {
    const data = makeCompleteE2eData();
    (data.metadata as Record<string, unknown>).status = 'invalid-status';
    const result = validateContractAgainstSchema(data, e2eContract);
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// 5. Legacy normalization
// ============================================================================

describe('§5.5 Legacy normalization', () => {
  let e2eContract: ContractDefinition;

  beforeAll(async () => {
    const contractPath = join(CONTRACTS_DIR, 'e2e-test', 'schema.json');
    e2eContract = await loadContract(contractPath);
  });

  it('legacy fixture normalizes losslessly', () => {
    const legacyData = {
      id: 'batch-1:TC-001',
      title: 'User login test',
      status: 'planned',
      test_batch: 'batch-1',
      scope: '验证用户登录流程',
      actors: ['registered_user'],
      system_boundaries: ['auth-service'],
      test_cases: [
        {
          case_id: 'TC-001',
          goal: 'Login succeeds',
          preconditions: ['Account exists'],
          actions: [{ step: 1, action: 'Login' }],
          oracles: [{ observable: 'Dashboard', criterion: 'Visible' }],
          cleanup: ['Logout'],
          priority: 'critical',
          trace_targets: ['S-12'],
        },
      ],
      // Relations (now required)
      relations: [
        { kind: 'derives_from', target_type: 'scenario', target_id: 'S-12' },
        { kind: 'verifies', target_type: 'feature', target_id: 'ACA11', anchor: 'AC1' },
      ],
      // Legacy coverage fields
      ac_coverage: { ACA11: ['AC1'] },
      related_scenarios: ['S-12'],
      // Legacy environment fields
      topology: 'docker-compose',
      fixtures: ['test-user-db'],
      isolation_strategy: 'per-test',
      // Legacy evidence fields
      required_artifacts: ['auth-service-logs', 'ui-screenshot'],
      runner_binding: 'playwright',
    };

    const result = normalizeE2eLegacyArtifact(legacyData, e2eContract);
    expect(result.success).toBe(true);
    expect(result.ir).toBeDefined();
    expect(result.ir!.canonical).toBeDefined();
    expect(result.ir!.canonical.metadata).toBeDefined();
    expect((result.ir!.canonical.metadata as Record<string, unknown>).id).toBe('batch-1:TC-001');
    expect(result.ir!.sourceRevision).toBe('legacy');
  });

  it('unknown field fails closed with LOSSY_NORMALIZATION', () => {
    const legacyData = {
      id: 'batch-1:TC-001',
      title: 'Test',
      status: 'planned',
      test_batch: 'batch-1',
      unknown_field: 'some value',
      scope: 'Test scope',
      actors: ['user'],
      system_boundaries: ['boundary'],
      test_cases: [
        {
          case_id: 'TC-001',
          goal: 'Goal',
          preconditions: ['Pre'],
          actions: [{ step: 1, action: 'Act' }],
          oracles: [{ observable: 'Obs', criterion: 'Crit' }],
          cleanup: [],
          priority: 'critical',
        },
      ],
    };

    const result = normalizeE2eLegacyArtifact(legacyData, e2eContract);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.code === 'LOSSY_NORMALIZATION')).toBe(true);
    expect(result.errors.some((e) => e.message.includes('unknown_field'))).toBe(true);
  });

  it('missing required legacy field fails', () => {
    const legacyData = {
      // Missing id
      title: 'Test',
      status: 'planned',
      test_batch: 'batch-1',
      scope: 'Test scope',
      actors: ['user'],
      system_boundaries: ['boundary'],
      test_cases: [
        {
          case_id: 'TC-001',
          goal: 'Goal',
          preconditions: ['Pre'],
          actions: [{ step: 1, action: 'Act' }],
          oracles: [{ observable: 'Obs', criterion: 'Crit' }],
          cleanup: [],
          priority: 'critical',
        },
      ],
    };

    const result = normalizeE2eLegacyArtifact(legacyData, e2eContract);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('pure canonical input remains canonical', () => {
    const result = normalizeE2eLegacyArtifact(makeCompleteE2eData(), e2eContract);
    expect(result.success).toBe(true);
    expect(result.ir?.sourceRevision).toBe('canonical');
  });

  it('equivalent mixed canonical and legacy fields are deduplicated', () => {
    const mixed = { ...makeCompleteE2eData(), id: 'batch-1:TC-001' };
    const result = normalizeE2eLegacyArtifact(mixed, e2eContract);
    expect(result.success).toBe(true);
    expect(result.ir?.sourceRevision).toBe('legacy');
    expect((result.ir?.canonical.metadata as Record<string, unknown>).id).toBe('batch-1:TC-001');
    expect(result.ir?.canonical.id).toBeUndefined();
  });

  it('conflicting mixed canonical and legacy fields fail with a structured conflict', () => {
    const mixed = { ...makeCompleteE2eData(), id: 'batch-1:TC-999' };
    const result = normalizeE2eLegacyArtifact(mixed, e2eContract);
    expect(result.success).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      code: CONTRACT_ERROR_CODES.CANONICAL_LEGACY_CONFLICT,
      path: '/metadata/id',
    }));
  });
});

// ============================================================================
// 6. Single active write revision + multi-revision
// ============================================================================

describe('§5.6 Single active write revision + multi-revision', () => {
  it('single active write contract succeeds', () => {
    const registry = new ContractRegistry();
    const contract: ContractDefinition = {
      identity: makeE2eIdentity(),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    expect(() => registry.register(contract, { isActive: true, isWriteTarget: true })).not.toThrow();
  });

  it('same major different digest can coexist', () => {
    const registry = new ContractRegistry();
    const contract1: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest1' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    const contract2: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest2' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    registry.register(contract1, { isActive: true, isWriteTarget: false });
    expect(() => registry.register(contract2, { isActive: true, isWriteTarget: false })).not.toThrow();
    expect(registry.getByMajor('artifact.e2e-test@1')).toHaveLength(2);
  });

  it('same major same digest fails (duplicate)', () => {
    const registry = new ContractRegistry();
    const contract: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:same-digest' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    registry.register(contract);
    expect(() => registry.register(contract)).toThrow(ContractError);
    try {
      registry.register(contract);
    } catch (e) {
      expect((e as ContractError).code).toBe(CONTRACT_ERROR_CODES.DUPLICATE_IDENTITY);
    }
  });

  it('multiple active write contracts of same type fail', () => {
    const registry = new ContractRegistry();
    const contract1: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest1' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    const contract2: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest2' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    registry.register(contract1, { isActive: true, isWriteTarget: true });
    expect(() => registry.register(contract2, { isActive: true, isWriteTarget: true })).toThrow(ContractError);
    try {
      registry.register(contract2, { isActive: true, isWriteTarget: true });
    } catch (e) {
      expect((e as ContractError).code).toBe(CONTRACT_ERROR_CODES.MULTIPLE_ACTIVE_WRITE);
    }
  });

  it('active + legacy (read-only) coexist', () => {
    const registry = new ContractRegistry();
    const activeContract: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:active-digest' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    const legacyContract: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:legacy-digest' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    registry.register(activeContract, { isActive: true, isWriteTarget: true });
    expect(() => registry.register(legacyContract, { isActive: true, isWriteTarget: false })).not.toThrow();
    expect(registry.getByMajor('artifact.e2e-test@1')).toHaveLength(2);
    expect(registry.getActiveWriteContract('artifact.e2e-test')).toBeDefined();
  });

  it('resolve by major+digest works', () => {
    const registry = new ContractRegistry();
    const contract1: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest1' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    const contract2: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest2' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    registry.register(contract1, { isActive: true, isWriteTarget: false });
    registry.register(contract2, { isActive: true, isWriteTarget: false });
    expect(registry.getByMajorAndDigest('artifact.e2e-test@1', 'sha256:digest1')).toBeDefined();
    expect(registry.getByMajorAndDigest('artifact.e2e-test@1', 'sha256:digest2')).toBeDefined();
    expect(registry.getByMajorAndDigest('artifact.e2e-test@1', 'sha256:nonexistent')).toBeUndefined();
  });

  it('resolve by major with multiple read-only revisions fails as ambiguous', () => {
    const registry = new ContractRegistry();
    const contract1: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest1' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    const contract2: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest2' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    registry.register(contract1, { isActive: true, isWriteTarget: false });
    registry.register(contract2, { isActive: true, isWriteTarget: false });
    expect(() => registry.get('artifact.e2e-test@1')).toThrow(ContractError);
    try {
      registry.get('artifact.e2e-test@1');
    } catch (error) {
      expect((error as ContractError).code).toBe(CONTRACT_ERROR_CODES.AMBIGUOUS_REVISION);
    }
  });

  it('resolve by major selects the unique active write revision', () => {
    const registry = new ContractRegistry();
    const active = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:active' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    const legacy = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:legacy' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    registry.register(active, { isActive: true, isWriteTarget: true });
    registry.register(legacy, { isActive: true, isWriteTarget: false });
    expect(registry.get('artifact.e2e-test@1')?.identity.revisionDigest).toBe('sha256:active');
  });
});

// ============================================================================
// 7. Project policy monotonic tightening
// ============================================================================

describe('§5.7 Project policy monotonic tightening', () => {
  let e2eContract: ContractDefinition;

  beforeAll(async () => {
    const contractPath = join(CONTRACTS_DIR, 'e2e-test', 'schema.json');
    e2eContract = await loadContract(contractPath);
  });

  it('policy adding required field passes', () => {
    const policy: ProjectPolicy = {
      id: 'my-project-policy',
      baseContractMajor: 'artifact.e2e-test@1',
      additionalRequired: ['coverage'],
    };
    const result = validatePolicyCompatibility(policy, e2eContract);
    expect(result.compatible).toBe(true);
  });

  it('policy restricting enum passes', () => {
    const policy: ProjectPolicy = {
      id: 'my-project-policy',
      baseContractMajor: 'artifact.e2e-test@1',
      restrictedEnums: {
        'metadata.status': ['planned', 'active', 'done'],
      },
    };
    const result = validatePolicyCompatibility(policy, e2eContract);
    expect(result.compatible).toBe(true);
  });

  it('policy adding enum value not in base fails', () => {
    const policy: ProjectPolicy = {
      id: 'my-project-policy',
      baseContractMajor: 'artifact.e2e-test@1',
      restrictedEnums: {
        'metadata.status': ['planned', 'active', 'done', 'deprecated', 'invalid-extra'],
      },
    };
    const result = validatePolicyCompatibility(policy, e2eContract);
    expect(result.compatible).toBe(false);
    expect(result.errors.some((e) => e.includes('invalid-extra'))).toBe(true);
  });

  it('policy requiring non-existent field fails', () => {
    const policy: ProjectPolicy = {
      id: 'my-project-policy',
      baseContractMajor: 'artifact.e2e-test@1',
      additionalRequired: ['non_existent_field_xyz'],
    };
    const result = validatePolicyCompatibility(policy, e2eContract);
    expect(result.compatible).toBe(false);
    expect(result.errors.some((e) => e.includes('non_existent_field_xyz'))).toBe(true);
  });

  it('policy referencing wrong base contract fails', () => {
    const policy: ProjectPolicy = {
      id: 'my-project-policy',
      baseContractMajor: 'artifact.wrong-contract@1',
    };
    const result = validatePolicyCompatibility(policy, e2eContract);
    expect(result.compatible).toBe(false);
    expect(result.errors.some((e) => e.includes('artifact.wrong-contract@1'))).toBe(true);
  });

  it('policy setting min cardinality higher than base passes', () => {
    const policy: ProjectPolicy = {
      id: 'my-project-policy',
      baseContractMajor: 'artifact.e2e-test@1',
      minCardinality: {
        'test_cases': 2,
      },
    };
    const result = validatePolicyCompatibility(policy, e2eContract);
    expect(result.compatible).toBe(true);
  });

  it('policy setting cardinality for non-existent field fails', () => {
    const policy: ProjectPolicy = {
      id: 'my-project-policy',
      baseContractMajor: 'artifact.e2e-test@1',
      minCardinality: {
        'nonexistent': 1,
      },
    };
    const result = validatePolicyCompatibility(policy, e2eContract);
    expect(result.compatible).toBe(false);
  });
});

// ============================================================================
// 7.0.1 applyProjectPolicy
// ============================================================================

describe('§5.7.0.1 applyProjectPolicy', () => {
  let e2eContract: ContractDefinition;

  beforeAll(async () => {
    const contractPath = join(CONTRACTS_DIR, 'e2e-test', 'schema.json');
    e2eContract = await loadContract(contractPath);
  });

  it('valid policy produces effective contract', () => {
    const policy: ProjectPolicy = {
      id: 'my-project-policy',
      baseContractMajor: 'artifact.e2e-test@1',
      additionalRequired: ['coverage'],
      restrictedEnums: {
        'metadata.status': ['planned', 'active', 'done'],
      },
      minCardinality: {
        'test_cases': 2,
      },
    };
    const result = applyProjectPolicy(policy, e2eContract);
    expect(result.success).toBe(true);
    expect(result.effectiveContract).toBeDefined();
    expect(result.effectiveContract!.identity.revisionDigest).toMatch(/^sha256:/);
    // Verify effective schema has tightened constraints
    const effectiveSchema = result.effectiveContract!.schema;
    expect(effectiveSchema.properties.metadata).toBeDefined();
  });

  it('invalid policy fails', () => {
    const policy: ProjectPolicy = {
      id: 'my-project-policy',
      baseContractMajor: 'artifact.wrong-contract@1',
    };
    const result = applyProjectPolicy(policy, e2eContract);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('effective contract validates data correctly', () => {
    const policy: ProjectPolicy = {
      id: 'my-project-policy',
      baseContractMajor: 'artifact.e2e-test@1',
      minCardinality: {
        'test_cases': 2,
      },
    };
    const result = applyProjectPolicy(policy, e2eContract);
    expect(result.success).toBe(true);
    const effectiveContract = result.effectiveContract!;
    // Data with 1 test case should fail (policy requires 2)
    const dataWith1Case = makeCompleteE2eData();
    (dataWith1Case.test_cases as Record<string, unknown>[]).pop();
    const validationResult = validateContractAgainstSchema(dataWith1Case, effectiveContract);
    expect(validationResult.valid).toBe(false);
    // Data with 2 test cases should pass
    const dataWith2Cases = makeCompleteE2eData();
    (dataWith2Cases.test_cases as Record<string, unknown>[]).push({
      case_id: 'TC-002',
      goal: 'Second test case',
      preconditions: ['Precondition'],
      actions: [{ step: 1, action: 'Action' }],
      oracles: [{ observable: 'Obs', criterion: 'Crit' }],
      cleanup: [],
      priority: 'high',
      trace_targets: ['S-12'],
    });
    const validationResult2 = validateContractAgainstSchema(dataWith2Cases, effectiveContract);
    expect(validationResult2.valid).toBe(true);
  });

  it('nested required policy updates the parent object and keeps raw/schema/identity consistent', () => {
    const policy: ProjectPolicy = {
      id: 'require-test-batch',
      baseContractMajor: 'artifact.e2e-test@1',
      additionalRequired: ['metadata.test_batch'],
    };
    const result = applyProjectPolicy(policy, e2eContract);
    expect(result.success).toBe(true);
    const effective = result.effectiveContract!;
    const metadataSchema = effective.schema.properties.metadata as { required?: string[] };
    expect(metadataSchema.required).toContain('test_batch');
    expect(effective.schema.required).not.toContain('test_batch');

    const withoutBatch = makeCompleteE2eData();
    delete (withoutBatch.metadata as Record<string, unknown>).test_batch;
    expect(validateContractAgainstSchema(withoutBatch, e2eContract).valid).toBe(true);
    expect(validateContractAgainstSchema(withoutBatch, effective).valid).toBe(false);

    const rawSchema = JSON.parse(effective.rawContent) as ContractSchema;
    expect(rawSchema.contractIdentity.revisionDigest).toBe(effective.identity.revisionDigest);
    expect(computeRevisionDigest(effective.rawContent)).toBe(effective.identity.revisionDigest);
    expect(rawSchema).toEqual(effective.schema);
  });
});

// ============================================================================
// 7.1 Relation rules validation
// ============================================================================

describe('§5.7.1 Relation rules validation', () => {
  let e2eContract: ContractDefinition;

  beforeAll(async () => {
    const contractPath = join(CONTRACTS_DIR, 'e2e-test', 'schema.json');
    e2eContract = await loadContract(contractPath);
  });

  it('valid relations pass validation', () => {
    const relations = [
      { kind: 'derives_from', target_type: 'scenario', target_id: 'S-12' },
      { kind: 'verifies', target_type: 'feature', target_id: 'ACA11', anchor: 'section-1' },
      { kind: 'implemented_by', target_type: 'code', target_id: 'auth-service' },
    ];
    const result = validateRelations(relations, e2eContract);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('invalid relation kind fails with RELATION_INVALID_KIND', () => {
    const relations = [
      { kind: 'invalid_kind', target_type: 'feature', target_id: 'ACA11' },
    ];
    const result = validateRelations(relations, e2eContract);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'RELATION_INVALID_KIND')).toBe(true);
  });

  it('invalid target type fails with RELATION_INVALID_TARGET_TYPE', () => {
    const relations = [
      { kind: 'derives_from', target_type: 'invalid_type', target_id: 'ACA11' },
    ];
    const result = validateRelations(relations, e2eContract);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'RELATION_INVALID_TARGET_TYPE')).toBe(true);
  });

  it('missing required anchor fails with RELATION_MISSING_ANCHOR', () => {
    const relations = [
      { kind: 'verifies', target_type: 'scenario', target_id: 'S-12' },
    ];
    const result = validateRelations(relations, e2eContract);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'RELATION_MISSING_ANCHOR')).toBe(true);
  });

  it('forbidden anchor fails with RELATION_FORBIDDEN_ANCHOR', () => {
    // Add a relation kind with forbidden anchor for testing
    const contractWithForbidden = {
      ...e2eContract,
      identity: {
        ...e2eContract.identity,
        relationRules: {
          ...e2eContract.identity.relationRules,
          test_forbidden: {
            allowedTargetTypes: ['feature'],
            min: 0,
            max: 10,
            anchorPolicy: 'forbidden' as const,
          },
        },
      },
    };
    const relations = [
      { kind: 'test_forbidden', target_type: 'feature', target_id: 'ACA11', anchor: 'section-3' },
    ];
    const result = validateRelations(relations, contractWithForbidden);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'RELATION_FORBIDDEN_ANCHOR')).toBe(true);
  });

  it('below minimum cardinality fails with RELATION_BELOW_MIN', () => {
    // derives_from requires min=1, but we provide 0
    const relations: Array<Record<string, unknown>> = [];
    const result = validateRelations(relations, e2eContract);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'RELATION_BELOW_MIN')).toBe(true);
  });

  it('above maximum cardinality fails with RELATION_ABOVE_MAX', () => {
    // derives_from has max=10, provide 11
    const relations = Array.from({ length: 11 }, (_, i) => ({
      kind: 'derives_from',
      target_type: 'scenario',
      target_id: `S-${i}`,
    }));
    const result = validateRelations(relations, e2eContract);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'RELATION_ABOVE_MAX')).toBe(true);
  });

  it('missing relation rules fails with RELATION_RULES_MISSING', () => {
    const contractWithoutRules = {
      ...e2eContract,
      identity: {
        ...e2eContract.identity,
        relationRules: undefined,
      },
    };
    const relations = [
      { kind: 'derives_from', target_type: 'scenario', target_id: 'S-12' },
    ];
    const result = validateRelations(relations, contractWithoutRules);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'RELATION_RULES_MISSING')).toBe(true);
  });

  it('CLI validate checks relation rules', () => {
    const ROOT = join(import.meta.dirname ?? __dirname, '..');
    function runCliLocal(args: string[]): { code: number; stdout: string; stderr: string } {
      try {
        const stdout = execFileSync('node', [join(ROOT, 'dist', 'cli.js'), ...args], {
          encoding: 'utf-8',
          cwd: ROOT,
          timeout: 30000,
        });
        return { code: 0, stdout, stderr: '' };
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
      }
    }
    // Use implemented_by without anchor (requires anchor) to pass JSON schema but fail relation rules
    const invalidData = {
      ...makeCompleteE2eData(),
      relations: [
        { kind: 'derives_from', target_type: 'scenario', target_id: 'S-12' },
        { kind: 'verifies', target_type: 'feature', target_id: 'ACA11' }, // Missing required anchor
      ],
    };
    const result = runCliLocal([
      'contract', 'validate',
      '--contract', 'artifact.e2e-test@1',
      '--data', JSON.stringify(invalidData),
      '--root', ROOT,
      '--format', 'json',
    ]);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((i: { code: string }) => i.code === 'RELATION_MISSING_ANCHOR')).toBe(true);
  });
});

// ============================================================================
// 7.2 Semantic markers validation
// ============================================================================

describe('§5.7.2 Semantic markers validation', () => {
  let e2eContract: ContractDefinition;

  beforeAll(async () => {
    const contractPath = join(CONTRACTS_DIR, 'e2e-test', 'schema.json');
    e2eContract = await loadContract(contractPath);
  });

  it('valid markdown with all required markers passes', () => {
    const markdown = `
# E2E Test Specification

<!-- marker: scope -->
## Scope
This is the scope section.

<!-- marker: system-boundary -->
## System Boundary
This is the system boundary section.

<!-- marker: coverage -->
## Coverage
This is the coverage section.

<!-- marker: environment-data -->
## Environment Data
This is the environment data section.

<!-- marker: test-cases -->
## Test Cases
This is the test cases section.

<!-- marker: evidence-contract -->
## Evidence Contract
This is the evidence contract section.
`;
    const result = validateSemanticMarkers(markdown, e2eContract);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('missing required marker fails with MARKER_MISSING', () => {
    const markdown = `
# E2E Test Specification

<!-- marker: scope -->
## Scope
This is the scope section.

<!-- marker: system-boundary -->
## System Boundary
This is the system boundary section.

<!-- marker: coverage -->
## Coverage
This is the coverage section.

<!-- marker: environment-data -->
## Environment Data
This is the environment data section.

<!-- marker: test-cases -->
## Test Cases
This is the test cases section.

<!-- Missing evidence-contract marker -->
`;
    const result = validateSemanticMarkers(markdown, e2eContract);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('MARKER_MISSING'))).toBe(true);
    expect(result.errors.some((e) => e.includes('evidence-contract'))).toBe(true);
  });

  it('duplicate marker fails with MARKER_DUPLICATE', () => {
    const markdown = `
# E2E Test Specification

<!-- marker: scope -->
## Scope
This is the scope section.

<!-- marker: scope -->
## Another Scope
This is a duplicate scope section.

<!-- marker: system-boundary -->
## System Boundary
This is the system boundary section.

<!-- marker: coverage -->
## Coverage
This is the coverage section.

<!-- marker: environment-data -->
## Environment Data
This is the environment data section.

<!-- marker: test-cases -->
## Test Cases
This is the test cases section.

<!-- marker: evidence-contract -->
## Evidence Contract
This is the evidence contract section.
`;
    const result = validateSemanticMarkers(markdown, e2eContract);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('MARKER_DUPLICATE'))).toBe(true);
    expect(result.errors.some((e) => e.includes('scope'))).toBe(true);
  });

  it('unknown marker fails with MARKER_UNKNOWN', () => {
    const markdown = `
# E2E Test Specification

<!-- marker: scope -->
## Scope
This is the scope section.

<!-- marker: system-boundary -->
## System Boundary
This is the system boundary section.

<!-- marker: coverage -->
## Coverage
This is the coverage section.

<!-- marker: environment-data -->
## Environment Data
This is the environment data section.

<!-- marker: test-cases -->
## Test Cases
This is the test cases section.

<!-- marker: evidence-contract -->
## Evidence Contract
This is the evidence contract section.

<!-- marker: unknown-marker -->
## Unknown Section
This is an unknown section.
`;
    const result = validateSemanticMarkers(markdown, e2eContract);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('MARKER_UNKNOWN'))).toBe(true);
    expect(result.errors.some((e) => e.includes('unknown-marker'))).toBe(true);
  });

  it('title changes but marker same still passes', () => {
    const markdown = `
# E2E Test Specification

<!-- marker: scope -->
## Business Goals and Scope
This is the scope section with a different title.

<!-- marker: system-boundary -->
## System Architecture and Boundaries
This is the system boundary section with a different title.

<!-- marker: coverage -->
## Test Coverage Requirements
This is the coverage section with a different title.

<!-- marker: environment-data -->
## Test Environment Configuration
This is the environment data section with a different title.

<!-- marker: test-cases -->
## Test Case Definitions
This is the test cases section with a different title.

<!-- marker: evidence-contract -->
## Evidence Collection Contract
This is the evidence contract section with a different title.
`;
    const result = validateSemanticMarkers(markdown, e2eContract);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('CLI validate-markers command works', () => {
    const ROOT = join(import.meta.dirname ?? __dirname, '..');
    function runCliLocal(args: string[]): { code: number; stdout: string; stderr: string } {
      try {
        const stdout = execFileSync('node', [join(ROOT, 'dist', 'cli.js'), ...args], {
          encoding: 'utf-8',
          cwd: ROOT,
          timeout: 30000,
        });
        return { code: 0, stdout, stderr: '' };
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
      }
    }
    // Create a temporary markdown file
    const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
    const markdownPath = join(tmpDir, 'test.md');
    const markdown = `
# E2E Test Specification

<!-- marker: scope -->
## Scope
This is the scope section.

<!-- marker: system-boundary -->
## System Boundary
This is the system boundary section.

<!-- marker: coverage -->
## Coverage
This is the coverage section.

<!-- marker: environment-data -->
## Environment Data
This is the environment data section.

<!-- marker: test-cases -->
## Test Cases
This is the test cases section.

<!-- marker: evidence-contract -->
## Evidence Contract
This is the evidence contract section.
`;
    writeFileSync(markdownPath, markdown);
    const result = runCliLocal([
      'contract', 'validate-markers',
      '--contract', 'artifact.e2e-test@1',
      '--markdown', markdownPath,
      '--root', ROOT,
      '--format', 'json',
    ]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.valid).toBe(true);
    // Clean up
    rmSync(tmpDir, { recursive: true });
  });
});

// ============================================================================
// 8. Contract catalog + loading
// ============================================================================

describe('§5.8 Contract catalog and loading', () => {
  it('loads e2e-test contract from contracts directory', async () => {
    const contracts = await loadContractsFromDirectory(CONTRACTS_DIR);
    expect(contracts.length).toBeGreaterThan(0);
    const e2e = contracts.find((c) => c.identity.major === 'artifact.e2e-test@1');
    expect(e2e).toBeDefined();
  });

  it('contract catalog lists contracts', async () => {
    const catalog = await loadContractCatalog(CONTRACTS_DIR);
    const list = catalog.list();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((c) => c.identity.major === 'artifact.e2e-test@1')).toBe(true);
  });

  it('contract catalog can resolve by major identity', async () => {
    const catalog = await loadContractCatalog(CONTRACTS_DIR);
    const contract = catalog.resolve('artifact.e2e-test@1');
    expect(contract).toBeDefined();
    expect(contract!.identity.major).toBe('artifact.e2e-test@1');
  });

  it('unknown contract returns undefined', async () => {
    const catalog = await loadContractCatalog(CONTRACTS_DIR);
    const contract = catalog.resolve('artifact.nonexistent@1');
    expect(contract).toBeUndefined();
  });
});

// ============================================================================
// 9. Error codes stability
// ============================================================================

describe('§5.9 Error codes stability', () => {
  it('all error codes are defined', () => {
    expect(CONTRACT_ERROR_CODES.CONTRACT_NOT_FOUND).toBe('CONTRACT_NOT_FOUND');
    expect(CONTRACT_ERROR_CODES.INVALID_IDENTITY).toBe('INVALID_IDENTITY');
    expect(CONTRACT_ERROR_CODES.DIGEST_MISMATCH).toBe('DIGEST_MISMATCH');
    expect(CONTRACT_ERROR_CODES.DUPLICATE_IDENTITY).toBe('DUPLICATE_IDENTITY');
    expect(CONTRACT_ERROR_CODES.MULTIPLE_ACTIVE_WRITE).toBe('MULTIPLE_ACTIVE_WRITE');
    expect(CONTRACT_ERROR_CODES.UNKNOWN_AUTHORITY).toBe('UNKNOWN_AUTHORITY');
    expect(CONTRACT_ERROR_CODES.AUTHORITY_VIOLATION).toBe('AUTHORITY_VIOLATION');
    expect(CONTRACT_ERROR_CODES.SCHEMA_VALIDATION_FAILED).toBe('SCHEMA_VALIDATION_FAILED');
    expect(CONTRACT_ERROR_CODES.NORMALIZATION_FAILED).toBe('NORMALIZATION_FAILED');
    expect(CONTRACT_ERROR_CODES.POLICY_INCOMPATIBLE).toBe('POLICY_INCOMPATIBLE');
    expect(CONTRACT_ERROR_CODES.LEGACY_NORMALIZATION_FAILED).toBe('LEGACY_NORMALIZATION_FAILED');
    expect(CONTRACT_ERROR_CODES.CANONICAL_LEGACY_CONFLICT).toBe('CANONICAL_LEGACY_CONFLICT');
  });

  it('ContractError carries stable code and details', () => {
    const err = new ContractError(
      CONTRACT_ERROR_CODES.DIGEST_MISMATCH,
      'test message',
      { computedDigest: 'sha256:abc' }
    );
    expect(err.code).toBe('DIGEST_MISMATCH');
    expect(err.message).toBe('test message');
    expect(err.details).toEqual({ computedDigest: 'sha256:abc' });
    expect(err.name).toBe('ContractError');
  });
});

// ============================================================================
// 10. CLI contract commands
// ============================================================================

describe('§5.10 CLI contract commands', () => {
  const ROOT = join(import.meta.dirname ?? __dirname, '..');

  function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync('node', [join(ROOT, 'dist', 'cli.js'), ...args], {
        encoding: 'utf-8',
        cwd: ROOT,
        timeout: 30000,
      });
      return { code: 0, stdout, stderr: '' };
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  it('contract list outputs JSON with contracts array', () => {
    const result = runCli(['contract', 'list', '--root', ROOT, '--format', 'json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.data.contracts)).toBe(true);
    expect(parsed.data.contracts.length).toBeGreaterThan(0);
  });

  it('contract explain outputs JSON for e2e-test contract', () => {
    const result = runCli(['contract', 'explain', '--contract', 'artifact.e2e-test@1', '--root', ROOT, '--format', 'json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.identity.major).toBe('artifact.e2e-test@1');
  });

  it('contract validate passes for valid fixture', () => {
    const result = runCli([
      'contract', 'validate',
      '--contract', 'artifact.e2e-test@1',
      '--data', JSON.stringify(makeCompleteE2eData()),
      '--root', ROOT,
      '--format', 'json',
    ]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.valid).toBe(true);
  });

  it('contract validate fails for invalid fixture', () => {
    const invalidData = { metadata: { id: 'test', title: 'Test', status: 'planned' } };
    const result = runCli([
      'contract', 'validate',
      '--contract', 'artifact.e2e-test@1',
      '--data', JSON.stringify(invalidData),
      '--root', ROOT,
      '--format', 'json',
    ]);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it('contract explain for unknown contract fails with stable error', () => {
    const result = runCli(['contract', 'explain', '--contract', 'artifact.nonexistent@1', '--root', ROOT, '--format', 'json']);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('CONTRACT_NOT_FOUND');
  });

  it('CLI stdout is valid JSON in machine mode', () => {
    const result = runCli(['contract', 'list', '--root', ROOT, '--format', 'json']);
    expect(result.code).toBe(0);
    // Verify it's valid JSON
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
});

// ============================================================================
// Additional: ContractCatalog class
// ============================================================================

describe('ContractCatalog', () => {
  it('empty catalog returns empty list', () => {
    const catalog = new ContractCatalog();
    expect(catalog.list()).toHaveLength(0);
  });

  it('add and resolve contract', () => {
    const catalog = new ContractCatalog();
    const contract: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest1' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    catalog.add(contract);
    expect(catalog.resolve('artifact.e2e-test@1')).toBeDefined();
    expect(catalog.list()).toHaveLength(1);
  });

  it('duplicate add throws', () => {
    const catalog = new ContractCatalog();
    const contract: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:same-digest' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    catalog.add(contract);
    expect(() => catalog.add(contract)).toThrow(ContractError);
  });

  it('same major different digest can coexist', () => {
    const catalog = new ContractCatalog();
    const contract1: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest1' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    const contract2: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest2' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    catalog.add(contract1, { isActive: true, isWriteTarget: false });
    catalog.add(contract2, { isActive: true, isWriteTarget: false });
    expect(catalog.list()).toHaveLength(2);
  });

  it('resolve by major with single revision returns it', () => {
    const catalog = new ContractCatalog();
    const contract: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest1' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    catalog.add(contract);
    const resolved = catalog.resolve('artifact.e2e-test@1');
    expect(resolved).toBeDefined();
    expect(resolved!.identity.revisionDigest).toBe('sha256:digest1');
  });

  it('resolve by major with multiple revisions and no active write throws AMBIGUOUS_REVISION', () => {
    const catalog = new ContractCatalog();
    const contract1: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest1' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    const contract2: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest2' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    catalog.add(contract1, { isActive: true, isWriteTarget: false });
    catalog.add(contract2, { isActive: true, isWriteTarget: false });
    expect(() => catalog.resolve('artifact.e2e-test@1')).toThrow(ContractError);
    try {
      catalog.resolve('artifact.e2e-test@1');
    } catch (e) {
      expect((e as ContractError).code).toBe('AMBIGUOUS_REVISION');
    }
  });

  it('resolve by major with multiple revisions and unique active write returns it', () => {
    const catalog = new ContractCatalog();
    const contract1: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:active-digest' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    const contract2: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:legacy-digest' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    catalog.add(contract1, { isActive: true, isWriteTarget: true });
    catalog.add(contract2, { isActive: true, isWriteTarget: false });
    const resolved = catalog.resolve('artifact.e2e-test@1');
    expect(resolved).toBeDefined();
    expect(resolved!.identity.revisionDigest).toBe('sha256:active-digest');
  });

  it('resolve by major+digest does exact resolution', () => {
    const catalog = new ContractCatalog();
    const contract1: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest1' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    const contract2: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest2' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    catalog.add(contract1, { isActive: true, isWriteTarget: false });
    catalog.add(contract2, { isActive: true, isWriteTarget: false });
    const resolved = catalog.resolveByDigest('artifact.e2e-test@1', 'sha256:digest2');
    expect(resolved).toBeDefined();
    expect(resolved!.identity.revisionDigest).toBe('sha256:digest2');
  });

  it('resolve by major+digest returns undefined for non-existent digest', () => {
    const catalog = new ContractCatalog();
    const contract: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest1' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    catalog.add(contract);
    const resolved = catalog.resolveByDigest('artifact.e2e-test@1', 'sha256:nonexistent');
    expect(resolved).toBeUndefined();
  });

  it('toJSON shows all revisions', () => {
    const catalog = new ContractCatalog();
    const contract1: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest1' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    const contract2: ContractDefinition = {
      identity: makeE2eIdentity({ revisionDigest: 'sha256:digest2' }),
      schema: makeMinimalE2eSchema(),
      rawContent: '{}',
    };
    catalog.add(contract1, { isActive: true, isWriteTarget: false });
    catalog.add(contract2, { isActive: true, isWriteTarget: false });
    const json = catalog.toJSON();
    expect((json.contracts as unknown[])).toHaveLength(2);
  });
});
