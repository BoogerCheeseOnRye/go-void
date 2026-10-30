import { createHash } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 8192;
export const MAX_RELAY_BYTES = 4096;
export const MAX_SIGNAL_BYTES = 6144;
export const MAX_NAME_LENGTH = 14;
export const MAX_CLIENTS = 500;
export const MAX_CLIENTS_PER_IP = 12;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const NAME_ALLOWED = /[^\p{L}\p{N} _.\-·'’]/gu;

/**
 * Names are display-only, never used as selectors or HTML. Still, keep them
 * bounded, strip controls and disallow markup characters by allowlist.
 */
export function sanitizeName(input, fallback = 'Ronin') {
  if (typeof input !== 'string') return fallback;
  const cleaned = input
    .normalize('NFKC')
    .replace(CONTROL, '')
    .replace(NAME_ALLOWED, '')
    .trim();
  const value = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('');
  return value.length >= 1 ? value : fallback;
}

export function stableHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export function applySecurityHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self' ws: wss:",
      "media-src 'self' blob:",
      "worker-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Origin-Agent-Cluster', '?1');
}

export function parseAllowedOrigins(env = process.env) {
  if (!env.ALLOWED_ORIGINS) return [];
  return env.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The game is same-origin. Allow localhost/LAN development, the configured
 * allowlist, and the request host. A missing Origin is allowed for native
 * clients, but browsers always send one for WebSocket.
 */
export function isAllowedOrigin(origin, hostHeader, env = process.env) {
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const allowed = parseAllowedOrigins(env);
  if (allowed.length && allowed.includes(parsed.origin)) return true;
  if (!allowed.length) {
    if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) return true;
    if (hostHeader && parsed.host === hostHeader) return true;
    // Private LAN origins (phones on the same Wi-Fi) are useful when testing.
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.hostname)) return true;
  }
  return false;
}

export class TokenBucket {
  constructor(capacity = 30, refillPerSecond = 3) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.last = Date.now();
  }

  take(cost = 1) {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.last) / 1000) * this.refillPerSecond,
    );
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

export function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

export function byteSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Infinity;
  }
}

export function validBoardSize(value) {
  return value === 9 || value === 13 || value === 19;
}

export function validMovePayload(payload) {
  if (!isPlainObject(payload)) return false;
  if (byteSize(payload) > MAX_RELAY_BYTES) return false;
  const type = payload.type;
  if (typeof type !== 'string' || type.length > 24) return false;
  if (type === 'move') {
    return (
      Number.isInteger(payload.seq) &&
      payload.seq >= 0 &&
      payload.seq < 1_000_000 &&
      Number.isInteger(payload.index) &&
      payload.index >= 0 &&
      payload.index < 361 &&
      (payload.color === 1 || payload.color === 2) &&
      (payload.hash === undefined ||
        (typeof payload.hash === 'string' && payload.hash.length <= 16))
    );
  }
  if (type === 'pass') {
    return (
      Number.isInteger(payload.seq) &&
      payload.seq >= 0 &&
      payload.seq < 1_000_000 &&
      (payload.color === 1 || payload.color === 2)
    );
  }
  if (type === 'score') {
    if (!Array.isArray(payload.dead) || payload.dead.length > 361) return false;
    const seen = new Set();
    for (const index of payload.dead) {
      if (!Number.isInteger(index) || index < 0 || index >= 361 || seen.has(index)) return false;
      seen.add(index);
    }
    return true;
  }
  if (type === 'resign' || type === 'hello' || type === 'sync' || type === 'rematch' || type === 'emote') {
    return true;
  }
  return false;
}

export function validSignalPayload(data) {
  if (!isPlainObject(data) || byteSize(data) > MAX_SIGNAL_BYTES) return false;
  if (data.description !== undefined) {
    if (!isPlainObject(data.description)) return false;
    if (data.description.type !== 'offer' && data.description.type !== 'answer') return false;
    if (typeof data.description.sdp !== 'string' || data.description.sdp.length > 6000) return false;
  }
  if (data.candidate !== undefined && data.candidate !== null) {
    if (!isPlainObject(data.candidate)) return false;
    if (data.candidate.candidate !== undefined && typeof data.candidate.candidate !== 'string') return false;
    if (data.candidate.candidate && data.candidate.candidate.length > 512) return false;
    if (data.candidate.sdpMid !== undefined && data.candidate.sdpMid !== null && typeof data.candidate.sdpMid !== 'string') {
      return false;
    }
    if (
      data.candidate.sdpMLineIndex !== undefined &&
      data.candidate.sdpMLineIndex !== null &&
      !Number.isInteger(data.candidate.sdpMLineIndex)
    ) {
      return false;
    }
  }
  return data.description !== undefined || data.candidate !== undefined;
}
