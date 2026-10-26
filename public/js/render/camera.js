/* GO/VOID — orbit camera, fitting, shake and board raycasting. */

import {
  clamp,
  damp,
  degToRad,
  identity,
  invert,
  lookAt,
  multiply,
  normalize3,
  perspective,
  sub3,
  transformPoint,
} from './math.js';

const UP = [0, 1, 0];
const GAME_ELEVATION = degToRad(57);
const MENU_ELEVATION = degToRad(48);
const MIN_ELEVATION = degToRad(34);
const MAX_ELEVATION = degToRad(82);

export class OrbitCamera {
  constructor() {
    this.fov = degToRad(41);
    this.near = 0.08;
    this.far = 600;
    this.target = [0, 0.18, 0];

    this.boardSize = 9;
    this.aspect = 1;
    this.viewportHeight = 800;
    this.mode = 'menu';

    this.userAzimuth = 0;
    this.userElevation = GAME_ELEVATION;
    this.zoom = 1;
    this.menuSpin = 0;
    this.menuDrift = 0;
    this.time = 0;

    this.azimuth = 0;
    this.elevation = MENU_ELEVATION;
    this.distance = 18;
    this.fit = 18;

    this.shakeAmp = 0;
    this.shakeTime = 0;
    this.shakeSeed = Math.random() * 100;
    this.flash = 0;

    this.eye = [0, 10, 18];
    this.view = identity();
    this.proj = identity();
    this.viewProj = identity();
    this.invViewProj = identity();
    this._projTmp = identity();
    this._viewTmp = identity();
  }

  setBoardSize(size) {
    this.boardSize = size;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'game') {
      this.userAzimuth = 0;
      this.userElevation = GAME_ELEVATION;
      this.zoom = 1;
      this.menuDrift = this.azimuth;
    } else {
      this.menuSpin = 0;
      this.userAzimuth = 0;
      this.menuDrift = 0;
      this.zoom = 1.12;
    }
  }

  recenter(immediate = false) {
    this.userAzimuth = 0;
    this.userElevation = this.mode === 'menu' ? MENU_ELEVATION : GAME_ELEVATION;
    this.zoom = 1;
    if (immediate) {
      this.azimuth = this.mode === 'menu' ? 0 : 0;
      this.elevation = this.mode === 'menu' ? MENU_ELEVATION : GAME_ELEVATION;
    }
  }

  orbitBy(dxPx, dyPx) {
    const speed = this.mode === 'menu' ? 0.0042 : 0.0055;
    this.userAzimuth -= dxPx * speed;
    if (this.mode === 'game') this.userAzimuth = clamp(this.userAzimuth, -1.12, 1.12);
    this.userElevation = clamp(this.userElevation + dyPx * 0.0042, MIN_ELEVATION, MAX_ELEVATION);
  }

  zoomBy(scale) {
    this.zoom = clamp(this.zoom * scale, 0.62, 1.8);
  }

  shake(amount = 0.08) {
    this.shakeAmp = Math.min(0.32, Math.max(this.shakeAmp, amount));
  }

  /** Approximate distance needed to fit the slab for the current viewport. */
  fitDistance(aspect = this.aspect) {
    const size = this.boardSize;
    const halfW = (size + 1.35) * 0.5;
    const halfD = (size + 0.95) * 0.5;
    const fovX = 2 * Math.atan(Math.tan(this.fov * 0.5) * Math.max(0.2, aspect));
    const distX = halfW / Math.tan(fovX * 0.5);
    // The axis-aligned depth of the board is compressed in screen space by the
    // tilt. The extra 14% accounts for perspective and the front bevel.
    const distY = (halfD * 1.02 + 0.35) / Math.tan(this.fov * 0.5);
    return Math.max(distX, distY) * 1.02 + size * 0.16;
  }

  update(dt, aspect = this.aspect, viewportHeight = this.viewportHeight) {
    this.aspect = aspect > 0 ? aspect : 1;
    this.viewportHeight = viewportHeight > 0 ? viewportHeight : 800;
    this.time += dt;

    if (this.mode === 'menu') {
      this.menuSpin += dt * 0.075;
      const desiredAz = this.menuSpin + this.userAzimuth;
      this.azimuth = damp(this.azimuth, desiredAz, 2.1, dt);
      this.elevation = damp(this.elevation, MENU_ELEVATION + (this.userElevation - GAME_ELEVATION) * 0.4, 2.4, dt);
    } else {
      this.azimuth = damp(this.azimuth, this.userAzimuth, 5.5, dt);
      this.elevation = damp(this.elevation, this.userElevation, 5.5, dt);
    }

    this.fit = this.fitDistance(this.aspect);
    const menuScale = this.mode === 'menu' ? 1.02 : 1;
    const shortLandscape =
      this.mode === 'game' && this.aspect > 1.4 && this.viewportHeight < 560;
    const viewScale = shortLandscape ? 1.28 : 1;
    const desiredDistance = this.fit * this.zoom * menuScale * viewScale;
    this.distance = damp(this.distance, desiredDistance, 4.2, dt);
    this.distance = Math.max(this.distance, this.boardSize * 0.8);

    // Target rises a touch when zoomed out so the slab stays optically centered.
    const targetY = this.target[1] + (this.mode === 'menu' ? 0.1 : 0);

    this.shakeTime += dt;
    this.shakeAmp *= Math.exp(-6.8 * dt);
    if (this.shakeAmp < 0.0005) this.shakeAmp = 0;
    const st = this.shakeTime * 60 + this.shakeSeed;
    const sx = Math.sin(st * 1.31) * this.shakeAmp;
    const sy = Math.cos(st * 1.07) * this.shakeAmp * 0.7;
    const sz = Math.sin(st * 0.83 + 1.7) * this.shakeAmp * 0.55;

    const cosEl = Math.cos(this.elevation);
    const eye = [
      Math.sin(this.azimuth) * cosEl * this.distance + sx,
      Math.sin(this.elevation) * this.distance + targetY + sy,
      Math.cos(this.azimuth) * cosEl * this.distance + sz,
    ];
    this.eye = eye;

    const target = [targetY * 0.4 + sy * 0.25, targetY, 0];
    lookAt(this.view, eye, target, UP);
    perspective(this.proj, this.fov, this.aspect, this.near, this.far);
    multiply(this.viewProj, this.proj, this.view);
    invert(this.invViewProj, this.viewProj);
  }

  /** World-space pick ray. Coordinates are CSS pixels relative to the canvas. */
  pickRay(px, py, width, height) {
    const x = (px / Math.max(1, width)) * 2 - 1;
    const y = 1 - (py / Math.max(1, height)) * 2;
    const near = transformPoint([0, 0, 0], this.invViewProj, [x, y, -1, 1]);
    const far = transformPoint([0, 0, 0], this.invViewProj, [x, y, 1, 1]);
    const dir = normalize3(sub3(far, near));
    return { origin: near, dir };
  }

  /** Board index under the pointer, or -1. Uses the exact grid plane at y=0. */
  pickBoard(px, py, width, height, size = this.boardSize) {
    const { origin, dir } = this.pickRay(px, py, width, height);
    if (Math.abs(dir[1]) < 1e-6) return -1;
    const t = -origin[1] / dir[1];
    if (t <= 0) return -1;
    const wx = origin[0] + dir[0] * t;
    const wz = origin[2] + dir[2] * t;
    const half = (size - 1) * 0.5;
    const bx = wx + half;
    const bz = wz + half;
    if (bx < -0.55 || bz < -0.55 || bx > size - 0.45 || bz > size - 0.45) return -1;
    const gx = Math.round(bx);
    const gz = Math.round(bz);
    if (gx < 0 || gz < 0 || gx >= size || gz >= size) return -1;
    // Snap only within a stone-sized radius, not the whole cell, so dragging a
    // finger between intersections does not place wild moves.
    const dx = bx - gx;
    const dz = bz - gz;
    if (dx * dx + dz * dz > 0.44 * 0.44) return -1;
    return gz * size + gx;
  }

  /** World position of an intersection. */
  boardPoint(index, size = this.boardSize, y = 0) {
    const half = (size - 1) * 0.5;
    return [(index % size) - half, y, Math.floor(index / size) - half];
  }

  projectToScreen(world, width, height) {
    const p = transformPoint([0, 0, 0], this.viewProj, [world[0], world[1], world[2], 1]);
    return [(p[0] * 0.5 + 0.5) * width, (0.5 - p[1] * 0.5) * height, p[2]];
  }
}
