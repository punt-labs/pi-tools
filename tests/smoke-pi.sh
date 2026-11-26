#!/usr/bin/env bash
# Pi JSON print-mode smoke test for the keep extension.
# Requires: Node.js with type stripping, pi, tmux, and a configured model.
set -euo pipefail
exec node --experimental-strip-types "${BASH_SOURCE[0]%/*}/smoke-keep.ts" "$@"
