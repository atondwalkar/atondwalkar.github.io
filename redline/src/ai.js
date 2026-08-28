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

// Everything that used to be a module constant or an internal random roll, so
// a driver can be given a character rather than only a skill number. The
// defaults reproduce exactly what every driver did before, which is why the
// sixteen-car field is unchanged by any of this.
// How close a chaser has to be to its station before it stops driving the road
// and drives at the car.
const RAM_RANGE = 18;

// How much more of the tyres a unit sixty metres or more short of its station
// will use. Fades to nothing as it arrives, so it closes the gap and then
// drives like everything else.
const PURSUIT_CATCHUP = 1.05;

// How far to one side a flanker will always try to be, even with the car it is
// chasing hard against the kerb. Below about two metres it is not beside
// anybody, it is behind them and slightly off-centre.
const PURSUIT_MIN_FLANK = 2.3;

// When a unit that has got in front turns across the road: how far ahead it
// has to be, how far ahead is too far to bother, and the speed above which
// slewing sideways stops being a block and starts being a crash.
const BLOCK_MIN = 6;
const BLOCK_MAX = 34;
const BLOCK_SPEED = 34;              // 122 km/h
// How far round the nose has to come before it stops steering across the road
// and starts steering at the car.
// Low, on purpose. The "across the road" target sits a few metres ahead ALONG
// the road, so as the car rotates the target rotates with it and the turn
// settles at an equilibrium of about forty degrees — it slews and stops. The
// handover has to come before that, because aiming at the car is what keeps
// the rotation going: the further round the nose comes, the further off the
// nose the quarry sits, and the harder it steers.
const BLOCK_FACING = 0.42;           // 24 degrees
// How far ahead the blocking target sits. Short, because a long look-ahead is
// a gentle lane change and what is wanted is a car slewing sideways.
const BLOCK_LOOK = 9;
// What fraction of the quarry's speed a blocking unit drops to. Low enough
// that the gap closes in a second or two rather than over half the stage.
const BLOCK_BRAKE = 0.55;

// A unit that cut in ahead: how far back down the road it will still try to
// turn and face you from, how slowly it has to be going to turn in, how fast
// it may come at you once it has, and how far past it you have to be before it
// gives up and becomes an ordinary chaser again.
const INTERCEPT_RANGE = 700;
const INTERCEPT_TURN = 4;
const INTERCEPT_CLOSE = 20;
const INTERCEPT_DONE = 14;
// How near the nose the quarry has to be before the unit is allowed to come at
// it rather than to keep turning. Thirty-five degrees: past that it is still
// swinging, and a car let off the leash while it is still swinging sweeps
// instead of turning.
const INTERCEPT_ROUND = 0.61;
// How far ahead an interceptor aims while it is turning.
const INTERCEPT_LOOK = 10;

// Where the units try to be, relative to the car they are chasing: one on the
// bumper and one down each side. `along` is metres up the road from it — so a
// negative number is behind — and `beside` is metres to its left.
//
// Three of them, in this order, because the first unit to arrive should be the
// one on the bumper: a flanker that gets there first has nothing to push
// against and simply drives alongside.
const PURSUIT_STATIONS = [
  { along: -7, beside: 0 },
  { along: -1.5, beside: 3.4 },
  { along: -1.5, beside: -3.4 },
  { along: -22, beside: 2.0 },
  { along: -22, beside: -2.0 },
];
// How much of the aim the lunge takes over at point-blank range, and how far
// ahead of the quarry it aims. Half a second of lead is twenty metres at these
// speeds — which, from a car on the apex of a junction, points at the building
// on the inside of it.
const RAM_WEIGHT = 0.55;
const RAM_LEAD = 0.15;

const DEFAULTS = {
  brakeG: BRAKE_G,
  cornerMargin: AI.cornerMargin,
  aggression: null,        // null = roll it, the way it always was
  block: 0,                // willingness to take a defensive line, 0..1
  drift: 0,                // chance of committing to a handbrake corner, 0..1
  chase: 0,                // 0..1: steer at the quarry rather than at the road
  station: 0,              // which place in the box this unit takes
  // 1/32 m. The junctions are 18 m radius; a 50 m sweeper is not something
  // you throw a car at, and treating it as one meant drifting every corner.
  driftMinTurn: 0.031,
};

// Traffic.
//
// Not a Driver with the numbers turned down — a Driver plans a racing line,
// looks two hundred metres ahead for the next corner and works out how late it
// can brake, and none of that is what a car pottering along a bridge in lane
// three is doing. This holds a lane and a speed, and that is all it does.
//
// It is a separate class rather than an option on the other one because the
// two have almost nothing in common, and every `if (this.traffic)` inside a
// racing driver is a place where the racing gets slower and less clear.
export class Cruiser {
  constructor(car, track, lane, speed) {
    this.car = car;
    this.track = track;
    this.lane = lane;              // metres left of the centreline
    this.speed = speed;            // metres a second it would like to be doing
    this.hint = -1;
    this.opts = { chase: 0 };      // read by the chasers' traffic rule
  }

  drive(dt, cars) {
    const v = this.car.vehicle;
    const t = this.track;
    const loc = t.locate(v.x, v.z, this.hint);
    this.hint = loc.index;
    this.car.loc = loc;

    // Steer at a point up the road in this lane. A short look-ahead, because
    // it is not going fast enough to need a long one and a long one makes it
    // cut corners it has no reason to cut.
    const look = clamp(10 + Math.max(v.u, 0) * 0.5, 12, 30);
    const p = t.atDistance(loc.s + look);
    const tx = p.x + p.nx * this.lane, tz = p.z + p.nz * this.lane;
    const dx = tx - v.x, dz = tz - v.z;
    const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
    const localZ = dx * sy + dz * cy;
    const localX = dx * cy - dz * sy;
    const alpha = Math.atan2(localX, Math.max(localZ, 0.5));
    const want = Math.atan2(2 * CAR.wheelbase * Math.sin(alpha),
      Math.max(Math.hypot(localX, localZ), 4));
    v.steerInput = clamp(want / Math.max(v.maxSteerAngle, 1e-3), -1, 1);

    // And hold the speed — but not into the back of the car in front.
    //
    // Traffic in a lane used to be given speeds that differed by five metres a
    // second, so a quick one behind a slow one drove straight into it and the
    // two of them carried on down the bridge as one object, collecting the
    // next car along. What the player saw was cars stacked and duplicated in
    // front of each other. Lane speeds are matched now, and this is the
    // backstop for when they are not: everybody lifts for the car ahead.
    // `pace`, not `want`: the steering above already has a `want` in this
    // scope, and a second const of the same name is a SyntaxError that takes
    // the whole module out — which takes the whole game out, silently.
    let pace = this.speed;
    if (cars) {
      for (const o of cars) {
        if (o === this.car || !o.traffic || !o.loc || !this.car.loc) continue;
        const gap = t.gap(o.loc.s, this.car.loc.s);
        if (gap <= 0 || gap > 42) continue;
        if (Math.abs(o.loc.lateral - this.car.loc.lateral) > 2.2) continue;
        pace = Math.min(pace, Math.max(0, o.vehicle.u * clamp((gap - 7) / 16, 0, 1)));
      }
    }
    const err = pace - Math.max(v.u, 0);
    v.throttle = clamp(err * 0.25, 0, 0.55);
    v.brake = clamp(-err * 0.18, 0, 0.5);
    v.handbrake = 0;
    void dt;
  }
}

export class Driver {
  constructor(car, track, skill = 0.9, opts = {}) {
    this.car = car;
    this.track = track;
    this.skill = skill;
    this.opts = { ...DEFAULTS, ...opts };
    this.brakeG = this.opts.brakeG;
    this.cornerMargin = this.opts.cornerMargin;
    this.aggression = this.opts.aggression
      ?? lerp(AI.aggression[0], AI.aggression[1], Math.random());
    this.hint = -1;
    // The car this one is after, if it is after one. Set from outside — the
    // driver has no idea who is being chased and no business deciding.
    this.quarry = null;
    this.gap = Infinity;          // to the quarry, when there is one
    this.stationErr = 0;          // metres short of its place in the box
    this.blockSide = 0;           // which way it committed to slew, once blocking
    this.intercepting = false;    // cut in ahead, and has not been passed yet
    this.facing = false;          // turned round and looking at the quarry
    this.blockSkew = 0;           // how far off the road's line it has come
    this.offset = 0;              // where on the track it wants to be, in metres
    this.offsetTarget = 0;
    this.reactT = 0;
    this.mistake = 0;             // seconds of degraded input after an error
    this.mistakeCooldown = rand(8, 40);
    this.brakeNoise = rand(-1, 1) * (1 - skill) * 0.10;
    this.throttleNoise = rand(-1, 1) * (1 - skill) * 0.06;
    this.recoverT = 0;
    this.blocked = null;
    // Drifting is a small state machine, latched by distance round the lap so
    // it commits once to a corner rather than re-triggering ten times through
    // it.
    this.driftPhase = 'none';       // none | entry | hold | exit
    this.driftT = 0;
    this.driftAt = null;            // the `s` of the corner it last committed to
    this.driftBend = 1;
    this.driftTarget = 0;
  }

  // The fastest this car could be `d` metres from here and still have slowed to
  // `v` by then. This is the whole of a braking point in one line.
  // The fastest this car could be `d` metres from here and still have slowed
  // to `v`. Per-driver now rather than static: `brakeG` is what "brakes later"
  // means numerically, and it is the single biggest lever on how hard a driver
  // looks. The static form is kept because it is the module default.
  reach(v, d) {
    return Math.sqrt(v * v + 2 * this.brakeG * 9.81 * Math.max(0, d));
  }

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
    const { x: tx, z: tz } = this._aimPoint(dt, loc, speed, cars);

    // --- is this a corner worth throwing the car at?
    const drift = this.opts.drift > 0 ? this._drift(dt, loc, speed) : null;

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
    //
    // In a drift this sign flips, and that flip is the whole difference between
    // catching a slide and holding one. Normally the term ADDS the slip angle,
    // which cancels it — a save. Drifting instead regulates the slip angle to a
    // setpoint, so the term is the ERROR against that setpoint.
    const slideAngle = Math.atan2(v.v, Math.max(Math.abs(v.u), 1));
    if (drift && drift.hold) {
      // The setpoint is NEGATIVE of the bend. `bend` is +1 for a left-hander,
      // and the body frame has +x as the car's LEFT — so a rear end stepping
      // out through a left-hander gives lateral velocity to the right, which
      // is a negative slip angle. Getting this backwards asks the car to slide
      // the wrong way and drives it straight off the road, which is precisely
      // what it did.
      wantAngle += (-this.driftTarget * this.driftBend - slideAngle) * 1.4;
    } else {
      wantAngle += clamp(slideAngle, -0.45, 0.45) * (this.skill * 0.85 + 0.15);
    }
    const maxAngle = Math.max(v.maxSteerAngle, 1e-3);
    v.steerInput = clamp(wantAngle / maxAngle, -1, 1) * (this.mistake > 0 ? 0.85 : 1);

    // --- how fast we are allowed to be
    const limit = this._speedLimit(loc, speed, cars);

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

    // The drift overrides the pedals it needs and leaves the rest alone.
    if (drift) {
      if (drift.entry) { v.handbrake = 1; v.brake = 0; }
      else if (drift.hold) { v.handbrake = 0; v.throttle = Math.max(v.throttle, 0.55); }
    }
  }

  // Throw the car at a corner on the handbrake, and hold it there.
  //
  // Returns null when not drifting, otherwise `{ entry, hold }`. Four phases:
  //
  //   entry  0.35 s of handbrake to break the rear away. The lever IS the
  //          brake here — it locks the rear axle outright and bypasses
  //          stability control, which is the one control allowed to do that.
  //   hold   handbrake off, throttle on, and the steering regulating the slip
  //          angle to a setpoint rather than nulling it.
  //   exit   the setpoint ramps to zero and the ordinary countersteer resumes.
  //
  // It aborts if the car gets away — without that, a botched drift ends facing
  // backwards at twenty km/h, which `_recover` will not catch because it wants
  // the car nearly stopped.
  _drift(dt, loc, speed) {
    const v = this.car.vehicle;
    const t = this.track;
    const slide = Math.abs(Math.atan2(v.v, Math.max(Math.abs(v.u), 1)));

    if (this.driftPhase !== 'none') {
      this.driftT += dt;
      if (slide > 0.8 || Math.abs(v.yawRate) > 2.2) {     // got away from it
        this.driftPhase = 'none';
        return null;
      }
      if (this.driftPhase === 'entry') {
        if (this.driftT > 0.25) { this.driftPhase = 'hold'; this.driftT = 0; }
        return { entry: true, hold: false };
      }
      // Out when the road ahead straightens.
      let ahead = 0;
      for (let d = 0; d < 25; d += t.step * 2) ahead = Math.max(ahead, this._lineAt(loc.s + d).curvature || 0);
      if (ahead < this.opts.driftMinTurn * 0.5) {
        this.driftPhase = 'exit';
        this.driftTarget = Math.max(0, this.driftTarget - dt / 0.4 * 0.22);
        if (this.driftTarget <= 0.001) { this.driftPhase = 'none'; return null; }
      }
      return { entry: false, hold: true };
    }

    // --- worth committing to?
    if (speed < 15.3) return null;                          // under 55 km/h
    // gap() wraps, so this has to be an explicit null rather than a sentinel
    // distance — a large negative one wraps round to "very close" and blocks
    // the first drift of every lap.
    if (this.driftAt !== null && Math.abs(t.gap(loc.s, this.driftAt)) < 60) return null;
    let tightest = 0, bend = 1;
    for (let d = 4; d < 30; d += t.step * 2) {
      const p = this._lineAt(loc.s + d);
      if ((p.curvature || 0) > tightest) {
        tightest = p.curvature || 0;
        bend = t.atDistance(loc.s + d).bend || 1;
      }
    }
    if (tightest < this.opts.driftMinTurn) return null;
    if (Math.random() > this.opts.drift) { this.driftAt = loc.s; return null; }

    this.driftPhase = 'entry';
    this.driftT = 0;
    this.driftAt = loc.s;
    this.driftBend = bend;
    this.driftTarget = 0.22;
    return { entry: true, hold: false };
  }

  // Where to point the car.
  //
  // Extracted from drive() unchanged. It is a seam, not a tidy-up: a pursuing
  // police car aims at the player rather than at the racing line, and a
  // blocking rival aims where you are rather than where the line is, and both
  // want the rest of drive() exactly as it stands.
  _aimPoint(dt, loc, speed, cars) {
    const t = this.track;
    const look = clamp(8 + speed * 0.62, 12, 46);
    const aimS = loc.s + look;
    const lineAt = this._lineAt(aimS);

    const aimSample = t.atDistance(aimS);

    // A pursuer never runs the racing-line offset logic at all.
    //
    // It used to run both: `_chooseOffset` pulled the car back toward the line
    // every frame while the pursuit pulled it toward its station, and what
    // came out was the average of the two — which is to say, never quite
    // alongside anybody. A unit whose job is to sit on somebody's left door
    // has no opinion about the racing line.
    if (this.opts.chase > 0 && this.quarry && this.quarry.loc) {
      return this._pursue(dt, loc, speed, aimS, lineAt, aimSample);
    }

    if (this.reactT <= 0) {
      this.reactT = AI.reaction * rand(0.7, 1.3);
      this.offsetTarget = this._chooseOffset(loc, cars, speed);
    }
    this.offset = lerp(this.offset, this.offsetTarget, clamp(dt * 2.2, 0, 1));

    const onLine = {
      x: lineAt.x + aimSample.nx * this.offset,
      z: lineAt.z + aimSample.nz * this.offset,
    };

    // --- the chase.
    //
    // A police car is not in the race. It is not trying to get round quickly
    // and it is not trying to overtake: it is trying to be in a particular
    // place relative to one other car and stay there. Which place depends on
    // which unit it is — one on the bumper, one down each side — and between
    // them that is a box.
    //
    // This used to be a racing driver with a lunge bolted on inside seventy
    // metres, and outside seventy metres it drove the racing line like
    // everybody else. On a three and a half kilometre route that is not a
    // pursuit, it is three police cars in a race, which is exactly what it
    // looked like.
    return onLine;
  }

  // Where this unit is trying to be, relative to the car it is chasing.
  //
  // `along` is metres up the road from the quarry — negative is behind it —
  // and `beside` is metres to its left. Assigned round-robin by station index,
  // so three units take the bumper and both flanks rather than all three
  // queueing up behind.
  get station() {
    const n = this.opts.station | 0;
    return PURSUIT_STATIONS[n % PURSUIT_STATIONS.length];
  }

  _pursue(dt, loc, speed, aimS, lineAt, aimSample) {
    const t = this.track;
    const q = this.quarry;
    const st = this.station;
    const gap = t.gap(q.loc.s, loc.s);
    this.gap = gap;

    // How far short of station this unit is, along the road. Positive means
    // the station is still up ahead and it has ground to make up.
    this.stationErr = gap + st.along;

    // Sit where the station is, measured off the racing line so the line is
    // not counted twice — `offset` is added to the line and `lateral` is
    // measured from the centreline, and setting one to the other put the
    // chaser twice the line's offset out, which is off the road.
    // Where to sit, across the road.
    //
    // Measured from the quarry, then held to the road the CHASER is on — a
    // junction is fifteen metres wide and the street between two of them is
    // eleven, so a place that exists at one does not at the other. And if the
    // quarry is hard against one kerb, the flanker on that side has nowhere to
    // go: it takes the far side of it instead of grinding along the pavement.
    const room = aimSample.width / 2 - 1.35;
    let beside = st.beside;
    if (beside !== 0) {
      // A flanker keeps ITS OWN side of the car and gets squeezed rather than
      // moved. The first version flipped to the other side when there was not
      // enough road — and since both flankers are looking at the same car on
      // the same kerb, both of them flipped, both to the same place. What that
      // produced was three police cars in a line down one side of the road,
      // which is a queue with sirens on, not a box.
      //
      // Being pinned against a kerb by a police car IS the mechanic, so a
      // flanker with nowhere to go takes what there is and leans on it.
      const sgn = beside > 0 ? 1 : -1;
      const avail = room - sgn * q.loc.lateral;
      beside = sgn * Math.min(Math.abs(beside), Math.max(PURSUIT_MIN_FLANK, avail - 0.4));
    }
    // Clamp the LATERAL and then convert, not the other way round.
    //
    // `offset` is added to the racing line, and the line is itself several
    // metres off the centreline through a corner — so clamping the offset to
    // the road's half-width lets the pair of them add up to seven metres on an
    // eleven-metre street. Which is where a third of the pursuit was being
    // spent: on the pavement, at speed, in the corners.
    const lineOff = lineAt.offset || 0;
    const want = clamp(q.loc.lateral + beside, -room, room) - lineOff;
    // Quicker across the road the closer it is to station: a unit still two
    // hundred metres back has no business weaving, and one drawing alongside
    // has nothing else to do.
    const urgency = clamp(1 - Math.abs(this.stationErr) / 60, 0.15, 1);
    this.offset = lerp(this.offset, want, clamp(dt * 3.4 * urgency, 0, 1));
    const lined = {
      x: lineAt.x + aimSample.nx * this.offset,
      z: lineAt.z + aimSample.nz * this.offset,
    };
    void aimS;

    // Ahead of the quarry and slow: turn across it.
    //
    // A unit that has got in front has one job, and it is not to drive along
    // politely at the same speed. Steering at a car that is BEHIND you swings
    // the nose round through the pure-pursuit geometry — which at thirty
    // metres and forty km/h is a police car slewing across the lane in front
    // of you, and at a hundred and eighty would be a police car spinning into
    // the bay. So it only happens slowly, and only when it is genuinely in
    // front rather than merely half a length up.
    const infront = -this.stationErr;

    // An interceptor is a ROADBLOCK.
    //
    // The units that cut in ahead used to be ordinary pursuers who happened to
    // be in front: the station machinery slowed them a little and the block
    // only reached thirty-four metres, so from three hundred they simply drove
    // down the road at nine metres a second slower than you until you caught
    // them. What was wanted is a car that stops, turns round, and comes back
    // at you — so the block reaches as far as they are spawned, and the speed
    // limit below drops far enough for a car to turn in.
    //
    // It stops being an interceptor the moment you are past it, at which point
    // it is a normal chaser with a normal station behind you.
    if (this.intercepting && gap > INTERCEPT_DONE) this.intercepting = false;
    const reach = this.intercepting ? INTERCEPT_RANGE : BLOCK_MAX;
    this.facing = false;
    // In front and close: this is a block, not a cruise.
    //
    // What it used to do was hold station at the quarry's speed, seven metres
    // ahead, for ever — which from the driving seat is a police car escorting
    // you politely to the ramp. A unit that has got in front has one job, and
    // `_speedLimit` does the other half of it: brake hard enough to be caught.
    if (infront > BLOCK_MIN && infront < reach && speed < BLOCK_SPEED) {
      // ACROSS the road, not at the car.
      //
      // Aiming at the quarry looks like the obvious thing and does nothing at
      // all: a car directly behind you is directly behind you, so the lateral
      // error pure pursuit steers on is zero and the wheel stays straight. The
      // block has to be expressed as somewhere to GO — the far side of the
      // carriageway, a few metres ahead — and the turn falls out of the
      // geometry the same way every other turn in here does.
      // The side is LATCHED when the block starts.
      //
      // Chosen fresh every frame it flips the moment the car crosses the
      // centreline — full lock one way, full lock the other, and a police car
      // shimmying down the road instead of turning across it. It commits to a
      // direction and holds it until the block ends.
      if (this.blockSide === 0) this.blockSide = loc.lateral > 0 ? -1 : 1;
      const side = this.blockSide;
      const road = t.atDistance(loc.s);
      const v0 = this.car.vehicle;
      const skew = Math.abs(angleDiff(v0.yaw, Math.atan2(road.dirX, road.dirZ)));
      // How far off the nose the quarry sits. This, not the angle to the ROAD,
      // is what "facing the car" means — a unit broadside across a bridge is
      // ninety degrees off the road and pointing straight at you, and gating
      // its speed on the road angle left it sitting there at walking pace
      // while you went past.
      this.blockSkew = Math.abs(angleDiff(
        v0.yaw, Math.atan2(q.vehicle.x - v0.x, q.vehicle.z - v0.z)));

      // Two halves to the manoeuvre, and they need different targets.
      //
      // Turning across the road has to be expressed as somewhere to GO — the
      // far side of the carriageway, a few metres ahead — because aiming at a
      // car directly behind gives zero lateral error and pure pursuit does
      // nothing with it. But once the nose has come round far enough to be
      // pointing at the quarry rather than down the road, that stops being
      // true: from there it aims at the CAR, and drives into it.
      // An interceptor turns straight toward the car and never does the
      // across-the-road phase at all.
      //
      // That phase exists to break the tie when the quarry is DIRECTLY behind,
      // where the lateral error pure pursuit steers on is zero. A unit that
      // cut in three hundred metres up the road is not in that position — the
      // car is a long way back and a little off-line — so aiming at it gives
      // a target behind the nose, which the pure-pursuit clamp turns into full
      // lock, which is a car turning round. Nudged a couple of metres to the
      // side it committed to, so the tie is broken even when it is exact.
      if (this.intercepting) {
        this.facing = true;
        // A point ten metres away in the DIRECTION of the car, not the car
        // itself three hundred metres off.
        //
        // Pure pursuit divides by how far the target is, so aiming at
        // something three hundred metres behind asks for one degree of lock
        // and the car takes half a minute to come round — by which time you
        // have gone past. Ten metres in the same direction asks for all of it.
        const dx0 = q.vehicle.x - this.car.vehicle.x;
        const dz0 = q.vehicle.z - this.car.vehicle.z;
        const l0 = Math.hypot(dx0, dz0) || 1;
        // The side nudge exists only to break the tie while it is still
        // turning — aiming at a car directly behind gives zero lateral error
        // and nothing happens. Once it is round, the nudge is two metres of
        // deliberate miss, and at a closing speed of sixty there is no time to
        // correct it: so it fades out as the nose comes onto the car.
        const n = loc.sample;
        const nudge = side * 2 * clamp(this.blockSkew / INTERCEPT_ROUND, 0, 1);
        return {
          x: this.car.vehicle.x + (dx0 / l0) * INTERCEPT_LOOK + n.nx * nudge,
          z: this.car.vehicle.z + (dz0 / l0) * INTERCEPT_LOOK + n.nz * nudge,
        };
      }
      if (skew > BLOCK_FACING) {
        // Round far enough to be looking at the car: go at it. `facing` is
        // read by the speed limit, which stops holding it back the moment the
        // turn is done — a roadblock that has turned and then crawls is a
        // roadblock you drive round.
        this.facing = true;
        return { x: q.vehicle.x, z: q.vehicle.z };
      }
      const across = t.atDistance(loc.s + BLOCK_LOOK);
      // A pivot, not a lane change. An interceptor that swings to the far side
      // of a six-lane deck to begin its turn ends the turn twenty metres off
      // the line the car is on, and twenty metres is a miss.
      const off = side * (this.intercepting ? 3.5 : across.width / 2 - 1.5);
      return { x: across.x + across.nx * off, z: across.z + across.nz * off };
    }

    this.blockSide = 0;

    // On station and close: lean on it. The nose goes where the car is going
    // to be rather than where it is, which is the difference between hitting
    // it and arriving just behind it.
    const near = Math.hypot(q.vehicle.x - loc.sample.x, q.vehicle.z - loc.sample.z);
    if (Math.abs(this.stationErr) > RAM_RANGE || near > 26) return lined;
    const k = (1 - Math.abs(this.stationErr) / RAM_RANGE) * this.opts.chase * RAM_WEIGHT;
    const qv = q.vehicle;
    const ax = qv.x + Math.sin(qv.yaw) * qv.u * RAM_LEAD;
    const az = qv.z + Math.cos(qv.yaw) * qv.u * RAM_LEAD;
    return { x: lerp(lined.x, ax, k), z: lerp(lined.z, az, k) };
  }

  // How fast this driver will let itself be. The other seam.
  _speedLimit(loc, speed, cars) {
    const t = this.track;
    let limit = Infinity;
    for (let d = 0; d < 190; d += t.step * 2) {
      const p = this._lineAt(loc.s + d);
      const allowed = this.reach(p.speed, d);
      if (allowed < limit) limit = allowed;
    }
    // Skill is mostly this line: how close to the limit the driver is willing
    // to run. A tenth of a g around a lap is several seconds.
    limit *= this.cornerMargin * lerp(0.90, 1.03, this.skill);
    if (this.mistake > 0) limit *= 1.14;                 // braked too late
    limit = Math.max(limit, 6);

    // --- traffic: do not drive into the back of the car in front
    const ahead = this._carAhead(cars, loc);
    // A chaser does not lift for the car it is chasing. That is the whole
    // point of it, and the traffic rule below — which exists so a field of
    // sixteen does not concertina into the back of itself — would otherwise
    // make every police car settle politely two car lengths back.
    //
    // It returns the CORNER limit, not something faster than it. Letting a
    // chaser off the corner limit as well — `max(limit, speed + 6)` — put it
    // into the first junction at a hundred and thirty and thirty metres off
    // the road, where it spent the rest of the pursuit.
    if (this.opts.chase > 0 && this.quarry && this.quarry.loc) {
      // A chaser does not lift for the car it is chasing — that is the whole
      // point of it, and the traffic rule below, which exists so a field of
      // sixteen does not concertina into the back of itself, would otherwise
      // make every unit settle politely two car lengths back.
      //
      // What it does instead is hold STATION. Behind its station it takes the
      // full corner limit and everything the engine has. Past its station it
      // backs off to the quarry's pace and below, which is what stops three
      // police cars overtaking and disappearing up the road — the behaviour
      // that made the stage look like a race with sirens.
      const err = this.stationErr ?? 0;
      const qs = Math.max(this.quarry.vehicle.u, 0);
      // Inside ramming range the corner limit applies HARDER, not softer: a
      // car leaning sideways on another one is spending grip on that and
      // cannot also spend it holding the corner.
      const close = clamp(1 - Math.abs(err) / RAM_RANGE, 0, 1);
      let cap = limit * lerp(1, 0.86, close);
      // Catch-up. The cars are identical — one physics package, deliberately —
      // so a pursuer can only take time out of the car in front in the
      // corners, and eight per cent of corner speed over a three-kilometre
      // route brings the first unit alongside somewhere around the last
      // junction. Which is too late for the stage to be about being chased.
      //
      // So a unit a long way short of station is allowed to lean on it harder,
      // fading out entirely as it arrives. It is not extra grip and it is not
      // a faster car: it is a driver taking more of what the tyres already
      // have, the further behind it is.
      if (err > 0) cap *= lerp(1, PURSUIT_CATCHUP, clamp(err / 60, 0, 1));
      // In front: brake, hard, so the quarry arrives. Holding station at the
      // quarry's own speed keeps the gap exactly where it is, which is the
      // one outcome a block must not produce — the unit sits in front doing
      // the same speed as you until the stage ends.
      const front = -err;
      const reach2 = this.intercepting ? INTERCEPT_RANGE : BLOCK_MAX;
      if (front > BLOCK_MIN && front < reach2) {
        // The speed is gated on how far ROUND it is, not on whether it has
        // started aiming at the car. Those are different moments: the aim
        // hands over at twenty-four degrees, which is early on purpose because
        // that is what keeps the rotation going, and a car let off the leash
        // at twenty-four degrees and twenty metres a second does not turn, it
        // sweeps — the first version of this ended up a hundred metres off the
        // side of the bridge, still politely rotating.
        if (this.blockSkew < INTERCEPT_ROUND) return Math.min(cap, INTERCEPT_CLOSE);
        // Not yet round: slow enough to turn in. A car doing forty cannot
        // spin on the spot, and an interceptor that cannot turn is a slow car
        // in your way.
        if (this.intercepting) return Math.min(cap, INTERCEPT_TURN);
        return Math.min(cap, Math.max(4, qs * BLOCK_BRAKE));
      }
      // Station keeping, once it is anywhere near. A flat "back off to the
      // quarry's pace" overshoots and then has to catch up again, so a unit
      // that should be sitting on a door spends its time swinging past it and
      // dropping back: proportional to the error, it settles instead.
      if (err < 24) {
        const want = qs + clamp(err * 0.55, -9, 14);
        cap = Math.min(cap, Math.max(5, want));
      }
      return cap;
    }
    if (ahead) {
      const closing = speed - ahead.speed;
      const room = ahead.distance - 6.5;
      if (room < 1) limit = Math.min(limit, ahead.speed * 0.85);
      else if (closing > 0) {
        limit = Math.min(limit, this.reach(ahead.speed, room) * 0.98);
      }
    }
    return limit;
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

    // --- and defend, if this driver is the sort that does.
    //
    // Nothing in the field blocks today: a bot in front holds the racing line
    // whatever is behind it. A rival that will not move is not a rival, it is
    // a pace car. Defending happens on the straight and stops at the corner —
    // weaving into a braking zone is how you lose a race, not how you win one.
    if (this.opts.block > 0 && loc.sample.curvature < 0.006) {
      for (const other of cars) {
        if (other === this.car || !other.vehicle) continue;
        const behind = t.gap(loc.s, other.loc ? other.loc.s : 0);
        if (behind < 2 || behind > 22) continue;
        const theirs = other.loc ? other.loc.lateral : 0;
        // Move to the side they are coming from, and no further than the
        // driver's willingness to do it.
        want += clamp(theirs - loc.lateral, -1, 1) * 3.0 * this.opts.block;
        break;
      }
    }

    // Keep off the kerbs unless the line is there.
    const total = clamp(lineOffset + want, -halfWidth, halfWidth);
    return total - lineOffset;
  }

  _carAhead(cars, loc) {
    const t = this.track;
    const chasing = this.opts.chase > 0;
    let best = null;
    for (const other of cars) {
      if (other === this.car || !other.loc) continue;
      // A unit does not queue behind another unit.
      //
      // Three police cars converging on three different places around one car
      // start out in the same lane, and the traffic rule — which exists so a
      // field of sixteen does not concertina into itself — made the two
      // flankers sit politely behind the one on the bumper for the whole
      // pursuit. They never reached a flank, so there was never a box. They
      // are one coordinated thing; they can pass each other.
      if (chasing && other.driver && other.driver.opts.chase > 0) continue;
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
    // Held at the end on a route rather than wrapping to the start: the speed
    // profile looks a hundred and ninety metres up the road, and past the end
    // of an open one there is nothing to look at. Wrapping instead sent every
    // driver in the last two hundred metres braking for the first corner of a
    // road they had already left.
    if (!t.closed) return t.line[clamp(Math.round(s / t.step), 0, n - 1)];
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
    // A unit that has deliberately turned to face the oncoming car is not
    // lost. Recovery exists to rescue a driver that has spun or gone off; run
    // on a roadblock it undoes the roadblock, points the car back down the
    // road and drives it away — which is exactly what this was doing.
    if (this.facing) return false;
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
