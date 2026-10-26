import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { applySecurityHeaders } from './security.mjs';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

function cacheControl(ext, pathname) {
  if (pathname === '/index.html' || pathname === '/' || pathname === '/sw.js') {
    return 'no-cache';
  }
  if (ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css' || ext === '.webmanifest') {
    return 'public, max-age=0, must-revalidate';
  }
  if (ext === '.woff2' || ext === '.woff' || ext === '.ttf' || ext === '.png' || ext === '.svg') {
    return 'public, max-age=604800';
  }
  return 'no-cache';
}

function safeResolve(publicDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded.split('/').some((part) => part.startsWith('.') && part !== '.')) return null;
  const normalized = path.posix.normalize(decoded);
  if (normalized.includes('..')) return null;
  const relative = normalized === '/' ? '/index.html' : normalized;
  const full = path.resolve(publicDir, `.${relative}`);
  const root = path.resolve(publicDir);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

export function createStaticHandler(publicDir, { immutable = false } = {}) {
  return async function handleStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      applySecurityHeaders(res);
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return true;
    }

    const file = safeResolve(publicDir, pathname);
    if (!file) {
      applySecurityHeaders(res);
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return true;
    }

    let info;
    try {
      info = await stat(file);
    } catch {
      return false;
    }
    if (!info.isFile()) return false;

    const ext = path.extname(file).toLowerCase();
    const type = MIME.get(ext) || 'application/octet-stream';
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      applySecurityHeaders(res);
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl(ext, pathname) });
      res.end();
      return true;
    }

    applySecurityHeaders(res);
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(info.size));
    res.setHeader('Last-Modified', info.mtime.toUTCString());
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : cacheControl(ext, pathname));
    res.setHeader('X-Robots-Tag', 'noindex');
    res.writeHead(200);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    const stream = createReadStream(file);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.destroy();
    });
    stream.pipe(res);
    return true;
  };
}
