import test from 'node:test';
import assert from 'node:assert/strict';
import { BLACK, WHITE, EMPTY, GoGame } from '../public/js/core/go.js';
import { chooseMove } from '../public/js/core/ai.js';

function emptyBoard(size) {
  return new Uint8Array(size * size);
}

function legalFrom(game, color, move) {
  if (move === -1) return true;
  return game.isLegal(color, move);
}

test('AI opens at the center of a 9x9 board', () => {
  const size = 9;
  const r = chooseMove({
    board: emptyBoard(size),
    size,
    color: BLACK,
    difficulty: 'medium',
    seed: 1,
  });
  assert.equal(r.pass, false);
  assert.equal(r.move, 40);
});

test('AI only returns legal moves on tactical boards', () => {
  const g = new GoGame(9);
  const setup = [
    [BLACK, 40],
    [WHITE, 38],
    [BLACK, 39],
    [WHITE, 30],
  ];
  for (const [c, i] of setup) assert.equal(g.play(c, i).ok, true);
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const r = chooseMove({
      board: g.board,
      size: 9,
      color: WHITE,
      koPoint: g.koPoint,
      lastMove: g.lastMove.index,
      moveNumber: g.moveNumber,
      difficulty,
      seed: 1234,
    });
    assert.ok(legalFrom(g, WHITE, r.move), `${difficulty} produced illegal ${r.move}`);
  }
});

test('AI finds an immediate capture', () => {
  const size = 9;
  const b = new Uint8Array(81);
  const I = (x, y) => y * size + x;
  // White stone at (4,4) has one liberty at (4,5). Black to play.
  b[I(4, 3)] = BLACK;
  b[I(3, 4)] = BLACK;
  b[I(5, 4)] = BLACK;
  b[I(4, 4)] = WHITE;
  const r = chooseMove({
    board: b,
    size,
    color: BLACK,
    lastMove: I(4, 3),
    moveNumber: 4,
    difficulty: 'hard',
    seed: 7,
  });
  assert.equal(r.pass, false);
  assert.equal(r.move, I(4, 5));
});

test('AI self-play terminates with legal moves', () => {
  for (const difficulty of ['easy', 'medium']) {
    const g = new GoGame(9);
    let passes = 0;
    let plies = 0;
    while (g.phase === 'playing' && plies < 220) {
      const r = chooseMove({
        board: g.board,
        size: 9,
        color: g.turn,
        koPoint: g.koPoint,
        lastMove: g.lastMove?.index ?? -1,
        moveNumber: g.moveNumber,
        difficulty,
        seed: 100 + plies,
        passes: g.passes,
      });
      if (r.pass) {
        const p = g.pass(g.turn);
        assert.equal(p.ok, true);
        passes++;
        if (p.ended) break;
      } else {
        const p = g.play(g.turn, r.move);
        assert.equal(p.ok, true, `illegal ${r.move} at ply ${plies}: ${p.error}`);
        passes = 0;
      }
      plies++;
    }
    assert.ok(plies < 220, `${difficulty} did not terminate`);
    assert.ok(passes >= 0);
  }
});

test('AI respects ko', () => {
  const size = 9;
  const b = new Uint8Array(81);
  const I = (x, y) => y * size + x;
  // Ko shape from the rules tests: black to move P=(2,2), white Q=(2,1).
  b[I(1, 1)] = BLACK;
  b[I(3, 1)] = BLACK;
  b[I(2, 0)] = BLACK;
  b[I(2, 1)] = WHITE;
  b[I(1, 2)] = WHITE;
  b[I(3, 2)] = WHITE;
  b[I(2, 3)] = WHITE;
  // Give black a ko threat far away so the board is not tiny.
  b[I(6, 6)] = WHITE;
  b[I(6, 7)] = BLACK;
  const r = chooseMove({
    board: b,
    size,
    color: BLACK,
    moveNumber: 10,
    difficulty: 'hard',
    seed: 11,
  });
  assert.ok(r.move === -1 || b[r.move] === EMPTY);
});
