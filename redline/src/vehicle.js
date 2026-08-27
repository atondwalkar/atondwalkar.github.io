// The car.
//
// This is a real vehicle model rather than an arcade approximation, because the
// two things the brief asks for — gears and handbrake drifting — only feel like
// anything if they fall out of the physics instead of being special-cased.
//
// Each axle carries a wheel with its own rotational speed, so it has a slip
// ratio (is the tyre turning faster or slower than the road under it?) and a
// slip angle (is it pointing where it is going?). A tyre model turns those two
// numbers into a force, load transfer decides how much grip each axle has to
// spend, and the body is integrated from the sum. Consequently:
//
//   * Gears matter because engine torque reaches the wheels multiplied by the
//     ratio, and the engine only makes torque over a certain band. Short gear,
//     lots of torque, easy wheelspin. Tall gear, lazy but fast.
//   * The handbrake locks the rear axle. A locked tyre has a slip ratio of -1,
//     which saturates it, and a saturated tyre has almost nothing left for
//     cornering — so the back steps out. Catching it with opposite lock is not
//     scripted anywhere; it is just what the equations do.
//
// Body axes: +z is forward and +x is the car's LEFT. That is not a typo and it
// is not arbitrary — it is what a right-handed frame with Y up and Z forward
// gives you, and getting it backwards is how the steering ends up mirrored.
// Yaw is measured about +y from +z, so world forward is (sin yaw, cos yaw) and
// increasing yaw turns the car to its left.

import {
  CAR, AIR_DENSITY, GRAVITY, CONTACT,
} from './defs.js';
import { clamp, curve, sign, approach } from './utils.js';

const KMH = 3.6;
const RPM_PER_RADS = 60 / (Math.PI * 2);

// The shape of a tyre: how much of its available grip it is using at a given
// amount of slip. It climbs to a peak at slip = 1 and then holds very nearly
// flat, so overshooting the limit costs you a little speed rather than the
// corner.
//
// A slide still comes out of this, but from the friction circle rather than
// from the curve: the longitudinal and lateral demands share one budget, so a
// locked rear axle spends the lot on not rotating and has nothing left to
// corner with. That is what the handbrake does, and it works no matter how
// flat this curve is.
function tyreCurve(slip, falloff) {
  if (slip <= 0) return 0;
  if (slip <= 1) return Math.sin((Math.PI / 2) * slip);
  return falloff + (1 - falloff) * Math.exp(-(slip - 1) * 1.1);
}

export class Vehicle {
  constructor(spec = CAR) {
    this.spec = spec;

    // --- state
    this.x = 0; this.z = 0; this.y = 0;
    this.yaw = 0;
    this.yawRate = 0;
    this.u = 0;              // body-frame forward velocity, m/s
    this.v = 0;              // body-frame lateral velocity, m/s (positive: left)
    this.omegaF = 0;         // front axle wheel speed, rad/s
    this.omegaR = 0;         // rear axle wheel speed, rad/s
    this.rpm = spec.idleRpm;
    this.gear = 1;           // index into spec.gears; 0 is reverse, 1 is first
    this.shiftT = 0;
    this.autoShift = true;
    this.wantReverse = false;
    this.reverseT = 0;

    // --- inputs, all 0..1 except steer which is -1..1
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = 0;
    this.steerInput = 0;     // -1 hard right, +1 hard left
    this.steer = 0;          // actual road-wheel angle, radians; positive is left

    // --- telemetry the rest of the game reads
    this.slipF = 0;          // 0..1+, how far past the grip peak each axle is
    this.slipR = 0;
    this.lateralG = 0;
    this.longG = 0;
    this.loadF = 0;
    this.loadR = 0;
    this.wheelSpin = 0;      // rear slip ratio, positive means lighting them up
    this.onTrack = true;
    this.surfaceGrip = 1;    // scaled down off the racing surface
    this.grade = 0;          // slope of the road, rise over run, uphill positive
    this.lastImpact = 0;

    const a = spec.wheelbase * (1 - spec.weightFront);
    const b = spec.wheelbase * spec.weightFront;
    this.a = a;              // CG to front axle
    this.b = b;              // CG to rear axle
    this.izz = spec.mass * (spec.wheelbase * spec.wheelbase + spec.track * spec.track) / 12 * 1.35;
  }

  get speed() { return Math.hypot(this.u, this.v); }

  // How much lock is available right now. A driver — human or otherwise — has
  // to know this: asking for "half steering" means something different at
  // thirty kilometres an hour and at two hundred.
  steerAuthority(speed = Math.abs(this.u)) {
    const f = this.spec.fullLockBelow;
    return speed <= f ? 1 : (f * f) / (speed * speed);
  }

  get maxSteerAngle() { return this.spec.steerLock * this.steerAuthority(); }
  get speedKmh() { return this.speed * KMH; }
  get forwardX() { return Math.sin(this.yaw); }
  get forwardZ() { return Math.cos(this.yaw); }
  get gearRatio() { return this.spec.gears[this.gear]; }
  // Always in a gear now, except during the change itself.
  get inGear() { return this.shiftT <= 0; }

  // Where the wheels sit in body coordinates — used by the models, the tyre
  // smoke and the collision box alike.
  wheelPositions() {
    const t = this.spec.track / 2;
    return [
      { x: -t, z: this.a, front: true },
      { x: t, z: this.a, front: true },
      { x: -t, z: -this.b, front: false },
      { x: t, z: -this.b, front: false },
    ];
  }

  // Put the car at a speed properly: body and wheels together.
  setSpeed(mps) {
    this.u = mps;
    this.omegaF = this.omegaR = mps / this.spec.wheelRadius;
  }

  reset(x, z, yaw) {
    this.x = x; this.z = z; this.yaw = yaw;
    this.u = this.v = this.yawRate = 0;
    this.omegaF = this.omegaR = 0;
    this.rpm = this.spec.idleRpm;
    this.gear = 1;
    this.shiftT = 0;
    this.throttle = this.brake = this.handbrake = this.steerInput = 0;
    this.steer = 0;
    // The road the car was last on is not the road it is being put on. Left
    // set, a car reset at the top of the hill keeps pulling against that grade
    // until something tells it otherwise — which made the same measurement
    // come out differently depending on where the previous race had ended.
    this.grade = 0;
    this.wantReverse = false;
    this.reverseT = 0;
    this.lastImpact = 0;
  }

  // ------------------------------------------------------------ gearbox

  shiftUp() {
    const top = this.spec.gears.length - 1;
    if (this.shiftT > 0 || this.gear >= top) return false;
    this.gear++;
    this.shiftT = this.spec.shiftTime;
    return true;
  }

  shiftDown() {
    // Down to first and no further. Reverse is not below first, it is chosen
    // by holding the brake at a standstill — with no neutral between the two,
    // letting the lever reach it would mean two pulls at a red light selects
    // reverse.
    if (this.shiftT > 0 || this.gear <= 1) return false;
    this.gear--;
    this.shiftT = this.spec.shiftTime;
    return true;
  }

  // What the engine would be turning at, in this gear, at this road speed.
  rpmInGear(gear) {
    const ratio = this.spec.gears[gear];
    if (!ratio) return this.spec.idleRpm;
    return Math.abs(this.omegaR * ratio * this.spec.finalDrive) * RPM_PER_RADS;
  }

  // The automatic: change up before the limiter, change down when the next gear
  // down would not over-rev, and never hunt while a shift is in progress.
  _autoShift(dt) {
    this.reverseT = Math.max(0, this.reverseT - dt);
    if (this.shiftT > 0) return;
    const top = this.spec.gears.length - 1;
    const wantsBack = this.wantReverse;
    if (this.gear === 0) {                                  // reverse
      // Stay in it long enough to actually get out of trouble.
      if (!this.wantReverse && this.reverseT <= 0 && this.u > -0.4) this.gear = 1;
      return;
    }
    if (wantsBack && Math.abs(this.u) < 0.6) { this.gear = 0; this.reverseT = 1.4; return; }
    const up = this.spec.redline * 0.965;
    if (this.gear < top && this.rpm > up && this.throttle > 0.1) {
      this.shiftUp();
      return;
    }
    if (this.gear > 1 && this.rpmInGear(this.gear - 1) < this.spec.redline * 0.86) {
      // Only drop down when we actually want the engine: coasting into a corner
      // on the brakes, or asking for more than this gear can give.
      if (this.rpm < this.spec.redline * 0.55 || this.brake > 0.25) this.shiftDown();
    }
  }

  // -------------------------------------------------------------- engine

  engineTorque() {
    const s = this.spec;
    if (this.rpm >= s.limiter) return -40;                  // on the limiter
    const wide = curve(s.torque, this.rpm);
    // Off throttle the engine drags: that is the engine braking you steer with.
    const drag = -(28 + this.rpm * 0.011);
    return drag + (wide - drag) * this.throttle;
  }

  // ------------------------------------------------------------- update

  update(dt, substeps = 4) {
    const h = dt / substeps;
    for (let i = 0; i < substeps; i++) this._step(h);
    this.x += 0;   // position is integrated inside _step
  }

  _step(dt) {
    const s = this.spec;
    const tyre = s.tyre;

    if (this.shiftT > 0) this.shiftT -= dt;
    if (this.autoShift) this._autoShift(dt);

    // --- steering: less lock the faster you go, and it takes time to apply
    const speed = Math.abs(this.u);
    // Full lock is for the pit lane. The faster you go the less of it you get,
    // falling away as the square of speed, which is roughly what keeps the
    // demanded cornering force constant across the range.
    // How much cornering the car has left. A tyre asked to brake has already
    // spent part of its grip, so what remains for turning is the other side of
    // the friction circle — and both the steering and the stability control
    // below have to work from this same number, or one of them will command a
    // corner the other cannot hold.
    const spent = clamp(this.brake, 0, 1) * 0.85;
    const latAvail = s.tyre.holdG * GRAVITY * this.surfaceGrip
      * Math.sqrt(Math.max(0.12, 1 - spent * spent));

    const authority = this.steerAuthority(speed);
    let target = clamp(this.steerInput, -1, 1) * s.steerLock * authority;

    // ...and it will not ask for a turn the tyres could not hold.
    //
    // The rolloff above knows about speed but nothing about what else the car
    // is doing. Brake hard into a corner while holding a steering key — which
    // on a keyboard is simply what turning is — and the speed collapses, the
    // available lock grows as the square of that, and within a second the
    // steering is commanding a two-g turn from a car that has one and a half.
    // The car slides, and it looks for all the world as though the brake did
    // it. So: whatever grip the braking is not using is what the steering is
    // allowed to spend, plus a margin to lean on.
    // The margin is not decoration. wheelbase·a/u² is the Ackermann angle,
    // which assumes the tyres run at no slip angle at all; a real tyre needs
    // several degrees of slip to make its force, so the angle that actually
    // holds the limit is meaningfully larger. Clamp at the textbook figure and
    // the car cannot reach its own cornering limit.
    const holdable = (s.wheelbase * latAvail) / Math.max(this.u * this.u, 1);
    target = clamp(target, -holdable * s.steerMargin, holdable * s.steerMargin);
    this.steer = approach(this.steer, target, dt * 6.5);

    // --- aerodynamics
    const vsq = this.u * this.u + this.v * this.v;
    const drag = 0.5 * AIR_DENSITY * s.dragArea * vsq;
    const lift = s.downforce * vsq;                          // downward, newtons

    // --- vertical loads, with the weight that transfers under acceleration
    const weight = s.mass * GRAVITY;
    const transfer = s.mass * this.longG * GRAVITY * s.cgHeight / s.wheelbase;
    this.loadF = Math.max(0, weight * s.weightFront - transfer + lift * 0.46);
    this.loadR = Math.max(0, weight * (1 - s.weightFront) + transfer + lift * 0.54);

    // Lateral transfer does not change the total load but it does cost grip,
    // because a tyre loaded twice as hard is not twice as grippy.
    const latTransfer = clamp(Math.abs(this.lateralG) * s.cgHeight / (s.track / 2), 0, 1.6);
    const latGripLoss = 1 - 0.14 * latTransfer * latTransfer;

    // --- slip angles. The denominator is floored so that standing still does
    // not produce an infinite slip angle and launch the car into orbit.
    const uRef = Math.max(Math.abs(this.u), 2.2);
    const alphaF = Math.atan2(this.v + this.a * this.yawRate, uRef) - this.steer * sign(this.u || 1);
    const alphaR = Math.atan2(this.v - this.b * this.yawRate, uRef);

    // --- slip ratios
    const kRef = Math.max(Math.abs(this.u), 1.6);
    const kappaF = (this.omegaF * s.wheelRadius - this.u) / kRef;
    const kappaR = (this.omegaR * s.wheelRadius - this.u) / kRef;

    const grip = this.surfaceGrip * latGripLoss;
    const F = this._axleForce(kappaF, alphaF, this.loadF, grip);
    const R = this._axleForce(kappaR, alphaR, this.loadR, grip * tyre.rearGrip);
    this.slipF = F.slip;
    this.slipR = R.slip;
    this.wheelSpin = kappaR;

    // The front tyre's forces are produced in the steered wheel's frame.
    const cs = Math.cos(this.steer), sn = Math.sin(this.steer);
    const fxF = F.fx * cs - F.fy * sn;
    const fyF = F.fx * sn + F.fy * cs;

    // --- sum of forces on the body
    const roll = s.rollingResistance * (this.loadF + this.loadR) * sign(this.u);
    // Gravity along the road. On a hill this is the whole story: a twenty-seven
    // metre climb at eight per cent takes about a tenth of a g out of the car
    // going up and hands it back coming down, which is why you change gear on
    // the way up a San Francisco street and not on the way down one.
    const slope = -s.mass * GRAVITY * Math.sin(Math.atan(this.grade));
    const fx = fxF + R.fx - drag * sign(this.u) - roll + slope;
    const fy = fyF + R.fy;
    let mz = this.a * fyF - this.b * R.fy;

    // --- stability control.
    //
    // Everything above is a real vehicle model, and a real vehicle model will
    // spin the car if you brake hard in a corner. That is true of real cars
    // too, which is exactly why real cars have this. It compares the yaw rate
    // the car is actually doing against the yaw rate the steering and the
    // speed are asking for, and leans on the difference — so an ordinary
    // corner, where the two agree, is untouched, and a departure is caught.
    //
    // The handbrake switches it off completely. That is the whole point of the
    // handbrake here: it is the one control allowed to break traction.
    if (this.handbrake < 0.1 && Math.abs(this.u) > 4) {
      // What the steering is asking for, capped at what the car can actually
      // hold. Capping it at the tyres' headline figure instead was worse than
      // not capping it at all: under braking the reference stayed high, and
      // the stability control drove the very rotation it exists to stop.
      const gripYaw = latAvail / Math.abs(this.u);
      const asked = clamp((this.u * this.steer) / s.wheelbase, -gripYaw, gripYaw);
      mz += (asked - this.yawRate) * s.stability * this.izz;
    }

    // --- integrate the body. The cross terms are what makes a rotating frame
    // a rotating frame: they are the reason a car in a corner keeps turning.
    //
    // The g figures are the specific force — what an accelerometer bolted to
    // the car would read, and what actually transfers weight. The derivative
    // of the body-frame velocity is a different number entirely: in a steady
    // corner it is nearly zero however hard the car is cornering.
    const accelX = fx / s.mass;
    const accelY = fy / s.mass;
    const ax = accelX + this.v * this.yawRate;
    const ay = accelY - this.u * this.yawRate;
    this.u += ax * dt;
    this.v += ay * dt;
    this.yawRate += (mz / this.izz) * dt;

    // Below walking pace the model has nothing meaningful to say; bleed the
    // rotation off so a stationary car does not shimmy.
    if (Math.abs(this.u) < 0.6) {
      this.yawRate *= Math.max(0, 1 - dt * 6);
      this.v *= Math.max(0, 1 - dt * 4);
    }

    this.longG = accelX / GRAVITY;
    this.lateralG = accelY / GRAVITY;

    this.yaw += this.yawRate * dt;
    this.x += (this.u * Math.sin(this.yaw) + this.v * Math.cos(this.yaw)) * dt;
    this.z += (this.u * Math.cos(this.yaw) - this.v * Math.sin(this.yaw)) * dt;

    // --- wheels
    this._spinAxle(dt, F, R);
  }

  // One axle's worth of tyre force, from its slip ratio and slip angle. The two
  // share a single friction budget: spend it all going forwards and there is
  // none left to turn with, which is the whole of car control in one line.
  _axleForce(kappa, alpha, load, grip) {
    const t = this.spec.tyre;
    if (load <= 1) return { fx: 0, fy: 0, slip: 0 };
    // Big tyres are less efficient than small ones, so grip falls off as the
    // load rises. Without this a car would corner harder the heavier it got.
    const mu = t.muPeak * grip * (1 - t.loadSensitivity * Math.max(0, load - 3200));
    const sN = kappa / t.peakSlipRatio;
    const aN = Math.tan(alpha) / t.peakSlipAngle;
    const slip = Math.hypot(sN, aN);
    if (slip < 1e-5) return { fx: 0, fy: 0, slip: 0 };
    const total = mu * load * tyreCurve(slip, t.falloff);
    return {
      fx: total * (sN / slip),
      fy: -total * (aN / slip),
      slip,
    };
  }

  _spinAxle(dt, F, R) {
    const s = this.spec;
    const r = s.wheelRadius;

    // Drive torque reaches the rear axle through the gearbox. During a shift
    // the clutch is out, so nothing does.
    let drive = 0;
    let inertiaR = s.wheelInertia * 2;
    const ratio = this.gearRatio;
    if (this.inGear && ratio) {
      const gearing = ratio * s.finalDrive;
      const wheelRpm = Math.abs(this.omegaR * gearing) * RPM_PER_RADS;
      if (wheelRpm >= s.idleRpm) {
        // Clutch home: the engine and the wheels are one rotating assembly, so
        // the engine's inertia has to be dragged along too. This is why a car
        // in first feels heavy to rev and a car in sixth does not.
        this.rpm += (wheelRpm - this.rpm) * Math.min(1, 45 * dt);
        drive = this.engineTorque() * gearing * s.driveline * s.rearDrive;
        inertiaR += s.engineInertia * gearing * gearing;
      } else {
        // Clutch slipping — pulling away, or crawling. The engine runs at its
        // own speed and the clutch passes as much torque as it can hold, which
        // is what lets you launch the car (and light the tyres up doing it).
        const free = s.idleRpm + (s.redline - s.idleRpm) * this.throttle;
        this.rpm += (free - this.rpm) * Math.min(1, 6 * dt);
        const capacity = s.clutchTorque * (0.22 + 0.78 * this.throttle);
        drive = Math.min(this.engineTorque(), capacity) * gearing * s.driveline * s.rearDrive;
      }
    } else {
      // Neutral or mid-shift: the engine revs to suit the throttle alone.
      const free = s.idleRpm + (s.redline - s.idleRpm) * this.throttle;
      const rate = this.throttle > 0.05 ? 7.0 : 3.4;
      this.rpm += (free - this.rpm) * Math.min(1, rate * dt);
    }
    this.rpm = clamp(this.rpm, s.stallRpm, s.limiter);

    // The floor the anti-lock system will not let the wheel drop below: the
    // speed at which the tyre is slipping just past its peak, where it is
    // stopping hardest. The handbrake is deliberately outside the system.
    const absFloor = Math.max(0, (Math.abs(this.u) * (1 - s.absSlip)) / r) * sign(this.u || 1);

    // Brake-force distribution. An axle is only given as much brake as the
    // load sitting on it can turn into stopping force, which matters most at
    // the back: braking throws the weight forward, so by the time you are
    // hard on the pedal the rear is carrying about a third of the car while a
    // fixed bias is still sending it nearly two fifths of the braking. That
    // over-braked rear axle spends its grip budget on slowing down and has
    // none left to steer with, and the back comes round — under the ordinary
    // brake pedal, which is not where a slide should ever come from.
    // ...and it respects the friction circle. A tyre being asked to corner has
    // already spent part of its grip, and braking it at its straight-line
    // limit at the same time is asking for more than it has. Whatever the
    // cornering is not using is what is left to brake with — which is why
    // standing on the pedal mid-corner now slows you less and spins you not at
    // all, instead of the other way round.
    const latUse = clamp(Math.abs(this.lateralG) / (s.tyre.muPeak * this.surfaceGrip), 0, 1);
    const longShare = Math.sqrt(Math.max(0, 1 - latUse * latUse));
    const ceiling = (load) => load * s.tyre.muPeak * this.surfaceGrip * r * 0.90 * longShare;
    const footF = Math.min(s.brakeTorque * s.brakeBias * this.brake, ceiling(this.loadF));
    const footR = Math.min(s.brakeTorque * (1 - s.brakeBias) * this.brake, ceiling(this.loadR));

    // The handbrake gets none of that: no distribution, no anti-lock, no
    // ceiling. It is the one control that is allowed to break traction.
    const hand = s.handbrakeTorque * this.handbrake;

    this.omegaF = this._wheelStep(this.omegaF, -F.fx * r, footF, s.wheelInertia * 2, dt, absFloor);
    this.omegaR = this._wheelStep(this.omegaR, drive - R.fx * r, footR, inertiaR, dt, absFloor);
    this.omegaR = this._wheelStep(this.omegaR, 0, hand, inertiaR, dt);        // no ABS here
  }

  // Integrate one axle, treating the brake as a torque that can hold the wheel
  // still but never drive it backwards — otherwise a locked wheel judders.
  _wheelStep(omega, torque, brakeTorque, inertia, dt, absFloor = null) {
    let next = omega + (torque / inertia) * dt;
    if (brakeTorque > 0) {
      const dw = (brakeTorque / inertia) * dt;
      if (Math.abs(next) <= dw) next = 0;
      else next -= dw * sign(next);
      // Anti-lock: release rather than let the wheel stop turning.
      if (absFloor !== null && absFloor !== 0) {
        if (absFloor > 0 && next < absFloor) next = absFloor;
        if (absFloor < 0 && next > absFloor) next = absFloor;
      }
    }
    return next;
  }

  // ---------------------------------------------------------- collisions

  // Shove the car by a world-space impulse applied at a point offset from the
  // centre of mass, which is what gives a nudge in the door its yaw.
  applyImpulse(ix, iz, offsetX = 0, offsetZ = 0) {
    const s = this.spec;
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    // World impulse into body axes.
    const bx = ix * c - iz * sn;
    const bz = ix * sn + iz * c;
    this.v += bx / s.mass;
    this.u += bz / s.mass;
    this.yawRate += (offsetZ * bx - offsetX * bz) * CONTACT.yawKick / this.izz;
    this.lastImpact = Math.hypot(bx, bz) / s.mass;
  }
}

export { tyreCurve };
