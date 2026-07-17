#!/bin/sh
set -u

artifact_graph() {
  if [ -x ./node_modules/.bin/artifact-graph ]; then
    ./node_modules/.bin/artifact-graph "$@"
    return $?
  fi
  if command -v artifact-graph >/dev/null 2>&1; then
    artifact-graph "$@"
    return $?
  fi
  if [ -n "${ARTIFACT_GRAPH_LEGACY_CLI:-}" ] && [ -f "$ARTIFACT_GRAPH_LEGACY_CLI" ]; then
    node "$ARTIFACT_GRAPH_LEGACY_CLI" "$@"
    return $?
  fi
  echo "artifact-chain-assistant: artifact-graph CLI not found; install it in the project or PATH." >&2
  return 127
}

# Detect if config or spec boundary files are staged
staged_files=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
config_staged=0
for f in $staged_files; do
  case "$f" in
    artifact-graph.config.yaml|*/artifact-graph.config.yaml)
      config_staged=1
      break
      ;;
  esac
done

if [ "$config_staged" -eq 1 ]; then
  artifact_graph version-lock refresh --all --format markdown || exit $?
else
  artifact_graph version-lock refresh --changed-only --staged --format markdown || exit $?
fi

if ! git diff --quiet -- artifacts/traceability-version-lock.json; then
  echo "artifact-chain-assistant: version lock changed during pre-commit." >&2
  echo "Please review and stage artifacts/traceability-version-lock.json, then commit again." >&2
  exit 1
fi
