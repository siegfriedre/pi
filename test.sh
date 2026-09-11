#!/usr/bin/env bash
set -euo pipefail
DAAS_TEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DAAS_TEST_ROOT"
exec npm run test:daas -- "$@"
