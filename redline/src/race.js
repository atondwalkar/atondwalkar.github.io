// The race: sixteen cars, three laps, and everything that has to be true about
// them — where they are on the circuit, whose nose is in front, who has crossed
// the line and when, and what happens when two of them try to occupy the same
// piece of road.

import * as THREE from 'three';
import { Vehicle } from './vehicle.js';
import { Driver, Cruiser } from './ai.js';
import { DriftScore } from './score.js';
import { buildCar } from './carmodels.js';
import { RACE, CAR, CONTACT, HULL, LIVERIES, PLAYER_LIVERY, POLICE, AI } from './defs.js';
import { clamp, lerp, rand, sign, angleDiff, dist2D } from './utils.js';

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

// Exactly the sixteen-car field the game has always had: the quick ones at the
// front so the order means something, the player last so there is a race to
// run. Written out rather than derived so that changing the campaign's field
// cannot change this one.

// How close to the end of the road traffic gets before it leaves it, how far
// behind the player it is taken away, and the window ahead that is kept full.
//
// The near edge is short on purpose: traffic has to be there from the first
// corner, not two hundred and sixty metres up the road where the old layout
// started it. A few at a time, so a frame never builds twenty cars at once.
const TRAFFIC_EXIT = 90;
const TRAFFIC_DROP = 220;
const TRAFFIC_NEAR = 60;
const TRAFFIC_FAR = 1500;
const TRAFFIC_PER_TICK = 3;

// How far behind the player a leashed unit comes back. Always further back
// than the threshold that triggered it, or the leash fires again immediately.
const LEASH_BACK = 130;

// How wide a contact bucket is, and how many cars there have to be before
// bucketing is worth the map. Twenty metres is comfortably wider than a car,
// and below a couple of dozen cars the straight double loop is cheaper than
// building the map.
const CONTACT_BIN = 20;
const CONTACT_BUCKET_FROM = 24;

// How far away traffic has to be before it is stepped less often, and how much
// less often. Seven hundred metres is past the fog on every layout that has
// traffic on it.
const FAR_TRAFFIC = 700;
const FAR_EVERY = 3;

// How far up the road traffic is still drawn. Past the fog there is nothing
// to see, and a car nobody can see is a draw call nobody needs.
const DRAW_RANGE = 620;

// How fast everybody is already going when a pursuit stage opens.
const ROLLING_START = 42;            // 150 km/h

// How far back the first pursuer starts. Alongside is not a chase: the stage
// is about getting away, and a car that begins level with you has already
// caught you.
const PURSUIT_GAP = 55;

export function defaultField() {
  const cars = [];
  for (let i = 0; i < RACE.cars; i++) {
    const isPlayer = i === RACE.cars - 1;
    cars.push({
      livery: isPlayer ? PLAYER_LIVERY : LIVERIES[i % LIVERIES.length],
      isPlayer,
      skill: lerp(AI.maxSkill, AI.minSkill, i / (RACE.cars - 1)),
    });
  }
  return { cars, laps: RACE.laps, contact: false };
}

// Give back what a car model holds. Removing without disposing is nothing once
// a session and not nothing once per stage retry.
function disposeCar(scene, model) {
  if (!model) return;
  scene.remove(model);
  model.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
  });
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

    this.buildField(defaultField());
  }

  // Put a field on the grid.
  //
  // `plan.cars` is a list of specs, front of the grid first. Extracted from
  // the constructor so a campaign stage can name its own field — a duel is two
  // cars, a chase is one plus the police — without any of it being derived
  // from a grid index the way the sixteen-car ramp is.
  buildField(plan) {
    for (const car of this.cars) disposeCar(this.game.scene, car.model);
    this.cars = [];
    this.laps = plan.laps ?? RACE.laps;
    this.contact = !!plan.contact;
    // A point-to-point stage: metres along the road from the start line, to be
    // reached rather than a number of laps to be completed. Null for a race.
    this.route = plan.route ?? null;
    // Seconds to do it in. Null for a race, which ends when it ends.
    this.limit = plan.limit ?? null;
    // How the cars line up. A grid is staggered two abreast; a pursuit is the
    // quarry alone at the front with everyone else strung out behind it.
    this.formation = plan.formation || 'grid';
    // Metres. Null for a stage where losing the police is allowed to mean
    // losing them.
    this.leash = plan.leash ?? null;
    // Where and how often fresh units cut in ahead of the player, and how many
    // there may be at once. Null for a stage with a fixed field.
    this.intercept = plan.intercept ?? null;
    this.roadblocks = plan.roadblocks ?? null;
    // Losing the police as the WIN condition: no pursuer within `clear` for
    // `hold` seconds. Null everywhere the stage has a finish line instead.
    this.escape = plan.escape ?? null;
    this.coolT = 0;
    this.nearestHeat = Infinity;
    // How much the player's car can take before the stage is lost. Null for
    // stages where a wall is a wall and nothing more.
    this.damageMax = plan.damageMax ?? null;
    this.damage = 0;
    // Drift scoring: a points target inside the clock. Null elsewhere, and the
    // scorer only exists where the stage asks for it — a running total nobody
    // can see is work nobody asked for.
    this.driftTarget = plan.driftTarget ?? null;
    this.drift = this.driftTarget ? new DriftScore() : null;
    // The traffic specs are kept as a POOL, not just as a one-off layout: the
    // race tops the road up ahead of the player from them as it goes.
    this.trafficSpecs = (plan.cars || []).filter((c) => c.traffic);
    this.trafficEvery = plan.trafficEvery || 0;
    // Checkpoints on a route: fractions of it that, crossed, add seconds to
    // the clock. The classic sprint shape — the clock is always about to run
    // out and never quite does, as long as you keep making the line.
    this.checkpoints = plan.checkpoints
      ? plan.checkpoints.at.map((f) => ({ s: f * this.track.length, bonus: plan.checkpoints.bonus, taken: false }))
      : null;
    // The stage is over the moment the result is decided, rather than when the
    // last car is home. In a duel that is the first car across the line —
    // whoever it is, the other one has lost and there is nothing left to watch.
    this.endOnFirst = !!plan.endOnFirst;

    for (const spec of plan.cars) {
      const car = new Car(spec.livery, !!spec.isPlayer);
      if (spec.name) car.name = spec.name;
      // A pursuer is not in the race. It has no finish to reach and no
      // position worth holding: its entire job is to arrive where the player
      // is, and letting it "win" a stage by driving past the ramp first is a
      // result nobody asked for.
      car.pursuer = !!spec.pursuer;
      // Traffic is scenery that moves and can be hit. It is not in the race,
      // has no position, never finishes, and nothing waits for it.
      car.traffic = !!spec.traffic;
      if (spec.isPlayer) {
        car.vehicle.autoShift = false;         // you get the gearbox
      } else if (spec.traffic) {
        car.driver = new Cruiser(car, this.track, spec.lane || 0, spec.speed || 14);
        car.vehicle.autoShift = true;
      } else {
        car.driver = new Driver(car, this.track, spec.skill ?? 0.9, spec.opts || {});
        car.vehicle.autoShift = true;
      }
      this.cars.push(car);
      this.game.scene.add(car.model);
    }
    this.player = this.cars.find((c) => c.isPlayer) || this.cars[0];
    // Whoever is chasing is chasing the player. Set here rather than in the
    // Driver, which has no idea a player exists and no business deciding.
    for (const car of this.cars) {
      if (car.driver && car.driver.opts.chase > 0) car.driver.quarry = this.player;
    }
    this.gridUp();
  }

  // Move the field onto a different circuit.
  //
  // Every driver carries a `hint` — the sample index it found the car on last
  // frame, so `locate` can search around it instead of the whole hash. Those
  // indices mean nothing on a new track, and a stale one sends `locate` off to
  // a piece of road that is not there any more, so they are cleared here
  // rather than left to be noticed a lap later.
  setTrack(track) {
    this.track = track;
    for (const car of this.cars) {
      if (car.driver) { car.driver.track = track; car.driver.hint = -1; }
      car.loc = null;
      car.prev = null;
    }
    this.gridUp();
  }

  // Where each car starts. A staggered grid, or a pursuit — the quarry on its
  // own and everyone else in a line a long way back, so there is a chase to
  // begin with rather than a scrum.
  _slots() {
    const t = this.track;
    this.trafficCount = this.cars.filter((c) => c.traffic).length;
    // Traffic is NEVER on the grid, whatever the formation.
    //
    // This used to be checked only on the pursuit path, and the grid path
    // simply indexed `gridSlots` by car number — sixteen slots, indexed by an
    // eighteen-car field the moment a race stage carried traffic, which is an
    // undefined slot and a stage that dies on its first frame. The composable
    // field made rivals-plus-traffic expressible; this is the other half of
    // expressing it.
    let nth = 0;
    let gridN = 0;
    // On a route the run-up in front of the line is short, so a pursuer put
    // fifty-five metres behind the start would be off the end of the road.
    // Clamped to what there is, which is why the run-up is as long as it is.
    const base = t.gridSlots[0].s;
    return this.cars.map((car, i) => {
      void i;
      if (!car.traffic && this.formation !== 'pursuit') return t.gridSlots[gridN++];
      if (car.traffic) {
        // Spread over the WHOLE road from close to the line, not from two
        // hundred and sixty metres up it: the first thing the stage does is
        // put you on a bridge, and a bridge with nothing on it for the first
        // quarter mile is a bridge with nothing on it.
        //
        // The layout only has to be right for the first few seconds; from
        // there on `_topUpTraffic` keeps the density up ahead of the car.
        const k = nth++;
        const from = base + TRAFFIC_NEAR;
        const room = Math.max(200, t.length - 60 - from);
        const step = room / Math.max(1, this.trafficCount);
        const s = from + (k + 0.5) * step;
        const p = t.atDistance(s);
        const lane = car.driver ? car.driver.lane : 0;
        return {
          x: p.x + p.nx * lane, z: p.z + p.nz * lane, y: p.y,
          yaw: Math.atan2(p.dirX, p.dirZ), s,
        };
      }
      // The player at the front; the units at 55 m and then 13 m apart —
      // close enough together that the flankers reach their doors early.
      //
      // Counted by PURSUIT CAR, not by field index. The field orders traffic
      // between the player and the police, so on the bridge the first unit's
      // raw index was 365 and `back` was four and a half kilometres — clamped
      // to the start of the road, which happened to land them close enough
      // that nobody noticed the arithmetic was nonsense.
      const k2 = gridN++;
      const back = k2 === 0 ? 0 : PURSUIT_GAP + (k2 - 1) * 13;
      const s = t.closed ? base - back : Math.max(4, base - back);
      const p = t.atDistance(s);
      const off = i === 0 ? 0 : ((i % 2) ? 2.6 : -2.6);
      return { x: p.x + p.nx * off, z: p.z + p.nz * off, y: p.y, yaw: Math.atan2(p.dirX, p.dirZ), s };
    });
  }

  gridUp() {
    const slots = this._slots();
    this.cars.forEach((car, i) => {
      const slot = slots[i];
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
      // Traffic is already moving when you arrive. A bridge full of stationary
      // cars that lurch into motion on the green light is a starting grid.
      if (car.traffic && car.driver) car.vehicle.setSpeed(car.driver.speed);
      car.syncModel(this.track);
    });
    // A chase does not start from a standstill.
    //
    // Five red lights and a standing start is how a race begins; a stage that
    // opens with police already behind you cannot have everybody sitting still
    // waiting for a gantry that is not there. A pursuit starts ROLLING: the
    // clock is already going, everyone is already at speed, and the game slows
    // time for a second and a half so the first corner is not a surprise.
    if (this.formation === 'pursuit') {
      this.state = 'racing';
      this.time = 0;
      this.countdown = 0;
      this.lights = 0;
      this.results = [];
      for (const car of this.cars) {
        if (car.traffic) continue;
        car.vehicle.setSpeed(ROLLING_START);
        car.lapStart = 0;
      }
      this.game.onLightsOut();
      return;
    }
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
    // Traffic beyond the fog is not drawn.
    //
    // Three hundred and sixty cars is three hundred and sixty models, each a
    // shell, four wheels, two plates and a shadow — a couple of thousand draw
    // calls for a road whose far end is invisible at three hundred metres. The
    // cars are still simulated; they are simply not submitted.
    //
    // Frustum culling does not do this for you here: a car behind you is
    // culled, but the two hundred ahead of you down a straight bridge are all
    // in frame and all beyond seeing.
    const p = this.player;
    const here = p && p.loc ? p.loc.s : 0;
    for (const car of this.cars) {
      car.syncModel(this.track, alpha);
      if (car.traffic && car.model && car.loc) {
        car.model.visible = Math.abs(this.track.gap(car.loc.s, here)) < DRAW_RANGE;
      }
    }
    this._flash();
  }

  // The light bars. Left, right, left, right — five a second, which is about
  // what a real one does and fast enough to read as urgent rather than as a
  // hazard light. Driven off `time` rather than an accumulator so every car in
  // a pursuit flashes together, the way a convoy of them does.
  _flash() {
    const on = Math.floor(this.time * 5) % 2;
    for (const car of this.cars) {
      const b = car.model && car.model.userData.beacons;
      if (!b) continue;
      b[0].visible = on === 0;
      b[1].visible = on === 1;
    }
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

    // Traffic a long way off is stepped less often.
    //
    // Three hundred and sixty cars on an eleven-kilometre bridge is three
    // hundred and sixty drivers and three hundred and sixty tyre models a
    // hundred and twenty times a second, and all but a dozen of them are
    // beyond the fog holding a lane at fifty. They are stepped every third
    // frame at three times the interval instead, which is the same motion at a
    // third of the cost and is only ever applied to cars nobody can see.
    //
    // The step is still fixed — a third of 120 Hz is 40 Hz, not a variable
    // rate — so this is not the thing a variable timestep would be.
    this._slice = ((this._slice || 0) + 1) % FAR_EVERY;
    const here = this.player && this.player.loc ? this.player.loc.s : 0;
    const skip = (car, i) => car.traffic && car.loc
      && Math.abs(this.track.gap(car.loc.s, here)) > FAR_TRAFFIC
      && (i % FAR_EVERY) !== this._slice;

    // --- drivers
    for (let ci = 0; ci < this.cars.length; ci++) {
      const car = this.cars[ci];
      if (skip(car, ci) || car.roadblock) continue;
      const step = car.traffic && car.loc
        && Math.abs(this.track.gap(car.loc.s, here)) > FAR_TRAFFIC ? dt * FAR_EVERY : dt;
      car._step = step;
      if (car.driver) {
        if (racing) car.driver.drive(step, this.cars);
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
    for (let ci = 0; ci < this.cars.length; ci++) {
      const car = this.cars[ci];
      if (skip(car, ci)) continue;
      const step = car._step || dt;
      const v = car.vehicle;
      car.capture(step);
      v.update(step);
      const loc = this.track.locate(v.x, v.z, car.loc ? car.loc.index : -1);
      car.loc = loc;
      // Off the racing surface the grip goes away, which is the whole penalty
      // for running wide — no invisible walls, just a car that will not turn.
      v.grade = loc.grade;
      const over = Math.abs(loc.lateral) - loc.width / 2;
      // Rain is a multiplier on whatever the surface gives, applied here at
      // the ONE place grip is decided — a wet road and a wet verge are both
      // wetter than their dry selves, and a rain that only affected one of
      // them would make running wide the fast line.
      const wet = this.track.layout.wet || 1;
      if (over <= 0) { v.surfaceGrip = wet; v.onTrack = true; car.offTrackT = 0; }
      else if (over < 1.6) { v.surfaceGrip = 0.92 * wet; v.onTrack = true; }
      else {
        v.onTrack = false;
        car.offTrackT += dt;
        v.surfaceGrip = (loc.sample.curvature > 0.0055 ? 0.80 : 0.52) * wet;
      }
    }

    // Contact first, then the wall. Contact can push a car past the building
    // line, and the barrier pass has to be the thing that finally clamps it —
    // run them the other way round and a car can be left inside a building.
    this._carContact();
    for (const car of this.cars) {
      if (car.contactT > 0.3) car.loc = this.track.locate(car.vehicle.x, car.vehicle.z, car.loc ? car.loc.index : -1);
    }
    this._barriers();
    this._knockThings(dt);

    for (const car of this.cars) {
      if (racing) this._progress(car, dt);
      car.contactT = Math.max(0, car.contactT - dt);
    }

    if (racing) {
      this._despawn();
      this._topUpTraffic();
      this._leash();
      this._intercept(dt);
      this._roadblocks(dt);
    }

    this._order();
    // The result is decided. In a duel the first car across the line settles
    // it both ways round: if it is the player they have won, and if it is the
    // rival there is nothing to be gained from driving the rest of the lap.
    if (this.state === 'racing' && this.endOnFirst && this.cars.some((c) => c.finished)) {
      this.state = 'finished';
      this.results = this.order.slice();
      return;
    }
    // Drift: score accrues while the player is sideways, and the stage is won
    // the moment the target is met. The clock running out first is the loss.
    if (this.state === 'racing' && this.drift && this.player) {
      const p3 = this.player;
      this.drift.step(dt, p3.vehicle, p3.vehicle.onTrack !== false);
      if (p3.contactT > 0 && this.drift.chain > 0) this.drift.drop();
      if (this.drift.total >= this.driftTarget && !p3.finished) {
        this.drift.bank();
        p3.finished = true;
        p3.finishTime = this.time;
        this.game.onFinish(p3);
        this.state = 'finished';
        this.results = this.order.slice();
        return;
      }
    }

    // Escape: the stage with no finish line. The player wins by having no
    // pursuer within `clear` metres for `hold` seconds together — losing them,
    // held. Any unit closing inside the radius puts the meter back to zero,
    // which is what makes the leash and the interceptors the opposition here:
    // the road never ends, only the heat does.
    if (this.state === 'racing' && this.escape && this.player) {
      const p2 = this.player;
      let nearest = Infinity;
      for (const c of this.cars) {
        // Roadblocks do not count as heat. They are parked — they cannot
        // chase, and they spawn AHEAD every few seconds, so counting them held
        // `nearest` inside the clear radius for the whole stage and the meter
        // never moved: the win condition was unreachable by construction.
        // What a roadblock threatens is your bodywork, not your escape.
        if (!c.pursuer || c.roadblock || !c.loc || !p2.loc) continue;
        nearest = Math.min(nearest, dist2D(p2.vehicle.x, p2.vehicle.z, c.vehicle.x, c.vehicle.z));
      }
      this.coolT = nearest > this.escape.clear ? (this.coolT || 0) + dt : 0;
      this.nearestHeat = nearest;
      if (this.coolT >= this.escape.hold && !p2.finished) {
        p2.finished = true;
        p2.finishTime = this.time;
        this.game.onFinish(p2);
        this.state = 'finished';
        this.results = this.order.slice();
        return;
      }
    }

    // A run ends when the player reaches the ramp. The units chasing them
    // never finish anything, so waiting for every car would wait forever.
    if (this.state === 'racing' && this.route !== null && this.player.finished) {
      this.state = 'finished';
      this.results = this.order.slice();
      return;
    }
    // Out of time. Everyone still running is out of it, not just the player:
    // a route with three police cars on it has to stop as one thing, or the
    // scene behind it plays over cars still driving.
    if (this.state === 'racing' && this.limit !== null && this.time >= this.limit) {
      this.state = 'finished';
      this.results = this.order.slice();
      return;
    }
    if (this.state === 'racing' && this.cars.every((c) => c.pursuer || c.traffic || c.finished)) {
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

  _barriers() { this.constrain(this.cars); }

  // Hold a list of cars inside the building line.
  //
  // Exposed rather than baked into the update loop because a cutscene drives
  // cars of its own — the police arriving are not in the race — and a police
  // car drifting a junction with nothing to stop it ends up parked on a
  // pavement in the middle of the shot.
  constrain(cars) {
    // Where a car is stopped. Not the barrier offset any more — there are no
    // barriers — but the frontage the buildings stand on, so that being
    // stopped happens where there is a building to be stopped by.
    const limit = this.track.wall;
    for (const car of cars) {
      const v = car.vehicle;
      const loc = car.loc;
      if (!loc) continue;

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

  // Car-to-car contact — off by default, and off for the sixteen-car race.
  //
  // Cars used to pass through one another everywhere, deliberately: being
  // punted out of a sixteen-car pack is miserable, so the resolver was taken
  // out entirely. That reasoning does not apply to a one-on-one duel or to a
  // police car trying to put you into a wall, so contact is per-race rather
  // than global, and `race` mode never switches it on.
  // Every pair of cars that could possibly be touching, and no others.
  //
  // This was every pair full stop — fine for sixteen cars, which is a hundred
  // and twenty tests, and not fine for three hundred and sixty-eight, which is
  // sixty-seven thousand of them, every step, a hundred and twenty times a
  // second. The broad-phase distance check inside `_resolvePair` does not help:
  // the cost is in reaching it.
  //
  // Cars are on a road, so their positions along it are a single number, and
  // two cars twenty metres apart along it cannot be touching whatever else is
  // true. Bucketed by that number, each car is compared with the handful in
  // its own bucket and the one ahead — which is a few hundred tests rather
  // than sixty-seven thousand, and is exactly the same answer.
  _carContact() {
    if (!this.contact) return;
    const cars = this.cars;
    if (cars.length < CONTACT_BUCKET_FROM) {
      for (let i = 0; i < cars.length; i++) {
        for (let j = i + 1; j < cars.length; j++) this._resolvePair(cars[i], cars[j]);
      }
      return;
    }
    const bins = new Map();
    for (const c of cars) {
      if (!c.loc) continue;
      const k = Math.floor(c.loc.s / CONTACT_BIN);
      let list = bins.get(k);
      if (!list) { list = []; bins.set(k, list); }
      list.push(c);
    }
    for (const [k, list] of bins) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) this._resolvePair(list[i], list[j]);
        // ...and the next bin along, so a pair straddling a boundary is not
        // missed. Only the next one: the bin is wider than any car is long.
        const next = bins.get(k + 1);
        if (next) for (const o of next) this._resolvePair(list[i], o);
      }
    }
  }

  // The deepest contact between two cars, resolved once.
  //
  // Once, not once per disc pair: resolving all four in a step double-counts a
  // square-on hit and pops the cars apart. One contact at 120 Hz is plenty —
  // it is exactly how the barrier resolver behaves, and that is stable.
  _resolvePair(A, B) {
    const a = A.vehicle, b = B.vehicle;
    const dx0 = b.x - a.x, dz0 = b.z - a.z;
    const reach = HULL.radius * 2 + Math.abs(HULL.fore) + Math.abs(HULL.aft);
    if (dx0 * dx0 + dz0 * dz0 > reach * reach) return;      // broad phase

    const discs = (v) => {
      const c = Math.cos(v.yaw), s2 = Math.sin(v.yaw);
      return [HULL.fore, HULL.aft].map((f) => ({
        x: v.x + s2 * f, z: v.z + c * f, f,
      }));
    };
    const da = discs(a), db = discs(b);

    let best = null;
    for (const pa of da) {
      for (const pb of db) {
        const dx = pb.x - pa.x, dz = pb.z - pa.z;
        const d = Math.hypot(dx, dz);
        const overlap = HULL.radius * 2 - d;
        if (overlap <= HULL.slop) continue;
        if (!best || overlap > best.overlap) {
          best = { overlap, nx: d > 1e-4 ? dx / d : 1, nz: d > 1e-4 ? dz / d : 0, pa, pb };
        }
      }
    }
    if (!best) return;

    const { nx, nz, overlap } = best;
    // Positional correction, split evenly. Correcting the whole overlap every
    // step is what makes resting cars jitter.
    const push = (overlap - HULL.slop) * HULL.correction * 0.5;
    a.x -= nx * push; a.z -= nz * push;
    b.x += nx * push; b.z += nz * push;

    // Two cars spawned on top of each other is not a collision. Separate them
    // and leave it there — the uncapped impulse would launch them.
    if (overlap > HULL.radius) return;

    const world = (v) => {
      const c = Math.cos(v.yaw), s2 = Math.sin(v.yaw);
      return { vx: v.u * s2 + v.v * c, vz: v.u * c - v.v * s2 };
    };
    const va = world(a), vb = world(b);
    const rvx = vb.vx - va.vx, rvz = vb.vz - va.vz;
    const closing = rvx * nx + rvz * nz;
    if (closing >= 0) return;                               // already parting

    const mA = a.spec.mass, mB = b.spec.mass;
    let jn = -(1 + HULL.restitution) * closing / (1 / mA + 1 / mB);
    jn = Math.min(jn, HULL.maxDeltaV * (mA * mB) / (mA + mB));

    // Tangential scrub: what turns a side-on rub into a scrub and a twitch
    // rather than a frictionless slide past.
    const tx = -nz, tz = nx;
    const along = rvx * tx + rvz * tz;
    let jt = -along * HULL.friction / (1 / mA + 1 / mB);
    jt = clamp(jt, -Math.abs(jn) * HULL.friction, Math.abs(jn) * HULL.friction);

    const ix = nx * jn + tx * jt, iz = nz * jn + tz * jt;
    // Each car's contact point in its OWN body frame, which is what
    // applyImpulse reads, so an off-centre hit yaws the right way.
    a.applyImpulse(-ix, -iz, 0, best.pa.f, HULL.yawScale);
    b.applyImpulse(ix, iz, 0, best.pb.f, HULL.yawScale);

    A.contactT = 0.35;
    B.contactT = 0.35;
    const force = Math.abs(jn) / Math.min(mA, mB);
    if (A.isPlayer || B.isPlayer) this.game.onImpact(A.isPlayer ? A : B, force);
  }

  // ------------------------------------------------------ laps and order

  _progress(car, dt) {
    const t = this.track;
    const s = car.loc.s;
    const prev = car.lastS;
    // Crossing the line: the distance jumps from nearly a lap to nearly zero.
    // A route has no line to cross and no laps to count.
    if (t.closed && prev > t.length * 0.75 && s < t.length * 0.25) {
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
      if (car.lap > this.laps && !car.finished) {
        car.finished = true;
        car.finishTime = this.time;
        this.game.onFinish(car);
      }
    } else if (t.closed && prev < t.length * 0.25 && s > t.length * 0.75) {
      car.lap--;                                                // went back over it
    }
    car.lastS = s;
    car.progress = car.lap * t.length + s;
    // A route ends where it ends, which is usually nowhere near the line.
    // Checked after `progress` is written, not inside the crossing branch
    // above: the finish is a point on the road, and the only frame it is
    // guaranteed to be noticed on is the one where the distance passes it.
    //
    // Against `length + route`, because `progress` is not distance travelled —
    // it is `lap * length + s`, and the grid sits BEHIND the line, so a car
    // that has not crossed yet reads a whole lap lower than one that just
    // has. That offset cancels for the ordering this number was written for
    // and does not cancel here.
    // Checkpoints, before the finish: crossing one buys time.
    if (this.checkpoints && car.isPlayer) {
      const along = this.distanceAlong(car);
      for (const cp of this.checkpoints) {
        if (cp.taken || along < cp.s) continue;
        cp.taken = true;
        this.limit += cp.bonus;
        this.game.onCheckpoint(cp.bonus);
      }
    }
    if (this.route !== null && !car.pursuer && !car.traffic
        && this.distanceAlong(car) >= this.route && !car.finished) {
      car.finished = true;
      car.finishTime = this.time;
      this.game.onFinish(car);
    }
    void dt;
  }

  // Traffic, kept up ahead of the player rather than laid out once.
  //
  // Laid out once and left, it drains: every car of it drives forward at forty
  // to seventy while the player does a hundred and eighty, so the road behind
  // fills up with nothing and the first kilometre — which is where the stage
  // starts — is empty by the time anybody looks at it. Cars have to keep
  // arriving, and the only place they can arrive from is out of sight.
  //
  // So: a window ahead of the car, kept at the density the stage asked for.
  // Anything that falls a long way behind is taken away, which is also what
  // pays for the ones being added.
  _topUpTraffic() {
    if (!this.trafficEvery || !this.trafficSpecs.length) return;
    const t = this.track;
    const p = this.player;
    if (!p || !p.loc) return;
    const here = p.loc.s;
    const end = t.closed ? Infinity : t.length - TRAFFIC_EXIT;
    const from = here + TRAFFIC_NEAR;
    const to = Math.min(end, here + TRAFFIC_FAR);
    if (to <= from) return;

    const inWindow = [];
    for (const c of this.cars) {
      if (c.traffic && c.loc && c.loc.s >= from - 40 && c.loc.s <= to) inWindow.push(c);
    }
    const want = Math.floor((to - from) / this.trafficEvery);
    let add = Math.min(want - inWindow.length, TRAFFIC_PER_TICK);

    for (let guard = 0; add > 0 && guard < 40; guard++) {
      const spec = this.trafficSpecs[(this._trafficN = (this._trafficN || 0) + 1) % this.trafficSpecs.length];
      // Somewhere in the window that is not already occupied in that lane.
      // Tried a handful of times and then given up on: the alternative is a
      // car placed on top of another one, which is the thing that made the
      // bridge look like it had duplicates on it.
      const s = from + ((this._trafficN * 137) % Math.max(1, Math.round(to - from)));
      let clear = true;
      for (const c of inWindow) {
        // Where the car IS, not where its driver wants to be — and not
        // through `c.driver`, which a car is not obliged to have. Reading the
        // lane off the driver threw on the first traffic car that had none.
        const lane = c.loc.lateral;
        if (Math.abs(c.loc.s - s) < 34 && Math.abs(lane - spec.lane) < 2.2) { clear = false; break; }
      }
      if (!clear) continue;
      const car = this._makeTraffic(spec, s);
      if (car) { inWindow.push(car); add--; }
    }
  }

  _makeTraffic(spec, s) {
    const t = this.track;
    const p = t.atDistance(s);
    const car = new Car(spec.livery, false);
    car.name = '';
    car.traffic = true;
    car.driver = new Cruiser(car, t, spec.lane, spec.speed);
    car.vehicle.autoShift = true;
    car.vehicle.reset(p.x + p.nx * spec.lane, p.z + p.nz * spec.lane, Math.atan2(p.dirX, p.dirZ));
    car.vehicle.setSpeed(spec.speed);
    car.loc = t.locate(car.vehicle.x, car.vehicle.z);
    car.lastS = car.loc.s;
    car.progress = car.loc.s;
    car.prev = null;
    car.syncModel(t);
    this.cars.push(car);
    this.game.scene.add(car.model);
    return car;
  }

  // Traffic that reaches the end of the road leaves it.
  //
  // On an open route everything past the last sample is clamped to the last
  // sample, so a car that gets there keeps aiming at a point it is already
  // standing on — and the next one arrives, and the next. What piles up is
  // every car of traffic that started ahead of the player, parked across all
  // six lanes at exactly the place the stage is won. There is no road past the
  // end for them to drive off down, so they go.
  _despawn() {
    if (this.route === null || this.track.closed) return;
    const edge = this.track.length - TRAFFIC_EXIT;
    let gone = false;
    const behind = this.player && this.player.loc ? this.player.loc.s - TRAFFIC_DROP : -Infinity;
    for (const car of this.cars) {
      if (!car.traffic || !car.loc) continue;
      // Off the end of the road, or a long way back down it. The second is
      // what pays for the cars being added ahead: without it the field only
      // ever grows, and by the far end of an eleven-kilometre bridge it would
      // be carrying every car it had ever made.
      if (car.loc.s < edge && car.loc.s > behind) continue;
      disposeCar(this.game.scene, car.model);
      car.model = null;
      car.gone = true;
      gone = true;
    }
    // Rebuilt rather than spliced in place: the contact resolver walks this
    // array pairwise and the ordering walks it too, and a hole in it is a null
    // dereference in whichever of them runs first.
    if (gone) {
      this.cars = this.cars.filter((c) => !c.gone);
      this.trafficCount = this.cars.filter((c) => c.traffic).length;
    }
  }

  // Fresh units, cutting in from ahead and from the side.
  //
  // Three cars chasing from behind is a tail, and a tail is a thing you can
  // simply out-drive: get a lead and the stage is over as a contest. What
  // makes a pursuit a pursuit is that it keeps arriving — a car coming the
  // other way round a block, one waiting at the next junction, one that pulls
  // out alongside you from nowhere.
  //
  // So units are spawned ahead of and beside the player at intervals, already
  // moving, already looking for you. They are the same Driver as the ones
  // behind — the station system does the rest, and because they arrive in
  // FRONT their station error is negative, which is what makes them slow,
  // block, and swing across the road as you close.
  _intercept(dt) {
    const spec = this.intercept;
    if (!spec) return;
    const t = this.track;
    const p = this.player;
    if (!p || !p.loc) return;
    this._interceptT = (this._interceptT || 0) + dt;
    if (this._interceptT < spec.every) return;
    this._interceptT = 0;

    const units = this.cars.filter((c) => c.pursuer);
    if (units.length >= spec.max) return;

    // Ahead, far enough that it is not conjured in front of your bonnet.
    const n = (this._interceptN = (this._interceptN || 0) + 1);
    const ahead = spec.from + ((n * 97) % Math.max(1, spec.to - spec.from));
    const s = t.closed ? p.loc.s + ahead : Math.min(t.length - 40, p.loc.s + ahead);
    if (!t.closed && s <= p.loc.s + 40) return;
    const at = t.atDistance(s);
    const half = at.width / 2 - 2;
    // Alternating sides, and out toward the edge — pulling out of a side road
    // rather than materialising in the middle of the carriageway.
    const lane = ((n % 2) ? 1 : -1) * half * 0.7;

    const car = new Car(POLICE.livery, false);
    car.name = `${POLICE.name} ${units.length + 1}`;
    car.pursuer = true;
    car.vehicle.autoShift = true;
    car.vehicle.reset(at.x + at.nx * lane, at.z + at.nz * lane, Math.atan2(at.dirX, at.dirZ));
    car.vehicle.setSpeed(Math.max(14, Math.abs(p.vehicle.u) * 0.55));
    car.loc = t.locate(car.vehicle.x, car.vehicle.z);
    car.lastS = car.loc.s;
    car.progress = car.loc.s;
    car.prev = null;
    car.driver = new Driver(car, t, POLICE.skill, { ...POLICE.opts, station: n % 3 });
    car.driver.quarry = p;
    // It cut in AHEAD, so it is a roadblock until it has been passed: it will
    // stop, turn round and come back at the car rather than drive on down the
    // road in front of it.
    car.driver.intercepting = true;
    car.syncModel(t);
    this.cars.push(car);
    this.game.scene.add(car.model);
  }

  // Roadblocks: parked units across the road ahead.
  //
  // Not a driver slowing down to block — a car with NO driver, placed
  // stationary and turned across the carriageway, with its bar lit. What it
  // asks of the player is different from what a chaser asks: a chaser is
  // pressure from behind, an interceptor is an argument in front, and a
  // roadblock is a puzzle — which side is open, decided at speed.
  //
  // Two cars, offset to alternating sides so there is always a gap, and the
  // gap is never in the middle two blocks running.
  _roadblocks(dt) {
    const spec = this.roadblocks;
    if (!spec) return;
    const t = this.track;
    const p = this.player;
    if (!p || !p.loc) return;
    this._blockT = (this._blockT || 0) + dt;
    if (this._blockT < spec.every) return;
    this._blockT = 0;

    const n = (this._blockN = (this._blockN || 0) + 1);
    const ahead = spec.from + ((n * 131) % Math.max(1, spec.to - spec.from));
    const s = t.closed ? p.loc.s + ahead : Math.min(t.length - 60, p.loc.s + ahead);
    if (!t.closed && s <= p.loc.s + spec.from * 0.8) return;
    const at = t.atDistance(s);
    const half = at.width / 2;
    // The open side alternates, and the two cars cover the rest of the road
    // nose to tail, turned across it.
    const openSide = (n % 2) ? 1 : -1;
    const yaw = Math.atan2(at.dirX, at.dirZ) + Math.PI / 2 * openSide;
    for (let k = 0; k < 2; k++) {
      const lat = -openSide * (half - 2.2 - k * 4.6);
      const car = new Car(POLICE.livery, false);
      car.name = '';
      car.pursuer = true;                        // flashes, counts for heat
      car.roadblock = true;                      // but never moves
      car.vehicle.reset(at.x + at.nx * lat, at.z + at.nz * lat, yaw);
      car.vehicle.autoShift = true;
      car.loc = t.locate(car.vehicle.x, car.vehicle.z);
      car.lastS = car.loc.s;
      car.progress = car.loc.s;
      car.prev = null;
      car.syncModel(t);
      this.cars.push(car);
      this.game.scene.add(car.model);
    }
    // And kept from piling up: one behind the player is done with.
    for (const c of this.cars) {
      if (c.roadblock && c.loc && t.gap(p.loc.s, c.loc.s) > 250) c.gone = true;
    }
    if (this.cars.some((c) => c.gone)) {
      for (const c of this.cars) if (c.gone) disposeCar(this.game.scene, c.model);
      this.cars = this.cars.filter((c) => !c.gone);
    }
  }

  // Keep the pursuit in the mirror.
  //
  // A police car that has lost you by four hundred metres is not a pursuit any
  // more, it is a stage with nothing in it: you drive the rest of the road on
  // your own and the tension the whole thing is built on is a number counting
  // down in the corner. Real chase games solve this by cheating, and so does
  // this one — a unit that falls off the back is brought up the road and
  // matched to your speed.
  //
  // Only from a long way back, and always to somewhere further back still.
  // Two rules, and between them the move cannot be watched: a unit is only
  // ever leashed while it is behind you, and it only ever comes back behind
  // you. "Behind" is the half of the world a driver is not looking at.
  //
  // A leash that put a police car in front would be a leash that decided the
  // stage, and one that fired at fifty metres would be a car that flickered
  // about in the mirror every few seconds.
  _leash() {
    if (!this.leash) return;
    const t = this.track;
    const p = this.player;
    if (!p || !p.loc) return;
    for (const car of this.cars) {
      if (!car.pursuer || car.roadblock || !car.loc) continue;
      const gap = t.gap(p.loc.s, car.loc.s);         // + means the player is ahead
      if (gap < this.leash) continue;
      const back = LEASH_BACK + (car.driver ? (car.driver.opts.station | 0) * 14 : 0);
      const s = t.closed ? p.loc.s - back : Math.max(4, p.loc.s - back);
      const at = t.atDistance(s);
      const lane = (car.driver && car.driver.opts.station % 2) ? 3.0 : -3.0;
      car.vehicle.reset(at.x + at.nx * lane, at.z + at.nz * lane, Math.atan2(at.dirX, at.dirZ));
      // At the player's pace, not from a standing start — dropped in at rest
      // it would be four hundred metres behind again inside ten seconds, and
      // the leash would fire over and over.
      car.vehicle.setSpeed(Math.max(Math.abs(p.vehicle.u), 18));
      car.loc = t.locate(car.vehicle.x, car.vehicle.z);
      car.prev = null;
      if (car.driver) { car.driver.hint = -1; car.driver.stationErr = 0; }
      car.syncModel(t);
    }
  }

  // How far a car is along the route, measured from the start line.
  //
  // `progress` is not that: it is `lap * length + s`, and on a closed circuit
  // the grid sits BEHIND the line, so a car that has not crossed yet reads a
  // whole lap lower than one that just has. That offset cancels for ordering
  // and does not cancel for a finish line partway round. On an open route
  // there are no laps at all and `s` is simply the answer.
  distanceAlong(car) {
    if (!car.loc) return 0;
    return this.track.closed ? car.progress - this.track.length : car.loc.s;
  }

  _order() {
    // Traffic is not classified. It has no position, it is not on the timing
    // screen, and it must not push the player down the order by existing —
    // "4th of 12" on a bridge with eight commuters on it is not a result.
    const sorted = this.cars.filter((c) => !c.traffic).sort((a, b) => {
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
