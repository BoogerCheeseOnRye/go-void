import { randomUUID, randomInt } from 'node:crypto';
import {
  MAX_CLIENTS,
  MAX_CLIENTS_PER_IP,
  MAX_MESSAGE_BYTES,
  MAX_RELAY_BYTES,
  MAX_SIGNAL_BYTES,
  PROTOCOL_VERSION,
  TokenBucket,
  byteSize,
  isPlainObject,
  sanitizeName,
  validBoardSize,
  validMovePayload,
  validSignalPayload,
} from './security.mjs';

const BLACK = 1;
const WHITE = 2;
const QUEUE_TIMEOUT_MS = 120_000;
const HEARTBEAT_MS = 30_000;

function wsOpen(ws) {
  return ws && ws.readyState === 1;
}

export class MatchHub {
  constructor({ wss, iceServers = [], log = console, queueTimeoutMs = QUEUE_TIMEOUT_MS }) {
    this.wss = wss;
    this.iceServers = iceServers;
    this.log = log;
    this.clients = new Map();
    this.rooms = new Map();
    this.queues = new Map([
      [9, []],
      [13, []],
      [19, []],
    ]);
    this.ipCounts = new Map();
    this.queueTimeoutMs = queueTimeoutMs;
    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
    wss.on('connection', (ws, req) => this.onConnection(ws, req));
  }

  onConnection(ws, req) {
    if (this.wss.clients.size > MAX_CLIENTS) {
      ws.close(1013, 'server-full');
      return;
    }
    const ip = req.socket.remoteAddress || 'unknown';
    const ipCount = this.ipCounts.get(ip) || 0;
    if (ipCount >= MAX_CLIENTS_PER_IP) {
      ws.close(1013, 'too-many-connections');
      return;
    }
    this.ipCounts.set(ip, ipCount + 1);

    const client = {
      id: randomUUID(),
      ws,
      ip,
      name: 'Ronin',
      roomId: null,
      color: null,
      queuedAt: 0,
      alive: true,
      bucket: new TokenBucket(40, 4),
      connectedAt: Date.now(),
    };
    this.clients.set(client.id, client);

    ws.binaryType = 'nodebuffer';
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.sendError(client, 'binary-not-supported', 'Binary messages are not supported.');
        return;
      }
      this.onMessage(client, data);
    });
    ws.on('close', () => this.onClose(client));
    ws.on('error', () => this.onClose(client));

    this.send(client, {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      clientId: client.id,
      maxMessageBytes: MAX_MESSAGE_BYTES,
    });
  }

  onMessage(client, data) {
    if (!client.bucket.take()) {
      this.sendError(client, 'rate-limited', 'Too many messages. Slow down.');
      return;
    }
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (raw.byteLength > MAX_MESSAGE_BYTES) {
      this.sendError(client, 'too-large', 'Message too large.');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      this.sendError(client, 'bad-json', 'Invalid JSON.');
      return;
    }
    if (!isPlainObject(msg) || typeof msg.type !== 'string') {
      this.sendError(client, 'bad-message', 'Expected an object with a type.');
      return;
    }

    switch (msg.type) {
      case 'queue':
        return this.onQueue(client, msg);
      case 'cancel':
        return this.onCancel(client);
      case 'signal':
        return this.onSignal(client, msg);
      case 'relay':
        return this.onRelay(client, msg);
      case 'leave':
        return this.onLeave(client);
      case 'rematch':
        return this.onRematch(client, msg);
      case 'ping':
        return this.send(client, { type: 'pong', t: Date.now() });
      default:
        return this.sendError(client, 'unknown-type', 'Unknown message type.');
    }
  }

  onQueue(client, msg) {
    if (client.roomId) {
      this.sendError(client, 'already-matched', 'You are already in a match.');
      return;
    }
    const size = msg.boardSize;
    if (!validBoardSize(size)) {
      this.sendError(client, 'bad-size', 'Board size must be 9, 13 or 19.');
      return;
    }
    client.name = sanitizeName(msg.name, client.name);
    this.removeFromQueue(client);

    const queue = this.queues.get(size);
    if (!queue) {
      this.sendError(client, 'bad-size', 'Unsupported board size.');
      return;
    }
    if (queue.length >= 200) {
      this.sendError(client, 'queue-full', 'That queue is full. Try again soon.');
      return;
    }

    for (const candidateId of queue) {
      const other = this.clients.get(candidateId);
      if (!other || !wsOpen(other.ws) || other.id === client.id) continue;
      const idx = queue.indexOf(candidateId);
      if (idx !== -1) queue.splice(idx, 1);
      this.createRoom(client, other, size);
      return;
    }

    client.queuedAt = Date.now();
    client.roomId = null;
    queue.push(client.id);
    this.send(client, {
      type: 'queued',
      boardSize: size,
      position: queue.length,
      queuedAt: client.queuedAt,
    });
  }

  onCancel(client) {
    const wasQueued = this.removeFromQueue(client);
    this.send(client, { type: 'cancelled', wasQueued });
  }

  createRoom(a, b, size) {
    const roomId = randomUUID();
    const aBlack = randomInt(2) === 0;
    const players = [
      { id: a.id, color: aBlack ? BLACK : WHITE, initiator: true },
      { id: b.id, color: aBlack ? WHITE : BLACK, initiator: false },
    ];
    const room = {
      id: roomId,
      size,
      players: new Map(players.map((p) => [p.id, p])),
      createdAt: Date.now(),
    };
    this.rooms.set(roomId, room);
    a.roomId = roomId;
    b.roomId = roomId;
    a.color = room.players.get(a.id).color;
    b.color = room.players.get(b.id).color;
    a.queuedAt = 0;
    b.queuedAt = 0;
    a.name = a.name || 'Ronin';
    b.name = b.name || 'Ronin';

    for (const [self, peer] of [
      [a, b],
      [b, a],
    ]) {
      this.send(self, {
        type: 'matched',
        protocol: PROTOCOL_VERSION,
        roomId,
        boardSize: size,
        color: room.players.get(self.id).color,
        initiator: room.players.get(self.id).initiator,
        opponent: { id: peer.id, name: peer.name },
        iceServers: this.iceServers,
        relayAvailable: true,
      });
    }
  }

  onSignal(client, msg) {
    const room = this.rooms.get(client.roomId);
    if (!room) {
      this.sendError(client, 'not-matched', 'You are not in a match.');
      return;
    }
    if (!validSignalPayload(msg.data)) {
      this.sendError(client, 'bad-signal', 'Invalid WebRTC signal.');
      return;
    }
    const peer = this.peerOf(room, client.id);
    if (!peer) {
      this.sendError(client, 'peer-gone', 'Opponent is no longer connected.');
      return;
    }
    this.send(peer, { type: 'signal', from: client.id, data: msg.data });
  }

  onRelay(client, msg) {
    const room = this.rooms.get(client.roomId);
    if (!room) {
      this.sendError(client, 'not-matched', 'You are not in a match.');
      return;
    }
    if (!validMovePayload(msg.payload)) {
      this.sendError(client, 'bad-payload', 'Invalid game message.');
      return;
    }
    if (byteSize(msg.payload) > MAX_RELAY_BYTES) {
      this.sendError(client, 'too-large', 'Game message too large.');
      return;
    }
    const peer = this.peerOf(room, client.id);
    if (!peer) {
      this.sendError(client, 'peer-gone', 'Opponent is no longer connected.');
      return;
    }
    this.send(peer, { type: 'relay', from: client.id, payload: msg.payload });
  }

  onRematch(client, msg) {
    const room = this.rooms.get(client.roomId);
    if (!room) {
      this.sendError(client, 'not-matched', 'You are not in a match.');
      return;
    }
    const peer = this.peerOf(room, client.id);
    if (!peer) {
      this.sendError(client, 'peer-gone', 'Opponent is no longer connected.');
      return;
    }
    this.send(peer, { type: 'rematch-offer', from: client.id, accept: msg.accept === true });
  }

  onLeave(client) {
    const room = this.rooms.get(client.roomId);
    if (room) {
      const peer = this.peerOf(room, client.id);
      if (peer) this.send(peer, { type: 'peer-left', reason: 'left' });
      this.destroyRoom(room.id);
    }
    this.removeFromQueue(client);
    this.send(client, { type: 'left' });
  }

  peerOf(room, id) {
    for (const player of room.players.values()) {
      if (player.id === id) continue;
      return this.clients.get(player.id);
    }
    return null;
  }

  removeFromQueue(client) {
    let removed = false;
    for (const queue of this.queues.values()) {
      const idx = queue.indexOf(client.id);
      if (idx !== -1) {
        queue.splice(idx, 1);
        removed = true;
      }
    }
    client.queuedAt = 0;
    return removed;
  }

  destroyRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const player of room.players.values()) {
      const client = this.clients.get(player.id);
      if (client) {
        client.roomId = null;
        client.color = null;
      }
    }
    this.rooms.delete(roomId);
  }

  onClose(client) {
    if (!this.clients.has(client.id)) return;
    const room = this.rooms.get(client.roomId);
    if (room) {
      const peer = this.peerOf(room, client.id);
      if (peer) this.send(peer, { type: 'peer-left', reason: 'disconnected' });
      this.destroyRoom(room.id);
    }
    this.removeFromQueue(client);
    this.clients.delete(client.id);
    const count = (this.ipCounts.get(client.ip) || 1) - 1;
    if (count <= 0) this.ipCounts.delete(client.ip);
    else this.ipCounts.set(client.ip, count);
  }

  send(client, obj) {
    if (!client || !wsOpen(client.ws)) return false;
    try {
      client.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  sendError(client, code, message) {
    this.send(client, { type: 'error', code, message });
  }

  tick() {
    const now = Date.now();
    for (const client of this.clients.values()) {
      if (!client.alive) {
        client.ws.terminate();
        this.onClose(client);
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        client.ws.terminate();
      }
      if (client.queuedAt && now - client.queuedAt > this.queueTimeoutMs) {
        this.removeFromQueue(client);
        this.send(client, { type: 'queue-timeout' });
      }
    }
    for (const [roomId, room] of this.rooms) {
      if (now - room.createdAt > 6 * 60 * 60 * 1000) {
        for (const player of room.players.values()) {
          const c = this.clients.get(player.id);
          if (c) this.send(c, { type: 'peer-left', reason: 'room-expired' });
        }
        this.destroyRoom(roomId);
      }
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients.values()) {
      try {
        client.ws.close(1001, 'server-shutdown');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.rooms.clear();
    for (const q of this.queues.values()) q.length = 0;
  }

  stats() {
    return {
      clients: this.clients.size,
      rooms: this.rooms.size,
      queued: [...this.queues.values()].reduce((n, q) => n + q.length, 0),
      bySize: Object.fromEntries([...this.queues.entries()].map(([size, q]) => [size, q.length])),
    };
  }
}
