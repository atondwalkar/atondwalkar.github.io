// The camera. A chase camera that is rigidly attached to the car tells you
// nothing about what the car is doing; one that lags behind it, leans with it
// and pulls back as the speed rises tells you almost everything. The other
// views are here because a cockpit view is how you judge an apex and a bonnet
// view is how you judge a gap.

import * as THREE from 'three';
import { clamp, lerp, damp } from './utils.js';

export const VIEWS = ['CHASE', 'CLOSE', 'BONNET', 'COCKPIT'];

const RIGS = {
  CHASE: { back: 7.4, up: 2.85, ahead: 6.5, fov: 70, stiff: 7.0, roll: 0.35 },
  CLOSE: { back: 5.2, up: 2.05, ahead: 5.5, fov: 66, stiff: 9.5, roll: 0.30 },
  BONNET: { back: -0.55, up: 1.06, ahead: 12, fov: 74, stiff: 26, roll: 0.55 },
  COCKPIT: { back: 0.35, up: 1.02, ahead: 12, fov: 68, stiff: 30, roll: 0.75 },
};

// A subject's own frame. Every shot is expressed in it — `ahead` down the
// car's nose, `left` across it, `up` from the road — which is what pins the
// car in the same place on screen while the city streams past behind it.
export function cameraFrame(car) {
  const v = car.vehicle;
  const y = car.loc ? car.loc.y : 0;
  const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
  const lx = Math.cos(v.yaw), lz = -Math.sin(v.yaw);
  return {
    x: v.x, y, z: v.z, yaw: v.yaw,
    p: (ahead, left, up) => [v.x + fx * ahead + lx * left, y + up, v.z + fz * ahead + lz * left],
  };
}

// The shot list.
//
// Every distance is from the car's CENTRE, and a car is two metres wide and
// four and a half long. Four metres to the side is one metre off its flank,
// which fills the frame with a door — the first cut of the title sequence put
// the camera inside the bodywork exactly that way.
//
// `k` runs 0..1 through the shot, so a shot can move. `g` is the second
// actor's frame, for two-shots.
export const SHOTS = {
  // --- the title reel
  lowRear:    (f, k) => ({ from: f.p(-(10.5 - k * 2.4), 1.6, 1.0), at: f.p(5, 0, 0.85), fov: 40 }),
  trackPast:  (f, k) => ({ from: f.p(7 - k * 14, 8.2, 1.05),       at: f.p(0, 0, 0.70), fov: 40 }),
  headOn:     (f, k) => ({ from: f.p(12 + k * 6, -3.4, 1.7),       at: f.p(0, 0, 0.75), fov: 38 }),
  wheelArch:  (f)    => ({ from: f.p(1.2, 2.5, 0.95),              at: f.p(26, 3, 1.7), fov: 48 }),
  highWide:   (f)    => ({ from: f.p(-14, -6.5, 6.2),              at: f.p(10, 0, 1.0), fov: 42 }),

  // --- for scripted scenes
  // Close on the nose, easing in. Far enough out to hold the whole car.
  closeFront: (f, k) => ({ from: f.p(7.6 - k * 0.9, 1.4, 1.15),    at: f.p(0, 0, 1.0),  fov: 44 }),
  // Over the shoulder at the other car, which is what a stand-off looks like.
  twoShot: (f, k, g) => {
    if (!g) return { from: f.p(8.5, 3.2, 1.5), at: f.p(0, 0, 1.0), fov: 42 };
    const mx = (f.x + g.x) / 2, mz = (f.z + g.z) / 2, my = (f.y + g.y) / 2;
    // Perpendicular to the line between them, so both are in frame.
    let dx = g.x - f.x, dz = g.z - f.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    const out = Math.max(9, d * 0.95) + k * 1.2;
    return { from: [mx - dz * out, my + 2.0, mz + dx * out], at: [mx, my + 0.9, mz], fov: 40 };
  },
  // A slow arc, for a beat that wants to breathe. Absorbs the old orbit().
  orbit: (f, k) => {
    const a = k * 1.5;
    const r = 12.5;
    return {
      from: [f.x + Math.sin(a) * r, f.y + 3.6, f.z + Math.cos(a) * r],
      at: [f.x, f.y + 0.75, f.z], fov: 38,
    };
  },
};

const ATTRACT_REEL = ['lowRear', 'trackPast', 'headOn', 'wheelArch', 'highWide'];
const ATTRACT_SHOT = 4.6;

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.view = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.shake = 0;
    this.lookBack = false;
    this._wasBack = false;
    this.started = false;
  }

  cycle() {
    this.view = (this.view + 1) % VIEWS.length;
    this.started = false;                     // snap rather than sweep across
    return VIEWS[this.view];
  }

  get name() { return VIEWS[this.view]; }

  bump(amount) { this.shake = Math.min(1.4, this.shake + amount); }

  update(dt, car) {
    const rig = RIGS[VIEWS[this.view]];
    // Looking behind is a glance, not a manoeuvre. Swinging the camera round
    // on the spring takes most of a second at either end, which is a second of
    // looking at the scenery going past sideways while whoever you were trying
    // to see goes somewhere else. Snap it, both ways.
    if (this.lookBack !== this._wasBack) { this._wasBack = this.lookBack; this.started = false; }
    const v = car.vehicle;
    const speed = v.speed;
    const y = car.loc ? car.loc.y : 0;

    // The camera sits behind the car's *heading*, not its nose, so a car that
    // is sideways stays in frame and you can see where you are actually going.
    const drift = Math.atan2(v.v, Math.max(Math.abs(v.u), 4));
    const blend = VIEWS[this.view] === 'CHASE' || VIEWS[this.view] === 'CLOSE' ? 0.55 : 0;
    let yaw = v.yaw - drift * blend;
    if (this.lookBack) yaw += Math.PI;

    const back = rig.back * (1 + clamp(speed / 90, 0, 1) * 0.16);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const want = new THREE.Vector3(
      v.x - fx * back,
      y + rig.up + clamp(speed / 90, 0, 1) * 0.35,
      v.z - fz * back,
    );
    // Bonnet and cockpit are bolted on; the chase views are on a spring.
    const target = new THREE.Vector3(
      v.x + fx * rig.ahead,
      y + 0.95 + (VIEWS[this.view] === 'CHASE' ? 0.3 : 0),
      v.z + fz * rig.ahead,
    );
    // A camera that has just been switched to snaps; one that is running
    // follows on a spring. Both ends of it have to snap, or it points at
    // wherever it was last looking.
    if (!this.started) { this.pos.copy(want); this.look.copy(target); this.started = true; }
    this.pos.lerp(want, clamp(rig.stiff * dt, 0, 1));
    this.look.lerp(target, clamp((rig.stiff + 4) * dt, 0, 1));

    this.shake = damp(this.shake, 0, 5, dt);
    // Kerbs and contact shake the camera; so, very slightly, does raw speed.
    const rattle = this.shake * 0.10 + clamp(speed / 110, 0, 1) * 0.012;
    this.camera.position.set(
      this.pos.x + (Math.random() - 0.5) * rattle,
      this.pos.y + (Math.random() - 0.5) * rattle,
      this.pos.z + (Math.random() - 0.5) * rattle,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);
    // Lean the horizon into the corner.
    this.camera.rotateZ(clamp(-v.lateralG * rig.roll * 0.055, -0.12, 0.12));

    const fov = rig.fov + clamp(speed / 95, 0, 1) * 9;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = lerp(this.camera.fov, fov, clamp(dt * 4, 0, 1));
      this.camera.updateProjectionMatrix();
    }
  }

  // Play one named shot from SHOTS. `k` is 0..1 through it; `id` changes on a
  // cut. `second` is the other actor in a two-shot.
  //
  // The cut/ease mechanism is the whole trick and is unchanged: hard-copy
  // pos/look on the frame the id changes, lerp every other frame.
  playShot(dt, name, subject, k, id, second = null) {
    const shot = SHOTS[name] || SHOTS.lowRear;
    const s = shot(cameraFrame(subject), clamp(k, 0, 1), second ? cameraFrame(second) : null);

    if (this._shot !== id) { this._shot = id; this.started = false; }
    const want = new THREE.Vector3(s.from[0], s.from[1], s.from[2]);
    const look = new THREE.Vector3(s.at[0], s.at[1], s.at[2]);
    if (!this.started) { this.pos.copy(want); this.look.copy(look); this.started = true; }
    this.pos.lerp(want, clamp(9 * dt, 0, 1));
    this.look.lerp(look, clamp(11 * dt, 0, 1));
    this.camera.position.copy(this.pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);
    const fov = s.fov;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = lerp(this.camera.fov, fov, clamp(dt * 5, 0, 1));
      this.camera.updateProjectionMatrix();
    }
  }

  // The title screen: five shots of one car, cutting every few seconds.
  //
  // Cuts rather than one long move, because a continuous shot of a car going
  // round a lap is a lap, not a title sequence.
  cinematic(dt, car, t) {
    const n = Math.floor(t / ATTRACT_SHOT) % ATTRACT_REEL.length;
    this.playShot(dt, ATTRACT_REEL[n], car, (t % ATTRACT_SHOT) / ATTRACT_SHOT, n);
  }
}
