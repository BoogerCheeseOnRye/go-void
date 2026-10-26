/* GO/VOID — AI worker. Keeps deep searches off the render thread. */

import { chooseMove } from '../core/ai.js';

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'move' || typeof msg.id !== 'number') return;
  const size = msg.size;
  if (size !== 9 && size !== 13 && size !== 19) return;
  if (!Array.isArray(msg.board) || msg.board.length !== size * size) return;
  if (msg.color !== 1 && msg.color !== 2) return;
  try {
    const result = chooseMove({
      board: Uint8Array.from(msg.board),
      size,
      color: msg.color,
      koPoint: Number.isInteger(msg.koPoint) ? msg.koPoint : -1,
      lastMove: Number.isInteger(msg.lastMove) ? msg.lastMove : -1,
      moveNumber: Number.isInteger(msg.moveNumber) ? msg.moveNumber : 0,
      difficulty: typeof msg.difficulty === 'string' ? msg.difficulty : 'medium',
      komi: typeof msg.komi === 'number' ? msg.komi : 6.5,
      seed: Number.isInteger(msg.seed) ? msg.seed >>> 0 : undefined,
      passes: Number.isInteger(msg.passes) ? msg.passes : 0,
    });
    self.postMessage({ id: msg.id, type: 'result', result });
  } catch (err) {
    self.postMessage({ id: msg.id, type: 'error', message: String(err?.message || err) });
  }
};
