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

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// Runtime state shared across UI handlers and render passes.
const game = {
  handle: null,
  bottleCount: parseInteger(bottleCountEl.value, 16),
  scramble: parseInteger(scrambleEl.value, 110),
  emptyTubes: parseInteger(emptyTubesEl.value, 2),
  selectedTube: null,
  won: false,
  lastMove: null,
  shakeUntil: new Map(),
  clearLastMoveTimer: null,
  toastTimer: null,
  ready: false,
  ideal: {
    loading: false,
    value: null,
    exact: false,
  },
  finish: null,
  scoreToken: 0,
};

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

  // Golden-angle hue spacing keeps neighboring IDs visually far apart.
  let hue = Math.round((index * 137.508) % 360);
  let saturation = [74, 68, 62][index % 3];
  let lightness = [56, 52, 60][(index + 1) % 3];

  // Tone down aggressive red/green buckets to avoid eye-straining neon colors.
  const nearRed = hue >= 345 || hue <= 20;
  const nearGreen = hue >= 85 && hue <= 155;
  if (nearRed) {
    hue = (hue + 12) % 360;
    saturation = Math.min(saturation, 56);
    lightness = Math.max(lightness, 58);
  } else if (nearGreen) {
    hue = (hue + 14) % 360;
    saturation = Math.min(saturation, 58);
    lightness = Math.max(lightness, 56);
  }

  if (activeTheme === "dark") {
    saturation = Math.max(38, saturation - 16);
    lightness = Math.max(40, Math.min(52, lightness - 10));
  }

  const color = `hsl(${hue} ${saturation}% ${lightness}%)`;
  COLOR_CACHE.set(cacheKey, color);
  return color;
}

// --- Scoring and ideal move reporting ---

function normalizedScrambleValue(value) {
  const number = Number.parseInt(String(value), 10);
  if (Number.isNaN(number)) {
    return 110;
  }
  return Math.max(24, Math.min(220, number));
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
    loading: true,
    value: null,
    exact: false,
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
        const label = game.finish.exact ? "ideal" : "best known";
        showToast(
          `Solved: ${game.finish.actual} moves (${label} ${game.finish.ideal}, ${game.finish.percent}% efficiency).`,
        );
      }
    }
    render();
  }, 20);
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
  if (destination.length >= 4) {
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
  }, 1600);
}

function clearShake(index) {
  if (game.shakeUntil.has(index)) {
    game.shakeUntil.delete(index);
    render();
  }
}

function triggerShake(index) {
  game.shakeUntil.set(index, Date.now() + 300);
  render();
  window.setTimeout(() => clearShake(index), 320);
}

// --- Rendering ---

function updateBottleCountLabel() {
  bottleCountValueEl.textContent = String(game.bottleCount);
}

function updateScrambleLabel() {
  scrambleValueEl.textContent = String(game.scramble);
}

function normalizeEmptyTubes() {
  const maxAllowed = Math.min(4, Math.max(2, game.bottleCount - 2));
  if (game.emptyTubes > maxAllowed) {
    game.emptyTubes = maxAllowed;
    emptyTubesEl.value = String(maxAllowed);
  }
  for (const option of emptyTubesEl.options) {
    option.disabled = Number.parseInt(option.value, 10) > maxAllowed;
  }
}

function updateStatusText(board) {
  if (game.handle === null) {
    statusTextEl.textContent = "Loading engine...";
    scoreLineEl.textContent = "";
    scoreLineEl.classList.remove("visible");
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
      scoreLineEl.textContent = "Analyzing optimal path...";
      scoreLineEl.classList.add("visible");
      return;
    }
    if (!game.finish.pending) {
      const idealLabel = game.finish.exact ? "Ideal" : "Best known";
      statusTextEl.textContent = `Solved in ${actual} moves.`;
      scoreLineEl.textContent = `${idealLabel}: ${game.finish.ideal} | Efficiency: ${game.finish.percent}% (${game.finish.grade})`;
      scoreLineEl.classList.add("visible");
      return;
    }
    statusTextEl.textContent = `Solved in ${actual} moves.`;
    scoreLineEl.textContent = "";
    scoreLineEl.classList.remove("visible");
    return;
  }

  scoreLineEl.textContent = "";
  scoreLineEl.classList.remove("visible");
  if (game.ideal.loading) {
    scoreLineEl.textContent = "Ideal: analyzing...";
    scoreLineEl.classList.add("visible");
  } else if (game.ideal.value !== null) {
    const label = game.ideal.exact ? "Ideal" : "Best known";
    scoreLineEl.textContent = `${label}: ${game.ideal.value} moves`;
    scoreLineEl.classList.add("visible");
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
  if (board.length >= 18) {
    boardEl.dataset.density = "tight";
  } else if (board.length >= 14) {
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
      layer.style.bottom = `${layerIndex * 25}%`;
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
  }, 360);
}

function render() {
  const board = readBoardState();
  updateStatusText(board);
  renderBoard(board);
  undoBtn.disabled = game.handle === null || moveCount(game.handle) === 0;
  restartBtn.disabled = game.handle === null;
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
  const label = game.finish.exact ? "ideal" : "best known";
  showToast(
    `Solved: ${game.finish.actual} moves (${label} ${game.finish.ideal}, ${game.finish.percent}% efficiency).`,
  );
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
  game.ideal = {
    loading: false,
    value: null,
    exact: false,
  };
  game.finish = null;
}

function startNewGame() {
  if (!game.ready) {
    return;
  }
  destroyCurrentGame();
  game.handle = createGame(game.bottleCount, game.emptyTubes, game.scramble, randomSeed());
  game.selectedTube = null;
  game.won = false;
  game.lastMove = null;
  game.finish = null;
  render();
  computeIdealMovesForPuzzle();
}

function restartGame() {
  if (game.handle === null) {
    return;
  }
  restart(game.handle);
  game.selectedTube = null;
  game.won = false;
  game.lastMove = null;
  game.finish = null;
  render();
}

function undoMove() {
  if (game.handle === null) {
    return;
  }
  if (!undo(game.handle)) {
    return;
  }
  game.selectedTube = null;
  game.won = false;
  game.lastMove = null;
  game.finish = null;
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

async function bootstrap() {
  initTheme();
  updateBottleCountLabel();
  updateScrambleLabel();
  normalizeEmptyTubes();
  statusTextEl.textContent = "Loading Rust + WebAssembly engine...";
  try {
    await initEngine();
    game.ready = true;
    startNewGame();
    if (shouldAutoShowGuide()) {
      window.setTimeout(() => openGuide(), 120);
    }
  } catch (error) {
    console.error(error);
    statusTextEl.textContent = "Failed to load WASM engine. Build it with scripts/build-wasm.sh.";
    progressEl.textContent = "0 / 0";
    movesEl.textContent = "0";
  }
}

bootstrap();
