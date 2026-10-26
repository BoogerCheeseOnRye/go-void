/* GO/VOID — tiny procedural sound engine. No audio files, no dependencies. */

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class Soundscape {
  constructor() {
    this.enabled = true;
    this.haptics = true;
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.volume = 0.55;
  }

  unlock() {
    if (!this.enabled) return;
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 18;
        comp.ratio.value = 5;
        comp.attack.value = 0.003;
        comp.release.value = 0.22;
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
        const length = Math.floor(this.ctx.sampleRate * 1.2);
        this.noiseBuffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
        const data = this.noiseBuffer.getChannelData(0);
        let last = 0;
        for (let i = 0; i < length; i++) {
          const white = Math.random() * 2 - 1;
          last = last * 0.72 + white * 0.28;
          data[i] = last;
        }
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.master) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, now, 0.03);
    }
    if (this.enabled) this.unlock();
  }

  setHaptics(enabled) {
    this.haptics = Boolean(enabled);
  }

  vibrate(pattern) {
    if (!this.haptics) return;
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* not supported */
    }
  }

  _ready() {
    return this.enabled && this.ctx && this.ctx.state === 'running';
  }

  _noise(duration, gain, filterType, frequency, q = 1) {
    if (!this.noiseBuffer) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + duration + 0.02);
    return { src, filter, gain: g };
  }

  _tone(freq, duration, gain, type = 'sine', bend = 0) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (bend) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * bend), t + duration);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.03);
    return osc;
  }

  stone(color = 1, pan = 0, power = 1) {
    if (!this._ready()) return;
    try {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-0.8, Math.min(0.8, pan));
      panner.connect(this.master);
      const noise = this._noise(0.06, 0.22 * power, 'bandpass', color === 1 ? 1900 : 2800, 1.2);
      if (noise) {
        // Re-route the click through the panner.
        noise.gain.disconnect();
        noise.gain.connect(panner);
      }
      const body = ctx.createOscillator();
      const bodyGain = ctx.createGain();
      body.type = 'triangle';
      body.frequency.setValueAtTime(color === 1 ? 155 : 210, t);
      body.frequency.exponentialRampToValueAtTime(color === 1 ? 84 : 120, t + 0.14);
      bodyGain.gain.setValueAtTime(0.0001, t);
      bodyGain.gain.exponentialRampToValueAtTime(0.18 * power, t + 0.008);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      body.connect(bodyGain);
      bodyGain.connect(panner);
      body.start(t);
      body.stop(t + 0.24);
      this._tone(color === 1 ? 920 : 1320, 0.08, 0.035, 'sine');
    } catch {
      /* ignore audio failures */
    }
  }

  capture(power = 1) {
    if (!this._ready()) return;
    try {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const noise = this._noise(0.55, 0.34 * power, 'lowpass', 1600, 0.6);
      if (noise) noise.filter.frequency.exponentialRampToValueAtTime(180, t + 0.5);
      this._tone(120, 0.5, 0.25 * power, 'sine', 0.35);
      this._tone(180, 0.35, 0.12 * power, 'triangle', 0.4);
      this._tone(880, 0.28, 0.07 * power, 'sine', 1.8);
      const shimmer = ctx.createOscillator();
      const sg = ctx.createGain();
      shimmer.type = 'sawtooth';
      shimmer.frequency.setValueAtTime(2400, t);
      shimmer.frequency.exponentialRampToValueAtTime(600, t + 0.4);
      sg.gain.setValueAtTime(0.035 * power, t);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1800;
      shimmer.connect(filter);
      filter.connect(sg);
      sg.connect(this.master);
      shimmer.start(t);
      shimmer.stop(t + 0.42);
      this.vibrate([0, 28, 22, 46]);
    } catch {
      /* ignore */
    }
  }

  pass() {
    if (!this._ready()) return;
    try {
      const noise = this._noise(0.36, 0.12, 'bandpass', 900, 0.9);
      if (noise) {
        const t = this.ctx.currentTime;
        noise.filter.frequency.exponentialRampToValueAtTime(220, t + 0.34);
      }
      this._tone(300, 0.32, 0.05, 'sine', 0.7);
    } catch {
      /* ignore */
    }
  }

  ui() {
    if (!this._ready()) return;
    this._tone(660, 0.05, 0.025, 'sine', 1.2);
  }

  error() {
    if (!this._ready()) return;
    this._tone(110, 0.18, 0.09, 'square', 0.8);
    this.vibrate(28);
  }

  win() {
    if (!this._ready()) return;
    try {
      const notes = [392, 523.25, 659.25, 783.99];
      notes.forEach((freq, i) => {
        const ctx = this.ctx;
        const t = ctx.currentTime + i * 0.11;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.11, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        osc.connect(g);
        g.connect(this.master);
        osc.start(t);
        osc.stop(t + 1);
      });
    } catch {
      /* ignore */
    }
  }

  lose() {
    if (!this._ready()) return;
    try {
      const notes = [329.63, 293.66, 246.94, 196];
      notes.forEach((freq, i) => {
        const ctx = this.ctx;
        const t = ctx.currentTime + i * 0.16;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.07, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
        osc.connect(g);
        g.connect(this.master);
        osc.start(t);
        osc.stop(t + 1.2);
      });
    } catch {
      /* ignore */
    }
  }
}
