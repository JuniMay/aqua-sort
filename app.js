// Aqua Sort front-end controller.
// Responsibilities:
// - wire UI controls to Rust/WASM engine calls,
// - render tubes and game status,
// - manage guide visibility, theme mode, and score presentation.

import {
  initEngine,
  createGame,
  freeGame,
  tubeCount,
  colorCount,
  tubeLen,
  tubeColor,
  canPour,
  pour,
  undo,
  restart,
  isSolved,
  solvedTubeCount,
  moveCount,
  idealMoves,
  idealIsExact,
} from "./engine/wasm/loader.js";

const COLOR_CACHE = new Map();
const rootEl = document.documentElement;

const boardEl = document.getElementById("board");
const bottleCountEl = document.getElementById("bottle-count");
const bottleCountValueEl = document.getElementById("bottle-count-value");
const scrambleEl = document.getElementById("scramble");
const scrambleValueEl = document.getElementById("scramble-value");
const emptyTubesEl = document.getElementById("empty-tubes");
const newGameBtn = document.getElementById("new-game");
const restartBtn = document.getElementById("restart");
const undoBtn = document.getElementById("undo");
const showGuideBtn = document.getElementById("show-guide");
const shareInitialBtn = document.getElementById("share-initial");
const shareCurrentBtn = document.getElementById("share-current");
const toggleSharedViewBtn = document.getElementById("toggle-shared-view");
const statusTextEl = document.getElementById("status-text");
const scoreLineEl = document.getElementById("score-line");
const movesEl = document.getElementById("moves");
const progressEl = document.getElementById("progress");
const toastEl = document.getElementById("toast");
const guideOverlayEl = document.getElementById("guide-overlay");
const guideCloseBtn = document.getElementById("guide-close");
const guideHideNextEl = document.getElementById("guide-hide-next");
const themeToggleBtn = document.getElementById("theme-toggle");

const GUIDE_STORAGE_KEY = "aqua_sort_intro_hidden_v1";
const THEME_STORAGE_KEY = "aqua_sort_theme_v1";
const THEME_MODE_CYCLE = ["auto", "dark", "light"];
const SHARE_VERSION = "1";
const MOVE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const TUBE_CAPACITY = 4;
const BOTTLE_MIN = 8;
const BOTTLE_MAX = 20;
const BOTTLE_DEFAULT = 16;
const EMPTY_MIN = 2;
const EMPTY_MAX = 4;
const EMPTY_DEFAULT = 2;
const SCRAMBLE_DEFAULT = 110;
const SCRAMBLE_MIN = 24;
const SCRAMBLE_MAX = 220;
const IDEAL_COMPUTE_DELAY_MS = 20;
const TOAST_DURATION_MS = 1600;
const SHAKE_DURATION_MS = 300;
const SHAKE_CLEAR_DELAY_MS = 320;
const LAST_MOVE_HIGHLIGHT_MS = 360;
const GUIDE_AUTO_OPEN_DELAY_MS = 120;
const SEGMENT_HEIGHT_PERCENT = 25;
const BOARD_DENSITY_COMPACT_THRESHOLD = 14;
const BOARD_DENSITY_TIGHT_THRESHOLD = 18;
const FORCED_LOOP_SCAN_MOVE_LIMIT = 20;
const DISTINCT_BASE_COLORS = [
  [205, 64, 55],
  [30, 58, 56],
  [282, 47, 58],
  [165, 55, 46],
  [48, 66, 52],
  [336, 50, 57],
  [232, 56, 60],
  [12, 52, 54],
  [142, 42, 49],
  [258, 46, 52],
  [191, 54, 52],
  [76, 50, 50],
  [304, 40, 58],
  [219, 46, 48],
  [24, 46, 50],
  [156, 38, 56],
  [348, 44, 55],
  [90, 38, 47],
  [272, 42, 46],
  [201, 40, 61],
  [60, 46, 56],
  [324, 38, 50],
  [128, 35, 52],
  [16, 40, 48],
];

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function defaultIdealState() {
  return {
    loading: false,
    value: null,
    exact: false,
  };
}

// Runtime state shared across UI handlers and render passes.
const game = {
  handle: null,
  bottleCount: parseInteger(bottleCountEl.value, BOTTLE_DEFAULT),
  scramble: parseInteger(scrambleEl.value, SCRAMBLE_DEFAULT),
  emptyTubes: parseInteger(emptyTubesEl.value, EMPTY_DEFAULT),
  activeBottleCount: parseInteger(bottleCountEl.value, BOTTLE_DEFAULT),
  activeScramble: parseInteger(scrambleEl.value, SCRAMBLE_DEFAULT),
  activeEmptyTubes: parseInteger(emptyTubesEl.value, EMPTY_DEFAULT),
  seed: null,
  moveTrail: [],
  selectedTube: null,
  won: false,
  lastMove: null,
  shakeUntil: new Map(),
  clearLastMoveTimer: null,
  toastTimer: null,
  ready: false,
  ideal: defaultIdealState(),
  finish: null,
  scoreToken: 0,
  sharedReplay: null,
  sharedView: "current",
  stallCheck: {
    key: "",
    forcedLoop: false,
  },
};

function resetInteractionState() {
  game.selectedTube = null;
  game.won = false;
  game.lastMove = null;
  game.finish = null;
  game.stallCheck = { key: "", forcedLoop: false };
}

// --- Guide modal persistence ---

function randomSeed() {
  return Date.now() * 1000 + Math.floor(Math.random() * 997);
}

function shouldAutoShowGuide() {
  try {
    return localStorage.getItem(GUIDE_STORAGE_KEY) !== "1";
  } catch {
    return true;
  }
}

function setAutoShowGuide(enabled) {
  try {
    if (enabled) {
      localStorage.removeItem(GUIDE_STORAGE_KEY);
    } else {
      localStorage.setItem(GUIDE_STORAGE_KEY, "1");
    }
  } catch {
    // Ignore persistence errors (private mode or blocked storage).
  }
}

function isGuideOpen() {
  return guideOverlayEl.classList.contains("show");
}

function openGuide() {
  guideHideNextEl.checked = !shouldAutoShowGuide();
  guideOverlayEl.classList.add("show");
  guideOverlayEl.setAttribute("aria-hidden", "false");
}

function closeGuide() {
  setAutoShowGuide(!guideHideNextEl.checked);
  guideOverlayEl.classList.remove("show");
  guideOverlayEl.setAttribute("aria-hidden", "true");
}

// --- Theme mode handling (Auto/Dark/Light) ---

function normalizeThemeMode(mode) {
  return mode === "light" || mode === "dark" || mode === "auto" ? mode : "auto";
}

function readStoredThemeMode() {
  try {
    return normalizeThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // Ignore storage read failures.
    return "auto";
  }
}

function writeStoredThemeMode(mode) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Ignore storage write failures.
  }
}

function systemThemePreference() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolvedTheme(mode) {
  return mode === "auto" ? systemThemePreference() : mode;
}

function applyThemeMode(mode, persist = true) {
  const normalizedMode = normalizeThemeMode(mode);
  const activeTheme = resolvedTheme(normalizedMode);
  rootEl.dataset.themeMode = normalizedMode;
  rootEl.dataset.theme = activeTheme;
  themeToggleBtn.textContent =
    normalizedMode === "auto" ? "Theme: Auto" : normalizedMode === "dark" ? "Theme: Dark" : "Theme: Light";
  themeToggleBtn.setAttribute(
    "aria-label",
    normalizedMode === "auto"
      ? "Theme mode is Auto. Click to switch to Dark."
      : normalizedMode === "dark"
        ? "Theme mode is Dark. Click to switch to Light."
        : "Theme mode is Light. Click to switch to Auto.",
  );
  themeToggleBtn.title = "Cycle theme mode: Auto, Dark, Light";
  if (persist) {
    writeStoredThemeMode(normalizedMode);
  }
  COLOR_CACHE.clear();
  if (game.ready) {
    render();
  }
}

function cycleThemeMode() {
  const currentMode = normalizeThemeMode(rootEl.dataset.themeMode);
  const currentIndex = THEME_MODE_CYCLE.indexOf(currentMode);
  const nextMode = THEME_MODE_CYCLE[(currentIndex + 1) % THEME_MODE_CYCLE.length];
  applyThemeMode(nextMode);
}

function initTheme() {
  applyThemeMode(readStoredThemeMode(), false);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const handleSystemThemeChange = () => {
    if (normalizeThemeMode(rootEl.dataset.themeMode) !== "auto") {
      return;
    }
    applyThemeMode("auto", false);
  };
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", handleSystemThemeChange);
  } else {
    media.addListener(handleSystemThemeChange);
  }
}

// --- Color palette generation ---

function colorForIndex(index) {
  const activeTheme = rootEl.dataset.theme === "dark" ? "dark" : "light";
  const cacheKey = `${activeTheme}:${index}`;
  if (COLOR_CACHE.has(cacheKey)) {
    return COLOR_CACHE.get(cacheKey);
  }

  // Prefer a curated palette so neighboring colors remain highly distinguishable.
  let [hue, saturation, lightness] =
    DISTINCT_BASE_COLORS[index % DISTINCT_BASE_COLORS.length];

  // For out-of-range IDs (custom engine configs), derive extra colors with a
  // hue jump and slight S/L drift to keep them separated from base entries.
  if (index >= DISTINCT_BASE_COLORS.length) {
    const cycle = Math.floor(index / DISTINCT_BASE_COLORS.length);
    hue = Math.round((hue + cycle * 23) % 360);
    saturation = Math.max(34, Math.min(68, saturation + (cycle % 2 === 0 ? -6 : 4)));
    lightness = Math.max(44, Math.min(64, lightness + (cycle % 3) * 3 - 3));
  }

  if (activeTheme === "dark") {
    // Dark mode keeps contrast while dimming overall intensity.
    const darkLift = [-2, 2, 5, 0][index % 4];
    saturation = Math.max(34, Math.min(66, saturation - 12));
    lightness = Math.max(34, Math.min(58, lightness - 12 + darkLift));
  }

  const color = `hsl(${hue} ${saturation}% ${lightness}%)`;
  COLOR_CACHE.set(cacheKey, color);
  return color;
}

// --- Scoring and ideal move reporting ---

function normalizedScrambleValue(value) {
  const number = Number.parseInt(String(value), 10);
  if (Number.isNaN(number)) {
    return SCRAMBLE_DEFAULT;
  }
  return Math.max(SCRAMBLE_MIN, Math.min(SCRAMBLE_MAX, number));
}

function efficiencyGrade(percent) {
  if (percent >= 98) {
    return "S";
  }
  if (percent >= 90) {
    return "A";
  }
  if (percent >= 80) {
    return "B";
  }
  if (percent >= 68) {
    return "C";
  }
  return "D";
}

function solvedToastSummary(finish) {
  const label = finish.exact ? "ideal" : "best known";
  return `Solved: ${finish.actual} moves (${label} ${finish.ideal}, ${finish.percent}% efficiency).`;
}

function refreshFinishScore() {
  if (!game.won || game.handle === null) {
    return;
  }
  const actual = moveCount(game.handle);
  if (game.ideal.loading || game.ideal.value === null) {
    game.finish = {
      pending: true,
      actual,
    };
    return;
  }
  const ideal = game.ideal.value;
  const percent = ideal === 0 ? 100 : Math.round((ideal / Math.max(actual, ideal)) * 100);
  game.finish = {
    pending: false,
    actual,
    ideal,
    exact: game.ideal.exact,
    percent,
    grade: efficiencyGrade(percent),
  };
}

// Computes ideal moves asynchronously so UI interactions remain smooth.
function computeIdealMovesForPuzzle() {
  if (game.handle === null) {
    return;
  }
  const token = game.scoreToken + 1;
  game.scoreToken = token;
  game.ideal = {
    ...defaultIdealState(),
    loading: true,
  };
  render();

  window.setTimeout(() => {
    if (game.handle === null || game.scoreToken !== token) {
      return;
    }
    const value = idealMoves(game.handle);
    const exact = idealIsExact(game.handle);
    game.ideal = {
      loading: false,
      value,
      exact,
    };

    if (game.won) {
      const wasPending = game.finish && game.finish.pending;
      refreshFinishScore();
      if (wasPending && game.finish && !game.finish.pending) {
        showToast(solvedToastSummary(game.finish));
      }
    }
    render();
  }, IDEAL_COMPUTE_DELAY_MS);
}

// --- Board projection and move validation helpers ---

function readBoardState() {
  if (game.handle === null) {
    return [];
  }
  const total = tubeCount(game.handle);
  const board = [];
  for (let tubeIndex = 0; tubeIndex < total; tubeIndex += 1) {
    const len = tubeLen(game.handle, tubeIndex);
    const tube = [];
    for (let level = 0; level < len; level += 1) {
      const color = tubeColor(game.handle, tubeIndex, level);
      if (color >= 0) {
        tube.push(color);
      }
    }
    board.push(tube);
  }
  return board;
}

function topColor(tube) {
  return tube.length > 0 ? tube[tube.length - 1] : null;
}

function boardStateKey(board) {
  return board.map((tube) => tube.join(",")).join("|");
}

function clampBottleCount(value) {
  return Math.max(BOTTLE_MIN, Math.min(BOTTLE_MAX, value));
}

function clampEmptyTubes(value, bottleCount) {
  return Math.max(EMPTY_MIN, Math.min(EMPTY_MAX, Math.min(value, bottleCount - 2)));
}

function encodeMoveTrail(moves) {
  let out = "";
  for (const move of moves) {
    const from = move.from >>> 0;
    const to = move.to >>> 0;
    const packed = ((from & 31) << 5) | (to & 31);
    out += MOVE_ALPHABET[(packed >> 6) & 63];
    out += MOVE_ALPHABET[packed & 63];
  }
  return out;
}

function decodeMoveTrail(encoded) {
  if (!encoded || encoded.length === 0) {
    return [];
  }
  if (encoded.length % 2 !== 0) {
    return null;
  }
  const moves = [];
  for (let i = 0; i < encoded.length; i += 2) {
    const hi = MOVE_ALPHABET.indexOf(encoded[i]);
    const lo = MOVE_ALPHABET.indexOf(encoded[i + 1]);
    if (hi < 0 || lo < 0) {
      return null;
    }
    const packed = (hi << 6) | lo;
    moves.push({
      from: (packed >> 5) & 31,
      to: packed & 31,
    });
  }
  return moves;
}

function normalizeSharePayload(raw) {
  if (!raw) {
    return null;
  }
  const type = raw.type === "current" ? "current" : "initial";
  const bottleCount = clampBottleCount(parseInteger(raw.bottleCount, BOTTLE_DEFAULT));
  const scramble = normalizedScrambleValue(raw.scramble);
  const emptyTubes = clampEmptyTubes(parseInteger(raw.emptyTubes, EMPTY_DEFAULT), bottleCount);
  const seed = parseInteger(raw.seed, 0);
  if (!Number.isFinite(seed) || seed <= 0) {
    return null;
  }
  return {
    type,
    bottleCount,
    scramble,
    emptyTubes,
    seed,
    moves: Array.isArray(raw.moves) ? raw.moves : [],
  };
}

function parseShareFromUrl() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("ws") !== SHARE_VERSION) {
    return null;
  }
  const mode = params.get("t");
  if (mode !== "i" && mode !== "c") {
    return null;
  }
  const decodedMoves = mode === "c" ? decodeMoveTrail(params.get("mv") || "") : [];
  if (mode === "c" && decodedMoves === null) {
    return null;
  }
  const payload = normalizeSharePayload({
      type: mode === "c" ? "current" : "initial",
      bottleCount: parseInteger(params.get("b"), BOTTLE_DEFAULT),
      emptyTubes: parseInteger(params.get("e"), EMPTY_DEFAULT),
      scramble: parseInteger(params.get("sc"), SCRAMBLE_DEFAULT),
      seed: Number.parseInt(params.get("sd") || "", 10),
      moves: decodedMoves,
    });
  if (!payload) {
    return null;
  }
  return payload;
}

function applyPuzzleSettings(settings) {
  const bottleCount = clampBottleCount(parseInteger(settings.bottleCount, BOTTLE_DEFAULT));
  game.bottleCount = bottleCount;
  bottleCountEl.value = String(bottleCount);

  game.scramble = normalizedScrambleValue(settings.scramble);
  scrambleEl.value = String(game.scramble);

  game.emptyTubes = clampEmptyTubes(parseInteger(settings.emptyTubes, EMPTY_DEFAULT), bottleCount);
  emptyTubesEl.value = String(game.emptyTubes);

  normalizeEmptyTubes();
  updateBottleCountLabel();
  updateScrambleLabel();
}

function buildShareUrl(type) {
  if (game.handle === null || game.seed === null) {
    return null;
  }
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("ws", SHARE_VERSION);
  url.searchParams.set("t", type === "current" ? "c" : "i");
  url.searchParams.set("b", String(game.activeBottleCount));
  url.searchParams.set("e", String(game.activeEmptyTubes));
  url.searchParams.set("sc", String(game.activeScramble));
  url.searchParams.set("sd", String(game.seed));
  if (type === "current") {
    url.searchParams.set("mv", encodeMoveTrail(game.moveTrail));
  }
  return url.toString();
}

async function copyShareLink(type) {
  const url = buildShareUrl(type);
  if (!url) {
    showToast("No puzzle to share yet.");
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast(type === "current" ? "Current-state link copied." : "Initial-state link copied.");
  } catch {
    window.prompt("Copy share link:", url);
  }
}

function updateSharedViewButton() {
  if (!game.sharedReplay) {
    toggleSharedViewBtn.hidden = true;
    return;
  }
  toggleSharedViewBtn.hidden = false;
  if (game.sharedView === "current") {
    toggleSharedViewBtn.textContent = "View Initial";
  } else {
    toggleSharedViewBtn.textContent = "View Shared Current";
  }
}

function restoreSharedCurrent(moves, options = {}) {
  const warnOnPartial = options.warnOnPartial !== false;
  const total = tubeCount(game.handle);
  let applied = 0;
  for (const move of moves) {
    if (
      !move ||
      move.from < 0 ||
      move.to < 0 ||
      move.from >= total ||
      move.to >= total ||
      move.from === move.to
    ) {
      break;
    }
    if (!canPour(game.handle, move.from, move.to)) {
      break;
    }
    const moved = pour(game.handle, move.from, move.to);
    if (moved <= 0) {
      break;
    }
    game.moveTrail.push({ from: move.from, to: move.to });
    applied += 1;
  }
  if (warnOnPartial && applied !== moves.length) {
    showToast("Share link restored partially: some moves are invalid.");
  }
  resetInteractionState();
}

function toggleSharedView() {
  if (game.handle === null || !game.sharedReplay) {
    return;
  }

  restart(game.handle);
  resetInteractionState();
  game.moveTrail = [];

  if (game.sharedView === "current") {
    game.sharedView = "initial";
    updateSharedViewButton();
    render();
    showToast("Showing shared initial state.");
    return;
  }

  restoreSharedCurrent(game.sharedReplay.moves, { warnOnPartial: false });
  game.sharedView = "current";
  updateSharedViewButton();
  checkWin();
  render();
  showToast("Showing shared current state.");
}

function canPourBoard(board, from, to) {
  if (from === to || from < 0 || to < 0 || from >= board.length || to >= board.length) {
    return false;
  }
  const source = board[from];
  const destination = board[to];
  if (!source || source.length === 0 || !destination || destination.length >= TUBE_CAPACITY) {
    return false;
  }
  if (destination.length === 0) {
    return true;
  }
  return source[source.length - 1] === destination[destination.length - 1];
}

function topRunLength(tube) {
  if (!tube || tube.length === 0) {
    return 0;
  }
  const top = tube[tube.length - 1];
  let run = 0;
  for (let i = tube.length - 1; i >= 0; i -= 1) {
    if (tube[i] !== top) {
      break;
    }
    run += 1;
  }
  return run;
}

function applyBoardMove(board, from, to) {
  const next = board.map((tube) => tube.slice());
  if (!canPourBoard(next, from, to)) {
    return next;
  }
  const source = next[from];
  const destination = next[to];
  const amount = Math.min(topRunLength(source), TUBE_CAPACITY - destination.length);
  if (amount <= 0) {
    return next;
  }
  const moved = source.splice(source.length - amount, amount);
  destination.push(...moved);
  return next;
}

function legalMovesForBoard(board) {
  const moves = [];
  for (let from = 0; from < board.length; from += 1) {
    for (let to = 0; to < board.length; to += 1) {
      if (canPourBoard(board, from, to)) {
        moves.push([from, to]);
      }
    }
  }
  return moves;
}

function isForcedMoveLoop(board, precomputedMoves = null) {
  const key = boardStateKey(board);
  if (game.stallCheck.key === key) {
    return game.stallCheck.forcedLoop;
  }

  const moves = precomputedMoves || legalMovesForBoard(board);
  if (moves.length === 0 || moves.length > FORCED_LOOP_SCAN_MOVE_LIMIT) {
    game.stallCheck = { key, forcedLoop: false };
    return false;
  }

  for (const [from, to] of moves) {
    const next = applyBoardMove(board, from, to);
    const nextMoves = legalMovesForBoard(next);
    if (nextMoves.length === 0) {
      game.stallCheck = { key, forcedLoop: false };
      return false;
    }

    let hasEscape = false;
    for (const [nextFrom, nextTo] of nextMoves) {
      const after = applyBoardMove(next, nextFrom, nextTo);
      if (boardStateKey(after) !== key) {
        hasEscape = true;
        break;
      }
    }

    if (hasEscape) {
      game.stallCheck = { key, forcedLoop: false };
      return false;
    }
  }

  game.stallCheck = { key, forcedLoop: true };
  return true;
}

function invalidMoveReason(from, to, board) {
  if (from === to) {
    return "Pick a different tube.";
  }
  const source = board[from];
  const destination = board[to];
  if (!source || source.length === 0) {
    return "That tube is empty.";
  }
  if (!destination) {
    return "That tube is unavailable.";
  }
  if (destination.length >= TUBE_CAPACITY) {
    return "The destination tube is full.";
  }
  if (destination.length > 0 && topColor(destination) !== topColor(source)) {
    return "You can only pour onto the same color or an empty tube.";
  }
  return "That move is not allowed.";
}

// --- UI feedback / micro-interactions ---

function showToast(message) {
  if (game.toastTimer) {
    window.clearTimeout(game.toastTimer);
  }
  toastEl.textContent = message;
  toastEl.classList.add("show");
  game.toastTimer = window.setTimeout(() => {
    toastEl.classList.remove("show");
  }, TOAST_DURATION_MS);
}

function clearShake(index) {
  if (game.shakeUntil.has(index)) {
    game.shakeUntil.delete(index);
    render();
  }
}

function triggerShake(index) {
  game.shakeUntil.set(index, Date.now() + SHAKE_DURATION_MS);
  render();
  window.setTimeout(() => clearShake(index), SHAKE_CLEAR_DELAY_MS);
}

// --- Rendering ---

function updateBottleCountLabel() {
  bottleCountValueEl.textContent = String(game.bottleCount);
}

function updateScrambleLabel() {
  scrambleValueEl.textContent = String(game.scramble);
}

function normalizeEmptyTubes() {
  const maxAllowed = Math.min(EMPTY_MAX, Math.max(EMPTY_MIN, game.bottleCount - 2));
  if (game.emptyTubes > maxAllowed) {
    game.emptyTubes = maxAllowed;
    emptyTubesEl.value = String(maxAllowed);
  }
  for (const option of emptyTubesEl.options) {
    option.disabled = Number.parseInt(option.value, 10) > maxAllowed;
  }
}

function setScoreLine(text = "") {
  scoreLineEl.textContent = text;
  scoreLineEl.classList.toggle("visible", text.length > 0);
}

function updateStatusText(board) {
  if (game.handle === null) {
    statusTextEl.textContent = "Loading engine...";
    setScoreLine();
    progressEl.textContent = "0 / 0";
    movesEl.textContent = "0";
    return;
  }

  const solved = solvedTubeCount(game.handle);
  const totalColors = colorCount(game.handle);
  progressEl.textContent = `${solved} / ${totalColors}`;
  movesEl.textContent = String(moveCount(game.handle));

  if (game.won) {
    const actual = moveCount(game.handle);
    if (!game.finish || game.finish.pending) {
      statusTextEl.textContent = `Solved in ${actual} moves. Computing ideal moves...`;
      setScoreLine("Analyzing optimal path...");
      return;
    }
    const idealLabel = game.finish.exact ? "Ideal" : "Best known";
    statusTextEl.textContent = `Solved in ${actual} moves.`;
    setScoreLine(
      `${idealLabel}: ${game.finish.ideal} | Efficiency: ${game.finish.percent}% (${game.finish.grade})`,
    );
    return;
  }

  if (game.ideal.loading) {
    setScoreLine("Ideal: analyzing...");
  } else if (game.ideal.value !== null) {
    const label = game.ideal.exact ? "Ideal" : "Best known";
    setScoreLine(`${label}: ${game.ideal.value} moves`);
  } else {
    setScoreLine();
  }

  const legalMoves = legalMovesForBoard(board);
  if (legalMoves.length === 0) {
    game.selectedTube = null;
    statusTextEl.textContent = "No legal moves left in this state. Undo or Restart.";
    return;
  }

  if (isForcedMoveLoop(board, legalMoves)) {
    game.selectedTube = null;
    statusTextEl.textContent = "This state is stuck in a move loop. Undo a few moves or Restart.";
    return;
  }

  if (game.selectedTube === null) {
    statusTextEl.textContent = "Pick a tube to begin.";
    return;
  }

  const selected = board[game.selectedTube];
  if (!selected || selected.length === 0) {
    game.selectedTube = null;
    statusTextEl.textContent = "Pick a tube to begin.";
    return;
  }
  statusTextEl.textContent = "Now pick a destination tube.";
}

function tubeClasses(index) {
  const classes = ["tube"];
  if (game.selectedTube === index) {
    classes.push("selected");
  }
  if (
    game.selectedTube !== null &&
    game.selectedTube !== index &&
    game.handle !== null &&
    canPour(game.handle, game.selectedTube, index)
  ) {
    classes.push("candidate");
  }
  if (game.lastMove) {
    if (game.lastMove.from === index) {
      classes.push("pour-from");
    }
    if (game.lastMove.to === index) {
      classes.push("pour-to");
    }
  }
  if (game.shakeUntil.has(index) && game.shakeUntil.get(index) > Date.now()) {
    classes.push("shake");
  }
  return classes.join(" ");
}

function renderBoard(board) {
  if (board.length >= BOARD_DENSITY_TIGHT_THRESHOLD) {
    boardEl.dataset.density = "tight";
  } else if (board.length >= BOARD_DENSITY_COMPACT_THRESHOLD) {
    boardEl.dataset.density = "compact";
  } else {
    boardEl.dataset.density = "normal";
  }

  boardEl.innerHTML = "";
  board.forEach((tube, index) => {
    const tubeButton = document.createElement("button");
    tubeButton.type = "button";
    tubeButton.className = tubeClasses(index);
    tubeButton.ariaLabel = `Tube ${index + 1}, ${tube.length} layers`;
    tubeButton.addEventListener("click", () => handleTubeClick(index));

    const glass = document.createElement("div");
    glass.className = "glass";
    const liquidStack = document.createElement("div");
    liquidStack.className = "liquid-stack";

    tube.forEach((color, layerIndex) => {
      const layer = document.createElement("div");
      const showToken = layerIndex === tube.length - 1 || tube[layerIndex + 1] !== color;
      const classes = ["segment"];
      if (layerIndex > 0) {
        classes.push("has-divider");
      }
      layer.className = classes.join(" ");
      layer.style.setProperty("--segment-color", colorForIndex(color));
      layer.style.bottom = `${layerIndex * SEGMENT_HEIGHT_PERCENT}%`;
      if (showToken) {
        const token = document.createElement("span");
        token.className = "segment-token";
        token.textContent = String(color + 1);
        layer.appendChild(token);
      }
      liquidStack.appendChild(layer);
    });

    glass.appendChild(liquidStack);
    tubeButton.appendChild(glass);
    boardEl.appendChild(tubeButton);
  });
}

function finishLastMoveAnimation() {
  if (game.clearLastMoveTimer) {
    window.clearTimeout(game.clearLastMoveTimer);
  }
  game.clearLastMoveTimer = window.setTimeout(() => {
    game.lastMove = null;
    render();
  }, LAST_MOVE_HIGHLIGHT_MS);
}

function render() {
  const board = readBoardState();
  updateStatusText(board);
  renderBoard(board);
  undoBtn.disabled = game.handle === null || moveCount(game.handle) === 0;
  restartBtn.disabled = game.handle === null;
  shareInitialBtn.disabled = game.handle === null;
  shareCurrentBtn.disabled = game.handle === null;
  toggleSharedViewBtn.disabled = game.handle === null || !game.sharedReplay;
  updateSharedViewButton();
}

function checkWin() {
  if (game.handle === null) {
    return;
  }
  if (!isSolved(game.handle)) {
    return;
  }
  game.won = true;
  game.selectedTube = null;
  refreshFinishScore();
  render();
  if (!game.finish || game.finish.pending) {
    showToast("Puzzle solved. Computing ideal moves...");
    return;
  }
  showToast(solvedToastSummary(game.finish));
}

// --- Input handlers ---

function handleTubeClick(index) {
  if (game.handle === null || game.won) {
    return;
  }
  const board = readBoardState();
  const selected = game.selectedTube;
  const clickedTube = board[index];

  if (selected === null) {
    if (!clickedTube || clickedTube.length === 0) {
      showToast("That tube is empty.");
      triggerShake(index);
      return;
    }
    game.selectedTube = index;
    render();
    return;
  }

  if (selected === index) {
    game.selectedTube = null;
    render();
    return;
  }

  if (canPour(game.handle, selected, index)) {
    const moved = pour(game.handle, selected, index);
    if (moved > 0) {
      game.moveTrail.push({ from: selected, to: index });
      game.selectedTube = null;
      game.lastMove = { from: selected, to: index };
      render();
      finishLastMoveAnimation();
      checkWin();
      return;
    }
  }

  showToast(invalidMoveReason(selected, index, board));
  triggerShake(index);
  game.selectedTube = clickedTube && clickedTube.length > 0 ? index : selected;
  render();
}

// --- Game lifecycle ---

function destroyCurrentGame() {
  if (game.handle !== null) {
    freeGame(game.handle);
    game.handle = null;
  }
  game.scoreToken += 1;
  game.ideal = defaultIdealState();
  resetInteractionState();
}

function startNewGame(seed = randomSeed(), options = {}) {
  const sharedReplay = options.sharedReplay || null;
  const sharedView = options.sharedView === "initial" ? "initial" : "current";
  if (!game.ready) {
    return;
  }
  destroyCurrentGame();
  game.seed = seed;
  game.activeBottleCount = game.bottleCount;
  game.activeEmptyTubes = game.emptyTubes;
  game.activeScramble = game.scramble;
  game.moveTrail = [];
  game.handle = createGame(game.bottleCount, game.emptyTubes, game.scramble, seed);
  resetInteractionState();
  game.sharedReplay = sharedReplay;
  game.sharedView = sharedReplay ? sharedView : "current";
  updateSharedViewButton();
  render();
  computeIdealMovesForPuzzle();
}

function restartGame() {
  if (game.handle === null) {
    return;
  }
  restart(game.handle);
  resetInteractionState();
  game.moveTrail = [];
  if (game.sharedReplay) {
    game.sharedView = "initial";
    updateSharedViewButton();
  }
  render();
}

function undoMove() {
  if (game.handle === null) {
    return;
  }
  if (!undo(game.handle)) {
    return;
  }
  resetInteractionState();
  if (game.moveTrail.length > 0) {
    game.moveTrail.pop();
  }
  render();
}

// --- Bootstrapping and event wiring ---

function syncBottleCountFromInput() {
  game.bottleCount = parseInteger(bottleCountEl.value, game.bottleCount);
  normalizeEmptyTubes();
  updateBottleCountLabel();
}

function syncScrambleFromInput() {
  game.scramble = normalizedScrambleValue(scrambleEl.value);
  scrambleEl.value = String(game.scramble);
  updateScrambleLabel();
}

bottleCountEl.addEventListener("input", syncBottleCountFromInput);
bottleCountEl.addEventListener("change", () => {
  syncBottleCountFromInput();
  startNewGame();
});

scrambleEl.addEventListener("input", syncScrambleFromInput);

scrambleEl.addEventListener("change", () => {
  syncScrambleFromInput();
  startNewGame();
});

emptyTubesEl.addEventListener("change", () => {
  game.emptyTubes = parseInteger(emptyTubesEl.value, game.emptyTubes);
  startNewGame();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isGuideOpen()) {
    closeGuide();
    return;
  }
  if (isGuideOpen()) {
    return;
  }
  if (event.key === "u" || event.key === "U") {
    undoMove();
  }
  if (event.key === "r" || event.key === "R") {
    restartGame();
  }
  if (event.key === "n" || event.key === "N") {
    startNewGame();
  }
});

window.addEventListener("beforeunload", () => {
  destroyCurrentGame();
});

guideOverlayEl.addEventListener("click", (event) => {
  if (event.target === guideOverlayEl) {
    closeGuide();
  }
});

newGameBtn.addEventListener("click", startNewGame);
restartBtn.addEventListener("click", restartGame);
undoBtn.addEventListener("click", undoMove);
showGuideBtn.addEventListener("click", openGuide);
guideCloseBtn.addEventListener("click", closeGuide);
themeToggleBtn.addEventListener("click", cycleThemeMode);
shareInitialBtn.addEventListener("click", () => {
  copyShareLink("initial");
});
shareCurrentBtn.addEventListener("click", () => {
  copyShareLink("current");
});
toggleSharedViewBtn.addEventListener("click", toggleSharedView);

async function bootstrap() {
  const shared = parseShareFromUrl();
  initTheme();
  if (shared) {
    applyPuzzleSettings(shared);
    statusTextEl.textContent = "Loading shared puzzle...";
  } else {
    updateBottleCountLabel();
    updateScrambleLabel();
    normalizeEmptyTubes();
    statusTextEl.textContent = "Loading Rust + WebAssembly engine...";
  }
  try {
    await initEngine();
    game.ready = true;
    if (shared) {
      const replay =
        shared.type === "current"
          ? {
              moves: shared.moves,
            }
          : null;
      startNewGame(shared.seed, {
        sharedReplay: replay,
        sharedView: shared.type === "current" ? "current" : "initial",
      });
      if (shared.type === "current") {
        restoreSharedCurrent(shared.moves);
        checkWin();
        render();
      }
      showToast(
        shared.type === "current"
          ? "Shared current state restored."
          : "Shared initial puzzle restored.",
      );
    } else {
      startNewGame();
    }
    if (shouldAutoShowGuide()) {
      window.setTimeout(() => openGuide(), GUIDE_AUTO_OPEN_DELAY_MS);
    }
  } catch (error) {
    console.error(error);
    statusTextEl.textContent = "Failed to load WASM engine. Build it with scripts/build-wasm.sh.";
    progressEl.textContent = "0 / 0";
    movesEl.textContent = "0";
  }
}

bootstrap();
