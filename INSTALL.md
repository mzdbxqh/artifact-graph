# artifact-graph Installation

## Prerequisites

- Node.js `>=22.0.0`.

## Install

### From npm

```bash
pnpm add -D artifact-graph
```

Or with npm:

```bash
npm install --save-dev artifact-graph
```

### From GitHub

```bash
npm install github:mzdbxqh/artifact-graph
```

Or with pnpm:

```bash
pnpm add -D github:mzdbxqh/artifact-graph
```

After installation, verify the CLI is available:

```bash
artifact-graph --help
```

### pnpm Native Build Allowlist

With pnpm 10+, the native `better-sqlite3` dependency must be allowed to build.
Add or update `pnpm-workspace.yaml` in your project root:

```yaml
allowBuilds:
  better-sqlite3: true
```

Without this entry, `pnpm install` may skip the native build and `artifact-graph` will fail at
runtime.

## Quick Start

From your project root:

```bash
artifact-graph init --root .
artifact-graph validate --root . --warning-only
artifact-graph version-lock refresh --changed-only --staged --format markdown
artifact-graph version-lock audit --root . --strict-missing-lock
```

## Smoke Test

Run these commands to confirm the installation is working:

```bash
artifact-graph --help
artifact-graph doctor --format markdown
artifact-graph validate --root . --warning-only
```

If `artifact-graph doctor` cannot find the CLI or config, check that:

1. `artifact-graph` is in `PATH` or `./node_modules/.bin/`.
2. Your project has an `artifact-graph.config.yaml` (run `artifact-graph init --root .` to create one).

## Related Project

Use [`artifact-chain-assistant`](https://github.com/mzdbxqh/artifact-chain-assistant) for Codex and
Claude Code skills that guide artifact-chain intake, setup, and maintenance.
