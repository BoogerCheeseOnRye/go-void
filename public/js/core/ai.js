/* GO/VOID — AI opponent.
 *
 * A fast tactical Go bot: candidate scoring, local threat search and alpha-beta
 * over the top moves. It is deliberately dependency-free so it runs in a module
 * worker on a phone and in node for tests.
 */

import {
  BLACK,
  WHITE,
  EMPTY,
  other,
  tryMove,
  findGroup,
  isEye,
  scoreBoard,
  neighbors,
} from './go.js';

const PROFILE = {
  easy: { budget: 90, root: 14, reply: 6, depth: 0, noise: 1.4, pass: -18, random: 0.18 },
  medium: { budget: 380, root: 24, reply: 9, depth: 1, noise: 0.35, pass: -8, random: 0.03 },
  hard: { budget: 1100, root: 34, reply: 12, depth: 2, noise: 0, pass: -3, random: 0 },
  insane: { budget: 2200, root: 44, reply: 14, depth: 3, noise: 0, pass: -1, random: 0 },
};

const STAR_LINES = {
  9: [2, 4, 6],
  13: [3, 6, 9],
  19: [3, 9, 15],
};

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isStar(size, index) {
  const lines = STAR_LINES[size];
  if (!lines) return false;
  const x = index % size;
  const y = Math.floor(index / size);
  return lines.includes(x) && lines.includes(y);
}

function edgeDistance(size, index) {
  const x = index % size;
  const y = Math.floor(index / size);
  return Math.min(x, y, size - 1 - x, size - 1 - y);
}

function countAtariAfter(board, size, index, color) {
  // Only groups adjacent to the played point can have become atari.
  let groups = 0;
  let stones = 0;
  const seen = new Set();
  for (const nb of neighbors(size, index)) {
    if (board[nb] !== color || seen.has(nb)) continue;
    const g = findGroup(board, size, nb);
    for (const s of g.stones) seen.add(s);
    if (g.liberties.size === 1) {
      groups++;
      stones += g.stones.length;
    }
  }
  return { groups, stones };
}

function savedAtari(board, size, index, color) {
  // Own groups in atari next to the point that gain a liberty by this move.
  let saved = 0;
  let savedStones = 0;
  const seen = new Set();
  for (const nb of neighbors(size, index)) {
    if (board[nb] !== color || seen.has(nb)) continue;
    const g = findGroup(board, size, nb);
    for (const s of g.stones) seen.add(s);
    if (g.liberties.size === 1) {
      saved++;
      savedStones += g.stones.length;
    }
  }
  return { saved, savedStones };
}

function positionalScore(size, index, moveNumber) {
  const x = index % size;
  const y = Math.floor(index / size);
  const edge = edgeDistance(size, index);
  let s = 0;
  if (edge === 0) s -= 7;
  else if (edge === 1) s -= 1.5;
  else if (edge === 2) s += 4;
  else if (edge === 3) s += 5.5;
  else s += 2;
  if (isStar(size, index)) s += 4;
  const center = (size - 1) / 2;
  const dist = Math.max(Math.abs(x - center), Math.abs(y - center));
  if (moveNumber < size * 2) s += Math.max(0, 3 - dist) * 0.8;
  // Prefer the upper-left / lower-right half a touch on symmetric openings.
  if (moveNumber < 8) s += (x + y) % 2 === 0 ? 0.3 : 0;
  return s;
}

function localCandidateIndices(board, size, around, radius = 2) {
  const set = new Set();
  if (around >= 0) {
    const ax = around % size;
    const ay = Math.floor(around / size);
    for (let y = Math.max(0, ay - radius); y <= Math.min(size - 1, ay + radius); y++) {
      for (let x = Math.max(0, ax - radius); x <= Math.min(size - 1, ax + radius); x++) {
        const i = y * size + x;
        if (board[i] === EMPTY) set.add(i);
      }
    }
  }
  // All points touching a group in atari are tactically relevant.
  const seen = new Uint8Array(board.length);
  for (let i = 0; i < board.length; i++) {
    if (board[i] === EMPTY || seen[i]) continue;
    const g = findGroup(board, size, i);
    for (const s of g.stones) seen[s] = 1;
    if (g.liberties.size === 1) {
      for (const lib of g.liberties) set.add(lib);
    }
  }
  if (set.size < 6) {
    for (let i = 0; i < board.length && set.size < 10; i++) {
      if (board[i] === EMPTY) set.add(i);
    }
  }
  return [...set];
}

/** Score a single move from the mover's point of view. Higher is better. */
function scoreMove(board, size, color, index, koPoint, lastMove, moveNumber, rand, noise) {
  const result = tryMove(board, size, color, index, koPoint);
  if (!result) return null;

  const opponent = other(color);
  const beforeOwn = savedAtari(board, size, index, color);
  const afterAtari = countAtariAfter(result.board, size, index, opponent);
  const eye = isEye(board, size, index, color);

  let score = 0;
  score += result.captures.length * 26;
  if (result.captures.length > 1) score += (result.captures.length - 1) * 10;
  score += afterAtari.groups * 8 + afterAtari.stones * 3;
  score += beforeOwn.saved * 9 + beforeOwn.savedStones * 2.5;
  score += result.liberties * 1.6;
  if (result.selfAtari) {
    score -= result.captures.length ? 6 : 26;
    if (result.liberties === 1 && result.captures.length === 0) score -= 10;
  }
  if (eye && result.captures.length === 0) score -= 70;
  score += positionalScore(size, index, moveNumber);

  if (lastMove >= 0) {
    const lx = lastMove % size;
    const ly = Math.floor(lastMove / size);
    const dx = Math.abs((index % size) - lx);
    const dy = Math.abs(Math.floor(index / size) - ly);
    const d = Math.max(dx, dy);
    if (d <= 1) score += 2.5;
    else if (d <= 2) score += 1.2;
    else if (d >= 6) score -= 0.8;
  }

  // Do not fill the last liberties of a healthy group.
  if (result.selfAtari && result.captures.length === 0 && result.liberties === 1) {
    score -= 10;
  }

  // A large, safe group is good; a lone stone on the first line is not.
  if (result.group.stones.length >= 4 && result.liberties >= 3) score += 3;

  score += (rand() - 0.5) * noise;
  return { index, score, result, captures: result.captures, eye };
}

function influenceBalance(board, size) {
  const n = board.length;
  const INF = 99;
  const dB = new Int16Array(n).fill(INF);
  const dW = new Int16Array(n).fill(INF);
  const qb = [];
  const qw = [];
  for (let i = 0; i < n; i++) {
    if (board[i] === BLACK) {
      dB[i] = 0;
      qb.push(i);
    } else if (board[i] === WHITE) {
      dW[i] = 0;
      qw.push(i);
    }
  }
  const bfs = (dist, queue) => {
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      const d = dist[cur] + 1;
      if (d > 6) continue;
      for (const nb of neighbors(size, cur)) {
        if (dist[nb] > d) {
          dist[nb] = d;
          queue.push(nb);
        }
      }
    }
  };
  bfs(dB, qb);
  bfs(dW, qw);

  let sum = 0;
  let empty = 0;
  for (let i = 0; i < n; i++) {
    if (board[i] !== EMPTY) continue;
    empty++;
    const b = Math.min(dB[i], 6);
    const w = Math.min(dW[i], 6);
    const bi = Math.max(0, 1 - b / 6);
    const wi = Math.max(0, 1 - w / 6);
    sum += bi - wi;
  }
  return empty ? (sum / empty) * 14 : 0;
}

function evaluatePosition(board, size, color, komi, moveNumber = 0) {
  const s = scoreBoard(board, size, komi);
  const stonesDiff = s.stonesBlack - s.stonesWhite;
  const density = (s.stonesBlack + s.stonesWhite) / (size * size);
  const areaWeight = 0.08 + 0.92 * Math.min(1, density / 0.55);
  let value = stonesDiff + influenceBalance(board, size) + s.diff * 0.18 * areaWeight;

  const seen = new Uint8Array(board.length);
  for (let i = 0; i < board.length; i++) {
    if (board[i] === EMPTY || seen[i]) continue;
    const g = findGroup(board, size, i);
    for (const stone of g.stones) seen[stone] = 1;
    const own = g.color === color;
    const libs = g.liberties.size;
    const weight = own ? 1 : -1;
    if (libs === 1) value -= weight * (5 + g.stones.length * 0.8);
    else if (libs === 2) value -= weight * 1.2;
    else if (libs >= 5) value += weight * 0.8;
    if (g.stones.length >= 5 && libs >= 2) value += weight * 0.5;
  }

  // A tiny bonus for influence near the center, helps the bot invade rather than
  // play passively on the edge.
  let centerStones = 0;
  const center = (size - 1) / 2;
  const r = size * 0.3;
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== color) continue;
    const x = i % size;
    const y = Math.floor(i / size);
    if (Math.hypot(x - center, y - center) < r) centerStones++;
  }
  value += Math.min(centerStones, 8) * 0.2;
  if (moveNumber < size * 1.5) value += 0.5;
  return value;
}

function buildReplies(board, size, color, koPoint, around, limit, rand, noise, moveNumber) {
  const indices = localCandidateIndices(board, size, around, 2);
  const scored = [];
  for (const index of indices) {
    if (board[index] !== EMPTY) continue;
    const m = scoreMove(board, size, color, index, koPoint, around, moveNumber, rand, noise);
    if (m) scored.push(m);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function alphaBeta(board, size, turn, rootColor, depth, alpha, beta, koPoint, lastMove, moveNumber, rand, noise, deadline, profile) {
  if (depth <= 0 || now() > deadline) {
    return evaluatePosition(board, size, rootColor, profile.komi, moveNumber);
  }

  const limit = depth === profile.depth ? profile.reply : Math.max(4, profile.reply - 2);
  const replies = buildReplies(board, size, turn, koPoint, lastMove, limit, rand, noise, moveNumber);
  const maximize = turn === rootColor;
  let best = maximize ? -Infinity : Infinity;

  if (replies.length === 0) {
    return evaluatePosition(board, size, rootColor, profile.komi, moveNumber);
  }

  for (const reply of replies) {
    const nextKo = reply.result.nextKo;
    const val = alphaBeta(
      reply.result.board,
      size,
      other(turn),
      rootColor,
      depth - 1,
      alpha,
      beta,
      nextKo,
      reply.index,
      moveNumber + 1,
      rand,
      noise,
      deadline,
      profile,
    );
    if (maximize) {
      if (val > best) best = val;
      if (best > alpha) alpha = best;
    } else {
      if (val < best) best = val;
      if (best < beta) beta = best;
    }
    if (beta <= alpha) break;
    if (now() > deadline) break;
  }
  return best;
}

export function chooseMove(options) {
  const {
    board,
    size,
    color,
    koPoint = -1,
    lastMove = -1,
    moveNumber = 0,
    difficulty = 'medium',
    komi = 6.5,
    seed = (Date.now() ^ (moveNumber * 2654435761)) >>> 0,
    passes = 0,
  } = options;

  if (!board || !size || !color) throw new Error('chooseMove: board, size and color are required');
  if (color !== BLACK && color !== WHITE) throw new Error('chooseMove: invalid color');
  const base = PROFILE[difficulty] || PROFILE.medium;
  const profile = { ...base, komi };
  const rand = mulberry32(seed);
  const deadline = now() + profile.budget;

  // Immediate tactical wins: capture a group if it is the only move that saves us.
  // Root candidate scoring is also the tactical evaluation for easy.
  const roots = [];
  let moveCount = 0;
  const emptyCount = board.reduce((n, v) => n + (v === EMPTY ? 1 : 0), 0);
  for (let index = 0; index < board.length; index++) {
    if (board[index] !== EMPTY) continue;
    moveCount++;
    const m = scoreMove(board, size, color, index, koPoint, lastMove, moveNumber, rand, profile.noise);
    if (m) roots.push(m);
  }

  if (!roots.length) {
    return { move: -1, pass: true, reason: 'no-legal-moves', score: 0, candidates: 0 };
  }

  roots.sort((a, b) => b.score - a.score);

  // Opening book: make the first move feel intentional.
  if (moveNumber === 0 && size === 9) {
    return { move: 40, pass: false, reason: 'opening', score: roots[0].score, candidates: roots.length };
  }
  if (moveNumber === 0 && size === 13) {
    return { move: 6 * 13 + 6, pass: false, reason: 'opening', score: roots[0].score, candidates: roots.length };
  }
  if (moveNumber === 0) {
    return { move: 3 * size + 3, pass: false, reason: 'opening', score: roots[0].score, candidates: roots.length };
  }

  // Tactical override: do not miss a clean capture. The search sometimes prefers
  // a bigger-looking influence move when a capture is sitting on the board.
  const captureMoves = roots.filter(
    (m) => m.captures.length > 0 && !(m.result.selfAtari && m.result.liberties === 1 && m.captures.length === 1),
  );
  if (captureMoves.length) {
    captureMoves.sort((a, b) => b.captures.length - a.captures.length || b.score - a.score);
    const capture = captureMoves[0];
    if (capture.captures.length >= 2 || capture.score >= 18) {
      return {
        move: capture.index,
        pass: false,
        reason: 'capture',
        score: Math.round(capture.score * 10) / 10,
        candidates: roots.length,
        top: captureMoves.slice(0, 3).map((m) => ({ move: m.index, captures: m.captures.length })),
      };
    }
  }

  // Easy picks a good-but-random move; medium/hard search.
  const poolSize = Math.min(roots.length, profile.root);
  const pool = roots.slice(0, poolSize);
  let best = pool[0];
  let bestValue = -Infinity;

  if (profile.depth === 0) {
    const spread = difficulty === 'easy' ? 6 : 2;
    const pick = pool[Math.min(pool.length - 1, Math.floor(rand() * spread))];
    best = pick;
    bestValue = pick.score;
  } else {
    for (const move of pool) {
      if (now() > deadline) break;
      let value;
      if (profile.depth === 1) {
        // Our move, then the opponent's strongest local reply.
        const nextKo = move.result.nextKo;
        const replies = buildReplies(
          move.result.board,
          size,
          other(color),
          nextKo,
          move.index,
          profile.reply,
          rand,
          profile.noise,
          moveNumber + 1,
        );
        let worst = evaluatePosition(move.result.board, size, color, komi, moveNumber + 1);
        for (const reply of replies) {
          const v = evaluatePosition(reply.result.board, size, color, komi, moveNumber + 2);
          if (v < worst) worst = v;
        }
        value = worst + move.score * 0.12;
      } else {
        value = alphaBeta(
          move.result.board,
          size,
          other(color),
          color,
          profile.depth,
          -Infinity,
          Infinity,
          move.result.nextKo,
          move.index,
          moveNumber + 1,
          rand,
          profile.noise,
          deadline,
          profile,
        );
        value += move.score * 0.05;
      }
      if (value > bestValue) {
        bestValue = value;
        best = move;
      }
      if (now() > deadline) break;
    }
  }

  // Random blunder for easy.
  if (difficulty === 'easy' && rand() < profile.random) {
    best = roots[Math.floor(rand() * Math.min(roots.length, 12))];
    bestValue = best.score;
  }

  const current = evaluatePosition(board, size, color, komi, moveNumber);
  const late = emptyCount < Math.max(8, size * 0.9);
  const veryLate = passes > 0 && emptyCount < size * 2.2 && current > -1.5;
  const exhausted = moveNumber > size * size * 1.25;
  const shouldPass =
    emptyCount === 0 ||
    exhausted ||
    veryLate ||
    (moveNumber > Math.max(16, size * 2) &&
      passes > 0 &&
      current > 0 &&
      (late || emptyCount < size * 2) &&
      bestValue < profile.pass);

  if (shouldPass) {
    return {
      move: -1,
      pass: true,
      reason: exhausted ? 'exhausted' : veryLate ? 'settled' : 'ahead-and-settled',
      score: current,
      candidates: roots.length,
    };
  }

  // Never pass while behind unless the board is essentially full.
  const losing = current < -2;
  if (!losing && emptyCount === 0) {
    return { move: -1, pass: true, reason: 'board-full', score: current, candidates: roots.length };
  }

  return {
    move: best.index,
    pass: false,
    reason: profile.depth ? 'search' : 'heuristic',
    score: Math.round(bestValue * 10) / 10,
    candidates: roots.length,
    // Debug info used by the test harness, harmless on the wire.
    top: pool.slice(0, 3).map((m) => ({ move: m.index, score: Math.round(m.score * 10) / 10 })),
  };
}

export { PROFILE as AI_PROFILES };
