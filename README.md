# Aqua Sort (Rust + WebAssembly)

A fluent, single-page water sort puzzle with a Rust game engine compiled to WebAssembly.

## Architecture

The project is split into three layers:

- Frontend UI controller: [`app.js`](app.js)
- WASM boundary adapter: [`engine/wasm/loader.js`](engine/wasm/loader.js)
- Core game + solver engine: [`engine/src/lib.rs`](engine/src/lib.rs)

Development server:

- Minimal Rust static server: [`tools/static-server/src/main.rs`](tools/static-server/src/main.rs)

UI assets:

- Page shell: [`index.html`](index.html)
- Styling (glass UI, responsive layout, themes): [`styles.css`](styles.css)

## Build

From `/Users/juni/Projects/water-sort`:

```bash
./scripts/build-wasm.sh
```

If needed, install the target once:

```bash
rustup target add wasm32-unknown-unknown
```

## Run

Serve the project root with any static server, then open the served URL.

Rust server:

```bash
./scripts/serve-rust.sh
```

Open `http://localhost:4173`.

## Quality Checks

Run from project root:

```bash
# Engine (native target)
cargo clippy --all-targets --all-features --manifest-path engine/Cargo.toml -- -D warnings
cargo test --manifest-path engine/Cargo.toml

# Engine (WASM target)
cargo clippy --target wasm32-unknown-unknown --all-features --manifest-path engine/Cargo.toml -- -D warnings

# Static dev server
cargo clippy --all-targets --all-features --manifest-path tools/static-server/Cargo.toml -- -D warnings
cargo test --manifest-path tools/static-server/Cargo.toml

# Formatting
cargo fmt --manifest-path engine/Cargo.toml
cargo fmt --manifest-path tools/static-server/Cargo.toml

# Frontend syntax checks
node --check app.js
node --check engine/wasm/loader.js
```

## Deployment

This app is a static website:

- commit the repository root contents to a branch served by GitHub Pages,
- ensure `engine/wasm/water_engine.wasm` is present in the deployed artifact,
- serve from the site root so relative paths like `./engine/wasm/water_engine.wasm` resolve correctly.

## Gameplay

- Click one tube, then another, to pour.
- You can only pour onto an empty tube or matching top color.
- Adjust `Bottles` (8-20), `Scramble` (24-220), and `Empty Tubes` (2-4), then start a new puzzle.
- On completion, the game shows `actual moves`, computed `ideal moves`, and an efficiency score.
- `Undo` reverts one move.
- `Restart` resets the current puzzle.
- Keyboard shortcuts: `U` undo, `R` restart, `N` new puzzle.

# About

Vibe-coded using Codex.
