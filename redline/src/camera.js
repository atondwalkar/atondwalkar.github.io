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

  // The title-screen cutscene: a close shot of a car on the street, cutting
  // between angles every few seconds.
  //
  // Cuts rather than one long move, because a single continuous shot of a car
  // going round a lap is a lap, not a title sequence. Each shot is anchored to
  // the car's own frame so it holds the car in the same place on screen while
  // the city goes past behind it, which is the whole trick.
  cinematic(dt, car, t) {
    const v = car.vehicle;
    const y = car.loc ? car.loc.y : 0;
    const SHOT = 4.6;
    const n = Math.floor(t / SHOT) % 5;
    const k = (t % SHOT) / SHOT;                 // 0..1 through this shot
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    const lx = Math.cos(v.yaw), lz = -Math.sin(v.yaw);
    let from, at, fov = 34;

    // Every distance here is from the car's CENTRE, and the car is about two
    // metres wide and four and a half long. Four metres to the side is one
    // metre off its flank, which fills the frame with a door — the first cut
    // of this put the camera inside the bodywork. These are all set to leave
    // the whole car in shot with the street behind it.
    if (n === 0) {
      // Low and behind, drifting in over the shot.
      const back = 10.5 - k * 2.4;
      from = [v.x - fx * back + lx * 1.6, y + 1.0, v.z - fz * back + lz * 1.6];
      at = [v.x + fx * 5, y + 0.85, v.z + fz * 5];
      fov = 40;
    } else if (n === 1) {
      // Side on, low, tracking past as the car goes by.
      const along = 7 - k * 14;
      from = [v.x + lx * 8.2 + fx * along, y + 1.05, v.z + lz * 8.2 + fz * along];
      at = [v.x, y + 0.7, v.z];
      fov = 40;
    } else if (n === 2) {
      // Ahead of it, looking back, falling away as the car closes.
      const lead = 12 + k * 6;
      from = [v.x + fx * lead - lx * 3.4, y + 1.7, v.z + fz * lead - lz * 3.4];
      at = [v.x, y + 0.75, v.z];
      fov = 38;
    } else if (n === 3) {
      // Just outside the front wheel, looking down the street with the nose of
      // the car in the corner of frame.
      from = [v.x + lx * 2.5 + fx * 1.2, y + 0.95, v.z + lz * 2.5 + fz * 1.2];
      at = [v.x + fx * 26 + lx * 3, y + 1.7, v.z + fz * 26 + lz * 3];
      fov = 48;
    } else {
      // High and behind, showing the street rather than the car.
      from = [v.x - fx * 14 - lx * 6.5, y + 6.2, v.z - fz * 14 - lz * 6.5];
      at = [v.x + fx * 10, y + 1.0, v.z + fz * 10];
      fov = 42;
    }

    // Snap on a cut, ease within a shot.
    if (this._shot !== n) { this._shot = n; this.started = false; }
    const want = new THREE.Vector3(from[0], from[1], from[2]);
    const look = new THREE.Vector3(at[0], at[1], at[2]);
    if (!this.started) { this.pos.copy(want); this.look.copy(look); this.started = true; }
    this.pos.lerp(want, clamp(9 * dt, 0, 1));
    this.look.lerp(look, clamp(11 * dt, 0, 1));
    this.camera.position.copy(this.pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = lerp(this.camera.fov, fov, clamp(dt * 5, 0, 1));
      this.camera.updateProjectionMatrix();
    }
  }

  // A slow orbit of the grid before the lights, and of the winner afterwards.
  orbit(dt, car, t) {
    const v = car.vehicle;
    const y = car.loc ? car.loc.y : 0;
    const r = 12 + Math.sin(t * 0.3) * 2;
    this.camera.position.set(v.x + Math.sin(t * 0.35) * r, y + 4.2, v.z + Math.cos(t * 0.35) * r);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(v.x, y + 0.7, v.z);
    this.started = false;
    void dt;
  }
}
