// Headless smoke test: load with ?test=<seconds> and the game checks itself.
//
// A racing game is unusually testable, because almost everything it claims is a
// number you can measure. A car that says it has six gears should pull six
// different speeds; a handbrake should produce a slide that not pulling it does
// not; a three-lap race should end after three laps with sixteen cars in some
// definite order. So rather than eyeball it, the test drives the car.
//
// It also runs a whole race at once by stepping the simulation as fast as the
// machine will go, so a three-lap, sixteen-car race is checked in about a
// second instead of two minutes.

import * as THREE from 'three';
import { Vehicle } from './vehicle.js';
import { Driver } from './ai.js';
import { Track } from './track.js';
import { CAR, RACE, AI, SELECTABLE } from './defs.js';
import { clamp, lapTime, dist2D } from './utils.js';

const FIXED = 1 / 120;

function post(path, body) {
  try { fetch(path, { method: 'POST', body }); } catch (e) { /* console is the fallback */ }
}

// A car on its own, on a surface with grip, for measuring what it can do.
function bench() {
  const v = new Vehicle(CAR);
  v.reset(0, 0, 0);
  v.autoShift = true;
  v.surfaceGrip = 1;
  return v;
}

function step(v, seconds, fn) {
  const n = Math.round(seconds / FIXED);
  for (let i = 0; i < n; i++) {
    if (fn) fn(v, i * FIXED);
    v.update(FIXED, 2);
  }
}

// ---------------------------------------------------------------- physics

// Standing start to a hundred kilometres an hour, and on to the top speed the
// gearing and the drag settle at.
function checkAcceleration() {
  const v = bench();
  let t = 0, to100 = 0, to200 = 0;
  const n = Math.round(45 / FIXED);
  for (let i = 0; i < n; i++) {
    v.throttle = 1;
    v.update(FIXED, 2);
    t += FIXED;
    if (!to100 && v.speedKmh >= 100) to100 = t;
    if (!to200 && v.speedKmh >= 200) to200 = t;
  }
  const top = v.speedKmh;
  const ok = to100 > 2.2 && to100 < 6.5 && top > 240 && top < 360;
  return `${ok ? 'as specified' : 'OUT OF RANGE'} — 0–100 in ${to100.toFixed(2)}s, ` +
    `0–200 in ${to200 ? to200.toFixed(2) : '--'}s, top ${top.toFixed(0)} km/h in ${v.gear}${nth(v.gear)}`;
}

// Takes the gear NUMBER, which is now the same as its index into CAR.gears.
const nth = (g) => (g === 1 ? 'st' : g === 2 ? 'nd' : g === 3 ? 'rd' : 'th');

// A hundred kilometres an hour to a standstill, in metres.
function checkBraking() {
  const v = bench();
  step(v, 12, (c) => { c.throttle = 1; });
  // Settle at 100 km/h, then stand on the brakes.
  v.throttle = 0;
  while (v.speedKmh > 100) v.update(FIXED, 2);
  let t = 0, d = 0;
  let px = v.x, pz = v.z;
  while (v.speed > 0.5 && t < 12) {
    v.throttle = 0;
    v.brake = 1;
    v.update(FIXED, 2);
    d += Math.hypot(v.x - px, v.z - pz);
    px = v.x; pz = v.z;
    t += FIXED;
  }
  const g = (27.78 * 27.78) / (2 * d) / 9.81;
  // Wide enough to allow a genuinely good stop on slicks with downforce, and
  // still catch a car that teleports to a halt or one that will not pull up.
  const ok = d > 21 && d < 60;
  return `${ok ? 'stops properly' : 'WRONG'} — 100–0 in ${d.toFixed(1)} m (${g.toFixed(2)} g) in ${t.toFixed(2)}s, ` +
    `anti-lock held the tyres at ${v.slipF.toFixed(2)} slip`;
}

// Six gears that actually do different things. The speed each one reaches at
// the redline must climb, and first must not be able to reach top speed.
// No neutral. The array is [R, 1..6]: shifting down from first must stay in
// first rather than dropping into reverse, and there must be no ratio of zero
// anywhere in it.
function checkNoNeutral() {
  const zeros = CAR.gears.filter((g) => g === 0).length;
  const v = bench();
  v.autoShift = false;
  v.gear = 1;
  v.shiftT = 0;
  v.shiftDown();
  const held = v.gear === 1;
  const ok = zeros === 0 && held && CAR.gears.length === 7;
  return `${ok ? 'no neutral to fall into' : 'WRONG'} — ` +
    `${CAR.gears.length - 1} ratios and reverse, ${zeros} of them zero, ` +
    `shifting down from first ${held ? 'stays in first' : `gave ${v.gear}`}`;
}

function checkGearbox() {
  const v = bench();
  const speeds = [];
  // From index 1: the array is [R, 1..6] now, with no neutral between them.
  for (let g = 1; g < CAR.gears.length; g++) {
    const ratio = CAR.gears[g] * CAR.finalDrive;
    const omega = (CAR.redline / 60) * Math.PI * 2 / ratio;
    speeds.push(omega * CAR.wheelRadius * 3.6);
  }
  let rising = true;
  for (let i = 1; i < speeds.length; i++) if (speeds[i] <= speeds[i - 1]) rising = false;

  // And the shift itself: changing up must drop the revs.
  const c = bench();
  c.autoShift = false;
  step(c, 6, (x) => { x.throttle = 1; });
  const before = c.rpm;
  const gearBefore = c.gear;
  c.shiftUp();
  step(c, 0.5, (x) => { x.throttle = 1; });
  const after = c.rpm;
  const dropped = after < before * 0.92;
  const changed = c.gear === gearBefore + 1;
  const ok = rising && dropped && changed && speeds.length === 6;
  return `${ok ? 'six speeds, all different' : 'WRONG'} — ` +
    `${speeds.map((s) => s.toFixed(0)).join('/')} km/h at the redline; ` +
    `shift up dropped ${before.toFixed(0)} → ${after.toFixed(0)} rpm`;
}

// What the car will hold in a steady corner, measured the way a skidpad run
// measures it: hold a speed and wind the lock on gradually until the front
// tyres give up, recording the best the car managed on the way. A fixed stab
// of steering would measure the size of the stab, not the grip.
function peakLateral(kmh = 130) {
  const v = bench();
  step(v, 12, (c) => { c.throttle = 1; });
  while (v.speedKmh > kmh) { v.throttle = 0; v.update(FIXED, 2); }
  let peak = 0, radius = 0, at = 0;
  const T = 4.5;
  step(v, T, (c, t) => {
    c.throttle = 0.45;
    c.steerInput = Math.min(1, t / (T * 0.75));
    if (Math.abs(c.lateralG) > peak) {
      peak = Math.abs(c.lateralG);
      at = c.speedKmh;
      if (Math.abs(c.yawRate) > 0.01) radius = Math.abs(c.u / c.yawRate);
    }
  });
  return { peak, radius, at };
}

function checkCornering() {
  const r = peakLateral();
  const ok = r.peak > 1.0 && r.peak < 2.2;
  // "The most it will pull", not "the limit": the steering rack now runs out
  // before the tyres do, deliberately, so this is what the car will actually
  // give you rather than what the rubber could theoretically hold.
  return `${ok ? 'grips' : 'WRONG'} — ${r.peak.toFixed(2)} g is the most it will pull, ` +
    `${r.radius.toFixed(0)} m radius at ${r.at.toFixed(0)} km/h`;
}

// Holding a turn must simply turn.
//
// This is the assertion that matters most for how the car feels, because on a
// keyboard there is no half-lock: an ordinary corner *is* a held key, so if
// full lock breaks traction then every corner does. The car has to keep
// pulling as hard at the end of a long turn as in the middle of it, and it has
// to come out still pointing roughly where it was steered.
function checkHeldTurn() {
  const rows = [];
  let worstHold = 1, worstSlide = 0;
  for (const kmh of [60, 100, 140, 180]) {
    const v = bench();
    step(v, 14, (c) => { c.throttle = 1; });
    while (v.speedKmh > kmh) { v.throttle = 0; v.update(FIXED, 2); }
    let mid = 0, end = 0, slide = 0;
    const T = 3.2;
    step(v, T, (c, t) => {
      c.throttle = 0.4;
      c.steerInput = Math.min(1, t / 0.5);          // wind on, then hold
      if (t > 1.0 && t < 1.6) mid = Math.max(mid, Math.abs(c.lateralG));
      if (t > T - 0.6) {
        end = Math.max(end, Math.abs(c.lateralG));
        slide = Math.max(slide, Math.abs(Math.atan2(c.v, Math.max(Math.abs(c.u), 1))));
      }
    });
    const hold = mid > 0.05 ? end / mid : 0;
    worstHold = Math.min(worstHold, hold);
    worstSlide = Math.max(worstSlide, slide);
    rows.push(`${kmh}:${end.toFixed(2)}g`);
  }
  const deg = (worstSlide * 180) / Math.PI;
  // Still pulling what it was pulling, and not sideways doing it.
  const ok = worstHold > 0.9 && deg < 12;
  return `${ok ? 'holds the corner' : 'LETS GO MID-CORNER'} — ` +
    `${rows.join(' ')} sustained, keeping ${(worstHold * 100).toFixed(0)}% of ` +
    `mid-corner grip to the exit, ${deg.toFixed(0)}° of slide at worst`;
}

// Braking must not be a way to start a slide. Stand on the pedal in the middle
// of a corner — trail braking, the most demanding ordinary thing a driver does
// — and the car has to stay pointed where it is going. The handbrake is the one
// control allowed to break traction, and the same test run with the lever
// pulled shows the difference.
function checkBrakeStability() {
  const run = (useHandbrake) => {
    const v = bench();
    step(v, 12, (c) => { c.throttle = 1; });
    while (v.speedKmh > 150) { v.throttle = 0; v.update(FIXED, 2); }
    let peak = 0, at = 0, yawThere = 0, askedThere = 0, slipR = 0;
    // Settle into the corner, then brake hard without lifting out of it.
    step(v, 0.8, (c) => { c.throttle = 0.35; c.steerInput = 0.7; });
    step(v, 1.8, (c) => {
      c.throttle = 0;
      c.brake = 1;
      c.steerInput = 0.7;
      c.handbrake = useHandbrake ? 1 : 0;
      const b = Math.abs(Math.atan2(c.v, Math.max(Math.abs(c.u), 1)));
      if (b > peak) {
        peak = b;
        at = c.speedKmh;
        yawThere = Math.abs(c.yawRate);
        askedThere = Math.abs((c.u * c.steer) / CAR.wheelbase);
        slipR = c.slipR;
      }
    });
    return { deg: (peak * 180) / Math.PI, at, yawThere, askedThere, slipR };
  };
  const pedal = run(false);
  const lever = run(true);
  const ok = pedal.deg < 15 && lever.deg > pedal.deg * 2.5;
  return `${ok ? 'the pedal holds it, the lever lets go' : 'BRAKING SLIDES IT'} — ` +
    `${pedal.deg.toFixed(0)}° of slide braking hard mid-corner ` +
    `(worst at ${pedal.at.toFixed(0)} km/h, turning ${pedal.yawThere.toFixed(2)} rad/s ` +
    `against ${pedal.askedThere.toFixed(2)} asked, rear slip ${pedal.slipR.toFixed(2)}), ` +
    `${lever.deg.toFixed(0)}° with the handbrake`;
}

// The handbrake. Pulling it should produce a slide that not pulling it, with
// exactly the same steering, does not — and the car should come back.
function checkHandbrakeDrift() {
  const run = (useHandbrake) => {
    const v = bench();
    step(v, 8, (c) => { c.throttle = 1; });
    while (v.speedKmh > 90) { v.throttle = 0; v.update(FIXED, 2); }
    let peakSlide = 0, peakYaw = 0;
    step(v, 1.6, (c) => {
      c.throttle = 0.3;
      c.steerInput = 0.35;
      c.handbrake = useHandbrake ? 1 : 0;
      const slide = Math.abs(Math.atan2(c.v, Math.max(Math.abs(c.u), 1)));
      peakSlide = Math.max(peakSlide, slide);
      peakYaw = Math.max(peakYaw, Math.abs(c.yawRate));
    });
    // Let go, straighten up, and see whether it comes back.
    step(v, 2.2, (c) => { c.handbrake = 0; c.throttle = 0.25; c.steerInput = -0.15; });
    const settled = Math.abs(Math.atan2(v.v, Math.max(Math.abs(v.u), 1)));
    return { slide: peakSlide, yaw: peakYaw, settled, rear: v.slipR };
  };
  const on = run(true);
  const off = run(false);
  const deg = (r) => (r * 180) / Math.PI;
  const ok = on.slide > off.slide * 1.8 && deg(on.slide) > 12 && deg(on.settled) < 10;
  return `${ok ? 'locks the rear and steps it out' : 'NO DRIFT'} — ` +
    `${deg(on.slide).toFixed(0)}° of slide with it, ${deg(off.slide).toFixed(0)}° without, ` +
    `recovers to ${deg(on.settled).toFixed(0)}°`;
}

// Weight transfer: braking should load the front axle and unload the rear.
function checkWeightTransfer() {
  const v = bench();
  step(v, 10, (c) => { c.throttle = 1; });
  step(v, 0.6, (c) => { c.throttle = 0; c.brake = 1; });
  const braking = { f: v.loadF, r: v.loadR };
  step(v, 1.2, (c) => { c.brake = 0; c.throttle = 1; });
  const driving = { f: v.loadF, r: v.loadR };
  const ok = braking.f > driving.f && driving.r > braking.r;
  return `${ok ? 'transfers under load' : 'WRONG'} — braking ${braking.f.toFixed(0)}/${braking.r.toFixed(0)} N ` +
    `front/rear, driving ${driving.f.toFixed(0)}/${driving.r.toFixed(0)} N`;
}

// Which way is left? This is worth a test of its own, because the answer is
// not the obvious one: in a right-handed frame with Y up and Z forward, the
// car's left is +x, and writing the steering as though it were the right gives
// you a car that goes the other way from the key you pressed.
//
// Checked twice over: that positive steering turns the car toward its own left
// in world space, and that the key the player presses produces the sign that
// does it.
function checkSteering(game) {
  const notes = [];

  // --- the physics. From the origin facing +z, a left turn goes toward +x.
  const turn = (input) => {
    const v = bench();
    step(v, 6, (c) => { c.throttle = 0.7; });
    v.reset(0, 0, 0);
    v.setSpeed(26);
    v.gear = 3;
    step(v, 1.4, (c) => { c.throttle = 0.35; c.steerInput = input; });
    return { x: v.x, yaw: v.yaw, steer: v.steer };
  };
  const L = turn(1), R = turn(-1);
  const ok = L.x > 1 && R.x < -1 && L.yaw > 0 && R.yaw < 0;
  notes.push(ok
    ? `positive steering goes left (${L.x.toFixed(1)} m) and negative right (${R.x.toFixed(1)} m)`
    : `MIRRORED — +1 moved ${L.x.toFixed(1)} m, -1 moved ${R.x.toFixed(1)} m in x`);

  // --- the keyboard. A must ask for left, D for right.
  const race = game.race;
  const wasState = race.state;
  const player = race.player;
  const wasDriver = player.driver;
  const wasInput = player.vehicle.steerInput;
  race.state = 'racing';
  player.driver = null;
  player.finished = false;
  const press = (code) => {
    game.keys.clear();
    game.keys.add(code);
    player.vehicle.steerInput = 0;
    for (let i = 0; i < 40; i++) game._drivePlayer(1 / 60);
    return player.vehicle.steerInput;
  };
  const a = press('KeyA'), d = press('KeyD');
  notes.push(a > 0.2 && d < -0.2
    ? 'A steers left, D steers right'
    : `KEYS BACKWARDS — A gave ${a.toFixed(2)}, D gave ${d.toFixed(2)}`);

  // --- and the gearbox is on the up and down arrows, which must not also be
  // pressing a pedal on the way past.
  const v = player.vehicle;
  const wasAuto = v.autoShift, wasGear = v.gear, wasThr = v.throttle, wasBrk = v.brake;
  v.autoShift = false;
  // Relative to wherever it starts, rather than hard-coded gear numbers: the
  // numbers changed when neutral was taken out of the array, and an assertion
  // written in absolute indices reported a working gearbox as broken.
  const START = 2;
  v.gear = START;
  v.shiftT = 0;
  v.throttle = 0;
  v.brake = 0;
  game.keys.clear();
  game._press('ArrowUp');
  const up = v.gear;
  v.shiftT = 0;
  game._press('ArrowDown');
  game._press('ArrowDown');
  const down = v.gear;
  // Held down, an arrow must drive no pedal.
  game.keys.add('ArrowUp');
  for (let i = 0; i < 30; i++) game._drivePlayer(1 / 60);
  const pedals = v.throttle + v.brake;
  game.keys.clear();

  v.autoShift = wasAuto;
  v.gear = wasGear;
  v.throttle = wasThr;
  v.brake = wasBrk;
  race.state = wasState;
  player.driver = wasDriver;
  player.vehicle.steerInput = wasInput;
  // Two downs, one shift: the second is inside the shift time and refused,
  // which is the gearbox behaving, so it lands back where it started.
  notes.push(up === START + 1 && down === START
    ? 'up-arrow shifts up, down-arrow shifts down'
    : `ARROWS DO NOT SHIFT — from ${START}${nth(START)}, `
      + `up gave ${up} and a down gave ${down}`);
  notes.push(pedals < 0.01 ? 'and neither touches a pedal'
    : `ARROW ALSO DRIVES A PEDAL (${pedals.toFixed(2)})`);
  return notes.join(', ');
}

// How much steering is there to spend, against how much the tyres can actually
// use? This is what "too sensitive" means in a number. If full lock at racing
// speed asks for several times the cornering force the car can generate, most
// of the steering's travel does nothing but scrub the fronts or spin it, and
// the car is undrivable however good the rest of the model is.
function checkSteeringWeight() {
  // The limit the car actually reaches, not the tyre's headline coefficient:
  // load sensitivity and lateral transfer both take a bite out of it, and
  // comparing against the headline figure would call a well-judged steering
  // rack too light.
  const lim = peakLateral().peak * 9.81;
  const rows = [];
  let worst = 0, tooLittle = false;
  for (const kmh of [40, 60, 100, 140, 180, 220]) {
    const u = kmh / 3.6;
    const f = CAR.fullLockBelow;
    const avail = CAR.steerLock * (u <= f ? 1 : (f * f) / (u * u));
    // The road-wheel angle a steady turn at the limit needs, from the bicycle
    // approximation: radius = wheelbase / angle, and the limit sets the radius.
    const need = (CAR.wheelbase * lim) / (u * u);
    const ratio = avail / need;
    worst = Math.max(worst, ratio);
    if (ratio < 1.05) tooLittle = true;
    rows.push(`${kmh}:${ratio.toFixed(1)}x`);
  }
  // Must be able to reach the limit everywhere, and must not offer so much
  // more than the limit that most of the travel is wasted spinning.
  const ok = worst < 2.5 && !tooLittle;
  return `${ok ? 'enough to provoke it, not enough to throw it away'
    : tooLittle ? 'CANNOT REACH THE LIMIT' : 'FAR TOO MUCH LOCK'} — ` +
    `full lock asks for ${rows.join(' ')} of what the tyres can hold`;
}

// ------------------------------------------------------------------ track

function checkTrack(track) {
  const notes = [];
  notes.push(`${(track.length / 1000).toFixed(3)} km, ${track.samples.length} samples`);
  // The road should be one width except at the junctions. It was widening at
  // every point of the grid, including the three the road runs straight
  // through, which put an unexplained bulge in the middle of a straight.
  let wide = 0, wideAt = 0, bulges = 0;
  for (const p of track.samples) {
    if (p.width > wide) { wide = p.width; wideAt = p.s; }
    if (p.width > track.samples[0].width + 0.2) {
      const corner = track.corners.some((c) => dist2D(c.x, c.z, p.x, p.z) < 36);
      if (!corner) bulges++;
    }
  }
  notes.push(`${wide.toFixed(1)} m at its widest (at ${wideAt.toFixed(0)} m)`
    + (bulges ? `, WIDE IN ${(bulges * track.step).toFixed(0)} m OF PLAIN STREET` : ''));
  // Where the lap starts matters: the grid sits in the ninety metres behind
  // the line, and the run after it is what the field gets to sort itself out
  // on before the first corner.
  if (track.startStraight) {
    let run = 0;
    while (run < track.samples.length && track.at(run).curvature < 0.0025) run++;
    notes.push(`starts on a ${track.startStraight.toFixed(0)} m straight `
      + `with ${(run * track.step).toFixed(0)} m of it left after the line`);
  }

  // Closed: the last sample must lead back into the first.
  const a = track.samples[0], b = track.samples[track.samples.length - 1];
  const closes = dist2D(a.x, a.z, b.x, b.z) < track.step * 1.6;
  notes.push(closes ? 'closed loop' : 'NOT CLOSED');

  // No crossings: two points far apart along the lap must be far apart on the
  // ground, or the circuit runs over itself.
  // Two stretches of track must stay far enough apart that their surfaces and
  // their barriers do not share ground — otherwise a car that runs wide can be
  // snapped onto the wrong stretch, and its lap counter goes with it.
  let worst = Infinity, worstAt = 0, worstS = 0;
  for (let i = 0; i < track.samples.length; i++) {
    for (let j = i + 1; j < track.samples.length; j++) {
      const along = Math.min(Math.abs(i - j), track.samples.length - Math.abs(i - j)) * track.step;
      if (along < 90) continue;
      const p = track.samples[i], q = track.samples[j];
      const d = dist2D(p.x, p.z, q.x, q.z) - (p.width + q.width) / 2;
      if (d < worst) { worst = d; worstAt = along; worstS = p.s; }
    }
  }
  const clear = worst > 12;
  notes.push(clear
    ? `never doubles back on itself (${worst.toFixed(0)} m of clear ground at the closest)`
    : `TOO CLOSE TO ITSELF — ${worst.toFixed(0)} m between edges at ${worstS.toFixed(0)} m ` +
      `into the lap, ${worstAt.toFixed(0)} m apart along it`);

  // Corners: how much of the lap is actually a corner tells you if it is a
  // circuit or an oval.
  const corners = track.samples.filter((p) => p.curvature > 0.004).length;
  const tight = track.samples.filter((p) => p.curvature > 0.011).length;
  notes.push(`${Math.round((corners / track.samples.length) * 100)}% cornering, ` +
    `${Math.round((tight / track.samples.length) * 100)}% of it slow`);
  return notes.join(', ');
}

// The racing line has to stay on the road and be straighter than the road.
// How steep the road gets where it bends. The surface is level across its
// width, so a sample's height applies right across it — which means the inside
// edge of a corner covers its rise in a shorter distance than the centreline
// does, and climbs harder for it. On a wide road round a tight bend the
// difference is not subtle.
function checkCornerGrade(track) {
  const hw = track.samples[0].width / 2;
  let worstAmp = 0, worstAt = null, tightest = Infinity;
  for (const p of track.samples) {
    const r = p.curvature > 1e-6 ? 1 / p.curvature : Infinity;
    tightest = Math.min(tightest, r);
    const inner = Math.max(1.5, r - hw);
    // Capped the same way the levelling caps it. Past about three, the ratio
    // is describing a ribbon that is wider than its own corner radius — which
    // a plus-shaped junction is, and which is a flat square of tarmac rather
    // than a ribbon at all.
    const amp = Math.min(3, r / inner);
    const steep = Math.abs(p.grade) * amp;
    if (steep > worstAmp) { worstAmp = steep; worstAt = { r, amp, g: p.grade }; }
  }
  let lo = Infinity, hi = -Infinity;
  for (const p of track.samples) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
  const note = worstAt
    ? `tightest radius ${tightest.toFixed(1)} m, worst inside edge ${(worstAt.g * worstAt.amp * 100).toFixed(1)}% `
      + `from a ${(worstAt.g * 100).toFixed(1)}% centreline at ${worstAt.r.toFixed(1)} m radius (${worstAt.amp.toFixed(2)}x), `
      + `hill ${lo.toFixed(1)}–${hi.toFixed(1)} m`
    : 'flat';
  return note;
}

function checkRacingLine(track) {
  const N = track.line.length;
  let outside = 0, lineLen = 0, roadLen = 0;
  for (let i = 0; i < N; i++) {
    const p = track.line[i], q = track.line[(i + 1) % N];
    const c = track.samples[i], d = track.samples[(i + 1) % N];
    if (Math.abs(p.offset) > track.samples[i].width / 2) outside++;
    lineLen += dist2D(p.x, p.z, q.x, q.z);
    roadLen += dist2D(c.x, c.z, d.x, d.z);
  }

  // What makes a line a racing line is that it apexes.
  //
  // Two earlier measures both said the wrong thing here. Total curvature over
  // the lap punishes a line for easing out across a straight to set up for a
  // junction, which is the correct thing to do and which a grid circuit is
  // nearly all of. Peak curvature punishes it for the transition between one
  // side of the road and the other — and on an 11.6 m street that swing is
  // genuinely tighter than the corner it is setting up for, however well it is
  // driven. Neither says anything about whether the line is any good.
  //
  // What does: at the tightest places on the road, is the line on the inside?
  // That is what apexing IS, it is what makes the corner faster, and it means
  // the same thing on a sweeper and on a right-angle junction.
  const idx = [...track.samples.keys()]
    .sort((a2, b2) => track.samples[b2].curvature - track.samples[a2].curvature)
    .slice(0, Math.max(8, Math.round(N * 0.05)));
  let apexed = 0, depth = 0;
  for (const i of idx) {
    const s2 = track.samples[i];
    // nx is left of travel and bend is +1 for a left-hander, so the inside of
    // the corner is a positive offset on a left and a negative one on a right.
    const inside = track.line[i].offset * s2.bend;
    if (inside > 0.4) apexed++;
    depth += inside / (s2.width / 2);
  }
  const frac = apexed / idx.length;
  const speeds = track.line.map((p) => p.speed);
  const min = Math.min(...speeds), max = Math.max(...speeds);
  // Speeds are metres per second here; the report prints them as km/h.
  const ok = outside === 0 && frac > 0.8 && lineLen < roadLen * 1.02
    && min > 8 && max > 45;
  return `${ok ? 'inside the white lines and apexing' : 'WRONG'} — ` +
    `${outside} points off track, apexes ${apexed}/${idx.length} of the tightest corners ` +
    `at ${(depth / idx.length * 100).toFixed(0)}% of the way to the kerb, ` +
    `${(lineLen / roadLen * 100).toFixed(1)}% of the road's length, ` +
    `${(min * 3.6).toFixed(0)}–${(max * 3.6).toFixed(0)} km/h`;
}

// The side streets at the junctions.
//
// Three things, each of which was wrong at some point.
//
// They are scenery, so the circuit's wall has to run unbroken across the mouth
// of every one. An earlier version opened it so they could be driven into, and
// because a side street's corridor starts at the junction centre — a place the
// circuit itself goes through — cars taking the corner registered as being in
// the side street, lost the wall that keeps them on the road, and were shoved
// by the side street's own walls instead. Twelve of sixteen finished stranded.
//
// They must not stop dead. A street that ends at a wall reads as a piece of
// scenery with an edge; one that Ts into a cross street reads as a street that
// goes somewhere, and the buildings filling in around it hide that the cross
// street stops too.
//
// And the junction has to be a junction: a curb return on every corner, or the
// side street is a strip of tarmac laid beside the circuit rather than joined
// to it.
function checkSideStreets(track) {
  const bad = [];
  let blocked = 0, teed = 0, lit = 0;
  for (const t of track.stubs) {
    // A blockade across the mouth: cones right across it, and a machine parked
    // in it. Concrete used to do this job, and a city does not have concrete
    // poured across every side street — what closes a street is cones, an
    // arrow board and whoever's plant is doing the work.
    let cones = 0, police = 0;
    for (const p of track.props) {
      if (p.kind !== 'cone' && p.kind !== 'plant') continue;
      const dx = p.x - t.x, dz = p.z - t.z;
      const along = dx * t.ux + dz * t.uz;
      if (along < 0 || along > t.len) continue;
      if (Math.abs(dx * -t.uz + dz * t.ux) > t.width / 2 + 4) continue;
      if (p.kind === 'cone') cones++; else police++;
    }
    if (cones >= 5 && police >= 1) blocked++;
    else bad.push(`a mouth with only ${cones} cones and ${police} machines across it`);

    // The bar across the top of the T: road at right angles, out at the end.
    const ex = t.x + t.ux * t.len, ez = t.z + t.uz * t.len;
    if (track.onStubRoad(ex - t.uz * 11, ez + t.ux * 11)
      && track.onStubRoad(ex + t.uz * 11, ez - t.ux * 11)) teed++;
    else if (t.bar) bad.push('a T with no road across it');
  }
  // And the lights actually flash — two materials played against each other,
  // so at any instant one is up and the other is down.
  if (track.beacons) {
    track.update(0.05);
    const a = track.beacons[0].opacity, b2 = track.beacons[1].opacity;
    track.update(0.30);
    const c = track.beacons[0].opacity;
    if (a > b2 && c < a) lit = 1;
    else bad.push('beacons that do not alternate');
  }
  // Every corner must be signed, whether or not it has a side street to hang
  // the board on. The shallow ones have no street — the sign is the part that
  // matters, and losing the street must not lose the sign.
  // And none of them may run alongside the circuit. "Straight on" at a corner
  // continues the leg you arrived down, so at a shallow bend it separates from
  // the course so slowly that it sits a few metres off the kerb for a hundred
  // metres — a second carriageway beside the racing line rather than a fork.
  let hug = Infinity, hugPar = 0;
  for (const t of track.stubs) {
    for (let d = 26; d < t.len; d += 4) {
      const x = t.x + t.ux * d, z = t.z + t.uz * d;
      const loc = track.locate(x, z);
      const gap = Math.abs(loc.lateral) - loc.width / 2;
      if (gap < hug) {
        hug = gap;
        hugPar = Math.abs(t.ux * loc.sample.dirX + t.uz * loc.sample.dirZ);
      }
    }
  }
  if (hug < 16) bad.push(`one running ${hug.toFixed(0)} m off the kerb`);

  // How many corners have a street off them at all — the thing that makes a
  // corner read as a junction rather than as a bend with a sign beside it.
  let withStreet = 0;
  const bare = [];
  for (const c of track.corners) {
    const n = track.stubs.filter((t) => t.corner === c).length;
    if (n) withStreet++;
    else bare.push(`${(c.turn * 57.3).toFixed(0)}°`);
  }
  let signedCorners = 0;
  for (const c of track.corners) {
    const near = track.props.some((p) =>
      p.kind === 'sign' && dist2D(p.x, p.z, c.x, c.z) < 46);
    if (near) signedCorners++;
    else bad.push('a corner with no sign on it');
  }
  const corners = track.returns ? track.returns.length : 0;
  const ok = bad.length === 0 && track.stubs.length >= 8 && lit === 1
    && corners >= track.corners.length * 3;
  return `${ok ? 'every corner signed, coned off and Teeing out at the end'
    : `WRONG — ${bad[0] || `only ${corners} curb returns`}`} — ` +
    `${track.stubs.length} of them, ${blocked} blockaded, ${teed} Teeing into a cross street, ` +
    `${withStreet}/${track.corners.length} corners with a street off them` +
    `${bare.length ? ` (bare at ${bare.join(' ')})` : ''}, ` +
    `${signedCorners} signed, closest runs ${hug.toFixed(0)} m off the kerb ` +
    `at ${hugPar.toFixed(2)} parallel, ${corners} curb returns, ` +
    `beacons ${lit ? 'flashing' : 'DEAD'}`;
}

// Who is driving. The player's name used to be the car's name, so whoever
// picked the white coupe was called GT COUPE; it is typed in on the way to the
// car select now, and has to survive being carried into the race and shown on
// the timing screen.
function checkDriverName(game) {
  const car = game.race.player;
  const was = { name: car.name, livery: game.playerLivery, typed: game.playerName };
  game.playerName = 'ASHWORTH';
  game.setPlayerCar(SELECTABLE[3]);
  const named = car.name === 'ASHWORTH';
  // And with nothing typed it falls back to the car, the way it always was.
  game.playerName = null;
  game.setPlayerCar(SELECTABLE[3]);
  const fell = car.name === SELECTABLE[3].name;
  // Every driver still has a name of their own.
  const names = new Set(game.race.cars.map((c) => c.name));
  const unique = names.size === game.race.cars.length;

  game.playerName = was.typed;
  if (was.livery) game.setPlayerCar(was.livery);
  car.name = was.name;

  const ok = named && fell && unique;
  return `${ok ? 'the player names themselves' : 'WRONG'} — ` +
    `typed name ${named ? 'used' : 'IGNORED'}, ` +
    `blank falls back to the car ${fell ? 'correctly' : 'WRONGLY'}, ` +
    `${names.size}/${game.race.cars.length} names on the grid are distinct`;
}

// Street furniture that gives way.
//
// A lamp post a car passes through is scenery; one that goes over is a place.
// The check is that they exist, that they are separate objects — a merged mesh
// is one object and you cannot tip a single post out of one — and that hitting
// one knocks it flat without stopping the car, which would be worse than
// driving through it.
function checkBreakables(track) {
  const list = track.breakables || [];
  const kinds = {};
  for (const o of list) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
  const bad = [];
  if (list.length < 40) bad.push(`only ${list.length} of them`);
  if (!kinds.sign) bad.push('no direction signs at the blockades');
  if (!kinds.lamp) bad.push('no lamp standards');

  // Knock one over and watch it go.
  const o = list.find((q) => q.kind === 'lamp');
  let fell = 0;
  if (o) {
    track.knock(o, 1, 0);
    if (track.knock(o, 1, 0)) bad.push('one that can be knocked over twice');
    for (let i = 0; i < 40; i++) track.update(i * 0.02, 0.02);
    fell = Math.abs(o.mesh.rotation.x) + Math.abs(o.mesh.rotation.z);
    if (fell < 1.3) bad.push(`one that only fell ${fell.toFixed(2)} rad`);
    o.axis = null; o.fall = 0; o.mesh.rotation.set(0, 0, 0);
  }
  const ok = bad.length === 0;
  return `${ok ? 'it gives way' : `WRONG — ${bad[0]}`} — ` +
    `${list.length} things you can knock over ` +
    `(${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}), ` +
    `falls ${(fell * 57.3).toFixed(0)}°`;
}

// The city itself: no building inside another one, and none of them standing
// on a road.
//
// Both were happening. Every placement pass ran in ignorance of the ones
// before it, so buildings grew through each other — and the first attempt to
// stop it used bounding circles, which for a long thin building either lets
// the ends overlap or refuses everything that would sit beside it, which is
// where the holes in the terrace came from. And the side streets were laid
// after the buildings, so buildings sat in the middle of them.
function checkCity(track) {
  const all = track.props.filter((p) => p.kind === 'building' && p.w);
  const corners = (b) => {
    const c = Math.cos(b.ry), s2 = Math.sin(b.ry);
    const hw = b.w / 2, hd = b.d / 2;
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => ({
      x: b.x + u * c + v * s2, z: b.z - u * s2 + v * c,
    }));
  };
  const overlap = (A, B) => {
    for (const box of [A, B]) {
      const c = Math.cos(box.ry), s2 = Math.sin(box.ry);
      for (const ax of [{ x: c, z: -s2 }, { x: s2, z: c }]) {
        let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
        for (const q of corners(A)) {
          const d = q.x * ax.x + q.z * ax.z;
          aMin = Math.min(aMin, d); aMax = Math.max(aMax, d);
        }
        for (const q of corners(B)) {
          const d = q.x * ax.x + q.z * ax.z;
          bMin = Math.min(bMin, d); bMax = Math.max(bMax, d);
        }
        // A metre of mutual intrusion is a shared party wall, not a fault.
        if (aMax < bMin + 1.0 || bMax < aMin + 1.0) return false;
      }
    }
    return true;
  };

  let intersecting = 0, worst = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const A = all[i], B = all[j];
      const d = dist2D(A.x, A.z, B.x, B.z);
      if (d > A.r + B.r) continue;                 // cannot possibly touch
      if (overlap(A, B)) { intersecting++; worst = Math.max(worst, A.r + B.r - d); }
    }
  }

  // And on the tarmac. Sampled across the footprint, because a building can
  // straddle a road without any of its corners being on one.
  let onRoad = 0;
  for (const b of all) {
    const c = Math.cos(b.ry), s2 = Math.sin(b.ry);
    let hit = false;
    for (let u = -2; u <= 2 && !hit; u++) {
      for (let v = -2; v <= 2 && !hit; v++) {
        const lu = (u / 4) * b.w, lv = (v / 4) * b.d;
        if (track.onAnyRoad(b.x + lu * c + lv * s2, b.z - lu * s2 + lv * c)) hit = true;
      }
    }
    if (hit) onRoad++;
  }

  const ok = intersecting === 0 && onRoad === 0 && all.length > 400;
  return `${ok ? 'built solid — nothing inside anything else, nothing on a road'
    : `WRONG — ${intersecting} buildings intersect (worst ${worst.toFixed(1)} m), ${onRoad} on a road`} — ` +
    `${all.length} buildings`;
}

// Nothing beside the circuit may stand on it, or in the run-off beside it.
//
// This has to include the barriers themselves, and originally did not, which is
// how a stretch of armco ended up laid across the road: the ground nine metres
// outside one corner is the racing surface of the next one along, and a fence
// built there is a fence nothing collides with, because the collision boundary
// is a distance from whichever stretch of track is nearest rather than from the
// mesh. It was a fence you drove through.
function checkClearance(track) {
  const barrier = track.barrierOffset;
  const bad = [];
  const counts = {};
  for (const prop of track.props) {
    counts[prop.kind] = (counts[prop.kind] || 0) + 1;
    const loc = track.locate(prop.x, prop.z);
    const clear = Math.abs(loc.lateral) - loc.width / 2 - prop.r;
    // A tree wants the full run-off behind it; a barrier and a marshal's post
    // stand at the edge of it, which is their job.
    const need = prop.kind === 'tree' ? barrier : barrier - 1.5;
    if (clear < need) bad.push(`${prop.kind} ${clear.toFixed(1)} m from the track`);
  }
  const tally = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
  return bad.length
    ? `ON THE CIRCUIT — ${bad.length} of ${track.props.length}: ${bad.slice(0, 3).join(', ')}`
    : `nothing on the road — ${tally}, all clear of every stretch`;
}

// Every grid slot has to be on the track, behind the line, and clear of the
// car in front of it.
function checkGrid(track) {
  const bad = [];
  for (let i = 0; i < track.gridSlots.length; i++) {
    const g = track.gridSlots[i];
    const loc = track.locate(g.x, g.z);
    if (Math.abs(loc.lateral) > loc.width / 2 - 0.9) bad.push(`slot ${i + 1} off track`);
    for (let j = i + 1; j < track.gridSlots.length; j++) {
      const h = track.gridSlots[j];
      if (dist2D(g.x, g.z, h.x, h.z) < 4.4) bad.push(`slots ${i + 1}/${j + 1} overlap`);
    }
  }
  return bad.length ? `PROBLEMS — ${bad.slice(0, 4).join(', ')}`
    : `${track.gridSlots.length} slots, all on track and clear of each other`;
}

// ------------------------------------------------------------- the race

// Run the whole race as fast as the machine will do it.
function fastForward(game, maxSeconds = 400) {
  const race = game.race;
  let t = 0;
  const guard = Math.round(maxSeconds / FIXED);
  for (let i = 0; i < guard; i++) {
    race.update(FIXED);
    t += FIXED;
    if (race.state === 'finished') break;
    // Once the leader is home the tail-enders are not interesting.
    if (race.cars.every((c) => c.finished)) break;
  }
  return t;
}

function checkRace(game) {
  const race = game.race;
  const notes = [];
  // Give the player to a driver so the whole field is racing.
  const player = race.player;
  const hadDriver = player.driver;
  player.driver = new Driver(player, race.track, 0.9);
  player.vehicle.autoShift = true;
  race.gridUp();
  race.state = 'racing';
  race.countdown = 0;
  for (const c of race.cars) c.lapStart = 0;

  const t = fastForward(game);
  const finished = race.cars.filter((c) => c.finished);
  const laps = race.cars.map((c) => c.lap);
  const best = Math.min(...race.cars.map((c) => c.bestLap));
  const worstBest = Math.max(...race.cars.filter((c) => isFinite(c.bestLap)).map((c) => c.bestLap));

  notes.push(`${finished.length}/${race.cars.length} finished in ${t.toFixed(0)}s of racing`);
  notes.push(laps.every((l) => l > RACE.laps)
    ? `all took the flag after ${RACE.laps} laps`
    : `ONLY ${Math.max(0, Math.min(...laps) - 1)} LAPS BY THE SLOWEST`);
  notes.push(isFinite(best) ? `best lap ${lapTime(best)}, slowest driver's best ${lapTime(worstBest)}`
    : 'NO LAP TIMES');

  // The order must be a genuine order: no ties, and it must agree with the
  // finishing times.
  const order = race.order;
  let sane = true;
  for (let i = 1; i < order.length; i++) {
    if (order[i - 1].finished && order[i].finished &&
        order[i - 1].finishTime > order[i].finishTime) sane = false;
  }
  notes.push(sane ? 'classified in finishing order' : 'ORDER DISAGREES WITH THE TIMES');

  // Nobody should have got stuck or gone the wrong way round.
  const stuck = race.cars.filter((c) => c.lap <= RACE.laps);
  notes.push(stuck.length === 0 ? 'nobody stranded'
    : `STRANDED: ${stuck.map((c) => c.name).join(', ')}`);

  player.driver = hadDriver;
  return notes.join(', ');
}

// The AI has to be able to lap the circuit without help, cleanly and at a
// sensible speed. One car, one lap, nothing else on track.
function checkAiLap(game) {
  const race = game.race;
  const car = race.cars[0];
  const saved = { x: car.vehicle.x, z: car.vehicle.z, yaw: car.vehicle.yaw };
  const driver = car.driver || new Driver(car, race.track, 0.95);
  const start = race.track.atDistance(4);
  car.vehicle.reset(start.x, start.z, Math.atan2(start.dirX, start.dirZ));
  car.vehicle.setSpeed(30);
  car.loc = race.track.locate(car.vehicle.x, car.vehicle.z);

  let t = 0, offTrack = 0, minSpeed = 999, maxSpeed = 0;
  const excursions = [];
  const solo = [car];
  const guard = Math.round(140 / FIXED);
  let lapDone = 0;
  let lastS = car.loc.s;
  for (let i = 0; i < guard; i++) {
    driver.drive(FIXED, solo);
    car.vehicle.update(FIXED, 2);
    const loc = race.track.locate(car.vehicle.x, car.vehicle.z, car.loc.index);
    car.loc = loc;
    const over = Math.abs(loc.lateral) - loc.width / 2;
    car.vehicle.surfaceGrip = over <= 0 ? 1 : over < 1.6 ? 0.92 : 0.55;
    if (over > 2.0) {
      offTrack += FIXED;
      // Note where it went off, so a failure says which corner rather than
      // just that there was one.
      const at = Math.round(loc.s / 50) * 50;
      if (!excursions.includes(at)) excursions.push(at);
    }
    minSpeed = Math.min(minSpeed, car.vehicle.speedKmh);
    maxSpeed = Math.max(maxSpeed, car.vehicle.speedKmh);
    t += FIXED;
    if (lastS > race.track.length * 0.75 && loc.s < race.track.length * 0.25) { lapDone = t; break; }
    lastS = loc.s;
  }
  car.vehicle.reset(saved.x, saved.z, saved.yaw);
  const ok = lapDone > 20 && lapDone < 120 && offTrack < 2 && minSpeed > 25;
  return `${ok ? 'laps it cleanly' : 'STRUGGLES'} — ${lapDone ? lapTime(lapDone) : 'NO LAP'}, ` +
    `${offTrack.toFixed(1)}s off track${excursions.length ? ` at ${excursions.slice(0, 6).join('/')} m` : ''}, ` +
    `${minSpeed.toFixed(0)}–${maxSpeed.toFixed(0)} km/h`;
}

// ------------------------------------------------------------ collisions

// Two cars driven into each other must end up apart, still on the map, and
// having lost rather than gained energy.
function checkCollision(game) {
  const race = game.race;
  const A = race.cars[0], B = race.cars[1];
  const saved = race.cars.map((c) => ({ x: c.vehicle.x, z: c.vehicle.z, yaw: c.vehicle.yaw }));
  race.cars.forEach((c, i) => { if (i > 1) c.vehicle.reset(2000 + i * 20, 2000, 0); });

  const speedOf = (car) => car.vehicle.speed;

  // --- cars pass through each other. Drive a fast one straight through a slow
  // one and neither should feel a thing: same speed out as in, and at some
  // point they should have been in the same place at the same time.
  const p = race.track.atDistance(60);
  const yaw = Math.atan2(p.dirX, p.dirZ);
  A.vehicle.reset(p.x, p.z, yaw);
  B.vehicle.reset(p.x + p.dirX * 9, p.z + p.dirZ * 9, yaw);
  A.vehicle.setSpeed(42);
  B.vehicle.setSpeed(22);
  A.loc = race.track.locate(A.vehicle.x, A.vehicle.z);
  B.loc = race.track.locate(B.vehicle.x, B.vehicle.z);
  const wasA = speedOf(A), wasB = speedOf(B);

  // A control run first: the same car, from the same speed, over the same
  // time, with nothing else anywhere near it. What it loses is drag and
  // rolling resistance, and the pair below must lose the same — comparing
  // against a fixed number instead means the test fails whenever the
  // aerodynamics or the tyres are retuned, which has nothing to do with
  // whether two cars pass through each other.
  const solo = () => {
    const v = new Vehicle(CAR);
    v.reset(p.x, p.z, yaw);
    v.surfaceGrip = 1;
    v.setSpeed(42);
    for (let i = 0; i < Math.round(2.0 / FIXED); i++) { v.throttle = 0; v.update(FIXED, 2); }
    return 42 - v.speed;
  };
  const coasting = solo();

  let closest = Infinity;
  for (let i = 0; i < Math.round(2.0 / FIXED); i++) {
    A.vehicle.throttle = 0; B.vehicle.throttle = 0;
    A.vehicle.update(FIXED, 2); B.vehicle.update(FIXED, 2);
    A.loc = race.track.locate(A.vehicle.x, A.vehicle.z, A.loc.index);
    B.loc = race.track.locate(B.vehicle.x, B.vehicle.z, B.loc.index);
    closest = Math.min(closest, dist2D(A.vehicle.x, A.vehicle.z, B.vehicle.x, B.vehicle.z));
  }
  const lostA = wasA - speedOf(A), lostB = wasB - speedOf(B);
  const overlapped = closest < 1.5;
  // Within a tenth of a metre per second of coasting alone, for the car that
  // drove through, and no shove at all for the one it drove through.
  const untouched = Math.abs(lostA - coasting) < 0.1 && speedOf(B) <= wasB + 0.05;

  // --- but the edge of the course is still solid.
  const q = race.track.atDistance(200);
  const C = race.cars[2];
  C.vehicle.reset(q.x, q.z, Math.atan2(q.nx, q.nz));      // pointing at the wall
  C.vehicle.setSpeed(40);
  C.loc = race.track.locate(C.vehicle.x, C.vehicle.z);
  for (let i = 0; i < Math.round(3 / FIXED); i++) {
    C.vehicle.update(FIXED, 2);
    C.loc = race.track.locate(C.vehicle.x, C.vehicle.z, C.loc.index);
    race._barriers();
  }
  // Against `wall`, not `barrierOffset`. There are no barriers any more — the
  // thing that stops a car is the building line, and `barrierOffset` is now
  // only where the scenery gets placed.
  const held = Math.abs(C.loc.lateral) <= C.loc.width / 2 + race.track.wall + 0.3;

  race.cars.forEach((c, i) => c.vehicle.reset(saved[i].x, saved[i].z, saved[i].yaw));
  const ok = overlapped && untouched && held;
  return `${ok ? 'cars phase through, the building line does not' : 'WRONG'} — ` +
    `the two overlapped to ${closest.toFixed(1)} m apart; the one that drove ` +
    `through lost ${lostA.toFixed(2)} m/s against ${coasting.toFixed(2)} coasting ` +
    `alone, and the one it drove through lost ${lostB.toFixed(2)}; ` +
    `edge of the course ${held ? 'held' : 'LEAKED'}`;
}

// Running wide has to cost something.
function checkSurface(game) {
  const track = game.track;
  const p = track.atDistance(300);
  const on = track.locate(p.x, p.z);
  const off = track.locate(p.x + p.nx * (p.width / 2 + 4), p.z + p.nz * (p.width / 2 + 4));
  return `${!on.onTrack || off.onTrack ? 'WRONG' : 'the verge is slower'} — ` +
    `on the road at ${on.lateral.toFixed(1)} m, off it at ${off.lateral.toFixed(1)} m of ` +
    `${(off.width / 2).toFixed(1)} m half-width`;
}

// ------------------------------------------------------------------- HUD

// The dashboard is the part of the game the player actually looks at, and the
// results table is the last thing they see, so both are checked rather than
// assumed. This drives the HUD through the states it has to survive — on the
// grid, mid-race, and after the flag — and reads back what it wrote.
function checkHud(game) {
  const hud = game.hud;
  const race = game.race;
  const notes = [];
  const el = (id) => document.getElementById(id);

  hud.update(1 / 60);
  const gear = el('gear').textContent;
  const speed = Number(el('speed').textContent);
  notes.push(/^[RN1-6]$/.test(gear) ? `gear reads "${gear}"` : `GEAR READS "${gear}"`);
  notes.push(Number.isFinite(speed) ? `speed reads ${speed} km/h` : 'SPEED IS NOT A NUMBER');
  notes.push(/^\d+\/16$/.test(el('pos-v').textContent)
    ? `position reads ${el('pos-v').textContent}` : 'POSITION MALFORMED');

  // The rev counter and the map are canvases: check they actually drew, by
  // looking for a pixel that is not the background.
  const drew = (id) => {
    const c = el(id);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
    return false;
  };
  notes.push(drew('tacho-c') ? 'tacho drawn' : 'TACHO BLANK');
  notes.push(drew('map-c') ? 'map drawn' : 'MAP BLANK');

  // The order list has a row per car it is showing, and yours is marked.
  const rows = el('standings-rows').children.length;
  hud.showAll = true;
  hud.update(1 / 60);
  const all = el('standings-rows').children.length;
  hud.showAll = false;
  notes.push(all === RACE.cars && rows > 0 && rows <= RACE.cars
    ? `order lists ${rows} of ${all}` : `ORDER LISTS ${rows}/${all}`);

  // And the results table, which nothing else exercises until the flag falls.
  hud.results(race);
  const res = el('results-rows').children.length;
  hud.hideResults();
  notes.push(res === RACE.cars ? `results table has all ${res}` : `RESULTS TABLE HAS ${res}`);
  return notes.join(', ');
}

// ------------------------------------------------------------- the run

function assertions(game) {
  const track = game.track;
  return [
    `track          ${checkTrack(track)}`,
    `corner grade   ${checkCornerGrade(track)}`,
    `racing line    ${checkRacingLine(track)}`,
    `grid           ${checkGrid(track)}`,
    `clearance      ${checkClearance(track)}`,
    `side streets   ${checkSideStreets(track)}`,
    `city           ${checkCity(track)}`,
    `street         ${checkBreakables(track)}`,
    `driver         ${checkDriverName(game)}`,
    `acceleration   ${checkAcceleration()}`,
    `braking        ${checkBraking()}`,
    `brake balance  ${checkBrakeStability()}`,
    `gearbox        ${checkGearbox()}`,
    `neutral        ${checkNoNeutral()}`,
    `cornering      ${checkCornering()}`,
    `held turn      ${checkHeldTurn()}`,
    `steering       ${checkSteering(game)}`,
    `steering feel  ${checkSteeringWeight()}`,
    `handbrake      ${checkHandbrakeDrift()}`,
    `weight         ${checkWeightTransfer()}`,
    `surface        ${checkSurface(game)}`,
    `phasing        ${checkCollision(game)}`,
    `ai lap         ${checkAiLap(game)}`,
    `full race      ${checkRace(game)}`,
    `hud            ${checkHud(game)}`,
  ];
}

export function runSelfTest(game, seconds) {
  const errors = [...(window.__errors || [])];
  window.addEventListener('error', (e) => errors.push(`${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => errors.push(`promise: ${e.reason}`));

  game.begin();
  // Drive the player for the live part of the run, so the frame-rate numbers
  // are measured with sixteen cars actually racing.
  const player = game.race.player;
  player.driver = new Driver(player, game.track, 0.93);
  player.vehicle.autoShift = true;

  const stats = { frames: 0, dt: 0, worst: 0, laps: 0 };
  const realLap = game.onLap.bind(game);
  // Only count timed laps: the first crossing is the start of lap one, not the
  // end of a lap, so counting it would report sixteen laps in the first minute.
  game.onLap = (car, lap, ...rest) => { if (lap > 1) stats.laps++; return realLap(car, lap, ...rest); };

  const realUpdate = game.update.bind(game);
  game.update = (dt) => {
    realUpdate(dt);
    stats.frames++;
    stats.dt += dt;
    if (dt > stats.worst) stats.worst = dt;
  };

  setTimeout(() => {
    const race = game.race;
    const fps = stats.frames / Math.max(0.001, stats.dt);
    // Snapshot the live race before the assertions restart it.
    const live = [
      `duration       ${seconds}s, ${stats.frames} frames, ${fps.toFixed(1)} fps ` +
        `(worst frame ${(stats.worst * 1000).toFixed(0)}ms)`,
      `race           ${race.state}, leader on lap ${race.leader.lap + 1}/${RACE.laps}, ` +
        `player ${race.player.position}/${RACE.cars}`,
      `activity       ${stats.laps} timed laps by the field`,
      `player         ${race.player.speedKmh.toFixed(0)} km/h in gear ` +
        `${race.player.vehicle.gear}, best lap ${lapTime(race.player.bestLap)}`,
    ];

    const lines = [
      'REDLINE — SMOKE TEST',
      ...live,
      '',
      ...assertions(game),
      '',
      `errors         ${errors.length ? errors.slice(0, 6).join(' | ') : 'none'}`,
    ];
    const text = lines.join('\n');
    console.log(text);
    post('/__result', text);

    if (new URLSearchParams(location.search).has('dump')) {
      try { dumpFrames(game); } catch (e) { post('/__result', `\nframe dump failed: ${e.message}`); }
    }
  }, seconds * 1000);
}

// Pictures of the thing, taken from the places worth looking from.
function dumpFrames(game) {
  const cam = game.camera;
  const c = game.renderer.domElement;
  const track = game.track;
  const dump = [];
  const shot = (name, from, at, fov = 60) => {
    cam.fov = fov;
    cam.position.set(from[0], from[1], from[2]);
    cam.up.set(0, 1, 0);
    cam.lookAt(at[0], at[1], at[2]);
    cam.updateProjectionMatrix();
    game.post.render(game.scene, cam);
    post(`/__frame/${name}`, c.toDataURL('image/png'));
  };

  // The title-screen cutscene, which is the first thing anyone sees: one car,
  // close up, with the rest of the field hidden because cars phase through
  // each other and that shows at this distance.
  try {
    const wasStarted = game.started;
    game.started = false;
    game._attracting = false;
    // One frame from each of the five shots, so a camera that ends up inside
    // the bodywork on any of them is visible in the dump.
    for (let sh = 0; sh < 5; sh++) {
      game.chase._shot = -1;
      game.time = sh * 4.6 + 2.3;
      for (let i = 0; i < 40; i++) game._attract(1 / 60);
      game.post.render(game.scene, game.camera);
      post(`/__frame/cutscene${sh}`, c.toDataURL('image/png'));
    }
    const shown = game.race.cars.filter((q) => q.model.visible).length;
    game._endAttract();
    game.started = wasStarted;
    if (shown !== 1) console.log(`cutscene shows ${shown} cars`);
  } catch (e) { console.log(`cutscene dump failed: ${e.message}`); }

  // The car-select carousel, which is the first thing anyone sees. Driven
  // directly rather than through openSelect(), which refuses once the race has
  // started — and the race has, because the test began it in order to run.
  try {
    game.select.active = true;
    game.select.index = 1;
    game.select.slide = 0;
    for (let i = 0; i < 120; i++) game.select.update(1 / 60, cam.aspect);
    game.post.render(game.select.scene, game.select.camera);
    post('/__frame/select', c.toDataURL('image/png'));
    game.select.active = false;
  } catch (e) { console.log(`select dump failed: ${e.message}`); }

  // The circuit from above.
  // The aerial diagnostics look through 700 m of night air, which the fog
  // turns into a flat brown card. Lift it for these two shots only.
  const fog = game.scene.fog;
  game.scene.fog = null;
  shot('circuit', [0, 700, 40], [0, 0, 0], 52);
  game.scene.fog = fog;

  // The grid, from behind and above the back row, looking up the rows. Every
  // one of these has to be taken relative to the local elevation: the circuit
  // climbs eight metres, so a camera at a fixed height ends up underground at
  // one end of it and in the clouds at the other.
  const back = track.gridSlots[15];
  const front = track.gridSlots[0];
  shot('grid', [back.x - Math.sin(back.yaw) * 16, back.y + 6.0, back.z - Math.cos(back.yaw) * 16],
    [front.x, front.y + 0.8, front.z], 40);

  // And the race itself: the leader, from alongside.
  const lead = game.race.order ? game.race.order[0] : game.race.cars[0];
  const lv = lead.vehicle;
  const ly = lead.loc ? lead.loc.y : 0;
  shot('racing', [lv.x - Math.sin(lv.yaw) * 14 + Math.cos(lv.yaw) * 9, ly + 4.0,
    lv.z - Math.cos(lv.yaw) * 14 - Math.sin(lv.yaw) * 9], [lv.x, ly + 0.8, lv.z], 48);

  // Down the main straight, and into the first corner.
  const s0 = track.atDistance(20);
  shot('straight', [s0.x - s0.dirX * 12, s0.y + 3.6, s0.z - s0.dirZ * 12],
    [s0.x + s0.dirX * 90, s0.y + 1.5, s0.z + s0.dirZ * 90], 58);
  // The climb, which is the signature of this circuit and the thing most
  // likely to look wrong: ground poking through the road, or cars sitting
  // level on an eight per cent grade.
  const hill = track.atDistance(track.length * 0.40);
  shot('hill', [hill.x - hill.dirX * 34 - hill.nx * 12, hill.y + 9, hill.z - hill.dirZ * 34 - hill.nz * 12],
    [hill.x + hill.dirX * 40, hill.y + 2, hill.z + hill.dirZ * 40], 55);

  // The arrow board at a blockade, from where a driver arriving at the corner
  // would see it: down the street it faces, at eye height.
  {
    const sign = track.props.find((q) => q.kind === 'sign');
    if (sign) {
      const t = track.stubs.find((q) =>
        q.ahead && dist2D(q.x + q.ux * 40, q.z + q.uz * 40, sign.x, sign.z) < 60);
      if (t) {
        const y = track.locate(t.x, t.z).y;
        // Offset to one side: head-on, the arrow board stands in front of the
        // machine and hides it.
        shot('sign', [t.x - t.ux * 15 - t.uz * 13, y + 3.4, t.z - t.uz * 15 + t.ux * 13],
          [sign.x + t.ux * 5, y + 2.2, sign.z + t.uz * 5], 44);
      }
    }
  }

  // Straight down the longest side street from the circuit — which is the
  // view that shows whatever is standing behind it.
  {
    const t = track.stubs.reduce((best, q) => (q.len > best.len ? q : best), track.stubs[0]);
    const y = track.locate(t.x, t.z).y;
    shot('down-stub', [t.x - t.ux * 18, y + 2.2, t.z - t.uz * 18],
      [t.x + t.ux * 200, y + 34, t.z + t.uz * 200], 50);
  }

  // The far end of a side street, where it Ts into a cross street. What is
  // built around that T is what sells the illusion that the street goes on.
  {
    const t = track.stubs.reduce((best, q) => (q.len > best.len ? q : best), track.stubs[0]);
    const ex = t.x + t.ux * t.len, ez = t.z + t.uz * t.len;
    const y = track.locate(ex, ez).y;
    shot('stub-end', [ex - t.ux * 46, y + 4, ez - t.uz * 46], [ex, y + 6, ez], 48);
  }

  // A shallow corner — one with no side street, so its arrow board stands on
  // its own on the outside of the turn.
  {
    const c = track.corners.reduce((best, q) =>
      Math.abs(q.turn) < Math.abs(best.turn) ? q : best, track.corners[0]);
    const y = track.locate(c.x, c.z).y;
    shot('shallow', [c.x - c.u1x * 26, y + 2.2, c.z - c.u1z * 26],
      [c.x + c.u1x * 10, y + 1.6, c.z + c.u1z * 10], 52);
    // Which way it turns, so the arrow in the picture can be checked against
    // it rather than guessed at. Worth stating that left-of-travel renders on
    // the RIGHT of the screen here: the body frame has +x as the car's left,
    // so the visual sense is mirrored from what you would first assume, and
    // that is exactly the sort of thing to get an arrow pointing backwards.
    dump.push(`shallow corner turns ${c.turn > 0 ? 'left' : 'right'} `
      + `${(Math.abs(c.turn) * 57.3).toFixed(0)}°`);
  }

  // A junction, from far enough back down the street to see all four arms of
  // it — two the circuit uses and two walled off.
  if (track.corners && track.corners.length > 2) {
    const j = track.corners[2];
    const y = track.locate(j.x, j.z).y;
    // Above the rooflines: at street level the camera stands inside whatever
    // block is behind it, now that the blocks are built.
    shot('junction',
      [j.x - j.u1x * 60, y + 42, j.z - j.u1z * 60],
      [j.x + j.u1x * 14, y + 1.5, j.z + j.u1z * 14], 60);
  }

  // The bridge, from the circuit looking out across the water.
  {
    const bx = -560, bz = 330;
    const from = track.samples.reduce((best, p) =>
      dist2D(p.x, p.z, bx, bz) < dist2D(best.x, best.z, bx, bz) ? p : best, track.samples[0]);
    shot('bridge', [from.x, from.y + 26, from.z], [bx, 60, bz], 46);
  }

  const t1 = track.atDistance(track.length * 0.14);
  shot('turn-one', [t1.x + t1.nx * 26, t1.y + 11, t1.z + t1.nz * 26], [t1.x, t1.y + 0.6, t1.z], 55);

  // A car, close up, and the chase view the player actually uses.
  const p = game.race.player.vehicle;
  const py = game.race.player.loc ? game.race.player.loc.y : 0;
  shot('car', [p.x + 5.4, py + 1.7, p.z + 5.0], [p.x, py + 0.65, p.z], 42);
  game.chase.started = false;
  game.chase.update(0.016, game.race.player);
  game.post.render(game.scene, cam);
  post('/__frame/chase', c.toDataURL('image/png'));

  // The two views that put the camera inside the car, which is where the
  // windscreen is either a window or a wall.
  for (const want of ['BONNET', 'COCKPIT']) {
    while (game.chase.name !== want) game.chase.cycle();
    game.chase.started = false;
    game.chase.update(0.016, game.race.player);
    game.post.render(game.scene, cam);
    post(`/__frame/${want.toLowerCase()}`, c.toDataURL('image/png'));
  }
  while (game.chase.name !== 'CHASE') game.chase.cycle();

  // And the racing line, drawn over the circuit from above.
  const line = new THREE.BufferGeometry().setFromPoints(
    track.line.map((q) => new THREE.Vector3(q.x, q.y + 0.4, q.z)),
  );
  const mesh = new THREE.LineLoop(line, new THREE.LineBasicMaterial({ color: 0xff3a2a }));
  game.scene.add(mesh);
  game.scene.fog = null;
  shot('racing-line', [0, 700, 40], [0, 0, 0], 52);
  game.scene.fog = fog;
  game.scene.remove(mesh);
  void clamp; void AI; void Track; void CAR;
}
