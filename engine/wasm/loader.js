// Thin JavaScript adapter over the Rust/WASM exports.
// Keeps all numeric boundary conversions in one place so app.js can stay
// focused on gameplay/UI state.

let wasm = null;

const DEFAULT_WASM_PATH = "./engine/wasm/water_engine.wasm";
export const STALL_STATUS = Object.freeze({
  NONE: 0,
  NO_LEGAL_MOVES: 1,
  FORCED_LOOP: 2,
});
export const MOVE_REASON = Object.freeze({
  NONE: 0,
  SAME_TUBE: 1,
  SOURCE_EMPTY: 2,
  DEST_UNAVAILABLE: 3,
  DEST_FULL: 4,
  COLOR_MISMATCH: 5,
  NOT_ALLOWED: 6,
});

function ensureReady() {
  if (!wasm) {
    throw new Error("WASM engine is not initialized.");
  }
}

// Loads and instantiates the WASM module once per page session.
export async function initEngine(wasmPath = DEFAULT_WASM_PATH) {
  if (wasm) {
    return;
  }
  const response = await fetch(wasmPath);
  if (!response.ok) {
    throw new Error(`Failed to load WASM engine (${response.status}).`);
  }
  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  wasm = instance.exports;
}

// Allocates a game in Rust and returns an opaque handle.
export function createGame(totalTubes, emptyTubes, scramble, seed) {
  ensureReady();
  return wasm.create_game(totalTubes >>> 0, emptyTubes >>> 0, scramble >>> 0, BigInt(seed));
}

// Releases a previously allocated game handle.
export function freeGame(handle) {
  ensureReady();
  wasm.free_game(handle >>> 0);
}

export function tubeCount(handle) {
  ensureReady();
  return wasm.game_tube_count(handle >>> 0) >>> 0;
}

export function colorCount(handle) {
  ensureReady();
  return wasm.game_color_count(handle >>> 0) >>> 0;
}

export function tubeLen(handle, tubeIndex) {
  ensureReady();
  return wasm.game_tube_len(handle >>> 0, tubeIndex >>> 0) >>> 0;
}

export function tubeColor(handle, tubeIndex, level) {
  ensureReady();
  return wasm.game_tube_color(handle >>> 0, tubeIndex >>> 0, level >>> 0);
}

export function canPour(handle, from, to) {
  ensureReady();
  return (wasm.game_can_pour(handle >>> 0, from >>> 0, to >>> 0) >>> 0) === 1;
}

// Returns an enum code that explains why a move is invalid.
export function invalidMoveReasonCode(handle, from, to) {
  ensureReady();
  return wasm.game_invalid_move_reason(handle >>> 0, from >>> 0, to >>> 0) >>> 0;
}

// Returns dead-end / forced-loop status for the current board.
export function stallStatus(handle, moveLimit) {
  ensureReady();
  return wasm.game_stall_status(handle >>> 0, moveLimit >>> 0) >>> 0;
}

export function pour(handle, from, to) {
  ensureReady();
  return wasm.game_pour(handle >>> 0, from >>> 0, to >>> 0) >>> 0;
}

export function undo(handle) {
  ensureReady();
  return (wasm.game_undo(handle >>> 0) >>> 0) === 1;
}

export function restart(handle) {
  ensureReady();
  wasm.game_restart(handle >>> 0);
}

export function isSolved(handle) {
  ensureReady();
  return (wasm.game_is_solved(handle >>> 0) >>> 0) === 1;
}

export function solvedTubeCount(handle) {
  ensureReady();
  return wasm.game_solved_tube_count(handle >>> 0) >>> 0;
}

export function moveCount(handle) {
  ensureReady();
  return wasm.game_move_count(handle >>> 0) >>> 0;
}

export function idealMoves(handle) {
  ensureReady();
  return wasm.game_ideal_moves(handle >>> 0) >>> 0;
}

export function idealIsExact(handle) {
  ensureReady();
  return (wasm.game_ideal_is_exact(handle >>> 0) >>> 0) === 1;
}
