// The race: sixteen cars, three laps, and everything that has to be true about
// them — where they are on the circuit, whose nose is in front, who has crossed
// the line and when, and what happens when two of them try to occupy the same
// piece of road.

import * as THREE from 'three';
import { Vehicle } from './vehicle.js';
import { Driver } from './ai.js';
import { buildCar } from './carmodels.js';
import { RACE, CAR, CONTACT, LIVERIES, PLAYER_LIVERY, AI } from './defs.js';
import { clamp, lerp, rand, sign, angleDiff } from './utils.js';

export class Car {
  constructor(livery, isPlayer = false) {
    this.livery = livery;
    this.name = livery.name;
    this.number = livery.num;
    this.isPlayer = isPlayer;
    this.vehicle = new Vehicle(CAR);
    this.model = buildCar(livery);
    // Yaw last, so pitch and roll act in the car's own frame rather than the
    // world's. In the default XYZ order a yawed car pitches about the world's
    // x axis, which tips it sideways on a hill.
    this.model.rotation.order = 'YXZ';
    this.driver = null;

    this.lap = 0;
    this.lastS = 0;
    this.progress = 0;          // metres covered since the start of the race
    this.loc = null;
    this.lapStart = 0;
    this.lapTimes = [];
    this.bestLap = Infinity;
    this.lastLap = 0;
    this.finished = false;
    this.finishTime = Infinity;
    this.position = 1;
    this.contactT = 0;
    this.offTrackT = 0;
    this.spinF = 0;             // how far each axle has rotated, for the models
    this.spinR = 0;
  }

  get speedKmh() { return this.vehicle.speedKmh; }

  // Keep the mesh where the physics says the car is, and turn the wheels.
  // The pose as it stands before a physics step, kept so the frame can be
  // drawn between two steps instead of on top of whichever one happened to
  // land last. The wheels are wound on here too, at the rate the physics is
  // actually running rather than at an assumed sixty frames a second.
  capture(dt) {
    const v = this.vehicle;
    const p = this.prev || (this.prev = {});
    p.x = v.x; p.z = v.z; p.yaw = v.yaw;
    p.y = this.loc ? this.loc.y : 0;
    p.lateralG = v.lateralG; p.longG = v.longG; p.steer = v.steer;
    p.grade = this.loc ? this.loc.grade || 0 : 0;
    this.spinF += v.omegaF * dt;
    this.spinR += v.omegaR * dt;
  }

  // `alpha` is how far the frame being drawn falls between the previous
  // physics step and the latest one. Drawing the latest step outright is what
  // makes a 120 Hz simulation look jerky at 60 Hz: the frames do not divide
  // into the steps evenly, so the car advances two steps' worth one frame and
  // three the next. Rendering one step in the past and interpolating costs
  // eight milliseconds of lag and takes all of it out.
  syncModel(track, alpha = 1) {
    const v = this.vehicle;
    const p = this.prev;
    const a = p ? clamp(alpha, 0, 1) : 1;
    const y = lerp(p ? p.y : 0, this.loc ? this.loc.y : 0, a);
    this.model.position.set(
      lerp(p ? p.x : v.x, v.x, a), y, lerp(p ? p.z : v.z, v.z, a));
    this.model.rotation.y = lerp(p ? p.yaw : v.yaw, v.yaw, a);
    // Roll the body out of the corner and pitch it under load — small angles,
    // but without them the car looks like it is on rails. Both were the wrong
    // way round: a car leans away from a corner and dips its nose when it
    // brakes, not the reverse.
    //
    // And lie along the road, which on a hill this steep is the larger effect
    // by far: a car driven up an eight per cent grade sitting dead level looks
    // like it is hovering up the street.
    const grade = lerp(p ? p.grade : 0, this.loc ? this.loc.grade || 0 : 0, a);
    const slope = this.loc
      ? grade * Math.sign(v.forwardX * this.loc.sample.dirX
        + v.forwardZ * this.loc.sample.dirZ || 1)
      : 0;
    const latG = lerp(p ? p.lateralG : v.lateralG, v.lateralG, a);
    const lonG = lerp(p ? p.longG : v.longG, v.longG, a);
    this.model.rotation.z = clamp(latG * 0.030, -0.075, 0.075);
    this.model.rotation.x = clamp(-lonG * 0.022, -0.05, 0.05) - Math.atan(slope);
    // The two axles turn at their own rates, which is the point: under braking
    // the fronts slow and the rears do not, and with the handbrake on the rears
    // stop dead while the fronts keep rolling. You can see it happen.
    // Tail lights: on dim, hard red under braking or the lever. In a pack this
    // is the only warning you get that the car in front has stopped going.
    const tails = this.model.userData.tails;
    if (tails) tails.opacity = 0.30 + clamp(Math.max(v.brake, v.handbrake), 0, 1) * 0.70;

    const steer = lerp(p ? p.steer : v.steer, v.steer, a);
    for (const w of this.model.userData.wheels) {
      w.pivot.rotation.y = w.front ? steer : 0;
      w.mesh.rotation.x = -(w.front ? this.spinF : this.spinR);
    }
    void track;
  }
}

export class Race {
  constructor(game, track) {
    this.game = game;
    this.track = track;
    this.cars = [];
    this.state = 'grid';        // grid | countdown | racing | finished
    this.time = 0;
    this.lights = 0;            // 0..5 red lights, then out
    this.countdown = RACE.countdown;
    this.results = [];
    this.messages = [];

    // The player starts from the back — sixteenth — so there is a race to run.
    const liveries = [...LIVERIES];
    for (let i = 0; i < RACE.cars; i++) {
      const isPlayer = i === RACE.cars - 1;
      const car = new Car(isPlayer ? PLAYER_LIVERY : liveries[i % liveries.length], isPlayer);
      if (!isPlayer) {
        // The quick ones start at the front, so the order means something.
        const skill = lerp(AI.maxSkill, AI.minSkill, i / (RACE.cars - 1));
        car.driver = new Driver(car, track, skill);
        car.vehicle.autoShift = true;
      } else {
        car.vehicle.autoShift = false;   // you get the gearbox
      }
      this.cars.push(car);
      game.scene.add(car.model);
    }
    this.player = this.cars[RACE.cars - 1];
    this.gridUp();
  }

  gridUp() {
    this.cars.forEach((car, i) => {
      const slot = this.track.gridSlots[i];
      car.vehicle.reset(slot.x, slot.z, slot.yaw);
      car.lap = 0;
      car.lastS = slot.s;
      car.progress = slot.s - this.track.length;   // behind the line
      car.loc = this.track.locate(slot.x, slot.z);
      car.lapTimes = [];
      car.bestLap = Infinity;
      car.finished = false;
      car.finishTime = Infinity;
      car.position = i + 1;
      car.prev = null;                 // nothing to interpolate from yet
      car.syncModel(this.track);
    });
    this.state = 'countdown';
    this.time = 0;
    this.countdown = RACE.countdown;
    this.lights = 0;
    this.results = [];
  }

  get started() { return this.state === 'racing' || this.state === 'finished'; }

  // The player may now choose any car in the game, including one of the
  // field's. If they take a driver's car, that driver takes the one nobody was
  // using — fifteen bots share sixteen liveries, so there is always exactly
  // one spare. Two identical cars on the grid is worse than it sounds: the
  // timing screen and the mirrors both become guesswork.
  avoidDuplicate(taken) {
    const clash = this.cars.find((c) => !c.isPlayer && c.livery.name === taken.name);
    if (!clash) return;
    const used = new Set(this.cars.filter((c) => !c.isPlayer).map((c) => c.livery.name));
    const free = LIVERIES.find((l) => !used.has(l.name));
    if (!free) return;
    clash.livery = free;
    clash.number = free.num;
    this.game.scene.remove(clash.model);
    clash.model = buildCar(free);
    clash.model.rotation.order = 'YXZ';
    this.game.scene.add(clash.model);
    clash.syncModel(this.track);
  }

  // Called once a frame, not once a step: the frame is drawn between the last
  // two physics steps.
  sync(alpha) {
    for (const car of this.cars) car.syncModel(this.track, alpha);
  }

  update(dt) {
    if (this.state === 'countdown') {
      this.countdown -= dt;
      this.lights = clamp(Math.ceil(RACE.countdown - this.countdown), 0, 5);
      if (this.countdown <= 0) {
        this.state = 'racing';
        this.time = 0;
        for (const c of this.cars) c.lapStart = 0;
        this.game.onLightsOut();
      }
    } else if (this.state === 'racing' || this.state === 'finished') {
      this.time += dt;
    }

    const racing = this.state === 'racing' || this.state === 'finished';

    // --- drivers
    for (const car of this.cars) {
      if (car.driver) {
        if (racing) car.driver.drive(dt, this.cars);
        else {
          car.vehicle.throttle = 0;
          car.vehicle.brake = 1;
        }
      }
    }
    if (!racing) {
      // On the grid, everyone is held on the brakes — in first, not reverse.
      for (const car of this.cars) car.vehicle.wantReverse = false;
      this.player.vehicle.throttle = 0;
      this.player.vehicle.brake = 1;
      this.player.vehicle.steerInput = 0;
    }

    // --- physics
    for (const car of this.cars) {
      const v = car.vehicle;
      car.capture(dt);
      v.update(dt);
      const loc = this.track.locate(v.x, v.z, car.loc ? car.loc.index : -1);
      car.loc = loc;
      // Off the racing surface the grip goes away, which is the whole penalty
      // for running wide — no invisible walls, just a car that will not turn.
      v.grade = loc.grade;
      const over = Math.abs(loc.lateral) - loc.width / 2;
      if (over <= 0) { v.surfaceGrip = 1; v.onTrack = true; car.offTrackT = 0; }
      else if (over < 1.6) { v.surfaceGrip = 0.92; v.onTrack = true; }
      else {
        v.onTrack = false;
        car.offTrackT += dt;
        v.surfaceGrip = loc.sample.curvature > 0.0055 ? 0.80 : 0.52;
      }
    }

    this._barriers();
    this._knockThings(dt);

    for (const car of this.cars) {
      if (racing) this._progress(car, dt);
      car.contactT = Math.max(0, car.contactT - dt);
    }

    this._order();
    if (this.state === 'racing' && this.cars.every((c) => c.finished)) {
      this.state = 'finished';
    }
  }

  // --------------------------------------------------------- collisions

  // The barrier is a wall a fixed distance outside the white line. Hitting it
  // costs speed and points the car back down the road; it does not stop the
  // race, because a race where one mistake ends it is not a race.
  // Street furniture gives way.
  //
  // A lamp post that a car passes through is scenery; one that goes over is a
  // place. It costs the car almost nothing — a real one is a thin aluminium
  // tube on a shear base and it is supposed to fold — so this takes a little
  // speed and a little heading and leaves the rest alone. What it must not do
  // is stop the car: being halted dead by a signpost at a hundred and forty is
  // worse than driving through one.
  _knockThings(dt) {
    const list = this.track.breakables;
    if (!list || !list.length) return;
    for (const car of this.cars) {
      const v = car.vehicle;
      for (const o of list) {
        if (o.axis) continue;
        const dx = v.x - o.x, dz = v.z - o.z;
        const reach = o.r + 1.9;
        if (dx * dx + dz * dz > reach * reach) continue;
        const c = Math.cos(v.yaw), s2 = Math.sin(v.yaw);
        if (!this.track.knock(o, v.u * s2 + v.v * c, v.u * c - v.v * s2)) continue;
        const hit = Math.min(1, Math.abs(v.speed) / 30);
        v.u *= 1 - 0.10 * hit;
        v.yawRate += (Math.random() - 0.5) * 1.1 * hit;
        car.contactT = 0.35;
        if (car.isPlayer) this.game.onKnock(o, hit);
      }
    }
    void dt;
  }

  _barriers() {
    // Where a car is stopped. Not the barrier offset any more — there are no
    // barriers — but the frontage the buildings stand on, so that being
    // stopped happens where there is a building to be stopped by.
    const limit = this.track.wall;
    for (const car of this.cars) {
      const v = car.vehicle;
      const loc = car.loc;

      const edge = loc.width / 2 + limit - 1.0;
      const over = Math.abs(loc.lateral) - edge;
      if (over <= 0) continue;
      const s = sign(loc.lateral);
      const nx = -loc.sample.nx * s, nz = -loc.sample.nz * s;   // inward
      // Put it back on the right side of the armco.
      v.x += nx * over;
      v.z += nz * over;
      // Kill the velocity into the wall and scrub some of the rest off.
      const c = Math.cos(v.yaw), sn = Math.sin(v.yaw);
      const worldVx = v.u * sn + v.v * c;
      const worldVz = v.u * c - v.v * sn;
      const into = worldVx * nx + worldVz * nz;
      if (into < 0) {
        // The inward component must be cancelled in full — anything less and
        // the car keeps pressing into the armco and grinds along it. Only the
        // bounce back, and what the hit costs you, are scaled down.
        const bounce = -into * (1 + CONTACT.restitution * CONTACT.strength);
        v.applyImpulse(nx * bounce * v.spec.mass, nz * bounce * v.spec.mass, 0, 0);
        v.u *= 1 - 0.14 * CONTACT.strength;
        v.v *= 1 - 0.50 * CONTACT.strength;
        v.yawRate *= 1 - 0.45 * CONTACT.strength;
        car.contactT = 0.35;
        this.game.onImpact(car, Math.abs(into));
      }
    }
  }

  // Cars pass through one another. There is no car-to-car contact resolution
  // at all — not a disabled branch, not a zeroed coefficient — so two cars
  // occupying the same piece of road simply do. The barriers above are the
  // only thing that will stop you.
  //
  // The drivers still behave as though contact mattered: they slow behind a
  // car they are catching and pick a side to go round it, because that is what
  // makes traffic look like racing rather than like ghosts on a hot lap.

  // ------------------------------------------------------ laps and order

  _progress(car, dt) {
    const t = this.track;
    const s = car.loc.s;
    const prev = car.lastS;
    // Crossing the line: the distance jumps from nearly a lap to nearly zero.
    if (prev > t.length * 0.75 && s < t.length * 0.25) {
      car.lap++;
      const lapTime = this.time - car.lapStart;
      // The first crossing is the start of lap one, not the end of one: the
      // grid is behind the line, so that run is a few seconds long and timing
      // it would put a three-second lap on the board.
      if (car.lap > 1) {
        car.lastLap = lapTime;
        car.lapTimes.push(lapTime);
        if (lapTime < car.bestLap) car.bestLap = lapTime;
      }
      car.lapStart = this.time;
      this.game.onLap(car, car.lap, lapTime);
      if (car.lap > RACE.laps && !car.finished) {
        car.finished = true;
        car.finishTime = this.time;
        this.game.onFinish(car);
      }
    } else if (prev < t.length * 0.25 && s > t.length * 0.75) {
      car.lap--;                                                // went back over it
    }
    car.lastS = s;
    car.progress = car.lap * t.length + s;
    void dt;
  }

  _order() {
    const sorted = [...this.cars].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    sorted.forEach((c, i) => { c.position = i + 1; });
    this.order = sorted;
    return sorted;
  }

  // The gap, in seconds, from a car to the one classified ahead of it. Worked
  // out from the distance between them and the speed of the car behind, which
  // is what a timing screen does.
  gapAhead(car) {
    // The HUD can ask before the first physics step has produced an order.
    if (!this.order) return 0;
    const idx = this.order.indexOf(car);
    if (idx <= 0) return 0;
    const ahead = this.order[idx - 1];
    const d = ahead.progress - car.progress;
    const v = Math.max(car.vehicle.u, 12);
    return d / v;
  }

  get leader() { return (this.order && this.order[0]) || this.cars[0]; }
}

void THREE;
void rand;
void angleDiff;
