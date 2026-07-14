/**
 * packet-validator.ts
 *
 * Schema validation for implementation packets.
 * Validates both structured JSON packets and rendered Markdown packets.
 *
 * v1.12: accepts optional schema to derive valid target types dynamically.
 * Without schema, falls back to the static VALID_PACKET_TARGET_TYPES list.
 */
import type { ImplementationPacket } from './packet-assembler.js';
import { BASELINE_CONSTRAINTS_COUNT, BASELINE_ITEMS_COUNT } from './packet-constants.js';

/** Minimum required validation commands */
const MIN_VALIDATION_COMMANDS = 4;

/** Valid target types for packets (legacy static fallback) */
export const VALID_PACKET_TARGET_TYPES = ['feature', 'scenario', 'decision', 'design', 'e2e_test'] as const;
export type PacketTargetType = typeof VALID_PACKET_TARGET_TYPES[number];

export function isPacketTargetType(type: string): type is PacketTargetType {
  return (VALID_PACKET_TARGET_TYPES as readonly string[]).includes(type);
}

/**
 * Check whether a type is a valid packet target, optionally using a loaded schema.
 * When a schema is provided, uses dynamic target-capable types.
 * Without schema, uses the static VALID_PACKET_TARGET_TYPES.
 */
type PacketTargetSchema = {
  types: Record<string, { target?: boolean; role?: string }>;
  idPatterns?: Record<string, string>;
};

export function isPacketTargetTypeDynamic(type: string, schema?: PacketTargetSchema): boolean {
  if (schema) {
    const definition = schema.types[type];
    if (!definition) return false;
    if (definition.target === true) return true;
    // Match getArtifactTypeMetadata: legacy types are implicitly target-capable
    // only while their configured role remains the canonical type name.
    return isPacketTargetType(type) && definition.role === type;
  }
  return isPacketTargetType(type);
}

const VALID_TARGET_TYPES = [...VALID_PACKET_TARGET_TYPES];

// ── Public types ──

export interface PacketValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
}

export interface PacketValidationResult {
  ok: boolean;
  issues: PacketValidationIssue[];
}

// ── Structured packet validation ──

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
export function validatePacket(
  packet: ImplementationPacket,
  schema?: PacketTargetSchema,
): PacketValidationResult {
  const issues: PacketValidationIssue[] = [];

  // PKT-001: schemaVersion
  if (packet.schemaVersion !== '1.0') {
    issues.push({
      severity: 'error',
      code: 'PKT-001',
      message: `schemaVersion must be "1.0", got "${packet.schemaVersion}"`,
      path: 'schemaVersion',
    });
  }

  // PKT-002: target.type — validate shape only; allowability determined by loaded schema
  if (!isPacketTargetTypeDynamic(packet.target.type, schema)) {
    const validTypes = schema
      ? Object.keys(schema.types).filter((t) => isPacketTargetTypeDynamic(t, schema))
      : VALID_TARGET_TYPES;
    issues.push({
      severity: 'error',
      code: 'PKT-002',
      message: `target.type must be one of [${validTypes.join(', ')}], got "${packet.target.type}"`,
      path: 'target.type',
    });
  }

  // PKT-003: target.id non-empty
  if (!packet.target.id || packet.target.id.trim().length === 0) {
    issues.push({
      severity: 'error',
      code: 'PKT-003',
      message: 'target.id must be non-empty',
      path: 'target.id',
    });
  }

  // PKT-004: requiredBaseline.total === BASELINE_ITEMS_COUNT
  if (packet.requiredBaseline.total !== BASELINE_ITEMS_COUNT) {
    issues.push({
      severity: 'error',
      code: 'PKT-004',
      message: `requiredBaseline.total must be ${BASELINE_ITEMS_COUNT}, got ${packet.requiredBaseline.total}`,
      path: 'requiredBaseline.total',
    });
  }

  // PKT-005: constraints count and C-RULE-01 presence
  const constraints = packet.implementationBlueprintDraft.constraints;
  if (constraints.length !== BASELINE_CONSTRAINTS_COUNT) {
    issues.push({
      severity: 'error',
      code: 'PKT-005',
      message: `constraints must have exactly ${BASELINE_CONSTRAINTS_COUNT} entries, got ${constraints.length}`,
      path: 'implementationBlueprintDraft.constraints',
    });
  }
  const hasCRule01 = constraints.some((c) => c.id === 'C-RULE-01');
  if (!hasCRule01) {
    issues.push({
      severity: 'error',
      code: 'PKT-005',
      message: 'constraints must include C-RULE-01 (SEC severity must not be downgraded)',
      path: 'implementationBlueprintDraft.constraints',
    });
  }

  // PKT-006: validationCommands minimum count
  if (packet.validationCommands.length < MIN_VALIDATION_COMMANDS) {
    issues.push({
      severity: 'error',
      code: 'PKT-006',
      message: `validationCommands must have at least ${MIN_VALIDATION_COMMANDS} entries, got ${packet.validationCommands.length}`,
      path: 'validationCommands',
    });
  }

  // PKT-007: missing is an error
  if (packet.missing.length > 0) {
    issues.push({
      severity: 'error',
      code: 'PKT-007',
      message: `packet has ${packet.missing.length} missing artifact(s): ${packet.missing.join(', ')}`,
      path: 'missing',
    });
  }

  // PKT-009: recommendedReviewOrder must be a non-empty array
  const reviewOrder = packet.implementationBlueprintDraft.recommendedReviewOrder;
  if (!Array.isArray(reviewOrder) || reviewOrder.length === 0) {
    issues.push({
      severity: 'error',
      code: 'PKT-009',
      message: 'recommendedReviewOrder must be a non-empty array',
      path: 'implementationBlueprintDraft.recommendedReviewOrder',
    });
  } else {
    for (const step of reviewOrder) {
      if (typeof step.step !== 'number' || !step.category || !step.reason) {
        issues.push({
          severity: 'error',
          code: 'PKT-009',
          message: 'each recommendedReviewOrder entry must have step (number), category (string), and reason (string)',
          path: 'implementationBlueprintDraft.recommendedReviewOrder',
        });
        break;
      }
    }
  }

  // PKT-010: riskChecklist must be a non-empty array
  const riskChecklist = packet.implementationBlueprintDraft.riskChecklist;
  if (!Array.isArray(riskChecklist) || riskChecklist.length === 0) {
    issues.push({
      severity: 'error',
      code: 'PKT-010',
      message: 'riskChecklist must be a non-empty array',
      path: 'implementationBlueprintDraft.riskChecklist',
    });
  } else {
    for (const risk of riskChecklist) {
      if (!risk.id || !risk.description || typeof risk.checked !== 'boolean') {
        issues.push({
          severity: 'error',
          code: 'PKT-010',
          message: 'each riskChecklist entry must have id (string), description (string), and checked (boolean)',
          path: 'implementationBlueprintDraft.riskChecklist',
        });
        break;
      }
    }
  }

  const hasError = issues.some((i) => i.severity === 'error');
  return { ok: !hasError, issues };
}

// ── Markdown packet validation ──

/** Required section headings in rendered packet Markdown */
const REQUIRED_SECTIONS = [
  '## 1. 实现目标',
  '## 2. 上下文清单摘要',
  '## 3. Required Baseline（必读制品）',
  '## 8. Implementation Blueprint Draft（实现蓝图草案）',
  '### 8.3 约束与边界',
  '### 8.4 验证命令',
  '### 8.5 推荐审阅顺序',
  '### 8.6 风险检查清单',
];

/**
 * Validate a rendered Markdown packet for required section structure.
 *
 * Checks that all required section headings are present.
 */
export function validatePacketMarkdown(markdown: string): PacketValidationResult {
  const issues: PacketValidationIssue[] = [];

  for (const section of REQUIRED_SECTIONS) {
    if (!markdown.includes(section)) {
      issues.push({
        severity: 'error',
        code: 'PKT-008',
        message: `missing required section: "${section}"`,
        path: 'markdown',
      });
    }
  }

  const hasError = issues.some((i) => i.severity === 'error');
  return { ok: !hasError, issues };
}
