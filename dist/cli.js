#!/usr/bin/env node

// src/cli.ts
import yaml2 from "js-yaml";
import { realpathSync } from "fs";
import { access as access2, readFile as readFile4, writeFile as writeFile6 } from "fs/promises";
import { join as join6 } from "path";
import { fileURLToPath } from "url";

// src/index.ts
import Database from "better-sqlite3";
import matter from "gray-matter";
import yaml from "js-yaml";
import { mkdir as mkdir4, readFile as readFile3, readdir, writeFile as writeFile4 } from "fs/promises";
import { basename, dirname as dirname3, extname, join as join4, relative as relative2 } from "path";

// src/packet-constants.ts
var ALWAYS_PRESENT_ITEMS = [
  { path: "AGENTS.md", reason: "project agent instructions" },
  { path: "CLAUDE.md", reason: "project instructions" },
  { path: "artifacts/artifact-chain-spec.md", reason: "artifact chain specification" },
  { path: "artifacts/blueprints/generation-packet-spec.md", reason: "generation packet spec" },
  { path: "artifacts/blueprints/implementation-blueprint.md", reason: "implementation blueprint" },
  { path: "artifacts/contracts/interface-contracts.md", reason: "interface contracts" },
  { path: "artifacts/contracts/data-contracts.md", reason: "data contracts" },
  { path: "artifacts/contracts/application-state-machines.md", reason: "application state machines" },
  { path: "artifacts/contracts/error-model.md", reason: "error model" },
  { path: "artifacts/contracts/report-contracts.md", reason: "report contracts" },
  { path: "artifacts/contracts/ui-flow-contracts.md", reason: "UI flow contracts" },
  { path: "artifacts/contracts/non-functional-budgets.md", reason: "non-functional budgets" },
  { path: "artifacts/domain/domain-glossary.md", reason: "domain glossary" },
  { path: "artifacts/domain/bounded-context-map.md", reason: "bounded context map" },
  { path: "artifacts/domain/domain-invariants.md", reason: "domain invariants" },
  { path: "artifacts/tests/rule-golden-cases.md", reason: "rule golden cases" },
  { path: "artifacts/tests/verification-fixtures.md", reason: "verification fixtures" },
  { path: "artifacts/design/test-strategy.md", reason: "test strategy" },
  { path: "artifacts/traceability-matrix-v2.md", reason: "traceability matrix" }
];
var BASELINE_ITEMS_COUNT = ALWAYS_PRESENT_ITEMS.length;
var BASELINE_CONSTRAINTS = [
  { id: "C-ARCH-01", description: "\u6280\u672F\u6808\u5FC5\u987B\u4E3A TypeScript \u5168\u6808", source: "artifacts/decisions/D-ARCH-01.md" },
  { id: "C-ARCH-03", description: "\u4E0D\u53EF\u5728 Quick Check \u8DEF\u5F84\u5F15\u5165 LLM", source: "artifacts/decisions/D-ARCH-03.md" },
  { id: "C-ARCH-05", description: "\u4EA7\u54C1\u5F62\u6001\u4E3A Tauri v2 \u684C\u9762\u5E94\u7528\uFF0C\u4E0D\u4F7F\u7528\u5DF2\u5E9F\u5F03\u7684 Web Dashboard", source: "artifacts/decisions/D-ARCH-05.md" },
  { id: "C-RULE-01", description: "SEC severity \u4E0D\u5141\u8BB8\u964D\u7EA7", source: "artifacts/decisions/D-RULE-01.md" },
  { id: "C-GEN-01", description: "\u5B9E\u73B0\u84DD\u56FE\u4E0D\u5F97\u5F15\u5165 PRD \u4E2D\u672A\u51FA\u73B0\u7684\u65B0\u529F\u80FD", source: "artifacts/blueprints/implementation-blueprint.md" },
  { id: "C-GEN-02", description: "\u6587\u4EF6\u53D8\u66F4\u5FC5\u987B\u5148\u68C0\u67E5 interface-contracts\u3001data-contracts\u3001error-model \u662F\u5426\u9700\u8981\u540C\u6B65", source: "artifacts/blueprints/implementation-blueprint.md" },
  { id: "C-GEN-03", description: "\u4E0D\u5F97\u5C06\u5E9F\u5F03 Web Dashboard \u8BBE\u8BA1\u4F5C\u4E3A\u5B9E\u73B0\u4F9D\u636E", source: "artifacts/blueprints/implementation-blueprint.md" }
];
var BASELINE_CONSTRAINTS_COUNT = BASELINE_CONSTRAINTS.length;

// src/packet-validator.ts
var MIN_VALIDATION_COMMANDS = 4;
var VALID_PACKET_TARGET_TYPES = ["feature", "scenario", "decision", "design", "e2e_test"];
function isPacketTargetType(type) {
  return VALID_PACKET_TARGET_TYPES.includes(type);
}
var VALID_TARGET_TYPES = [...VALID_PACKET_TARGET_TYPES];
function validatePacket(packet) {
  const issues = [];
  if (packet.schemaVersion !== "1.0") {
    issues.push({
      severity: "error",
      code: "PKT-001",
      message: `schemaVersion must be "1.0", got "${packet.schemaVersion}"`,
      path: "schemaVersion"
    });
  }
  if (!isPacketTargetType(packet.target.type)) {
    issues.push({
      severity: "error",
      code: "PKT-002",
      message: `target.type must be one of [${VALID_TARGET_TYPES.join(", ")}], got "${packet.target.type}"`,
      path: "target.type"
    });
  }
  if (!packet.target.id || packet.target.id.trim().length === 0) {
    issues.push({
      severity: "error",
      code: "PKT-003",
      message: "target.id must be non-empty",
      path: "target.id"
    });
  }
  if (packet.requiredBaseline.total !== BASELINE_ITEMS_COUNT) {
    issues.push({
      severity: "error",
      code: "PKT-004",
      message: `requiredBaseline.total must be ${BASELINE_ITEMS_COUNT}, got ${packet.requiredBaseline.total}`,
      path: "requiredBaseline.total"
    });
  }
  const constraints = packet.implementationBlueprintDraft.constraints;
  if (constraints.length !== BASELINE_CONSTRAINTS_COUNT) {
    issues.push({
      severity: "error",
      code: "PKT-005",
      message: `constraints must have exactly ${BASELINE_CONSTRAINTS_COUNT} entries, got ${constraints.length}`,
      path: "implementationBlueprintDraft.constraints"
    });
  }
  const hasCRule01 = constraints.some((c) => c.id === "C-RULE-01");
  if (!hasCRule01) {
    issues.push({
      severity: "error",
      code: "PKT-005",
      message: "constraints must include C-RULE-01 (SEC severity must not be downgraded)",
      path: "implementationBlueprintDraft.constraints"
    });
  }
  if (packet.validationCommands.length < MIN_VALIDATION_COMMANDS) {
    issues.push({
      severity: "error",
      code: "PKT-006",
      message: `validationCommands must have at least ${MIN_VALIDATION_COMMANDS} entries, got ${packet.validationCommands.length}`,
      path: "validationCommands"
    });
  }
  if (packet.missing.length > 0) {
    issues.push({
      severity: "error",
      code: "PKT-007",
      message: `packet has ${packet.missing.length} missing artifact(s): ${packet.missing.join(", ")}`,
      path: "missing"
    });
  }
  const reviewOrder = packet.implementationBlueprintDraft.recommendedReviewOrder;
  if (!Array.isArray(reviewOrder) || reviewOrder.length === 0) {
    issues.push({
      severity: "error",
      code: "PKT-009",
      message: "recommendedReviewOrder must be a non-empty array",
      path: "implementationBlueprintDraft.recommendedReviewOrder"
    });
  } else {
    for (const step of reviewOrder) {
      if (typeof step.step !== "number" || !step.category || !step.reason) {
        issues.push({
          severity: "error",
          code: "PKT-009",
          message: "each recommendedReviewOrder entry must have step (number), category (string), and reason (string)",
          path: "implementationBlueprintDraft.recommendedReviewOrder"
        });
        break;
      }
    }
  }
  const riskChecklist = packet.implementationBlueprintDraft.riskChecklist;
  if (!Array.isArray(riskChecklist) || riskChecklist.length === 0) {
    issues.push({
      severity: "error",
      code: "PKT-010",
      message: "riskChecklist must be a non-empty array",
      path: "implementationBlueprintDraft.riskChecklist"
    });
  } else {
    for (const risk of riskChecklist) {
      if (!risk.id || !risk.description || typeof risk.checked !== "boolean") {
        issues.push({
          severity: "error",
          code: "PKT-010",
          message: "each riskChecklist entry must have id (string), description (string), and checked (boolean)",
          path: "implementationBlueprintDraft.riskChecklist"
        });
        break;
      }
    }
  }
  const hasError = issues.some((i) => i.severity === "error");
  return { ok: !hasError, issues };
}

// src/packet-assembler.ts
var DEFAULT_VALIDATION_COMMANDS = [
  "pnpm build",
  "pnpm test",
  "artifact-graph validate --root . --warning-only",
  "artifact-graph version-lock audit --root . --strict-missing-lock"
];
function toPacketItem(item) {
  const pi = {
    path: item.path,
    reason: item.reason,
    required: item.required ?? false
  };
  if (item.tier !== void 0) pi.tier = item.tier;
  if (item.reasons !== void 0) pi.reasons = item.reasons;
  return pi;
}
function toOmittedItem(item) {
  const oi = {
    path: item.path,
    reason: item.reason
  };
  if (item.tier !== void 0) oi.tier = item.tier;
  return oi;
}
function deriveConstraints() {
  return [...BASELINE_CONSTRAINTS];
}
function deriveObjectiveDescription(type, id, title) {
  const titleSuffix = title ? `\uFF1A${title}` : "";
  switch (type) {
    case "feature":
      return `\u529F\u80FD ${id}${titleSuffix} \u7684\u5B9E\u73B0\u4E0E\u96C6\u6210`;
    case "scenario":
      return `\u573A\u666F ${id}${titleSuffix} \u7684\u9A8C\u8BC1\u4E0E\u6D4B\u8BD5`;
    case "decision":
      return `\u51B3\u7B56 ${id}${titleSuffix} \u7684\u843D\u5730\u4E0E\u5408\u89C4\u68C0\u67E5`;
    case "design":
      return `\u8BBE\u8BA1\u89C4\u683C ${id}${titleSuffix} \u7684\u5B9E\u73B0\u4E0E\u9A8C\u8BC1`;
    case "e2e_test":
      return `E2E \u6D4B\u8BD5 ${id}${titleSuffix} \u7684\u8865\u5168\u4E0E\u9A8C\u8BC1`;
    default:
      return `${type} ${id}${titleSuffix} \u5B9E\u73B0\u76EE\u6807`;
  }
}
function deriveRecommendedReviewOrder(hasBaseline, hasTarget, hasDirect, hasMatrix, hasTransitive) {
  const steps = [];
  let step = 1;
  if (hasBaseline) {
    steps.push({ step: step++, category: "baseline", reason: "\u5FC5\u8BFB\u57FA\u7840\u5236\u54C1\uFF0C\u5EFA\u7ACB\u9879\u76EE\u89C4\u8303\u548C\u7EA6\u675F\u7684\u57FA\u7EBF\u8BA4\u77E5" });
  }
  if (hasTarget) {
    steps.push({ step: step++, category: "target", reason: "\u76EE\u6807\u672C\u8EAB\uFF0C\u7406\u89E3\u672C\u6B21\u5B9E\u73B0\u8981\u4EA4\u4ED8\u7684\u5177\u4F53\u5185\u5BB9" });
  }
  if (hasDirect) {
    steps.push({ step: step++, category: "direct", reason: "\u76F4\u63A5\u5173\u8054\u5236\u54C1\uFF0C\u5F71\u54CD\u5B9E\u73B0\u65B9\u6848\u7684\u5173\u952E\u8F93\u5165" });
  }
  if (hasMatrix) {
    steps.push({ step: step++, category: "matrix", reason: "\u77E9\u9635\u4EA4\u53C9\u5F15\u7528\uFF0C\u8BC6\u522B\u8DE8\u7EF4\u5EA6\u4F9D\u8D56\u548C\u4E00\u81F4\u6027\u8981\u6C42" });
  }
  if (hasTransitive) {
    steps.push({ step: step++, category: "transitive", reason: "\u4F20\u9012\u5173\u8054\u5236\u54C1\uFF0C\u8865\u5145\u80CC\u666F\u77E5\u8BC6\u548C\u9886\u57DF\u672F\u8BED" });
  }
  return steps;
}
function deriveRiskChecklist(context, missingCount, categories) {
  const allPaths = Object.values(context).flat().map((i) => i.path).join("\n");
  const items = [
    {
      id: "RISK-001",
      description: "\u662F\u5426\u89E6\u78B0 artifacts/ \u4E0B\u7684\u5236\u54C1\u6587\u4EF6\uFF08\u573A\u666F\u3001PRD\u3001\u51B3\u7B56\u3001\u8BBE\u8BA1\u89C4\u683C\u3001\u5B9E\u4F53\u6CE8\u518C\u8868\uFF09",
      checked: allPaths.includes("artifacts/")
    },
    {
      id: "RISK-002",
      description: "\u662F\u5426\u6D89\u53CA desktop E2E \u94FE\u8DEF\uFF08React UI -> Tauri IPC -> Node sidecar -> core/engine\uFF09",
      checked: categories.some((c) => c.name === "e2e_test")
    },
    {
      id: "RISK-003",
      description: "\u662F\u5426\u4FEE\u6539 Quick Check \u89C4\u5219\uFF08\u786E\u5B9A\u6027 TypeScript \u5F15\u64CE\uFF0C0 LLM\uFF0C<30s\uFF09",
      checked: allPaths.includes("rules/") || allPaths.includes("rule-")
    },
    {
      id: "RISK-004",
      description: "\u662F\u5426\u5F71\u54CD security severity\uFF08SEC severity \u4E0D\u5141\u8BB8\u964D\u7EA7\uFF09",
      checked: allPaths.includes("security") || allPaths.includes("SEC-")
    },
    {
      id: "RISK-005",
      description: "\u662F\u5426\u5F15\u7528\u5DF2\u5E9F\u5F03\u7684 Web Dashboard \u4F5C\u4E3A\u5B9E\u73B0\u4F9D\u636E",
      checked: false
    }
  ];
  if (categories.some((c) => c.name === "e2e_test")) {
    items.push({
      id: "RISK-006",
      description: "\u9700\u66F4\u65B0\u6216\u590D\u8DD1\u76F8\u5173 E2E \u6D4B\u8BD5",
      checked: true
    });
  }
  if (missingCount > 0) {
    items.push({
      id: "RISK-007",
      description: "\u8FFD\u6EAF\u7F3A\u5931\u9700\u5148\u4FEE\u590D",
      checked: false
    });
  }
  return items;
}
function countRequired(cat) {
  let required = 0;
  let optional = 0;
  for (const item of cat.items) {
    if (item.required) required++;
    else optional++;
  }
  return { required, optional };
}
function categorySummaryLine(cat) {
  const { required, optional } = countRequired(cat);
  const total = cat.total;
  if (optional > 0) {
    return `\u5171 ${total} \u9879\uFF08\u5FC5\u8BFB: ${required} | \u9009\u8BFB: ${optional}\uFF09`;
  }
  if (required > 0) {
    return `\u5171 ${total} \u9879\uFF08\u5168\u90E8\u5FC5\u8BFB\uFF09`;
  }
  return `\u5171 ${total} \u9879`;
}
function renderContextCategory(cat, opts) {
  const lines = [];
  lines.push(`### ${cat.category}\uFF08${cat.total} \u9879\uFF09`);
  lines.push("");
  lines.push(`> ${categorySummaryLine(cat)}`);
  lines.push("");
  for (const item of cat.items) {
    const req = opts?.includeRequiredMark && item.required ? "[\u5FC5\u8BFB]" : "";
    const tier = item.tier ? ` [${item.tier}]` : "";
    lines.push(`- \`${item.path}\` \u2014 ${req}${item.reason}${tier}`);
  }
  return lines;
}
var COMMAND_COMMENTS = {
  "pnpm build": "\u6784\u5EFA\u9879\u76EE",
  "pnpm test": "\u8FD0\u884C\u9879\u76EE\u6D4B\u8BD5",
  "artifact-graph validate --root . --warning-only": "\u5236\u54C1\u94FE\u4E00\u81F4\u6027\u6821\u9A8C\uFF08warning-only\uFF09",
  "artifact-graph version-lock audit --root . --strict-missing-lock": "\u5236\u54C1\u94FE\u7248\u672C\u9501\u4E25\u683C\u5BA1\u8BA1"
};
function classifyCategories(manifest) {
  let baseline = { category: "baseline", total: 0, items: [] };
  const direct = [];
  const matrix = [];
  const transitive = [];
  for (const [category, items] of Object.entries(manifest.context)) {
    if (category === "baseline") {
      baseline = { category, total: items.length, items: items.map(toPacketItem) };
      continue;
    }
    if (category === "target") {
      direct.push({ category, total: items.length, items: items.map(toPacketItem) });
      continue;
    }
    const tierCounts = /* @__PURE__ */ new Map();
    for (const item of items) {
      const tier = item.tier ?? "direct";
      tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
    }
    let predominantTier = "direct";
    let maxCount = 0;
    for (const [tier, count] of tierCounts) {
      if (count > maxCount) {
        maxCount = count;
        predominantTier = tier;
      }
    }
    const pc = { category, total: items.length, items: items.map(toPacketItem) };
    if (predominantTier === "matrix") {
      matrix.push(pc);
    } else if (predominantTier === "transitive") {
      transitive.push(pc);
    } else {
      direct.push(pc);
    }
  }
  if (baseline.items.length >= ALWAYS_PRESENT_ITEMS.length - 1) {
    const baselineByPath = new Map(baseline.items.map((item) => [item.path, item]));
    const itemsByPath = /* @__PURE__ */ new Map();
    for (const items of Object.values(manifest.context)) {
      for (const item of items) {
        itemsByPath.set(item.path, toPacketItem(item));
      }
    }
    for (const item of ALWAYS_PRESENT_ITEMS) {
      if (baselineByPath.has(item.path)) continue;
      const existing = itemsByPath.get(item.path);
      if (!existing) continue;
      const baselineItem = { ...existing, reason: item.reason, required: true, tier: "baseline" };
      baseline.items.push(baselineItem);
      baselineByPath.set(baselineItem.path, baselineItem);
    }
    baseline.total = baseline.items.length;
  }
  return { baseline, direct, matrix, transitive };
}
function assemblePacket(manifest, options) {
  const validationCommands = options?.validationCommands ?? DEFAULT_VALIDATION_COMMANDS;
  const mode = options?.mode ?? "implementation";
  const maxPerCategory = options?.maxPerCategory ?? 20;
  const constraints = deriveConstraints();
  const { baseline, direct, matrix, transitive } = classifyCategories(manifest);
  let totalItems = 0;
  for (const items of Object.values(manifest.context)) {
    totalItems += items.length;
  }
  const omittedItems = (manifest.omitted ?? []).map(toOmittedItem);
  const categories = [];
  for (const [category, items] of Object.entries(manifest.context)) {
    categories.push({ name: category, count: items.length, paths: items.map((i) => i.path) });
  }
  const recommendedReviewOrder = deriveRecommendedReviewOrder(
    "baseline" in manifest.context,
    "target" in manifest.context,
    direct.length > 0,
    matrix.length > 0,
    transitive.length > 0
  );
  const riskChecklist = deriveRiskChecklist(manifest.context, manifest.missing.length, categories);
  const blueprintDraft = {
    objective: {
      featureId: manifest.target.type === "feature" ? manifest.target.id : null,
      scenarioId: manifest.target.type === "scenario" ? manifest.target.id : null,
      decisionId: manifest.target.type === "decision" ? manifest.target.id : null,
      designId: manifest.target.type === "design" ? manifest.target.id : null,
      e2eTestId: manifest.target.type === "e2e_test" ? manifest.target.id : null,
      description: deriveObjectiveDescription(manifest.target.type, manifest.target.id, manifest.target.title),
      scope: "\uFF08\u7531\u5B9E\u73B0\u4EFB\u52A1\u586B\u5199\uFF09",
      nonGoals: ["\u4E0D\u5F97\u5F15\u5165 PRD \u4E2D\u672A\u51FA\u73B0\u7684\u65B0\u529F\u80FD", "\u4E0D\u5F97\u4FEE\u6539\u4E0E\u76EE\u6807\u65E0\u5173\u7684\u5B9E\u73B0\u4EE3\u7801"]
    },
    contextChecklist: { categories },
    fileChanges: [],
    constraints,
    validationCommands,
    recommendedReviewOrder,
    riskChecklist
  };
  const packet = {
    schemaVersion: "1.0",
    generatedAt: options?.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    target: {
      type: manifest.target.type,
      id: manifest.target.id,
      uid: manifest.target.uid,
      title: manifest.target.title,
      sourcePath: manifest.target.sourcePath,
      status: manifest.target.status
    },
    contextManifestSummary: {
      totalCategories: Object.keys(manifest.context).length,
      totalItems,
      totalOmitted: omittedItems.length,
      totalMissing: manifest.missing.length,
      mode,
      maxPerCategory
    },
    requiredBaseline: baseline,
    contextByTier: { direct, matrix, transitive },
    omittedItems,
    missing: [...manifest.missing],
    missingDetails: manifest.missingDetails ? [...manifest.missingDetails] : void 0,
    implementationBlueprintDraft: blueprintDraft,
    validationCommands
  };
  return packet;
}
function renderPacketMarkdown(packet) {
  const lines = [];
  const b = packet.implementationBlueprintDraft;
  const s = packet.contextManifestSummary;
  lines.push(`# Implementation Packet \u2014 ${packet.target.type.toUpperCase()} ${packet.target.id}`);
  lines.push("");
  lines.push(`> schemaVersion: ${packet.schemaVersion} | generatedAt: ${packet.generatedAt}`);
  lines.push(`> mode: ${s.mode} | maxPerCategory: ${s.maxPerCategory}`);
  lines.push("");
  lines.push("## 1. \u5B9E\u73B0\u76EE\u6807");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| Type | ${packet.target.type} |`);
  lines.push(`| ID | ${packet.target.id} |`);
  lines.push(`| UID | \`${packet.target.uid}\` |`);
  lines.push(`| Description | ${b.objective.description} |`);
  lines.push(`| Scope | ${b.objective.scope} |`);
  lines.push(`| Non-goals | ${b.objective.nonGoals.join("; ")} |`);
  lines.push("");
  lines.push(`> **Context items: ${s.totalItems}** | **Missing: ${s.totalMissing}** | **Omitted: ${s.totalOmitted}**`);
  lines.push("");
  lines.push("## 2. \u4E0A\u4E0B\u6587\u6E05\u5355\u6458\u8981");
  lines.push("");
  lines.push("| \u7C7B\u522B | \u6570\u91CF |");
  lines.push("|---|---|");
  lines.push(`| Categories\uFF08\u7C7B\u522B\uFF09 | ${s.totalCategories} |`);
  lines.push(`| Total items\uFF08\u6761\u76EE\uFF09 | ${s.totalItems} |`);
  lines.push(`| Omitted\uFF08\u622A\u65AD\uFF09 | ${s.totalOmitted} |`);
  lines.push(`| Missing\uFF08\u7F3A\u5931\uFF09 | ${s.totalMissing} |`);
  lines.push("");
  lines.push("> **\u6267\u884C\u6307\u4EE4\uFF1A**");
  lines.push("> 1. \u5148\u9605\u8BFB Required Baseline \u4E2D\u6807\u8BB0 `[\u5FC5\u8BFB]` \u7684\u5236\u54C1");
  lines.push("> 2. \u82E5 Missing \u975E\u7A7A\uFF0C\u5148\u4FEE\u590D\u8FFD\u6EAF\u518D\u5B9E\u73B0");
  lines.push("> 3. \u82E5 Omitted \u975E\u7A7A\uFF0C\u5224\u65AD\u662F\u5426\u9700\u8981 `--mode full` \u83B7\u53D6\u5B8C\u6574\u4E0A\u4E0B\u6587");
  lines.push("> 4. \u4FEE\u6539 artifacts \u540E\u5FC5\u987B\u8FD0\u884C artifact-graph validate \u548C version-lock audit");
  lines.push("");
  const baselineSummary = categorySummaryLine(packet.requiredBaseline);
  const { required: baselineRequired, optional: baselineOptional } = countRequired(packet.requiredBaseline);
  lines.push("## 3. Required Baseline\uFF08\u5FC5\u8BFB\u5236\u54C1\uFF09");
  lines.push("");
  lines.push(`> \u5FC5\u8BFB: ${baselineRequired} \u9879 | \u9009\u8BFB: ${baselineOptional} \u9879`);
  lines.push("");
  lines.push(baselineSummary);
  lines.push("");
  for (const item of packet.requiredBaseline.items) {
    const req = item.required ? "[\u5FC5\u8BFB]" : "[\u9009\u8BFB]";
    lines.push(`- ${req} \`${item.path}\` \u2014 ${item.reason}`);
  }
  lines.push("");
  if (packet.contextByTier.direct.length > 0) {
    lines.push("## 4. Direct Context\uFF08\u76F4\u63A5\u5173\u8054\uFF09");
    lines.push("");
    for (const cat of packet.contextByTier.direct) {
      lines.push(...renderContextCategory(cat, { includeRequiredMark: true }));
      lines.push("");
    }
  }
  if (packet.contextByTier.matrix.length > 0) {
    lines.push("## 5. Matrix Context\uFF08\u77E9\u9635\u5173\u8054\uFF09");
    lines.push("");
    for (const cat of packet.contextByTier.matrix) {
      lines.push(...renderContextCategory(cat));
      lines.push("");
    }
  }
  if (packet.contextByTier.transitive.length > 0) {
    lines.push("## 6. Transitive Context\uFF08\u4F20\u9012\u5173\u8054\uFF09");
    lines.push("");
    for (const cat of packet.contextByTier.transitive) {
      lines.push(...renderContextCategory(cat));
      lines.push("");
    }
  }
  if (packet.omittedItems.length > 0) {
    lines.push("## 7. Omitted Items\uFF08\u622A\u65AD\u6761\u76EE\uFF09");
    lines.push("");
    lines.push(`> \u5171 ${packet.omittedItems.length} \u9879\u88AB\u622A\u65AD\u3002\u53EF\u7528 \`--mode full\` \u67E5\u770B\u5B8C\u6574\u4E0A\u4E0B\u6587\uFF0C\u6216\u589E\u5927 \`--max-per-category\` \u4E0A\u9650\u3002`);
    lines.push("");
    for (const item of packet.omittedItems) {
      const tier = item.tier ? ` [${item.tier}]` : "";
      lines.push(`- \`${item.path}\` \u2014 ${item.reason}${tier}`);
    }
    lines.push("");
  }
  if (packet.missing.length > 0) {
    lines.push("## \u26A0\uFE0F Missing Artifacts\uFF08\u7F3A\u5931\u5236\u54C1\uFF09");
    lines.push("");
    lines.push(`> \u5171 ${packet.missing.length} \u9879\u7F3A\u5931\u3002\u5FC5\u987B\u5148\u4FEE\u590D\u8FFD\u6EAF\u518D\u5B9E\u73B0\u3002`);
    lines.push("");
    for (const m of packet.missing) {
      lines.push(`- ${m}`);
    }
    lines.push("");
  }
  if (packet.missingDetails && packet.missingDetails.length > 0) {
    lines.push("### Missing Details\uFF08\u7F3A\u5931\u8BCA\u65AD\uFF09");
    lines.push("");
    lines.push("| ref | kind | suggestedAction |");
    lines.push("|---|---|---|");
    for (const d of packet.missingDetails) {
      lines.push(`| \`${d.ref}\` | ${d.kind} | ${d.suggestedAction} |`);
    }
    lines.push("");
  }
  lines.push("## 8. Implementation Blueprint Draft\uFF08\u5B9E\u73B0\u84DD\u56FE\u8349\u6848\uFF09");
  lines.push("");
  lines.push("### 8.1 \u4E0A\u4E0B\u6587\u6E05\u5355");
  lines.push("");
  for (const cat of b.contextChecklist.categories) {
    lines.push(`- **${cat.name}**\uFF08${cat.count} \u9879\uFF09`);
    for (const p of cat.paths) {
      lines.push(`  - \`${p}\``);
    }
  }
  lines.push("");
  lines.push("### 8.2 \u6587\u4EF6\u53D8\u66F4\u6E05\u5355");
  lines.push("");
  if (b.fileChanges.length === 0) {
    lines.push("> \uFF08\u7A7A\uFF09\u7531\u5B9E\u73B0\u4EFB\u52A1\u586B\u5199\u3002\u6BCF\u4E2A\u53D8\u66F4\u5FC5\u987B\u80FD\u8FFD\u6EAF\u5230\u4E0A\u65B9\u67D0\u4E2A context \u6761\u76EE\u3002");
  } else {
    lines.push("| File path | Action | Description | Source |");
    lines.push("|---|---|---|---|");
    for (const fc of b.fileChanges) {
      lines.push(`| \`${fc.path}\` | ${fc.action} | ${fc.description} | ${fc.source} |`);
    }
  }
  lines.push("");
  lines.push("### 8.3 \u7EA6\u675F\u4E0E\u8FB9\u754C");
  lines.push("");
  lines.push("| ID | Description | Source |");
  lines.push("|---|---|---|");
  for (const c of b.constraints) {
    lines.push(`| ${c.id} | ${c.description} | \`${c.source}\` |`);
  }
  lines.push("");
  lines.push("### 8.4 \u9A8C\u8BC1\u547D\u4EE4");
  lines.push("");
  lines.push("```bash");
  for (const cmd of b.validationCommands) {
    const comment = COMMAND_COMMENTS[cmd];
    lines.push(comment ? `${cmd} # ${comment}` : cmd);
  }
  lines.push("```");
  lines.push("");
  lines.push("### 8.5 \u63A8\u8350\u5BA1\u9605\u987A\u5E8F");
  lines.push("");
  lines.push("| \u6B65\u9AA4 | \u7C7B\u522B | \u7406\u7531 |");
  lines.push("|---|---|---|");
  for (const step of b.recommendedReviewOrder) {
    lines.push(`| ${step.step} | ${step.category} | ${step.reason} |`);
  }
  lines.push("");
  lines.push("### 8.6 \u98CE\u9669\u68C0\u67E5\u6E05\u5355");
  lines.push("");
  for (const risk of b.riskChecklist) {
    const mark = risk.checked ? "[x]" : "[ ]";
    lines.push(`- ${mark} **${risk.id}**: ${risk.description}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("> \u672C packet \u7531 `artifact-graph packet` \u547D\u4EE4\u81EA\u52A8\u751F\u6210\u3002\u9664 `generatedAt` \u65F6\u95F4\u6233\u5916\uFF0C\u5185\u5BB9\u7531 manifest \u786E\u5B9A\uFF1B\u9700\u8981\u5B8C\u5168\u53EF\u590D\u73B0\u65F6\u53EF\u4F20\u5165\u56FA\u5B9A `generatedAt`\uFF08\u5185\u90E8 API\uFF09\u3002\u4E0D\u6D89\u53CA LLM\u3002");
  lines.push("");
  lines.push("> \u63D0\u793A\uFF1A\u4F7F\u7528 Ctrl+F \u641C\u7D22 `[\u5FC5\u8BFB]` \u5FEB\u901F\u5B9A\u4F4D\u5FC5\u8BFB\u5236\u54C1\u3002");
  return lines.join("\n");
}

// src/packet-audit.ts
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
var VALID_TYPES = new Set(VALID_PACKET_TARGET_TYPES);
var VALID_TYPES_LABEL = VALID_PACKET_TARGET_TYPES.join(", ");
function parseTargetsFile(content) {
  const targets = [];
  const errors = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) {
      errors.push({ line: i + 1, raw: lines[i], message: `\u7F3A\u5C11\u5192\u53F7\u5206\u9694\u7B26\uFF0C\u671F\u671B\u683C\u5F0F "type:id"` });
      continue;
    }
    const type = line.slice(0, colonIdx).trim();
    const id = line.slice(colonIdx + 1).trim();
    if (!VALID_TYPES.has(type)) {
      errors.push({ line: i + 1, raw: lines[i], message: `\u975E\u6CD5\u7C7B\u578B "${type}"\uFF0C\u5141\u8BB8\u503C: ${VALID_TYPES_LABEL}` });
      continue;
    }
    if (!id) {
      errors.push({ line: i + 1, raw: lines[i], message: `ID \u4E3A\u7A7A\uFF0C\u671F\u671B\u683C\u5F0F "type:id"` });
      continue;
    }
    targets.push({ type, id });
  }
  return { targets, errors };
}
async function auditSingleTarget(target, graph, options) {
  const entry = {
    type: target.type,
    id: target.id,
    status: "passed",
    missingCount: 0,
    omittedCount: 0,
    itemsCount: 0,
    baselineCount: 0,
    constraintsCount: 0,
    errors: []
  };
  try {
    const contextOpts = {
      [target.type]: target.id
    };
    if (options.mode) contextOpts.mode = options.mode;
    if (options.maxPerCategory !== void 0) contextOpts.maxPerCategory = options.maxPerCategory;
    const manifest = resolveArtifactContext(graph, {
      feature: target.type === "feature" ? target.id : void 0,
      scenario: target.type === "scenario" ? target.id : void 0,
      decision: target.type === "decision" ? target.id : void 0,
      design: target.type === "design" ? target.id : void 0,
      e2e_test: target.type === "e2e_test" ? target.id : void 0,
      mode: options.mode,
      maxPerCategory: options.maxPerCategory
    });
    const packet = assemblePacket(manifest, {
      mode: options.mode,
      maxPerCategory: options.maxPerCategory
    });
    entry.missingCount = manifest.missing.length;
    entry.omittedCount = packet.omittedItems.length;
    entry.baselineCount = packet.requiredBaseline.total;
    entry.constraintsCount = packet.implementationBlueprintDraft.constraints.length;
    let totalItems = 0;
    for (const items of Object.values(manifest.context)) {
      totalItems += items.length;
    }
    entry.itemsCount = totalItems;
    const validationResult = validatePacket(packet);
    if (validationResult.issues.length > 0) {
      entry.validationIssues = validationResult.issues;
    }
    if (!validationResult.ok) {
      entry.status = "failed";
      for (const issue2 of validationResult.issues) {
        if (issue2.severity === "error") {
          entry.errors.push(`validation ${issue2.code}: ${issue2.message}`);
        }
      }
    }
    if (manifest.missing.length > 0) {
      entry.status = "failed";
      for (const m of manifest.missing) {
        entry.errors.push(`missing: ${m}`);
      }
      if (manifest.missingDetails && manifest.missingDetails.length > 0) {
        entry.missingDetailsSummary = manifest.missingDetails.map((d) => ({
          ref: d.ref,
          kind: d.kind,
          suggestedAction: d.suggestedAction
        }));
      }
    }
    if (options.outDir && !options.summaryOnly) {
      const fmt = options.format ?? "markdown";
      const ext = fmt === "json" ? "json" : "md";
      const filename = `${target.type}-${target.id}.packet.${ext}`;
      const outPath = join(options.outDir, filename);
      let content;
      if (fmt === "json") {
        content = JSON.stringify(packet, null, 2) + "\n";
      } else {
        content = renderPacketMarkdown(packet);
      }
      await writeFile(outPath, content, "utf-8");
      entry.outputPath = outPath;
    }
  } catch (error) {
    entry.status = "failed";
    entry.errors.push(error.message);
  }
  return entry;
}
async function auditPackets(root, targets, options, graph) {
  const resolvedGraph = graph ?? await scanArtifacts(root);
  if (options.sampleTargets && options.sampleTargets.length > 0) {
    const targetSet = new Set(targets.map((t) => `${t.type}:${t.id}`));
    const missingSamples = options.sampleTargets.filter((st) => !targetSet.has(st));
    if (missingSamples.length > 0) {
      throw new Error(
        `Sample target(s) not found in audit target set: ${missingSamples.join(", ")}`
      );
    }
  }
  if (options.outDir) {
    await mkdir(options.outDir, { recursive: true });
  }
  const sampleSet = options.sampleTargets ? new Set(options.sampleTargets) : null;
  const sampleOutputPaths = [];
  const entries = [];
  for (const target of targets) {
    const targetKey = `${target.type}:${target.id}`;
    const effectiveOptions = { ...options };
    if (sampleSet) {
      effectiveOptions.summaryOnly = !sampleSet.has(targetKey);
    }
    const entry = await auditSingleTarget(target, resolvedGraph, effectiveOptions);
    if (entry.outputPath) {
      sampleOutputPaths.push(entry.outputPath);
    }
    entries.push(entry);
  }
  const passed = entries.filter((e) => e.status === "passed").length;
  const failed = entries.filter((e) => e.status === "failed").length;
  const missing = entries.filter((e) => e.status === "missing").length;
  const totalOmitted = entries.reduce((sum, e) => sum + e.omittedCount, 0);
  let packetOutputMode = "full";
  if (options.summaryOnly && !sampleSet) {
    packetOutputMode = "summary-only";
  } else if (sampleSet) {
    packetOutputMode = "sample";
  }
  const countsByType = {};
  for (const e of entries) {
    countsByType[e.type] = (countsByType[e.type] ?? 0) + 1;
  }
  const isCompact = options.summaryDetail === "compact";
  const summaryTargets = isCompact ? entries.filter((e) => e.status !== "passed") : entries;
  const summary = {
    schemaVersion: "1.3",
    total: entries.length,
    passed,
    failed,
    missing,
    totalOmitted,
    targets: summaryTargets,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sourceTargetsPath: options.sourceTargetsPath,
    mode: options.mode,
    format: options.format,
    maxPerCategory: options.maxPerCategory,
    packetOutputMode,
    ...sampleSet ? { sampleTargets: options.sampleTargets } : {},
    ...sampleOutputPaths.length > 0 ? { sampleOutputPaths } : {},
    ...isCompact ? { summaryDetail: "compact", countsByType } : {}
  };
  if (options.outDir) {
    const summaryPath = join(options.outDir, "summary.json");
    await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf-8");
  }
  return summary;
}
async function discoverAndAuditPackets(root, options) {
  const config = await loadConfig(root);
  const graph = await scanArtifacts(root, config);
  const discovered = discoverTargets(graph, { limit: options.limit, schema: config });
  const targets = discovered.map((d) => ({
    type: d.type,
    id: d.id
  }));
  return auditPackets(root, targets, {
    root,
    outDir: options.outDir,
    format: options.format,
    mode: options.mode,
    maxPerCategory: options.maxPerCategory,
    summaryOnly: options.summaryOnly,
    sampleTargets: options.sampleTargets,
    summaryDetail: options.summaryDetail
  }, graph);
}

// src/packet-prompt.ts
var TYPE_CLI_FLAG = {
  feature: "feature",
  scenario: "scenario",
  decision: "decision",
  design: "design",
  e2e_test: "e2e-test"
};
function cliFlag(type) {
  return TYPE_CLI_FLAG[type] ?? type;
}
var DEFAULT_MAX_CHARS = 4e3;
var MIN_PROMPT_CHARS = 320;
function renderPromptHeader(packet) {
  const t = packet.target;
  const typeLabelMap = { feature: "\u529F\u80FD", scenario: "\u573A\u666F", decision: "\u51B3\u7B56", design: "\u8BBE\u8BA1\u89C4\u683C", e2e_test: "E2E \u6D4B\u8BD5" };
  const typeLabel = typeLabelMap[t.type] ?? t.type;
  const lines = [
    `# \u5B9E\u73B0\u4EFB\u52A1\uFF1A${typeLabel} ${t.id}`,
    "",
    `**\u76EE\u6807**: ${packet.implementationBlueprintDraft.objective.description}`
  ];
  if (t.title) {
    lines.push(`**\u6807\u9898**: ${t.title}`);
  }
  if (t.sourcePath) {
    lines.push(`**\u6E90\u6587\u4EF6**: \`${t.sourcePath}\``);
  }
  if (t.status) {
    lines.push(`**\u72B6\u6001**: ${t.status}`);
  }
  lines.push(
    `**\u4E0A\u4E0B\u6587\u5B8C\u6574\u6027**: Missing=${packet.contextManifestSummary.totalMissing} | Omitted=${packet.contextManifestSummary.totalOmitted}`,
    ""
  );
  return lines;
}
function renderReviewOrder(packet) {
  const steps = packet.implementationBlueprintDraft.recommendedReviewOrder;
  if (steps.length === 0) {
    return [];
  }
  const lines = [
    "## \u63A8\u8350\u5BA1\u9605\u6B65\u9AA4",
    ""
  ];
  for (const step of steps) {
    lines.push(`${step.step}. **${step.category}**: ${step.reason}`);
  }
  lines.push("");
  return lines;
}
function renderRequiredReading(packet) {
  const lines = [
    "## \u5FC5\u8BFB\u5236\u54C1",
    "",
    `\u5171 ${BASELINE_ITEMS_COUNT} \u4E2A baseline \u5236\u54C1 + \u76EE\u6807\u76F4\u63A5\u5173\u8054\u5236\u54C1\u3002`,
    "\u6267\u884C\u8005\u5FC5\u987B\u5148\u9605\u8BFB\u6240\u6709\u6807\u8BB0\u4E3A\u5FC5\u8BFB\u7684 baseline \u6587\u4EF6\uFF0C\u518D\u7ED3\u5408\u76EE\u6807\u6E90\u6587\u4EF6\u548C\u76F4\u63A5\u5173\u8054\u5236\u54C1\u5B9E\u73B0\uFF1B\u82E5 Missing \u6216 Omitted \u975E\u96F6\uFF0C\u5148\u505C\u6B62\u5E76\u8BF4\u660E\u963B\u585E\u3002",
    "\u8FD0\u884C\u4EE5\u4E0B\u547D\u4EE4\u83B7\u53D6\u5B8C\u6574\u4E0A\u4E0B\u6587\uFF1A",
    "",
    "```bash",
    `artifact-graph packet --root <root> --${cliFlag(packet.target.type)} ${packet.target.id} --format markdown`,
    "```",
    ""
  ];
  return lines;
}
function renderConstraints() {
  const lines = [
    "## \u7EA6\u675F\u4E0E\u8FB9\u754C",
    ""
  ];
  for (const c of BASELINE_CONSTRAINTS) {
    lines.push(`- **${c.id}**: ${c.description}`);
  }
  lines.push("");
  return lines;
}
function renderValidationCommands(packet) {
  const lines = [
    "## \u9A8C\u8BC1\u547D\u4EE4",
    "",
    "\u5B9E\u73B0\u5B8C\u6210\u540E\u5FC5\u987B\u8FD0\u884C\uFF1A",
    "",
    "```bash"
  ];
  for (const cmd of packet.validationCommands) {
    lines.push(cmd);
  }
  lines.push("```");
  lines.push("");
  return lines;
}
function renderCommitRequirements() {
  return [
    "## \u63D0\u4EA4\u8981\u6C42",
    "",
    "- \u4E24\u4E2A git \u4ED3\u5E93\u5206\u5F00\u63D0\u4EA4\uFF08parent repo \u548C heimdall/\uFF09",
    "- \u4E0D\u8981\u56DE\u9000\u7528\u6237\u5DF2\u6709\u6539\u52A8",
    "- commit message \u4EE5 `feat/fix/docs` \u5F00\u5934\uFF0C\u8BF4\u660E\u53D8\u66F4\u539F\u56E0",
    "- \u63D0\u4EA4\u524D\u8FD0\u884C `git diff --check` \u548C `git status --short`",
    ""
  ];
}
function renderForbidden() {
  return [
    "## \u7981\u6B62\u4E8B\u9879",
    "",
    "- \u4E0D\u5F97\u5F15\u5165 PRD \u4E2D\u672A\u51FA\u73B0\u7684\u65B0\u529F\u80FD",
    "- \u4E0D\u5F97\u4FEE\u6539\u4E0E\u76EE\u6807\u65E0\u5173\u7684\u5B9E\u73B0\u4EE3\u7801",
    "- \u4E0D\u5F97\u5C06\u5E9F\u5F03 Web Dashboard \u8BBE\u8BA1\u4F5C\u4E3A\u5B9E\u73B0\u4F9D\u636E",
    "- SEC severity \u4E0D\u5141\u8BB8\u964D\u7EA7",
    "- \u4E0D\u5F97\u56DE\u9000\u7528\u6237\u5DF2\u6709\u7684 dirty work",
    ""
  ];
}
function renderChangeBoundary(packet) {
  const lines = [
    "## \u9884\u671F\u4FEE\u6539\u8FB9\u754C",
    ""
  ];
  const categories = packet.implementationBlueprintDraft.contextChecklist.categories;
  if (categories.length > 0) {
    for (const cat of categories) {
      if (cat.name === "baseline") continue;
      lines.push(`- **${cat.name}**\uFF08${cat.count} \u9879\uFF09`);
    }
  } else {
    lines.push("> \u7531\u5B9E\u73B0\u4EFB\u52A1\u6839\u636E\u76EE\u6807\u81EA\u884C\u786E\u5B9A\u4FEE\u6539\u8303\u56F4\u3002");
  }
  lines.push("");
  return lines;
}
function renderPacketPrompt(packet, options) {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  if (maxChars < MIN_PROMPT_CHARS) {
    return {
      ok: false,
      reason: "maxChars \u4F4E\u4E8E\u6700\u5C0F\u53EF\u7528\u63D0\u793A\u8BCD\u957F\u5EA6",
      actualLength: 0,
      minRequired: MIN_PROMPT_CHARS
    };
  }
  const sections = [];
  sections.push(...renderPromptHeader(packet));
  sections.push(...renderRequiredReading(packet));
  sections.push(...renderReviewOrder(packet));
  sections.push(...renderConstraints());
  sections.push(...renderChangeBoundary(packet));
  sections.push(...renderValidationCommands(packet));
  sections.push(...renderCommitRequirements());
  sections.push(...renderForbidden());
  sections.push("---");
  sections.push("");
  sections.push(`> \u7531 artifact-graph packet-prompt \u81EA\u52A8\u751F\u6210 (${packet.generatedAt})\u3002\u7EC6\u8282\u8BF7\u8FD0\u884C packet \u547D\u4EE4\u83B7\u53D6\u5B8C\u6574\u4E0A\u4E0B\u6587\u3002`);
  sections.push("");
  const fullText = sections.join("\n");
  if (fullText.length <= maxChars) {
    return fullText;
  }
  const compactSections = [];
  compactSections.push(...renderPromptHeader(packet));
  compactSections.push(...renderRequiredReading(packet));
  compactSections.push(...renderReviewOrder(packet));
  compactSections.push("## \u7EA6\u675F\u4E0E\u8FB9\u754C", "");
  for (const c of BASELINE_CONSTRAINTS) {
    compactSections.push(`- ${c.id}: ${c.description}`);
  }
  compactSections.push("");
  compactSections.push(...renderValidationCommands(packet));
  compactSections.push(...renderCommitRequirements());
  compactSections.push(...renderForbidden());
  compactSections.push("---", "");
  compactSections.push(`> \u7531 artifact-graph packet-prompt \u81EA\u52A8\u751F\u6210\u3002\u4E0A\u4E0B\u6587\u5DF2\u538B\u7F29\uFF0C\u8BF7\u8FD0\u884C packet \u547D\u4EE4\u83B7\u53D6\u5B8C\u6574\u5236\u54C1\u6E05\u5355\u3002`);
  compactSections.push("");
  const compactText = compactSections.join("\n");
  if (compactText.length <= maxChars) {
    return compactText;
  }
  const t = packet.target;
  const typeLabelMapMinimal = { feature: "\u529F\u80FD", scenario: "\u573A\u666F", decision: "\u51B3\u7B56", design: "\u8BBE\u8BA1\u89C4\u683C", e2e_test: "E2E \u6D4B\u8BD5" };
  const typeLabel = typeLabelMapMinimal[t.type] ?? t.type;
  const minimalSections = [];
  minimalSections.push(`# \u5B9E\u73B0\u4EFB\u52A1\uFF1A${typeLabel} ${t.id}`, "");
  minimalSections.push(`**\u76EE\u6807**: ${packet.implementationBlueprintDraft.objective.description}`, "");
  minimalSections.push("## \u5FC5\u8BFB\u5236\u54C1", "");
  minimalSections.push("```bash");
  minimalSections.push(`artifact-graph packet --root <root> --${cliFlag(t.type)} ${t.id} --format markdown`);
  minimalSections.push("```", "");
  minimalSections.push("## \u9A8C\u8BC1\u547D\u4EE4", "");
  minimalSections.push("```bash");
  minimalSections.push("pnpm build && pnpm test");
  minimalSections.push("artifact-graph validate --root <root> --warning-only");
  minimalSections.push("artifact-graph version-lock audit --root <root> --strict-missing-lock");
  minimalSections.push("```", "");
  minimalSections.push("## \u63D0\u4EA4\u8981\u6C42", "");
  minimalSections.push("- \u63D0\u4EA4\u524D\u8FD0\u884C `git diff --check` \u548C `git status --short`");
  minimalSections.push("");
  minimalSections.push("## \u7981\u6B62\u4E8B\u9879", "");
  minimalSections.push("- \u4E0D\u5F97\u5F15\u5165 PRD \u4E2D\u672A\u51FA\u73B0\u7684\u65B0\u529F\u80FD");
  minimalSections.push("- SEC severity \u4E0D\u5141\u8BB8\u964D\u7EA7");
  minimalSections.push("- \u4E0D\u5F97\u56DE\u9000\u7528\u6237\u5DF2\u6709\u7684 dirty work", "");
  minimalSections.push("---", "");
  minimalSections.push(`> \u7531 artifact-graph packet-prompt \u81EA\u52A8\u751F\u6210 (${packet.generatedAt})\u3002`);
  minimalSections.push("");
  const minimalText = minimalSections.join("\n");
  if (minimalText.length <= maxChars) {
    return minimalText;
  }
  const absMin = [];
  absMin.push(`# \u5B9E\u73B0\u4EFB\u52A1\uFF1A${typeLabel} ${t.id}`, "");
  absMin.push("## \u5FC5\u8BFB\u5236\u54C1");
  absMin.push("```bash");
  absMin.push(`artifact-graph packet --root <root> --${cliFlag(t.type)} ${t.id}`);
  absMin.push("```", "");
  absMin.push("## \u9A8C\u8BC1\u547D\u4EE4");
  absMin.push("```bash");
  absMin.push("pnpm build && pnpm test");
  absMin.push("artifact-graph validate --root <root> --warning-only");
  absMin.push("git diff --check");
  absMin.push("```", "");
  absMin.push("## \u7981\u6B62\u4E8B\u9879");
  absMin.push("- \u4E0D\u5F97\u56DE\u9000\u7528\u6237\u5DF2\u6709\u6539\u52A8");
  absMin.push("- SEC severity \u4E0D\u5141\u8BB8\u964D\u7EA7");
  absMin.push("");
  const absMinText = absMin.join("\n");
  if (absMinText.length <= maxChars) {
    return absMinText;
  }
  return {
    ok: false,
    reason: "\u65E0\u6CD5\u5C06\u63D0\u793A\u8BCD\u538B\u7F29\u5230\u6307\u5B9A\u957F\u5EA6",
    actualLength: absMinText.length,
    minRequired: absMinText.length
  };
}

// src/packet-prompt-validator.ts
var REQUIRED_CHECKS = [
  {
    code: "PP-001",
    description: "\u76EE\u6807\u4FE1\u606F",
    test: (t) => /实现任务/.test(t),
    severity: "error"
  },
  {
    code: "PP-002",
    description: "packet \u547D\u4EE4\u6216\u6765\u6E90\u5F15\u7528",
    test: (t) => /packet\s+--root/.test(t) || /packet\.json/.test(t) || /artifact-graph\s+packet/.test(t),
    severity: "error"
  },
  {
    code: "PP-003",
    description: "\u9A8C\u8BC1\u547D\u4EE4",
    test: (t) => /验证命令/.test(t) || /artifact-graph\s+(build|test)/.test(t),
    severity: "error"
  },
  {
    code: "PP-004",
    description: "\u63D0\u4EA4\u8981\u6C42",
    test: (t) => /提交要求/.test(t) || /git\s+diff\s+--check/.test(t),
    severity: "error"
  },
  {
    code: "PP-005",
    description: "\u7981\u6B62\u4E8B\u9879",
    test: (t) => /禁止事项/.test(t),
    severity: "error"
  },
  {
    code: "PP-006",
    description: "\u4E0D\u5F97\u56DE\u9000\u89C4\u5219",
    test: (t) => /不得回退/.test(t) || /不要回退/.test(t) || /no[- ]?revert/i.test(t),
    severity: "error"
  },
  {
    code: "PP-007",
    description: "SEC severity \u89C4\u5219",
    test: (t) => /SEC\s+severity/.test(t) || /severity/.test(t) && /降级/.test(t),
    severity: "error"
  }
];
function checkChineseDominance(text) {
  const textOutsideCode = text.replace(/```[\s\S]*?```/g, "");
  const cleanText = textOutsideCode.replace(/^[#>]+ .*$/gm, "").replace(/\[.*?\]\(.*?\)/g, "");
  const totalChars = cleanText.replace(/\s/g, "").length;
  if (totalChars === 0) return null;
  const cjkChars = (cleanText.match(/[一-鿿㐀-䶿]/g) || []).length;
  const ratio = cjkChars / totalChars;
  if (ratio < 0.3) {
    return {
      code: "PP-008",
      message: `\u4E2D\u6587\u5B57\u7B26\u5360\u6BD4 ${(ratio * 100).toFixed(1)}%\uFF0C\u4F4E\u4E8E 30% \u8981\u6C42`,
      severity: "warning"
    };
  }
  return null;
}
function validatePacketPrompt(prompt) {
  const issues = [];
  for (const check of REQUIRED_CHECKS) {
    if (!check.test(prompt)) {
      issues.push({
        code: check.code,
        message: `\u7F3A\u5C11${check.description}`,
        severity: check.severity
      });
    }
  }
  const langIssue = checkChineseDominance(prompt);
  if (langIssue) {
    issues.push(langIssue);
  }
  const hasErrors = issues.some((i) => i.severity === "error");
  return { ok: !hasErrors, issues };
}

// src/versioned-traceability.ts
import { createHash } from "crypto";
import { mkdir as mkdir2, readFile, writeFile as writeFile2 } from "fs/promises";
import { dirname, join as join2, relative } from "path";
var VERSION_LOCK_PATH = "artifacts/traceability-version-lock.json";
var VERSION_INDEX_SCHEMA_VERSION = "1.0";
var VERSION_LOCK_SCHEMA_VERSION = "1.0";
async function buildVersionIndex(root, graph) {
  const scannedGraph = graph ?? await scanArtifacts(root);
  const hashCache = /* @__PURE__ */ new Map();
  const nodes = await Promise.all(scannedGraph.nodes.map(async (node) => ({
    uid: node.uid,
    type: node.type,
    id: node.code,
    path: node.path,
    title: node.title,
    line: node.line,
    sourceKind: classifyNode(node),
    contentHash: await hashRelativePath(root, node.path, hashCache)
  })));
  const hashByUid = new Map(nodes.map((node) => [node.uid, node.contentHash]));
  const edges = scannedGraph.edges.map((edge2) => ({
    from: edge2.from,
    to: edge2.to,
    kind: normalizeVersionEdgeKind(edge2),
    source: edge2.source,
    sourcePath: edge2.sourcePath,
    sourceLine: edge2.sourceLine,
    fromHash: hashByUid.get(edge2.from),
    toHash: hashByUid.get(edge2.to)
  }));
  return {
    schemaVersion: VERSION_INDEX_SCHEMA_VERSION,
    root,
    graph: {
      nodes: scannedGraph.nodes.length,
      edges: scannedGraph.edges.length
    },
    nodes: sortBy(nodes, (node) => node.uid),
    edges: sortBy(edges, (edge2) => `${edge2.from}	${edge2.to}	${edge2.kind}	${edge2.sourcePath}	${edge2.sourceLine}`)
  };
}
async function auditVersionLock(root, lockPath = VERSION_LOCK_PATH, graph) {
  const index = await buildVersionIndex(root, graph);
  const safeLockPath = normalizeRelativePath(root, lockPath);
  const lock = await readVersionLock(root, safeLockPath);
  const nodeByArtifact = new Map(index.nodes.map((node) => [`${node.type}:${node.id}`, node]));
  const nodeByPath = new Map(index.nodes.map((node) => [node.path, node]));
  const currentEdges = implementationEdges(index);
  const currentEdgeIds = new Set(currentEdges.map((edge2) => edge2.edgeId));
  const issues = [];
  let fresh = 0;
  for (const entry of lock.locks) {
    const artifactNode = nodeByArtifact.get(`${entry.artifact.type}:${entry.artifact.id}`);
    const sourceNode = nodeByPath.get(entry.source.path);
    if (!artifactNode || !sourceNode) {
      issues.push({
        status: "orphan_lock",
        edgeId: entry.edgeId,
        message: `Lock references missing ${!artifactNode ? "artifact" : "source"} node`,
        artifact: entry.artifact,
        source: entry.source
      });
      continue;
    }
    const entryIssues = [];
    if (!currentEdgeIds.has(entry.edgeId)) {
      entryIssues.push({
        status: "orphan_lock",
        edgeId: entry.edgeId,
        message: `Locked traceability edge no longer exists in the current graph`,
        artifact: entry.artifact,
        source: entry.source
      });
    }
    if (artifactNode.contentHash !== entry.artifact.contentHash) {
      entryIssues.push({
        status: "artifact_changed",
        edgeId: entry.edgeId,
        message: `${entry.artifact.type}:${entry.artifact.id} changed since the lock was written`,
        artifact: entry.artifact,
        source: entry.source,
        currentArtifactHash: artifactNode.contentHash
      });
    }
    if (sourceNode.contentHash !== entry.source.contentHash) {
      entryIssues.push({
        status: "source_changed",
        edgeId: entry.edgeId,
        message: `${entry.source.path} changed since the lock was written`,
        artifact: entry.artifact,
        source: entry.source,
        currentSourceHash: sourceNode.contentHash
      });
    }
    for (const verifiedBy of entry.verifiedBy ?? []) {
      const verifierNode = nodeByPath.get(verifiedBy.path);
      if (!verifierNode) {
        entryIssues.push({
          status: "orphan_lock",
          edgeId: entry.edgeId,
          message: `Verifier ${verifiedBy.path} is missing`,
          artifact: entry.artifact,
          source: entry.source,
          verifiedByPath: verifiedBy.path
        });
        continue;
      }
      if (verifierNode.contentHash !== verifiedBy.contentHash) {
        entryIssues.push({
          status: "verified_by_changed",
          edgeId: entry.edgeId,
          message: `Verifier ${verifiedBy.path} changed since the lock was written`,
          artifact: entry.artifact,
          source: entry.source,
          currentVerifiedByHash: verifierNode.contentHash,
          verifiedByPath: verifiedBy.path
        });
      }
      if (artifactNode && !currentEdges.some((edge2) => edge2.from === verifierNode.uid && edge2.to === artifactNode.uid)) {
        entryIssues.push({
          status: "orphan_lock",
          edgeId: entry.edgeId,
          message: `Verifier ${verifiedBy.path} no longer declares a traceability link to ${entry.artifact.type}:${entry.artifact.id}`,
          artifact: entry.artifact,
          source: entry.source,
          verifiedByPath: verifiedBy.path
        });
      }
    }
    if (entryIssues.length === 0) {
      fresh += 1;
    } else {
      issues.push(...entryIssues);
    }
  }
  const reportedMissingLocks = /* @__PURE__ */ new Set();
  for (const edge2 of currentEdges) {
    const edgeId = edge2.edgeId;
    if (!lock.locks.some((entry) => entry.edgeId === edgeId)) {
      if (reportedMissingLocks.has(edgeId)) {
        continue;
      }
      reportedMissingLocks.add(edgeId);
      const source = index.nodes.find((node) => node.uid === edge2.from);
      const artifact = index.nodes.find((node) => node.uid === edge2.to);
      issues.push({
        status: "missing_lock",
        edgeId,
        message: `${edge2.from} ${edge2.kind} ${edge2.to} has no version lock`,
        artifact: artifact ? lockRefFromNode(artifact) : void 0,
        source: source ? sourceRefFromNode(source) : void 0
      });
    }
  }
  return {
    schemaVersion: "1.0",
    root,
    lockPath: safeLockPath,
    totalLocks: lock.locks.length,
    fresh,
    issues: sortBy(issues, (issue2) => `${issue2.status}	${issue2.edgeId}	${issue2.verifiedByPath ?? ""}`)
  };
}
async function updateVersionLock(root, options) {
  const index = await buildVersionIndex(root);
  const currentEdges = implementationEdges(index);
  const targetUid = parseTarget(options.target);
  const sourcePath = normalizeRelativePath(root, options.source);
  const source = index.nodes.find((node) => node.path === sourcePath);
  const artifact = index.nodes.find((node) => node.uid === targetUid);
  if (!artifact) {
    throw new Error(`Target artifact not found: ${options.target}`);
  }
  if (!source) {
    throw new Error(`Source node not found or has no traceability comment: ${sourcePath}`);
  }
  if (source.sourceKind !== "code" && source.sourceKind !== "test") {
    throw new Error(`Source must be code or test, got ${source.sourceKind}: ${sourcePath}`);
  }
  const matchingEdge = currentEdges.find((edge2) => edge2.from === source.uid && edge2.to === artifact.uid);
  if (!matchingEdge) {
    throw new Error(`Source ${sourcePath} does not declare a traceability link to ${options.target}`);
  }
  const verifiedBy = (options.verifiedBy ?? []).map((path) => {
    const verifierPath = normalizeRelativePath(root, path);
    const verifier = index.nodes.find((node) => node.path === verifierPath);
    if (!verifier) {
      throw new Error(`Verifier node not found or has no traceability comment: ${verifierPath}`);
    }
    if (verifier.sourceKind !== "code" && verifier.sourceKind !== "test") {
      throw new Error(`Verifier must be code or test, got ${verifier.sourceKind}: ${verifierPath}`);
    }
    const verifierEdge = currentEdges.find((edge2) => edge2.from === verifier.uid && edge2.to === artifact.uid);
    if (!verifierEdge) {
      throw new Error(`Verifier ${verifierPath} does not declare a traceability link to ${options.target}`);
    }
    return sourceRefFromNode(verifier);
  });
  const kind = source.sourceKind === "test" ? "verifies" : "implements";
  const entry = {
    edgeId: lockEdgeIdFor(source, artifact, kind),
    kind,
    artifact: lockRefFromNode(artifact),
    source: sourceRefFromNode(source),
    verifiedBy: verifiedBy.length > 0 ? sortBy(verifiedBy, (item) => item.path) : void 0
  };
  const lockPath = normalizeRelativePath(root, options.lockPath ?? VERSION_LOCK_PATH);
  const lock = await readVersionLock(root, lockPath);
  const filtered = lock.locks.filter((item) => item.edgeId !== entry.edgeId);
  const next = {
    schemaVersion: VERSION_LOCK_SCHEMA_VERSION,
    locks: sortBy([...filtered, entry], (item) => item.edgeId)
  };
  await writeVersionLock(root, lockPath, next);
  return next;
}
async function bootstrapVersionLock(root, options = {}) {
  const index = await buildVersionIndex(root);
  const lockPath = normalizeRelativePath(root, options.lockPath ?? VERSION_LOCK_PATH);
  if (!options.force) {
    const existing = await readVersionLock(root, lockPath);
    if (existing.locks.length > 0) {
      throw new Error(`Version lock already contains ${existing.locks.length} locks. Use --force to overwrite.`);
    }
  }
  const nodeByUid = new Map(index.nodes.map((node) => [node.uid, node]));
  const entries = /* @__PURE__ */ new Map();
  for (const edge2 of implementationEdges(index)) {
    const source = nodeByUid.get(edge2.from);
    const artifact = nodeByUid.get(edge2.to);
    if (!source || !artifact) {
      continue;
    }
    const kind = source.sourceKind === "test" ? "verifies" : "implements";
    const edgeId = edge2.edgeId;
    if (entries.has(edgeId)) {
      continue;
    }
    entries.set(edgeId, {
      edgeId,
      kind,
      artifact: lockRefFromNode(artifact),
      source: sourceRefFromNode(source)
    });
  }
  const next = {
    schemaVersion: VERSION_LOCK_SCHEMA_VERSION,
    locks: sortBy([...entries.values()], (item) => item.edgeId)
  };
  await writeVersionLock(root, lockPath, next);
  return next;
}
async function refreshVersionLock(root, options = {}) {
  const lockPath = normalizeRelativePath(root, options.lockPath ?? VERSION_LOCK_PATH);
  const changedPaths = sortUnique((options.changedPaths ?? []).map((path) => normalizeRelativePath(root, path)));
  const all = options.all === true || options.changedOnly !== true;
  const mode = all ? "all" : "changed-only";
  const warnings = [];
  if (!all && changedPaths.includes("artifact-graph.config.yaml")) {
    throw new Error("Changed-only version-lock refresh includes artifact-graph.config.yaml and requires --all");
  }
  const index = await buildVersionIndex(root);
  const lock = await readVersionLock(root, lockPath);
  const nodeByUid = new Map(index.nodes.map((node) => [node.uid, node]));
  const nodeByPath = new Map(index.nodes.map((node) => [node.path, node]));
  const currentImplementationEdges = implementationEdges(index);
  const currentEdgePairs = new Set(currentImplementationEdges.map((edge2) => `${edge2.from}	${edge2.to}`));
  const currentEntries = /* @__PURE__ */ new Map();
  const changedPathSet = new Set(changedPaths);
  const affectedEdges = /* @__PURE__ */ new Set();
  const addedLocks = [];
  const updatedLocks = [];
  const retainedOrphans = [];
  const removedOrphans = [];
  const nextLocks = /* @__PURE__ */ new Map();
  for (const edge2 of currentImplementationEdges) {
    const source = nodeByUid.get(edge2.from);
    const artifact = nodeByUid.get(edge2.to);
    if (!source || !artifact || currentEntries.has(edge2.edgeId)) {
      continue;
    }
    const existing = lock.locks.find((entry) => entry.edgeId === edge2.edgeId);
    currentEntries.set(edge2.edgeId, lockEntryFromCurrentEdge(
      edge2.edgeId,
      source,
      artifact,
      existing,
      nodeByPath,
      currentEdgePairs,
      options.removeOrphans === true,
      removedOrphans
    ));
  }
  for (const existing of lock.locks) {
    const current = currentEntries.get(existing.edgeId);
    const affected = all || lockEntryTouchesAnyPath(existing, changedPathSet);
    if (affected) {
      affectedEdges.add(existing.edgeId);
    }
    if (!current) {
      if (affected && options.removeOrphans === true) {
        removedOrphans.push(existing.edgeId);
      } else {
        if (affected) {
          retainedOrphans.push(existing.edgeId);
        }
        nextLocks.set(existing.edgeId, existing);
      }
      continue;
    }
    if (affected || currentEdgeTouchesAnyPath(current, changedPathSet)) {
      affectedEdges.add(existing.edgeId);
      if (stableEntryJson(existing) !== stableEntryJson(current)) {
        updatedLocks.push(existing.edgeId);
      }
      nextLocks.set(existing.edgeId, current);
    } else {
      nextLocks.set(existing.edgeId, existing);
    }
  }
  for (const [edgeId, current] of currentEntries) {
    if (nextLocks.has(edgeId)) {
      continue;
    }
    const affected = all || currentEdgeTouchesAnyPath(current, changedPathSet);
    if (!affected) {
      continue;
    }
    affectedEdges.add(edgeId);
    addedLocks.push(edgeId);
    nextLocks.set(edgeId, current);
  }
  if (mode === "changed-only" && changedPaths.length === 0) {
    warnings.push("No changed paths were provided; no locks were refreshed.");
  }
  const next = {
    schemaVersion: VERSION_LOCK_SCHEMA_VERSION,
    locks: sortBy([...nextLocks.values()], (item) => item.edgeId)
  };
  await writeVersionLock(root, lockPath, next);
  const postAudit = await auditVersionLock(root, lockPath);
  return {
    schemaVersion: "1.0",
    root,
    lockPath,
    mode,
    changedPaths,
    affectedEdges: sortUnique([...affectedEdges]),
    addedLocks: sortUnique(addedLocks),
    updatedLocks: sortUnique(updatedLocks),
    retainedOrphans: sortUnique(retainedOrphans),
    removedOrphans: sortUnique(removedOrphans),
    postAudit,
    warnings
  };
}
async function traceVersion(root, target, lockPath = VERSION_LOCK_PATH) {
  const index = await buildVersionIndex(root);
  const safeLockPath = normalizeRelativePath(root, lockPath);
  const audit = await auditVersionLock(root, safeLockPath);
  const targetUid = parseTarget(target);
  const lock = await readVersionLock(root, safeLockPath);
  const targetNode = index.nodes.find((node) => node.uid === targetUid);
  const targetIssues = targetNode ? [] : [{
    status: "target_not_found",
    edgeId: targetUid,
    message: `Target artifact not found: ${target}`
  }];
  return {
    schemaVersion: "1.0",
    root,
    lockPath: safeLockPath,
    target: {
      uid: targetUid,
      node: targetNode
    },
    currentEdges: index.edges.filter((edge2) => edge2.from === targetUid || edge2.to === targetUid),
    locks: lock.locks.filter((entry) => `${entry.artifact.type}:${entry.artifact.id}` === targetUid),
    issues: [...targetIssues, ...audit.issues.filter((issue2) => `${issue2.artifact?.type}:${issue2.artifact?.id}` === targetUid || issue2.edgeId.includes(`#${targetUid}`))]
  };
}
function renderVersionLockAuditMarkdown(result) {
  const lines = [
    "# Version Lock Audit",
    "",
    `Root: \`${result.root}\``,
    `Lock: \`${result.lockPath}\``,
    `Locks: ${result.totalLocks} | Fresh: ${result.fresh} | Issues: ${result.issues.length}`,
    ""
  ];
  if (result.issues.length === 0) {
    lines.push("No version lock issues.");
    return `${lines.join("\n")}
`;
  }
  for (const issue2 of result.issues) {
    lines.push(`- [${issue2.status}] \`${issue2.edgeId}\` \u2014 ${issue2.message}`);
  }
  return `${lines.join("\n")}
`;
}
function renderVersionLockRefreshMarkdown(result) {
  const lines = [
    "# Version Lock Refresh",
    "",
    `Root: \`${result.root}\``,
    `Lock: \`${result.lockPath}\``,
    `Mode: \`${result.mode}\``,
    `Changed paths: ${result.changedPaths.length}`,
    `Affected edges: ${result.affectedEdges.length}`,
    `Added: ${result.addedLocks.length} | Updated: ${result.updatedLocks.length} | Retained orphans: ${result.retainedOrphans.length} | Removed orphans: ${result.removedOrphans.length}`,
    `Post-audit issues: ${result.postAudit.issues.length}`,
    ""
  ];
  appendList(lines, "Added Locks", result.addedLocks);
  appendList(lines, "Updated Locks", result.updatedLocks);
  appendList(lines, "Retained Orphans", result.retainedOrphans);
  appendList(lines, "Removed Orphans", result.removedOrphans);
  appendList(lines, "Warnings", result.warnings);
  if (result.postAudit.issues.length > 0) {
    lines.push("## Post-Audit Issues");
    for (const issue2 of result.postAudit.issues) {
      lines.push(`- [${issue2.status}] \`${issue2.edgeId}\` \u2014 ${issue2.message}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}
`;
}
function renderTraceVersionMarkdown(result) {
  const lines = [
    "# Trace Version",
    "",
    `Target: \`${result.target.uid}\``,
    result.target.node ? `Current hash: \`${result.target.node.contentHash}\`` : "Current hash: target not found",
    `Edges: ${result.currentEdges.length} | Locks: ${result.locks.length} | Issues: ${result.issues.length}`,
    ""
  ];
  if (result.locks.length > 0) {
    lines.push("## Locks");
    for (const lock of result.locks) {
      lines.push(`- \`${lock.edgeId}\` source=\`${lock.source.path}\` sourceHash=\`${lock.source.contentHash}\` artifactHash=\`${lock.artifact.contentHash}\``);
    }
    lines.push("");
  }
  if (result.currentEdges.length > 0) {
    lines.push("## Current Edges");
    for (const edge2 of result.currentEdges) {
      lines.push(`- \`${edge2.from}\` ${edge2.kind} \`${edge2.to}\` fromHash=\`${edge2.fromHash ?? "unknown"}\` toHash=\`${edge2.toHash ?? "unknown"}\``);
    }
    lines.push("");
  }
  if (result.issues.length > 0) {
    lines.push("## Issues");
    for (const issue2 of result.issues) {
      lines.push(`- [${issue2.status}] \`${issue2.edgeId}\` \u2014 ${issue2.message}`);
    }
  }
  return `${lines.join("\n")}
`;
}
async function readVersionLock(root, lockPath) {
  const safeLockPath = normalizeRelativePath(root, lockPath);
  try {
    const raw = await readFile(join2(root, safeLockPath), "utf-8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Version lock ${safeLockPath} is not valid JSON: ${error.message}`);
    }
    return validateVersionLockFile(parsed, safeLockPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { schemaVersion: VERSION_LOCK_SCHEMA_VERSION, locks: [] };
    }
    throw error;
  }
}
function validateVersionLockFile(value, lockPath) {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid version lock schema in ${lockPath}: root must be an object`);
  }
  const record = value;
  if (record.schemaVersion !== VERSION_LOCK_SCHEMA_VERSION || !Array.isArray(record.locks)) {
    throw new Error(`Invalid version lock schema in ${lockPath}`);
  }
  const seen = /* @__PURE__ */ new Set();
  const locks = record.locks.map((entry, index) => validateVersionLockEntry(entry, index, seen));
  return {
    schemaVersion: VERSION_LOCK_SCHEMA_VERSION,
    locks
  };
}
function validateVersionLockEntry(value, index, seen) {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid version lock entry at locks[${index}]: entry must be an object`);
  }
  const entry = value;
  const edgeId = requireString(entry.edgeId, `locks[${index}].edgeId`);
  if (seen.has(edgeId)) {
    throw new Error(`Invalid version lock entry at locks[${index}]: duplicate edgeId ${edgeId}`);
  }
  seen.add(edgeId);
  const kind = requireString(entry.kind, `locks[${index}].kind`);
  if (kind !== "implements" && kind !== "verifies") {
    throw new Error(`Invalid version lock entry at locks[${index}]: kind must be implements or verifies`);
  }
  const artifact = validateVersionLockRef(entry.artifact, `locks[${index}].artifact`);
  const source = validateVersionLockSourceRef(entry.source, `locks[${index}].source`);
  const verifiedBy = entry.verifiedBy === void 0 ? void 0 : validateVerifiedBy(entry.verifiedBy, `locks[${index}].verifiedBy`);
  return {
    edgeId,
    kind,
    artifact,
    source,
    verifiedBy
  };
}
function validateVersionLockRef(value, path) {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid version lock entry at ${path}: ref must be an object`);
  }
  const record = value;
  return {
    type: requireString(record.type, `${path}.type`),
    id: requireString(record.id, `${path}.id`),
    path: requireSafeRelativePath(requireString(record.path, `${path}.path`), `${path}.path`),
    contentHash: requireHash(record.contentHash, `${path}.contentHash`)
  };
}
function validateVersionLockSourceRef(value, path) {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid version lock entry at ${path}: source must be an object`);
  }
  const record = value;
  const type = requireString(record.type, `${path}.type`);
  if (type !== "code" && type !== "test") {
    throw new Error(`Invalid version lock entry at ${path}.type: source type must be code or test`);
  }
  return {
    type,
    path: requireSafeRelativePath(requireString(record.path, `${path}.path`), `${path}.path`),
    contentHash: requireHash(record.contentHash, `${path}.contentHash`)
  };
}
function validateVerifiedBy(value, path) {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid version lock entry at ${path}: verifiedBy must be an array`);
  }
  return value.map((item, index) => validateVersionLockSourceRef(item, `${path}[${index}]`));
}
function requireString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid version lock entry at ${path}: expected non-empty string`);
  }
  return value;
}
function requireHash(value, path) {
  const hash = requireString(value, path);
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Invalid version lock entry at ${path}: expected sha256 hash`);
  }
  return hash;
}
function requireSafeRelativePath(value, path) {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Invalid version lock entry at ${path}: path must stay within root`);
  }
  return normalized;
}
async function writeVersionLock(root, lockPath, lock) {
  const safeLockPath = normalizeRelativePath(root, lockPath);
  const fullPath = join2(root, safeLockPath);
  await mkdir2(dirname(fullPath), { recursive: true });
  await writeFile2(fullPath, `${JSON.stringify(lock, null, 2)}
`);
}
function implementationEdges(index) {
  const nodesByUid = new Map(index.nodes.map((node) => [node.uid, node]));
  return index.edges.filter((edge2) => {
    const source = nodesByUid.get(edge2.from);
    return source?.sourceKind === "code" || source?.sourceKind === "test";
  }).map((edge2) => {
    const source = nodesByUid.get(edge2.from);
    const artifact = nodesByUid.get(edge2.to);
    const kind = source.sourceKind === "test" ? "verifies" : "implements";
    return {
      ...edge2,
      kind,
      edgeId: artifact ? lockEdgeIdFor(source, artifact, kind) : `${source.sourceKind}:${source.path}#${kind}#${edge2.to}`
    };
  });
}
function lockRefFromNode(node) {
  return {
    type: node.type,
    id: node.id,
    path: node.path,
    contentHash: node.contentHash
  };
}
function sourceRefFromNode(node) {
  return {
    type: node.sourceKind === "test" ? "test" : "code",
    path: node.path,
    contentHash: node.contentHash
  };
}
function appendList(lines, title, items) {
  if (items.length === 0) {
    return;
  }
  lines.push(`## ${title}`);
  for (const item of items) {
    lines.push(`- \`${item}\``);
  }
  lines.push("");
}
function lockEntryFromCurrentEdge(edgeId, source, artifact, existing, nodeByPath, currentEdgePairs, removeOrphans, removedOrphans) {
  const verifiedBy = (existing?.verifiedBy ?? []).flatMap((item) => {
    const verifier = nodeByPath.get(item.path);
    if (!verifier || verifier.sourceKind !== "code" && verifier.sourceKind !== "test") {
      if (removeOrphans) {
        removedOrphans.push(`${edgeId}#verifiedBy:${item.path}`);
        return [];
      }
      return [item];
    }
    if (!currentEdgePairs.has(`${verifier.uid}	${artifact.uid}`)) {
      if (removeOrphans) {
        removedOrphans.push(`${edgeId}#verifiedBy:${item.path}`);
        return [];
      }
      return [sourceRefFromNode(verifier)];
    }
    return [sourceRefFromNode(verifier)];
  });
  return {
    edgeId,
    kind: source.sourceKind === "test" ? "verifies" : "implements",
    artifact: lockRefFromNode(artifact),
    source: sourceRefFromNode(source),
    verifiedBy: verifiedBy.length > 0 ? sortBy(verifiedBy, (item) => item.path) : void 0
  };
}
function currentEdgeTouchesAnyPath(entry, paths) {
  return paths.has(entry.artifact.path) || paths.has(entry.source.path) || (entry.verifiedBy ?? []).some((item) => paths.has(item.path));
}
function lockEntryTouchesAnyPath(entry, paths) {
  return currentEdgeTouchesAnyPath(entry, paths);
}
function stableEntryJson(entry) {
  return JSON.stringify({
    edgeId: entry.edgeId,
    kind: entry.kind,
    artifact: entry.artifact,
    source: entry.source,
    verifiedBy: entry.verifiedBy ?? []
  });
}
function normalizeVersionEdgeKind(edge2) {
  if (edge2.source === "test-comment") {
    return edge2.sourcePath.match(/\.(test|spec)\.(ts|tsx|rs)$/) ? "verifies" : "implements";
  }
  return edge2.kind;
}
function classifyNode(node) {
  if (node.type === "test") {
    return node.path.match(/\.(test|spec)\.(ts|tsx|rs)$/) ? "test" : "code";
  }
  return "artifact";
}
function parseTarget(target) {
  const separator = target.indexOf(":");
  if (separator < 1 || separator === target.length - 1) {
    throw new Error(`Invalid target "${target}". Expected type:id`);
  }
  return `${target.slice(0, separator)}:${target.slice(separator + 1)}`;
}
function lockEdgeIdFor(source, artifact, kind) {
  return `${source.sourceKind}:${source.path}#${kind}#${artifact.type}:${artifact.id}`;
}
async function hashRelativePath(root, path, cache) {
  const normalized = normalizeRelativePath(root, path);
  const cached = cache.get(normalized);
  if (cached) return cached;
  const content = await readFile(join2(root, normalized));
  const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  cache.set(normalized, hash);
  return hash;
}
function normalizeRelativePath(root, path) {
  const normalized = path.replace(/\\/g, "/");
  const relativePath = normalized.startsWith("/") ? relative(root, normalized).replace(/\\/g, "/") : normalized.replace(/^\.\//, "");
  if (relativePath === ".." || relativePath.startsWith("../")) {
    throw new Error(`Path is outside root: ${path}`);
  }
  return relativePath;
}
function sortBy(items, keyFn) {
  return [...items].sort((left, right) => keyFn(left).localeCompare(keyFn(right)));
}
function sortUnique(items) {
  return [...new Set(items)].sort((left, right) => left.localeCompare(right));
}

// src/cli-resolver.ts
import { execFile } from "child_process";
import { constants } from "fs";
import { access } from "fs/promises";
import { isAbsolute, join as join3, resolve } from "path";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
var KNOWN_COMMANDS = [
  "init",
  "scan",
  "validate",
  "query",
  "context",
  "packet",
  "packet-prompt",
  "packet-audit",
  "packet-prompt-audit",
  "version-index",
  "version-lock audit",
  "version-lock update",
  "version-lock bootstrap",
  "version-lock refresh",
  "trace-version",
  "next-id",
  "render",
  "doctor"
];
async function resolveArtifactGraphCli(root, options = {}) {
  const pathCli = await findCommandOnPath("artifact-graph");
  const legacyCliPath = options.projectCliPath ?? process.env.ARTIFACT_GRAPH_LEGACY_CLI;
  const candidates = [
    {
      source: "node_modules",
      path: join3(root, "node_modules/.bin/artifact-graph"),
      exists: false
    },
    {
      source: "path",
      path: pathCli ?? "artifact-graph",
      exists: pathCli !== void 0
    },
    {
      source: "legacy",
      path: legacyCliPath ? resolveCandidatePath(root, legacyCliPath) : "ARTIFACT_GRAPH_LEGACY_CLI",
      exists: false
    },
    {
      source: "plugin-bundled",
      path: resolveCandidatePath(root, options.fallbackPath ?? "dist/cli.js"),
      exists: false
    }
  ];
  for (const candidate of candidates) {
    candidate.exists = await pathExists(candidate.path);
  }
  const selected = candidates.find((candidate) => candidate.exists);
  const warnings = selected ? [] : ["No artifact-graph CLI was found in node_modules, PATH, explicit legacy override, or plugin-bundled locations."];
  return {
    path: selected?.path,
    source: selected?.source,
    candidates,
    warnings
  };
}
async function doctorArtifactChain(root, options = {}) {
  const cli = await resolveArtifactGraphCli(root, options);
  const configPath = join3(root, "artifact-graph.config.yaml");
  const lockPath = join3(root, VERSION_LOCK_PATH);
  const supportedCommands = cli.path ? await detectSupportedCommands(cli.path) : [];
  const nodeCompatible = isNodeCompatible(process.versions.node);
  const warnings = [
    ...cli.warnings,
    ...nodeCompatible ? [] : [`Node.js ${process.versions.node} does not satisfy >=22.0.0.`]
  ];
  return {
    schemaVersion: "1.0",
    root,
    cli,
    node: {
      version: process.versions.node,
      compatible: nodeCompatible,
      required: ">=22.0.0"
    },
    config: {
      path: configPath,
      exists: await pathExists(configPath)
    },
    lock: {
      path: lockPath,
      exists: await pathExists(lockPath)
    },
    supportedCommands,
    warnings
  };
}
function renderDoctorMarkdown(report) {
  const lines = [
    "# Artifact Chain Doctor",
    "",
    `Root: \`${report.root}\``,
    `CLI: ${report.cli.path ? `\`${report.cli.path}\` (${report.cli.source})` : "not found"}`,
    `Node: ${report.node.version} (${report.node.compatible ? "compatible" : "incompatible"}, required ${report.node.required})`,
    `Config: \`${report.config.path}\` ${report.config.exists ? "found" : "missing"}`,
    `Lock: \`${report.lock.path}\` ${report.lock.exists ? "found" : "missing"}`,
    ""
  ];
  if (report.supportedCommands.length > 0) {
    lines.push("## Supported Commands");
    for (const command of report.supportedCommands) {
      lines.push(`- \`${command}\``);
    }
    lines.push("");
  }
  if (report.warnings.length > 0) {
    lines.push("## Warnings");
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}
`;
}
async function detectSupportedCommands(cliPath) {
  const command = cliPath.endsWith(".js") ? process.execPath : cliPath;
  const args = cliPath.endsWith(".js") ? [cliPath, "--help"] : ["--help"];
  let help = "";
  try {
    const result = await execFileAsync(command, args);
    help = `${result.stdout}
${result.stderr}`;
  } catch (error) {
    const maybe = error;
    help = `${maybe.stdout ?? ""}
${maybe.stderr ?? ""}`;
  }
  return KNOWN_COMMANDS.filter((commandName) => help.includes(commandName));
}
async function pathExists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
async function findCommandOnPath(command) {
  try {
    const result = await execFileAsync("sh", ["-c", `command -v ${command}`]);
    const resolved = result.stdout.trim().split("\n")[0];
    return resolved.length > 0 ? resolved : void 0;
  } catch {
    return void 0;
  }
}
function resolveCandidatePath(root, candidatePath) {
  return isAbsolute(candidatePath) ? candidatePath : resolve(root, candidatePath);
}
function isNodeCompatible(version) {
  const major = Number(version.split(".")[0]);
  return Number.isFinite(major) && major >= 22;
}

// src/git-changes.ts
import { execFile as execFile2 } from "child_process";
import { promisify as promisify2 } from "util";
var execFileAsync2 = promisify2(execFile2);
async function collectChangedPaths(root, options) {
  const args = gitDiffArgs(options);
  let stdout;
  try {
    ({ stdout } = await execFileAsync2("git", args, { cwd: root }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to collect git changed paths (${options.mode}): ${message}`);
  }
  const changedPaths = normalizeGitPathList(stdout);
  const unstagedPaths = options.mode === "staged" ? await collectUnstagedPaths(root) : [];
  const stagedUnstagedConflictPaths = options.mode === "staged" ? intersect(changedPaths, unstagedPaths) : [];
  return {
    root,
    mode: options.mode,
    base: options.base,
    changedPaths,
    unstagedPaths,
    stagedUnstagedConflictPaths
  };
}
function gitDiffArgs(options) {
  const common = ["diff", "--name-only", "--diff-filter=ACDMRT"];
  if (options.mode === "staged") {
    return [...common, "--cached"];
  }
  if (options.mode === "worktree") {
    return common;
  }
  if (!options.base) {
    throw new Error("--base requires a ref when collecting base changed paths");
  }
  return [...common, `${options.base}...HEAD`];
}
async function collectUnstagedPaths(root) {
  try {
    const { stdout } = await execFileAsync2("git", ["diff", "--name-only", "--diff-filter=ACDMRT"], { cwd: root });
    return normalizeGitPathList(stdout);
  } catch {
    return [];
  }
}
function normalizeGitPathList(stdout) {
  return sortUnique2(stdout.split(/\r?\n/).map((line) => line.trim().replace(/\\/g, "/").replace(/^\.\//, "")).filter((line) => line.length > 0 && !line.startsWith("../") && !line.startsWith("/")));
}
function intersect(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}
function sortUnique2(items) {
  return [...new Set(items)].sort((left, right) => left.localeCompare(right));
}

// src/hook-installer.ts
import { chmod, mkdir as mkdir3, readFile as readFile2, writeFile as writeFile3 } from "fs/promises";
import { dirname as dirname2 } from "path";
var DEFAULT_MARKER_ID = "artifact-chain-assistant";
async function installManagedHookBlock(options) {
  const markerId = options.markerId ?? DEFAULT_MARKER_ID;
  const begin = beginMarker(markerId);
  const end = endMarker(markerId);
  const existing = await readHook(options.hookPath);
  const range = findManagedRange(existing, begin, end);
  if (options.uninstall === true) {
    if (!range) {
      return { hookPath: options.hookPath, action: "unchanged", markerId };
    }
    await writeHook(options.hookPath, stripExtraBlankLines(`${existing.slice(0, range.start)}${existing.slice(range.end)}`));
    return { hookPath: options.hookPath, action: "uninstalled", markerId };
  }
  const managedBlock = `${begin}
${options.block.trimEnd()}
${end}
`;
  const next = range ? `${existing.slice(0, range.start)}${managedBlock}${existing.slice(range.end)}` : appendManagedBlock(existing, managedBlock);
  await writeHook(options.hookPath, next);
  return { hookPath: options.hookPath, action: range ? "replaced" : "installed", markerId };
}
function beginMarker(markerId) {
  return `# >>> ${markerId} managed block >>>`;
}
function endMarker(markerId) {
  return `# <<< ${markerId} managed block <<<`;
}
async function readHook(hookPath) {
  try {
    return await readFile2(hookPath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "#!/bin/sh\n";
    }
    throw error;
  }
}
async function writeHook(hookPath, content) {
  await mkdir3(dirname2(hookPath), { recursive: true });
  await writeFile3(hookPath, content.endsWith("\n") ? content : `${content}
`);
  await chmod(hookPath, 493);
}
function findManagedRange(content, begin, end) {
  const start = content.indexOf(begin);
  if (start < 0) {
    return void 0;
  }
  const endStart = content.indexOf(end, start + begin.length);
  if (endStart < 0) {
    return void 0;
  }
  const endLine = content.indexOf("\n", endStart);
  return {
    start,
    end: endLine < 0 ? content.length : endLine + 1
  };
}
function appendManagedBlock(existing, managedBlock) {
  const base = existing.trimEnd();
  if (base.length === 0) {
    return managedBlock;
  }
  return `${base}

${managedBlock}`;
}
function stripExtraBlankLines(content) {
  return content.replace(/\n{3,}/g, "\n\n");
}

// src/index.ts
var TARGET_ARTIFACT_TYPES = VALID_PACKET_TARGET_TYPES;
var NON_TARGET_ROLES = ["context", "candidate", "not-recommended"];
function isTargetArtifactType(type) {
  return isPacketTargetType(type);
}
function normalizeArtifactTypeRole(role) {
  if (typeof role === "string") {
    if (isTargetArtifactType(role)) return role;
    if (NON_TARGET_ROLES.includes(role)) return role;
  }
  return "context";
}
function getArtifactTypeMetadata(schema, type) {
  const definition = schema.types[type];
  const role = normalizeArtifactTypeRole(definition?.role);
  const aliases = Array.isArray(definition?.aliases) ? definition.aliases.filter((alias) => typeof alias === "string" && alias.trim().length > 0) : [];
  return {
    type,
    displayName: definition?.displayName?.trim() || type,
    role,
    layer: definition?.layer?.trim() || "context",
    aliases,
    targetCapable: isTargetArtifactType(type) && role === type
  };
}
function getTargetArtifactTypes(schema = DEFAULT_SCHEMA) {
  return TARGET_ARTIFACT_TYPES.filter((type) => getArtifactTypeMetadata(schema, type).targetCapable);
}
var DEFAULT_SCHEMA = {
  types: {
    decision: { paths: ["artifacts/decisions/**/*.md"], displayName: "\u51B3\u7B56\u6587\u6863", role: "decision", layer: "decision", aliases: ["decisions", "adr"] },
    entity: { paths: ["artifacts/entities/entity-registry.md"], displayName: "\u5B9E\u4F53\u6CE8\u518C\u8868", role: "context", layer: "domain", aliases: ["entity-registry"] },
    feature: { paths: ["artifacts/prd/features/**/*.md"], displayName: "\u529F\u80FD\u7279\u6027", role: "feature", layer: "prd", aliases: ["prd-feature", "prd_features"] },
    scenario: { paths: ["artifacts/scenarios/**/*.md"], displayName: "\u573A\u666F\u5267\u672C", role: "scenario", layer: "scenario", aliases: ["scenarios", "scenario-script"] },
    design: { paths: ["artifacts/design/**/*.md"], displayName: "\u8BBE\u8BA1\u89C4\u683C", role: "design", layer: "design", aliases: ["design-spec", "design_docs"] },
    test: { paths: ["heimdall/packages/**/*.test.ts"], displayName: "\u4EE3\u7801\u6CE8\u91CA\u8FFD\u6EAF", role: "context", layer: "implementation", aliases: ["code-test", "code-trace", "unit-test"] },
    e2e_test: { paths: ["artifacts/tests/e2e/*.md"], displayName: "E2E \u6D4B\u8BD5\u89C4\u683C", role: "e2e_test", layer: "verification", aliases: ["e2e-test", "e2e_tests"] },
    e2e_registry: { paths: ["artifacts/tests/e2e/e2e-test-registry.json"], displayName: "E2E \u6D4B\u8BD5\u6CE8\u518C\u8868", role: "context", layer: "verification", aliases: ["e2e-registry"] },
    "rule-golden-cases": { paths: ["artifacts/tests/rule-golden-cases.md"], displayName: "\u89C4\u5219\u9EC4\u91D1\u6D4B\u8BD5\u7528\u4F8B", role: "context", layer: "verification", aliases: ["rule_golden_cases"] },
    "test-strategy": { paths: ["artifacts/design/test-strategy.md"], displayName: "\u6D4B\u8BD5\u7B56\u7565", role: "context", layer: "verification", aliases: ["test_strategy"] },
    "traceability-matrix-v2": { paths: ["artifacts/traceability-matrix-v2.md"], displayName: "\u8FFD\u6EAF\u77E9\u9635 v2", role: "context", layer: "traceability", aliases: ["traceability_matrix_v2"] }
  },
  idPatterns: {
    decision: "^D-[A-Z]+-\\d+$",
    entity: "^E-\\d{3,}$",
    feature: "^[A-Z]{1,4}\\d+$",
    scenario: "^S-\\d+[a-z]?$",
    design: "^[A-Za-z0-9._-]+$",
    test: "^.+\\.test\\.ts$",
    e2e_test: "^.+:(TC-\\d+[a-z]?|FILE)$",
    e2e_registry: "^e2e-test-registry$",
    "rule-golden-cases": "^[A-Z]+-\\d{3}:(pass|fail|edge)$",
    "test-strategy": "^(unit|integration|e2e|desktop_chain|rule|contract)$",
    "traceability-matrix-v2": "^.+$"
  },
  relationFields: {
    feature: ["scenarios", "decisions", "depends_on", "design_docs"],
    scenario: ["\u5173\u8054\u529F\u80FD", "\u5173\u8054\u51B3\u7B56"],
    design: ["related_features", "related_scenarios"],
    test: ["@scenario", "@feature", "@entity", "@decision"],
    e2e_test: ["test_batch", "scope", "ac_coverage", "related_scenarios", "related_decisions", "related_entities", "\u8986\u76D6\u573A\u666F", "\u8986\u76D6\u529F\u80FD"],
    e2e_registry: ["batches"]
  },
  allowedEdges: [],
  forbiddenEdges: [{ from: "scenario", to: "entity", kind: "references" }],
  statuses: ["planned", "active", "done", "deprecated"],
  idRanges: {}
};
async function loadConfig(root) {
  const configPath = join4(root, "artifact-graph.config.yaml");
  let parsed = {};
  try {
    const raw = await readFile3(configPath, "utf-8");
    parsed = yaml.load(raw) ?? {};
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return {
    ...DEFAULT_SCHEMA,
    ...parsed,
    types: mergeArtifactTypes(DEFAULT_SCHEMA.types, parsed.types),
    idPatterns: mergeRecord(DEFAULT_SCHEMA.idPatterns, parsed.idPatterns),
    relationFields: mergeRecord(DEFAULT_SCHEMA.relationFields, parsed.relationFields),
    allowedEdges: parsed.allowedEdges ?? DEFAULT_SCHEMA.allowedEdges,
    forbiddenEdges: parsed.forbiddenEdges ?? DEFAULT_SCHEMA.forbiddenEdges,
    statuses: parsed.statuses ?? DEFAULT_SCHEMA.statuses,
    idRanges: mergeRecord(DEFAULT_SCHEMA.idRanges, parsed.idRanges)
  };
}
function buildGraph(nodes, edges) {
  const graphNodes = nodes.map((node) => ({ ...node, uid: toUid(node.type, node.code) }));
  graphNodes.sort(compareNode);
  edges.sort(compareEdge);
  const seen = /* @__PURE__ */ new Set();
  const dedupedEdges = [];
  for (const e of edges) {
    const key = `${e.from}	${e.to}	${e.kind}	${e.source}	${e.sourcePath}	${e.sourceLine}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedEdges.push(e);
    }
  }
  return {
    nodes: graphNodes,
    edges: dedupedEdges,
    generatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
  };
}
async function scanArtifacts(root, schema) {
  const config = schema ?? await loadConfig(root);
  const nodes = [];
  const edges = [];
  const scannedFiles = /* @__PURE__ */ new Set();
  for (const [type, definition] of artifactTypeEntriesBySpecificity(config)) {
    const files = await findFiles(root, definition.paths);
    for (const file of files) {
      if (scannedFiles.has(file)) {
        continue;
      }
      scannedFiles.add(file);
      const raw = await readFile3(join4(root, file), "utf-8");
      const parsed = parseFile(type, file, raw);
      nodes.push(...parsed.nodes);
      edges.push(...parsed.edges);
    }
  }
  const graph = buildGraph(nodes, edges);
  return resolveMatrixEdges(graph);
}
function artifactTypeEntriesBySpecificity(schema) {
  return Object.entries(schema.types).sort((left, right) => {
    const specificity = artifactTypePathSpecificity(right[1]) - artifactTypePathSpecificity(left[1]);
    return specificity !== 0 ? specificity : left[0].localeCompare(right[0]);
  });
}
function artifactTypePathSpecificity(definition) {
  return Math.max(...definition.paths.map((pathPattern) => {
    const wildcardPenalty = (pathPattern.match(/\*/g) ?? []).length * 1e3;
    const exactBonus = pathPattern.includes("*") ? 0 : 1e5;
    return exactBonus + pathPattern.length - wildcardPenalty;
  }), 0);
}
function resolveMatrixEdges(graph) {
  const idToArtifact = /* @__PURE__ */ new Map();
  for (const node of graph.nodes) {
    if (node.type === "traceability-matrix-v2") continue;
    const bare = node.code;
    if (bare && !idToArtifact.has(bare)) {
      idToArtifact.set(bare, node.uid);
    }
  }
  const matrixCodeToBareId = /* @__PURE__ */ new Map();
  for (const node of graph.nodes) {
    if (node.type === "traceability-matrix-v2") {
      const attrs = node.attrs;
      if (attrs?.id) {
        matrixCodeToBareId.set(node.code, attrs.id);
      }
    }
  }
  const resolved = [];
  for (const e of graph.edges) {
    if (e.to.startsWith("resolve:")) {
      const bareId = e.to.slice("resolve:".length);
      if (/^ADR-\d+$/i.test(bareId)) continue;
      if (/\.\w+$/.test(bareId)) continue;
      const artifactUid = idToArtifact.get(bareId);
      resolved.push({ ...e, to: artifactUid ?? e.to });
      continue;
    }
    resolved.push(e);
    if (e.from.startsWith("traceability-matrix-v2:") && e.to.startsWith("traceability-matrix-v2:")) {
      const targetMatrixCode = e.to.slice("traceability-matrix-v2:".length);
      const targetBareId = matrixCodeToBareId.get(targetMatrixCode);
      if (targetBareId) {
        const artifactUid = idToArtifact.get(targetBareId);
        if (artifactUid) {
          resolved.push({ ...e, to: artifactUid });
        }
      }
    }
  }
  return { ...graph, edges: resolved };
}
function validateGraph(graph, schema = DEFAULT_SCHEMA) {
  const issues = [];
  const byUid = /* @__PURE__ */ new Map();
  for (const node of graph.nodes) {
    const bucket = byUid.get(node.uid) ?? [];
    bucket.push(node);
    byUid.set(node.uid, bucket);
  }
  for (const duplicates of byUid.values()) {
    if (duplicates.length > 1) {
      for (const node of duplicates) {
        issues.push(issue("DUPLICATE_ID", `Duplicate artifact ID ${node.uid}`, node.path, node.line, {
          node: node.uid,
          severity: node.type.startsWith("e2e_") ? "warning" : "error"
        }));
      }
    }
  }
  for (const node of graph.nodes) {
    const pattern = schema.idPatterns[node.type];
    if (pattern && !new RegExp(pattern).test(node.code)) {
      issues.push(issue("INVALID_ID", `Artifact ${node.uid} does not match ${pattern}`, node.path, node.line, { node: node.uid }));
    }
    if (node.status && schema.statuses.length > 0 && !schema.statuses.includes(node.status)) {
      issues.push(issue("INVALID_STATUS", `Artifact ${node.uid} has invalid status "${node.status}"`, node.path, node.line, { node: node.uid }));
    }
    if (node.type === "feature" && Object.prototype.hasOwnProperty.call(node.attrs ?? {}, "entities")) {
      issues.push(issue(
        "FEATURE_ENTITY_FIELD_FORBIDDEN",
        "Feature frontmatter must not declare entities; entity traceability belongs in design specs and code comments",
        node.path,
        node.line,
        { node: node.uid }
      ));
    }
  }
  for (const edge2 of graph.edges) {
    if (!byUid.has(edge2.to)) {
      issues.push(issue("DANGLING_REFERENCE", `Reference target ${edge2.to} does not exist`, edge2.sourcePath, edge2.sourceLine, {
        edge: edge2,
        severity: edge2.from.startsWith("e2e_test:") ? "warning" : "error"
      }));
    }
    const fromType = edge2.from.split(":", 1)[0] ?? "";
    const toType = edge2.to.split(":", 1)[0] ?? "";
    if (schema.forbiddenEdges.some((rule) => rule.from === fromType && rule.to === toType && rule.kind === edge2.kind)) {
      issues.push(issue("FORBIDDEN_EDGE", `Forbidden ${fromType} -> ${toType} ${edge2.kind} relation`, edge2.sourcePath, edge2.sourceLine, { edge: edge2 }));
    }
  }
  issues.push(...validateE2eTests(graph));
  issues.push(...validateE2eRegistry(graph));
  issues.push(...validateCodeCommentTraceabilityFormat(graph));
  issues.push(...validateCodeCommentScenarioFeatureConsistency(graph));
  for (const edge2 of graph.edges) {
    if (edge2.kind !== "covers" || !edge2.from.startsWith("feature:") || !edge2.to.startsWith("scenario:")) {
      continue;
    }
    const reverseExists = graph.edges.some((candidate) => candidate.from === edge2.to && candidate.to === edge2.from && candidate.kind === "references");
    if (!reverseExists) {
      issues.push(issue("BIDIRECTIONAL_MISMATCH", `${edge2.from} lists ${edge2.to}, but reverse scenario relation is missing`, edge2.sourcePath, edge2.sourceLine, { edge: edge2 }));
    }
  }
  for (const edge2 of graph.edges) {
    if (edge2.kind !== "references" || !edge2.from.startsWith("scenario:") || !edge2.to.startsWith("feature:")) {
      continue;
    }
    const reverseExists = graph.edges.some((candidate) => candidate.from === edge2.to && candidate.to === edge2.from && candidate.kind === "covers");
    if (!reverseExists) {
      issues.push(issue("BIDIRECTIONAL_MISMATCH", `${edge2.from} references ${edge2.to}, but PRD feature does not list the scenario`, edge2.sourcePath, edge2.sourceLine, { edge: edge2 }));
    }
  }
  for (const edge2 of graph.edges) {
    if (edge2.kind !== "references" || !edge2.from.startsWith("feature:") || !edge2.to.startsWith("design:")) {
      continue;
    }
    const reverseExists = graph.edges.some((candidate) => candidate.from === edge2.to && candidate.to === edge2.from && candidate.kind === "references");
    if (!reverseExists) {
      issues.push(issue("BIDIRECTIONAL_MISMATCH", `${edge2.from} lists ${edge2.to}, but reverse design relation is missing`, edge2.sourcePath, edge2.sourceLine, { edge: edge2 }));
    }
  }
  for (const edge2 of graph.edges) {
    if (edge2.kind !== "references" || !edge2.from.startsWith("design:") || !edge2.to.startsWith("feature:")) {
      continue;
    }
    const reverseExists = graph.edges.some((candidate) => candidate.from === edge2.to && candidate.to === edge2.from && candidate.kind === "references");
    if (!reverseExists) {
      issues.push(issue("BIDIRECTIONAL_MISMATCH", `${edge2.from} references ${edge2.to}, but PRD feature does not list the design doc`, edge2.sourcePath, edge2.sourceLine, { edge: edge2 }));
    }
  }
  for (const node of graph.nodes) {
    if (node.type !== "feature") {
      continue;
    }
    const hasDesignLink = graph.edges.some((edgeValue) => edgeValue.kind === "references" && (edgeValue.from === node.uid && edgeValue.to.startsWith("design:") || edgeValue.to === node.uid && edgeValue.from.startsWith("design:")));
    if (!hasDesignLink) {
      issues.push(issue("DESIGN_COVERAGE_MISSING", `${node.uid} has no linked design spec`, node.path, node.line, { node: node.uid, severity: "warning" }));
    }
  }
  for (const cycle of findDependsOnCycles(graph)) {
    issues.push(issue("CYCLE_DETECTED", `depends_on cycle detected: ${cycle.join(" -> ")}`, "", 1, { node: cycle[0] }));
  }
  issues.sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path) || left.line - right.line);
  return issues;
}
function validateCodeCommentTraceabilityFormat(graph) {
  const issues = [];
  for (const node of graph.nodes) {
    if (node.type !== "test") {
      continue;
    }
    const invalidComments = node.attrs?.invalidTraceabilityComments;
    if (!Array.isArray(invalidComments)) {
      continue;
    }
    for (const invalid of invalidComments) {
      const line = typeof invalid?.line === "number" ? invalid.line : node.line;
      const reason = typeof invalid?.reason === "string" ? invalid.reason : "traceability tags must use standalone // comments";
      issues.push(issue(
        "CODE_COMMENT_TRACEABILITY_FORMAT",
        `${reason}: ${typeof invalid?.text === "string" ? invalid.text : ""}`.trim(),
        node.path,
        line,
        { node: node.uid }
      ));
    }
  }
  return issues;
}
function validateCodeCommentScenarioFeatureConsistency(graph) {
  const issues = [];
  const scenarioToFeatures = /* @__PURE__ */ new Map();
  for (const edgeValue of graph.edges) {
    if (edgeValue.kind === "references" && edgeValue.from.startsWith("scenario:") && edgeValue.to.startsWith("feature:")) {
      const features = scenarioToFeatures.get(edgeValue.from) ?? /* @__PURE__ */ new Set();
      features.add(edgeValue.to);
      scenarioToFeatures.set(edgeValue.from, features);
    }
    if (edgeValue.kind === "covers" && edgeValue.from.startsWith("feature:") && edgeValue.to.startsWith("scenario:")) {
      const features = scenarioToFeatures.get(edgeValue.to) ?? /* @__PURE__ */ new Set();
      features.add(edgeValue.from);
      scenarioToFeatures.set(edgeValue.to, features);
    }
  }
  const groups = /* @__PURE__ */ new Map();
  for (const edgeValue of graph.edges) {
    if (edgeValue.source !== "test-comment" || edgeValue.kind !== "verifies") {
      continue;
    }
    const targetType = edgeValue.to.split(":", 1)[0] ?? "";
    if (targetType !== "scenario" && targetType !== "feature") {
      continue;
    }
    const key = `${edgeValue.sourcePath}:${edgeValue.sourceLine}`;
    const group = groups.get(key) ?? { path: edgeValue.sourcePath, line: edgeValue.sourceLine, scenarios: [], features: [] };
    if (targetType === "scenario") {
      group.scenarios.push(edgeValue);
    } else {
      group.features.push(edgeValue);
    }
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.scenarios.length === 0 || group.features.length === 0) {
      continue;
    }
    const annotatedFeatures = new Set(group.features.map((edgeValue) => edgeValue.to));
    if (group.scenarios.length > 1 && annotatedFeatures.size > 1) {
      issues.push(issue(
        "CODE_COMMENT_AMBIGUOUS_TRACEABILITY",
        "Code traceability comment must not mix multiple scenarios with multiple features on one line; split into one mapping per line",
        group.path,
        group.line,
        { edge: group.scenarios[0] }
      ));
      continue;
    }
    for (const scenarioEdge of group.scenarios) {
      const expectedFeatures = scenarioToFeatures.get(scenarioEdge.to);
      if (!expectedFeatures || expectedFeatures.size === 0) {
        continue;
      }
      const hasMatchingFeature = [...expectedFeatures].some((featureUid) => annotatedFeatures.has(featureUid));
      if (!hasMatchingFeature) {
        issues.push(issue(
          "CODE_COMMENT_SCENARIO_FEATURE_MISMATCH",
          `${scenarioEdge.to} is linked to ${[...expectedFeatures].join(", ")}, but code comment lists ${[...annotatedFeatures].join(", ")}`,
          group.path,
          group.line,
          { edge: scenarioEdge }
        ));
      }
    }
  }
  return issues;
}
function queryGraph(graph, options) {
  const depth = options.depth ?? 1;
  const start = normalizeUid(options.from ?? options.to ?? "");
  const reverse = Boolean(options.to && !options.from);
  const selected = /* @__PURE__ */ new Set([start]);
  let frontier = /* @__PURE__ */ new Set([start]);
  for (let level = 0; level < depth; level += 1) {
    const next = /* @__PURE__ */ new Set();
    for (const edge2 of graph.edges) {
      if (!reverse && frontier.has(edge2.from)) {
        next.add(edge2.to);
      }
      if (!reverse && frontier.has(edge2.to)) {
        next.add(edge2.from);
      }
      if (reverse && frontier.has(edge2.to)) {
        next.add(edge2.from);
      }
    }
    for (const uid of next) {
      selected.add(uid);
    }
    frontier = next;
  }
  const nodes = graph.nodes.filter((node) => selected.has(node.uid));
  const edges = graph.edges.filter((edge2) => selected.has(edge2.from) && selected.has(edge2.to));
  return { ...graph, nodes, edges };
}
function renderMermaid(graph) {
  const lines = ["graph LR"];
  for (const node of graph.nodes) {
    lines.push(`  "${node.uid}"["${node.uid}<br/>${escapeMermaid(node.title)}"]`);
  }
  for (const edge2 of graph.edges) {
    lines.push(`  "${edge2.from}" -->|"${edge2.kind}"| "${edge2.to}"`);
  }
  return `${lines.join("\n")}
`;
}
function nextId(graph, schema, type, rangeName) {
  const range = schema.idRanges[type]?.[rangeName];
  if (!range) {
    throw new Error(`Unknown ID range ${type}.${rangeName}`);
  }
  const used = new Set(
    graph.nodes.filter((node) => node.type === type && node.code.startsWith(range.prefix)).map((node) => Number(node.code.slice(range.prefix.length).replace(/\D+$/, "")))
  );
  for (let id = range.start; id <= range.end; id += 1) {
    if (!used.has(id)) {
      return `${range.prefix}${id}`;
    }
  }
  throw new Error(`ID range ${type}.${rangeName} is exhausted`);
}
async function writeGraphCache(root, graph) {
  const cacheDir = join4(root, ".artifact-graph");
  await mkdir4(cacheDir, { recursive: true });
  await writeFile4(join4(cacheDir, "index.json"), `${JSON.stringify(graph, null, 2)}
`);
  const db = new Database(join4(cacheDir, "graph.sqlite"));
  try {
    db.exec(`
      DROP TABLE IF EXISTS nodes;
      DROP TABLE IF EXISTS edges;
      CREATE TABLE nodes (
        uid TEXT NOT NULL,
        type TEXT NOT NULL,
        code TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        status TEXT,
        attrs TEXT,
        aliases TEXT
      );
      CREATE TABLE edges (
        from_uid TEXT NOT NULL,
        to_uid TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_line INTEGER NOT NULL
      );
    `);
    const insertNode = db.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertEdge = db.prepare("INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?)");
    const tx = db.transaction(() => {
      for (const node of graph.nodes) {
        insertNode.run(node.uid, node.type, node.code, node.title, node.path, node.line, node.status ?? null, JSON.stringify(node.attrs ?? {}), JSON.stringify(node.aliases ?? []));
      }
      for (const edge2 of graph.edges) {
        insertEdge.run(edge2.from, edge2.to, edge2.kind, edge2.source, edge2.sourcePath, edge2.sourceLine);
      }
    });
    tx();
  } finally {
    db.close();
  }
}
function parseFile(type, path, raw) {
  if (type === "feature") {
    return parseFeature(path, raw);
  }
  if (type === "scenario") {
    return parseScenarios(path, raw);
  }
  if (type === "entity") {
    return parseEntityRegistry(path, raw);
  }
  if (type === "decision") {
    return parseDecisions(path, raw);
  }
  if (type === "test") {
    return parseTest(path, raw);
  }
  if (type === "design") {
    return parseDesign(path, raw);
  }
  if (type === "e2e_test") {
    return parseE2eTest(path, raw);
  }
  if (type === "e2e_registry") {
    return parseE2eRegistry(path, raw);
  }
  if (type === "interface_contracts" || type === "data_contracts" || type === "application_state_machines" || type === "error_model") {
    return parseContractTable(type, path, raw);
  }
  if (type === "domain-glossary") {
    return parseDomainGlossary(path, raw);
  }
  if (type === "bounded-context-map") {
    return parseBoundedContextMap(path, raw);
  }
  if (type === "domain-invariants") {
    return parseContractTable(type, path, raw);
  }
  if (type === "generation-packet-spec") {
    return parseGenerationPacketSpec(path, raw);
  }
  if (type === "rule-golden-cases") {
    return parseRuleGoldenCases(path, raw);
  }
  if (type === "test-strategy") {
    return parseTestStrategy(path, raw);
  }
  if (type === "traceability-matrix-v2") {
    return parseTraceabilityMatrixV2(path, raw);
  }
  if (type === "traceability-version-lock") {
    return parseTraceabilityVersionLock(path, raw);
  }
  if (type === "report-contracts") {
    return parseReportContracts(path, raw);
  }
  if (type === "verification-fixtures") {
    return parseVerificationFixtures(path, raw);
  }
  if (type === "ui-flow-contracts") {
    return parseUIFlowContracts(path, raw);
  }
  if (type === "non-functional-budgets") {
    return parseNonFunctionalBudgets(path, raw);
  }
  if (type === "implementation-blueprint") {
    return parseImplementationBlueprint(path, raw);
  }
  return { nodes: [], edges: [] };
}
function parseFeature(path, raw) {
  const parsed = matter(raw);
  const data = parsed.data;
  const code = String(data.id ?? "").trim();
  if (!code) {
    return { nodes: [], edges: [] };
  }
  const title = String(data.title ?? headingTitle(raw, code) ?? code);
  const node = {
    type: "feature",
    code,
    title,
    path,
    line: 1,
    status: typeof data.status === "string" ? data.status : void 0,
    attrs: { ...data, acceptanceCriteria: parseAcceptanceCriteria(raw) }
  };
  const edges = [
    ...frontmatterEdges(path, code, data.scenarios, "scenario", "covers"),
    ...frontmatterEdges(path, code, data.decisions, "decision", "references"),
    ...frontmatterEdges(path, code, data.depends_on, "feature", "depends_on"),
    ...frontmatterEdges(path, code, data.design_docs, "design", "references", normalizeDesignCode)
  ];
  return { nodes: [node], edges };
}
function parseScenarios(path, raw) {
  const lines = raw.split(/\r?\n/);
  const starts = [];
  lines.forEach((line, index) => {
    const match = /^#{2,3}\s+(S-\d+[a-z]?)\s*[:：]\s*(.+?)\s*$/.exec(line);
    if (match) {
      starts.push({ code: match[1], title: match[2], line: index + 1, index });
    }
  });
  const nodes = [];
  const edges = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = starts[i + 1]?.index ?? lines.length;
    const block = lines.slice(start.index, end);
    nodes.push({ type: "scenario", code: start.code, title: start.title, path, line: start.line });
    edges.push(...markdownLineEdges(path, start, block, "\u5173\u8054\u529F\u80FD", "feature", "references"));
    edges.push(...markdownLineEdges(path, start, block, "\u5173\u8054\u51B3\u7B56", "decision", "references"));
    edges.push(...markdownLineEdges(path, start, block, "\u5173\u8054\u5B9E\u4F53", "entity", "references"));
  }
  return { nodes, edges };
}
function parseEntityRegistry(path, raw) {
  const nodes = [];
  const edges = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    const match = /^\|\s*(E-\d{3,})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|.*?\|\s*([^|]+?)\s*\|/.exec(line);
    if (!match) {
      return;
    }
    const code = match[1].trim();
    nodes.push({ type: "entity", code, title: match[2].trim(), path, line: index + 1, attrs: { entityType: match[3].trim() } });
    for (const decision of extractCodes(match[4], "decision")) {
      edges.push(edge(toUid("entity", code), toUid("decision", decision), "references", "markdown", path, index + 1));
    }
  });
  return { nodes, edges };
}
function parseDecisions(path, raw) {
  const seen = /* @__PURE__ */ new Set();
  const nodes = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    for (const code of extractCodes(line, "decision")) {
      if (seen.has(code)) {
        continue;
      }
      seen.add(code);
      nodes.push({ type: "decision", code, title: titleNearCode(line, code), path, line: index + 1 });
    }
  });
  return { nodes, edges: [] };
}
function parseTest(path, raw) {
  const nodes = [];
  const edges = [];
  const traceabilityComments = scanTraceabilityComments(raw);
  const node = {
    type: "test",
    code: path,
    title: path.split("/").at(-1) ?? path,
    path,
    line: 1,
    attrs: traceabilityComments.invalid.length > 0 ? { invalidTraceabilityComments: traceabilityComments.invalid } : {}
  };
  let hasTags = false;
  for (const { tags, lineNumber } of traceabilityComments.canonical) {
    hasTags = true;
    for (const code of tags.scenario ?? []) {
      edges.push(edge(toUid("test", path), toUid("scenario", code), "verifies", "test-comment", path, lineNumber));
    }
    for (const code of tags.feature ?? []) {
      edges.push(edge(toUid("test", path), toUid("feature", code), "verifies", "test-comment", path, lineNumber));
    }
    for (const code of tags.entity ?? []) {
      edges.push(edge(toUid("test", path), toUid("entity", code), "verifies", "test-comment", path, lineNumber));
    }
    for (const code of tags.decision ?? []) {
      edges.push(edge(toUid("test", path), toUid("decision", code), "verifies", "test-comment", path, lineNumber));
    }
  }
  if (hasTags || traceabilityComments.invalid.length > 0) {
    nodes.push(node);
  }
  return { nodes, edges };
}
function scanTraceabilityComments(raw) {
  const canonical = [];
  const invalid = [];
  for (const comment of scanCodeComments(raw)) {
    if (!containsTraceabilityTag(comment.text)) {
      continue;
    }
    if (comment.kind === "block") {
      invalid.push({ line: comment.lineNumber, text: comment.text.trim(), reason: "traceability tags must use standalone // comments" });
      continue;
    }
    if (!comment.standalone) {
      invalid.push({ line: comment.lineNumber, text: comment.text.trim(), reason: "traceability tags must use standalone // comments" });
      continue;
    }
    const parsed = parseTraceabilityTagLine(comment.text.trim());
    if (parsed.valid) {
      canonical.push({ tags: parsed.tags, lineNumber: comment.lineNumber });
    } else {
      invalid.push({ line: comment.lineNumber, text: comment.text.trim(), reason: parsed.reason });
    }
  }
  for (const comment of scanMarkdownComments(raw)) {
    if (!containsTraceabilityTag(comment.text)) {
      continue;
    }
    if (!comment.standalone) {
      invalid.push({ line: comment.lineNumber, text: comment.text.trim(), reason: "traceability tags in markdown must use standalone HTML comments" });
      continue;
    }
    const parsed = parseTraceabilityTagLine(comment.text.trim());
    if (parsed.valid) {
      canonical.push({ tags: parsed.tags, lineNumber: comment.lineNumber });
    } else {
      invalid.push({ line: comment.lineNumber, text: comment.text.trim(), reason: parsed.reason });
    }
  }
  return { canonical, invalid };
}
function scanCodeComments(raw) {
  const comments = [];
  let quote;
  let escaped = false;
  let lineNumber = 1;
  let lineStart = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = void 0;
      }
      if (char === "\n") {
        lineNumber += 1;
        lineStart = index + 1;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "/" && next === "/") {
      const startLine = lineNumber;
      const standalone = raw.slice(lineStart, index).trim() === "";
      const start = index + 2;
      let end = start;
      while (end < raw.length && raw[end] !== "\n") {
        end += 1;
      }
      comments.push({ kind: "line", text: raw.slice(start, end), lineNumber: startLine, standalone });
      index = end - 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const startLine = lineNumber;
      const standalone = raw.slice(lineStart, index).trim() === "";
      const start = index + 2;
      let end = start;
      while (end < raw.length - 1 && !(raw[end] === "*" && raw[end + 1] === "/")) {
        if (raw[end] === "\n") {
          lineNumber += 1;
          lineStart = end + 1;
        }
        end += 1;
      }
      comments.push({ kind: "block", text: raw.slice(start, end), lineNumber: startLine, standalone });
      index = end + 1;
      continue;
    }
    if (char === "\n") {
      lineNumber += 1;
      lineStart = index + 1;
    }
  }
  return comments;
}
function scanMarkdownComments(raw) {
  const comments = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    const match = /^(\s*)<!--\s*([\s\S]*?)\s*-->\s*$/.exec(line);
    if (!match) {
      return;
    }
    comments.push({ text: match[2], lineNumber: index + 1, standalone: true });
  });
  return comments;
}
function parseTraceabilityTagLine(text) {
  const trimmed = text.trim();
  if (!/^@(scenario|feature|entity|decision)\b/.test(trimmed)) {
    return { valid: false, reason: "traceability line must start with @scenario, @feature, @entity, or @decision" };
  }
  const tags = {};
  const tagPattern = /@(scenario|feature|entity|decision)\b/g;
  const matches = [...trimmed.matchAll(tagPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const tag = match[1];
    const valueStart = (match.index ?? 0) + match[0].length;
    const valueEnd = index + 1 < matches.length ? matches[index + 1].index ?? trimmed.length : trimmed.length;
    const value = trimmed.slice(valueStart, valueEnd);
    const codes = extractTraceabilityCodes(value, tag);
    if (codes.length === 0) {
      return { valid: false, reason: `traceability tag @${tag} must contain at least one valid ID` };
    }
    tags[tag] = [...tags[tag] ?? [], ...codes];
  }
  return { valid: true, tags };
}
function extractTraceabilityCodes(text, tag) {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
  const expanded = tokens.flatMap((value) => expandTraceabilityToken(value, tag));
  if (expanded.length === 0 || expanded.includes("")) {
    return [];
  }
  return [...new Set(expanded)];
}
function expandTraceabilityToken(value, tag) {
  if (!traceabilityTokenPattern(tag).test(value)) {
    return [""];
  }
  return expandCodeRange(value);
}
function traceabilityTokenPattern(tag) {
  const patterns = {
    decision: /^D-[A-Z]+-\d+$/,
    entity: /^E-\d{3,}(?:~(?:E-)?\d{3,})?$/,
    feature: /^(?!AC\d+$)[A-Z]{1,4}\d+(?:~(?:[A-Z]{1,4})?\d+)?$/,
    scenario: /^S-\d+[a-z]?(?:~(?:S-)?\d+[a-z]?)?$/
  };
  return patterns[tag];
}
function expandCodeRange(value) {
  const range = value.match(/^([A-Z-]+)(\d+)([a-z]?)~([A-Z-]+)?(\d+)([a-z]?)$/);
  if (!range || range[3] || range[6]) {
    return [value];
  }
  const [, prefix, startRaw, , endPrefix, endRaw] = range;
  if (endPrefix && endPrefix !== prefix) {
    return [""];
  }
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || end - start > 200) {
    return [value];
  }
  const width = startRaw.length;
  return Array.from({ length: end - start + 1 }, (_, index) => `${prefix}${String(start + index).padStart(width, "0")}`);
}
function containsTraceabilityTag(value) {
  return value.includes("@scenario") || value.includes("@feature") || value.includes("@entity") || value.includes("@decision");
}
function parseDesign(path, raw) {
  const parsed = matter(raw);
  const data = parsed.data;
  const code = normalizeDesignCode(path);
  const title = String(data.title ?? raw.match(/^#\s+(.+)$/m)?.[1] ?? code);
  const nodes = [{ type: "design", code, title, path, line: 1, attrs: data }];
  const edges = [
    ...designFrontmatterEdges(path, code, data.related_features, "feature", "references"),
    ...designFrontmatterEdges(path, code, data.related_scenarios, "scenario", "references")
  ];
  raw.split(/\r?\n/).forEach((line, index) => {
    for (const codeValue of extractCodes(line, "entity")) {
      edges.push(edge(toUid("design", code), toUid("entity", codeValue), "references", "markdown", path, index + 1));
    }
    for (const codeValue of extractCodes(line, "decision")) {
      edges.push(edge(toUid("design", code), toUid("decision", codeValue), "references", "markdown", path, index + 1));
    }
  });
  return { nodes, edges };
}
function parseE2eTest(path, raw) {
  const parsed = matter(raw);
  const data = parsed.data;
  const lines = raw.split(/\r?\n/);
  const starts = [];
  lines.forEach((line, index) => {
    const match = /^#{2,3}\s+(TC-\d+[a-z]?)\s*[:：]?\s*(.*?)\s*$/.exec(line);
    if (match) {
      starts.push({ id: match[1], title: match[2].trim(), line: index + 1, index });
    }
  });
  const nodes = [];
  const edges = [];
  const batch = String(data.test_batch ?? basename(path, extname(path))).trim();
  const frontmatterScenarios = toArray(data.related_scenarios).map((value) => String(value).trim()).filter(Boolean);
  const scopeFeatures = extractCodes(String(data.scope ?? ""), "feature");
  const frontmatterFeatures = [.../* @__PURE__ */ new Set([...Object.keys(asRecord(data.ac_coverage)), ...scopeFeatures])];
  const frontmatterDecisions = toArray(data.related_decisions).map((value) => String(value).trim()).filter(Boolean);
  const frontmatterEntities = toArray(data.related_entities).map((value) => String(value).trim()).filter(Boolean);
  if (starts.length === 0) {
    const code = `${batch}:FILE`;
    nodes.push({
      type: "e2e_test",
      code,
      title: raw.match(/^#\s+(.+)$/m)?.[1] ?? batch,
      path,
      line: 1,
      attrs: {
        ...data,
        testCaseId: "FILE",
        fileLevelOnly: true,
        tcFields: {},
        blockText: raw,
        coveredFeatures: [],
        coveredScenarios: []
      }
    });
    addE2eFrontmatterEdges(edges, code, path, frontmatterScenarios, frontmatterFeatures, frontmatterDecisions, frontmatterEntities);
  }
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1]?.index ?? lines.length;
    const block = lines.slice(start.index, end);
    const fields = extractE2eTcFields(block);
    const code = `${batch}:${start.id}`;
    const attrs = {
      ...data,
      testCaseId: start.id,
      tcFields: fields,
      blockText: block.join("\n"),
      coveredFeatures: extractFeatureAcRefs(fields["\u8986\u76D6\u529F\u80FD"] ?? ""),
      coveredScenarios: extractCodes(fields["\u8986\u76D6\u573A\u666F"] ?? "", "scenario")
    };
    nodes.push({ type: "e2e_test", code, title: start.title, path, line: start.line, attrs });
    addE2eFrontmatterEdges(edges, code, path, frontmatterScenarios, frontmatterFeatures, frontmatterDecisions, frontmatterEntities);
    for (const scenario of extractCodes(fields["\u8986\u76D6\u573A\u666F"] ?? "", "scenario")) {
      edges.push(edge(toUid("e2e_test", code), toUid("scenario", scenario), "verifies", "markdown", path, start.line));
    }
    for (const feature of extractCodes(fields["\u8986\u76D6\u529F\u80FD"] ?? "", "feature")) {
      edges.push(edge(toUid("e2e_test", code), toUid("feature", feature), "verifies", "markdown", path, start.line));
    }
  }
  return { nodes, edges };
}
function addE2eFrontmatterEdges(edges, code, path, scenarios, features, decisions, entities) {
  for (const scenario of scenarios) {
    edges.push(edge(toUid("e2e_test", code), toUid("scenario", scenario), "verifies", "frontmatter", path, 1));
  }
  for (const feature of features) {
    edges.push(edge(toUid("e2e_test", code), toUid("feature", feature), "verifies", "frontmatter", path, 1));
  }
  for (const decision of decisions) {
    edges.push(edge(toUid("e2e_test", code), toUid("decision", decision), "references", "frontmatter", path, 1));
  }
  for (const entityValue of entities) {
    edges.push(edge(toUid("e2e_test", code), toUid("entity", entityValue), "references", "frontmatter", path, 1));
  }
}
function parseE2eRegistry(path, raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    data = { parseError: error.message };
  }
  return {
    nodes: [{ type: "e2e_registry", code: basename(path, extname(path)), title: "E2E Test Registry", path, line: 1, attrs: data }],
    edges: []
  };
}
function parseContractTable(type, path, raw) {
  const nodes = [];
  const edges = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let sourceCol = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headerCols = splitMarkdownCells(line).map((c) => c.trim());
      sourceCol = headerCols.findIndex((c) => /source/i.test(c));
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line)) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const rawItemCode = cells[0]?.replace(/"/g, "") ?? "";
      const backtickMatch = /`([^`]+)`/.exec(rawItemCode);
      const itemCode = backtickMatch ? backtickMatch[1] : rawItemCode.replace(/`/g, "").trim().split(/\s+/)[0];
      if (!itemCode) {
        continue;
      }
      const title = cells[1] ?? itemCode;
      nodes.push({ type, code: itemCode, title, path, line: i + 1 });
      if (sourceCol >= 0 && sourceCol < cells.length) {
        const sourceText = cells[sourceCol].replace(/`/g, "");
        for (const decisionCode of extractCodes(sourceText, "decision")) {
          edges.push(edge(toUid(type, itemCode), toUid("decision", decisionCode), "references", "markdown", path, i + 1));
        }
        for (const entityCode of extractCodes(sourceText, "entity")) {
          edges.push(edge(toUid(type, itemCode), toUid("entity", entityCode), "references", "markdown", path, i + 1));
        }
      }
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
    }
  }
  return { nodes, edges };
}
function slugify(text) {
  return text.trim().toLowerCase().replace(/\s+/g, "-");
}
function parseDomainGlossary(path, raw) {
  const nodes = [];
  const edges = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => {
        colIndex[h] = idx;
      });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && "term" in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const termIdx = colIndex["term"];
      const term = cells[termIdx]?.trim() ?? "";
      if (!term) {
        continue;
      }
      const code = slugify(term);
      const lookup = (header) => cells[colIndex[header] ?? -1] ?? "";
      nodes.push({ type: "domain-glossary", code, title: term, path, line: i + 1, attrs: { definition: lookup("definition"), canonicalOwner: lookup("canonical owner"), avoid: lookup("avoid") } });
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}
function parseBoundedContextMap(path, raw) {
  const nodes = [];
  const edges = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => {
        colIndex[h] = idx;
      });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && "context" in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const contextIdx = colIndex["context"];
      const context = cells[contextIdx]?.trim() ?? "";
      if (!context) {
        continue;
      }
      const code = slugify(context);
      const lookup = (header) => cells[colIndex[header] ?? -1] ?? "";
      nodes.push({ type: "bounded-context-map", code, title: context, path, line: i + 1, attrs: { owns: lookup("owns"), consumes: lookup("consumes"), publishes: lookup("publishes") } });
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}
function parseGenerationPacketSpec(path, raw) {
  const nodes = [{ type: "generation-packet-spec", code: "generation-packet-spec", title: "Generation Packet Spec", path, line: 1 }];
  const edges = [];
  const seen = /* @__PURE__ */ new Set();
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const decisionCode of extractCodes(line, "decision")) {
      const key = `decision:${decisionCode}:${i}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(edge(toUid("generation-packet-spec", "generation-packet-spec"), toUid("decision", decisionCode), "references", "markdown", path, i + 1));
      }
    }
    for (const entityCode of extractCodes(line, "entity")) {
      const key = `entity:${entityCode}:${i}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(edge(toUid("generation-packet-spec", "generation-packet-spec"), toUid("entity", entityCode), "references", "markdown", path, i + 1));
      }
    }
  }
  return { nodes, edges };
}
function parseRuleGoldenCases(path, raw) {
  const nodes = [];
  const edges = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => {
        colIndex[h] = idx;
      });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && "rule id" in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const ruleIdIdx = colIndex["rule id"];
      const caseTypeIdx = colIndex["\u7528\u4F8B\u7C7B\u578B"] ?? -1;
      const ruleId = cells[ruleIdIdx]?.trim() ?? "";
      const caseType = cells[caseTypeIdx]?.trim().toLowerCase() ?? "";
      if (!ruleId || !["pass", "fail", "edge"].includes(caseType)) {
        continue;
      }
      const code = `${ruleId}:${caseType}`;
      const dimensionIdx = colIndex["\u7EF4\u5EA6"] ?? -1;
      const sourceIdx = colIndex["\u89C4\u5219\u6765\u6E90"] ?? -1;
      const noteIdx = colIndex["\u5907\u6CE8"] ?? -1;
      const skillIdx = colIndex["skill \u7247\u6BB5"] ?? -1;
      const expectedIdx = colIndex["\u9884\u671F\u5224\u5B9A"] ?? -1;
      nodes.push({
        type: "rule-golden-cases",
        code,
        title: `${ruleId} ${caseType}`,
        path,
        line: i + 1,
        attrs: {
          dimension: cells[dimensionIdx] ?? "",
          skillSnippet: cells[skillIdx] ?? "",
          expectedVerdict: cells[expectedIdx] ?? "",
          ruleSource: cells[sourceIdx] ?? "",
          note: cells[noteIdx] ?? ""
        }
      });
      if (sourceIdx >= 0 && sourceIdx < cells.length) {
        const sourceText = cells[sourceIdx] ?? "";
        if (/rule-catalog/.test(sourceText)) {
          edges.push(edge(toUid("rule-golden-cases", code), toUid("design", "rule-catalog"), "references", "markdown", path, i + 1));
        }
      }
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}
function parseTestStrategy(path, raw) {
  const nodes = [];
  const edges = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => {
        colIndex[h] = idx;
      });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && "\u6D4B\u8BD5\u5C42\u7EA7" in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const tierIdx = colIndex["\u6D4B\u8BD5\u5C42\u7EA7"];
      const tier = cells[tierIdx]?.trim() ?? "";
      if (!tier) {
        continue;
      }
      const nameIdx = colIndex["\u4E2D\u6587\u540D"] ?? -1;
      const scopeIdx = colIndex["\u8986\u76D6\u8303\u56F4"] ?? -1;
      const toolIdx = colIndex["\u5DE5\u5177"] ?? -1;
      const freqIdx = colIndex["\u6267\u884C\u9891\u7387"] ?? -1;
      const entryIdx = colIndex["\u5165\u53E3"] ?? -1;
      const noteIdx = colIndex["\u5907\u6CE8"] ?? -1;
      nodes.push({
        type: "test-strategy",
        code: tier,
        title: cells[nameIdx] ?? tier,
        path,
        line: i + 1,
        attrs: {
          coverage: cells[scopeIdx] ?? "",
          tool: cells[toolIdx] ?? "",
          frequency: cells[freqIdx] ?? "",
          entry: cells[entryIdx] ?? "",
          note: cells[noteIdx] ?? ""
        }
      });
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}
function parseTraceabilityMatrixV2(path, raw) {
  const nodes = [];
  const edges = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex = {};
  const rawRows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => {
        colIndex[h] = idx;
      });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && "\u5C42\u7EA7" in colIndex && "id" in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const layerIdx = colIndex["\u5C42\u7EA7"];
      const idIdx = colIndex["id"];
      const layer = cells[layerIdx]?.trim() ?? "";
      const id = cells[idIdx]?.trim() ?? "";
      if (!layer || !id) {
        continue;
      }
      const nameIdx = colIndex["\u540D\u79F0"] ?? -1;
      const upstreamIdx = colIndex["\u4E0A\u6E38\u4F9D\u8D56"] ?? -1;
      const downstreamIdx = colIndex["\u4E0B\u6E38\u8986\u76D6"] ?? -1;
      const statusIdx = colIndex["\u72B6\u6001"] ?? -1;
      const productIdx = colIndex["\u4EA7\u54C1\u5206\u5C42"] ?? -1;
      const code = `${layer}:${id}`;
      nodes.push({
        type: "traceability-matrix-v2",
        code,
        title: cells[nameIdx] ?? id,
        path,
        line: i + 1,
        attrs: {
          layer,
          id,
          upstreamDependencies: cells[upstreamIdx] ?? "",
          downstreamCoverage: cells[downstreamIdx] ?? "",
          status: cells[statusIdx] ?? "",
          productLayer: cells[productIdx] ?? ""
        }
      });
      rawRows.push({
        code,
        layer,
        id,
        upstreamRaw: upstreamIdx >= 0 && upstreamIdx < cells.length ? cells[upstreamIdx] : "",
        downstreamRaw: downstreamIdx >= 0 && downstreamIdx < cells.length ? cells[downstreamIdx] : "",
        line: i + 1
      });
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  const idToCode = /* @__PURE__ */ new Map();
  for (const node of nodes) {
    const attrs = node.attrs;
    const bareId = attrs.id;
    if (bareId) {
      idToCode.set(bareId, node.code);
    }
  }
  const parseRefs = (raw2) => {
    return raw2.split(/[,;]+/).map((s) => s.replace(/`/g, "").trim()).filter((s) => s.length > 0 && !s.includes("~") && !s.includes("/") && !s.includes("*") && s !== "\u2014" && s !== "--");
  };
  for (const row of rawRows) {
    const fromUid = toUid("traceability-matrix-v2", row.code);
    for (const ref of parseRefs(row.upstreamRaw)) {
      const matrixCode = idToCode.get(ref);
      const targetUid = matrixCode ? toUid("traceability-matrix-v2", matrixCode) : `resolve:${ref}`;
      edges.push(edge(fromUid, targetUid, "references", "markdown", path, row.line));
    }
    for (const ref of parseRefs(row.downstreamRaw)) {
      const matrixCode = idToCode.get(ref);
      const targetUid = matrixCode ? toUid("traceability-matrix-v2", matrixCode) : `resolve:${ref}`;
      edges.push(edge(fromUid, targetUid, "covers", "markdown", path, row.line));
    }
  }
  return { nodes, edges };
}
function parseTraceabilityVersionLock(path, raw) {
  let attrs = {};
  try {
    const parsed = JSON.parse(raw);
    attrs = {
      schemaVersion: parsed.schemaVersion,
      lockCount: Array.isArray(parsed.locks) ? parsed.locks.length : 0
    };
  } catch (error) {
    attrs = { parseError: error.message };
  }
  return {
    nodes: [{
      type: "traceability-version-lock",
      code: "traceability-version-lock",
      title: "\u8FFD\u6EAF\u7248\u672C\u9501",
      path,
      line: 1,
      attrs
    }],
    edges: []
  };
}
function parseReportContracts(path, raw) {
  const nodes = [];
  const edges = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let sourceCol = -1;
  let idCol = -1;
  let section = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+\d+\./.test(line)) {
      section += 1;
      inTable = false;
      headerParsed = false;
      continue;
    }
    if (/^#\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim());
      sourceCol = headers.findIndex((c) => /source/i.test(c));
      idCol = section === 1 ? headers.findIndex((c) => /report field/i.test(c)) : section === 2 ? headers.findIndex((c) => /^format$/i.test(c)) : headers.findIndex((c) => /error code/i.test(c));
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && idCol >= 0) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const rawCode = cells[idCol]?.replace(/`/g, "").trim() ?? "";
      if (!rawCode || /\(/.test(rawCode)) continue;
      const code = rawCode;
      const title = cells[1] ?? code;
      nodes.push({ type: "report-contracts", code, title, path, line: i + 1 });
      if (sourceCol >= 0 && sourceCol < cells.length) {
        const sourceText = cells[sourceCol].replace(/`/g, "");
        for (const ref of extractCodes(sourceText, "decision")) {
          edges.push(edge(toUid("report-contracts", code), toUid("decision", ref), "references", "markdown", path, i + 1));
        }
        for (const ref of extractCodes(sourceText, "entity")) {
          edges.push(edge(toUid("report-contracts", code), toUid("entity", ref), "references", "markdown", path, i + 1));
        }
        for (const ref of extractCodes(sourceText, "feature")) {
          edges.push(edge(toUid("report-contracts", code), toUid("feature", ref), "references", "markdown", path, i + 1));
        }
      }
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
    }
  }
  return { nodes, edges };
}
function parseVerificationFixtures(path, raw) {
  const nodes = [];
  const edges = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => {
        colIndex[h] = idx;
      });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && "fixture id" in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const idIdx = colIndex["fixture id"];
      const code = cells[idIdx]?.trim() ?? "";
      if (!code || !/^FIX-\d{3}$/.test(code)) continue;
      const nameIdx = colIndex["\u4E2D\u6587\u540D"] ?? -1;
      const catIdx = colIndex["category"] ?? -1;
      const sourceIdx = colIndex["source"] ?? -1;
      nodes.push({
        type: "verification-fixtures",
        code,
        title: cells[nameIdx] ?? code,
        path,
        line: i + 1,
        attrs: {
          category: cells[catIdx] ?? ""
        }
      });
      if (sourceIdx >= 0 && sourceIdx < cells.length) {
        const sourceText = cells[sourceIdx].replace(/`/g, "");
        if (/rule-catalog/.test(sourceText)) {
          edges.push(edge(toUid("verification-fixtures", code), toUid("design", "rule-catalog"), "references", "markdown", path, i + 1));
        }
      }
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}
function parseUIFlowContracts(path, raw) {
  const nodes = [];
  const edges = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => {
        colIndex[h] = idx;
      });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line)) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      if ("page id" in colIndex) {
        const idIdx = colIndex["page id"];
        const code = cells[idIdx]?.trim() ?? "";
        if (!code) {
          continue;
        }
        const nameIdx = colIndex["\u4E2D\u6587\u540D"] ?? -1;
        const sourceIdx = colIndex["source"] ?? -1;
        nodes.push({ type: "ui-flow-contracts", code, title: cells[nameIdx] ?? code, path, line: i + 1 });
        if (sourceIdx >= 0 && sourceIdx < cells.length) {
          const src = cells[sourceIdx].replace(/`/g, "");
          for (const ref of extractCodes(src, "decision")) edges.push(edge(toUid("ui-flow-contracts", code), toUid("decision", ref), "references", "markdown", path, i + 1));
          for (const ref of extractCodes(src, "entity")) edges.push(edge(toUid("ui-flow-contracts", code), toUid("entity", ref), "references", "markdown", path, i + 1));
          for (const ref of extractCodes(src, "feature")) edges.push(edge(toUid("ui-flow-contracts", code), toUid("feature", ref), "references", "markdown", path, i + 1));
        }
      } else if ("flow id" in colIndex) {
        const idIdx = colIndex["flow id"];
        const code = cells[idIdx]?.trim() ?? "";
        if (!code) {
          continue;
        }
        const nameIdx = colIndex["\u4E2D\u6587\u540D"] ?? -1;
        const sourceIdx = colIndex["source"] ?? -1;
        const relatedScIdx = colIndex["related scenarios"] ?? -1;
        nodes.push({ type: "ui-flow-contracts", code, title: cells[nameIdx] ?? code, path, line: i + 1 });
        if (sourceIdx >= 0 && sourceIdx < cells.length) {
          const src = cells[sourceIdx].replace(/`/g, "");
          for (const ref of extractCodes(src, "decision")) edges.push(edge(toUid("ui-flow-contracts", code), toUid("decision", ref), "references", "markdown", path, i + 1));
          for (const ref of extractCodes(src, "entity")) edges.push(edge(toUid("ui-flow-contracts", code), toUid("entity", ref), "references", "markdown", path, i + 1));
          for (const ref of extractCodes(src, "feature")) edges.push(edge(toUid("ui-flow-contracts", code), toUid("feature", ref), "references", "markdown", path, i + 1));
        }
        if (relatedScIdx >= 0 && relatedScIdx < cells.length) {
          const scText = cells[relatedScIdx].replace(/`/g, "");
          for (const ref of extractCodes(scText, "scenario")) edges.push(edge(toUid("ui-flow-contracts", code), toUid("scenario", ref), "references", "markdown", path, i + 1));
        }
      } else if ("state" in colIndex && "trigger" in colIndex) {
        const idIdx = colIndex["state"];
        const rawCode = cells[idIdx]?.replace(/`/g, "").trim() ?? "";
        if (!rawCode) {
          continue;
        }
        const code = rawCode;
        const nameIdx = colIndex["\u4E2D\u6587\u540D"] ?? -1;
        const sourceIdx = colIndex["source"] ?? -1;
        nodes.push({ type: "ui-flow-contracts", code, title: cells[nameIdx] ?? code, path, line: i + 1 });
        if (sourceIdx >= 0 && sourceIdx < cells.length) {
          const src = cells[sourceIdx].replace(/`/g, "");
          for (const ref of extractCodes(src, "decision")) edges.push(edge(toUid("ui-flow-contracts", code), toUid("decision", ref), "references", "markdown", path, i + 1));
          for (const ref of extractCodes(src, "entity")) edges.push(edge(toUid("ui-flow-contracts", code), toUid("entity", ref), "references", "markdown", path, i + 1));
          for (const ref of extractCodes(src, "feature")) edges.push(edge(toUid("ui-flow-contracts", code), toUid("feature", ref), "references", "markdown", path, i + 1));
        }
      }
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}
function parseNonFunctionalBudgets(path, raw) {
  const nodes = [];
  const edges = [];
  const lines = raw.split(/\r?\n/);
  let inTable = false;
  let headerParsed = false;
  let colIndex = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#\s+/.test(line)) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
      continue;
    }
    if (/^\|.*\|/.test(line) && !inTable) {
      inTable = true;
      const headers = splitMarkdownCells(line).map((c) => c.trim().toLowerCase());
      headers.forEach((h, idx) => {
        colIndex[h] = idx;
      });
      continue;
    }
    if (inTable && /^\|\s*-+/.test(line)) {
      headerParsed = true;
      continue;
    }
    if (inTable && headerParsed && /^\|.*\|/.test(line) && "budget id" in colIndex) {
      const cells = splitMarkdownCells(line).map((c) => c.trim());
      const idIdx = colIndex["budget id"];
      const code = cells[idIdx]?.trim() ?? "";
      if (!code || !/^NFB-\d{3}$/.test(code)) continue;
      const nameIdx = colIndex["\u4E2D\u6587\u540D"] ?? -1;
      const metricIdx = colIndex["metric"] ?? -1;
      const sourceIdx = colIndex["source"] ?? -1;
      nodes.push({
        type: "non-functional-budgets",
        code,
        title: cells[nameIdx] ?? code,
        path,
        line: i + 1,
        attrs: { metric: cells[metricIdx] ?? "" }
      });
      if (sourceIdx >= 0 && sourceIdx < cells.length) {
        const sourceText = cells[sourceIdx].replace(/`/g, "");
        for (const ref of extractCodes(sourceText, "decision")) {
          edges.push(edge(toUid("non-functional-budgets", code), toUid("decision", ref), "references", "markdown", path, i + 1));
        }
        for (const ref of extractCodes(sourceText, "feature")) {
          edges.push(edge(toUid("non-functional-budgets", code), toUid("feature", ref), "references", "markdown", path, i + 1));
        }
      }
    }
    if (inTable && !/^\|.*\|/.test(line) && line.trim().length > 0) {
      inTable = false;
      headerParsed = false;
      colIndex = {};
    }
  }
  return { nodes, edges };
}
function parseImplementationBlueprint(path, raw) {
  const nodes = [
    { type: "implementation-blueprint", code: "implementation-blueprint", title: "Implementation Blueprint", path, line: 1 }
  ];
  const edges = [];
  const seen = /* @__PURE__ */ new Set();
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const decisionCode of extractCodes(line, "decision")) {
      const key = `decision:${decisionCode}:${i}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(edge(toUid("implementation-blueprint", "implementation-blueprint"), toUid("decision", decisionCode), "references", "markdown", path, i + 1));
      }
    }
    for (const featureCode of extractCodes(line, "feature")) {
      const key = `feature:${featureCode}:${i}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(edge(toUid("implementation-blueprint", "implementation-blueprint"), toUid("feature", featureCode), "references", "markdown", path, i + 1));
      }
    }
  }
  return { nodes, edges };
}
function frontmatterEdges(path, featureCode, value, targetType, kind, normalize = (target) => String(target).trim()) {
  return toArray(value).flatMap((target) => {
    const code = normalize(target);
    if (!code) {
      return [];
    }
    return [edge(toUid("feature", featureCode), toUid(targetType, code), kind, "frontmatter", path, 1)];
  });
}
function designFrontmatterEdges(path, designCode, value, targetType, kind) {
  return toArray(value).flatMap((target) => {
    const code = String(target).trim();
    if (!code) {
      return [];
    }
    return [edge(toUid("design", designCode), toUid(targetType, code), kind, "frontmatter", path, 1)];
  });
}
function markdownLineEdges(path, scenario, block, label, targetType, kind) {
  const result = [];
  block.forEach((line, index) => {
    if (!line.includes(label)) {
      return;
    }
    const relationText = line.split(/[:：]/).slice(1).join(":").split(/\s+[—-]\s+/)[0] ?? line;
    for (const code of extractCodes(relationText, targetType)) {
      result.push(edge(toUid("scenario", scenario.code), toUid(targetType, code), kind, "markdown", path, scenario.index + index + 1));
    }
  });
  return result;
}
function findDependsOnCycles(graph) {
  const adjacency = /* @__PURE__ */ new Map();
  for (const edgeValue of graph.edges) {
    if (edgeValue.kind === "depends_on") {
      adjacency.set(edgeValue.from, [...adjacency.get(edgeValue.from) ?? [], edgeValue.to]);
    }
  }
  const cycles = [];
  const visit = (node, stack) => {
    if (stack.includes(node)) {
      cycles.push([...stack.slice(stack.indexOf(node)), node]);
      return;
    }
    for (const next of adjacency.get(node) ?? []) {
      visit(next, [...stack, node]);
    }
  };
  for (const node of adjacency.keys()) {
    visit(node, []);
  }
  return cycles;
}
function validateE2eTests(graph) {
  const issues = [];
  const featureAcs = new Map(
    graph.nodes.filter((node) => node.type === "feature").map((node) => [node.code, toArray(node.attrs?.acceptanceCriteria).map((value) => String(value))])
  );
  const e2eNodes = graph.nodes.filter((node) => node.type === "e2e_test");
  const nodesByPath = groupBy(e2eNodes, (node) => node.path);
  for (const node of e2eNodes) {
    const attrs = node.attrs ?? {};
    for (const field of ["test_batch", "scope", "ac_coverage", "related_scenarios"]) {
      if (isEmptyValue(attrs[field])) {
        issues.push(issue("E2E_REQUIRED_FRONTMATTER", `${node.uid} missing required frontmatter ${field}`, node.path, 1, { node: node.uid, severity: "warning" }));
      }
    }
    const fields = asRecord(attrs.tcFields);
    const requiredTcFields = [
      ["\u6807\u9898", node.title],
      ["\u524D\u7F6E\u6761\u4EF6", fields["\u524D\u7F6E\u6761\u4EF6"]],
      ["\u6D4B\u8BD5\u6B65\u9AA4", fields["\u6D4B\u8BD5\u6B65\u9AA4"]],
      ["\u540E\u7F6E\u6E05\u7406", fields["\u540E\u7F6E\u6E05\u7406"]],
      ["\u8986\u76D6\u573A\u666F", fields["\u8986\u76D6\u573A\u666F"]],
      ["\u8986\u76D6\u529F\u80FD", fields["\u8986\u76D6\u529F\u80FD"]],
      ["\u4F18\u5148\u7EA7", fields["\u4F18\u5148\u7EA7"]]
    ];
    for (const [field, value] of requiredTcFields) {
      if (isEmptyValue(value)) {
        issues.push(issue("E2E_REQUIRED_TC_FIELD", `${node.uid} missing required TC field ${field}`, node.path, node.line, { node: node.uid, severity: "warning" }));
      }
    }
    for (const reference of extractFeatureAcRefs(String(fields["\u8986\u76D6\u529F\u80FD"] ?? ""))) {
      const accepted = featureAcs.get(reference.feature);
      if (!accepted || accepted.length === 0 || !accepted.includes(reference.ac)) {
        issues.push(issue("E2E_AC_UNKNOWN", `${node.uid} references unknown AC ${reference.feature}(${reference.ac})`, node.path, node.line, { node: node.uid, severity: "warning" }));
      }
    }
    if (needsDesktopChainWarning(node)) {
      issues.push(issue("E2E_DESKTOP_CHAIN_WARNING", `${node.uid} appears desktop-related but does not cover the full React/UI -> Tauri/IPC -> Node sidecar/JSON Lines -> core/engine -> SQLite/report data \u771F\u5B9E\u684C\u9762\u94FE\u8DEF`, node.path, node.line, { node: node.uid, severity: "warning" }));
    }
  }
  for (const [path, nodes] of nodesByPath) {
    const first = nodes[0];
    const declared = flattenAcCoverage(asRecord(first.attrs?.ac_coverage));
    const covered = new Set(nodes.flatMap((node) => toArray(node.attrs?.coveredFeatures).map((value) => {
      const ref = value;
      return `${String(ref.feature)}:${String(ref.ac)}`;
    })));
    for (const reference of declared) {
      if (!covered.has(`${reference.feature}:${reference.ac}`)) {
        issues.push(issue("E2E_AC_UNVERIFIED", `${path} declares ${reference.feature}(${reference.ac}) but no TC verifies it`, path, 1, { severity: "warning" }));
      }
    }
  }
  return issues;
}
function validateE2eRegistry(graph) {
  const registry = graph.nodes.find((node) => node.type === "e2e_registry");
  if (!registry) {
    return [];
  }
  const attrs = registry.attrs ?? {};
  const e2eNodes = graph.nodes.filter((node) => node.type === "e2e_test");
  const e2eTestCaseNodes = e2eNodes.filter((node) => node.attrs?.fileLevelOnly !== true);
  const actualBatches = new Set(e2eNodes.map((node) => String(node.attrs?.test_batch ?? node.code.split(":")[0])));
  const byPath = groupBy(e2eNodes, (node) => node.path);
  const issues = [];
  compareRegistryNumber(issues, registry, "total_batches", actualBatches.size);
  compareRegistryNumber(issues, registry, "total_test_cases", e2eTestCaseNodes.length);
  const batches = toArray(attrs.batches).filter((value) => typeof value === "object" && value !== null);
  const registeredFiles = /* @__PURE__ */ new Set();
  for (const batch of batches) {
    const file = String(batch.file ?? "");
    if (file) {
      registeredFiles.add(file);
    }
    const actualNodes = byPath.get(file) ?? [];
    if (actualNodes.length === 0) {
      issues.push(issue("E2E_REGISTRY_MISMATCH", `registry batch ${String(batch.batch_id ?? file)} file ${file || "<missing>"} does not match any E2E test file`, registry.path, registry.line, { node: registry.uid, severity: "warning" }));
      continue;
    }
    const first = actualNodes[0];
    compareRegistryValue(issues, registry, batch, "batch_id", first.attrs?.test_batch);
    compareRegistryValue(issues, registry, batch, "scope", first.attrs?.scope);
    compareRegistryAcCoverage(issues, registry, batch, asRecord(first.attrs?.ac_coverage));
    compareRegistryArray(issues, registry, batch, "related_scenarios", toArray(first.attrs?.related_scenarios).map((value) => String(value)));
    compareRegistryValue(issues, registry, batch, "test_case_count", actualNodes.filter((node) => node.attrs?.fileLevelOnly !== true).length);
  }
  for (const path of byPath.keys()) {
    if (!registeredFiles.has(path)) {
      issues.push(issue("E2E_REGISTRY_MISMATCH", `${path} is missing from registry`, registry.path, registry.line, { node: registry.uid, severity: "warning" }));
    }
  }
  return issues;
}
async function validateExecutableTraceability(root) {
  const issues = [];
  const e2eDir = join4(root, "artifacts", "tests", "e2e");
  const specPatterns = ["heimdall/**/*.spec.ts", "heimdall/**/*.e2e.spec.ts"];
  let e2eFiles;
  try {
    e2eFiles = (await readdir(e2eDir)).filter((name) => /^test-.*\.md$/.test(name)).map((name) => join4(e2eDir, name));
  } catch {
    return [];
  }
  const mdToRef = /* @__PURE__ */ new Map();
  const allMdTcInfo = /* @__PURE__ */ new Map();
  const tcKeyToFields = /* @__PURE__ */ new Map();
  const mdBatches = /* @__PURE__ */ new Set();
  for (const filePath of e2eFiles) {
    const raw = await readFile3(filePath, "utf-8");
    const relPath = relative2(root, filePath).split("\\").join("/");
    const parsed = matter(raw);
    const data = parsed.data;
    const batch = String(data.test_batch ?? basename(filePath, extname(filePath))).trim();
    const lines = raw.split(/\r?\n/);
    const tcStarts = [];
    lines.forEach((line, index) => {
      const match = /^#{2,3}\s+(TC-\d+[a-z]?)\s*[:：]?\s*.*$/.exec(line);
      if (match) {
        tcStarts.push({ id: match[1], line: index + 1, index });
      }
    });
    for (let i = 0; i < tcStarts.length; i += 1) {
      const start = tcStarts[i];
      const end = tcStarts[i + 1]?.index ?? lines.length;
      const block = lines.slice(start.index, end);
      const fields = extractE2eTcFields(block);
      const tcKey = `${batch}:${start.id}`;
      mdBatches.add(batch);
      tcKeyToFields.set(tcKey, fields);
      const execRef = String(fields["executable_ref"] ?? "").trim();
      const chainType = String(fields["chain_type"] ?? "desktop_chain").trim();
      allMdTcInfo.set(tcKey, { chainType, path: relPath, line: start.line });
      if (execRef) {
        mdToRef.set(tcKey, { ref: execRef, chainType, path: relPath, line: start.line });
      }
    }
  }
  const allFiles = await walk(root);
  const specFiles = /* @__PURE__ */ new Set();
  for (const pattern of specPatterns) {
    for (const file of allFiles) {
      if (matchesPattern(file, pattern)) {
        specFiles.add(file);
      }
    }
  }
  const refToSource = /* @__PURE__ */ new Map();
  const tcAnnotationRegex = /\/\/!?\s*@tc\s+(\S+?)\s+\[(\w+)\]/;
  const tcAnnotationNoLevelRegex = /\/\/!?\s*@tc\s+(\S+)/;
  for (const specFile of specFiles) {
    const fullSpecPath = join4(root, specFile);
    let content;
    try {
      content = await readFile3(fullSpecPath, "utf-8");
    } catch {
      continue;
    }
    const level = detectTestLevel(specFile, content);
    const specLines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < specLines.length; lineIndex += 1) {
      const line = specLines[lineIndex];
      let match = tcAnnotationRegex.exec(line);
      let annotatedLevel = "";
      if (match) {
        annotatedLevel = match[2];
      } else {
        match = tcAnnotationNoLevelRegex.exec(line);
      }
      if (!match) {
        continue;
      }
      const tcRef = match[1];
      const colonIndex = tcRef.indexOf(":");
      if (colonIndex < 0) {
        continue;
      }
      const batch = tcRef.substring(0, colonIndex);
      const tcId = tcRef.substring(colonIndex + 1);
      const effectiveLevel = annotatedLevel || level;
      let testName = "";
      for (let j = lineIndex + 1; j < Math.min(lineIndex + 5, specLines.length); j += 1) {
        const testMatch = /^\s*(?:test|it)\s*\(\s*['"](.+?)['"]/.exec(specLines[j]);
        if (testMatch) {
          testName = testMatch[1];
          break;
        }
      }
      const annotation = {
        batch,
        tcId,
        level: effectiveLevel,
        file: specFile,
        testName,
        line: lineIndex + 1
      };
      const key = `${batch}:${tcId}`;
      const existing = refToSource.get(key) ?? [];
      existing.push(annotation);
      refToSource.set(key, existing);
    }
  }
  const tcValidRefFiles = /* @__PURE__ */ new Map();
  for (const [tcKey, { ref, chainType, path, line }] of mdToRef) {
    if (isPendingExecutableRef(ref)) {
      if (isDesktopChainType(chainType)) {
        issues.push(issue("E2E-TRACE-005", `desktop_chain TC ${tcKey} has pending executable_ref`, path, line, { node: tcKey, severity: "warning" }));
      }
      continue;
    }
    const refEntries = parseExecutableRefLines(ref);
    const validFiles = [];
    for (const entry of refEntries) {
      const normalizedRefFile = entry.file.startsWith("heimdall/") ? entry.file : `heimdall/${entry.file}`;
      const fileExists = specFiles.has(normalizedRefFile);
      if (!fileExists) {
        issues.push(issue("E2E-TRACE-001", `executable_ref target file not found: ${entry.file}`, path, line, { node: tcKey, severity: "warning" }));
        continue;
      }
      if (entry.testId) {
        let content;
        try {
          content = await readFile3(join4(root, normalizedRefFile), "utf-8");
        } catch {
          continue;
        }
        const testIdPattern = new RegExp(`(?:test|it)\\s*\\(\\s*['"].*?${escapeRegExp(entry.testId)}.*?['"]`);
        if (!testIdPattern.test(content)) {
          issues.push(issue("E2E-TRACE-001", `executable_ref target test "${entry.testId}" not found in ${entry.file}`, path, line, { node: tcKey, severity: "warning" }));
          continue;
        }
      }
      const annotationsForTc = refToSource.get(tcKey);
      const hasAnnotationInFile = annotationsForTc?.some((ann) => {
        const normalizedAnnFile = ann.file.startsWith("heimdall/") ? ann.file : `heimdall/${ann.file}`;
        return normalizedAnnFile === normalizedRefFile;
      }) ?? false;
      if (!hasAnnotationInFile) {
        issues.push(issue("E2E-TRACE-003", `executable_ref target ${entry.file} has no // @tc ${tcKey} line-comment annotation`, path, line, { node: tcKey, severity: "warning" }));
        continue;
      }
      validFiles.push(normalizedRefFile);
    }
    tcValidRefFiles.set(tcKey, validFiles);
  }
  for (const [tcKey, annotations] of refToSource) {
    const batch = tcKey.split(":")[0];
    if (!mdBatches.has(batch)) {
      for (const ann of annotations) {
        issues.push(issue("E2E-TRACE-002", `@tc annotation ${tcKey} references non-existent E2E batch "${batch}"`, ann.file, ann.line, { node: tcKey, severity: "warning" }));
      }
      continue;
    }
    if (!mdToRef.has(tcKey) && !await hasMarkdownTc(tcKey, e2eDir)) {
      for (const ann of annotations) {
        issues.push(issue("E2E-TRACE-002", `@tc annotation ${tcKey} references non-existent Markdown TC`, ann.file, ann.line, { node: tcKey, severity: "warning" }));
      }
    }
  }
  for (const [tcKey, { ref, path, line }] of mdToRef) {
    if (isPendingExecutableRef(ref)) {
      continue;
    }
    const sourceAnnotations = refToSource.get(tcKey);
    if (!sourceAnnotations || sourceAnnotations.length === 0) {
      continue;
    }
    const validFiles = tcValidRefFiles.get(tcKey) ?? [];
    const refEntries = parseExecutableRefLines(ref);
    for (const ann of sourceAnnotations) {
      const matchesAnyRef = validFiles.some((vf) => ann.file === vf);
      if (matchesAnyRef) {
        continue;
      }
      const primaryRef = refEntries[0];
      const normalizedPrimary = primaryRef?.file.startsWith("heimdall/") ? primaryRef?.file : `heimdall/${primaryRef?.file ?? ""}`;
      const detail = `file: MD refs=[${refEntries.map((e) => e.file).join(", ")}] vs source=${ann.file}`;
      issues.push(issue("E2E-TRACE-003", `executable_ref \u2194 @tc mismatch for ${tcKey}: ${detail}`, path, line, { node: tcKey, severity: "warning" }));
    }
  }
  for (const [tcKey, { chainType, path, line }] of mdToRef) {
    if (!isDesktopChainType(chainType)) {
      continue;
    }
    const validFiles = new Set(tcValidRefFiles.get(tcKey) ?? []);
    const sourceAnnotations = refToSource.get(tcKey);
    if (!sourceAnnotations) {
      continue;
    }
    for (const ann of sourceAnnotations) {
      const normalizedAnnFile = ann.file.startsWith("heimdall/") ? ann.file : `heimdall/${ann.file}`;
      if (!validFiles.has(normalizedAnnFile)) {
        continue;
      }
      if (ann.level === "mock_playwright") {
        issues.push(issue("E2E-TRACE-004", `desktop_chain TC ${tcKey} points to mock_playwright test in ${ann.file}`, path, line, { node: tcKey, severity: "warning" }));
      }
    }
  }
  for (const [tcKey, { chainType, path, line }] of allMdTcInfo) {
    if (!isDesktopChainType(chainType)) {
      continue;
    }
    const tcFields = tcKeyToFields.get(tcKey);
    if (!tcFields) {
      continue;
    }
    const chainCoverage = String(tcFields["chain_coverage"] ?? "").trim().toLowerCase();
    const chainCoverageStatus = parseChainCoverageStatus(chainCoverage);
    const pendingField = String(tcFields["pending"] ?? "").trim();
    const isComplete = chainCoverageStatus === "complete";
    const hasPartialCoverage = chainCoverageStatus === "partial";
    const hasPendingField = pendingField.length > 0;
    if (!isComplete && !hasPartialCoverage && !hasPendingField) {
      continue;
    }
    const validFiles = new Set(tcValidRefFiles.get(tcKey) ?? []);
    const sourceAnnotations = refToSource.get(tcKey)?.filter((ann) => {
      const normalized = ann.file.startsWith("heimdall/") ? ann.file : `heimdall/${ann.file}`;
      return validFiles.has(normalized);
    });
    const hasDesktopChain = sourceAnnotations?.some((ann) => ann.level === "desktop_chain") ?? false;
    const hasBridge = sourceAnnotations?.some((ann) => ann.level === "ui_sidecar_bridge") ?? false;
    if (isComplete) {
      let evidenceDetail = "";
      let hasValidEvidence = false;
      if (hasDesktopChain) {
        hasValidEvidence = true;
      } else if (hasBridge) {
        const partialResult = await validatePartialRustEvidence(tcFields, tcKey, root);
        if (partialResult.hasValidPartialRust) {
          hasValidEvidence = true;
        } else {
          evidenceDetail = partialResult.detail;
        }
      }
      if (hasValidEvidence && hasPendingField) {
        issues.push(issue(
          "E2E-TRACE-006",
          `desktop_chain TC ${tcKey} declared complete with valid evidence but has pending field: "${pendingField}"`,
          path,
          line,
          { node: tcKey, severity: "warning" }
        ));
      } else if (hasValidEvidence) {
        continue;
      } else if (hasPendingField) {
        issues.push(issue(
          "E2E-TRACE-006",
          `desktop_chain TC ${tcKey} declared complete but has pending field: "${pendingField}"${evidenceDetail ? `; ${evidenceDetail}` : ""}`,
          path,
          line,
          { node: tcKey, severity: "warning" }
        ));
      } else {
        issues.push(issue(
          "E2E-TRACE-006",
          `desktop_chain TC ${tcKey} declared complete but missing valid desktop_chain or ui_sidecar_bridge + partial_rust evidence${evidenceDetail ? `; ${evidenceDetail}` : ""}`,
          path,
          line,
          { node: tcKey, severity: "warning" }
        ));
      }
    } else {
      if (hasDesktopChain) {
        continue;
      }
      let partialDetail = "";
      if (hasBridge) {
        const partialResult = await validatePartialRustEvidence(tcFields, tcKey, root);
        if (partialResult.hasValidPartialRust) {
          continue;
        }
        partialDetail = partialResult.detail;
      }
      issues.push(issue(
        "E2E-TRACE-006",
        `partial desktop_chain coverage \u2014 full desktop_chain harness pending for ${tcKey}${partialDetail ? `; ${partialDetail}` : ""}`,
        path,
        line,
        { node: tcKey, severity: "warning" }
      ));
    }
  }
  return issues;
}
function isPendingExecutableRef(ref) {
  const stripped = ref.replace(/^[\s-*()]+/, "").trim();
  return /^pending\b/i.test(stripped);
}
function parseExecutableRefLines(ref) {
  const lines = ref.split("\n").filter((l) => l.trim().length > 0);
  const results = [];
  for (const line of lines.length === 0 ? [ref] : lines) {
    const codeMatch = /`([^`]+)`/.exec(line);
    const raw = codeMatch ? codeMatch[1] : line.replace(/^[-*]\s*/, "").trim();
    const parts = raw.split("::");
    const file = parts[0]?.trim();
    if (!file) continue;
    results.push({ file, testId: parts[1]?.trim() || void 0 });
  }
  return results;
}
function isDesktopChainType(chainType) {
  const normalizedChainType = chainType.trim().toLowerCase();
  return normalizedChainType === "desktop_chain" || normalizedChainType === "";
}
function parseChainCoverageStatus(chainCoverage) {
  return chainCoverage.trim().toLowerCase().match(/^[a-z_]+/)?.[0] ?? "";
}
async function validatePartialRustEvidence(tcFields, tcKey, root) {
  const partialEvidence = String(tcFields["partial_evidence"] ?? "");
  if (!partialEvidence.trim()) {
    return { hasValidPartialRust: false, detail: "no partial_evidence field" };
  }
  const refEntries = [];
  for (const line of partialEvidence.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const codeMatch = /`([^`]+)`/.exec(trimmed);
    const raw = codeMatch ? codeMatch[1] : trimmed.replace(/^[-*]\s*/, "").trim();
    const filePath = raw.split("::")[0]?.split("\u2014")[0]?.split("\u2013")[0]?.trim();
    if (filePath) {
      refEntries.push({ file: filePath });
    }
  }
  if (refEntries.length === 0) {
    return { hasValidPartialRust: false, detail: "no file paths found in partial_evidence" };
  }
  const rustRefs = refEntries.filter((e) => e.file.endsWith(".rs"));
  if (rustRefs.length === 0) {
    return { hasValidPartialRust: false, detail: "no .rs file in partial_evidence" };
  }
  for (const ref of rustRefs) {
    const normalizedPath = ref.file.startsWith("heimdall/") ? ref.file : `heimdall/${ref.file}`;
    const fullPath = join4(root, normalizedPath);
    let content;
    try {
      content = await readFile3(fullPath, "utf-8");
    } catch {
      return { hasValidPartialRust: false, detail: `partial_rust file not found: ${ref.file}` };
    }
    const tcAnnotationPattern = new RegExp(
      `//[/!]?\\s*@tc\\s+${escapeRegExp(tcKey)}\\s+\\[partial_rust\\]`
    );
    if (!tcAnnotationPattern.test(content)) {
      const noLevelPattern = new RegExp(`//[/!]?\\s*@tc\\s+${escapeRegExp(tcKey)}\\b`);
      if (noLevelPattern.test(content)) {
        return { hasValidPartialRust: false, detail: `partial_rust file ${ref.file} has @tc ${tcKey} but not tagged [partial_rust]` };
      }
      return { hasValidPartialRust: false, detail: `partial_rust file ${ref.file} has no @tc ${tcKey} annotation` };
    }
  }
  return { hasValidPartialRust: true, detail: "ok" };
}
function detectTestLevel(specFile, content) {
  const isInCore = /packages\/core\//.test(specFile) || /packages\/engine-/.test(specFile);
  if (isInCore) {
    return "core_e2e";
  }
  const isInCli = /packages\/cli\//.test(specFile);
  if (isInCli) {
    return "cli_e2e";
  }
  const usesMock = /setupTauriMock|setupEmptyTauriMock|__TAURI_INTERNALS__/.test(content);
  if (usesMock) {
    return "mock_playwright";
  }
  return "desktop_chain";
}
function splitMarkdownCells(line) {
  const cells = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length && line[i + 1] === "|" && !inCode) {
      current += "|";
      i++;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  if (cells.length > 0 && cells[0].trim() === "") {
    cells.shift();
  }
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") {
    cells.pop();
  }
  return cells;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function hasMarkdownTc(tcKey, e2eDir) {
  const [batch, tcId] = tcKey.split(":");
  const filePath = join4(e2eDir, `${batch}.md`);
  try {
    const raw = await readFile3(filePath, "utf-8");
    const tcRegex = new RegExp(`^#{2,3}\\s+${escapeRegExp(tcId)}\\s*[:\uFF1A]?`, "m");
    return tcRegex.test(raw);
  } catch {
    return false;
  }
}
async function findFiles(root, patterns) {
  const all = await walk(root);
  const matched = /* @__PURE__ */ new Set();
  for (const pattern of patterns) {
    for (const file of all) {
      if (matchesPattern(file, pattern)) {
        matched.add(file);
      }
    }
  }
  return [...matched].sort();
}
async function walk(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git" || entry.name === ".artifact-graph") {
      continue;
    }
    const fullPath = join4(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(root, fullPath));
    } else {
      files.push(relative2(root, fullPath).split("\\").join("/"));
    }
  }
  return files;
}
function matchesPattern(file, pattern) {
  if (!pattern.includes("*")) {
    return file === pattern;
  }
  return globToRegExp(pattern).test(file);
}
function extractCodes(text, type) {
  const patterns = {
    decision: /\bD-[A-Z]+-\d+\b/g,
    entity: /\bE-\d{3,}\b/g,
    feature: /\b(?!AC\d+\b)[A-Z]{1,4}\d+\b/g,
    scenario: /\bS-\d+[a-z]?\b/g
  };
  return [...text.matchAll(patterns[type] ?? /$a/g)].map((match) => match[0]);
}
function extractE2eTcFields(block) {
  const fields = {};
  let current = "";
  for (const line of block) {
    const match = /^\*\*([^*]+?)\*\*\s*[:：]\s*(.*)$/.exec(line);
    if (match) {
      current = match[1].trim();
      fields[current] = match[2].trim();
      continue;
    }
    if (/^---\s*$/.test(line) || /^#{2,3}\s+/.test(line)) {
      current = "";
      continue;
    }
    if (current) {
      fields[current] = [fields[current], line.trim()].filter(Boolean).join("\n");
    }
  }
  return fields;
}
function parseAcceptanceCriteria(raw) {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+验收标准\s*$/.test(line.trim()));
  if (start < 0) {
    return [];
  }
  const result = /* @__PURE__ */ new Set();
  let numbered = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) {
      break;
    }
    if (/^\s*\d+[.)、]\s+/.test(line)) {
      numbered += 1;
      result.add(`AC${numbered}`);
    }
    for (const match of line.matchAll(/\bAC[-\s]?(\d+)\b/g)) {
      result.add(`AC${Number(match[1])}`);
    }
  }
  return [...result].sort((left, right) => Number(left.slice(2)) - Number(right.slice(2)));
}
function extractFeatureAcRefs(text) {
  const refs = [];
  for (const match of text.matchAll(/\b((?!AC\d+\b)[A-Z]{1,4}\d+)\s*[（(]([^）)]+)[）)]/g)) {
    for (const acMatch of match[2].matchAll(/\bAC[-\s]?(\d+)\b/g)) {
      refs.push({ feature: match[1], ac: `AC${Number(acMatch[1])}` });
    }
  }
  return refs;
}
function flattenAcCoverage(value) {
  return Object.entries(value).flatMap(([feature, refs]) => toArray(refs).map((ac) => ({ feature, ac: String(ac).replace(/^AC[-\s]?(\d+)$/i, (_match, digits) => `AC${Number(digits)}`) })));
}
function needsDesktopChainWarning(node) {
  const tcFields = asRecord(node.attrs?.tcFields);
  const chainType = String(tcFields["chain_type"] ?? "").trim().toLowerCase();
  if (chainType === "frontend_only" || chainType === "core_only") {
    return false;
  }
  const chainCoverage = String(tcFields["chain_coverage"] ?? "").trim().toLowerCase();
  if (parseChainCoverageStatus(chainCoverage) === "complete") {
    return false;
  }
  const text = `${node.title}
${String(node.attrs?.blockText ?? "")}`;
  if (!/(desktop|桌面|Tauri|IPC|React UI)/i.test(text)) {
    return false;
  }
  const checks = [
    /(React|UI|界面|页面)/i,
    /(Tauri|IPC)/i,
    /(Node sidecar|sidecar|JSON Lines)/i,
    /(core|engine|核心|引擎)/i,
    /(SQLite|report data|报告)/i
  ];
  return checks.some((check) => !check.test(text)) || /\bCLI\b|heimdall scan|纯函数/i.test(text) && checks.some((check) => !check.test(text));
}
function compareRegistryNumber(issues, registry, field, actual) {
  const expected = registry.attrs?.[field];
  if (typeof expected !== "number") {
    issues.push(issue("E2E_REGISTRY_MISMATCH", `registry ${field} cannot be determined`, registry.path, registry.line, { node: registry.uid, severity: "warning" }));
    return;
  }
  if (expected !== actual) {
    issues.push(issue("E2E_REGISTRY_MISMATCH", `registry ${field}=${expected} does not match actual ${actual}`, registry.path, registry.line, { node: registry.uid, severity: "warning" }));
  }
}
function compareRegistryValue(issues, registry, batch, field, actual) {
  if (!(field in batch)) {
    issues.push(issue("E2E_REGISTRY_MISMATCH", `registry batch ${String(batch.batch_id ?? "")} ${field} cannot be determined`, registry.path, registry.line, { node: registry.uid, severity: "warning" }));
    return;
  }
  if (String(batch[field]) !== String(actual)) {
    issues.push(issue("E2E_REGISTRY_MISMATCH", `registry batch ${String(batch.batch_id ?? "")} ${field}=${String(batch[field])} does not match actual ${String(actual)}`, registry.path, registry.line, { node: registry.uid, severity: "warning" }));
  }
}
function compareRegistryArray(issues, registry, batch, field, actual) {
  if (!(field in batch)) {
    issues.push(issue("E2E_REGISTRY_MISMATCH", `registry batch ${String(batch.batch_id ?? "")} ${field} cannot be determined`, registry.path, registry.line, { node: registry.uid, severity: "warning" }));
    return;
  }
  const expected = toArray(batch[field]).map((value) => String(value));
  if (expected.slice().sort().join(",") !== actual.slice().sort().join(",")) {
    issues.push(issue("E2E_REGISTRY_MISMATCH", `registry batch ${String(batch.batch_id ?? "")} ${field} does not match actual file`, registry.path, registry.line, { node: registry.uid, severity: "warning" }));
  }
}
function compareRegistryAcCoverage(issues, registry, batch, actual) {
  if (!("ac_coverage" in batch)) {
    issues.push(issue("E2E_REGISTRY_MISMATCH", `registry batch ${String(batch.batch_id ?? "")} ac_coverage cannot be determined`, registry.path, registry.line, { node: registry.uid, severity: "warning" }));
    return;
  }
  if (normalizeAcCoverage(asRecord(batch.ac_coverage)) !== normalizeAcCoverage(actual)) {
    issues.push(issue("E2E_REGISTRY_MISMATCH", `registry batch ${String(batch.batch_id ?? "")} ac_coverage does not match actual file`, registry.path, registry.line, { node: registry.uid, severity: "warning" }));
  }
}
function normalizeAcCoverage(value) {
  return flattenAcCoverage(value).map((reference) => `${reference.feature}:${reference.ac}`).sort().join(",");
}
function groupBy(values, key) {
  const result = /* @__PURE__ */ new Map();
  for (const value of values) {
    const groupKey = key(value);
    result.set(groupKey, [...result.get(groupKey) ?? [], value]);
  }
  return result;
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function isEmptyValue(value) {
  if (value === void 0 || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim() === "";
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length === 0;
  }
  return false;
}
function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}
function normalizeUid(value) {
  if (value.includes(":")) {
    return value;
  }
  if (/^S-\d+[a-z]?$/.test(value)) {
    return toUid("scenario", value);
  }
  if (/^D-[A-Z]+-\d+$/.test(value)) {
    return toUid("decision", value);
  }
  if (/^E-\d{3,}$/.test(value)) {
    return toUid("entity", value);
  }
  if (/^[A-Z]{1,4}\d+$/.test(value)) {
    return toUid("feature", value);
  }
  return value;
}
function normalizeDesignCode(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  return basename(raw, extname(raw));
}
function toUid(type, code) {
  return `${type}:${code}`;
}
function edge(from, to, kind, source, sourcePath, sourceLine) {
  return { from, to, kind, source, sourcePath, sourceLine };
}
function issue(code, message, path, line, extra = {}) {
  return { code, severity: "error", message, path, line, ...extra };
}
function compareNode(left, right) {
  return left.uid.localeCompare(right.uid) || left.path.localeCompare(right.path) || left.line - right.line;
}
function compareEdge(left, right) {
  return left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind);
}
function mergeRecord(base, override) {
  return { ...base, ...override ?? {} };
}
function mergeArtifactTypes(base, override) {
  const result = { ...base };
  for (const [type, definition] of Object.entries(override ?? {})) {
    result[type] = {
      ...base[type] ?? {},
      ...definition
    };
  }
  return result;
}
function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === void 0 || value === null) {
    return [];
  }
  return [value];
}
function headingTitle(raw, code) {
  return raw.match(new RegExp(`^#\\s+${code}:\\s+(.+)$`, "m"))?.[1];
}
function titleNearCode(line, code) {
  const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
  const index = cells.indexOf(code);
  if (index >= 0 && cells[index + 1]) {
    return cells[index + 1];
  }
  return line.split(code).at(1)?.replace(/^[:\s|-]+/, "").trim() || code;
}
function escapeMermaid(value) {
  return value.replace(/"/g, '\\"');
}
function discoverTargets(graph, options) {
  const limit = options?.limit === void 0 ? 20 : options.limit === 0 ? Infinity : options.limit;
  const targetTypes = getTargetArtifactTypes(options?.schema ?? DEFAULT_SCHEMA);
  const groups = /* @__PURE__ */ new Map();
  for (const t of targetTypes) {
    groups.set(t, []);
  }
  for (const node of graph.nodes) {
    if (targetTypes.includes(node.type)) {
      groups.get(node.type).push({ type: node.type, id: node.code });
    }
  }
  for (const [, group] of groups) {
    group.sort((a, b) => a.id.localeCompare(b.id));
  }
  const allItems = targetTypes.flatMap((type) => groups.get(type) ?? []);
  if (allItems.length <= limit) {
    return allItems;
  }
  const result = [];
  const indices = /* @__PURE__ */ new Map();
  for (const t of targetTypes) {
    indices.set(t, 0);
  }
  while (result.length < limit) {
    let added = false;
    for (const t of targetTypes) {
      const group = groups.get(t) ?? [];
      const idx = indices.get(t) ?? 0;
      if (idx < group.length && result.length < limit) {
        result.push(group[idx]);
        indices.set(t, idx + 1);
        added = true;
      }
    }
    if (!added) break;
  }
  return result;
}
var CONTEXT_CATEGORIES = {
  feature: "prd",
  scenario: "scenario",
  decision: "decision",
  design: "design",
  entity: "entity",
  "interface_contracts": "contract",
  "data_contracts": "contract",
  "application_state_machines": "contract",
  "error_model": "contract",
  "report-contracts": "contract",
  "ui-flow-contracts": "contract",
  "non-functional-budgets": "contract",
  "domain-glossary": "domain",
  "bounded-context-map": "domain",
  "domain-invariants": "domain",
  "generation-packet-spec": "domain",
  "rule-golden-cases": "verification",
  "test-strategy": "verification",
  "verification-fixtures": "verification",
  "implementation-blueprint": "blueprint",
  "traceability-matrix-v2": "matrix"
};
var TIER_ORDER = ["baseline", "target", "direct", "matrix", "transitive"];
function resolveArtifactContext(graph, opts) {
  const mode = opts.mode ?? "full";
  const maxPerCategory = opts.maxPerCategory ?? 20;
  const targetCount = [opts.feature, opts.scenario, opts.decision, opts.design, opts.e2e_test].filter(Boolean).length;
  if (targetCount > 1) {
    return {
      schemaVersion: "1.0",
      target: { type: "", id: "", uid: "" },
      context: {},
      missing: ["Only one of --feature, --scenario, --decision, --design, or --e2e-test may be specified"],
      missingDetails: [{
        ref: [opts.feature, opts.scenario, opts.decision, opts.design, opts.e2e_test].filter(Boolean).join(", "),
        from: "cli-options",
        kind: "multiple-targets",
        message: "Only one of --feature, --scenario, --decision, --design, or --e2e-test may be specified",
        suggestedAction: "\u53EA\u6307\u5B9A\u4E00\u4E2A --feature/--scenario/--decision/--design/--e2e-test"
      }],
      omitted: []
    };
  }
  let targetType;
  let targetId;
  if (opts.feature) {
    targetType = "feature";
    targetId = opts.feature;
  } else if (opts.scenario) {
    targetType = "scenario";
    targetId = opts.scenario;
  } else if (opts.decision) {
    targetType = "decision";
    targetId = opts.decision;
  } else if (opts.design) {
    targetType = "design";
    targetId = opts.design;
  } else if (opts.e2e_test) {
    targetType = "e2e_test";
    targetId = opts.e2e_test;
  }
  if (!targetType || !targetId) {
    return {
      schemaVersion: "1.0",
      target: { type: "", id: "", uid: "" },
      context: {},
      missing: ["No target specified (use --feature, --scenario, --decision, --design, or --e2e-test)"],
      missingDetails: [{
        ref: "",
        from: "cli-options",
        kind: "target-not-found",
        message: "No target specified (use --feature, --scenario, --decision, --design, or --e2e-test)",
        suggestedAction: "\u521B\u5EFA\u6587\u4EF6\u6216\u68C0\u67E5 ID \u62FC\u5199"
      }],
      omitted: []
    };
  }
  const targetUid = toUid(targetType, targetId);
  const targetNode = graph.nodes.find((n) => n.uid === targetUid);
  if (!targetNode) {
    return {
      schemaVersion: "1.0",
      target: { type: targetType, id: targetId, uid: targetUid },
      context: {},
      missing: [`Target artifact ${targetUid} not found in graph`],
      missingDetails: [{
        ref: targetId,
        from: targetType,
        kind: "target-not-found",
        message: `Target artifact ${targetUid} not found in graph`,
        suggestedAction: "\u521B\u5EFA\u6587\u4EF6\u6216\u68C0\u67E5 ID \u62FC\u5199"
      }],
      omitted: []
    };
  }
  const related = /* @__PURE__ */ new Map();
  const missing = [];
  const missingDetails = [];
  for (const e of graph.edges) {
    if (e.from === targetUid) {
      const nodes = graph.nodes.filter((n) => n.uid === e.to);
      for (const n of nodes) {
        if (!related.has(n.uid)) {
          related.set(n.uid, { node: n, reason: `${e.kind} \u2192 ${n.uid}` });
        }
      }
      if (!graph.nodes.some((n) => n.uid === e.to) && !related.has(e.to)) {
        const msg = `Unresolved reference from ${e.from}: ${e.to}`;
        if (!missing.includes(msg)) {
          missing.push(msg);
          missingDetails.push({
            ref: e.to,
            from: e.from,
            kind: "unresolved-outgoing",
            message: msg,
            suggestedAction: "\u6DFB\u52A0\u5F15\u7528\u6216\u5220\u9664\u60AC\u6302\u5F15\u7528"
          });
        }
      }
    }
    if (e.to === targetUid) {
      const nodes = graph.nodes.filter((n) => n.uid === e.from);
      for (const n of nodes) {
        if (!related.has(n.uid)) {
          related.set(n.uid, { node: n, reason: `${e.kind} \u2190 ${n.uid}` });
        }
      }
    }
  }
  const directUids = new Set(related.keys());
  for (const n of graph.nodes) {
    if (n.type !== "traceability-matrix-v2") continue;
    const attrs = n.attrs;
    if (attrs?.id === targetId && !related.has(n.uid)) {
      related.set(n.uid, { node: n, reason: `matrix row for ${targetId}` });
    }
  }
  const transitiveUids = /* @__PURE__ */ new Set();
  for (const [, { node }] of [...related]) {
    if (node.type !== "traceability-matrix-v2") continue;
    const attrs = node.attrs;
    if (!attrs?.layer || !attrs?.id) continue;
    const realUid = toUid(attrs.layer, attrs.id);
    if (realUid !== targetUid && !related.has(realUid)) {
      const realNode = graph.nodes.find((n) => n.uid === realUid);
      if (realNode) {
        related.set(realUid, { node: realNode, reason: `represented by ${node.uid}` });
        transitiveUids.add(realUid);
      }
    }
  }
  function tierFor(uid) {
    if (directUids.has(uid)) return "direct";
    const node = graph.nodes.find((n) => n.uid === uid);
    if (node?.type === "traceability-matrix-v2") return "matrix";
    if (transitiveUids.has(uid)) return "transitive";
    return "direct";
  }
  const pathMap = /* @__PURE__ */ new Map();
  for (const ap of ALWAYS_PRESENT_ITEMS) {
    const existing = pathMap.get(ap.path);
    if (existing) {
      if (!existing.reasons.includes(ap.reason)) existing.reasons.push(ap.reason);
    } else {
      pathMap.set(ap.path, { path: ap.path, reasons: [ap.reason], category: "baseline", required: true, tier: "baseline" });
    }
  }
  pathMap.set(targetNode.path, {
    path: targetNode.path,
    reasons: [`${targetType}:${targetId}`],
    category: "target",
    required: true,
    tier: "target"
  });
  for (const [uid, { node, reason }] of related) {
    const category = CONTEXT_CATEGORIES[node.type] ?? node.type;
    const tier = tierFor(uid);
    const existing = pathMap.get(node.path);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (existing.category !== "baseline") {
        existing.category = category;
        const existingTierIdx = TIER_ORDER.indexOf(existing.tier);
        const newTierIdx = TIER_ORDER.indexOf(tier);
        if (newTierIdx < existingTierIdx) existing.tier = tier;
      }
    } else {
      pathMap.set(node.path, { path: node.path, reasons: [reason], category, required: false, tier });
    }
  }
  const omitted = [];
  if (mode === "implementation") {
    const categoryCounts = /* @__PURE__ */ new Map();
    for (const [, entry] of pathMap) {
      if (entry.category === "baseline" || entry.category === "target") {
        categoryCounts.set(entry.category, (categoryCounts.get(entry.category) ?? 0) + 1);
      }
    }
    const categoryBuckets = /* @__PURE__ */ new Map();
    for (const [path, entry] of pathMap) {
      if (entry.category === "baseline" || entry.category === "target") continue;
      const cat = entry.category;
      if (!categoryBuckets.has(cat)) categoryBuckets.set(cat, []);
      categoryBuckets.get(cat).push({ entry, uid: path });
    }
    for (const [cat, bucket] of categoryBuckets) {
      bucket.sort((a, b) => {
        const tierDiff = TIER_ORDER.indexOf(a.entry.tier) - TIER_ORDER.indexOf(b.entry.tier);
        if (tierDiff !== 0) return tierDiff;
        return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0;
      });
      const limit = maxPerCategory;
      if (bucket.length > limit) {
        for (let i = limit; i < bucket.length; i++) {
          const entry = bucket[i].entry;
          pathMap.delete(bucket[i].uid);
          omitted.push({
            path: entry.path,
            reason: entry.reasons.join("; "),
            required: false,
            tier: entry.tier,
            reasons: [...entry.reasons]
          });
        }
        categoryCounts.set(cat, limit);
      }
    }
  }
  omitted.sort((a, b) => {
    const tierDiff = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
    if (tierDiff !== 0) return tierDiff;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  const context = {};
  for (const [, entry] of pathMap) {
    const category = entry.category;
    if (!context[category]) context[category] = [];
    context[category].push({
      path: entry.path,
      reason: entry.reasons.join("; "),
      required: entry.required,
      tier: entry.tier,
      reasons: [...entry.reasons]
    });
  }
  for (const key of Object.keys(context)) {
    context[key].sort((a, b) => {
      const tierDiff = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
      if (tierDiff !== 0) return tierDiff;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
    });
  }
  return {
    schemaVersion: "1.0",
    target: {
      type: targetType,
      id: targetId,
      uid: targetUid,
      title: targetNode.title,
      sourcePath: targetNode.path,
      status: targetNode.status
    },
    context,
    missing,
    missingDetails,
    omitted
  };
}
function formatContextMarkdown(manifest) {
  const lines = [];
  lines.push(`# Implementation Context: ${manifest.target.type}:${manifest.target.id}`);
  lines.push("");
  const hasTiers = manifest.schemaVersion === "1.0";
  if (hasTiers) {
    const tierLabels = {
      baseline: "Baseline \u5FC5\u8BFB",
      direct: "Direct context",
      matrix: "Matrix context",
      transitive: "Transitive / tests",
      target: "Target"
    };
    const tierGroups = /* @__PURE__ */ new Map();
    for (const items of Object.values(manifest.context)) {
      for (const item of items) {
        const tier = item.tier ?? (item.required ? "baseline" : "direct");
        if (!tierGroups.has(tier)) tierGroups.set(tier, []);
        tierGroups.get(tier).push(item);
      }
    }
    const emitOrder = ["baseline", "target", "direct", "matrix", "transitive"];
    for (const tier of emitOrder) {
      const items = tierGroups.get(tier);
      if (!items || items.length === 0) continue;
      lines.push(`## ${tierLabels[tier] ?? tier}`);
      const seen = /* @__PURE__ */ new Set();
      for (const item of items) {
        const key = `${tier}:${item.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const req = item.required ? "[\u5FC5\u8BFB] " : "";
        lines.push(`- \`${item.path}\` \u2014 ${req}${item.reason}`);
      }
      lines.push("");
    }
  } else {
    for (const [category, items] of Object.entries(manifest.context)) {
      lines.push(`## ${category}`);
      for (const item of items) {
        const req = item.required ? "[\u5FC5\u8BFB] " : "";
        lines.push(`- \`${item.path}\` \u2014 ${req}${item.reason}`);
      }
      lines.push("");
    }
  }
  if (manifest.omitted && manifest.omitted.length > 0) {
    lines.push("## Omitted");
    for (const item of manifest.omitted) {
      const tierLabel = item.tier ? ` (${item.tier})` : "";
      lines.push(`- \`${item.path}\` \u2014 ${item.reason}${tierLabel}`);
    }
    lines.push("");
  }
  if (manifest.missing.length > 0) {
    lines.push("## Missing");
    for (const m of manifest.missing) {
      lines.push(`- ${m}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// src/packet-prompt-audit.ts
import { mkdir as mkdir5, writeFile as writeFile5 } from "fs/promises";
import { join as join5 } from "path";
function promptFilename(target) {
  return `prompt-${target.type}-${target.id}.md`;
}
async function auditSinglePromptTarget(target, graph, options) {
  const entry = {
    type: target.type,
    id: target.id,
    ok: true,
    length: 0,
    issues: []
  };
  try {
    const manifest = resolveArtifactContext(graph, {
      feature: target.type === "feature" ? target.id : void 0,
      scenario: target.type === "scenario" ? target.id : void 0,
      decision: target.type === "decision" ? target.id : void 0,
      design: target.type === "design" ? target.id : void 0,
      e2e_test: target.type === "e2e_test" ? target.id : void 0,
      mode: "implementation"
    });
    if (manifest.missing.length > 0) {
      entry.ok = false;
      for (const m of manifest.missing) {
        entry.issues.push({ code: "MISSING", message: `\u7F3A\u5931\u5236\u54C1: ${m}`, severity: "error" });
      }
      return entry;
    }
    const packet = assemblePacket(manifest, { mode: "implementation" });
    const promptResult = renderPacketPrompt(packet, {
      maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
      root: options.root
    });
    if (typeof promptResult === "object" && "ok" in promptResult && !promptResult.ok) {
      const e = promptResult;
      entry.ok = false;
      entry.issues.push({
        code: "RENDER",
        message: `${e.reason}\u3002\u5B9E\u9645\u957F\u5EA6 ${e.actualLength}\uFF0C\u6700\u5C0F\u9700\u8981 ${e.minRequired} \u5B57\u7B26`,
        severity: "error"
      });
      return entry;
    }
    const prompt = promptResult;
    entry.length = prompt.length;
    const validation = validatePacketPrompt(prompt);
    for (const issue2 of validation.issues) {
      entry.issues.push({ code: issue2.code, message: issue2.message, severity: issue2.severity });
      if (issue2.severity === "error") {
        entry.ok = false;
      }
    }
    if (options.outDir) {
      const filename = promptFilename(target);
      const outPath = join5(options.outDir, filename);
      await writeFile5(outPath, prompt, "utf-8");
      entry.outputPath = outPath;
    }
  } catch (error) {
    entry.ok = false;
    entry.issues.push({
      code: "INTERNAL",
      message: error.message,
      severity: "error"
    });
  }
  return entry;
}
function renderPromptAuditSummaryMarkdown(summary) {
  const lines = [];
  lines.push("# Packet Prompt Audit Summary");
  lines.push("");
  lines.push(`> schemaVersion: ${summary.schemaVersion} | generatedAt: ${summary.generatedAt}`);
  lines.push(`> maxChars: ${summary.maxChars}`);
  lines.push("");
  lines.push("| \u6307\u6807 | \u6570\u503C |");
  lines.push("|---|---|");
  lines.push(`| \u603B\u8BA1 | ${summary.total} |`);
  lines.push(`| \u901A\u8FC7 | ${summary.passed} |`);
  lines.push(`| \u5931\u8D25 | ${summary.failed} |`);
  lines.push(`| \u8B66\u544A | ${summary.warnings} |`);
  if (summary.totalOmitted !== void 0) {
    lines.push(`| \u7701\u7565 | ${summary.totalOmitted} |`);
  }
  lines.push("");
  if (summary.countsByType) {
    lines.push("## \u6309\u7C7B\u578B\u7EDF\u8BA1");
    lines.push("");
    lines.push("| \u7C7B\u578B | \u603B\u8BA1 | \u901A\u8FC7 | \u5931\u8D25 |");
    lines.push("|------|------|------|------|");
    for (const [t, c] of Object.entries(summary.countsByType)) {
      lines.push(`| ${t} | ${c.total} | ${c.passed} | ${c.failed} |`);
    }
    lines.push("");
  }
  const isCompact = summary.totalOmitted !== void 0 && summary.totalOmitted > 0;
  const displayTargets = isCompact ? summary.targets.filter((t) => !t.ok) : summary.targets;
  lines.push("## Targets");
  lines.push("");
  if (isCompact && displayTargets.length === 0) {
    lines.push("\uFF08\u5168\u90E8\u901A\u8FC7\uFF0C\u65E0\u5931\u8D25 target\uFF09");
  }
  for (const t of displayTargets) {
    const icon = t.ok ? "PASS" : "FAIL";
    const issueStr = t.issues.length > 0 ? ` (${t.issues.length} issues)` : "";
    lines.push(`- [${icon}] \`${t.type}:${t.id}\` \u2014 length=${t.length}${issueStr}`);
    if (t.outputPath) lines.push(`  -> ${t.outputPath}`);
    for (const issue2 of t.issues) {
      const sev = issue2.severity === "error" ? "ERROR" : "WARN";
      lines.push(`  - [${sev}] ${issue2.code}: ${issue2.message}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
function computeCountsByType(entries) {
  const result = {};
  for (const e of entries) {
    if (!result[e.type]) {
      result[e.type] = { total: 0, passed: 0, failed: 0 };
    }
    result[e.type].total++;
    if (e.ok) result[e.type].passed++;
    else result[e.type].failed++;
  }
  return result;
}
async function auditPromptBatch(root, targets, options, graph) {
  const resolvedGraph = graph ?? await scanArtifacts(root);
  if (options.outDir) {
    await mkdir5(options.outDir, { recursive: true });
  }
  const entries = [];
  for (const target of targets) {
    const singleOptions = options.summaryOnly ? { ...options, outDir: void 0 } : options;
    const entry = await auditSinglePromptTarget(target, resolvedGraph, singleOptions);
    entries.push(entry);
  }
  const passed = entries.filter((e) => e.ok).length;
  const failed = entries.filter((e) => !e.ok).length;
  const warnings = entries.reduce((sum, e) => sum + e.issues.filter((i) => i.severity === "warning").length, 0);
  const countsByType = computeCountsByType(entries);
  const isCompact = options.summaryDetail === "compact";
  const summaryTargets = isCompact ? entries.filter((e) => !e.ok) : entries;
  const totalOmitted = isCompact ? entries.filter((e) => e.ok).length : 0;
  const summary = {
    schemaVersion: "1.1",
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    total: entries.length,
    passed,
    failed,
    warnings,
    countsByType,
    totalOmitted,
    sourceTargetsPath: options.sourceTargetsPath,
    maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
    targets: summaryTargets
  };
  if (options.outDir) {
    await mkdir5(options.outDir, { recursive: true });
    const jsonPath = join5(options.outDir, "prompt-audit-summary.json");
    await writeFile5(jsonPath, JSON.stringify(summary, null, 2) + "\n", "utf-8");
    const mdPath = join5(options.outDir, "prompt-audit-summary.md");
    await writeFile5(mdPath, renderPromptAuditSummaryMarkdown(summary), "utf-8");
  }
  return summary;
}
async function discoverAndAuditPromptBatch(root, options) {
  const config = await loadConfig(root);
  const graph = await scanArtifacts(root, config);
  const discovered = discoverTargets(graph, { limit: options.limit, schema: config });
  const targets = discovered.map((d) => ({
    type: d.type,
    id: d.id
  }));
  return auditPromptBatch(root, targets, {
    root,
    outDir: options.outDir,
    format: options.format,
    maxChars: options.maxChars,
    summaryOnly: options.summaryOnly,
    summaryDetail: options.summaryDetail
  }, graph);
}

// src/cli.ts
async function runCli(argv, io = {}) {
  const parsed = parseArgs(argv);
  const cwd = io.cwd ?? process.cwd();
  const out = io.stdout ?? ((chunk) => process.stdout.write(chunk));
  const err = io.stderr ?? ((chunk) => process.stderr.write(chunk));
  const root = String(parsed.flags.root ?? cwd);
  try {
    switch (parsed.command) {
      case "init": {
        await initConfig(root);
        out(`Created ${join6(root, "artifact-graph.config.yaml")}
`);
        return 0;
      }
      case "scan": {
        const graph = await scanArtifacts(root);
        await writeGraphCache(root, graph);
        out(`Scanned ${graph.nodes.length} artifacts and ${graph.edges.length} relations
`);
        return 0;
      }
      case "validate": {
        const config = await loadConfig(root);
        const graph = await scanArtifacts(root, config);
        const issues = validateGraph(graph, config);
        issues.push(...await validateExecutableTraceability(root));
        if (parsed.flags.format === "json") {
          out(`${JSON.stringify(issues, null, 2)}
`);
        } else if (issues.length === 0) {
          out("No validation issues\n");
        } else {
          out(issues.map((issue2) => `${issue2.code} ${issue2.path}:${issue2.line} ${issue2.message}`).join("\n") + "\n");
        }
        return issues.some((issue2) => issue2.severity === "error") && !parsed.flags["warning-only"] ? 1 : 0;
      }
      case "query": {
        const graph = await scanArtifacts(root);
        const result = queryGraph(graph, {
          from: typeof parsed.flags.from === "string" ? parsed.flags.from : void 0,
          to: typeof parsed.flags.to === "string" ? parsed.flags.to : void 0,
          depth: typeof parsed.flags.depth === "string" ? Number(parsed.flags.depth) : void 0
        });
        if (parsed.flags.format === "json") {
          out(`${JSON.stringify(result, null, 2)}
`);
        } else {
          out(result.nodes.map((node) => `${node.uid} ${node.path}:${node.line}`).join("\n") + "\n");
        }
        return 0;
      }
      case "render": {
        const graph = await scanArtifacts(root);
        const view = typeof parsed.flags.from === "string" || typeof parsed.flags.to === "string" ? queryGraph(graph, {
          from: typeof parsed.flags.from === "string" ? parsed.flags.from : void 0,
          to: typeof parsed.flags.to === "string" ? parsed.flags.to : void 0
        }) : graph;
        if (parsed.flags.format && parsed.flags.format !== "mermaid") {
          throw new Error(`Unsupported render format ${String(parsed.flags.format)}`);
        }
        out(renderMermaid(view));
        return 0;
      }
      case "next-id": {
        const type = parsed.positional[0];
        const range = parsed.flags.range;
        if (!type || typeof range !== "string") {
          throw new Error("Usage: artifact-graph next-id <type> --range <name>");
        }
        const config = await loadConfig(root);
        const graph = await scanArtifacts(root, config);
        out(`${nextId(graph, config, type, range)}
`);
        return 0;
      }
      case "context": {
        const contextTargets = [
          typeof parsed.flags.feature === "string" ? "feature" : null,
          typeof parsed.flags.scenario === "string" ? "scenario" : null,
          typeof parsed.flags.decision === "string" ? "decision" : null,
          typeof parsed.flags.design === "string" ? "design" : null,
          typeof parsed.flags["e2e-test"] === "string" ? "e2e_test" : null
        ].filter(Boolean);
        if (contextTargets.length !== 1) {
          err("Usage: artifact-graph context --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id> [--mode full|implementation] [--max-per-category <n>] [--format json]\n");
          return 1;
        }
        const contextMode = typeof parsed.flags.mode === "string" ? parsed.flags.mode : "implementation";
        if (contextMode !== "implementation" && contextMode !== "full") {
          err(`Invalid --mode: "${parsed.flags.mode}". Allowed values: implementation, full
`);
          err("Usage: artifact-graph context --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id> [--mode full|implementation] [--max-per-category <n>] [--format json]\n");
          return 1;
        }
        const maxPerCategory = typeof parsed.flags["max-per-category"] === "string" ? Number(parsed.flags["max-per-category"]) : void 0;
        if (typeof parsed.flags["max-per-category"] === "string") {
          const raw = parsed.flags["max-per-category"];
          const num = Number(raw);
          if (!Number.isFinite(num) || num < 1 || !Number.isInteger(num)) {
            err(`Invalid --max-per-category: "${raw}". Must be a positive integer
`);
            err("Usage: artifact-graph context --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id> [--mode full|implementation] [--max-per-category <n>] [--format json]\n");
            return 1;
          }
        }
        const graph = await scanArtifacts(root);
        const manifest = resolveArtifactContext(graph, {
          feature: typeof parsed.flags.feature === "string" ? parsed.flags.feature : void 0,
          scenario: typeof parsed.flags.scenario === "string" ? parsed.flags.scenario : void 0,
          decision: typeof parsed.flags.decision === "string" ? parsed.flags.decision : void 0,
          design: typeof parsed.flags.design === "string" ? parsed.flags.design : void 0,
          e2e_test: typeof parsed.flags["e2e-test"] === "string" ? parsed.flags["e2e-test"] : void 0,
          mode: contextMode,
          maxPerCategory
        });
        if (parsed.flags.format === "json") {
          out(`${JSON.stringify(manifest, null, 2)}
`);
        } else {
          out(formatContextMarkdown(manifest));
        }
        return manifest.missing.length > 0 ? 1 : 0;
      }
      case "packet": {
        const packetTargets = [
          typeof parsed.flags.feature === "string" ? "feature" : null,
          typeof parsed.flags.scenario === "string" ? "scenario" : null,
          typeof parsed.flags.decision === "string" ? "decision" : null,
          typeof parsed.flags.design === "string" ? "design" : null,
          typeof parsed.flags["e2e-test"] === "string" ? "e2e_test" : null
        ].filter(Boolean);
        if (packetTargets.length !== 1) {
          err("Usage: artifact-graph packet --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id> [--mode full|implementation] [--max-per-category <n>] [--format json|markdown] [--out <path>]\n");
          return 1;
        }
        const packetMode = typeof parsed.flags.mode === "string" ? parsed.flags.mode : "implementation";
        if (packetMode !== "implementation" && packetMode !== "full") {
          err(`Invalid --mode: "${parsed.flags.mode}". Allowed values: implementation, full
`);
          err("Usage: artifact-graph packet --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id> [--mode full|implementation] [--max-per-category <n>] [--format json|markdown] [--out <path>]\n");
          return 1;
        }
        const packetMaxPerCategory = typeof parsed.flags["max-per-category"] === "string" ? Number(parsed.flags["max-per-category"]) : void 0;
        if (typeof parsed.flags["max-per-category"] === "string") {
          const raw2 = parsed.flags["max-per-category"];
          const num2 = Number(raw2);
          if (!Number.isFinite(num2) || num2 < 1 || !Number.isInteger(num2)) {
            err(`Invalid --max-per-category: "${raw2}". Must be a positive integer
`);
            err("Usage: artifact-graph packet --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id> [--mode full|implementation] [--max-per-category <n>] [--format json|markdown] [--out <path>]\n");
            return 1;
          }
        }
        const graph = await scanArtifacts(root);
        const manifest = resolveArtifactContext(graph, {
          feature: typeof parsed.flags.feature === "string" ? parsed.flags.feature : void 0,
          scenario: typeof parsed.flags.scenario === "string" ? parsed.flags.scenario : void 0,
          decision: typeof parsed.flags.decision === "string" ? parsed.flags.decision : void 0,
          design: typeof parsed.flags.design === "string" ? parsed.flags.design : void 0,
          e2e_test: typeof parsed.flags["e2e-test"] === "string" ? parsed.flags["e2e-test"] : void 0,
          mode: packetMode,
          maxPerCategory: packetMaxPerCategory
        });
        if (manifest.missing.length > 0) {
          err("Missing artifacts detected \u2014 cannot generate packet:\n");
          for (const m of manifest.missing) {
            err(`  - ${m}
`);
          }
          err("\nFix the traceability gaps above before generating an implementation packet.\n");
          if (typeof parsed.flags.out === "string") {
            const errorReport = JSON.stringify({ error: "missing", missing: manifest.missing }, null, 2);
            await writeFile6(parsed.flags.out, errorReport + "\n");
          }
          return 1;
        }
        const packet = assemblePacket(manifest, {
          mode: packetMode,
          maxPerCategory: packetMaxPerCategory
        });
        const skipValidate = parsed.flags["no-validate"] === true;
        if (!skipValidate) {
          const vResult = validatePacket(packet);
          if (vResult.issues.length > 0) {
            for (const issue2 of vResult.issues) {
              err(`[${issue2.severity.toUpperCase()}] ${issue2.code}: ${issue2.message}
`);
            }
          }
          if (!vResult.ok) {
            err("Packet validation failed. Use --no-validate to skip.\n");
            return 1;
          }
        }
        const packetFormat = typeof parsed.flags.format === "string" ? parsed.flags.format : "markdown";
        let output;
        if (packetFormat === "json") {
          output = JSON.stringify(packet, null, 2) + "\n";
        } else if (packetFormat === "markdown") {
          output = renderPacketMarkdown(packet);
        } else {
          err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown
`);
          return 1;
        }
        if (typeof parsed.flags.out === "string") {
          await writeFile6(parsed.flags.out, output);
          out(`Packet written to ${parsed.flags.out}
`);
        } else {
          out(output);
        }
        return 0;
      }
      case "packet-prompt": {
        const promptFormat = typeof parsed.flags.format === "string" ? parsed.flags.format : void 0;
        if (promptFormat && promptFormat !== "markdown") {
          err(`\u4E0D\u652F\u6301\u7684 --format: "${promptFormat}". packet-prompt \u4EC5\u652F\u6301 --format markdown
`);
          return 1;
        }
        const packetJsonPath = typeof parsed.flags.packet === "string" ? parsed.flags.packet : void 0;
        const promptTargets = [
          typeof parsed.flags.feature === "string" ? "feature" : null,
          typeof parsed.flags.scenario === "string" ? "scenario" : null,
          typeof parsed.flags.decision === "string" ? "decision" : null,
          typeof parsed.flags.design === "string" ? "design" : null,
          typeof parsed.flags["e2e-test"] === "string" ? "e2e_test" : null
        ].filter(Boolean);
        if (packetJsonPath && promptTargets.length > 0) {
          err("\u9519\u8BEF\uFF1A--packet \u4E0E --feature/--scenario/--decision/--design/--e2e-test \u4E92\u65A5\uFF0C\u53EA\u80FD\u6307\u5B9A\u4E00\u79CD\u8F93\u5165\u65B9\u5F0F\n");
          return 1;
        }
        if (!packetJsonPath && promptTargets.length !== 1) {
          err("Usage: artifact-graph packet-prompt (--feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id> | --packet <path>) [--max-chars <n>] [--format markdown] [--out <path>]\n");
          return 1;
        }
        const maxChars = typeof parsed.flags["max-chars"] === "string" ? Number(parsed.flags["max-chars"]) : DEFAULT_MAX_CHARS;
        if (typeof parsed.flags["max-chars"] === "string") {
          const rawMc = parsed.flags["max-chars"];
          const numMc = Number(rawMc);
          if (!Number.isFinite(numMc) || numMc < MIN_PROMPT_CHARS || !Number.isInteger(numMc)) {
            err(`Invalid --max-chars: "${rawMc}". Must be an integer >= ${MIN_PROMPT_CHARS}
`);
            return 1;
          }
        }
        let promptPacket;
        if (packetJsonPath) {
          let rawJson;
          try {
            rawJson = await readFile4(packetJsonPath, "utf-8");
          } catch (readErr) {
            err(`\u9519\u8BEF\uFF1A\u65E0\u6CD5\u8BFB\u53D6 packet \u6587\u4EF6: "${packetJsonPath}" \u2014 ${readErr.message}
`);
            return 1;
          }
          let parsedPacket;
          try {
            parsedPacket = JSON.parse(rawJson);
          } catch {
            err(`\u9519\u8BEF\uFF1Apacket \u6587\u4EF6\u4E0D\u662F\u6709\u6548\u7684 JSON: "${packetJsonPath}"
`);
            return 1;
          }
          const pp = parsedPacket;
          const missingFields = [];
          if (pp.schemaVersion !== "1.0") missingFields.push('schemaVersion (\u9700\u8981 "1.0")');
          if (!pp.target || typeof pp.target !== "object") missingFields.push("target");
          if (!pp.requiredBaseline || typeof pp.requiredBaseline !== "object") missingFields.push("requiredBaseline");
          if (!pp.contextByTier || typeof pp.contextByTier !== "object") missingFields.push("contextByTier");
          if (!Array.isArray(pp.validationCommands)) missingFields.push("validationCommands");
          if (!pp.implementationBlueprintDraft || typeof pp.implementationBlueprintDraft !== "object") missingFields.push("implementationBlueprintDraft");
          if (missingFields.length > 0) {
            err(`\u9519\u8BEF\uFF1Apacket JSON \u7F3A\u5931\u6216\u65E0\u6548\u5B57\u6BB5:
`);
            for (const f of missingFields) {
              err(`  - ${f}
`);
            }
            return 1;
          }
          promptPacket = parsedPacket;
        } else {
          const graph = await scanArtifacts(root);
          const promptManifest = resolveArtifactContext(graph, {
            feature: typeof parsed.flags.feature === "string" ? parsed.flags.feature : void 0,
            scenario: typeof parsed.flags.scenario === "string" ? parsed.flags.scenario : void 0,
            decision: typeof parsed.flags.decision === "string" ? parsed.flags.decision : void 0,
            design: typeof parsed.flags.design === "string" ? parsed.flags.design : void 0,
            e2e_test: typeof parsed.flags["e2e-test"] === "string" ? parsed.flags["e2e-test"] : void 0,
            mode: "implementation"
          });
          if (promptManifest.missing.length > 0) {
            err("Missing artifacts detected \u2014 cannot generate prompt:\n");
            for (const m of promptManifest.missing) {
              err(`  - ${m}
`);
            }
            return 1;
          }
          promptPacket = assemblePacket(promptManifest, {
            mode: "implementation",
            generatedAt: typeof parsed.flags["generated-at"] === "string" ? parsed.flags["generated-at"] : void 0
          });
        }
        const promptResult = renderPacketPrompt(promptPacket, {
          maxChars,
          generatedAt: typeof parsed.flags["generated-at"] === "string" ? parsed.flags["generated-at"] : void 0,
          root
        });
        if (typeof promptResult === "object" && "ok" in promptResult && !promptResult.ok) {
          const e = promptResult;
          err(`\u9519\u8BEF\uFF1A${e.reason}\u3002\u5B9E\u9645\u957F\u5EA6 ${e.actualLength}\uFF0C\u6700\u5C0F\u9700\u8981 ${e.minRequired} \u5B57\u7B26\u3002
`);
          return 1;
        }
        const prompt = promptResult;
        const promptValidation = validatePacketPrompt(prompt);
        const promptErrors = promptValidation.issues.filter((issue2) => issue2.severity === "error");
        if (promptErrors.length > 0) {
          err("\u9519\u8BEF\uFF1A\u751F\u6210\u7684 packet-prompt \u672A\u901A\u8FC7\u8D28\u91CF\u6821\u9A8C\uFF1A\n");
          for (const issue2 of promptErrors) {
            err(`  - ${issue2.code}: ${issue2.message}
`);
          }
          return 1;
        }
        const promptWarnings = promptValidation.issues.filter((issue2) => issue2.severity === "warning");
        for (const issue2 of promptWarnings) {
          err(`\u8B66\u544A\uFF1A${issue2.code}: ${issue2.message}
`);
        }
        if (typeof parsed.flags.out === "string") {
          await writeFile6(parsed.flags.out, prompt);
          out(`Prompt written to ${parsed.flags.out}
`);
        } else {
          out(prompt);
        }
        return 0;
      }
      case "packet-audit": {
        const targetsFile = typeof parsed.flags["targets-file"] === "string" ? parsed.flags["targets-file"] : void 0;
        const discover = parsed.flags.discover === true;
        if (targetsFile && discover) {
          err("Error: --discover and --targets-file are mutually exclusive\n");
          return 1;
        }
        if (!targetsFile && !discover) {
          err("Usage: artifact-graph packet-audit (--targets-file <path> | --discover) [--out-dir <path>] [--limit <n>] [--format json|markdown] [--mode full|implementation] [--max-per-category <n>] [--summary-only] [--sample-targets <csv>] [--summary-detail full|compact]\n");
          return 1;
        }
        const summaryOnly = parsed.flags["summary-only"] === true;
        const sampleTargetsRaw = typeof parsed.flags["sample-targets"] === "string" ? parsed.flags["sample-targets"] : void 0;
        if (summaryOnly && sampleTargetsRaw) {
          err("Error: --summary-only and --sample-targets are mutually exclusive\n");
          return 1;
        }
        let sampleTargets;
        if (sampleTargetsRaw) {
          sampleTargets = sampleTargetsRaw.split(",").map((s) => s.trim()).filter(Boolean);
          for (const st of sampleTargets) {
            const colonIdx = st.indexOf(":");
            if (colonIdx < 0) {
              err(`Invalid --sample-targets entry: "${st}". Expected format "type:id"
`);
              return 1;
            }
            const stType = st.slice(0, colonIdx).trim();
            if (!["feature", "scenario", "decision", "design", "e2e_test"].includes(stType)) {
              err(`Invalid --sample-targets entry: "${st}". Type must be feature, scenario, decision, design, or e2e_test
`);
              return 1;
            }
            const stId = st.slice(colonIdx + 1).trim();
            if (!stId) {
              err(`Invalid --sample-targets entry: "${st}". ID is empty
`);
              return 1;
            }
          }
        }
        const auditOutDir = typeof parsed.flags["out-dir"] === "string" ? parsed.flags["out-dir"] : void 0;
        if (!auditOutDir && !summaryOnly) {
          err("Usage: artifact-graph packet-audit (--targets-file <path> | --discover) [--out-dir <path>] [--limit <n>] [--format json|markdown] [--mode full|implementation] [--max-per-category <n>] [--summary-only] [--sample-targets <csv>] [--summary-detail full|compact]\n");
          err("  --out-dir is required unless --summary-only is set\n");
          return 1;
        }
        const auditFormat = typeof parsed.flags.format === "string" ? parsed.flags.format : "markdown";
        if (auditFormat !== "json" && auditFormat !== "markdown") {
          err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown
`);
          return 1;
        }
        const auditMode = typeof parsed.flags.mode === "string" ? parsed.flags.mode : "implementation";
        if (auditMode !== "implementation" && auditMode !== "full") {
          err(`Invalid --mode: "${parsed.flags.mode}". Allowed values: implementation, full
`);
          return 1;
        }
        const auditMaxPerCategory = typeof parsed.flags["max-per-category"] === "string" ? Number(parsed.flags["max-per-category"]) : void 0;
        if (typeof parsed.flags["max-per-category"] === "string") {
          const raw3 = parsed.flags["max-per-category"];
          const num3 = Number(raw3);
          if (!Number.isFinite(num3) || num3 < 1 || !Number.isInteger(num3)) {
            err(`Invalid --max-per-category: "${raw3}". Must be a positive integer
`);
            return 1;
          }
        }
        const limit = typeof parsed.flags.limit === "string" ? Number(parsed.flags.limit) : void 0;
        if (typeof parsed.flags.limit === "string") {
          const rawLimit = parsed.flags.limit;
          const numLimit = Number(rawLimit);
          if (!Number.isFinite(numLimit) || numLimit < 0 || !Number.isInteger(numLimit)) {
            err(`Invalid --limit: "${rawLimit}". Must be a non-negative integer (0 = no limit)
`);
            return 1;
          }
        }
        const summaryDetail = typeof parsed.flags["summary-detail"] === "string" ? parsed.flags["summary-detail"] : void 0;
        if (summaryDetail && summaryDetail !== "full" && summaryDetail !== "compact") {
          err(`Invalid --summary-detail: "${parsed.flags["summary-detail"]}". Allowed values: full, compact
`);
          return 1;
        }
        let summary;
        if (discover) {
          summary = await discoverAndAuditPackets(root, {
            root,
            outDir: auditOutDir,
            format: auditFormat,
            mode: auditMode,
            maxPerCategory: auditMaxPerCategory,
            limit: limit === 0 ? Infinity : limit,
            summaryOnly,
            sampleTargets,
            summaryDetail
          });
        } else {
          const targetsContent = await readFile4(targetsFile, "utf-8");
          const parseResult = parseTargetsFile(targetsContent);
          if (parseResult.errors.length > 0) {
            for (const e of parseResult.errors) {
              err(`Parse error (line ${e.line}): ${e.message} \u2014 ${e.raw}
`);
            }
            return 1;
          }
          if (parseResult.targets.length === 0) {
            err(`No valid targets found in ${targetsFile}
`);
            return 1;
          }
          summary = await auditPackets(root, parseResult.targets, {
            root,
            outDir: auditOutDir,
            format: auditFormat,
            mode: auditMode,
            maxPerCategory: auditMaxPerCategory,
            sourceTargetsPath: targetsFile,
            summaryOnly,
            sampleTargets,
            summaryDetail
          });
        }
        if (parsed.flags.format === "json") {
          out(`${JSON.stringify(summary, null, 2)}
`);
        } else {
          out(`Packet Audit Summary
`);
          out(`Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed} | Missing: ${summary.missing}
`);
          for (const t of summary.targets) {
            const statusIcon = t.status === "passed" ? "PASS" : t.status === "failed" ? "FAIL" : "MISS";
            out(`  [${statusIcon}] ${t.type}:${t.id} items=${t.itemsCount} baseline=${t.baselineCount} missing=${t.missingCount} omitted=${t.omittedCount}`);
            if (t.outputPath) out(` -> ${t.outputPath}`);
            out("\n");
            for (const err2 of t.errors) {
              out(`        ${err2}
`);
            }
          }
        }
        if (discover && summary.total === 0) {
          err(`Error: discover mode found 0 targets in ${root}. Is this a valid artifact root?
`);
          return 1;
        }
        return summary.failed > 0 ? 1 : 0;
      }
      case "packet-prompt-audit": {
        const ppaTargetsFile = typeof parsed.flags["targets-file"] === "string" ? parsed.flags["targets-file"] : void 0;
        const ppaDiscover = parsed.flags.discover === true;
        if (ppaTargetsFile && ppaDiscover) {
          err("\u9519\u8BEF\uFF1A--discover \u4E0E --targets-file \u4E92\u65A5\uFF0C\u53EA\u80FD\u9009\u62E9\u4E00\u79CD\u65B9\u5F0F\n");
          return 1;
        }
        if (!ppaTargetsFile && !ppaDiscover) {
          err("Usage: artifact-graph packet-prompt-audit (--targets-file <path> | --discover) [--out-dir <path>] [--format json|markdown] [--max-chars <n>] [--limit <n>] [--summary-only] [--summary-detail full|compact]\n");
          return 1;
        }
        if (parsed.flags.packet) {
          err("\u9519\u8BEF\uFF1Apacket-prompt-audit \u4E0D\u652F\u6301 --packet\uFF0C\u4EC5\u63A5\u53D7 --targets-file \u6216 --discover\n");
          return 1;
        }
        const ppaFormat = typeof parsed.flags.format === "string" ? parsed.flags.format : "json";
        if (ppaFormat !== "json" && ppaFormat !== "markdown") {
          err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown
`);
          return 1;
        }
        const ppaMaxChars = typeof parsed.flags["max-chars"] === "string" ? Number(parsed.flags["max-chars"]) : DEFAULT_MAX_CHARS;
        if (typeof parsed.flags["max-chars"] === "string") {
          const rawPpa = parsed.flags["max-chars"];
          const numPpa = Number(rawPpa);
          if (!Number.isFinite(numPpa) || numPpa < MIN_PROMPT_CHARS || !Number.isInteger(numPpa)) {
            err(`Invalid --max-chars: "${rawPpa}". Must be an integer >= ${MIN_PROMPT_CHARS}
`);
            return 1;
          }
        }
        const ppaOutDir = typeof parsed.flags["out-dir"] === "string" ? parsed.flags["out-dir"] : void 0;
        const ppaSummaryOnly = parsed.flags["summary-only"] === true;
        const ppaSummaryDetail = typeof parsed.flags["summary-detail"] === "string" ? parsed.flags["summary-detail"] : void 0;
        if (ppaSummaryDetail && ppaSummaryDetail !== "full" && ppaSummaryDetail !== "compact") {
          err(`Invalid --summary-detail: "${parsed.flags["summary-detail"]}". Allowed values: full, compact
`);
          return 1;
        }
        const ppaLimit = typeof parsed.flags.limit === "string" ? Number(parsed.flags.limit) : void 0;
        if (typeof parsed.flags.limit === "string") {
          const rawPpaLimit = parsed.flags.limit;
          const numPpaLimit = Number(rawPpaLimit);
          if (!Number.isFinite(numPpaLimit) || numPpaLimit < 0 || !Number.isInteger(numPpaLimit)) {
            err(`Invalid --limit: "${rawPpaLimit}". Must be a non-negative integer (0 = no limit)
`);
            return 1;
          }
        }
        let ppaSummary;
        if (ppaDiscover) {
          ppaSummary = await discoverAndAuditPromptBatch(root, {
            root,
            outDir: ppaOutDir,
            format: ppaFormat,
            maxChars: ppaMaxChars,
            limit: ppaLimit === 0 ? Infinity : ppaLimit,
            summaryOnly: ppaSummaryOnly,
            summaryDetail: ppaSummaryDetail
          });
          if (ppaSummary.total === 0) {
            err(`\u9519\u8BEF\uFF1Adiscover \u6A21\u5F0F\u5728 ${root} \u4E2D\u672A\u627E\u5230\u4EFB\u4F55 target\u3002\u8BF7\u786E\u8BA4\u8FD9\u662F\u4E00\u4E2A\u6709\u6548\u7684 artifact root\u3002
`);
            return 1;
          }
        } else {
          let ppaTargetsContent;
          try {
            ppaTargetsContent = await readFile4(ppaTargetsFile, "utf-8");
          } catch (readErr) {
            err(`\u9519\u8BEF\uFF1A\u65E0\u6CD5\u8BFB\u53D6 targets \u6587\u4EF6: "${ppaTargetsFile}" \u2014 ${readErr.message}
`);
            return 1;
          }
          if (ppaTargetsContent.trim().length === 0) {
            err(`\u9519\u8BEF\uFF1Atargets \u6587\u4EF6\u4E3A\u7A7A: "${ppaTargetsFile}"
`);
            return 1;
          }
          const ppaParseResult = parseTargetsFile(ppaTargetsContent);
          if (ppaParseResult.errors.length > 0) {
            for (const e of ppaParseResult.errors) {
              err(`Parse error (line ${e.line}): ${e.message} \u2014 ${e.raw}
`);
            }
            return 1;
          }
          if (ppaParseResult.targets.length === 0) {
            err(`No valid targets found in ${ppaTargetsFile}
`);
            return 1;
          }
          ppaSummary = await auditPromptBatch(root, ppaParseResult.targets, {
            root,
            outDir: ppaOutDir,
            format: ppaFormat,
            maxChars: ppaMaxChars,
            sourceTargetsPath: ppaTargetsFile,
            summaryOnly: ppaSummaryOnly,
            summaryDetail: ppaSummaryDetail
          });
        }
        if (ppaFormat === "json") {
          out(`${JSON.stringify(ppaSummary, null, 2)}
`);
        } else {
          out(`Packet Prompt Audit Summary
`);
          out(`\u603B\u8BA1: ${ppaSummary.total} | \u901A\u8FC7: ${ppaSummary.passed} | \u5931\u8D25: ${ppaSummary.failed} | \u8B66\u544A: ${ppaSummary.warnings}
`);
          if (ppaSummary.totalOmitted !== void 0 && ppaSummary.totalOmitted > 0) {
            out(`\uFF08compact \u6A21\u5F0F\uFF1A\u5DF2\u7701\u7565 ${ppaSummary.totalOmitted} \u4E2A\u901A\u8FC7\u7684 target \u8BE6\u60C5\uFF09
`);
          }
          if (ppaSummary.countsByType) {
            const cbt = ppaSummary.countsByType;
            const typeEntries = Object.entries(cbt).map(([t, c]) => `${t}=${c.total}/${c.passed}`);
            out(`\u6309\u7C7B\u578B: ${typeEntries.join(" ")}
`);
          }
          for (const t of ppaSummary.targets) {
            const icon = t.ok ? "PASS" : "FAIL";
            out(`  [${icon}] ${t.type}:${t.id} length=${t.length}`);
            if (t.outputPath) out(` -> ${t.outputPath}`);
            out("\n");
            for (const issue2 of t.issues) {
              const sev = issue2.severity === "error" ? "ERROR" : "WARN";
              out(`        [${sev}] ${issue2.code}: ${issue2.message}
`);
            }
          }
        }
        return ppaSummary.failed > 0 ? 1 : 0;
      }
      case "version-index": {
        const format = typeof parsed.flags.format === "string" ? parsed.flags.format : "json";
        if (format !== "json") {
          err(`Invalid --format: "${parsed.flags.format}". Allowed values: json
`);
          return 1;
        }
        const index = await buildVersionIndex(root);
        const output = `${JSON.stringify(index, null, 2)}
`;
        if (typeof parsed.flags.out === "string") {
          await writeFile6(parsed.flags.out, output);
          out(`Version index written to ${parsed.flags.out}
`);
        } else {
          out(output);
        }
        return 0;
      }
      case "version-lock": {
        const action = parsed.positional[0];
        const lockPath = typeof parsed.flags["lock-path"] === "string" ? parsed.flags["lock-path"] : VERSION_LOCK_PATH;
        if (action === "audit") {
          const versionLockAuditFormat = typeof parsed.flags.format === "string" ? parsed.flags.format : "markdown";
          if (versionLockAuditFormat !== "json" && versionLockAuditFormat !== "markdown") {
            err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown
`);
            return 1;
          }
          const result = await auditVersionLock(root, lockPath);
          if (versionLockAuditFormat === "json") {
            out(`${JSON.stringify(result, null, 2)}
`);
          } else {
            out(renderVersionLockAuditMarkdown(result));
          }
          return hasBlockingVersionIssues(result.issues, parsed.flags["strict-missing-lock"] === true) && !parsed.flags["warning-only"] ? 1 : 0;
        }
        if (action === "update") {
          const target = typeof parsed.flags.target === "string" ? parsed.flags.target : void 0;
          const source = typeof parsed.flags.source === "string" ? parsed.flags.source : void 0;
          if (!target || !source) {
            err("Usage: artifact-graph version-lock update --target <type:id> --source <path> [--verified-by <path,path>] [--lock-path <path>]\n");
            return 1;
          }
          const verifiedBy = typeof parsed.flags["verified-by"] === "string" ? parsed.flags["verified-by"].split(",").map((item) => item.trim()).filter(Boolean) : void 0;
          const next = await updateVersionLock(root, {
            target,
            source,
            verifiedBy,
            lockPath
          });
          out(`Updated ${lockPath} (${next.locks.length} locks)
`);
          return 0;
        }
        if (action === "bootstrap") {
          const next = await bootstrapVersionLock(root, {
            lockPath,
            force: parsed.flags.force === true
          });
          out(`Bootstrapped ${lockPath} (${next.locks.length} locks)
`);
          return 0;
        }
        if (action === "refresh") {
          const refreshFormat = typeof parsed.flags.format === "string" ? parsed.flags.format : "markdown";
          if (refreshFormat !== "json" && refreshFormat !== "markdown") {
            err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown
`);
            return 1;
          }
          const refreshAll = parsed.flags.all === true;
          const refreshChangedOnly = parsed.flags["changed-only"] === true;
          if (!refreshAll && !refreshChangedOnly) {
            err("Usage: artifact-graph version-lock refresh (--all | --changed-only (--staged | --worktree | --base <ref>)) [--remove-orphans] [--format json|markdown] [--lock-path <path>]\n");
            return 1;
          }
          if (refreshAll && refreshChangedOnly) {
            err("Error: --all and --changed-only are mutually exclusive\n");
            return 1;
          }
          let changedPaths = [];
          if (refreshChangedOnly) {
            const changeModeFlags = [
              parsed.flags.staged === true ? "staged" : null,
              parsed.flags.worktree === true ? "worktree" : null,
              typeof parsed.flags.base === "string" ? "base" : null
            ].filter(Boolean);
            if (changeModeFlags.length !== 1) {
              err("Usage: artifact-graph version-lock refresh --changed-only (--staged | --worktree | --base <ref>) [--remove-orphans] [--format json|markdown] [--lock-path <path>]\n");
              return 1;
            }
            const changeResult = await collectChangedPaths(root, {
              mode: changeModeFlags[0],
              base: typeof parsed.flags.base === "string" ? parsed.flags.base : void 0
            });
            if (changeResult.stagedUnstagedConflictPaths.length > 0) {
              err("Cannot refresh staged version locks because these paths have both staged and unstaged changes:\n");
              for (const conflictPath of changeResult.stagedUnstagedConflictPaths) {
                err(`  - ${conflictPath}
`);
              }
              err("Stage or stash the unstaged changes before running changed-only staged refresh.\n");
              return 1;
            }
            const unstagedGraphPaths = changeResult.unstagedPaths.filter(isGraphRelevantPath);
            if (unstagedGraphPaths.length > 0) {
              err("Cannot refresh staged version locks because graph-relevant unstaged changes may affect working-tree hashes:\n");
              for (const conflictPath of unstagedGraphPaths) {
                err(`  - ${conflictPath}
`);
              }
              err("Stage or stash graph-relevant unstaged changes before running changed-only staged refresh.\n");
              return 1;
            }
            changedPaths = changeResult.changedPaths;
          }
          const result = await refreshVersionLock(root, {
            lockPath,
            changedOnly: refreshChangedOnly,
            changedPaths,
            all: refreshAll,
            removeOrphans: parsed.flags["remove-orphans"] === true
          });
          if (refreshFormat === "json") {
            out(`${JSON.stringify(result, null, 2)}
`);
          } else {
            out(renderVersionLockRefreshMarkdown(result));
          }
          return hasBlockingVersionIssues(result.postAudit.issues, true) && !parsed.flags["warning-only"] ? 1 : 0;
        }
        err("Usage: artifact-graph version-lock audit|update|bootstrap|refresh [options]\n");
        return 1;
      }
      case "trace-version": {
        const target = typeof parsed.flags.target === "string" ? parsed.flags.target : parsed.positional[0];
        if (!target) {
          err("Usage: artifact-graph trace-version --target <type:id> [--format json|markdown] [--lock-path <path>]\n");
          return 1;
        }
        const lockPath = typeof parsed.flags["lock-path"] === "string" ? parsed.flags["lock-path"] : VERSION_LOCK_PATH;
        const traceVersionFormat = typeof parsed.flags.format === "string" ? parsed.flags.format : "markdown";
        if (traceVersionFormat !== "json" && traceVersionFormat !== "markdown") {
          err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown
`);
          return 1;
        }
        const result = await traceVersion(root, target, lockPath);
        if (traceVersionFormat === "json") {
          out(`${JSON.stringify(result, null, 2)}
`);
        } else {
          out(renderTraceVersionMarkdown(result));
        }
        return hasBlockingVersionIssues(result.issues, parsed.flags["strict-missing-lock"] === true) && !parsed.flags["warning-only"] ? 1 : 0;
      }
      case "hooks": {
        const action = parsed.positional[0];
        if (action !== "install-git") {
          err("Usage: artifact-graph hooks install-git [--hook pre-commit|pre-push|all] [--uninstall]\n");
          return 1;
        }
        const hookFlag = typeof parsed.flags.hook === "string" ? parsed.flags.hook : "all";
        const hooks = hookFlag === "all" ? ["pre-commit", "pre-push"] : [hookFlag];
        for (const hookName of hooks) {
          if (hookName !== "pre-commit" && hookName !== "pre-push") {
            err(`Unsupported hook: ${hookName}
`);
            return 1;
          }
          const templatePath = fileURLToPath(new URL(`../templates/git-hooks/${hookName}.sh`, import.meta.url));
          const block = await readFile4(templatePath, "utf-8");
          const result = await installManagedHookBlock({
            hookPath: join6(root, `.git/hooks/${hookName}`),
            block,
            uninstall: parsed.flags.uninstall === true
          });
          out(`${result.action}: ${result.hookPath}
`);
        }
        return 0;
      }
      case "doctor": {
        const doctorFormat = typeof parsed.flags.format === "string" ? parsed.flags.format : "markdown";
        if (doctorFormat !== "json" && doctorFormat !== "markdown") {
          err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown
`);
          return 1;
        }
        const report = await doctorArtifactChain(root);
        if (doctorFormat === "json") {
          out(`${JSON.stringify(report, null, 2)}
`);
        } else {
          const config = await loadConfig(root);
          out(renderDoctorMarkdown(report));
          out(`Types: ${Object.keys(config.types).sort().join(", ")}
`);
          out(`Forbidden edges: ${config.forbiddenEdges.length}
`);
        }
        return 0;
      }
      default:
        err(helpText());
        return 1;
    }
  } catch (error) {
    err(`${error.message}
`);
    return 1;
  }
}
function hasBlockingVersionIssues(issues, strictMissingLock) {
  return issues.some((issue2) => issue2.status !== "missing_lock" || strictMissingLock);
}
function isGraphRelevantPath(path) {
  return path === "artifact-graph.config.yaml" || path === VERSION_LOCK_PATH || path.startsWith("artifacts/") || /\.(md|mdx|json|ya?ml|ts|tsx|js|jsx|mts|cts|rs|py|go)$/.test(path);
}
async function initConfig(root) {
  const configPath = join6(root, "artifact-graph.config.yaml");
  try {
    await access2(configPath);
    throw new Error(`Config already exists: ${configPath}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  await writeFile6(configPath, yaml2.dump(DEFAULT_SCHEMA, { lineWidth: 120 }));
}
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[index + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}
function helpText() {
  return `artifact-graph <command>

Commands:
  init
  scan
  validate [--format json] [--warning-only]
  query --from <code> [--format json]
  context --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id> [--mode full|implementation] [--max-per-category <n>] [--format json]
  packet --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id> [--mode full|implementation] [--max-per-category <n>] [--format json|markdown] [--out <path>] [--no-validate]
  packet-prompt (--feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id> | --packet <path>) [--max-chars <n>] [--format markdown] [--out <path>]
  packet-audit (--targets-file <path> | --discover) [--out-dir <path>] [--limit <n>] [--format json|markdown] [--mode full|implementation] [--max-per-category <n>] [--summary-only] [--sample-targets <type:id,...>] [--summary-detail full|compact]
  packet-prompt-audit --targets-file <path> [--out-dir <path>] [--format json|markdown] [--max-chars <n>]
  version-index [--format json] [--out <path>]
  version-lock audit [--format json|markdown] [--warning-only] [--strict-missing-lock] [--lock-path <path>]
  version-lock update --target <type:id> --source <path> [--verified-by <path,path>] [--lock-path <path>]
  version-lock bootstrap [--force] [--lock-path <path>]
  version-lock refresh (--all | --changed-only (--staged | --worktree | --base <ref>)) [--remove-orphans] [--format json|markdown] [--lock-path <path>]
  trace-version --target <type:id> [--format json|markdown] [--warning-only] [--strict-missing-lock] [--lock-path <path>]
  hooks install-git [--hook pre-commit|pre-push|all] [--uninstall]
  next-id <type> --range <name>
  render [--format mermaid]
  doctor [--format json|markdown]
`;
}
function isCliEntrypoint(argvPath) {
  if (!argvPath) {
    return false;
  }
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isCliEntrypoint(process.argv[1])) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
export {
  runCli
};
