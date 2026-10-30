/* GO/VOID — matchmaking, WebRTC data channel and relay fallback. */

const GAME_TYPES = new Set(['move', 'pass', 'score', 'resign', 'rematch']);
const MAX_PEER_MESSAGE = 4096;

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

export function validGamePayload(payload) {
  if (!isPlainObject(payload)) return false;
  const type = payload.type;
  if (typeof type !== 'string' || !GAME_TYPES.has(type)) return false;
  if (type === 'move') {
    return (
      Number.isInteger(payload.seq) &&
      payload.seq >= 0 &&
      payload.seq < 1_000_000 &&
      Number.isInteger(payload.index) &&
      payload.index >= 0 &&
      payload.index < 361 &&
      (payload.color === 1 || payload.color === 2) &&
      (payload.hash === undefined || (typeof payload.hash === 'string' && payload.hash.length <= 16))
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
  if (type === 'resign') return true;
  if (type === 'rematch') return typeof payload.accept === 'boolean';
  return false;
}

function randomCallsign() {
  const words = ['RONIN', 'KITSUNE', 'YUREI', 'ONI', 'TENGU', 'KAGE', 'RYU', 'HOSHI'];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 900 + 100)}`;
}

export class NetClient {
  constructor(options = {}) {
    this.name = options.name || randomCallsign();
    this.forceRelay = options.forceRelay === true;
    this.url = typeof options.url === 'string' && options.url ? options.url : null;
    this.listeners = new Map();
    this.ws = null;
    this.clientId = null;
    this.wsReady = false;
    this.closed = false;
    this.room = null;
    this.color = null;
    this.peerName = null;
    this.opponentId = null;
    this.pc = null;
    this.channel = null;
    this.mode = null;
    this.readyEmitted = false;
    this.relayTimer = null;
    this.connTimer = null;
    this.pendingCandidates = [];
    this.boardSize = 9;
    this._connectPromise = null;
    this._connectResolve = null;
    this._connectReject = null;
  }

  on(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
    return () => this.listeners.get(type)?.delete(handler);
  }

  emit(type, detail = {}) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(detail);
      } catch (err) {
        console.error(`[net:${type}]`, err);
      }
    }
  }

  connect() {
    if (this.wsReady) return Promise.resolve({ clientId: this.clientId });
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;
    });
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = this.url || `${protocol}//${location.host}/ws`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this._connectReject?.(err);
      return this._connectPromise;
    }
    this.ws = ws;
    this.connTimer = setTimeout(() => {
      if (!this.wsReady) {
        this._connectReject?.(new Error('Signalling timed out.'));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    }, 9000);

    ws.addEventListener('open', () => {
      this.emit('status', { state: 'signalling' });
    });
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isPlainObject(msg) || typeof msg.type !== 'string') return;
      this._onWsMessage(msg);
    });
    ws.addEventListener('error', () => {
      this.emit('error', { code: 'network', message: 'Could not reach the matchmaking relay.' });
    });
    ws.addEventListener('close', () => {
      clearTimeout(this.connTimer);
      this.wsReady = false;
      if (!this.room && this._connectReject) {
        this._connectReject(new Error('Matchmaking connection closed.'));
      } else if (this.room) {
        this.emit('peer-left', { reason: 'relay-closed' });
      }
      this.emit('status', { state: 'closed' });
    });
    return this._connectPromise;
  }

  queue(boardSize) {
    this.boardSize = boardSize;
    this._sendWs({ type: 'queue', boardSize, name: this.name });
  }

  cancel() {
    this._sendWs({ type: 'cancel' });
  }

  sendRematch(accept) {
    this._sendWs({ type: 'rematch', accept: Boolean(accept) });
  }

  /** Send a validated game message over the data channel or relay. */
  sendGame(payload) {
    if (!validGamePayload(payload)) return false;
    const raw = JSON.stringify(payload);
    if (this.mode === 'p2p' && this.channel && this.channel.readyState === 'open') {
      try {
        this.channel.send(raw);
        return true;
      } catch {
        /* fall through to relay */
      }
    }
    if (this.wsReady) {
      this._sendWs({ type: 'relay', payload });
      return true;
    }
    return false;
  }

  _sendWs(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  _onWsMessage(msg) {
    switch (msg.type) {
      case 'hello':
        this.clientId = typeof msg.clientId === 'string' ? msg.clientId : null;
        this.wsReady = true;
        clearTimeout(this.connTimer);
        this._connectResolve?.({ clientId: this.clientId });
        this._connectResolve = null;
        this._connectReject = null;
        this.emit('status', { state: 'online' });
        break;
      case 'queued':
        this.emit('queued', {
          boardSize: msg.boardSize,
          position: Number.isInteger(msg.position) ? msg.position : 1,
        });
        break;
      case 'cancelled':
        this.emit('cancelled', {});
        break;
      case 'matched':
        this._onMatched(msg);
        break;
      case 'signal':
        this._onSignal(msg);
        break;
      case 'relay':
        if (validGamePayload(msg.payload)) {
          this.emit('message', { payload: msg.payload, mode: 'relay' });
        }
        break;
      case 'peer-left':
        this.emit('peer-left', { reason: typeof msg.reason === 'string' ? msg.reason : 'left' });
        break;
      case 'rematch-offer':
        this.emit('rematch-offer', { accept: msg.accept === true });
        break;
      case 'left':
        this.emit('left', {});
        break;
      case 'queue-timeout':
        this.emit('timeout', {});
        break;
      case 'error':
        this.emit('error', {
          code: typeof msg.code === 'string' ? msg.code : 'error',
          message: typeof msg.message === 'string' ? msg.message.slice(0, 160) : 'Matchmaking error.',
        });
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  _onMatched(msg) {
    if (msg.boardSize !== 9 && msg.boardSize !== 13 && msg.boardSize !== 19) return;
    if (msg.color !== 1 && msg.color !== 2) return;
    this.room = typeof msg.roomId === 'string' ? msg.roomId : null;
    this.color = msg.color;
    this.boardSize = msg.boardSize;
    this.opponentId = typeof msg.opponent?.id === 'string' ? msg.opponent.id : null;
    this.peerName =
      typeof msg.opponent?.name === 'string'
        ? Array.from(msg.opponent.name).slice(0, 14).join('')
        : 'RIVAL';
    const iceServers = Array.isArray(msg.iceServers) ? msg.iceServers.slice(0, 8) : [];
    this.emit('matched', {
      boardSize: this.boardSize,
      color: this.color,
      opponent: { name: this.peerName, id: this.opponentId },
      initiator: msg.initiator === true,
      iceServers,
    });
    if (this.forceRelay || typeof RTCPeerConnection === 'undefined') {
      this._chooseRelay('relay-unavailable');
      return;
    }
    this._setupPeer({ iceServers, initiator: msg.initiator === true });
  }

  _setupPeer({ iceServers, initiator }) {
    try {
      this.pc = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 2,
        bundlePolicy: 'max-bundle',
      });
    } catch {
      this._chooseRelay('webrtc-failed');
      return;
    }
    const pc = this.pc;
    this.relayTimer = setTimeout(() => {
      if (!this.readyEmitted) this._chooseRelay('ice-timeout');
    }, 5200);

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        this._sendWs({
          type: 'signal',
          data: { candidate: event.candidate.toJSON?.() || event.candidate },
        });
      }
    });
    pc.addEventListener('connectionstatechange', () => {
      const state = pc.connectionState;
      if (state === 'failed') {
        if (!this.readyEmitted) this._chooseRelay('ice-failed');
        else if (this.mode === 'p2p') {
          this.mode = 'relay';
          this.emit('mode', { mode: 'relay' });
        }
      }
    });
    pc.addEventListener('datachannel', (event) => this._bindChannel(event.channel));

    if (initiator) {
      try {
        const channel = pc.createDataChannel('go-void', { ordered: true });
        this._bindChannel(channel);
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => {
            this._sendWs({ type: 'signal', data: { description: pc.localDescription } });
          })
          .catch(() => this._chooseRelay('offer-failed'));
      } catch {
        this._chooseRelay('offer-failed');
      }
    }
  }

  async _onSignal(msg) {
    if (!this.pc || !isPlainObject(msg.data)) return;
    const pc = this.pc;
    try {
      if (msg.data.description) {
        await pc.setRemoteDescription(msg.data.description);
        if (this.pendingCandidates.length) {
          for (const candidate of this.pendingCandidates.splice(0)) {
            await pc.addIceCandidate(candidate).catch(() => {});
          }
        }
        if (msg.data.description.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this._sendWs({ type: 'signal', data: { description: pc.localDescription } });
        }
      } else if (msg.data.candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(msg.data.candidate).catch(() => {});
        } else {
          this.pendingCandidates.push(msg.data.candidate);
        }
      }
    } catch {
      this._chooseRelay('signal-failed');
    }
  }

  _bindChannel(channel) {
    this.channel = channel;
    channel.addEventListener('open', () => {
      if (this.readyEmitted) return;
      clearTimeout(this.relayTimer);
      this.mode = 'p2p';
      this.peerReady = true;
      this._emitReady('p2p');
    });
    channel.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || event.data.length > MAX_PEER_MESSAGE) return;
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (validGamePayload(payload)) {
        this.emit('message', { payload, mode: 'p2p' });
      }
    });
    channel.addEventListener('close', () => {
      if (this.mode === 'p2p' && !this.closed) this.emit('mode', { mode: 'relay' });
      this.mode = this.mode === 'p2p' ? 'relay' : this.mode;
    });
  }

  _chooseRelay(reason) {
    if (this.readyEmitted) return;
    clearTimeout(this.relayTimer);
    this.mode = 'relay';
    this.peerReady = true;
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this._emitReady('relay', reason);
  }

  _emitReady(mode, reason = '') {
    if (this.readyEmitted) return;
    this.readyEmitted = true;
    this.emit('ready', { mode, reason });
  }

  leave() {
    this._sendWs({ type: 'leave' });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.relayTimer);
    clearTimeout(this.connTimer);
    try {
      if (this.room) this._sendWs({ type: 'leave' });
    } catch {
      /* ignore */
    }
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.channel = null;
    this.pc = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.wsReady = false;
    this.room = null;
    this.emit('closed', {});
  }
}
