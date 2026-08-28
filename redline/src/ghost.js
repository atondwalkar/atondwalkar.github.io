// The ghost: your best run, driving beside you.
//
// A recorder samples the player at a fixed rate while a timed run is going; a
// replayer plays a saved recording back as a translucent car that nothing can
// hit. The two halves share a format — arrays of [x, z, yaw] at GHOST_HZ —
// and the format is versioned in storage, because a saved ghost outlives the
// session and the code that reads it will change.
//
// Twenty hertz, interpolated on playback. The simulation steps at 120 and
// recording all of it would be six times the storage for movement the eye
// cannot tell apart once it is lerped: a car travels about two metres between
// 20 Hz samples at race speed, and the path between is as good as straight.

import * as THREE from 'three';
import { buildCar } from './carmodels.js';
import { clamp, lerp, angleDiff } from './utils.js';

export const GHOST_HZ = 20;
const VERSION = 1;
const KEY = (layoutId) => `redline.ghost.${layoutId}`;

export class GhostRecorder {
  constructor() {
    this.frames = [];
    this.acc = 0;
  }

  step(dt, vehicle) {
    // The first frame is pushed IMMEDIATELY, at time zero. Without it the
    // recording starts fifty milliseconds into the run, and on playback the
    // ghost sits clamped at its first sample while the real car was still on
    // the line — a four-metre teleport at the start of every replay.
    if (!this.frames.length) this._push(vehicle);
    this.acc += dt;
    const period = 1 / GHOST_HZ;
    while (this.acc >= period) {
      this.acc -= period;
      this._push(vehicle);
    }
  }

  _push(vehicle) {
    this.frames.push([
      Math.round(vehicle.x * 100) / 100,
      Math.round(vehicle.z * 100) / 100,
      Math.round(vehicle.yaw * 1000) / 1000,
    ]);
  }

  get seconds() { return this.frames.length / GHOST_HZ; }
}

// Save a finished run if it beats what is stored. Returns true if it did.
export function saveIfBest(layoutId, frames, time) {
  try {
    const old = loadGhost(layoutId);
    if (old && old.time <= time) return false;
    localStorage.setItem(KEY(layoutId), JSON.stringify({ v: VERSION, time, frames }));
    return true;
  } catch (e) {
    return false;                       // a private window: the run still counted
  }
}

export function loadGhost(layoutId) {
  try {
    const raw = localStorage.getItem(KEY(layoutId));
    if (!raw) return null;
    const g = JSON.parse(raw);
    if (g.v !== VERSION || !Array.isArray(g.frames) || g.frames.length < GHOST_HZ) return null;
    return g;
  } catch (e) {
    return null;
  }
}

// The car on the road. Translucent, unlit by gameplay — no shadow, no
// collisions, no dot on the map — because a ghost is a reference, not a
// participant, and the first thing every ghost implementation gets wrong is
// letting the player draft it.
export class GhostCar {
  constructor(scene, livery, frames) {
    this.frames = frames;
    this.t = 0;
    this.model = buildCar(livery);
    this.model.rotation.order = 'YXZ';
    this.model.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      o.material = o.material.clone();
      o.material.transparent = true;
      o.material.opacity = 0.32;
      o.material.depthWrite = false;
    });
    // The contact shadow is the one part that reads as MASS, which a ghost
    // has none of.
    if (this.model.userData.shadow) this.model.userData.shadow.visible = false;
    scene.add(this.model);
    this.scene = scene;
  }

  step(dt, track) {
    this.t += dt;
    // frames[0] is the car on the line at t = 0 — the recorder pushes it
    // before its first accumulated period — so index k maps to k/HZ exactly.
    const i = this.t * GHOST_HZ;
    const a = this.frames[clamp(Math.floor(i), 0, this.frames.length - 1)];
    const b = this.frames[clamp(Math.floor(i) + 1, 0, this.frames.length - 1)];
    const f = i - Math.floor(i);
    const x = lerp(a[0], b[0], f);
    const z = lerp(a[1], b[1], f);
    // Yaw through the short way round, or the car spins at the ±π seam.
    const yaw = a[2] + angleDiff(b[2], a[2]) * f;
    const y = track.locate(x, z).y;
    this.model.position.set(x, y, z);
    this.model.rotation.y = yaw;
  }

  get done() { return this.t * GHOST_HZ >= this.frames.length - 1; }

  dispose() {
    this.scene.remove(this.model);
    this.model.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
  }
}
