# Changelog

## Unreleased

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
