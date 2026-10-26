/* GO/VOID — rules engine.
 * Zero dependencies. Works in the browser, in a module worker, and in Node.
 *
 * Board values: 0 empty, 1 black, 2 white.
 * Rules: Chinese area scoring, positional superko by default, simple ko for search.
 */

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export const COLORS = Object.freeze({
  [BLACK]: 'black',
  [WHITE]: 'white',
});

export const KOMPI = Object.freeze({ 9: 6.5, 13: 7.5, 19: 7.5 });

export function other(color) {
  return color === BLACK ? WHITE : BLACK;
}

export function colorName(color) {
  return color === BLACK ? 'Black' : 'White';
}

export function inBounds(size, x, y) {
  return x >= 0 && y >= 0 && x < size && y < size;
}

export function toIndex(size, x, y) {
  return y * size + x;
}

export function toXY(size, index) {
  return [index % size, Math.floor(index / size)];
}

const neighborCache = new Map();
const diagonalCache = new Map();

export function neighbors(size, index) {
  let n = neighborCache.get(size);
  if (!n) {
    n = new Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const index = y * size + x;
        const list = [];
        if (x > 0) list.push(index - 1);
        if (x < size - 1) list.push(index + 1);
        if (y > 0) list.push(index - size);
        if (y < size - 1) list.push(index + size);
        n[y * size + x] = list;
      }
    }
    neighborCache.set(size, n);
  }
  return n[index];
}

export function diagonals(size, index) {
  let d = diagonalCache.get(size);
  if (!d) {
    d = new Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const index = y * size + x;
        const list = [];
        if (x > 0 && y > 0) list.push(index - size - 1);
        if (x < size - 1 && y > 0) list.push(index - size + 1);
        if (x > 0 && y < size - 1) list.push(index + size - 1);
        if (x < size - 1 && y < size - 1) list.push(index + size + 1);
        d[y * size + x] = list;
      }
    }
    diagonalCache.set(size, d);
  }
  return d[index];
}

export function createBoard(size) {
  return new Uint8Array(size * size);
}

export function cloneBoard(board) {
  return new Uint8Array(board);
}

/** All stones in the connected group containing index. */
export function findGroup(board, size, index) {
  const color = board[index];
  if (color === EMPTY) return { stones: [], liberties: new Set(), color: EMPTY };
  const stones = [];
  const liberties = new Set();
  const seen = new Uint8Array(board.length);
  const stack = [index];
  seen[index] = 1;
  while (stack.length) {
    const cur = stack.pop();
    stones.push(cur);
    for (const nb of neighbors(size, cur)) {
      const v = board[nb];
      if (v === EMPTY) liberties.add(nb);
      else if (v === color && !seen[nb]) {
        seen[nb] = 1;
        stack.push(nb);
      }
    }
  }
  return { stones, liberties, color };
}

/** True when the point looks like a simple eye for color. Used by the AI. */
export function isEye(board, size, index, color) {
  if (board[index] !== EMPTY) return false;
  const nbs = neighbors(size, index);
  for (const nb of nbs) if (board[nb] !== color) return false;
  const diags = diagonals(size, index);
  const edge = nbs.length < 4;
  let own = 0;
  for (const d of diags) {
    if (board[d] === other(color)) return false;
    if (board[d] === color) own++;
  }
  return edge ? own >= Math.max(2, diags.length - 1) : own >= 3;
}

/**
 * Try a move on a board copy without touching history.
 * Returns null when illegal (occupied, suicide, or simple ko), otherwise:
 * { board, captures, capturedIndex, group, liberties, nextKo, selfAtari, eye }
 */
export function tryMove(board, size, color, index, koPoint = -1) {
  if (!Number.isInteger(index) || index < 0 || index >= board.length) return null;
  if (board[index] !== EMPTY) return null;
  if (index === koPoint) return null;

  const next = new Uint8Array(board);
  next[index] = color;
  const opponent = other(color);
  const captures = [];
  let capturedIndex = -1;

  for (const nb of neighbors(size, index)) {
    if (next[nb] !== opponent) continue;
    const g = findGroup(next, size, nb);
    if (g.liberties.size === 0) {
      for (const stone of g.stones) {
        next[stone] = EMPTY;
        captures.push(stone);
        capturedIndex = stone;
      }
    }
  }

  const group = findGroup(next, size, index);
  if (group.liberties.size === 0) return null; // suicide

  let nextKo = -1;
  if (captures.length === 1 && group.stones.length === 1 && group.liberties.size === 1) {
    nextKo = capturedIndex;
  }

  return {
    board: next,
    captures,
    capturedIndex,
    group,
    liberties: group.liberties.size,
    nextKo,
    selfAtari: group.liberties.size === 1,
    eye: isEye(board, size, index, color),
  };
}

export function legalMoves(board, size, color, koPoint = -1) {
  const moves = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== EMPTY) continue;
    if (tryMove(board, size, color, i, koPoint)) moves.push(i);
  }
  return moves;
}

export function positionKey(board, turn) {
  let s = '';
  for (let i = 0; i < board.length; i++) s += board[i];
  return `${turn}:${s}`;
}

/** Stable 32-bit FNV-1a hash for wire sync, not a security primitive. */
export function boardHash(board, turn) {
  let h = 0x811c9dc5;
  h ^= turn;
  h = Math.imul(h, 0x01000193);
  for (let i = 0; i < board.length; i++) {
    h ^= board[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Chinese area score. dead: optional Set/array of stone indices treated as removed. */
export function scoreBoard(board, size, komi = 6.5, dead = null) {
  const work = new Uint8Array(board);
  let deadBlack = 0;
  let deadWhite = 0;
  if (dead) {
    const iterable = dead instanceof Set ? dead : dead;
    for (const index of iterable) {
      if (work[index] === BLACK) deadBlack++;
      else if (work[index] === WHITE) deadWhite++;
      if (index >= 0 && index < work.length) work[index] = EMPTY;
    }
  }

  let stonesBlack = 0;
  let stonesWhite = 0;
  for (let i = 0; i < work.length; i++) {
    if (work[i] === BLACK) stonesBlack++;
    else if (work[i] === WHITE) stonesWhite++;
  }

  let territoryBlack = 0;
  let territoryWhite = 0;
  const seen = new Uint8Array(work.length);
  const stack = [];
  for (let start = 0; start < work.length; start++) {
    if (work[start] !== EMPTY || seen[start]) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let owner = 0;
    let count = 0;
    let borderBlack = false;
    let borderWhite = false;
    while (stack.length) {
      const cur = stack.pop();
      count++;
      for (const nb of neighbors(size, cur)) {
        const v = work[nb];
        if (v === EMPTY) {
          if (!seen[nb]) {
            seen[nb] = 1;
            stack.push(nb);
          }
        } else if (v === BLACK) borderBlack = true;
        else if (v === WHITE) borderWhite = true;
      }
    }
    if (borderBlack && !borderWhite) {
      owner = BLACK;
      territoryBlack += count;
    } else if (borderWhite && !borderBlack) {
      owner = WHITE;
      territoryWhite += count;
    }
  }

  const black = stonesBlack + territoryBlack;
  const white = stonesWhite + territoryWhite + komi;
  return {
    black,
    white,
    stonesBlack,
    stonesWhite,
    territoryBlack,
    territoryWhite,
    deadBlack,
    deadWhite,
    komi,
    diff: black - white,
    winner: black > white ? BLACK : WHITE,
    margin: Math.abs(black - white),
  };
}

export function formatCoord(size, index) {
  const [x, y] = toXY(size, index);
  const letters = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
  return `${letters[x] ?? '?'}${size - y}`;
}

function normalizeDead(dead) {
  if (!dead) return null;
  if (dead instanceof Set) return dead;
  return new Set(dead);
}

export class GoGame {
  constructor(size = 9, options = {}) {
    if (![9, 13, 19].includes(size)) throw new Error(`unsupported board size: ${size}`);
    this.size = size;
    this.komi = options.komi ?? KOMPI[size] ?? 6.5;
    this.superko = options.superko !== false;
    this.reset();
  }

  reset() {
    this.board = createBoard(this.size);
    this.turn = BLACK;
    this.koPoint = -1;
    this.passes = 0;
    this.captures = { [BLACK]: 0, [WHITE]: 0 };
    this.history = [];
    this.phase = 'playing';
    this.dead = new Set();
    this._keys = new Set();
    this._keys.add(positionKey(this.board, this.turn));
    this._hash = boardHash(this.board, this.turn);
    this.lastMove = null;
  }

  get moveNumber() {
    return this.history.length;
  }

  get hash() {
    return this._hash;
  }

  index(x, y) {
    return y * this.size + x;
  }

  at(x, y) {
    return this.board[y * this.size + x];
  }

  groupAt(index) {
    return findGroup(this.board, this.size, index);
  }

  isLegal(color, index) {
    if (this.phase !== 'playing') return false;
    return tryMove(this.board, this.size, color, index, this.koPoint) !== null;
  }

  legalMoves(color = this.turn) {
    if (this.phase !== 'playing') return [];
    return legalMoves(this.board, this.size, color, this.koPoint);
  }

  /** Play one move. Mutates the game on success. */
  play(color, index, meta = null) {
    if (this.phase !== 'playing') return { ok: false, error: 'game-over' };
    if (color !== this.turn) return { ok: false, error: 'not-your-turn' };
    if (!Number.isInteger(index) || index < 0 || index >= this.board.length) {
      return { ok: false, error: 'out-of-bounds' };
    }
    if (this.board[index] !== EMPTY) return { ok: false, error: 'occupied' };
    if (index === this.koPoint) return { ok: false, error: 'ko' };

    const result = tryMove(this.board, this.size, color, index, this.koPoint);
    if (!result) return { ok: false, error: 'illegal' };

    const key = positionKey(result.board, other(color));
    if (this.superko && this._keys.has(key)) return { ok: false, error: 'superko' };

    const before = {
      board: this.board,
      turn: this.turn,
      koPoint: this.koPoint,
      passes: this.passes,
      captures: { ...this.captures },
      lastMove: this.lastMove,
      key: positionKey(this.board, this.turn),
    };

    this.board = result.board;
    this.turn = other(color);
    this.koPoint = result.nextKo;
    this.passes = 0;
    if (result.captures.length) this.captures[color] += result.captures.length;
    this.lastMove = {
      index,
      color,
      captures: result.captures,
      group: result.group.stones,
      at: Date.now(),
      meta,
    };
    this._keys.add(key);
    this._hash = boardHash(this.board, this.turn);
    this.history.push({
      type: 'move',
      color,
      index,
      captures: result.captures,
      koPoint: result.nextKo,
      before,
      key,
      hash: this._hash,
      meta,
    });
    return {
      ok: true,
      captures: result.captures,
      atari: this._atariGroups(color),
      selfAtari: result.selfAtari,
      lastMove: this.lastMove,
    };
  }

  _atariGroups(playedColor) {
    const groups = [];
    const seen = new Set();
    const opponent = other(playedColor);
    for (let i = 0; i < this.board.length; i++) {
      if (this.board[i] !== opponent || seen.has(i)) continue;
      const g = findGroup(this.board, this.size, i);
      for (const s of g.stones) seen.add(s);
      if (g.liberties.size === 1) groups.push({ stones: g.stones, liberty: [...g.liberties][0] });
    }
    return groups;
  }

  pass(color) {
    if (this.phase !== 'playing') return { ok: false, error: 'game-over' };
    if (color !== this.turn) return { ok: false, error: 'not-your-turn' };
    const before = {
      board: this.board,
      turn: this.turn,
      koPoint: this.koPoint,
      passes: this.passes,
      captures: { ...this.captures },
      lastMove: this.lastMove,
      key: positionKey(this.board, this.turn),
    };
    this.passes++;
    this.turn = other(color);
    this.koPoint = -1;
    this._hash = boardHash(this.board, this.turn);
    this.history.push({
      type: 'pass',
      color,
      index: -1,
      before,
      key: positionKey(this.board, this.turn),
      hash: this._hash,
    });
    const ended = this.passes >= 2;
    if (ended) this.phase = 'scoring';
    return { ok: true, phase: this.phase, ended };
  }

  /** Undo the last move/pass. Returns false when there is nothing to undo. */
  undo() {
    const last = this.history.pop();
    if (!last) return false;
    this.board = last.before.board;
    this.turn = last.before.turn;
    this.koPoint = last.before.koPoint;
    this.passes = last.before.passes;
    this.captures = last.before.captures;
    this.lastMove = last.before.lastMove;
    this._hash = boardHash(this.board, this.turn);
    this.phase = 'playing';
    this.dead.clear();
    if (this.superko) {
      this._keys.delete(last.key);
      // Rebuild defensively; undo is rare and this keeps superko exact.
      this._keys.clear();
      this._keys.add(last.before.key);
      for (const h of this.history) this._keys.add(h.key);
    }
    return true;
  }

  /** Rebuild from a list of wire moves. Used for P2P resync. */
  replay(moves) {
    const size = this.size;
    this.reset();
    for (const m of moves) {
      if (m.pass) {
        const r = this.pass(this.turn);
        if (!r.ok) return false;
      } else {
        const r = this.play(this.turn, m.index, m.meta);
        if (!r.ok) return false;
      }
    }
    return true;
  }

  toggleDead(index) {
    if (this.phase !== 'scoring') return null;
    if (index < 0 || index >= this.board.length || this.board[index] === EMPTY) return null;
    const g = findGroup(this.board, this.size, index);
    const allDead = g.stones.every((s) => this.dead.has(s));
    for (const s of g.stones) {
      if (allDead) this.dead.delete(s);
      else this.dead.add(s);
    }
    return { stones: g.stones, dead: !allDead };
  }

  score(dead = this.dead) {
    return scoreBoard(this.board, this.size, this.komi, normalizeDead(dead));
  }

  snapshot() {
    return {
      size: this.size,
      board: Array.from(this.board),
      turn: this.turn,
      koPoint: this.koPoint,
      passes: this.passes,
      captures: { ...this.captures },
      phase: this.phase,
      dead: [...this.dead],
      lastMove: this.lastMove ? { index: this.lastMove.index, color: this.lastMove.color } : null,
      moveNumber: this.history.length,
      hash: this._hash,
    };
  }
}
