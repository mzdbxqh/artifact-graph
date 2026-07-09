# artifact-graph

Git-native Markdown artifact graph scanner and validator.

`artifact-graph` scans project artifacts, source traceability comments, version-lock metadata, and
related test evidence so agentic coding workflows can load and verify the right context.

## Install

```bash
pnpm add -D artifact-graph
```

## Common Commands

```bash
artifact-graph init --root .
artifact-graph validate --root . --warning-only
artifact-graph version-lock refresh --changed-only --staged --format markdown
artifact-graph version-lock audit --root . --strict-missing-lock
```

## Git Hooks

After a project has a working `artifact-graph.config.yaml`, install opt-in Git hooks:

```bash
artifact-graph hooks install-git --hook all
```

## License

MIT
