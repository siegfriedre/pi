#!/usr/bin/env bash
set -euo pipefail
DAAS_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAAS_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    unset DEEPSEEK_API_KEY OPENAI_API_KEY
  else
    DAAS_ARGS+=("$arg")
  fi
done
exec "$DAAS_SCRIPT_DIR/node_modules/.bin/tsx" --tsconfig "$DAAS_SCRIPT_DIR/tsconfig.json" "$DAAS_SCRIPT_DIR/packages/coding-agent/src/cli.ts" "${DAAS_ARGS[@]}"
