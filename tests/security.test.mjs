import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_NAME_LENGTH,
  TokenBucket,
  applySecurityHeaders,
  byteSize,
  isAllowedOrigin,
  isPlainObject,
  sanitizeName,
  validBoardSize,
  validMovePayload,
  validSignalPayload,
} from '../server/security.mjs';

test('sanitizeName strips controls and markup characters', () => {
  assert.equal(sanitizeName('  <b>Ronin</b>\u0000 '), 'bRoninb');
  assert.equal(sanitizeName('Kitsune-123'), 'Kitsune-123');
  assert.equal(sanitizeName(''), 'Ronin');
  assert.equal(sanitizeName(null), 'Ronin');
  assert.equal(sanitizeName('x'.repeat(80)).length, MAX_NAME_LENGTH);
});

test('isAllowedOrigin enforces local and configured origins', () => {
  const env = {};
  assert.equal(isAllowedOrigin(undefined, 'localhost:4173', env), true);
  assert.equal(isAllowedOrigin('http://localhost:4173', 'localhost:4173', env), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:4173', '127.0.0.1:4173', env), true);
  assert.equal(isAllowedOrigin('http://192.168.1.20:4173', '192.168.1.20:4173', env), true);
  assert.equal(isAllowedOrigin('https://evil.example', 'localhost:4173', env), false);
  assert.equal(isAllowedOrigin('file://localhost', 'localhost:4173', env), false);
  assert.equal(isAllowedOrigin('not a url', 'localhost:4173', env), false);

  const locked = { ALLOWED_ORIGINS: 'https://go.example, https://beta.go.example' };
  assert.equal(isAllowedOrigin('https://go.example', 'go.example', locked), true);
  assert.equal(isAllowedOrigin('https://beta.go.example', 'go.example', locked), true);
  assert.equal(isAllowedOrigin('http://localhost:4173', 'localhost:4173', locked), false);
});

test('TokenBucket refills and refuses bursts beyond capacity', () => {
  const bucket = new TokenBucket(3, 1);
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  bucket.last -= 2000;
  assert.equal(bucket.take(), true);
});

test('move payload validation rejects malformed and oversized values', () => {
  assert.equal(validMovePayload({ type: 'move', seq: 1, index: 40, color: 1 }), true);
  assert.equal(validMovePayload({ type: 'move', seq: 1, index: 40, color: 1, hash: 'abc' }), true);
  assert.equal(validMovePayload({ type: 'move', seq: 1, index: 40, color: 3 }), false);
  assert.equal(validMovePayload({ type: 'move', seq: -1, index: 40, color: 1 }), false);
  assert.equal(validMovePayload({ type: 'move', seq: 1, index: 361, color: 1 }), false);
  assert.equal(validMovePayload({ type: 'move', seq: 1.5, index: 40, color: 1 }), false);
  assert.equal(validMovePayload({ type: 'pass', seq: 1, color: 2 }), true);
  assert.equal(validMovePayload({ type: 'resign' }), true);
  assert.equal(validMovePayload({ type: 'unknown' }), false);
  assert.equal(validMovePayload(null), false);
  assert.equal(validMovePayload({ type: 'move', seq: 1, index: 40, color: 1, pad: 'x'.repeat(5000) }), false);
});

test('signal payload validation only accepts SDP or ICE candidates', () => {
  assert.equal(validSignalPayload({ description: { type: 'offer', sdp: 'v=0' } }), true);
  assert.equal(validSignalPayload({ candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } }), true);
  assert.equal(validSignalPayload({ candidate: { sdpMid: 7 } }), false);
  assert.equal(validSignalPayload({ description: { type: 'pranswer', sdp: 'v=0' } }), false);
  assert.equal(validSignalPayload({ description: { type: 'offer', sdp: 'x'.repeat(7000) } }), false);
  assert.equal(validSignalPayload({}), false);
  assert.equal(validSignalPayload([]), false);
});

test('helpers behave predictably', () => {
  assert.equal(validBoardSize(9), true);
  assert.equal(validBoardSize(13), true);
  assert.equal(validBoardSize(19), true);
  assert.equal(validBoardSize(10), false);
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(byteSize({ a: 1 }), 7);
  assert.equal(byteSize({ toJSON() { throw new Error('no'); } }), Infinity);
});

test('security headers are strict and complete', () => {
  const headers = new Map();
  applySecurityHeaders({
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
  });
  const csp = headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(headers.get('permissions-policy'), /camera=\(\)/);
});
