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
npm install --save-dev github:mzdbxqh/artifact-graph
```

Or with pnpm:

```bash
pnpm add -D github:mzdbxqh/artifact-graph
```

After installation, verify the CLI is available:

```bash
# pnpm
pnpm exec artifact-graph --help

# npm
npx artifact-graph --help
```

### pnpm Native Build Allowlist

`artifact-graph` depends on `better-sqlite3`, which requires a native build. pnpm blocks postinstall
scripts by default; you must explicitly allow the build. The configuration key depends on your pnpm
version:

**pnpm 10.26+** — add `allowBuilds` to `pnpm-workspace.yaml` in your project root:

```yaml
# pnpm-workspace.yaml (pnpm 10.26+)
allowBuilds:
  better-sqlite3: true
```

**pnpm 10.0–10.25** — add `onlyBuiltDependencies` to your project `package.json`:

```jsonc
// package.json (pnpm 10.0–10.25)
{
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3"]
  }
}
```

Without the correct entry for your pnpm version, `pnpm install` may skip the native build and
`artifact-graph` will fail at runtime with a missing binding error.

## Quick Start

After installing as a dev dependency, use your package manager's exec to invoke the CLI. From your
project root:

```bash
# pnpm
pnpm exec artifact-graph init --root .
pnpm exec artifact-graph validate --root . --warning-only
pnpm exec artifact-graph version-lock refresh --all --format markdown
pnpm exec artifact-graph version-lock audit --root . --strict-missing-lock

# npm
npx artifact-graph init --root .
npx artifact-graph validate --root . --warning-only
npx artifact-graph version-lock refresh --all --format markdown
npx artifact-graph version-lock audit --root . --strict-missing-lock
```

> Use `version-lock refresh --all` for the initial lock. The `--changed-only --staged` variant is for
> pre-commit hooks on existing projects — not for first-time initialization.

## Smoke Test

Run these commands to confirm the installation is working:

```bash
# pnpm
pnpm exec artifact-graph --help
pnpm exec artifact-graph doctor --format markdown
pnpm exec artifact-graph validate --root . --warning-only

# npm
npx artifact-graph --help
npx artifact-graph doctor --format markdown
npx artifact-graph validate --root . --warning-only
```

If `artifact-graph doctor` cannot find the CLI or config, check that:

1. `artifact-graph` is in `./node_modules/.bin/` (run `pnpm exec artifact-graph --help` or
   `npx artifact-graph --help` to verify).
2. Your project has an `artifact-graph.config.yaml` (run `pnpm exec artifact-graph init --root .` or
   `npx artifact-graph init --root .` to create one).

## Universal Baseline Policy

Starting with 0.5.0, `artifact-graph context` and `artifact-graph packet` inject 19 always-present
baseline files (AGENTS.md, CLAUDE.md, artifact-chain-spec, blueprints, contracts, domain artifacts,
verification files, etc.) as required context by default. When any of these files is missing or
unreadable, the context manifest reports them in `missingDetails` and the command exits non-zero.

### Default behavior

```yaml
# artifact-graph.config.yaml
# context.universal_baseline defaults to true — no explicit entry needed
```

With the default, all baseline files are verified against the project root. If a file is missing,
is a directory, or is unreadable, it appears in the structured `missingDetails` with kind
`missing-baseline`.

### Explicit opt-out for lightweight projects

If your project does not contain all 19 baseline files (e.g., a partial migration or a standalone
library), explicitly disable baseline injection:

```yaml
# artifact-graph.config.yaml
context:
  universal_baseline: false
```

With `false`, `resolveArtifactContext` skips baseline injection entirely. No `baseline` category
appears in the context manifest, and the manifest writes `baselinePolicy: false` so that
packet validation (`validatePacket`) correctly allows `requiredBaseline.total=0`.

### Config validation

`loadConfig` rejects non-boolean values for `context.universal_baseline`:

| Value | Result |
|-------|--------|
| `true` | Baseline enabled |
| `false` | Baseline disabled |
| `undefined` | Defaults to `true` |
| `0`, `1` | **Error**: `Invalid context.universal_baseline` |
| `""`, `"false"`, `"true"` | **Error**: `Invalid context.universal_baseline` |

### Migration impact

- **Existing projects with all baseline files present**: no change in behavior. The default
  `true` policy was already implicit in 0.4.x context resolution.
- **Projects missing baseline files**: add `context.universal_baseline: false` to suppress
  baseline verification, or create the missing files. Without this, `context` and `packet`
  commands will exit non-zero with structured missing evidence.
- **Packet validation**: `validatePacket` (PKT-004) now requires an explicit `baselinePolicy`
  field to allow `requiredBaseline.total=0`. Packets without `baselinePolicy` and with
  `total=0, missing=[]` are rejected — this prevents silent opt-out inference.

## Related Project

Use [`artifact-chain-assistant`](https://github.com/mzdbxqh/artifact-chain-assistant) for Codex and
Claude Code skills that guide artifact-chain intake, setup, and maintenance.
