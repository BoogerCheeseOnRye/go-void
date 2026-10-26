/* GO/VOID — custom WebGL2 renderer. No three.js, no runtime dependencies. */

import {
  createGL,
  Program,
  createMesh,
  drawMesh,
  createRenderTarget,
  deleteRenderTarget,
  createFullscreenQuad,
  drawFullscreen,
  bindTexture,
} from './gl.js';
import { OrbitCamera } from './camera.js';
import {
  clamp,
  damp,
  easeOutCubic,
  identity,
  lerp,
  mix3,
} from './math.js';
import { findGroup } from '../core/go.js';
import * as SH from './shaders.js';

const STAR_LINES = {
  9: [2, 4, 6],
  13: [3, 6, 9],
  19: [3, 9, 15],
};

const BLACK_TINT = [0.02, 0.016, 0.032];
const WHITE_TINT = [0.74, 0.82, 0.92];

function sphereGeometry(rings = 22, segments = 28) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let y = 0; y <= rings; y++) {
    const v = y / rings;
    const phi = v * Math.PI;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const theta = u * Math.PI * 2;
      const px = Math.cos(theta) * sinPhi;
      const py = cosPhi;
      const pz = Math.sin(theta) * sinPhi;
      positions.push(px, py, pz);
      normals.push(px, py, pz);
      uvs.push(u, v);
    }
  }
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

function planeGeometry(half, y = 0, uvScale = 1) {
  const positions = new Float32Array([
    -half, y, -half,
    half, y, -half,
    -half, y, half,
    half, y, half,
  ]);
  const normals = new Float32Array([
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
  ]);
  const uvs = new Float32Array([
    0, 0,
    uvScale, 0,
    0, uvScale,
    uvScale, uvScale,
  ]);
  const indices = new Uint32Array([0, 2, 1, 1, 2, 3]);
  return { positions, normals, uvs, indices };
}

function roundedRectBoundary(hw, hd, radius, segments = 7) {
  const points = [];
  const corners = [
    [hw - radius, hd - radius, 0],
    [-hw + radius, hd - radius, Math.PI / 2],
    [-hw + radius, -hd + radius, Math.PI],
    [hw - radius, -hd + radius, (Math.PI * 3) / 2],
  ];
  for (const [cx, cz, start] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = start + (i / segments) * (Math.PI / 2);
      points.push([cx + Math.cos(a) * radius, cz + Math.sin(a) * radius]);
    }
  }
  return points;
}

function roundedSlabGeometry(hw, hd, thickness, radius) {
  const boundary = roundedRectBoundary(hw, hd, radius, 7);
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const topY = 0;
  const bottomY = -thickness;
  const count = boundary.length;

  const pushVertex = (x, y, z, nx, ny, nz) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    uvs.push(x / (hw * 2) + 0.5, z / (hd * 2) + 0.5);
    return positions.length / 3 - 1;
  };

  const topCenter = pushVertex(0, topY, 0, 0, 1, 0);
  const bottomCenter = pushVertex(0, bottomY, 0, 0, -1, 0);
  const topRim = [];
  const bottomRim = [];
  for (const [x, z] of boundary) topRim.push(pushVertex(x, topY, z, 0, 1, 0));
  for (const [x, z] of boundary) bottomRim.push(pushVertex(x, bottomY, z, 0, -1, 0));

  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    indices.push(topCenter, topRim[i], topRim[j]);
    indices.push(bottomCenter, bottomRim[j], bottomRim[i]);
  }

  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const [ax, az] = boundary[i];
    const [bx, bz] = boundary[j];
    let nx = az - bz;
    let nz = bx - ax;
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    const a = pushVertex(ax, topY, az, nx, 0, nz);
    const b = pushVertex(bx, topY, bz, nx, 0, nz);
    const c = pushVertex(ax, bottomY, az, nx, 0, nz);
    const d = pushVertex(bx, bottomY, bz, nx, 0, nz);
    indices.push(a, c, b, b, c, d);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

function unitQuad2D() {
  return new Float32Array([
    -1, -1,
    1, -1,
    -1, 1,
    -1, 1,
    1, -1,
    1, 1,
  ]);
}

function buildDemoBoard(size) {
  const board = new Uint8Array(size * size);
  if (size === 9) {
    const black = [
      [2, 2], [6, 2], [2, 6], [6, 6], [4, 4],
      [3, 4], [5, 4], [4, 2], [4, 6],
    ];
    const white = [
      [3, 3], [5, 3], [3, 5], [5, 5], [2, 4],
      [6, 4], [4, 3], [4, 5], [1, 4], [7, 4],
    ];
    for (const [x, y] of black) board[y * size + x] = 1;
    for (const [x, y] of white) board[y * size + x] = 2;
  } else {
    const scale = (size - 1) / 8;
    const black = [
      [2, 2], [6, 2], [2, 6], [6, 6], [4, 4],
      [3, 4], [5, 4], [4, 2], [4, 6],
    ];
    const white = [
      [3, 3], [5, 3], [3, 5], [5, 5], [2, 4],
      [6, 4], [4, 3], [4, 5], [1, 4], [7, 4],
    ];
    for (const [x, y] of black) {
      const px = Math.round(x * scale);
      const py = Math.round(y * scale);
      board[py * size + px] = 1;
    }
    for (const [x, y] of white) {
      const px = Math.round(x * scale);
      const py = Math.round(y * scale);
      if (!board[py * size + px]) board[py * size + px] = 2;
    }
  }
  return board;
}

export class Renderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.gl = createGL(canvas);
    if (!this.gl) throw new Error('WebGL2 is not available on this device.');
    this.gl.getExtension('EXT_color_buffer_float');
    this.gl.getExtension('OES_texture_float_linear');

    this.camera = new OrbitCamera();
    this.size = 9;
    this.quality = options.quality || 'auto';
    this.motion = options.motion !== 'reduced';
    this.reduced = options.reducedMotion || false;
    this.pixelRatio = 1;
    this.width = 1;
    this.height = 1;
    this.cssWidth = 1;
    this.cssHeight = 1;

    this.time = 0;
    this.clock = 0;
    this.mode = 'menu';
    this.turn = 1;
    this.phase = 'playing';
    this.board = new Uint8Array(81);
    this.prevBoard = new Uint8Array(81);
    this.dead = new Set();
    this.atari = new Set();
    this.lastMove = null;
    this.hover = -1;
    this.ghost = null;
    this.ghostColor = 1;

    this.stoneVisuals = new Map();
    this.particles = [];
    this.shockwaves = [];
    this.ambientTimer = 0;
    this.impactStrength = 0;
    this.flash = 0;
    this.impactCenter = [0.5, 0.5];
    this.lastFrameStats = { stones: 0, particles: 0 };

    this.programs = {};
    this.meshes = new Map();
    this.fullscreen = null;
    this.scene = null;
    this.bloom = null;
    this.hdr = false;
    this.initialized = false;

    this._stoneVAO = null;
    this._stoneBuffer = null;
    this._shadowVAO = null;
    this._shadowBuffer = null;
    this._markerVAO = null;
    this._markerBuffer = null;
    this._particleVAO = null;
    this._particleBuffer = null;

    this._stoneData = new Float32Array(0);
    this._shadowData = new Float32Array(0);
    this._markerData = new Float32Array(0);
    this._particleData = new Float32Array(0);
    this._identity = identity();
    this._stars = new Float32Array(18);
    this._color = [0, 0, 0];
  }

  init() {
    if (this.initialized) return;
    const gl = this.gl;

    this.programs.background = new Program(gl, SH.BACKGROUND_VS, SH.BACKGROUND_FS, 'background');
    this.programs.slab = new Program(gl, SH.SLAB_VS, SH.SLAB_FS, 'slab');
    this.programs.board = new Program(gl, SH.BOARD_VS, SH.BOARD_FS, 'board');
    this.programs.glow = new Program(gl, SH.GLOW_VS, SH.GLOW_FS, 'glow');
    this.programs.stone = new Program(gl, SH.STONE_VS, SH.STONE_FS, 'stone');
    this.programs.shadow = new Program(gl, SH.SHADOW_VS, SH.SHADOW_FS, 'shadow');
    this.programs.marker = new Program(gl, SH.MARKER_VS, SH.MARKER_FS, 'marker');
    this.programs.particle = new Program(gl, SH.PARTICLE_VS, SH.PARTICLE_FS, 'particle');
    this.programs.bright = new Program(gl, SH.BRIGHT_VS, SH.BRIGHT_FS, 'bright');
    this.programs.blur = new Program(gl, SH.BLUR_VS, SH.BLUR_FS, 'blur');
    this.programs.composite = new Program(gl, SH.COMPOSITE_VS, SH.COMPOSITE_FS, 'composite');

    this.fullscreen = createFullscreenQuad(gl);

    const sphere = createMesh(gl, sphereGeometry(22, 28));
    this.meshes.set('sphere', sphere);
    this._stoneVAO = sphere.vao;

    const quad = unitQuad2D();
    this._shadowVAO = this._createAttribVAO(quad, 2);
    this._markerVAO = this._createAttribVAO(quad, 2);
    this._shadowBuffer = this._attachInstances(this._shadowVAO, [
      { loc: 3, size: 3, offset: 0 },
      { loc: 4, size: 1, offset: 3 },
    ], 4, 512);
    this._markerBuffer = this._attachInstances(this._markerVAO, [
      { loc: 3, size: 3, offset: 0 },
      { loc: 4, size: 3, offset: 3 },
      { loc: 5, size: 4, offset: 6 },
    ], 10, 512);

    this._stoneBuffer = this._attachInstances(sphere.vao, [
      { loc: 3, size: 3, offset: 0 },
      { loc: 4, size: 3, offset: 3 },
      { loc: 5, size: 3, offset: 6 },
      { loc: 6, size: 4, offset: 9 },
    ], 13, 512);

    const particleVAO = gl.createVertexArray();
    this._particleVAO = particleVAO;
    this._particleBuffer = gl.createBuffer();
    gl.bindVertexArray(particleVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._particleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 460 * 32, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 32, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 32, 28);
    gl.bindVertexArray(null);

    this._buildBoardMeshes();
    this.resize();
    this.initialized = true;
  }

  _createAttribVAO(data, components) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, components, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  _attachInstances(vao, layout, strideFloats, capacity) {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * strideFloats * 4, gl.DYNAMIC_DRAW);
    for (const a of layout) {
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, strideFloats * 4, a.offset * 4);
      gl.vertexAttribDivisor(a.loc, 1);
    }
    gl.bindVertexArray(null);
    return buffer;
  }

  _buildBoardMeshes() {
    const gl = this.gl;
    const size = this.size;
    if (this.meshes.has(`board-${size}`)) return this.meshes.get(`board-${size}`);
    const half = (size - 1) * 0.5;
    const slabHalf = half + 0.68;
    const slab = createMesh(gl, roundedSlabGeometry(slabHalf, slabHalf, 0.36, 0.5));
    const boardPlane = createMesh(gl, planeGeometry(half + 0.47, 0.012, 1));
    const glowHalf = slabHalf + 1.6;
    const glow = createMesh(gl, planeGeometry(glowHalf, -0.62, 1));
    // center the glow at the board base, not at the origin of its own quad
    const entry = { slab, boardPlane, glow };
    this.meshes.set(`board-${size}`, entry);
    return entry;
  }

  setBoardSize(size) {
    if (size === this.size && this.meshes.has(`board-${size}`)) {
      this.camera.setBoardSize(size);
      return;
    }
    this.size = size;
    this.camera.setBoardSize(size);
    if (this.initialized) this._buildBoardMeshes();
    if (this.mode === 'menu') this.setDemo(size);
  }

  setQuality(quality) {
    this.quality = quality;
    if (this.initialized) this.resize();
  }

  setMotion(motion) {
    this.motion = motion !== 'reduced';
    this.camera.shakeAmp = 0;
    this.impactStrength = 0;
  }

  setReducedMotion(reduced) {
    this.reduced = Boolean(reduced);
    if (this.reduced) {
      this.particles.length = 0;
      this.impactStrength = 0;
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.camera.setMode(mode);
    if (mode === 'menu') {
      this.setDemo(this.size);
    } else {
      this.hover = -1;
      this.ghost = null;
    }
  }

  setDemo(size = this.size) {
    const board = buildDemoBoard(size);
    this.size = size;
    this.camera.setBoardSize(size);
    this.board = board;
    this.prevBoard = new Uint8Array(board);
    this.dead.clear();
    this.atari.clear();
    this.lastMove = null;
    this.phase = 'playing';
    this.stoneVisuals.clear();
    this.shockwaves.length = 0;
    this.particles.length = 0;
    const now = this.clock;
    for (let i = 0; i < board.length; i++) {
      if (!board[i]) continue;
      this.stoneVisuals.set(i, {
        color: board[i],
        born: now - 20,
        flash: 0,
        dying: 0,
        dead: false,
        danger: false,
      });
    }
    if (this.initialized) this._buildBoardMeshes();
    this._seedAmbient(this.reduced ? 12 : 55);
  }

  _seedAmbient(count) {
    const spread = (this.size + 2) * 0.55;
    for (let i = 0; i < count; i++) {
      const life = 2.5 + Math.random() * 6;
      this.particles.push({
        pos: [
          (Math.random() - 0.5) * spread * 2,
          0.15 + Math.random() * 3.2,
          (Math.random() - 0.5) * spread * 2,
        ],
        vel: [
          (Math.random() - 0.5) * 0.08,
          0.04 + Math.random() * 0.12,
          (Math.random() - 0.5) * 0.08,
        ],
        life,
        maxLife: life,
        size: 0.014 + Math.random() * 0.03,
        color: Math.random() < 0.5 ? [0.35, 0.8, 1.0] : [0.85, 0.35, 1.0],
        gravity: -0.02,
        ambient: true,
      });
    }
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || this.canvas.clientWidth || window.innerWidth);
    const cssH = Math.max(1, rect.height || this.canvas.clientHeight || window.innerHeight);
    this.cssWidth = cssW;
    this.cssHeight = cssH;
    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;
    let ratio;
    if (this.quality === 'low') ratio = Math.min(dpr, 1);
    else if (this.quality === 'high') ratio = Math.min(dpr, 2);
    else {
      const area = cssW * cssH;
      ratio = area > 420_000 ? Math.min(dpr, 1.6) : Math.min(dpr, 2);
    }
    // Keep the framebuffer under ~3.1 megapixels; phones dislike more.
    const budget = 3_100_000;
    if (cssW * cssH * ratio * ratio > budget) ratio = Math.sqrt(budget / (cssW * cssH));
    ratio = clamp(ratio, 0.85, 2);
    const w = Math.max(2, Math.round(cssW * ratio));
    const h = Math.max(2, Math.round(cssH * ratio));
    this.pixelRatio = w / cssW;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.width = w;
    this.height = h;
    this.camera.aspect = w / h;
    if (!this.initialized) return;
    this._ensureTargets(w, h);
  }

  _ensureTargets(w, h) {
    const gl = this.gl;
    if (this.scene && this.scene.width === w && this.scene.height === h) return;
    deleteRenderTarget(gl, this.scene);
    deleteRenderTarget(gl, this.bloom);
    deleteRenderTarget(gl, this._blurTemp);
    this.scene = null;
    this.bloom = null;
    this._blurTemp = null;
    this.hdr = Boolean(gl.getExtension('EXT_color_buffer_float'));
    try {
      this.scene = createRenderTarget(gl, w, h, { hdr: this.hdr, depth: true });
    } catch {
      this.hdr = false;
      this.scene = createRenderTarget(gl, w, h, { hdr: false, depth: true });
    }
    const bw = Math.max(2, Math.floor(w / 2));
    const bh = Math.max(2, Math.floor(h / 2));
    this.bloom = createRenderTarget(gl, bw, bh, { hdr: this.hdr });
    this._blurTemp = createRenderTarget(gl, bw, bh, { hdr: this.hdr });
  }

  /** Sync from a GoGame-like object. */
  sync(game, options = {}) {
    const animate = options.animate !== false;
    const captures = options.captures || [];
    let initial = options.initial === true;
    if (game.size !== this.size) {
      this.setBoardSize(game.size);
      initial = true;
    }
    const prev = this.prevBoard.length === game.board.length ? this.prevBoard : new Uint8Array(game.board.length);
    const now = this.clock;
    const captureSet = captures.length ? new Set(captures) : null;

    if (initial) {
      this.stoneVisuals.clear();
    }

    for (let i = 0; i < game.board.length; i++) {
      const next = game.board[i];
      const old = prev[i] || 0;
      const visual = this.stoneVisuals.get(i);
      if (next && (!visual || visual.color !== next || visual.dying)) {
        if (visual) this.stoneVisuals.delete(i);
        this.stoneVisuals.set(i, {
          color: next,
          born: animate ? now : now - 20,
          flash: animate ? 1 : 0,
          dying: 0,
          dead: false,
          danger: false,
        });
        if (animate && !initial) this._placementSparks(i, next);
      } else if (!next && visual && !visual.dying) {
        visual.dying = now;
        if (animate && captureSet && captureSet.has(i)) {
          this._captureBurst(i, visual.color, 26);
        }
      }
    }

    if (initial) {
      for (const key of [...this.stoneVisuals.keys()]) {
        if (!game.board[key]) this.stoneVisuals.delete(key);
      }
    }

    this.board = new Uint8Array(game.board);
    this.prevBoard = new Uint8Array(game.board);
    this.dead = new Set(game.dead || []);
    this.phase = game.phase || 'playing';
    this.turn = game.turn;
    this.lastMove = game.lastMove
      ? { index: game.lastMove.index, color: game.lastMove.color }
      : null;

    // Atari groups for the red warning halos.
    this.atari.clear();
    const seen = new Uint8Array(game.board.length);
    for (let i = 0; i < game.board.length; i++) {
      if (!game.board[i] || seen[i]) continue;
      const group = findGroup(game.board, game.size, i);
      for (const s of group.stones) seen[s] = 1;
      if (group.liberties.size === 1 && group.stones.length <= 12) {
        for (const s of group.stones) this.atari.add(s);
      }
    }

    for (const [index, visual] of this.stoneVisuals) {
      visual.dead = this.dead.has(index);
      visual.danger = this.atari.has(index);
    }
  }

  clearBoard(size = this.size) {
    this.size = size;
    this.board = new Uint8Array(size * size);
    this.prevBoard = new Uint8Array(size * size);
    this.stoneVisuals.clear();
    this.dead.clear();
    this.atari.clear();
    this.lastMove = null;
    this.shockwaves.length = 0;
    this.particles.length = 0;
  }

  setTurn(turn) {
    this.turn = turn;
    if (this.ghost) this.ghostColor = turn;
  }

  setHover(index) {
    this.hover = Number.isInteger(index) ? index : -1;
    if (this.hover < 0) this.ghost = null;
  }

  setGhost(index, color = this.turn) {
    if (!Number.isInteger(index) || index < 0) {
      this.ghost = null;
      return;
    }
    this.ghost = index;
    this.ghostColor = color;
  }

  /** Screen-space impact: shake, shockwave, flash and particle burst. */
  impact(index = -1, strength = 0.5, color = 1) {
    const s = clamp(strength, 0.15, 1.4);
    this.impactStrength = Math.min(1, this.impactStrength + 0.35 + s * 0.45);
    this.flash = Math.max(this.flash, 0.03 + s * 0.07);
    if (this.motion) this.camera.shake(0.045 + s * 0.12);
    if (Number.isInteger(index) && index >= 0) {
      const p = this.camera.boardPoint(index, this.size, 0.05);
      const screen = this.camera.projectToScreen(p, this.cssWidth, this.cssHeight);
      this.impactCenter = [
        clamp(screen[0] / this.cssWidth, 0, 1),
        clamp(1 - screen[1] / this.cssHeight, 0, 1),
      ];
      this.shockwaves.push({
        index,
        start: this.clock,
        duration: 0.45 + s * 0.2,
        size: 1.1 + s * 1.5,
        color: color === 1 ? [0.55, 0.75, 1.0] : [1.0, 0.9, 0.7],
        strength: s,
      });
    }
  }

  _placementSparks(index, color) {
    const p = this.camera.boardPoint(index, this.size, 0.04);
    const count = this.reduced ? 2 : 5;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.4 + Math.random() * 0.9;
      this._spawnParticle(
        [p[0] + Math.cos(a) * 0.12, 0.12, p[2] + Math.sin(a) * 0.12],
        [Math.cos(a) * speed, 1.2 + Math.random() * 1.6, Math.sin(a) * speed],
        0.28 + Math.random() * 0.24,
        0.035 + Math.random() * 0.04,
        color === 1 ? [0.55, 0.62, 1.0] : [1.0, 0.92, 0.72],
        2.4,
      );
    }
  }

  _captureBurst(index, color, count) {
    if (this.reduced) count = Math.min(8, count);
    const p = this.camera.boardPoint(index, this.size, 0.16);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.6 + Math.random() * 2.4;
      const up = 0.7 + Math.random() * 2.2;
      const warm = color === 1 ? [0.6, 0.32, 1.0] : [1.0, 0.82, 0.55];
      const cool = color === 1 ? [0.35, 0.9, 1.0] : [0.75, 1.0, 1.0];
      this._spawnParticle(
        [p[0], p[1], p[2]],
        [Math.cos(a) * speed, up, Math.sin(a) * speed],
        0.45 + Math.random() * 0.7,
        0.05 + Math.random() * 0.11,
        Math.random() < 0.62 ? warm : cool,
        2.6,
      );
    }
    // A low ring of dust hugging the board.
    for (let i = 0; i < Math.floor(count / 4); i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.1 + Math.random() * 0.35;
      this._spawnParticle(
        [p[0] + Math.cos(a) * r, 0.08, p[2] + Math.sin(a) * r],
        [Math.cos(a) * 1.1, 0.25, Math.sin(a) * 1.1],
        0.5 + Math.random() * 0.4,
        0.06 + Math.random() * 0.06,
        color === 1 ? [0.5, 0.3, 0.9] : [0.9, 0.85, 0.7],
        1.1,
      );
    }
  }

  _spawnParticle(pos, vel, life, size, color, gravity = 2) {
    if (this.particles.length > 460) this.particles.shift();
    this.particles.push({
      pos: [pos[0], pos[1], pos[2]],
      vel: [vel[0], vel[1], vel[2]],
      life,
      maxLife: life,
      size,
      color,
      gravity,
      ambient: false,
    });
  }

  _spawnAmbient(dt) {
    if (this.reduced) return;
    this.ambientTimer -= dt;
    if (this.ambientTimer > 0) return;
    this.ambientTimer = this.mode === 'menu' ? 0.12 : 0.22;
    if (this.particles.length > 340) return;
    const spread = (this.size + 2) * 0.62;
    this._spawnParticle(
      [
        (Math.random() - 0.5) * spread * 2,
        0.2 + Math.random() * 2.4,
        (Math.random() - 0.5) * spread * 2,
      ],
      [
        (Math.random() - 0.5) * 0.08,
        0.05 + Math.random() * 0.09,
        (Math.random() - 0.5) * 0.08,
      ],
      3.5 + Math.random() * 3.5,
      0.015 + Math.random() * 0.028,
      Math.random() < 0.5 ? [0.35, 0.8, 1.0] : [0.85, 0.35, 1.0],
      -0.02,
    );
    const p = this.particles[this.particles.length - 1];
    p.ambient = true;
  }

  _updateEffects(dt) {
    const now = this.clock;
    for (const [index, visual] of this.stoneVisuals) {
      if (visual.dying && now - visual.dying > 0.36) {
        this.stoneVisuals.delete(index);
      }
    }
    if (this.shockwaves.length) {
      this.shockwaves = this.shockwaves.filter((w) => now - w.start < w.duration);
    }
    this.impactStrength = Math.max(0, this.impactStrength - dt * 2.1);
    this.flash *= Math.exp(-8.5 * dt);

    const alive = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vel[1] -= p.gravity * dt;
      if (p.ambient) {
        p.vel[0] += Math.sin(this.time * 0.3 + p.pos[2]) * dt * 0.02;
        p.vel[2] += Math.cos(this.time * 0.25 + p.pos[0]) * dt * 0.02;
      }
      p.pos[0] += p.vel[0] * dt;
      p.pos[1] += p.vel[1] * dt;
      p.pos[2] += p.vel[2] * dt;
      if (p.pos[1] < 0.02) {
        p.pos[1] = 0.02;
        p.vel[1] *= -0.25;
        p.vel[0] *= 0.85;
        p.vel[2] *= 0.85;
      }
      alive.push(p);
    }
    this.particles = alive;
    this._spawnAmbient(dt);
  }

  _pushStoneUniforms(program) {
    program
      .use()
      .setMat4('uViewProj', this.camera.viewProj)
      .setVec3('uCameraPos', this.camera.eye[0], this.camera.eye[1], this.camera.eye[2])
      .setFloat('uTime', this.time);
  }

  _buildStoneInstances() {
    const now = this.clock;
    const count = this.stoneVisuals.size;
    const data = new Float32Array(Math.max(1, (count + 1)) * 13);
    const shadows = new Float32Array(Math.max(1, count) * 4);
    let n = 0;
    let sn = 0;
    const half = (this.size - 1) * 0.5;

    for (const [index, v] of this.stoneVisuals) {
      let alpha = 1;
      let flash = v.flash;
      let scaleX = 1;
      let scaleY = 1;
      let y = 0.18;
      let x = (index % this.size) - half;
      let z = Math.floor(index / this.size) - half;

      if (v.dying) {
        const t = clamp((now - v.dying) / 0.36, 0, 1);
        const k = 1 - t;
        alpha = k;
        scaleX = k * (1 + 0.3 * Math.sin(t * Math.PI));
        scaleY = k;
        y += t * 0.45;
        flash = Math.max(flash, (1 - t) * 0.8);
      } else {
        const age = now - v.born;
        if (age < 0.46) {
          const t = clamp(age / 0.34, 0, 1);
          y = 0.18 + Math.pow(1 - easeOutCubic(t), 2) * 1.15;
          const land = clamp((age - 0.24) / 0.22, 0, 1);
          const squash = Math.sin(land * Math.PI);
          scaleY = 1 - squash * 0.22;
          scaleX = 1 + squash * 0.13;
          flash = Math.max(flash, (1 - t) * 0.55);
        }
        if (v.flash > 0) v.flash = Math.max(0, v.flash - 0.055);
      }

      let base = v.color === 1 ? BLACK_TINT : WHITE_TINT;
      if (v.dead) {
        base = v.color === 1 ? [0.07, 0.015, 0.035] : [0.42, 0.31, 0.38];
        alpha *= 0.85;
      }
      const danger = v.danger ? 1 : 0;
      const seed = (index * 0.618033) % 1;

      const o = n * 13;
      data[o] = x;
      data[o + 1] = y;
      data[o + 2] = z;
      data[o + 3] = scaleX;
      data[o + 4] = scaleY;
      data[o + 5] = scaleX;
      data[o + 6] = base[0];
      data[o + 7] = base[1];
      data[o + 8] = base[2];
      data[o + 9] = alpha;
      data[o + 10] = flash;
      data[o + 11] = seed;
      data[o + 12] = danger;
      n++;

      const so = sn * 4;
      shadows[so] = x;
      shadows[so + 1] = 0.01;
      shadows[so + 2] = z;
      shadows[so + 3] = v.dying ? 0.4 : 1;
      sn++;
    }

    if (this.ghost !== null && this.mode !== 'menu' && !this.board[this.ghost]) {
      const x = (this.ghost % this.size) - half;
      const z = Math.floor(this.ghost / this.size) - half;
      const pulse = 0.26 + 0.06 * Math.sin(this.time * 3.2);
      const o = n * 13;
      const base = this.ghostColor === 1 ? [0.13, 0.12, 0.22] : [0.68, 0.78, 0.9];
      data[o] = x;
      data[o + 1] = 0.18 + 0.04 * Math.sin(this.time * 2.6);
      data[o + 2] = z;
      data[o + 3] = 1;
      data[o + 4] = 1;
      data[o + 5] = 1;
      data[o + 6] = base[0];
      data[o + 7] = base[1];
      data[o + 8] = base[2];
      data[o + 9] = pulse;
      data[o + 10] = 0.25;
      data[o + 11] = 0.4;
      data[o + 12] = 0;
      n++;
    }

    this._stoneData = data.subarray(0, n * 13);
    this._shadowData = shadows.subarray(0, sn * 4);
    this.lastFrameStats.stones = n;
  }

  _buildMarkers() {
    const markers = [];
    if (this.lastMove && this.lastMove.index >= 0 && this.phase === 'playing') {
      const p = this.camera.boardPoint(this.lastMove.index, this.size, 0.026);
      const color = this.lastMove.color === 1 ? [0.45, 0.85, 1.0] : [1.0, 0.8, 0.55];
      markers.push({ pos: p, size: 0.86, color, alpha: 0.55, style: 0, seed: 0.37 });
    }
    for (const w of this.shockwaves) {
      const p = this.camera.boardPoint(w.index, this.size, 0.03);
      const progress = clamp((this.clock - w.start) / w.duration, 0, 1);
      markers.push({
        pos: p,
        size: w.size * (1 + progress * 1.5),
        color: w.color,
        alpha: progress,
        style: 1,
        seed: 0,
      });
    }
    if (this.phase === 'playing' && !this.reduced) {
      let count = 0;
      for (const index of this.atari) {
        if (count++ > 40) break;
        const p = this.camera.boardPoint(index, this.size, 0.025);
        markers.push({
          pos: p,
          size: 0.58,
          color: [1.0, 0.12, 0.28],
          alpha: 0.4,
          style: 2,
          seed: (index * 0.37) % 1,
        });
      }
    }
    if (this.phase === 'scoring' && this.dead.size) {
      for (const index of this.dead) {
        const p = this.camera.boardPoint(index, this.size, 0.05);
        markers.push({
          pos: p,
          size: 0.5,
          color: [1.0, 0.18, 0.32],
          alpha: 0.6,
          style: 3,
          seed: 0,
        });
      }
    }
    const data = new Float32Array(Math.max(1, markers.length) * 10);
    markers.forEach((m, i) => {
      const o = i * 10;
      data[o] = m.pos[0];
      data[o + 1] = m.pos[1];
      data[o + 2] = m.pos[2];
      data[o + 3] = m.color[0];
      data[o + 4] = m.color[1];
      data[o + 5] = m.color[2];
      data[o + 6] = m.size;
      data[o + 7] = m.alpha;
      data[o + 8] = m.style;
      data[o + 9] = m.seed;
    });
    this._markerData = data;
    this._markerCount = markers.length;
  }

  _buildParticles() {
    const count = this.particles.length;
    const data = new Float32Array(count * 8);
    for (let i = 0; i < count; i++) {
      const p = this.particles[i];
      const t = p.life / p.maxLife;
      let alpha = Math.sin(clamp(t, 0, 1) * Math.PI) * (p.ambient ? 0.28 : 0.95);
      if (p.ambient) alpha *= 0.55;
      const o = i * 8;
      data[o] = p.pos[0];
      data[o + 1] = p.pos[1];
      data[o + 2] = p.pos[2];
      data[o + 3] = p.size * (0.5 + t * 0.7);
      data[o + 4] = p.color[0];
      data[o + 5] = p.color[1];
      data[o + 6] = p.color[2];
      data[o + 7] = alpha;
    }
    this._particleData = data;
    this.lastFrameStats.particles = count;
  }

  _upload(buffer, data) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  }

  update(dt) {
    dt = clamp(dt, 0, 0.05);
    this.clock += dt;
    this.time += dt;
    const aspect = this.width / Math.max(1, this.height);
    this.camera.aspect = aspect;
    const motionScale = this.motion ? 1 : 0.45;
    this.camera.update(dt * motionScale, aspect, this.cssHeight);
    this._updateEffects(dt);

    const stars = STAR_LINES[this.size] || STAR_LINES[9];
    this._stars.fill(-999);
    let s = 0;
    for (let y = 0; y < stars.length; y++) {
      for (let x = 0; x < stars.length; x++) {
        this._stars[s * 2] = stars[x];
        this._stars[s * 2 + 1] = stars[y];
        s++;
      }
    }
    this._starCount = s;

    this._buildStoneInstances();
    this._buildMarkers();
    this._buildParticles();

    if (!this.initialized) return;
    this._upload(this._stoneBuffer, this._stoneData);
    this._upload(this._shadowBuffer, this._shadowData);
    this._upload(this._markerBuffer, this._markerData);
    this._upload(this._particleBuffer, this._particleData);
  }

  render() {
    if (!this.initialized) return;
    const gl = this.gl;
    const { scene, bloom } = this;
    if (!scene || !bloom) return;

    // ── scene ──────────────────────────────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clearColor(0.002, 0.002, 0.007, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    const bg = this.programs.background.use();
    bg.setFloat('uTime', this.time)
      .setFloat('uAspect', this.width / this.height)
      .setFloat('uImpact', this.impactStrength)
      .setVec3('uImpactColor', 0.35, 0.8, 1.0)
      .setFloat('uGame', this.mode === 'game' ? 1 : 0)
      .setFloat('uReduced', this.reduced ? 1 : 0);
    drawFullscreen(gl, this.fullscreen);

    const mesh = this._buildBoardMeshes();
    const half = (this.size - 1) * 0.5;
    const accent = this.mode === 'menu' ? [0.42, 0.72, 1.0] : [0.42, 0.9, 1.0];
    const hoverColor =
      this.ghostColor === 1 ? [0.45, 0.85, 1.0] : [1.0, 0.82, 0.58];
    const lastIndex = this.lastMove && this.lastMove.index >= 0 ? this.lastMove.index : -999;
    const lastX = lastIndex >= 0 ? (lastIndex % this.size) : -999;
    const lastY = lastIndex >= 0 ? Math.floor(lastIndex / this.size) : -999;
    const hoverIndex = this.hover >= 0 ? this.hover : -999;
    const hoverX = hoverIndex >= 0 ? (hoverIndex % this.size) : -999;
    const hoverY = hoverIndex >= 0 ? Math.floor(hoverIndex / this.size) : -999;

    // Under-board glow.
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    const glow = this.programs.glow.use();
    glow.setMat4('uViewProj', this.camera.viewProj)
      .setFloat('uTime', this.time)
      .setVec3('uAccent', accent[0], accent[1], accent[2]);
    drawMesh(gl, mesh.glow);
    gl.disable(gl.BLEND);

    gl.depthMask(true);
    const slab = this.programs.slab.use();
    slab.setMat4('uViewProj', this.camera.viewProj)
      .setMat4('uModel', this._identity)
      .setVec3('uCameraPos', this.camera.eye[0], this.camera.eye[1], this.camera.eye[2])
      .setFloat('uTime', this.time)
      .setFloat('uHalf', half)
      .setVec3('uAccent', accent[0], accent[1], accent[2]);
    drawMesh(gl, mesh.slab);

    const board = this.programs.board.use();
    board.setMat4('uViewProj', this.camera.viewProj)
      .setMat4('uModel', this._identity)
      .setVec3('uCameraPos', this.camera.eye[0], this.camera.eye[1], this.camera.eye[2])
      .setFloat('uTime', this.time)
      .setFloat('uHalf', half)
      .setVec2('uHover', hoverX, hoverY)
      .setFloat('uHoverStrength', hoverIndex >= 0 ? 1 : 0)
      .setVec2('uLast', lastX, lastY)
      .setVec3('uHoverColor', hoverColor[0], hoverColor[1], hoverColor[2])
      .setFloat('uScoring', this.phase === 'scoring' ? 1 : 0)
      .setVec3('uAccent', accent[0], accent[1], accent[2])
      .setInt('uStarCount', this._starCount);
    gl.uniform2fv(board.u('uStars'), this._stars);
    drawMesh(gl, mesh.boardPlane);

    // Contact shadows.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    const shadow = this.programs.shadow.use();
    shadow.setMat4('uViewProj', this.camera.viewProj);
    gl.bindVertexArray(this._shadowVAO);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this._shadowData.length / 4);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);

    // Stones (opaque + ghost, alpha blending for dying stones).
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(true);
    const stone = this.programs.stone.use();
    stone
      .setMat4('uViewProj', this.camera.viewProj)
      .setVec3('uCameraPos', this.camera.eye[0], this.camera.eye[1], this.camera.eye[2])
      .setFloat('uTime', this.time);
    gl.bindVertexArray(this._stoneVAO);
    const stoneCount = this._stoneData.length / 13;
    gl.drawElementsInstanced(gl.TRIANGLES, this.meshes.get('sphere').count, gl.UNSIGNED_INT, 0, stoneCount);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);

    // Markers and particles on top, additively.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    const marker = this.programs.marker.use();
    marker.setMat4('uViewProj', this.camera.viewProj).setFloat('uTime', this.time);
    gl.bindVertexArray(this._markerVAO);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this._markerCount || 0);
    gl.bindVertexArray(null);

    if (this.particles.length) {
      const particle = this.programs.particle.use();
      particle
        .setMat4('uViewProj', this.camera.viewProj)
        .setFloat('uPixelScale', (this.height * 0.5) / Math.tan(this.camera.fov * 0.5));
      gl.bindVertexArray(this._particleVAO);
      gl.drawArrays(gl.POINTS, 0, this.particles.length);
      gl.bindVertexArray(null);
    }
    gl.disable(gl.BLEND);

    // ── bloom ──────────────────────────────────────────────────────────────
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloom.fbo);
    gl.viewport(0, 0, bloom.width, bloom.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const bright = this.programs.bright.use();
    bindTexture(gl, 0, scene.texture);
    bright.setInt('uScene', 0)
      .setVec2('uTexel', 1 / this.width, 1 / this.height)
      .setFloat('uThreshold', this.hdr ? 0.72 : 0.82);
    drawFullscreen(gl, this.fullscreen);

    const blur = this.programs.blur;
    for (let i = 0; i < 4; i++) {
      const source = i % 2 === 0 ? bloom.texture : this._blurTemp.texture;
      if (i % 2 === 0) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._blurTemp.fbo);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloom.fbo);
      }
      gl.viewport(0, 0, bloom.width, bloom.height);
      blur.use();
      bindTexture(gl, 0, source);
      blur.setInt('uImage', 0)
        .setVec2('uTexel', 1 / bloom.width, 1 / bloom.height)
        .setVec2('uDirection', i % 2 === 0 ? 1 : 0, i % 2 === 0 ? 0 : 1);
      drawFullscreen(gl, this.fullscreen);
    }

    // ── composite ─────────────────────────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0.002, 0.002, 0.007, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const comp = this.programs.composite.use();
    bindTexture(gl, 0, scene.texture);
    bindTexture(gl, 1, bloom.texture);
    comp
      .setInt('uScene', 0)
      .setInt('uBloom', 1)
      .setVec2('uResolution', this.width, this.height)
      .setFloat('uTime', this.time)
      .setFloat('uBloomStrength', this.hdr ? 0.72 : 0.58)
      .setFloat('uImpact', this.impactStrength)
      .setVec2('uImpactCenter', this.impactCenter[0], this.impactCenter[1])
      .setFloat('uFlash', this.flash)
      .setFloat('uMotion', this.motion ? 1 : 0)
      .setInt('uScoring', this.phase === 'scoring' ? 1 : 0);
    drawFullscreen(gl, this.fullscreen);
  }

  dispose() {
    const gl = this.gl;
    for (const program of Object.values(this.programs)) program.dispose?.();
    for (const mesh of this.meshes.values()) {
      if (!mesh) continue;
      for (const m of [mesh, mesh.slab, mesh.boardPlane, mesh.glow]) {
        if (m && m.buffers) {
          gl.deleteBuffer(m.buffers.positions);
          if (m.buffers.normals) gl.deleteBuffer(m.buffers.normals);
          if (m.buffers.uvs) gl.deleteBuffer(m.buffers.uvs);
          if (m.buffers.indices) gl.deleteBuffer(m.buffers.indices);
          gl.deleteVertexArray(m.vao);
        }
      }
    }
    for (const b of [this._stoneBuffer, this._shadowBuffer, this._markerBuffer, this._particleBuffer]) {
      if (b) gl.deleteBuffer(b);
    }
    for (const v of [this._shadowVAO, this._markerVAO, this._particleVAO]) {
      if (v) gl.deleteVertexArray(v);
    }
    deleteRenderTarget(gl, this.scene);
    deleteRenderTarget(gl, this.bloom);
    deleteRenderTarget(gl, this._blurTemp);
  }
}
