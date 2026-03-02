//! Rust + WebAssembly puzzle engine for Aqua Sort.
//!
//! This module contains:
//! - puzzle generation (reverse/backward moves from a solved board),
//! - gameplay state transitions (pour/undo/restart),
//! - optimal move estimation (A* with an admissible lower bound),
//! - a small C-ABI surface consumed by the browser loader.
//!
//! The exported C-ABI functions intentionally use primitive numeric types so
//! JavaScript can call them without additional marshaling layers.

use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};

/// Number of color slots available in each tube.
const TUBE_CAPACITY: usize = 4;
/// Lower bound for total tube count accepted by the engine.
const MIN_TOTAL_TUBES: usize = 6;
/// Upper bound for total tube count accepted by the engine.
const MAX_TOTAL_TUBES: usize = 24;
/// Lower bound for empty helper tubes accepted by the engine.
const MIN_EMPTY_TUBES: usize = 2;
/// Upper bound for empty helper tubes accepted by the engine.
const MAX_EMPTY_TUBES: usize = 4;

/// Canonical puzzle representation used internally by the solver and generator.
type State = Vec<Vec<u8>>;

/// Generated puzzle plus a known valid solution length produced by generation.
#[derive(Clone)]
struct GeneratedPuzzle {
    state: State,
    known_solution_len: u32,
}

/// Reverse move used by the generator while scrambling a solved state.
#[derive(Clone, Copy)]
struct BackwardMove {
    from: usize,
    to: usize,
    amount: usize,
    color: u8,
}

#[derive(Clone)]
struct Rng {
    state: u64,
}

impl Rng {
    /// Creates a deterministic XOR-shift style RNG.
    fn new(seed: u64) -> Self {
        let start = if seed == 0 { 0x9e3779b97f4a7c15 } else { seed };
        Self { state: start }
    }

    /// Returns the next pseudo-random `u32`.
    fn next_u32(&mut self) -> u32 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        (x >> 16) as u32
    }

    /// Returns a pseudo-random value in `[min, max_inclusive]`.
    fn range_u32(&mut self, min: u32, max_inclusive: u32) -> u32 {
        if min >= max_inclusive {
            return min;
        }
        let span = max_inclusive - min + 1;
        min + (self.next_u32() % span)
    }
}

/// Full mutable game session stored behind an integer handle.
#[derive(Clone)]
struct Game {
    initial_state: State,
    state: State,
    history: Vec<State>,
    moves: u32,
    color_count: usize,
    known_solution_upper_bound: u32,
    ideal_moves_cache: Option<u32>,
    ideal_is_exact: bool,
}

impl Game {
    /// Builds a new game with validated configuration and a generated puzzle.
    fn new(total_tubes: usize, empty_tubes: usize, scramble: u32, seed: u64) -> Self {
        let total = total_tubes.clamp(MIN_TOTAL_TUBES, MAX_TOTAL_TUBES);
        let clamped_empty = empty_tubes
            .clamp(MIN_EMPTY_TUBES, MAX_EMPTY_TUBES)
            .min(total.saturating_sub(2));
        let colors = total.saturating_sub(clamped_empty).max(2);
        let scramble_steps = scramble.clamp(12, 560);
        let mut rng = Rng::new(seed);
        let generated = generate_puzzle(colors, clamped_empty, scramble_steps, &mut rng);
        let known_solution_upper_bound = generated.known_solution_len;
        let start = generated.state;

        Self {
            initial_state: start.clone(),
            state: start,
            history: Vec::new(),
            moves: 0,
            color_count: colors,
            known_solution_upper_bound,
            ideal_moves_cache: None,
            ideal_is_exact: false,
        }
    }

    /// Resets the current board to the initial generated state.
    fn restart(&mut self) {
        self.state = self.initial_state.clone();
        self.history.clear();
        self.moves = 0;
    }

    /// Returns whether every non-empty tube is full and uniform.
    fn is_solved(&self) -> bool {
        self.state.iter().all(|tube| {
            if tube.is_empty() {
                return true;
            }
            if tube.len() != TUBE_CAPACITY {
                return false;
            }
            tube.iter().all(|&c| c == tube[0])
        })
    }

    /// Returns how many tubes are solved (full and uniform).
    fn solved_tube_count(&self) -> usize {
        self.state
            .iter()
            .filter(|tube| tube.len() == TUBE_CAPACITY && tube.iter().all(|&c| c == tube[0]))
            .count()
    }

    /// Checks whether a pour move is legal for `(from, to)`.
    fn can_pour(&self, from: usize, to: usize) -> bool {
        if from == to || from >= self.state.len() || to >= self.state.len() {
            return false;
        }
        let source = &self.state[from];
        let dest = &self.state[to];
        if source.is_empty() || dest.len() >= TUBE_CAPACITY {
            return false;
        }
        if dest.is_empty() {
            return true;
        }
        source.last() == dest.last()
    }

    /// Applies one legal pour and records the previous state for undo.
    fn pour(&mut self, from: usize, to: usize) -> u32 {
        if !self.can_pour(from, to) {
            return 0;
        }
        let before = self.state.clone();
        let amount = apply_pour(&mut self.state, from, to);
        if amount > 0 {
            self.history.push(before);
            self.moves = self.moves.saturating_add(1);
        }
        amount as u32
    }

    /// Restores the previous board state, if available.
    fn undo(&mut self) -> bool {
        if let Some(previous) = self.history.pop() {
            self.state = previous;
            self.moves = self.moves.saturating_sub(1);
            return true;
        }
        false
    }

    /// Computes and caches ideal move count for the initial board.
    fn ideal_moves(&mut self) -> u32 {
        if let Some(value) = self.ideal_moves_cache {
            return value;
        }

        // A* with an admissible lower bound computes an exact optimum when it
        // finishes. We bound exploration so gameplay stays responsive; if the
        // bound is hit, we fall back to the generator's known valid solution
        // length (still a guaranteed solvable upper bound).
        let node_limit = 2_500_000;
        let solved = solve_optimal_moves(
            &self.initial_state,
            self.known_solution_upper_bound,
            node_limit,
        );

        match solved {
            IdealSolveResult::Exact(value) => {
                self.ideal_moves_cache = Some(value);
                self.ideal_is_exact = true;
                value
            }
            IdealSolveResult::UpperBound(value) => {
                self.ideal_moves_cache = Some(value);
                self.ideal_is_exact = false;
                value
            }
        }
    }
}

thread_local! {
    /// Handle table for all active games visible through the WASM boundary.
    static GAMES: RefCell<Vec<Option<Game>>> = const { RefCell::new(Vec::new()) };
}

/// Converts a Rust bool into C-ABI style `0/1`.
fn bool_to_u32(value: bool) -> u32 {
    u32::from(value)
}

/// Returns the top color of a tube, if any.
fn top_color(tube: &[u8]) -> Option<u8> {
    tube.last().copied()
}

/// Counts contiguous same-color cells from the top of a tube.
fn top_run_count(tube: &[u8]) -> usize {
    let Some(top) = top_color(tube) else {
        return 0;
    };
    let mut run = 0;
    for color in tube.iter().rev() {
        if *color != top {
            break;
        }
        run += 1;
    }
    run
}

/// Applies a forward puzzle pour from one tube into another.
fn apply_pour(state: &mut State, from: usize, to: usize) -> usize {
    let amount = {
        let source = &state[from];
        let destination = &state[to];
        top_run_count(source).min(TUBE_CAPACITY.saturating_sub(destination.len()))
    };
    if amount == 0 {
        return 0;
    }
    let split_at = state[from].len().saturating_sub(amount);
    let moved = state[from].split_off(split_at);
    state[to].extend_from_slice(&moved);
    amount
}

/// Hashes a state for fast "seen state" checks during generation.
fn state_hash(state: &State) -> u64 {
    let mut hash = 1469598103934665603_u64;
    for tube in state {
        for &cell in tube {
            hash ^= u64::from(cell) + 1;
            hash = hash.wrapping_mul(1099511628211_u64);
        }
        hash ^= 255_u64;
        hash = hash.wrapping_mul(1099511628211_u64);
    }
    hash
}

/// Counts tubes that contain more than one color.
fn mixed_tube_count(state: &State) -> usize {
    state
        .iter()
        .filter(|tube| {
            if tube.len() < 2 {
                return false;
            }
            let head = tube[0];
            tube.iter().any(|&c| c != head)
        })
        .count()
}

/// Counts tubes that are solved (full + uniform).
fn solved_tube_count(state: &State) -> usize {
    state
        .iter()
        .filter(|tube| tube.len() == TUBE_CAPACITY && tube.iter().all(|&c| c == tube[0]))
        .count()
}

/// Returns true when all non-empty tubes are solved.
fn is_solved_state(state: &State) -> bool {
    state.iter().all(|tube| {
        if tube.is_empty() {
            return true;
        }
        tube.len() == TUBE_CAPACITY && tube.iter().all(|&c| c == tube[0])
    })
}

/// Enumerates reverse moves used to generate a scrambled but solvable puzzle.
fn enumerate_backward_moves(state: &State) -> Vec<BackwardMove> {
    let mut moves = Vec::new();
    for from in 0..state.len() {
        let source = &state[from];
        if source.is_empty() {
            continue;
        }
        let color = source[source.len() - 1];
        let run = top_run_count(source);
        let mut valid_amounts = Vec::new();
        for amount in 1..=run {
            if amount < run || amount == source.len() {
                valid_amounts.push(amount);
            }
        }
        if valid_amounts.is_empty() {
            continue;
        }

        for (to, destination) in state.iter().enumerate() {
            if to == from {
                continue;
            }
            let free_space = TUBE_CAPACITY.saturating_sub(destination.len());
            if free_space == 0 {
                continue;
            }
            if top_color(destination) == Some(color) {
                continue;
            }
            for amount in &valid_amounts {
                if *amount <= free_space {
                    moves.push(BackwardMove {
                        from,
                        to,
                        amount: *amount,
                        color,
                    });
                }
            }
        }
    }
    moves
}

/// Heuristic weight for selecting a reverse move during generation.
fn backward_move_score(state: &State, mv: &BackwardMove) -> u32 {
    let from = &state[mv.from];
    let to = &state[mv.to];
    let mut score = 10_u32;
    if !to.is_empty() && top_color(to) != Some(mv.color) {
        score += 25;
    }
    if to.is_empty() {
        score += 4;
    }
    if from.len().saturating_sub(mv.amount) == 0 {
        score += 9;
    }
    if mv.amount == 1 {
        score += 2;
    }
    if to.len() + mv.amount == TUBE_CAPACITY {
        score += 2;
    }
    score
}

/// Randomly picks one move using `backward_move_score` as weights.
fn weighted_pick<'a>(items: &'a [BackwardMove], state: &State, rng: &mut Rng) -> &'a BackwardMove {
    if items.len() == 1 {
        return &items[0];
    }
    let total = items.iter().fold(0_u32, |sum, mv| {
        sum.saturating_add(backward_move_score(state, mv))
    });
    if total <= 1 {
        return &items[(rng.next_u32() as usize) % items.len()];
    }
    let mut ticket = rng.range_u32(0, total.saturating_sub(1));
    for mv in items {
        let weight = backward_move_score(state, mv);
        if ticket < weight {
            return mv;
        }
        ticket = ticket.saturating_sub(weight);
    }
    &items[items.len() - 1]
}

/// Applies one reverse move to a cloned state.
fn apply_backward_move(state: &State, mv: &BackwardMove) -> State {
    let mut next = state.clone();
    let split_at = next[mv.from].len().saturating_sub(mv.amount);
    let moved = next[mv.from].split_off(split_at);
    next[mv.to].extend_from_slice(&moved);
    next
}

#[derive(Clone, Copy)]
enum IdealSolveResult {
    Exact(u32),
    UpperBound(u32),
}

#[derive(Clone)]
struct SearchNode {
    f: u32,
    g: u32,
    h: u32,
    state: State,
}

impl PartialEq for SearchNode {
    fn eq(&self, other: &Self) -> bool {
        self.f == other.f && self.g == other.g && self.h == other.h
    }
}

impl Eq for SearchNode {}

impl PartialOrd for SearchNode {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SearchNode {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reverse order so BinaryHeap behaves as a min-heap by f-cost.
        other
            .f
            .cmp(&self.f)
            .then_with(|| other.h.cmp(&self.h))
            .then_with(|| other.g.cmp(&self.g))
    }
}

fn canonicalize_state(state: &mut State) {
    state.sort_unstable();
}

/// Encodes a canonical state into a dense byte key for hash maps.
fn encode_state_key(state: &State) -> Vec<u8> {
    let mut out = Vec::with_capacity(state.len() * (TUBE_CAPACITY + 1));
    for tube in state {
        out.push(tube.len() as u8);
        for slot in 0..TUBE_CAPACITY {
            out.push(*tube.get(slot).unwrap_or(&u8::MAX));
        }
    }
    out
}

/// Returns true if a tube is non-empty and all cells share the same color.
fn is_uniform_tube(tube: &[u8]) -> bool {
    !tube.is_empty() && tube.iter().all(|&c| c == tube[0])
}

/// Admissible lower bound for A*:
/// for each color, count contiguous segments across all tubes.
/// A solved puzzle has exactly one segment per color; one move can
/// reduce segment count by at most one for the moved color.
fn segment_lower_bound(state: &State) -> u32 {
    let mut segments: HashMap<u8, u32> = HashMap::new();
    for tube in state {
        let mut prev: Option<u8> = None;
        for &color in tube {
            if prev != Some(color) {
                *segments.entry(color).or_insert(0) += 1;
                prev = Some(color);
            }
        }
    }

    segments
        .values()
        .map(|count| count.saturating_sub(1))
        .sum::<u32>()
}

fn enumerate_forward_moves(state: &State) -> Vec<(usize, usize)> {
    let mut moves = Vec::new();
    let mut seen_sources: HashSet<Vec<u8>> = HashSet::new();

    for from in 0..state.len() {
        let source = &state[from];
        if source.is_empty() {
            continue;
        }
        if !seen_sources.insert(source.clone()) {
            continue;
        }

        let source_top = top_color(source).unwrap_or(u8::MAX);
        let source_completed = source.len() == TUBE_CAPACITY && is_uniform_tube(source);
        let mut used_empty_dest = false;
        let mut seen_destinations: HashSet<Vec<u8>> = HashSet::new();

        for (to, destination) in state.iter().enumerate() {
            if to == from {
                continue;
            }

            if destination.len() >= TUBE_CAPACITY {
                continue;
            }

            if destination.is_empty() {
                if used_empty_dest {
                    continue;
                }
                used_empty_dest = true;
                if source_completed {
                    continue;
                }
                moves.push((from, to));
                continue;
            }

            if top_color(destination) != Some(source_top) {
                continue;
            }
            if !seen_destinations.insert(destination.clone()) {
                continue;
            }
            moves.push((from, to));
        }
    }

    moves
}

/// Computes the minimum number of moves for a puzzle using A* search.
///
/// The search starts from the canonicalized puzzle state and uses:
/// - exact transition costs (1 per pour),
/// - an admissible lower bound (`segment_lower_bound`),
/// - symmetry reduction via sorted tube multiset representation.
///
/// `known_upper_bound` comes from the reverse-construction generator and is a
/// guaranteed solvable upper bound. It is used for branch-and-bound pruning.
///
/// If `node_limit` is reached before proof of optimality, the function returns
/// the best upper bound found so far. Otherwise it returns an exact optimum.
fn solve_optimal_moves(
    initial: &State,
    known_upper_bound: u32,
    node_limit: usize,
) -> IdealSolveResult {
    let mut start = initial.clone();
    canonicalize_state(&mut start);
    if is_solved_state(&start) {
        return IdealSolveResult::Exact(0);
    }

    let mut best_solution = known_upper_bound.max(1);
    let start_h = segment_lower_bound(&start);
    if start_h > best_solution {
        // Should not happen with a valid upper bound, but keep search robust.
        best_solution = start_h;
    }

    let mut open = BinaryHeap::new();
    open.push(SearchNode {
        f: start_h,
        g: 0,
        h: start_h,
        state: start.clone(),
    });

    let mut best_g: HashMap<Vec<u8>, u32> = HashMap::new();
    best_g.insert(encode_state_key(&start), 0);
    let mut explored = 0_usize;
    let mut found_solution = false;

    while let Some(node) = open.pop() {
        if node.f > best_solution {
            continue;
        }

        let node_key = encode_state_key(&node.state);
        if best_g.get(&node_key).copied() != Some(node.g) {
            continue;
        }

        if is_solved_state(&node.state) {
            found_solution = true;
            best_solution = best_solution.min(node.g);
            if open.peek().map(|next| next.f).unwrap_or(u32::MAX) >= best_solution {
                return IdealSolveResult::Exact(best_solution);
            }
            continue;
        }

        explored = explored.saturating_add(1);
        if explored >= node_limit {
            return IdealSolveResult::UpperBound(best_solution);
        }

        for (from, to) in enumerate_forward_moves(&node.state) {
            let mut next = node.state.clone();
            apply_pour(&mut next, from, to);
            canonicalize_state(&mut next);

            let next_g = node.g.saturating_add(1);
            if next_g >= best_solution {
                continue;
            }

            let next_h = segment_lower_bound(&next);
            let next_f = next_g.saturating_add(next_h);
            if next_f > best_solution {
                continue;
            }

            if is_solved_state(&next) {
                found_solution = true;
                best_solution = best_solution.min(next_g);
                continue;
            }

            let key = encode_state_key(&next);
            if best_g.get(&key).map(|&g| g <= next_g).unwrap_or(false) {
                continue;
            }
            best_g.insert(key, next_g);
            open.push(SearchNode {
                f: next_f,
                g: next_g,
                h: next_h,
                state: next,
            });
        }

        if found_solution && open.peek().map(|next| next.f).unwrap_or(u32::MAX) >= best_solution {
            return IdealSolveResult::Exact(best_solution);
        }
    }

    IdealSolveResult::Exact(best_solution)
}

/// Generates a solvable puzzle by replaying weighted reverse moves.
///
/// The algorithm starts from a solved board and repeatedly applies a legal
/// reverse move. The resulting board is guaranteed to be solvable because it
/// was reached from a solved state by invertible transitions.
fn generate_puzzle(colors: usize, empties: usize, scramble: u32, rng: &mut Rng) -> GeneratedPuzzle {
    let mut best: Option<(State, i64, u32)> = None;
    let max_attempts = 120_u32;

    for _ in 0..max_attempts {
        let mut state: State = (0..colors).map(|c| vec![c as u8; TUBE_CAPACITY]).collect();
        for _ in 0..empties {
            state.push(Vec::new());
        }
        let mut working = state;
        let jitter = (scramble / 3).max(1);
        let steps_target = scramble + rng.range_u32(0, jitter);
        let mut applied = 0_u32;
        let mut previous: Option<BackwardMove> = None;
        let mut visited: HashSet<u64> = HashSet::new();
        visited.insert(state_hash(&working));
        let guard_limit = steps_target.saturating_mul(40);
        let mut guard = 0_u32;

        while applied < steps_target && guard < guard_limit {
            guard = guard.saturating_add(1);
            let mut options = enumerate_backward_moves(&working);
            if let Some(prev) = previous {
                options.retain(|mv| {
                    !(mv.from == prev.to && mv.to == prev.from && mv.amount == prev.amount)
                });
            }
            if options.is_empty() {
                break;
            }
            let picked = *weighted_pick(&options, &working, rng);
            let next = apply_backward_move(&working, &picked);
            let hash = state_hash(&next);
            if visited.contains(&hash) && rng.range_u32(0, 9) < 9 {
                continue;
            }
            visited.insert(hash);
            working = next;
            previous = Some(picked);
            applied = applied.saturating_add(1);
        }

        let mixed = mixed_tube_count(&working) as i64;
        let solved = solved_tube_count(&working) as i64;
        let quality = mixed * 3 + i64::from(applied) - solved * 2;
        match &best {
            Some((_, best_quality, _)) if quality <= *best_quality => {}
            _ => best = Some((working.clone(), quality, applied.max(1))),
        }
        if applied >= ((scramble as f32 * 0.78) as u32)
            && mixed >= (colors.saturating_sub(2).max(2) as i64)
            && !is_solved_state(&working)
        {
            return GeneratedPuzzle {
                state: working,
                known_solution_len: applied.max(1),
            };
        }
    }

    if let Some((state, _, known_solution_len)) = best {
        return GeneratedPuzzle {
            state,
            known_solution_len,
        };
    }

    let fallback: State = (0..colors)
        .map(|c| vec![c as u8; TUBE_CAPACITY])
        .chain((0..empties).map(|_| Vec::new()))
        .collect();
    GeneratedPuzzle {
        state: fallback,
        known_solution_len: 0,
    }
}

/// Executes a closure against a mutable game slot identified by handle.
fn with_game_mut<R>(handle: u32, f: impl FnOnce(&mut Game) -> R, default: R) -> R {
    GAMES.with(|games| {
        let mut games = games.borrow_mut();
        let Some(slot) = games.get_mut(handle as usize) else {
            return default;
        };
        let Some(game) = slot.as_mut() else {
            return default;
        };
        f(game)
    })
}

/// Executes a closure against an immutable game slot identified by handle.
fn with_game<R>(handle: u32, f: impl FnOnce(&Game) -> R, default: R) -> R {
    GAMES.with(|games| {
        let games = games.borrow();
        let Some(slot) = games.get(handle as usize) else {
            return default;
        };
        let Some(game) = slot.as_ref() else {
            return default;
        };
        f(game)
    })
}

/// Creates and stores a game instance, returning an opaque handle.
#[no_mangle]
pub extern "C" fn create_game(total_tubes: u32, empty_tubes: u32, scramble: u32, seed: u64) -> u32 {
    let total = (total_tubes as usize).clamp(MIN_TOTAL_TUBES, MAX_TOTAL_TUBES);
    let empty = (empty_tubes as usize)
        .clamp(MIN_EMPTY_TUBES, MAX_EMPTY_TUBES)
        .min(total.saturating_sub(2));
    let game = Game::new(total, empty, scramble, seed);
    GAMES.with(|games| {
        let mut games = games.borrow_mut();
        for (index, slot) in games.iter_mut().enumerate() {
            if slot.is_none() {
                *slot = Some(game);
                return index as u32;
            }
        }
        games.push(Some(game));
        (games.len() - 1) as u32
    })
}

/// Releases a previously created game handle.
#[no_mangle]
pub extern "C" fn free_game(handle: u32) {
    GAMES.with(|games| {
        let mut games = games.borrow_mut();
        if let Some(slot) = games.get_mut(handle as usize) {
            *slot = None;
        }
    });
}

/// Returns the number of tubes in the game.
#[no_mangle]
pub extern "C" fn game_tube_count(handle: u32) -> u32 {
    with_game(handle, |g| g.state.len() as u32, 0)
}

/// Returns the number of distinct colors in the game.
#[no_mangle]
pub extern "C" fn game_color_count(handle: u32) -> u32 {
    with_game(handle, |g| g.color_count as u32, 0)
}

/// Returns how many cells currently exist in a tube.
#[no_mangle]
pub extern "C" fn game_tube_len(handle: u32, tube: u32) -> u32 {
    with_game(
        handle,
        |g| {
            g.state
                .get(tube as usize)
                .map(|t| t.len() as u32)
                .unwrap_or(0)
        },
        0,
    )
}

/// Returns color id at `(tube, level)` or `-1` if out-of-bounds.
#[no_mangle]
pub extern "C" fn game_tube_color(handle: u32, tube: u32, level: u32) -> i32 {
    with_game(
        handle,
        |g| {
            g.state
                .get(tube as usize)
                .and_then(|t| t.get(level as usize).copied())
                .map(i32::from)
                .unwrap_or(-1)
        },
        -1,
    )
}

/// Returns `1` if a pour from `from` to `to` is legal.
#[no_mangle]
pub extern "C" fn game_can_pour(handle: u32, from: u32, to: u32) -> u32 {
    with_game(
        handle,
        |g| bool_to_u32(g.can_pour(from as usize, to as usize)),
        0,
    )
}

/// Applies one pour and returns how many cells were moved.
#[no_mangle]
pub extern "C" fn game_pour(handle: u32, from: u32, to: u32) -> u32 {
    with_game_mut(handle, |g| g.pour(from as usize, to as usize), 0)
}

/// Undoes the latest move, returning `1` on success.
#[no_mangle]
pub extern "C" fn game_undo(handle: u32) -> u32 {
    with_game_mut(handle, |g| bool_to_u32(g.undo()), 0)
}

/// Restarts the game back to the generated initial state.
#[no_mangle]
pub extern "C" fn game_restart(handle: u32) {
    with_game_mut(handle, |g| g.restart(), ());
}

/// Returns `1` if the current state is solved.
#[no_mangle]
pub extern "C" fn game_is_solved(handle: u32) -> u32 {
    with_game(handle, |g| bool_to_u32(g.is_solved()), 0)
}

/// Returns number of solved tubes in current state.
#[no_mangle]
pub extern "C" fn game_solved_tube_count(handle: u32) -> u32 {
    with_game(handle, |g| g.solved_tube_count() as u32, 0)
}

/// Returns how many user moves have been applied.
#[no_mangle]
pub extern "C" fn game_move_count(handle: u32) -> u32 {
    with_game(handle, |g| g.moves, 0)
}

/// Returns ideal move count (exact when search finishes within limits).
#[no_mangle]
pub extern "C" fn game_ideal_moves(handle: u32) -> u32 {
    with_game_mut(handle, |g| g.ideal_moves(), 0)
}

/// Returns `1` if the ideal move count is proven exact.
#[no_mangle]
pub extern "C" fn game_ideal_is_exact(handle: u32) -> u32 {
    with_game(handle, |g| bool_to_u32(g.ideal_is_exact), 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_game_has_expected_shape() {
        let game = Game::new(16, 2, 120, 7);
        assert_eq!(game.state.len(), 16);
        let cells: usize = game.state.iter().map(|tube| tube.len()).sum();
        assert_eq!(cells, 14 * TUBE_CAPACITY);
        assert!(!game.is_solved());
    }

    #[test]
    fn pour_and_undo_round_trip() {
        let mut game = Game::new(8, 2, 30, 11);
        let original = game.state.clone();
        let mut moved = false;
        'outer: for i in 0..game.state.len() {
            for j in 0..game.state.len() {
                if game.can_pour(i, j) {
                    let amount = game.pour(i, j);
                    assert!(amount > 0);
                    moved = true;
                    break 'outer;
                }
            }
        }
        assert!(moved);
        assert!(game.undo());
        assert_eq!(game.state, original);
    }

    #[test]
    fn ideal_move_solver_produces_upper_bound_or_better() {
        let mut game = Game::new(12, 2, 70, 42);
        let known_upper = game.known_solution_upper_bound;
        let ideal = game.ideal_moves();
        if known_upper > 0 {
            assert!(ideal <= known_upper);
        } else {
            assert_eq!(ideal, 0);
        }
        if game.ideal_is_exact {
            assert!(ideal > 0 || game.is_solved());
        }
    }
}
