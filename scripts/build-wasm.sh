#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="wasm32-unknown-unknown"
PROFILE="release"

cargo build \
  --manifest-path "$ROOT_DIR/engine/Cargo.toml" \
  --target "$TARGET" \
  --profile "$PROFILE"

mkdir -p "$ROOT_DIR/engine/wasm"
cp \
  "$ROOT_DIR/engine/target/$TARGET/$PROFILE/water_engine.wasm" \
  "$ROOT_DIR/engine/wasm/water_engine.wasm"

echo "Built WASM: $ROOT_DIR/engine/wasm/water_engine.wasm"
