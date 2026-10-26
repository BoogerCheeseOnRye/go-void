/* GO/VOID — app controller: menu, touch board, AI, scoring and P2P duels. */

import { Renderer } from './render/renderer.js';
import {
  GoGame,
  BLACK,
  WHITE,
  other,
  colorName,
  KOMPI,
} from './core/go.js';
import { Soundscape } from './audio.js';
import { fireImpact, clearImpact } from './impact.js';
import { NetClient } from './net.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'go-void:settings:v2';
const DEFAULTS = {
  quality: 'auto',
  motion: 'full',
  sound: 'on',
  haptics: 'on',
  size: 9,
  mode: 'local',
  difficulty: 'medium',
  color: '1',
};

function loadSettings() {
  const out = { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      if (['auto', 'high', 'low'].includes(raw.quality)) out.quality = raw.quality;
      if (['full', 'reduced'].includes(raw.motion)) out.motion = raw.motion;
      if (['on', 'off'].includes(raw.sound)) out.sound = raw.sound;
      if (['on', 'off'].includes(raw.haptics)) out.haptics = raw.haptics;
      if ([9, 13, 19].includes(raw.size)) out.size = raw.size;
      if (['local', 'ai', 'online'].includes(raw.mode)) out.mode = raw.mode;
      if (['easy', 'medium', 'hard', 'insane'].includes(raw.difficulty)) out.difficulty = raw.difficulty;
      if (['0', '1', '2'].includes(raw.color)) out.color = raw.color;
    }
  } catch {
    /* use defaults */
  }
  return out;
}

const settings = loadSettings();
const mediaReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const bootParams = new URLSearchParams(location.search);
const queryMode = bootParams.get('mode');
if (['local', 'ai', 'online'].includes(queryMode)) settings.mode = queryMode;

const state = {
  screen: 'menu',
  mode: settings.mode,
  boardSize: settings.size,
  difficulty: settings.difficulty,
  humanColor: BLACK,
  aiColor: WHITE,
  game: null,
  finished: false,
  startedAt: 0,
  thinking: false,
  aiToken: 0,
  aiTimer: null,
  scoringTimer: null,
  net: null,
  netReady: false,
  netMode: null,
  online: null,
  matchFound: false,
  startTimer: null,
  rematchOffer: false,
  rematchRequested: false,
  scoreSent: false,
  remoteScore: null,
  lastResult: null,
  installPrompt: null,
  booted: false,
};

const sound = new Soundscape();
sound.setEnabled(settings.sound === 'on');
sound.setHaptics(settings.haptics === 'on');

let renderer = null;
let modalOnClose = null;
let modalDismissible = true;
let chooseMoveFallback = null;
let aiWorker = null;
let aiWorkerFailed = false;
let aiReqId = 0;
const aiPending = new Map();

const el = {};

function cacheElements() {
  el.app = $('app');
  el.canvas = $('gl');
  el.loading = $('loading-screen');
  el.loadStatus = $('load-status');
  el.screenMenu = $('menu-screen');
  el.screenGame = $('game-screen');
  el.menuPanel = document.querySelector('.menu-panel');
  el.sizeSelect = $('size-select');
  el.modeGrid = $('mode-grid');
  el.aiOptions = $('ai-options');
  el.difficultySelect = $('difficulty-select');
  el.colorSelect = $('color-select');
  el.startBtn = $('start-btn');
  el.menuNote = $('menu-note');
  el.rulesBtn = $('btn-rules');
  el.settingsBtn = $('btn-settings');
  el.installBtn = $('btn-install');
  el.backBtn = $('btn-back-menu');
  el.playerBlack = $('player-black');
  el.playerWhite = $('player-white');
  el.nameBlack = $('name-black');
  el.nameWhite = $('name-white');
  el.capBlack = $('cap-black');
  el.capWhite = $('cap-white');
  el.moveBadge = $('move-badge');
  el.netBadge = $('net-badge');
  el.netStatus = $('net-status');
  el.netStatusText = $('net-status-text');
  el.gameHint = $('game-hint');
  el.thinking = $('thinking');
  el.scorePreview = $('score-preview');
  el.btnPass = $('btn-pass');
  el.btnUndo = $('btn-undo');
  el.btnResign = $('btn-resign');
  el.btnRecenter = $('btn-recenter');
  el.toast = $('toast');
  el.modalRoot = $('modal-root');
  el.modalContent = $('modal-content');
  el.modalClose = $('modal-close');
  el.impactLayer = $('impact-layer');
  el.rotateHint = $('rotate-hint');
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage is optional */
  }
}

function segmentedValue(container, attr) {
  const active = container?.querySelector('.seg-btn.active');
  return active ? active.getAttribute(`data-${attr}`) : null;
}

function setSegment(container, attr, value) {
  if (!container) return;
  for (const btn of container.querySelectorAll(`[data-${attr}]`)) {
    const active = btn.getAttribute(`data-${attr}`) === String(value);
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function formatPoints(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function isReducedMotion() {
  return settings.motion === 'reduced' || mediaReduced.matches;
}

function toast(message, bad = false) {
  if (!el.toast) return;
  el.toast.textContent = message;
  el.toast.classList.toggle('bad', bad);
  el.toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.toast.classList.remove('show'), 2400);
}

function showScreen(name) {
  state.screen = name;
  el.screenMenu?.classList.toggle('hidden', name !== 'menu');
  el.screenGame?.classList.toggle('hidden', name !== 'game');
  if (name === 'game') {
    el.gameHint?.classList.remove('hidden');
  }
}

function updateMenuNote() {
  if (!el.menuNote) return;
  const labels = { local: 'LOCAL DUEL', ai: 'VS MACHINE', online: 'P2P MATCH' };
  let note = `${labels[state.mode] || 'DUEL'} · ${settings.size}×${settings.size} · CHINESE SCORING`;
  if (state.mode === 'ai') note += ` · ${settings.difficulty.toUpperCase()}`;
  if (state.mode === 'online') note += ' · QUICK MATCH';
  el.menuNote.textContent = note;
}

function applySettingsToUI() {
  setSegment(el.sizeSelect, 'size', settings.size);
  for (const card of el.modeGrid?.querySelectorAll('[data-mode]') || []) {
    const active = card.dataset.mode === settings.mode;
    card.classList.toggle('active', active);
    card.setAttribute('aria-checked', active ? 'true' : 'false');
  }
  setSegment(el.difficultySelect, 'difficulty', settings.difficulty);
  setSegment(el.colorSelect, 'color', settings.color);
  if (el.aiOptions) el.aiOptions.hidden = settings.mode !== 'ai';
  document.documentElement.classList.toggle('reduced-motion', isReducedMotion());
  if (renderer) {
    renderer.setQuality(settings.quality);
    renderer.setMotion(settings.motion);
    renderer.setReducedMotion(isReducedMotion());
  }
  updateMenuNote();
}

// ── modal plumbing ────────────────────────────────────────────────────────

function openModal(templateId, options = {}) {
  if (!el.modalRoot || !el.modalContent) return null;
  const template = $(templateId);
  if (!template) return null;
  el.modalContent.replaceChildren();
  el.modalContent.append(template.content.cloneNode(true));
  el.modalRoot.classList.remove('hidden');
  el.modalRoot.setAttribute('aria-hidden', 'false');
  modalOnClose = typeof options.onClose === 'function' ? options.onClose : null;
  modalDismissible = options.dismissible !== false;
  if (el.modalClose) el.modalClose.hidden = !modalDismissible;
  const focusable = el.modalContent.querySelector('button:not([disabled])');
  if (focusable) focusable.focus({ preventScroll: true });
  return el.modalContent;
}

function closeModal(reason = 'close') {
  if (!el.modalRoot || el.modalRoot.classList.contains('hidden')) return;
  const callback = modalOnClose;
  modalOnClose = null;
  el.modalRoot.classList.add('hidden');
  el.modalRoot.setAttribute('aria-hidden', 'true');
  el.modalContent?.replaceChildren();
  if (el.modalClose) el.modalClose.hidden = false;
  if (callback) callback(reason);
}

function confirmAction({ title, body, okText = 'CONFIRM', cancelText = 'CANCEL', onOk }) {
  const content = openModal('tpl-confirm');
  if (!content) return;
  content.querySelector('#modal-title').textContent = title;
  content.querySelector('#confirm-body').textContent = body;
  const ok = content.querySelector('#confirm-ok');
  const cancel = content.querySelector('#confirm-cancel');
  ok.textContent = okText;
  cancel.textContent = cancelText;
  cancel.addEventListener('click', () => closeModal('cancel'));
  ok.addEventListener('click', () => {
    closeModal('confirmed');
    onOk?.();
  });
}

function openSettings() {
  const content = openModal('tpl-settings');
  if (!content) return;
  const quality = content.querySelector('#quality-select');
  const motion = content.querySelector('#motion-select');
  const soundSelect = content.querySelector('#sound-select');
  const haptics = content.querySelector('#haptics-select');
  setSegment(quality, 'quality', settings.quality);
  setSegment(motion, 'motion', settings.motion);
  setSegment(soundSelect, 'sound', settings.sound);
  setSegment(haptics, 'haptics', settings.haptics);

  quality.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-quality]');
    if (!btn) return;
    settings.quality = btn.dataset.quality;
    setSegment(quality, 'quality', settings.quality);
    renderer?.setQuality(settings.quality);
    saveSettings();
    sound.ui();
  });
  motion.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-motion]');
    if (!btn) return;
    settings.motion = btn.dataset.motion;
    setSegment(motion, 'motion', settings.motion);
    document.documentElement.classList.toggle('reduced-motion', isReducedMotion());
    renderer?.setMotion(settings.motion);
    renderer?.setReducedMotion(isReducedMotion());
    saveSettings();
    sound.ui();
  });
  soundSelect.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-sound]');
    if (!btn) return;
    settings.sound = btn.dataset.sound;
    setSegment(soundSelect, 'sound', settings.sound);
    sound.setEnabled(settings.sound === 'on');
    saveSettings();
    sound.ui();
  });
  haptics.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-haptics]');
    if (!btn) return;
    settings.haptics = btn.dataset.haptics;
    setSegment(haptics, 'haptics', settings.haptics);
    sound.setHaptics(settings.haptics === 'on');
    saveSettings();
    sound.ui();
  });
  content.querySelector('#settings-done')?.addEventListener('click', () => closeModal());
}

function openRules() {
  openModal('tpl-rules');
}

// ── menu wiring ───────────────────────────────────────────────────────────

function bindMenu() {
  el.sizeSelect?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-size]');
    if (!btn) return;
    const size = Number(btn.dataset.size);
    if (![9, 13, 19].includes(size)) return;
    settings.size = size;
    state.boardSize = size;
    setSegment(el.sizeSelect, 'size', size);
    renderer?.setBoardSize(size);
    updateMenuNote();
    saveSettings();
    sound.ui();
  });

  el.modeGrid?.addEventListener('click', (event) => {
    const card = event.target.closest('[data-mode]');
    if (!card) return;
    const mode = card.dataset.mode;
    if (!['local', 'ai', 'online'].includes(mode)) return;
    settings.mode = mode;
    state.mode = mode;
    setSegment(el.modeGrid, 'mode', mode);
    for (const c of el.modeGrid.querySelectorAll('[data-mode]')) {
      const active = c.dataset.mode === mode;
      c.classList.toggle('active', active);
      c.setAttribute('aria-checked', active ? 'true' : 'false');
    }
    if (el.aiOptions) el.aiOptions.hidden = mode !== 'ai';
    updateMenuNote();
    saveSettings();
    sound.ui();
  });

  el.difficultySelect?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-difficulty]');
    if (!btn) return;
    settings.difficulty = btn.dataset.difficulty;
    state.difficulty = settings.difficulty;
    setSegment(el.difficultySelect, 'difficulty', settings.difficulty);
    updateMenuNote();
    saveSettings();
    sound.ui();
  });

  el.colorSelect?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-color]');
    if (!btn) return;
    settings.color = btn.dataset.color;
    setSegment(el.colorSelect, 'color', settings.color);
    saveSettings();
    sound.ui();
  });

  el.startBtn?.addEventListener('click', () => {
    sound.unlock();
    sound.ui();
    if (state.mode === 'online') startMatchmaking();
    else if (state.mode === 'ai') startAiGame();
    else startLocalGame();
  });

  el.rulesBtn?.addEventListener('click', () => {
    sound.ui();
    openRules();
  });
  el.settingsBtn?.addEventListener('click', () => {
    sound.ui();
    openSettings();
  });
  el.installBtn?.addEventListener('click', async () => {
    if (!state.installPrompt) return;
    try {
      state.installPrompt.prompt();
      await state.installPrompt.userChoice;
    } catch {
      /* ignore */
    }
    state.installPrompt = null;
    el.installBtn.hidden = true;
  });
}

function bindGameControls() {
  el.btnPass?.addEventListener('click', () => {
    passTurn();
  });
  el.btnUndo?.addEventListener('click', () => {
    undoMove();
  });
  el.btnResign?.addEventListener('click', () => {
    sound.ui();
    resignGame();
  });
  el.btnRecenter?.addEventListener('click', () => {
    renderer?.camera.recenter(false);
    renderer?.setGhost(null);
    renderer?.setHover(-1);
    sound.ui();
  });
  el.backBtn?.addEventListener('click', () => {
    sound.ui();
    requestBackToMenu();
  });
}

// ── game start / stop ─────────────────────────────────────────────────────

function chooseHumanColor() {
  if (settings.color === '1') return BLACK;
  if (settings.color === '2') return WHITE;
  return Math.random() < 0.5 ? BLACK : WHITE;
}

function startLocalGame() {
  state.mode = 'local';
  state.boardSize = settings.size;
  state.humanColor = BLACK;
  state.aiColor = null;
  state.online = null;
  state.netReady = false;
  state.netMode = null;
  beginSession();
}

function startAiGame() {
  state.mode = 'ai';
  state.boardSize = settings.size;
  state.difficulty = settings.difficulty;
  state.humanColor = chooseHumanColor();
  state.aiColor = other(state.humanColor);
  state.online = null;
  state.netReady = false;
  state.netMode = null;
  beginSession();
  if (state.game && state.game.turn === state.aiColor) {
    scheduleAi(650);
  }
}

function beginSession({ online = false } = {}) {
  if (renderer) {
    renderer.camera.recenter(true);
  }
  clearAiPending();
  clearTimeout(state.scoringTimer);
  state.scoringTimer = null;
  state.game = new GoGame(state.boardSize, { komi: KOMPI[state.boardSize] ?? 6.5 });
  state.finished = false;
  state.startedAt = Date.now();
  state.thinking = false;
  state.lastResult = null;
  state.rematchOffer = false;
  state.rematchRequested = false;
  state.scoreSent = false;
  state.remoteScore = null;
  if (!online) {
    state.netReady = false;
    state.netMode = null;
  }
  state.humanColor = state.humanColor ?? BLACK;
  if (state.mode === 'ai') state.aiColor = other(state.humanColor);
  if (state.mode !== 'ai') state.aiColor = null;

  showScreen('game');
  closeModal('game-start');
  if (el.scorePreview) {
    el.scorePreview.classList.add('hidden');
    el.scorePreview.replaceChildren();
  }
  resetActionLabels();
  renderer?.setBoardSize(state.boardSize);
  renderer?.clearBoard(state.boardSize);
  renderer?.setMode('game');
  renderer?.setTurn(state.game.turn);
  renderer?.setHover(-1);
  renderer?.setGhost(null);
  renderer?.sync(state.game, { initial: true, animate: false });
  updateHud();
  updateHint();
  updateNetUI();
  if (!isReducedMotion()) fireImpact('start', { reduced: false });
  sound.unlock();
}

function requestBackToMenu() {
  if (state.screen !== 'game') return;
  if (state.finished || !state.game) {
    returnToMenu();
    return;
  }
  confirmAction({
    title: 'LEAVE THE VOID?',
    body:
      state.mode === 'online'
        ? 'Leaving now forfeits the match and disconnects your rival.'
        : 'The current duel will be abandoned.',
    okText: 'LEAVE',
    onOk: returnToMenu,
  });
}

function returnToMenu() {
  clearAiPending();
  clearTimeout(state.scoringTimer);
  clearTimeout(state.startTimer);
  state.scoringTimer = null;
  state.startTimer = null;
  closeModal('back');
  if (state.net) {
    state.net.close();
    state.net = null;
  }
  state.game = null;
  state.finished = false;
  state.thinking = false;
  state.netReady = false;
  state.netMode = null;
  state.online = null;
  state.rematchOffer = false;
  state.rematchRequested = false;
  state.scoreSent = false;
  state.remoteScore = null;
  clearImpact();
  showScreen('menu');
  renderer?.setMode('menu');
  renderer?.setBoardSize(settings.size);
  if (el.scorePreview) el.scorePreview.classList.add('hidden');
  updateMenuNote();
  updateNetUI();
}

// ── HUD / hints ───────────────────────────────────────────────────────────

function playerName(color) {
  if (!state.game) return colorName(color).toUpperCase();
  if (state.mode === 'local') return colorName(color).toUpperCase();
  if (color === state.humanColor) return 'YOU';
  if (state.mode === 'ai') return 'MACHINE';
  return (state.online?.opponent?.name || 'RIVAL').toUpperCase();
}

function setActionLabel(button, label) {
  if (!button) return;
  const span = button.querySelector('span:last-child');
  if (span) span.textContent = label;
}

function resetActionLabels() {
  setActionLabel(el.btnPass, 'PASS');
  setActionLabel(el.btnUndo, 'UNDO');
  setActionLabel(el.btnResign, 'RESIGN');
  setActionLabel(el.btnRecenter, 'CAMERA');
  if (el.btnPass) el.btnPass.disabled = false;
  if (el.btnUndo) el.btnUndo.disabled = false;
  if (el.btnResign) el.btnResign.disabled = false;
}

function updateHud() {
  const game = state.game;
  if (!game) return;
  el.nameBlack.textContent = playerName(BLACK);
  el.nameWhite.textContent = playerName(WHITE);
  el.capBlack.textContent = `${game.captures[BLACK]} CAPTURED`;
  el.capWhite.textContent = `${game.captures[WHITE]} CAPTURED`;
  el.moveBadge.textContent = `MOVE ${game.moveNumber}`;
  const active = !state.finished && game.phase === 'playing';
  el.playerBlack.classList.toggle('active', active && game.turn === BLACK);
  el.playerWhite.classList.toggle('active', active && game.turn === WHITE);

  const thinking = state.thinking && !state.finished;
  el.thinking?.classList.toggle('hidden', !thinking);
  if (thinking) {
    const label = el.thinking.querySelector('.think-label');
    if (label) {
      label.textContent = state.mode === 'ai' ? 'MACHINE THINKING' : 'RIVAL THINKING';
    }
  }

  const scoring = game.phase === 'scoring' && !state.finished;
  if (scoring) {
    const waiting = state.mode === 'online' && state.scoreSent;
    setActionLabel(el.btnPass, waiting ? 'WAITING' : 'SCORE');
    setActionLabel(el.btnUndo, 'RESUME');
    if (el.btnPass) el.btnPass.disabled = state.mode === 'online' && (waiting || !state.netReady);
    if (el.btnUndo) el.btnUndo.disabled = state.mode === 'online' || game.moveNumber === 0;
    updateScorePreview();
  } else if (!state.finished) {
    setActionLabel(el.btnPass, 'PASS');
    setActionLabel(el.btnUndo, 'UNDO');
    if (el.btnPass) el.btnPass.disabled = state.mode === 'online' && !state.netReady;
    if (el.btnUndo) {
      el.btnUndo.disabled =
        state.mode === 'online' || game.moveNumber === 0 || state.thinking;
    }
  } else {
    if (el.btnPass) el.btnPass.disabled = true;
    if (el.btnUndo) el.btnUndo.disabled = true;
    if (el.btnResign) el.btnResign.disabled = true;
  }
  if (el.btnResign) el.btnResign.disabled = state.finished;
  updateNetUI();
}

function updateHint() {
  const game = state.game;
  if (!game || !el.gameHint) return;
  let text = '';
  let accent = false;
  if (state.finished) {
    text = 'DUEL COMPLETE';
  } else if (game.phase === 'scoring') {
    if (state.mode === 'online') {
      if (state.scoreSent && !state.remoteScore) text = 'WAITING FOR RIVAL TO SCORE…';
      else if (state.remoteScore && !state.scoreSent) text = 'RIVAL SCORED · MARK DEAD + PRESS SCORE';
      else text = 'TAP GROUPS TO MARK DEAD · PRESS SCORE';
    } else {
      text = 'TAP GROUPS TO MARK DEAD · PRESS SCORE';
    }
    accent = true;
  } else if (state.thinking) {
    text = state.mode === 'ai' ? 'MACHINE IS THINKING…' : 'RIVAL IS PLAYING…';
  } else if (state.mode === 'online' && !state.netReady) {
    text = 'LINKING PEERS…';
  } else if ((state.mode === 'ai' || state.mode === 'online') && game.turn !== state.humanColor) {
    text = state.mode === 'ai' ? 'MACHINE TO PLAY' : 'RIVAL TO PLAY';
  } else {
    text = `${colorName(game.turn).toUpperCase()} TO PLAY · TAP AN INTERSECTION`;
    accent = true;
  }
  el.gameHint.textContent = text;
  el.gameHint.classList.toggle('accent', accent);
}

function updateScorePreview() {
  const game = state.game;
  if (!game || !el.scorePreview) return;
  if (game.phase !== 'scoring') {
    el.scorePreview.classList.add('hidden');
    return;
  }
  const score = game.score();
  const fragment = document.createDocumentFragment();
  const item = (label, value, accent = false) => {
    const box = document.createElement('span');
    box.className = accent ? 'score-item accent' : 'score-item';
    const name = document.createElement('span');
    name.textContent = label;
    const val = document.createElement('b');
    val.textContent = value;
    box.append(name, val);
    return box;
  };
  const divider = () => {
    const line = document.createElement('i');
    line.setAttribute('aria-hidden', 'true');
    return line;
  };
  fragment.append(
    item('BLACK', formatPoints(score.black)),
    divider(),
    item('WHITE', formatPoints(score.white)),
    divider(),
    item('TERRITORY', `${score.territoryBlack} / ${score.territoryWhite}`),
  );
  if (game.dead.size) {
    fragment.append(divider(), item('DEAD', String(game.dead.size), true));
  }
  el.scorePreview.replaceChildren(fragment);
  el.scorePreview.classList.remove('hidden');
}

function updateNetUI() {
  const online = state.mode === 'online' && state.screen === 'game' && state.game;
  el.netBadge?.classList.toggle('hidden', !online);
  el.netStatus?.classList.toggle('hidden', !online);
  if (!online) return;
  const mode = state.netMode || state.net?.mode || 'relay';
  const p2p = mode === 'p2p' && state.netReady;
  if (el.netBadge) {
    el.netBadge.textContent = state.netReady ? (p2p ? 'P2P' : 'RELAY') : 'LINK';
    el.netBadge.classList.toggle('relay', !p2p);
  }
  if (el.netStatus) {
    el.netStatus.classList.toggle('relay', !p2p);
    el.netStatusText.textContent = state.netReady
      ? p2p
        ? 'P2P DIRECT'
        : 'RELAY FALLBACK'
      : 'LINKING PEERS';
  }
}

// ── moves and scoring ─────────────────────────────────────────────────────

function canHumanAct() {
  const game = state.game;
  if (!game || state.finished || state.screen !== 'game') return false;
  if (game.phase !== 'playing') return false;
  if (state.thinking) return false;
  if (state.mode === 'local') return true;
  if (state.mode === 'online' && !state.netReady) return false;
  return game.turn === state.humanColor;
}

function moveErrorText(error) {
  return (
    {
      occupied: 'THERE IS ALREADY A STONE THERE',
      ko: 'KO · PLAY ELSEWHERE FIRST',
      superko: 'SUPERKO · POSITION REPEATED',
      'not-your-turn': 'WAIT FOR YOUR TURN',
      'game-over': 'THE DUEL IS OVER',
      illegal: 'THAT MOVE IS NOT LEGAL',
    }[error] || 'ILLEGAL MOVE'
  );
}

function placeAt(index) {
  const game = state.game;
  if (!game) return;
  if (state.finished) return;
  if (game.phase === 'scoring') {
    if (state.mode === 'online' && state.scoreSent) {
      toast('SCORE ALREADY SUBMITTED', true);
      return;
    }
    const result = game.toggleDead(index);
    if (!result) return;
    renderer?.sync(game);
    updateScorePreview();
    updateHud();
    sound.ui();
    return;
  }
  if (!canHumanAct()) {
    if (state.mode === 'online' && !state.netReady) toast('STILL LINKING TO YOUR RIVAL', true);
    else if (state.thinking) toast('WAIT FOR THE MACHINE TO MOVE', true);
    else if (state.mode !== 'local') toast('WAIT FOR YOUR TURN', true);
    return;
  }
  const color = game.turn;
  const played = game.play(color, index);
  if (!played.ok) {
    toast(moveErrorText(played.error), true);
    sound.error();
    renderer?.impact(index, 0.15, color);
    return;
  }

  const captures = played.captures || [];
  renderer?.sync(game, { captures });
  renderer?.setTurn(game.turn);
  renderer?.setGhost(null);
  updateHud();
  updateHint();
  if (state.mode === 'online') {
    state.net?.sendGame({
      type: 'move',
      seq: game.moveNumber,
      index,
      color,
      hash: game.hash,
    });
  }

  const [x] = [index % game.size];
  const pan = game.size > 1 ? ((x / (game.size - 1)) * 2 - 1) * 0.6 : 0;
  sound.stone(color, pan, captures.length ? 1.25 : 1);
  sound.vibrate(captures.length ? [0, 22, 18, 40] : 8);

  if (captures.length) {
    renderer?.impact(index, Math.min(1.4, 0.45 + captures.length * 0.12), color);
    sound.capture(Math.min(1, 0.6 + captures.length * 0.12));
    fireImpact('capture', { reduced: isReducedMotion() });
  } else {
    renderer?.impact(index, 0.18, color);
    if (played.atari?.length) {
      fireImpact('atari', { reduced: isReducedMotion() });
    }
  }

  if (state.mode === 'ai' && game.turn === state.aiColor) {
    scheduleAi(360);
  }
}

function passTurn() {
  const game = state.game;
  if (!game || state.finished) return;
  if (game.phase === 'scoring') {
    if (state.mode === 'online') {
      submitOnlineScore();
      return;
    }
    finalizeScoring();
    return;
  }
  if (!canHumanAct()) {
    toast('WAIT FOR YOUR TURN', true);
    return;
  }
  const color = game.turn;
  const result = game.pass(color);
  if (!result.ok) {
    toast(moveErrorText(result.error), true);
    return;
  }
  if (state.mode === 'online') {
    state.net?.sendGame({ type: 'pass', seq: game.moveNumber, color });
  }
  renderer?.sync(game, { captures: [] });
  renderer?.setTurn(game.turn);
  renderer?.setGhost(null);
  sound.pass();
  updateHud();
  updateHint();
  if (result.ended) {
    enterScoring();
  } else {
    toast(`${colorName(color).toUpperCase()} PASSES`);
    if (state.mode === 'ai' && game.turn === state.aiColor) scheduleAi(420);
  }
}

function enterScoring() {
  const game = state.game;
  if (!game) return;
  state.thinking = false;
  clearAiPending();
  state.scoreSent = false;
  state.remoteScore = null;
  updateHud();
  updateHint();
  renderer?.sync(game);
  updateScorePreview();
  sound.ui();
}

function submitOnlineScore() {
  const game = state.game;
  if (!game || state.finished || game.phase !== 'scoring' || state.mode !== 'online') return;
  if (state.scoreSent) return;
  if (!state.netReady || !state.net) {
    toast('RIVAL LINK LOST · SCORE UNAVAILABLE', true);
    return;
  }
  const dead = [...game.dead].sort((a, b) => a - b);
  if (!state.net.sendGame({ type: 'score', dead })) {
    toast('COULD NOT SEND SCORE', true);
    return;
  }
  state.scoreSent = true;
  if (!state.remoteScore) toast('SCORE SUBMITTED · WAITING FOR RIVAL');
  updateHud();
  updateHint();
  maybeFinishOnlineScore();
}

function maybeFinishOnlineScore() {
  const game = state.game;
  if (!game || state.finished || game.phase !== 'scoring') return;
  if (!state.scoreSent || !Array.isArray(state.remoteScore)) return;
  const remote = new Set(state.remoteScore);
  const agreed = [...game.dead].filter((index) => remote.has(index)).sort((a, b) => a - b);
  game.dead = new Set(agreed);
  renderer?.sync(game);
  updateScorePreview();
  finalizeScoring();
}

function finalizeScoring() {
  const game = state.game;
  if (!game || state.finished) return;
  clearTimeout(state.scoringTimer);
  state.scoringTimer = null;
  const score = game.score();
  finishGame({ reason: 'pass', winner: score.winner, score });
}

function resumeFromScoring() {
  const game = state.game;
  if (!game || game.phase !== 'scoring' || state.mode === 'online') return;
  clearTimeout(state.scoringTimer);
  state.scoringTimer = null;
  game.undo();
  renderer?.sync(game, { animate: false });
  updateHud();
  updateHint();
  if (el.scorePreview) el.scorePreview.classList.add('hidden');
  toast('PLAY RESUMED');
  sound.ui();
}

// ── undo / resign ─────────────────────────────────────────────────────────

function undoMove() {
  const game = state.game;
  if (!game || state.finished) return;
  if (state.mode === 'online') {
    toast('UNDO IS NOT AVAILABLE IN P2P DUELS', true);
    return;
  }
  if (game.phase === 'scoring') {
    resumeFromScoring();
    return;
  }
  if (game.moveNumber === 0) return;
  clearAiPending();
  game.undo();
  if (state.mode === 'ai' && game.moveNumber > 0 && game.turn !== state.humanColor) {
    game.undo();
  }
  renderer?.sync(game, { animate: false });
  renderer?.setTurn(game.turn);
  updateHud();
  updateHint();
  toast('MOVE UNDONE');
  sound.ui();
}

function resignGame() {
  const game = state.game;
  if (!game || state.finished) return;
  const resignColor = state.mode === 'local' ? game.turn : state.humanColor;
  confirmAction({
    title: 'RESIGN?',
    body:
      state.mode === 'local'
        ? `${colorName(resignColor).toUpperCase()} yields the duel.`
        : 'You yield the duel. The void does not judge.',
    okText: 'RESIGN',
    onOk: () => {
      if (state.mode === 'online') state.net?.sendGame({ type: 'resign' });
      finishGame({
        reason: 'resign',
        winner: other(resignColor),
        resignedColor: resignColor,
      });
    },
  });
}

// ── results / rematch ─────────────────────────────────────────────────────

function finishGame({ reason = 'pass', winner, score = null, resignedColor = null, peerLeft = false }) {
  const game = state.game;
  if (!game || state.finished) return;
  state.finished = true;
  state.thinking = false;
  clearAiPending();
  clearTimeout(state.scoringTimer);
  state.scoringTimer = null;
  const finalScore = score || game.score();
  const moves = game.moveNumber;
  const captures = game.captures[BLACK] + game.captures[WHITE];
  const elapsed = Date.now() - state.startedAt;
  game.phase = 'finished';
  renderer?.sync(game);
  renderer?.setGhost(null);
  renderer?.setHover(-1);
  updateHud();
  updateHint();

  const humanWon = state.mode === 'local' ? null : winner === state.humanColor;
  const result = {
    reason,
    score: finalScore,
    winner,
    moves,
    captures,
    elapsed,
    humanWon,
    resignedColor,
    peerLeft,
  };
  state.lastResult = result;

  if (state.mode === 'local') sound.win();
  else if (humanWon) sound.win();
  else sound.lose();
  if (!isReducedMotion()) {
    fireImpact(humanWon === false ? 'lose' : 'win', { reduced: false });
  }
  showResultModal(result);
}

function showResultModal(result) {
  const { score, winner, reason, resignedColor, peerLeft } = result;
  const content = openModal('tpl-result', { dismissible: false });
  if (!content) return;

  let title;
  if (state.mode === 'local') title = `${colorName(winner).toUpperCase()} WINS`;
  else if (peerLeft) title = 'RIVAL LEFT';
  else if (state.mode === 'ai') title = winner === state.humanColor ? 'YOU WIN' : 'MACHINE WINS';
  else title = winner === state.humanColor ? 'YOU WIN' : 'RIVAL WINS';

  let kicker = 'THE VOID HAS DECIDED';
  if (reason === 'resign') {
    kicker =
      state.mode === 'local'
        ? `${colorName(resignedColor).toUpperCase()} YIELDED`
        : winner === state.humanColor
          ? 'THE RIVAL YIELDED'
          : 'YOU YIELDED';
  } else if (peerLeft) {
    kicker = 'THE RIVAL VANISHED';
  }

  const margin =
    reason === 'resign'
      ? 'BY RESIGNATION'
      : peerLeft
        ? 'BY DISCONNECT'
        : `BY ${formatPoints(score.margin)} POINTS`;

  content.querySelector('#result-kicker').textContent = kicker;
  content.querySelector('#modal-title').textContent = title;
  content.querySelector('#result-black').textContent = formatPoints(score.black);
  content.querySelector('#result-white').textContent = formatPoints(score.white);
  content.querySelector('#result-black-detail').textContent =
    `${score.stonesBlack} stones · ${score.territoryBlack} area`;
  content.querySelector('#result-white-detail').textContent =
    `${score.stonesWhite} stones · ${score.territoryWhite} area`;
  content.querySelector('#result-margin').textContent = margin;
  content.querySelector('#result-moves').textContent = `${result.moves} MOVES`;
  content.querySelector('#result-caps').textContent = `${result.captures} CAPTURES`;
  content.querySelector('#result-time').textContent = formatTime(result.elapsed);

  const menuBtn = content.querySelector('#result-menu');
  const rematchBtn = content.querySelector('#result-rematch');
  menuBtn.addEventListener('click', () => {
    closeModal('menu');
    returnToMenu();
  });

  rematchBtn.classList.remove('hidden');
  rematchBtn.disabled = false;
  rematchBtn.textContent = 'REMATCH';
  if (peerLeft || (state.mode === 'online' && !state.net)) {
    rematchBtn.style.display = 'none';
  } else {
    rematchBtn.style.display = '';
    rematchBtn.addEventListener('click', () => {
      if (state.mode === 'online') requestOnlineRematch(rematchBtn);
      else {
        closeModal('rematch');
        if (state.mode === 'ai') startAiGame();
        else startLocalGame();
      }
    });
  }
}

function requestOnlineRematch(button) {
  if (!state.net) {
    toast('RIVAL NO LONGER CONNECTED', true);
    return;
  }
  if (state.rematchOffer) {
    state.net.sendRematch(true);
    closeModal('rematch');
    onlineRematch();
    return;
  }
  state.rematchRequested = true;
  state.net.sendRematch(true);
  button.disabled = true;
  button.textContent = 'WAITING…';
  toast('REMATCH OFFER SENT');
}

function onlineRematch() {
  if (!state.online || !state.net) return;
  closeModal('rematch');
  beginSession({ online: true });
  updateNetUI();
}

// ── AI ────────────────────────────────────────────────────────────────────

function ensureAiWorker() {
  if (aiWorker || aiWorkerFailed) return aiWorker;
  if (typeof Worker === 'undefined') {
    aiWorkerFailed = true;
    return null;
  }
  try {
    aiWorker = new Worker(new URL('./workers/ai-worker.js', import.meta.url), { type: 'module' });
    aiWorker.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || typeof msg.id !== 'number') return;
      const pending = aiPending.get(msg.id);
      if (!pending) return;
      aiPending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(msg.type === 'result' ? msg.result : null);
    });
    aiWorker.addEventListener('error', () => {
      aiWorkerFailed = true;
      try {
        aiWorker?.terminate();
      } catch {
        /* ignore */
      }
      aiWorker = null;
      for (const [id, pending] of aiPending) {
        clearTimeout(pending.timer);
        aiPending.delete(id);
        pending.resolve(null);
      }
    });
  } catch {
    aiWorkerFailed = true;
    aiWorker = null;
  }
  return aiWorker;
}

async function requestAiMove(snapshot) {
  const payload = {
    type: 'move',
    id: ++aiReqId,
    size: snapshot.size,
    board: Array.from(snapshot.board),
    color: snapshot.turn,
    koPoint: snapshot.koPoint,
    lastMove: snapshot.lastMove?.index ?? -1,
    moveNumber: snapshot.moveNumber,
    difficulty: state.difficulty,
    komi: snapshot.komi,
    passes: snapshot.passes,
    seed: (Date.now() ^ (snapshot.moveNumber * 2654435761)) >>> 0,
  };
  const worker = ensureAiWorker();
  if (!worker) return fallbackAiMove(payload);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      aiPending.delete(payload.id);
      resolve(fallbackAiMove(payload));
    }, 9000);
    aiPending.set(payload.id, { resolve, timer });
    try {
      worker.postMessage(payload);
    } catch {
      aiPending.delete(payload.id);
      clearTimeout(timer);
      resolve(fallbackAiMove(payload));
    }
  });
}

async function fallbackAiMove(payload) {
  if (!chooseMoveFallback) {
    try {
      chooseMoveFallback = (await import('./core/ai.js')).chooseMove;
    } catch {
      return null;
    }
  }
  try {
    return chooseMoveFallback({
      board: Uint8Array.from(payload.board),
      size: payload.size,
      color: payload.color,
      koPoint: payload.koPoint,
      lastMove: payload.lastMove,
      moveNumber: payload.moveNumber,
      difficulty: payload.difficulty,
      komi: payload.komi,
      passes: payload.passes,
      seed: payload.seed,
    });
  } catch {
    return null;
  }
}

function clearAiPending() {
  state.aiToken++;
  clearTimeout(state.aiTimer);
  state.aiTimer = null;
  state.thinking = false;
  for (const [id, pending] of aiPending) {
    clearTimeout(pending.timer);
    aiPending.delete(id);
    pending.resolve(null);
  }
  updateHud();
}

function scheduleAi(delay = 360) {
  if (state.mode !== 'ai' || !state.game || state.finished) return;
  if (state.game.phase !== 'playing' || state.game.turn !== state.aiColor) return;
  clearTimeout(state.aiTimer);
  const token = ++state.aiToken;
  state.aiTimer = setTimeout(async () => {
    if (token !== state.aiToken) return;
    const game = state.game;
    if (!game || game.phase !== 'playing' || game.turn !== state.aiColor) return;
    state.thinking = true;
    updateHud();
    updateHint();
    const snapshot = game.snapshot();
    const aiResult = await requestAiMove(snapshot);
    if (token !== state.aiToken || state.game !== game) return;
    state.thinking = false;
    if (!aiResult) {
      updateHud();
      updateHint();
      toast('THE MACHINE STALLED', true);
      return;
    }
    if (aiResult.pass || !Number.isInteger(aiResult.move) || aiResult.move < 0) {
      const passed = game.pass(state.aiColor);
      if (!passed.ok) return;
      renderer?.sync(game, { captures: [] });
      renderer?.setTurn(game.turn);
      sound.pass();
      updateHud();
      updateHint();
      if (passed.ended) enterScoring();
      return;
    }
    let played = game.play(state.aiColor, aiResult.move);
    if (!played.ok) {
      const legal = game.legalMoves(state.aiColor);
      if (legal.length) played = game.play(state.aiColor, legal[0]);
    }
    if (!played.ok) {
      updateHud();
      updateHint();
      toast('THE MACHINE STALLED', true);
      return;
    }
    const captures = played.captures || [];
    renderer?.sync(game, { captures });
    renderer?.setTurn(game.turn);
    updateHud();
    updateHint();
    const pan = ((aiResult.move % game.size) / Math.max(1, game.size - 1)) * 2 - 1;
    sound.stone(state.aiColor, pan * 0.6, captures.length ? 1.2 : 0.9);
    if (captures.length) {
      renderer?.impact(aiResult.move, Math.min(1.3, 0.4 + captures.length * 0.12), state.aiColor);
      sound.capture(0.8);
      fireImpact('capture', { reduced: isReducedMotion() });
    } else {
      renderer?.impact(aiResult.move, 0.16, state.aiColor);
    }
  }, delay);
}

// ── online play ───────────────────────────────────────────────────────────

function setMatchStatus(text, kicker = null) {
  const status = el.modalContent?.querySelector('#match-status-text');
  if (status) status.textContent = text;
  if (kicker) {
    const kick = el.modalContent?.querySelector('#match-kicker');
    if (kick) kick.textContent = kicker;
  }
}

function showMatchOpponent(name) {
  const box = el.modalContent?.querySelector('#match-opponent');
  if (!box) return;
  box.replaceChildren();
  const led = document.createElement('span');
  led.className = 'match-led';
  const text = document.createElement('span');
  const b = document.createElement('b');
  b.textContent = name.toUpperCase();
  text.append('RIVAL FOUND · ', b);
  box.append(led, text);
  box.classList.remove('hidden');
}

function startMatchmaking() {
  if (state.screen === 'game') return;
  state.mode = 'online';
  state.boardSize = settings.size;
  state.finished = false;
  state.matchFound = false;
  if (state.net) {
    state.net.close();
    state.net = null;
  }
  const params = new URLSearchParams(location.search);
  const net = new NetClient({ forceRelay: params.get('relay') === '1' });
  state.net = net;
  attachNetHandlers(net);

  openModal('tpl-matchmaking', {
    onClose: () => {
      if (!state.matchFound) cancelMatchmaking();
    },
  });
  if (!el.modalRoot || el.modalRoot.classList.contains('hidden')) return;
  setMatchStatus(`CONNECTING · ${settings.size}×${settings.size}`, 'Scanning the void for a peer.');
  el.modalContent?.querySelector('#match-opponent')?.classList.add('hidden');

  const cancel = el.modalContent?.querySelector('#match-cancel');
  cancel?.addEventListener('click', () => cancelMatchmaking());

  (async () => {
    try {
      await net.connect();
      if (state.net !== net) return;
      net.queue(settings.size);
      setMatchStatus(`QUEUED · ${settings.size}×${settings.size}`, 'Scanning the void for a peer.');
    } catch (err) {
      if (state.net !== net) return;
      setMatchStatus('SIGNAL LOST · TRY AGAIN', 'The relay did not answer.');
      toast(String(err?.message || 'COULD NOT REACH MATCHMAKING'), true);
    }
  })();
}

function cancelMatchmaking() {
  clearTimeout(state.startTimer);
  state.startTimer = null;
  state.matchFound = false;
  const net = state.net;
  state.net = null;
  if (net) {
    try {
      net.cancel();
      net.close();
    } catch {
      /* ignore */
    }
  }
  closeModal('cancel');
  updateNetUI();
}

function attachNetHandlers(net) {
  net.on('status', (event) => {
    if (state.net !== net) return;
    if (event.state === 'signalling' && state.screen === 'menu') {
      setMatchStatus(`CONNECTING · ${settings.size}×${settings.size}`);
    }
  });

  net.on('queued', (event) => {
    if (state.net !== net) return;
    setMatchStatus(`QUEUED · ${event.boardSize}×${event.boardSize} · ${event.position} IN LINE`);
  });

  net.on('matched', (event) => {
    if (state.net !== net) return;
    if (event.boardSize !== settings.size) return;
    state.matchFound = true;
    state.online = {
      color: event.color,
      boardSize: event.boardSize,
      opponent: event.opponent,
    };
    state.humanColor = event.color;
    state.boardSize = event.boardSize;
    state.netReady = Boolean(net.readyEmitted);
    state.netMode = net.mode;
    showMatchOpponent(event.opponent.name);
    setMatchStatus(`MATCHED · ${event.boardSize}×${event.boardSize}`, 'RIVAL ACQUIRED');
    const cancel = el.modalContent?.querySelector('#match-cancel');
    if (cancel) {
      cancel.textContent = 'MATCHED';
      cancel.disabled = true;
    }
    fireImpact('match', { reduced: isReducedMotion() });
    sound.win();
    clearTimeout(state.startTimer);
    state.startTimer = setTimeout(() => {
      if (state.net !== net || !state.matchFound) return;
      closeModal('matched');
      state.mode = 'online';
      beginSession({ online: true });
      updateNetUI();
      if (!net.readyEmitted) toast('LINKING TO YOUR RIVAL…');
    }, 850);
  });

  net.on('ready', (event) => {
    if (state.net !== net) return;
    state.netReady = true;
    state.netMode = event.mode;
    if (state.screen === 'game') {
      updateNetUI();
      updateHint();
      updateHud();
      toast(event.mode === 'p2p' ? 'P2P LINK ESTABLISHED' : 'RELAY LINK ESTABLISHED');
    }
  });

  net.on('mode', (event) => {
    if (state.net !== net) return;
    state.netMode = event.mode;
    if (state.screen === 'game') {
      updateNetUI();
      toast(event.mode === 'p2p' ? 'P2P RESTORED' : 'SWITCHED TO RELAY');
    }
  });

  net.on('message', (event) => {
    if (state.net !== net) return;
    handleOnlinePayload(event.payload);
  });

  net.on('peer-left', (event) => {
    if (state.net !== net) return;
    if (state.screen === 'game' && state.game && !state.finished) {
      finishGame({
        reason: 'peer-left',
        winner: state.humanColor,
        peerLeft: true,
      });
      toast(`RIVAL LEFT · ${event.reason === 'disconnected' ? 'DISCONNECTED' : 'FORFEIT'}`, true);
    } else if (state.screen === 'menu') {
      if (state.matchFound) {
        clearTimeout(state.startTimer);
        state.startTimer = null;
        state.matchFound = false;
        state.netReady = false;
        updateNetUI();
        closeModal('peer-left');
        const net = state.net;
        state.net = null;
        net?.close();
        toast('RIVAL LEFT THE LOBBY · FIND A NEW MATCH', true);
      } else {
        toast('RIVAL LEFT THE LOBBY', true);
      }
    }
    state.netReady = false;
    updateNetUI();
  });

  net.on('error', (event) => {
    if (state.net !== net) return;
    if (state.screen === 'menu') setMatchStatus(`ERROR · ${event.message.toUpperCase()}`.slice(0, 80));
    toast(event.message.toUpperCase(), true);
  });

  net.on('timeout', () => {
    if (state.net !== net) return;
    setMatchStatus('NO RIVAL FOUND · TRY AGAIN', 'The void stayed silent.');
    toast('MATCHMAKING TIMED OUT', true);
  });

  net.on('closed', () => {
    if (state.net !== net) return;
    state.netReady = false;
    state.netMode = null;
    updateNetUI();
  });

  net.on('rematch-offer', (event) => {
    if (state.net !== net) return;
    if (!event.accept) {
      state.rematchOffer = false;
      state.rematchRequested = false;
      const btn = el.modalContent?.querySelector('#result-rematch');
      if (btn && state.finished) {
        btn.disabled = false;
        btn.textContent = 'REMATCH';
      }
      toast('REMATCH DECLINED');
      return;
    }
    if (state.rematchRequested) {
      state.rematchOffer = false;
      state.rematchRequested = false;
      state.net.sendRematch(true);
      onlineRematch();
      return;
    }
    state.rematchOffer = true;
    if (state.finished && el.modalContent) {
      const btn = el.modalContent.querySelector('#result-rematch');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'ACCEPT REMATCH';
      }
      toast('RIVAL WANTS A REMATCH');
    }
  });
}

function handleOnlinePayload(payload) {
  const game = state.game;
  if (!game || state.finished) return;
  if (payload.type === 'move' || payload.type === 'pass') {
    if (payload.color !== game.turn) return;
    if (payload.seq !== game.moveNumber + 1) return;
    if (game.phase !== 'playing') return;
    if (payload.type === 'move') {
      if (payload.index < 0 || payload.index >= game.board.length) return;
      const played = game.play(payload.color, payload.index);
      if (!played.ok) {
        toast('DESYNC · MOVE REJECTED', true);
        return;
      }
      if (payload.hash && payload.hash !== game.hash) {
        toast('DESYNC DETECTED', true);
      }
      renderer?.sync(game, { captures: played.captures || [] });
      renderer?.setTurn(game.turn);
      updateHud();
      updateHint();
      sound.stone(payload.color, 0, 0.9);
      if (played.captures?.length) {
        renderer?.impact(payload.index, 0.5 + played.captures.length * 0.1, payload.color);
        sound.capture(0.75);
        fireImpact('capture', { reduced: isReducedMotion() });
      } else {
        renderer?.impact(payload.index, 0.14, payload.color);
      }
      if (played.atari?.length) fireImpact('atari', { reduced: isReducedMotion() });
    } else {
      const passed = game.pass(payload.color);
      if (!passed.ok) return;
      renderer?.sync(game, { captures: [] });
      renderer?.setTurn(game.turn);
      updateHud();
      updateHint();
      sound.pass();
      toast('RIVAL PASSES');
      if (passed.ended) enterScoring();
    }
    return;
  }
  if (payload.type === 'score') {
    if (game.phase !== 'scoring' || state.finished) return;
    state.remoteScore = payload.dead;
    if (!state.scoreSent) {
      updateHud();
      updateHint();
      toast(
        payload.dead.length
          ? `RIVAL MARKED ${payload.dead.length} DEAD · REVIEW + SCORE`
          : 'RIVAL SCORED · NO DEAD STONES',
      );
    } else {
      maybeFinishOnlineScore();
    }
    return;
  }
  if (payload.type === 'resign') {
    finishGame({
      reason: 'resign',
      winner: state.humanColor,
      resignedColor: other(state.humanColor),
    });
    toast('RIVAL RESIGNED');
  }
}

// ── board input ───────────────────────────────────────────────────────────

function screenToBoard(clientX, clientY) {
  if (!renderer) return -1;
  const rect = el.canvas.getBoundingClientRect();
  return renderer.camera.pickBoard(clientX - rect.left, clientY - rect.top, rect.width, rect.height, state.boardSize);
}

function updatePointerGhost(clientX, clientY) {
  if (!state.game || state.finished || state.game.phase !== 'playing') return;
  const index = screenToBoard(clientX, clientY);
  renderer?.setHover(index);
  if (index >= 0 && state.game.board[index] === 0) {
    if (canHumanAct()) renderer?.setGhost(index, state.game.turn);
    else renderer?.setGhost(index, state.game.turn);
  } else {
    renderer?.setGhost(null);
  }
  if (el.canvas) el.canvas.style.cursor = index >= 0 ? 'crosshair' : 'default';
}

function bindBoardInput() {
  const canvas = el.canvas;
  if (!canvas) return;
  const pointers = new Map();
  let drag = 0;
  let gestureStart = 0;
  let pinchDistance = 0;
  let pinchCenter = null;

  const pointerDistance = () => {
    const values = [...pointers.values()];
    if (values.length < 2) return 0;
    return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
  };
  const pointerCenter = () => {
    const values = [...pointers.values()];
    return {
      x: (values[0].x + values[1].x) / 2,
      y: (values[0].y + values[1].y) / 2,
    };
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0 && event.pointerType === 'mouse') return;
    sound.unlock();
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      drag = 0;
      gestureStart = performance.now();
      updatePointerGhost(event.clientX, event.clientY);
    } else if (pointers.size === 2) {
      pinchDistance = pointerDistance();
      pinchCenter = pointerCenter();
      renderer?.setGhost(null);
    }
    event.preventDefault();
  });

  canvas.addEventListener('pointermove', (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) {
      if (event.pointerType === 'mouse') updatePointerGhost(event.clientX, event.clientY);
      return;
    }
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    previous.x = event.clientX;
    previous.y = event.clientY;
    if (pointers.size >= 2) {
      const distance = pointerDistance();
      if (pinchDistance > 0 && distance > 0) {
        renderer?.camera.zoomBy(pinchDistance / distance);
      }
      pinchDistance = distance;
      const center = pointerCenter();
      if (pinchCenter) {
        renderer?.camera.orbitBy(center.x - pinchCenter.x, center.y - pinchCenter.y);
      }
      pinchCenter = center;
      return;
    }
    drag += Math.abs(dx) + Math.abs(dy);
    if (drag > 7) {
      renderer?.camera.orbitBy(dx, dy);
      renderer?.setGhost(null);
      renderer?.setHover(-1);
      if (el.canvas) el.canvas.style.cursor = 'grabbing';
    }
    event.preventDefault();
  }, { passive: false });

  const finishPointer = (event) => {
    const start = pointers.get(event.pointerId);
    if (!start) return;
    const wasTap =
      pointers.size === 1 &&
      drag < 9 &&
      performance.now() - gestureStart < 650 &&
      event.type === 'pointerup';
    pointers.delete(event.pointerId);
    if (wasTap) {
      const index = screenToBoard(event.clientX, event.clientY);
      if (index >= 0) placeAt(index);
    }
    if (pointers.size === 0) {
      drag = 0;
      pinchDistance = 0;
      pinchCenter = null;
      if (el.canvas) el.canvas.style.cursor = 'default';
    }
    event.preventDefault();
  };
  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', finishPointer);
  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse' && pointers.size === 0) {
      renderer?.setHover(-1);
      renderer?.setGhost(null);
    }
  });
  canvas.addEventListener(
    'wheel',
    (event) => {
      renderer?.camera.zoomBy(event.deltaY > 0 ? 1.08 : 0.92);
      event.preventDefault();
    },
    { passive: false },
  );
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
}

// ── keyboard ──────────────────────────────────────────────────────────────

function bindKeyboard() {
  window.addEventListener('keydown', (event) => {
    const modalOpen = el.modalRoot && !el.modalRoot.classList.contains('hidden');
    if (event.key === 'Escape') {
      if (modalOpen && modalDismissible) {
        closeModal('escape');
        event.preventDefault();
      } else if (!modalOpen && state.screen === 'game') {
        requestBackToMenu();
        event.preventDefault();
      }
      return;
    }
    if (modalOpen || state.screen !== 'game') return;
    const key = event.key.toLowerCase();
    if (key === 'p') passTurn();
    else if (key === 'u') undoMove();
    else if (key === 'r') {
      renderer?.camera.recenter(false);
      toast('CAMERA RECENTERED');
    } else if (key === 'm') requestBackToMenu();
  });
}

// ── boot / render loop ────────────────────────────────────────────────────

function resize() {
  renderer?.resize();
}
let lastFrame = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (!renderer) return;
  if (document.hidden) {
    lastFrame = now;
    return;
  }
  const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0.016;
  lastFrame = now;
  try {
    renderer.update(dt);
    renderer.render();
  } catch (err) {
    console.error(err);
    el.loadStatus.textContent = 'RENDERER FAULT — RELOAD THE VOID';
  }
}

function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    if (el.installBtn) el.installBtn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    if (el.installBtn) el.installBtn.hidden = true;
  });
  if (window.matchMedia('(display-mode: standalone)').matches && el.installBtn) {
    el.installBtn.hidden = true;
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (new URLSearchParams(location.search).get('nosw') === '1') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.warn('[sw]', err?.message || err);
    });
  });
}

async function boot() {
  cacheElements();
  setupInstallPrompt();
  registerServiceWorker();
  bindMenu();
  bindGameControls();
  bindBoardInput();
  bindKeyboard();
  el.startBtn.disabled = true;
  applySettingsToUI();

  if (!el.canvas) {
    el.loadStatus.textContent = 'NO CANVAS IN THE VOID';
    return;
  }
  try {
    renderer = new Renderer(el.canvas, {
      quality: settings.quality,
      motion: settings.motion,
      reducedMotion: isReducedMotion(),
    });
    el.loadStatus.textContent = 'CALIBRATING THE VOID';
    renderer.init();
    renderer.setBoardSize(settings.size);
    renderer.setMode('menu');
    renderer.resize();
    window.addEventListener('resize', () => {
      resize();
      setTimeout(resize, 180);
    });
    window.addEventListener('orientationchange', () => setTimeout(resize, 260));
    mediaReduced.addEventListener?.('change', () => {
      document.documentElement.classList.toggle('reduced-motion', isReducedMotion());
      renderer?.setReducedMotion(isReducedMotion());
    });

    requestAnimationFrame(frame);
    el.loadStatus.textContent = 'ENTERING THE VOID';
    try {
      await document.fonts.ready;
    } catch {
      /* fonts are cosmetic */
    }
    await new Promise((resolve) => setTimeout(resolve, 380));
    el.loading?.classList.add('gone');
    el.startBtn.disabled = false;
    state.booted = true;
    updateMenuNote();

    // Tiny debugging / test surface. Not used by gameplay.
    window.__goVoid = {
      state,
      settings,
      renderer,
      startLocalGame,
      startAiGame,
      beginSession,
      placeAt,
      passTurn,
      intersectionScreen(index) {
        const p = renderer.camera.boardPoint(index, state.boardSize, 0.18);
        const screen = renderer.camera.projectToScreen(p, renderer.cssWidth, renderer.cssHeight);
        const rect = el.canvas.getBoundingClientRect();
        return {
          x: rect.left + (screen[0] / renderer.cssWidth) * rect.width,
          y: rect.top + (screen[1] / renderer.cssHeight) * rect.height,
        };
      },
    };
    window.dispatchEvent(new CustomEvent('go-void-ready'));
    if (bootParams.get('start') === '1') {
      setTimeout(() => {
        if (state.screen !== 'menu') return;
        if (state.mode === 'online') startMatchmaking();
        else if (state.mode === 'ai') startAiGame();
        else startLocalGame();
      }, 480);
    }
  } catch (err) {
    console.error(err);
    el.loadStatus.textContent = `WEBGL2 REQUIRED — ${String(err?.message || err).slice(0, 120)}`;
    el.loading?.classList.remove('gone');
    toast('THIS DEVICE CANNOT OPEN THE VOID', true);
    el.startBtn.disabled = true;
  }
}

// Modal chrome listeners.
document.addEventListener('DOMContentLoaded', () => {
  el.modalRoot = $('modal-root');
  el.modalClose = $('modal-close');
  el.modalContent = $('modal-content');
  el.modalClose?.addEventListener('click', () => closeModal('x'));
  el.modalRoot?.addEventListener('click', (event) => {
    if (event.target.classList.contains('modal-backdrop') && modalDismissible) closeModal('backdrop');
    if (event.target.closest('[data-modal-close]') && modalDismissible) closeModal('close');
  });
  boot();
});

window.addEventListener('pointerdown', () => sound.unlock(), { once: true });
