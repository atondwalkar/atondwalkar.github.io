// The other fifteen drivers.
//
// A bot does what a driver does: it looks a corner ahead, works out the fastest
// it could be there and still stop in time, and then either presses the
// throttle or the brake. It aims at a point on the racing line rather than at
// the line itself, which is why it takes a smooth arc through a corner instead
// of sawing at the wheel.
//
// The interesting part is the traffic. A driver who only follows the line will
// drive into the back of anyone slower, so each one also looks at the cars
// around it, picks the side with more room, and commits to a pass or backs out
// according to how brave it is.

import { AI, CAR } from './defs.js';
import { clamp, lerp, rand, angleDiff, sign } from './utils.js';

const BRAKE_G = 1.28;   // planned with, not the 1.55 the car can actually do

export class Driver {
  constructor(car, track, skill = 0.9) {
    this.car = car;
    this.track = track;
    this.skill = skill;
    this.aggression = lerp(AI.aggression[0], AI.aggression[1], Math.random());
    this.hint = -1;
    this.offset = 0;              // where on the track it wants to be, in metres
    this.offsetTarget = 0;
    this.reactT = 0;
    this.mistake = 0;             // seconds of degraded input after an error
    this.mistakeCooldown = rand(8, 40);
    this.brakeNoise = rand(-1, 1) * (1 - skill) * 0.10;
    this.throttleNoise = rand(-1, 1) * (1 - skill) * 0.06;
    this.recoverT = 0;
    this.blocked = null;
  }

  // The fastest this car could be `d` metres from here and still have slowed to
  // `v` by then. This is the whole of a braking point in one line.
  static reach(v, d) {
    return Math.sqrt(v * v + 2 * BRAKE_G * 9.81 * Math.max(0, d));
  }

  drive(dt, cars) {
    const v = this.car.vehicle;
    const t = this.track;
    const loc = t.locate(v.x, v.z, this.hint);
    this.hint = loc.index;
    this.car.loc = loc;

    const speed = Math.max(v.u, 0);
    this.reactT -= dt;
    this.mistakeCooldown -= dt;
    this.mistake = Math.max(0, this.mistake - dt);

    // Every so often even a good driver misses a braking point.
    if (this.mistakeCooldown <= 0) {
      this.mistakeCooldown = rand(14, 55) / (1.15 - this.skill);
      if (Math.random() > this.skill) this.mistake = rand(0.4, 1.3);
    }

    // --- spun, stopped or in the scenery: get back to the track first
    if (this._recover(dt, loc, speed)) return;
    v.wantReverse = false;

    // --- where to aim
    const look = clamp(8 + speed * 0.62, 12, 46);
    const aimS = loc.s + look;
    const lineAt = this._lineAt(aimS);

    if (this.reactT <= 0) {
      this.reactT = AI.reaction * rand(0.7, 1.3);
      this.offsetTarget = this._chooseOffset(loc, cars, speed);
    }
    this.offset = lerp(this.offset, this.offsetTarget, clamp(dt * 2.2, 0, 1));

    const aimSample = t.atDistance(aimS);
    const tx = lineAt.x + aimSample.nx * this.offset;
    const tz = lineAt.z + aimSample.nz * this.offset;

    // --- steering, by pure pursuit toward that point.
    //
    // Work out the road-wheel angle the geometry needs, then ask for whatever
    // fraction of the available lock that is. Asking for a fraction directly —
    // which is what this did — under-steers badly at speed, because the lock
    // available at two hundred is a small part of the lock available at thirty.
    const dx = tx - v.x, dz = tz - v.z;
    const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
    const localZ = dx * sy + dz * cy;
    const localX = dx * cy - dz * sy;
    const ld = Math.max(Math.hypot(localX, localZ), 4);
    const alpha = Math.atan2(localX, Math.max(localZ, 0.5));
    let wantAngle = Math.atan2(2 * CAR.wheelbase * Math.sin(alpha), ld);
    // Countersteer: if the car is sliding, chase the slide rather than the point.
    const slideAngle = Math.atan2(v.v, Math.max(Math.abs(v.u), 1));
    wantAngle += clamp(slideAngle, -0.45, 0.45) * (this.skill * 0.85 + 0.15);
    const maxAngle = Math.max(v.maxSteerAngle, 1e-3);
    v.steerInput = clamp(wantAngle / maxAngle, -1, 1) * (this.mistake > 0 ? 0.85 : 1);

    // --- how fast we are allowed to be, looking down the road
    let limit = Infinity;
    for (let d = 0; d < 190; d += t.step * 2) {
      const p = this._lineAt(loc.s + d);
      const allowed = Driver.reach(p.speed, d);
      if (allowed < limit) limit = allowed;
    }
    // Skill is mostly this line: how close to the limit the driver is willing
    // to run. A tenth of a g around a lap is several seconds.
    limit *= AI.cornerMargin * lerp(0.90, 1.03, this.skill);
    if (this.mistake > 0) limit *= 1.14;                 // braked too late
    limit = Math.max(limit, 6);

    // --- traffic: do not drive into the back of the car in front
    const ahead = this._carAhead(cars, loc);
    if (ahead) {
      const closing = speed - ahead.speed;
      const room = ahead.distance - 6.5;
      if (room < 1) limit = Math.min(limit, ahead.speed * 0.85);
      else if (closing > 0) {
        limit = Math.min(limit, Driver.reach(ahead.speed, room) * 0.98);
      }
    }

    // --- pedals
    const over = speed - limit;
    if (over > 0.5) {
      v.brake = clamp((over - 0.5) / 3.5 + 0.16 + this.brakeNoise, 0, 1);
      v.throttle = 0;
    } else {
      v.brake = 0;
      const head = limit - speed;
      v.throttle = clamp(head / 5 + 0.35 + this.throttleNoise, 0, 1);
      // Do not simply floor it out of a slow corner: that is how you spin.
      const grip = clamp(1 - Math.abs(v.lateralG) / 1.5, 0.18, 1);
      const traction = clamp(1 - Math.abs(v.wheelSpin) * 2.4, 0.25, 1);
      v.throttle = Math.min(v.throttle, lerp(0.55, 1, grip * traction * this.skill));
    }
    v.handbrake = 0;
  }

  // Which line to take: the racing line normally, moved aside to overtake, to
  // defend, or to avoid somebody who is about to be in the way.
  _chooseOffset(loc, cars, speed) {
    const t = this.track;
    const halfWidth = loc.width / 2 - 1.5;
    const lineOffset = this._lineAt(loc.s + 20).offset;
    let want = 0;                                   // relative to the racing line
    this.blocked = null;

    for (const other of cars) {
      if (other === this.car || !other.vehicle) continue;
      const gap = t.gap(other.loc ? other.loc.s : 0, loc.s);
      if (gap < -3 || gap > 34) continue;           // only what is in front
      const theirOffset = other.loc ? other.loc.lateral : 0;
      const side = theirOffset - loc.lateral;
      if (Math.abs(side) > 5.5) continue;           // already going past
      this.blocked = other;
      // Go the way there is most road. If they are on the left, take the right.
      const room = (s) => halfWidth - Math.abs(lineOffset + s * 4.2);
      const preferRight = side < 0 ? 1 : -1;
      const alt = room(preferRight) > 1.2 ? preferRight : -preferRight;
      const commitment = gap < 16 ? 1 : 0.55;
      want += alt * 4.4 * commitment * this.aggression;
    }

    // Keep off the kerbs unless the line is there.
    const total = clamp(lineOffset + want, -halfWidth, halfWidth);
    return total - lineOffset;
  }

  _carAhead(cars, loc) {
    const t = this.track;
    let best = null;
    for (const other of cars) {
      if (other === this.car || !other.loc) continue;
      const gap = t.gap(other.loc.s, loc.s);
      if (gap <= 0 || gap > 40) continue;
      if (Math.abs(other.loc.lateral - loc.lateral - this.offset) > 4.0) continue;
      if (!best || gap < best.distance) {
        best = { car: other, distance: gap, speed: Math.max(other.vehicle.u, 0) };
      }
    }
    return best;
  }

  _lineAt(s) {
    const t = this.track;
    const n = t.line.length;
    const i = Math.round((((s % t.length) + t.length) % t.length) / t.step) % n;
    return t.line[i];
  }

  // Off the road, facing the wrong way, or stationary against a barrier: point
  // at the track and drive out of it. Returns true if it took over the controls.
  _recover(dt, loc, speed) {
    const v = this.car.vehicle;
    const t = this.track;
    const offRoad = Math.abs(loc.lateral) > loc.width / 2 + 1.5;
    const wrongWay = Math.abs(angleDiff(v.yaw, Math.atan2(loc.sample.dirX, loc.sample.dirZ))) > 1.9;
    const stuck = speed < 2.5 && (offRoad || wrongWay);

    if (stuck) this.recoverT = Math.max(this.recoverT, 0.9);
    if (this.recoverT <= 0) return false;
    this.recoverT -= dt;
    // Back on the road, pointing the right way and rolling? Nothing to recover.
    if (!offRoad && !wrongWay && speed > 8) {
      this.recoverT = 0;
      v.wantReverse = false;
      return false;
    }

    // Aim at a point on the track a little way ahead.
    const target = t.atDistance(loc.s + 22);
    const dx = target.x - v.x, dz = target.z - v.z;
    const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
    const localZ = dx * sy + dz * cy;
    const localX = dx * cy - dz * sy;

    if (localZ < 0 && v.u < 6) {
      // It is behind us: stop, select reverse, and back out steering the other
      // way. The gearbox is told to hold reverse rather than left to guess —
      // and the reversing is capped, because a car doing sixty backwards is
      // not recovering, it is having a different accident.
      v.wantReverse = true;
      v.steerInput = clamp(-Math.atan2(localX, Math.abs(localZ)) / Math.max(v.maxSteerAngle, 1e-3) * 0.35, -1, 1);
      if (v.u > 0.5) { v.brake = 1; v.throttle = 0; }
      else if (v.u < -6) { v.brake = 0.3; v.throttle = 0; }
      else { v.brake = 0; v.throttle = 0.5; }
      this.recoverT = Math.max(this.recoverT, 0.4);
    } else {
      v.wantReverse = false;
      v.steerInput = clamp(Math.atan2(localX, Math.max(localZ, 1)) / Math.max(v.maxSteerAngle, 1e-3) * 0.5, -1, 1);
      v.throttle = speed < 22 ? 0.7 : 0.35;
      v.brake = 0;
    }
    v.handbrake = 0;
    return true;
  }
}

export { BRAKE_G };
void CAR;
