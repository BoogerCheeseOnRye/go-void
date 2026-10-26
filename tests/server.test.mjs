import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createGameServer } from '../server/server.mjs';

const quiet = { error() {}, warn() {}, log() {} };

function connect(port, origin = `http://127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
    const queue = [];
    const waiters = [];
    const client = {
      ws,
      closed: false,
      send(message) {
        ws.send(typeof message === 'string' ? message : JSON.stringify(message));
      },
      next(type, timeout = 3000) {
        const existing = queue.findIndex((msg) => msg.type === type);
        if (existing !== -1) return Promise.resolve(queue.splice(existing, 1)[0]);
        return new Promise((res, rej) => {
          const waiter = { type, res, rej };
          waiter.timer = setTimeout(() => {
            const idx = waiters.indexOf(waiter);
            if (idx !== -1) waiters.splice(idx, 1);
            rej(new Error(`timed out waiting for ${type}; queue=${JSON.stringify(queue)}`));
          }, timeout);
          waiters.push(waiter);
        });
      },
      close() {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    };
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const idx = waiters.findIndex((w) => w.type === msg.type);
      if (idx !== -1) {
        const [waiter] = waiters.splice(idx, 1);
        clearTimeout(waiter.timer);
        waiter.res(msg);
      } else {
        queue.push(msg);
      }
    });
    ws.on('close', () => {
      client.closed = true;
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.rej(new Error('socket closed'));
      }
    });
    ws.once('error', reject);
    ws.once('open', () => {
      ws.off('error', reject);
      ws.on('error', () => {});
      resolve(client);
    });
  });
}

async function withServer(fn) {
  const app = createGameServer({ log: quiet, env: {} });
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ app, base, port: address.port });
  } finally {
    await app.close();
  }
}

test('HTTP surface serves the app with security headers', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    const html = await res.text();
    assert.match(html, /GO\/VOID/);
    assert.match(html, /\/js\/main\.js/);

    const health = await fetch(base + '/healthz');
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.protocol, 1);
    assert.equal(body.queued, 0);

    const config = await fetch(base + '/api/config');
    assert.equal(config.status, 200);
    assert.deepEqual((await config.json()).boardSizes, [9, 13, 19]);

    const manifest = await fetch(base + '/manifest.webmanifest');
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
    assert.equal((await manifest.json()).icons.length, 4);

    const missing = await fetch(base + '/does-not-exist');
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-security-policy'), /default-src 'self'/);

    const post = await fetch(base + '/', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  });
});

test('static handler refuses traversal and dotfiles', async () => {
  await withServer(async ({ base }) => {
    for (const path of [
      '/server/server.mjs',
      '/%2e%2e/server/server.mjs',
      '/..%2f..%2fetc%2fpasswd',
      '/.env',
      '/icons/%00.png',
    ]) {
      const res = await fetch(base + path);
      assert.ok(res.status === 400 || res.status === 404, `${path} -> ${res.status}`);
      assert.notEqual(res.status, 200);
    }
  });
});

test('WebSocket matchmaking pairs two peers and relays validated moves', async () => {
  await withServer(async ({ port }) => {
    const a = await connect(port);
    const b = await connect(port);
    const helloA = await a.next('hello');
    const helloB = await b.next('hello');
    assert.equal(helloA.protocol, 1);
    assert.equal(typeof helloA.clientId, 'string');
    assert.notEqual(helloA.clientId, helloB.clientId);

    a.send({ type: 'queue', boardSize: 9, name: '<script>Ronin</script>' });
    const queued = await a.next('queued');
    assert.equal(queued.boardSize, 9);
    assert.equal(queued.position, 1);

    b.send({ type: 'queue', boardSize: 9, name: 'Kitsune' });
    const [matchedA, matchedB] = await Promise.all([a.next('matched'), b.next('matched')]);
    assert.equal(matchedA.roomId, matchedB.roomId);
    assert.equal(matchedA.boardSize, 9);
    assert.notEqual(matchedA.color, matchedB.color);
    assert.equal([1, 2].includes(matchedA.color), true);
    assert.equal(matchedA.opponent.name, 'Kitsune');
    assert.equal(matchedB.opponent.name, 'scriptRoninscr');
    assert.equal(matchedA.iceServers.length >= 0, true);

    a.send({ type: 'relay', payload: { type: 'move', seq: 1, index: 40, color: 1, hash: 'abc' } });
    const relayed = await b.next('relay');
    assert.deepEqual(relayed.payload, { type: 'move', seq: 1, index: 40, color: 1, hash: 'abc' });

    a.send({ type: 'relay', payload: { type: 'score', dead: [3, 4, 9] } });
    const score = await b.next('relay');
    assert.deepEqual(score.payload, { type: 'score', dead: [3, 4, 9] });

    a.send({ type: 'relay', payload: { type: 'move', seq: 2, index: 361, color: 1 } });
    const rejection = await a.next('error');
    assert.equal(rejection.code, 'bad-payload');

    a.send({ type: 'relay', payload: { type: 'score', dead: [1, 1] } });
    const badScore = await a.next('error');
    assert.equal(badScore.code, 'bad-payload');

    a.send({ type: 'rematch', accept: true });
    const offer = await b.next('rematch-offer');
    assert.equal(offer.accept, true);

    a.close();
    const left = await b.next('peer-left');
    assert.equal(left.reason, 'disconnected');
    b.close();
  });
});

test('WebSocket rejects hostile origins, binary frames and malformed payloads', async () => {
  await withServer(async ({ port }) => {
    await assert.rejects(connect(port, 'https://evil.example'), /403/);

    const client = await connect(port);
    await client.next('hello');

    const errors = [];
    client.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'error') errors.push(msg);
      } catch {
        /* ignore */
      }
    });

    client.ws.send(Buffer.from([0, 1, 2]));
    client.send('{bad json');
    client.send({ type: 'queue', boardSize: 12 });
    await new Promise((resolve) => setTimeout(resolve, 240));

    assert.equal(errors.some((e) => e.code === 'binary-not-supported'), true);
    assert.equal(errors.some((e) => e.code === 'bad-json'), true);
    assert.equal(errors.some((e) => e.code === 'bad-size'), true);

    const peer = await connect(port);
    await peer.next('hello');
    client.send({ type: 'queue', boardSize: 9, name: 'Ronin' });
    await client.next('queued');
    peer.send({ type: 'queue', boardSize: 9, name: 'Kitsune' });
    await Promise.all([client.next('matched'), peer.next('matched')]);

    client.send({ type: 'signal', data: { description: { type: 'offer', sdp: 'x'.repeat(7000) } } });
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(errors.some((e) => e.code === 'bad-signal'), true);
    client.close();
    peer.close();
  });
});
