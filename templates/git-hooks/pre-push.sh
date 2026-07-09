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

artifact_graph version-lock audit --strict-missing-lock
