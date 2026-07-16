# artifact-graph

[中文](README.zh-CN.md)

Git-native Markdown artifact graph scanner and validator for agentic coding workflows.

`artifact-graph` helps projects keep requirements, scenarios, design notes, source files, tests,
and version-lock metadata connected. It is designed for deterministic local use before an AI coding
agent claims implementation work is complete.

## Install

```bash
pnpm add -D artifact-graph
```

Or install from GitHub:

```bash
npm install github:mzdbxqh/artifact-graph
```

Node.js `>=22.0.0` is required. For pnpm 10+, see [INSTALL.md](INSTALL.md) for the native build
allowlist setup.

## Quick Start

```bash
artifact-graph init --root .
artifact-graph validate --root . --warning-only
artifact-graph version-lock refresh --changed-only --staged --format markdown
artifact-graph version-lock audit --root . --strict-missing-lock
```

## Common Workflows

- Generate or inspect project artifact graph configuration with `artifact-graph init`.
- Validate artifact links with `artifact-graph validate`.
- Validate Review Result Protocol v1.0 documents with `artifact-graph validate-review-result --file <path>`.
- Build implementation context with `artifact-graph context` or `artifact-graph packet`.
- Keep traceability freshness with `artifact-graph version-lock refresh` and `audit`.
- Install opt-in Git hooks with `artifact-graph hooks install-git --hook all`.

## Review Result Protocol

The package publishes `schemas/review-result.schema.json` and a matching TypeScript types + validateReviewResult validator API.
The protocol is project-neutral and supports review, repair, batch evidence, findings, metrics, and
fail-closed decisions. Invalid fields are reported with stable JSON paths.

## Related Project

Use [`artifact-chain-assistant`](https://github.com/mzdbxqh/artifact-chain-assistant) for Codex and
Claude Code skills that guide artifact-chain intake, setup, and maintenance.

## License

Apache-2.0. See [LICENSE](LICENSE).
