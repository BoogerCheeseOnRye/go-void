import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { MatchHub } from './matchmaking.mjs';
import { createStaticHandler } from './static.mjs';
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  applySecurityHeaders,
  isAllowedOrigin,
} from './security.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

function json(res, status, body) {
  applySecurityHeaders(res);
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function parseIceServers(env = process.env) {
  if (env.ICE_SERVERS) {
    try {
      const parsed = JSON.parse(env.ICE_SERVERS);
      if (Array.isArray(parsed)) return parsed.slice(0, 8);
    } catch {
      /* fall through to defaults */
    }
  }
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
}

export function createGameServer(options = {}) {
  const env = options.env || process.env;
  const publicDir = options.publicDir || PUBLIC_DIR;
  const iceServers = options.iceServers || parseIceServers(env);
  const log = options.log || console;
  const serveStatic = createStaticHandler(publicDir);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (pathname === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          applySecurityHeaders(res);
          res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        json(res, 200, {
          ok: true,
          protocol: PROTOCOL_VERSION,
          uptime: Math.round(process.uptime()),
          ...hub.stats(),
        });
        return;
      }

      if (pathname === '/api/config') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          applySecurityHeaders(res);
          res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        json(res, 200, {
          protocol: PROTOCOL_VERSION,
          iceServers,
          boardSizes: [9, 13, 19],
          maxMessageBytes: MAX_MESSAGE_BYTES,
        });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        applySecurityHeaders(res);
        res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
      }

      if (await serveStatic(req, res, pathname)) return;

      applySecurityHeaders(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Not Found');
    } catch (err) {
      log.error?.('[http]', err?.message || err);
      if (!res.headersSent) {
        applySecurityHeaders(res);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Internal Server Error');
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    clientTracking: true,
  });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isAllowedOrigin(req.headers.origin, req.headers.host, env)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  const hub = new MatchHub({ wss, iceServers, log });

  async function listen(port = 4173, host = '0.0.0.0') {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    return server.address();
  }

  async function close() {
    hub.close();
    await new Promise((resolve) => {
      wss.close(() => resolve());
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
    });
    if (server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }

  return { server, wss, hub, listen, close, iceServers, publicDir };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '0.0.0.0';
  const app = createGameServer();
  app
    .listen(port, host)
    .then(() => {
      const shownHost = host === '0.0.0.0' ? 'localhost' : host;
      console.log(`\n  GO/VOID  http://${shownHost}:${port}\n`);
      console.log(`  websocket ws://${shownHost}:${port}/ws`);
      console.log(`  ice: ${JSON.stringify(app.iceServers)}\n`);
    })
    .catch((err) => {
      console.error('failed to start:', err);
      process.exitCode = 1;
    });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[${signal}] shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('[uncaught]', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[unhandled]', err);
  });
}
