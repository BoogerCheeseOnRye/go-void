import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validGamePayload } from '../public/js/net.js';

test('client accepts well-formed game messages', () => {
  assert.equal(validGamePayload({ type: 'move', seq: 1, index: 40, color: 1, hash: 'abc' }), true);
  assert.equal(validGamePayload({ type: 'pass', seq: 1, color: 2 }), true);
  assert.equal(validGamePayload({ type: 'score', dead: [] }), true);
  assert.equal(validGamePayload({ type: 'score', dead: [1, 40, 360] }), true);
  assert.equal(validGamePayload({ type: 'resign' }), true);
  assert.equal(validGamePayload({ type: 'rematch', accept: false }), true);
});

test('client rejects malformed, oversized and unknown game messages', () => {
  assert.equal(validGamePayload(null), false);
  assert.equal(validGamePayload([]), false);
  assert.equal(validGamePayload({ type: 'dance' }), false);
  assert.equal(validGamePayload({ type: 'move', seq: 1, index: 40, color: 0 }), false);
  assert.equal(validGamePayload({ type: 'move', seq: 1, index: 400, color: 1 }), false);
  assert.equal(validGamePayload({ type: 'move', seq: 1, index: 40, color: 1, hash: 'x'.repeat(17) }), false);
  assert.equal(validGamePayload({ type: 'score', dead: [1, 1] }), false);
  assert.equal(validGamePayload({ type: 'score', dead: [1.5] }), false);
  assert.equal(validGamePayload({ type: 'score', dead: [361] }), false);
  assert.equal(validGamePayload({ type: 'score', dead: Array.from({ length: 362 }, (_, i) => i) }), false);
  assert.equal(validGamePayload({ type: 'rematch' }), false);
  assert.equal(validGamePayload({ type: 'resign', extra: 'x' }), true);
});
