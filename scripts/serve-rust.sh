#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-4173}"

cargo run \
  --manifest-path "$ROOT_DIR/tools/static-server/Cargo.toml" \
  -- \
  --root "$ROOT_DIR" \
  --host 127.0.0.1 \
  --port "$PORT"
