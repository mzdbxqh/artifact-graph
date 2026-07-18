# Changelog

## Unreleased

## 0.6.1

### Fixed

- **CHANGELOG documentation corrections**: correct two 0.6.0 CHANGELOG descriptions to match
  actual implementation:
  - `E2E-UNIT-TEST-NOT-E2E`: the trigger condition is based on `e2e.runners[].kind` and runner
    root/include/exclude/testIgnore acceptance, not `.test.ts` / `.spec.ts` file suffix.
  - `E2E-TRACE-004`: when Markdown explicitly declares `chain_type: desktop_chain`, conflicts with
    source-level `mock_playwright` annotations are entirely suppressed (not downgraded to info).

## 0.6.0

### Added

- **E2E coverage proof mechanism**: `validate --include e2e-coverage` now outputs executable_ref
  coverage statistics (total TCs, with executable_ref, rate), status breakdown, chain_type breakdown,
  uncovered scenarios, and uncovered features. JSON and human-readable formats supported.
  - Configurable thresholds via `artifact-graph.config.yaml` `e2e` section:
    `executable_ref_warning`, `executable_ref_error`, `report_uncovered_scenarios`,
    `report_uncovered_features`, `scenario_waivers`, `feature_waivers`.
  - Threshold violations produce `E2E_COVERAGE_WARNING` / `E2E_COVERAGE_ERROR` findings.

- **TC status lifecycle validation**: TCs with invalid `status` values produce `E2E_INVALID_TC_STATUS`.
  `waived` status requires non-empty `waived_reason` (`E2E_WAIVED_NO_REASON`).

- **chain_type vocabulary validation**: Invalid chain_type produces `E2E_INVALID_CHAIN_TYPE`.
  Deprecated aliases `core_only` → `core_e2e`, `frontend_only` → `mock_playwright` produce
  `E2E_DEPRECATED_CHAIN_TYPE` migration warnings.

- **ac_coverage_rate freetext detection**: Handwritten percentages produce
  `E2E_AC_COVERAGE_RATE_FREETEXT` — this field must be computed, not manually entered.

- **Deterministic checklist rules**:
  - `E2E-UNIT-TEST-NOT-E2E`: executable_ref target is only accepted by unit runner(s)
    (per `e2e.runners[].kind` and runner root/include/exclude/testIgnore acceptance), not by any
    e2e/integration runner.
  - Version-lock liveness: E2E spec files with no active `@e2e_test`/`@tc` annotations produce
    `orphan_lock` liveness warnings.

- **`generate-e2e-registry` command**: Deterministic, idempotent E2E registry generation from
  Markdown test files. `--deterministic` flag sets `generated_at` to epoch for diff checks.
  `--out <path>` writes output to file.

- **E2E-TRACE-004 Markdown authority**: When a TC explicitly declares `chain_type: desktop_chain`
  in its Markdown, the Markdown side is authoritative (per artifact-chain-spec §5.2) — conflicts
  with source-level `mock_playwright` annotations are entirely suppressed (not emitted as warning
  or info).

### Changed

- **`validate --format json`** output is now wrapped in `{ issues, e2eCoverage }` when
  `--include e2e-coverage` is specified. Without `--include e2e-coverage`, output remains a raw
  issues array (backward compatible).

## 0.5.0

### Added

- **Universal baseline policy**: `resolveArtifactContext` now injects 19 always-present baseline
  files (AGENTS.md, CLAUDE.md, artifact-chain-spec, blueprints, contracts, etc.) as required context
  by default. `scanArtifacts` stores a normalized absolute `root` on the graph so that
  `resolveArtifactContext` can fall back to `graph.root` when callers omit `opts.root`.
  - Default: `context.universal_baseline` is `true` (all baseline files injected and verified).
  - Explicit opt-out: set `context.universal_baseline: false` in `artifact-graph.config.yaml` to
    skip baseline injection entirely for lightweight or partial projects.
  - Config validation: `loadConfig` rejects non-boolean values (`0`, `""`, `"false"`, `1`, `"true"`)
    with an explicit error.
  - Fail-closed: when baseline is enabled but no project root is available, all 19 baseline items
    appear in `missingDetails` with kind `missing-baseline`; the manifest writes
    `baselinePolicy: true` so downstream packet validation cannot silently infer opt-out.
  - Readability gate: baseline file checks now verify both `stat.isFile()` and read permission
    (`access(R_OK)`), so unreadable files are reported in `missingDetails` rather than silently
    skipped.
- **`ArtifactGraph.root` field**: `ArtifactGraph` interface gains an optional `root?: string` field
  populated by `scanArtifacts` with the normalized absolute project root. Consumers that construct
  graph literals without this field remain backward-compatible.

### Fixed

- **CLI `--help`/`-h` safety for subcommands**: `artifact-graph hooks install-git --help/-h` and
  `artifact-graph version-lock --help/-h` now exit 0 and print usage without executing command
  side effects. Previously, `hooks install-git --help` would install hooks into the Git repository
  instead of showing help. This prevents accidental hook installation when users pass `--help` to
  verify CLI behavior. Regression tests verify that `--help`, `-h`, and positional `help` tokens
  do not create or modify Git hooks.
- **Review Result input hardening**: reject unknown top-level fields and attempts outside 1–3;
  require producer identity for successful PASS decisions; reject PASS decisions with open block
  findings; and reject repair self-acceptance using stable `executor + name` identity even when
  `skill` metadata differs. This tightens Review Result v1.0 consumption compatibility, including
  acceptance identity rules: migrate legacy top-level fields into protocol sections and run
  `artifact-graph validate-review-result --file <result.json> --format json` before consumption.
- **Canonical E2E code tag**: add `@e2e_test` as the canonical traceability tag; legacy `@tc`
  remains an alias and emits the `E2E-TRACE-007` deprecation warning from generic code-comment scans.
- **Traceability annotation false-positive fix**: reduce false positives in source/test traceability
  comment validation for custom artifact types registered via `artifact-graph.config.yaml`.
- **Pre-commit hook configuration detection**: improve pre-commit hook configuration detection to
  handle non-standard Git hook directory layouts and `core.hooksPath` overrides.

## 0.4.1

### Changed

- Version bump for dual-repo synchronization with `artifact-chain-assistant@0.4.1`. No runtime code changes in this package.

## 0.4.0

### Added

- Add project-neutral Review Result Protocol v1.0 schema, TypeScript types and validateReviewResult validator API.
- Add `validate-review-result --file <path>` with absolute-path support and JSON-path diagnostics.
- Include `schemas/review-result.schema.json` in the published package.

## 0.3.1

### Fixed

- **CLI help contract**: `artifact-graph --help`、`-h` 和 `help` now return exit code 0 and print usage to stdout, making `--help` a reliable install verification gate for public INSTALL instructions.
- **init creates missing directories**: `artifact-graph init --root <path>` now creates intermediate directories if they don't exist, matching the documented usage pattern.

## 0.3.0

### Added

- **Config-driven custom artifact types**: register any Markdown artifact type via `artifact-graph.config.yaml` with `paths`, `idPatterns`, `extraFields`, `target`, `role`, and `aliases`. Generic frontmatter parser handles all registered types without dedicated code.
- **Dynamic `--target` selector**: unified `--target <type>:<id>` for `context`, `packet`, `packet-prompt`, and audit commands; legacy `--feature`, `--scenario`, `--decision`, `--design`, `--e2e-test` flags remain compatible.
- **Extra fields indexing**: declare `extraFields` (string, number, boolean, enum) in config to index specific frontmatter fields for custom types.
- **`packet-prompt-audit --discover` mode**: automatically discovers all targets from artifact config and audits packet prompts without a targets file.
- **`CUSTOM_ARTIFACT_ISOLATED` validation**: warns when config-registered custom types have no traceability edges.
- **Java code traceability**: `isTestFile` classifier supports `*Test.java`/`*Tests.java` convention for Java projects.

### Changed

- Scenario-PRD validation (`--include scenario-prd-links`) is now opt-in via `validateScenarioPrdLinkIndex` instead of unconditionally executed.
- Expand `release-verifier` sub-agent to check CHANGELOG completeness and GitHub Release readiness.
- Document CHANGELOG format standard (Keep a Changelog style with category headings).
- Document version decision rules (semver based on CHANGELOG content).
- Add GitHub Releases creation step to publish workflow.
- Reference release-policy.md for version/CHANGELOG/GitHub Releases procedures in SKILL.md.

## 0.1.4

### Changed

- Publish `artifact-graph` as a standalone public package.
- Add version-lock refresh and audit workflows.
- Add Git hook installation support.
- Add package README, Chinese README, NOTICE, and Apache-2.0 license files.
