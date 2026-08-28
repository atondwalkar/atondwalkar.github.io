// Sound, synthesised. There are no samples in this project, so the engine is
// built the way an engine actually sounds: a fundamental at the firing
// frequency, a couple of harmonics above it, and a filter that opens with the
// throttle. Because it is driven from the rpm the physics is already
// calculating, it stays in step with the gearbox for free — you can hear the
// shift because the note really does drop.

import { clamp, lerp } from './utils.js';

const CYLINDERS = 8;

export class AudioFX {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.75;
    this.lx = 0; this.lz = 0; this.lyaw = 0;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { this.enabled = false; return; }
    this.ctx = new Ctx();
    const t = this.ctx.currentTime;

    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);

    // --- the player's engine
    this.engine = this.ctx.createGain();
    this.engine.gain.value = 0;
    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 1.2;
    this.engine.connect(this.engineFilter);
    this.engineFilter.connect(this.master);

    this.oscs = [];
    for (const [type, mult, gain] of [
      ['sawtooth', 0.5, 0.32], ['sawtooth', 1, 0.44],
      ['square', 2, 0.14], ['sawtooth', 3, 0.08],
    ]) {
      const o = this.ctx.createOscillator();
      o.type = type;
      const g = this.ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(this.engine);
      o.start(t);
      this.oscs.push({ o, g, mult });
    }

    // --- a noise source, shared by the tyres, the wind and the impacts
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    this.tyre = this._noiseChannel('bandpass', 1750, 5.5);
    this.wind = this._noiseChannel('lowpass', 620, 0.9);
    this.gravel = this._noiseChannel('lowpass', 380, 1.2);
    // --- the rest of the field, as one layer that tracks the nearest car
    this.traffic = this.ctx.createGain();
    this.traffic.gain.value = 0;
    this.trafficFilter = this.ctx.createBiquadFilter();
    this.trafficFilter.type = 'lowpass';
    this.trafficFilter.frequency.value = 700;
    this.traffic.connect(this.trafficFilter);
    this.trafficFilter.connect(this.master);
    this.trafficOsc = this.ctx.createOscillator();
    this.trafficOsc.type = 'sawtooth';
    this.trafficOsc.connect(this.traffic);
    this.trafficOsc.start(t);
  }

  _noiseChannel(type, freq, q) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(this.ctx.currentTime);
    return { src, filter: f, gain: g };
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.volume;
  }

  // Called every frame with the player's car and the nearest rival.
  update(dt, player, nearest, nearestDist) {
    if (!this.ctx) return;
    const v = player.vehicle;
    const t = this.ctx.currentTime;

    // Firing frequency: an eight cylinder fires four times per revolution.
    const f = (v.rpm / 60) * (CYLINDERS / 2);
    for (const { o, mult } of this.oscs) {
      o.frequency.setTargetAtTime(clamp(f * mult, 20, 8000), t, 0.02);
    }
    // Off the throttle the engine is quieter and duller; on it, brighter.
    const load = lerp(0.35, 1, v.throttle);
    const rev = clamp(v.rpm / v.spec.redline, 0, 1.1);
    this.engine.gain.setTargetAtTime(0.16 * load * (0.55 + rev * 0.6), t, 0.03);
    this.engineFilter.frequency.setTargetAtTime(
      lerp(520, 4200, load * (0.35 + rev * 0.65)), t, 0.04);

    // Tyres: the noise of a tyre past its limit, front or rear.
    const slip = Math.max(v.slipF, v.slipR);
    const screech = clamp((slip - 1.02) * 1.5, 0, 1) * clamp(v.speed / 8, 0, 1);
    this.tyre.gain.gain.setTargetAtTime(screech * 0.20, t, 0.05);
    this.tyre.filter.frequency.setTargetAtTime(1400 + screech * 900, t, 0.06);

    // Wind, and the rumble of a car that has run wide.
    this.wind.gain.gain.setTargetAtTime(clamp(v.speed / 90, 0, 1) ** 2 * 0.13, t, 0.08);
    this.gravel.gain.gain.setTargetAtTime(
      v.onTrack ? 0 : clamp(v.speed / 40, 0, 1) * 0.16, t, 0.06);

    // The nearest other car: louder and higher the closer it is.
    if (nearest && nearestDist < 55) {
      const near = 1 - nearestDist / 55;
      const nf = (nearest.vehicle.rpm / 60) * (CYLINDERS / 2);
      this.trafficOsc.frequency.setTargetAtTime(clamp(nf, 20, 4000), t, 0.05);
      this.traffic.gain.setTargetAtTime(0.055 * near * near, t, 0.06);
    } else {
      this.traffic.gain.setTargetAtTime(0, t, 0.1);
    }
    void dt;
  }

  // --- one-shots

  _burst({ freq = 400, q = 1, type = 'bandpass', vol = 0.2, decay = 0.2, delay = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t);
    src.stop(t + decay + 0.05);
  }

  _tone({ from, to, vol = 0.2, decay = 0.2, type = 'sine', delay = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + decay);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g); g.connect(this.master);
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  // The bang between gears on a car with a sequential box.
  shift(up) {
    this._burst({ freq: up ? 2600 : 1800, q: 3, vol: 0.13, decay: 0.06 });
    if (up) this._tone({ from: 180, to: 90, vol: 0.10, decay: 0.09, type: 'square' });
  }

  impact(force) {
    const v = clamp(force / 14, 0.12, 1);
    this._burst({ freq: 260, q: 0.7, type: 'lowpass', vol: 0.42 * v, decay: 0.22 });
    this._burst({ freq: 3200, q: 2.4, vol: 0.20 * v, decay: 0.10 });
    this._tone({ from: 130, to: 55, vol: 0.28 * v, decay: 0.26, type: 'triangle' });
  }

  scrape(force) {
    this._burst({ freq: 2100, q: 4, vol: clamp(force / 26, 0.04, 0.16), decay: 0.14 });
  }

  light() { this._tone({ from: 520, to: 520, vol: 0.22, decay: 0.28, type: 'square' }); }

  lightsOut() {
    this._tone({ from: 880, to: 880, vol: 0.26, decay: 0.5, type: 'square' });
  }

  chequered() {
    for (let i = 0; i < 3; i++) {
      this._tone({ from: 700 + i * 220, to: 700 + i * 220, vol: 0.2, decay: 0.22, delay: i * 0.16 });
    }
  }

  // The siren.
  //
  // A continuous two-tone wail rather than a sample, and one voice however
  // many cars there are: three sirens playing the same waveform out of phase
  // is a chord, not a pursuit, and three playing IN phase is one siren three
  // times too loud. What sells it is proximity, so the gain is driven by how
  // close the nearest of them has got — which is the number the player is
  // actually listening for.
  //
  // `near` is metres to the closest pursuer, or null for none.
  siren(near) {
    if (!this.ctx) return;
    if (near === null || near === undefined) {
      if (this.sirenGain) this.sirenGain.gain.value = 0;
      return;
    }
    if (!this.sirenGain) {
      this.sirenGain = this.ctx.createGain();
      this.sirenGain.gain.value = 0;
      const shape = this.ctx.createBiquadFilter();
      shape.type = 'bandpass';
      shape.frequency.value = 900;
      shape.Q.value = 0.9;
      this.sirenGain.connect(shape);
      shape.connect(this.master);
      this.sirenOsc = this.ctx.createOscillator();
      this.sirenOsc.type = 'sawtooth';
      this.sirenOsc.frequency.value = 700;
      // The wail: a slow triangle on the pitch, about half a hertz, which is
      // the American two-tone rather than the European hi-lo.
      const lfo = this.ctx.createOscillator();
      lfo.type = 'triangle';
      lfo.frequency.value = 0.55;
      const depth = this.ctx.createGain();
      depth.gain.value = 260;
      lfo.connect(depth);
      depth.connect(this.sirenOsc.frequency);
      this.sirenOsc.connect(this.sirenGain);
      this.sirenOsc.start();
      lfo.start();
    }
    // Audible from a long way back and loud on your bumper, rolled off rather
    // than switched on so it grows as they arrive.
    const k = clamp(1 - near / 160, 0, 1);
    this.sirenGain.gain.value = 0.030 * k * k;
  }

  setListener(x, z, yaw) { this.lx = x; this.lz = z; this.lyaw = yaw; }
}
