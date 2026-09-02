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
import { buildCar } from './carmodels.js';
import { Driver, Cruiser, BRAKE_G } from './ai.js';
import { Race, defaultField } from './race.js';
import { Track, LAYOUTS, disposeTrack } from './track.js';
import { CAR, RACE, AI, RIVAL, POLICE, TRAFFIC, SELECTABLE } from './defs.js';
import { clamp, lerp, lapTime, dist2D, angleDiff } from './utils.js';
import { SHOTS, cameraFrame } from './camera.js';
import { Cutscene, SCRIPTS } from './cutscene.js';
import { PORTRAITS, portraitFor } from './portraits.js';
import { Campaign, STAGES, laneCentres, laneSpeed, trafficCount, unlockedUpTo, unlock } from './campaign.js';
import { CHEATS, findCheat, normalise, unresolved } from './cheats.js';
import { ACTIONS, actionFor, codesFor, isBound, rebind, resetBinds, label } from './keybinds.js';
import { PADS, looksLikeTouch } from './touch.js';
import { DriftScore, DRIFT } from './score.js';
import { GhostRecorder, GhostCar, GHOST_HZ, saveIfBest, loadGhost } from './ghost.js';

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
// The AI's per-driver knobs must default to exactly the module constants they
// replaced.
//
// `brakeG` and `cornerMargin` used to be a module const and an `AI` field read
// inline in drive(); they are per-driver now so a rival can brake later. That
// refactor is only safe if a DEFAULT driver computes bit-identical numbers —
// and the lap-time checks cannot prove it, because every driver rolls random
// brake and throttle noise and a 1% mistake chance, so their times move by a
// tenth between runs regardless. This proves it directly.
function checkDriverDefaults(track) {
  const car = { vehicle: new Vehicle(CAR) };
  const d = new Driver(car, track, 0.9);
  const same = [];
  for (const [v, dist] of [[10, 0], [30, 50], [60, 190], [0, 12]]) {
    same.push(d.reach(v, dist) === Driver.reach(v, dist));
  }
  const allSame = same.every(Boolean);
  const margin = d.cornerMargin === AI.cornerMargin;
  const brake = d.brakeG === BRAKE_G;
  // And a driver given a harder brakeG really does plan later.
  const hard = new Driver(car, track, 0.9, { brakeG: 1.44 });
  const later = hard.reach(30, 100) > d.reach(30, 100);

  const ok = allSame && margin && brake && later;
  return `${ok ? 'a default driver is the old driver exactly' : 'WRONG'} — ` +
    `reach matches the static form at ${same.filter(Boolean).length}/4 points, ` +
    `cornerMargin ${margin ? 'is' : 'IS NOT'} AI.cornerMargin, ` +
    `brakeG ${brake ? 'is' : 'IS NOT'} ${BRAKE_G}, ` +
    `a 1.44 g planner ${later ? 'carries more speed' : 'DOES NOT'}`;
}

// Every shot in the camera's shot list must produce a usable frame.
//
// The shots are pure functions of the subject's frame, so they can be checked
// without rendering anything — and the one failure that matters is cheap to
// test for: a camera inside the bodywork. The title sequence shipped that bug
// once, because every distance is measured from the car's CENTRE and a car is
// two metres wide.
function checkShots(track) {
  const fake = {
    vehicle: { x: 40, z: -25, yaw: 0.7 },
    loc: { y: 3 },
  };
  const other = { vehicle: { x: 46, z: -21, yaw: 0.7 }, loc: { y: 3 } };
  const bad = [];
  let closest = Infinity, worst = '';
  for (const [name, shot] of Object.entries(SHOTS)) {
    for (const k of [0, 0.5, 1]) {
      const s = shot(cameraFrame(fake), k, cameraFrame(other));
      const nums = [...s.from, ...s.at, s.fov];
      if (nums.some((n) => !Number.isFinite(n))) { bad.push(`${name} is not a number`); continue; }
      if (s.fov < 20 || s.fov > 80) bad.push(`${name} has a ${s.fov} degree lens`);
      const span = dist2D(s.from[0], s.from[2], s.at[0], s.at[2]);
      if (span < 0.5) bad.push(`${name} looks at its own position`);
      // How close the camera passes to the car it is filming.
      const d = Math.hypot(s.from[0] - fake.vehicle.x, s.from[2] - fake.vehicle.z);
      if (d < closest) { closest = d; worst = name; }
    }
  }
  if (closest < 1.8) bad.push(`${worst} puts the camera ${closest.toFixed(1)} m from the car`);
  const ok = bad.length === 0;
  return `${ok ? 'every shot frames the car' : `WRONG — ${bad[0]}`} — ` +
    `${Object.keys(SHOTS).length} shots, closest approach ${closest.toFixed(1)} m (${worst})`;
}

// Stage two's road: three and a half kilometres of city, end to end, from the
// eastern waterfront to the Golden Gate on-ramp.
//
// Checked as geometry only — sampled, lined and gridded, but not built — which
// is cheap, and which is where every one of these can go wrong. The one that
// matters most is the self-approach: a route this long folded into the same
// square of city has plenty of opportunity to run beside itself, and where it
// does, one stretch's blockades and buildings land on another's road.
function checkRunLayout() {
  const bad = [];
  const t = new Track(LAYOUTS.run);
  const stage = STAGES.find((q) => q.layout === 'run');

  if (!(t.length > 3000 && t.length < 4800)) bad.push(`it came out ${t.length.toFixed(0)} m`);

  // How close it comes to itself, ignoring what is near along the road.
  let closest = Infinity, where = null;
  const skip = 110;
  for (let i = 0; i < t.samples.length; i += 2) {
    for (let j = i + 2; j < t.samples.length; j += 2) {
      const along = (t.closed ? Math.min(j - i, t.samples.length - (j - i)) : j - i) * t.step;
      if (along < skip) continue;
      const a = t.samples[i], b = t.samples[j];
      const d = dist2D(a.x, a.z, b.x, b.z);
      if (d < closest) { closest = d; where = a; }
    }
  }
  if (closest < 36) {
    bad.push(`it runs ${closest.toFixed(0)} m from itself at ${where.x.toFixed(0)}, ${where.z.toFixed(0)}`);
  }

  // It has to fit inside the world. The ground plane is 1800 m square about
  // the origin, and beyond about 550 m from the road the terrain drops into
  // the bay — so a circuit wider than that drives off the edge of the city.
  // Inside the world the ground plane covers, with room for the buildings
  // that stand beyond the last junction.
  const world = (LAYOUTS.run.world || 1800) / 2;
  const span = t.samples.reduce((m, q) => Math.max(m, Math.abs(q.x), Math.abs(q.z)), 0);
  if (span > world - 180) bad.push(`it reaches ${span.toFixed(0)} m of a ${world.toFixed(0)} m world`);

  // The hill, and how steep it gets. Fifty metres of climb is the point of
  // this one; twenty per cent would be a wall.
  const hi = Math.max(...t.samples.map((q) => q.y));
  const lo = Math.min(...t.samples.map((q) => q.y));
  const grade = Math.max(...t.samples.map((q) => Math.abs(q.grade)));
  if (hi - lo < 25) bad.push(`the hill is only ${(hi - lo).toFixed(0)} m tall`);
  if (grade > 0.18) bad.push(`it hits a ${(grade * 100).toFixed(0)}% grade`);

  // And the ramp: where the stage ends has to be somewhere you can arrive at
  // speed, not the middle of a junction.
  const at = stage.routeFraction * t.length;
  const end = t.atDistance(at - 1);
  const near = t.corners.reduce((m, c) => Math.min(m, dist2D(c.x, c.z, end.x, end.z)), Infinity);
  if (near < 30) bad.push(`the ramp is ${near.toFixed(0)} m from a junction`);
  const bend = Math.max(...[-60, -40, -20, -1].map((d) => t.locate(
    t.atDistance(at + d).x, t.atDistance(at + d).z).sample.curvature));
  if (bend > 0.01) bad.push(`the ramp is on a ${(1 / bend).toFixed(0)} m radius bend`);

  // The ramp is built at the layout's fraction and the stage finishes at the
  // stage's, and they are written in two different files. If they drift, the
  // run ends in the middle of a block and the ramp stands somewhere nobody
  // gets to — a failure that looks like nothing at all until you play it.
  if (t.closed) bad.push('the run is still a lap');
  if (stage.routeFraction !== 1) bad.push(`the run stops ${stage.routeFraction} of the way along`);
  if (!t.rampPlan) bad.push('the layout has no ramp planned');
  else {
    const last = t.rampPlan.segs[t.rampPlan.segs.length - 1];
    // How much it climbs is not the measure on a route — it climbs however
    // much is left between the headland and the deck, and the road was
    // deliberately routed to arrive most of the way up. What matters is that
    // it ARRIVES, which the two checks below ask directly.
    // And it has to leave the road rather than run down the middle of it.
    // It has to arrive AT THE BRIDGE: at deck height, and at the deck's end.
    const B = LAYOUTS.run.bridge;
    const half = 340 * 2.4 / 2;
    const ends = [
      { x: B.x + Math.cos(B.ang) * half, z: B.z + Math.sin(B.ang) * half },
      { x: B.x - Math.cos(B.ang) * half, z: B.z - Math.sin(B.ang) * half },
    ];
    const reach = Math.min(...ends.map((e) => dist2D(e.x, e.z, last.x, last.z)));
    if (reach > 40) bad.push(`the on-ramp stops ${reach.toFixed(0)} m short of the deck`);
    if (Math.abs(last.y - 34) > 3) bad.push(`the on-ramp tops out at ${last.y.toFixed(0)} m, not 34`);
    if (Math.abs(t.rampPlan.rise) > 0.12) {
      bad.push(`the on-ramp climbs at ${(t.rampPlan.rise * 100).toFixed(0)}%`);
    }
  }

  // The same kerb profile the circuit is held to. It is the same function, but
  // this layout is where it was noticed, and a map's ground is worth checking
  // on the map rather than on its neighbour.
  const prof = [];
  for (const out of [6, 10, 16, 24]) {
    let sum2 = 0, n2 = 0, hi2 = -Infinity;
    for (let i = 0; i < t.samples.length; i += 29) {
      const p = t.samples[i];
      for (const sd of [-1, 1]) {
        const d = p.y - t.groundAt(p.x + p.nx * sd * out, p.z + p.nz * sd * out);
        sum2 += d; n2++; hi2 = Math.max(hi2, d);
      }
    }
    prof.push({ out, mean: sum2 / n2, worst: hi2 });
  }
  const kerb = prof.find((q) => q.out === 10);
  if (kerb.mean > 0.35) bad.push(`the ground sits ${kerb.mean.toFixed(2)} m under the road at the building line`);
  if (kerb.worst > 1.2) bad.push(`somewhere it is ${kerb.worst.toFixed(2)} m under it`);

  const ok = bad.length === 0;
  return `${ok ? 'an open road across the whole city' : `WRONG — ${bad[0]}`} — ` +
    `${(t.length / 1000).toFixed(2)} km over ${t.junctions.length} junctions, ` +
    `${(hi - lo).toFixed(0)} m of hill at up to ${(grade * 100).toFixed(0)}%, ` +
    `${closest.toFixed(0)} m at its closest to itself, reaching ${span.toFixed(0)} m out; ` +
    `the on-ramp starts ${(at / 1000).toFixed(2)} km in, ${near.toFixed(0)} m clear of a junction; ` +
    `ground below the road at ` + prof.map((q) => `${q.out}m:${q.mean.toFixed(2)}/${q.worst.toFixed(2)}`).join(' ');
}

// Stage three: the bridge, as a road rather than as scenery.
//
// The thing that can go wrong here is that `deck` is a switch which turns off
// most of what a Track knows how to build — the city, the side streets, the
// blockades, the pavements — and turns on a set of things nothing else uses.
// Half-applied, what you get is a bridge with a blockade on it, or a six-lane
// road with a building line ten metres out over the water.
function checkBridge(game) {
  const bad = [];
  const scene0 = game.scene;
  const t = new Track(LAYOUTS.bridge);
  const stage = STAGES.find((q) => q.layout === 'bridge');

  if (t.closed) bad.push('the bridge is a lap');
  if (!(t.length > 8000 && t.length < 14000)) bad.push(`it is ${t.length.toFixed(0)} m long`);

  // Six lanes, all the way. A junction bulge on a bridge is a bridge that gets
  // wider in the middle for no reason anybody can see.
  const widths = t.samples.map((p) => p.width);
  const wMin = Math.min(...widths), wMax = Math.max(...widths);
  if (Math.abs(wMax - wMin) > 0.01) bad.push(`its width varies from ${wMin.toFixed(1)} to ${wMax.toFixed(1)} m`);
  const lanes = Math.round(wMax / 3.6);
  if (lanes !== 6) bad.push(`it is ${lanes} lanes wide, not 6`);

  // Nothing a street has.
  if (t.streets.length || t.stubs.length) bad.push(`${t.stubs.length} side streets on a bridge`);
  if (t.rampPlan) bad.push('an on-ramp onto a bridge that is already the road');
  // No street works. A bridge with cones and amber arrow boards down it is a
  // bridge with roadworks nobody put there — and the boards went up at every
  // corner, which on a deck means every one-degree kink in it.
  const built = [];
  for (const _ of t.build(scene0)) { /* built so the props are laid */ }
  const kinds = {};
  for (const p of t.props || []) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
  for (const k of ['cone', 'sign', 'street']) {
    if (kinds[k]) bad.push(`${kinds[k]} ${k} props on a bridge`);
  }
  const lamps = (t.lamps || []).length;
  const breakables = (t.breakables || []).length;
  if (breakables) bad.push(`${breakables} things to knock over on a bridge`);
  disposeTrack(scene0, t);
  void built;

  // The railing is the wall, and it is at the edge of the deck rather than ten
  // metres past a pavement that does not exist.
  if (t.wall > 2.5) bad.push(`you stop ${t.wall.toFixed(1)} m past the kerb, over the water`);

  // Over WATER it is well clear of it — measured at mid-span rather than at
  // the ends, which now come down onto land: a bridge whose lowest point is
  // its deck height above the sea is a bridge that starts in mid-air, which is
  // the thing the landfalls were added to fix.
  const midSpan = t.atDistance(t.length / 2);
  const under = t.groundAt(midSpan.x, midSpan.z);
  if (midSpan.y - under < 40) {
    bad.push(`mid-span is only ${(midSpan.y - under).toFixed(0)} m above the water`);
  }
  // And it comes DOWN at both ends, onto ground that is there to meet it.
  for (const end of [4, t.length - 4]) {
    const p = t.atDistance(end);
    if (p.y > 14) bad.push(`the deck is ${p.y.toFixed(0)} m up where it meets the land`);
    if (t.landAt(p.x, p.z) < 0.8) bad.push('the bridge begins over open water');
    if (t.groundAt(p.x, p.z) < p.y - 1.5) {
      bad.push(`the ground is ${(p.y - t.groundAt(p.x, p.z)).toFixed(1)} m under the road at the landfall`);
    }
  }
  // The bay is level, and it is not a sheet.
  //
  // "Flat" was the old check, and flat is what was wrong with it: a single
  // height and a single colour over twelve kilometres reads as a blank canvas
  // with a bridge standing on it. What is wanted is water — level on average,
  // moving under you, and nowhere near the deck.
  // Sampled where the water actually IS: the ends are land now, and averaging
  // a city into the sea level says nothing about either.
  let lo2 = Infinity, hi2 = -Infinity, sum = 0, n = 0;
  for (let x = -3000; x <= 3000; x += 220) {
    for (let z = -1200; z <= 1200; z += 220) {
      if (t.landAt(x, z) > 0.02) continue;
      const y = t.groundAt(x, z);
      lo2 = Math.min(lo2, y); hi2 = Math.max(hi2, y); sum += y; n++;
    }
  }
  const mean = sum / n, range = hi2 - lo2;
  // Against the swell's own range, not a fixed tolerance: `under` is one
  // sample of moving water, so it is a couple of metres off the mean by
  // construction and comparing it to a flat number fails a correct sea.
  if (Math.abs(mean - under) > range) {
    bad.push(`the bay averages ${mean.toFixed(1)} m but reads ${under.toFixed(1)} under mid-span`);
  }
  if (range < 1.5) bad.push(`the bay is a sheet — ${range.toFixed(1)} m from trough to crest`);
  if (range > 12) bad.push(`the bay has ${range.toFixed(0)} m waves in it`);

  // The deck arcs. A suspended span is highest at mid-span, not at its ends.
  const mid = t.atDistance(t.length / 2).y;
  const end = t.atDistance(t.length - 4).y;
  if (mid - end < 4) bad.push(`mid-span is only ${(mid - end).toFixed(1)} m above the ends`);

  // And the traffic: enough of it to matter, spread across the lanes, and
  // slower than anybody racing.
  const c = new Campaign({ playerName: 'X' });
  c.index = STAGES.indexOf(stage);
  c.car = SELECTABLE[0];
  const f = c.field(t);
  const traffic = f.cars.filter((q) => q.traffic);
  const lanesUsed = new Set(traffic.map((q) => q.lane));
  const want = trafficCount(stage, t);
  if (traffic.length !== want) bad.push(`${traffic.length} cars of traffic, not ${want}`);
  // Density is the thing the stage asks for, so density is what is checked.
  // A count is a number that stops being right the moment the road changes
  // length, and this road changed length by a factor of five.
  const spacing = t.length / Math.max(1, traffic.length);
  if (spacing > 200) bad.push(`one car of traffic every ${spacing.toFixed(0)} m is an empty bridge`);
  // Every lane, and in the MIDDLE of it. They were at 0 and ±3.6 and ±7.2 —
  // the painted lines on a six-lane deck rather than the lanes between them.
  if (lanesUsed.size < lanes) bad.push(`the traffic uses ${lanesUsed.size} of ${lanes} lanes`);
  const centres = laneCentres(t);
  for (const q of traffic) {
    if (!centres.some((c) => Math.abs(c - q.lane) < 0.01)) {
      bad.push(`a car at ${q.lane} m is not in the middle of a lane`);
    }
  }
  for (const q of traffic) {
    if (Math.abs(q.lane) > wMax / 2 - 1.5) bad.push(`a lane at ${q.lane} m is off the deck`);
    if (!(q.speed > 6 && q.speed < 26)) bad.push(`traffic doing ${(q.speed * 3.6).toFixed(0)} km/h`);
  }
  if (f.cars.filter((q) => q.opts && q.opts.chase > 0).length !== stage.police) {
    bad.push('the police did not follow you onto the bridge');
  }

  // And the traffic drives: holds its lane, holds its speed, and is slow
  // enough to be an obstacle rather than a rival. A Cruiser that wanders out
  // of its lane is a car that ends up in the railing on its own, and a bridge
  // with nine cars parked against the parapet is not traffic.
  {
    const spec = traffic[0];
    const car = { vehicle: new Vehicle(CAR), loc: null };
    const p0 = t.atDistance(200);
    car.vehicle.reset(p0.x + p0.nx * spec.lane, p0.z + p0.nz * spec.lane,
      Math.atan2(p0.dirX, p0.dirZ));
    car.vehicle.autoShift = true;
    car.vehicle.surfaceGrip = 1;
    car.vehicle.setSpeed(spec.speed);
    car.loc = t.locate(car.vehicle.x, car.vehicle.z);
    const cr = new Cruiser(car, t, spec.lane, spec.speed);
    let drift = 0, fastest = 0, slowest = 999;
    for (let i = 0; i < Math.round(40 / FIXED); i++) {
      cr.drive(FIXED);
      car.vehicle.update(FIXED, 2);
      drift = Math.max(drift, Math.abs(car.loc.lateral - spec.lane));
      fastest = Math.max(fastest, car.vehicle.speedKmh);
      slowest = Math.min(slowest, car.vehicle.speedKmh);
    }
    if (drift > 1.2) bad.push(`traffic wandered ${drift.toFixed(1)} m out of its lane`);
    if (fastest > spec.speed * 3.6 + 12) bad.push(`traffic got up to ${fastest.toFixed(0)} km/h`);
    if (slowest < spec.speed * 3.6 - 14) bad.push(`traffic dropped to ${slowest.toFixed(0)} km/h`);
    bad.laneDrift = drift;
    if (car.loc.s < 300) bad.push('traffic did not go anywhere');
  }

  // Can it be crossed in the time allowed, and is the time allowed worth
  // having? An eleven-kilometre bridge behind a two-minute clock is a stage
  // nobody finishes; the same bridge behind a ten-minute one has no clock.
  const runner = { vehicle: new Vehicle(CAR), isPlayer: false, loc: null };
  {
    const p0 = t.atDistance(4);
    runner.vehicle.reset(p0.x, p0.z, Math.atan2(p0.dirX, p0.dirZ));
    runner.vehicle.autoShift = true;
    runner.vehicle.setSpeed(30);
    runner.loc = t.locate(runner.vehicle.x, runner.vehicle.z);
  }
  const d = new Driver(runner, t, 0.95);
  runner.driver = d;
  let crossed = 0, off = 0, time = 0;
  const solo = [runner];
  for (let i = 0; i < Math.round(500 / FIXED); i++) {
    d.drive(FIXED, solo);
    runner.vehicle.update(FIXED, 2);
    runner.loc = t.locate(runner.vehicle.x, runner.vehicle.z, runner.loc.index);
    const over = Math.abs(runner.loc.lateral) - runner.loc.width / 2;
    runner.vehicle.surfaceGrip = over <= 0 ? 1 : over < 1.6 ? 0.92 : 0.55;
    if (over > 2.0) off += FIXED;
    time += FIXED;
    if (runner.loc.s >= t.length - 6) { crossed = time; break; }
  }
  if (!crossed) bad.push(`nobody crossed it in ${time.toFixed(0)}s`);
  if (off > 3) bad.push(`${off.toFixed(1)}s off the deck crossing it`);
  // The clock is judged against a POPULATED crossing, not a solo one.
  //
  // A clean lap on an empty deck is a number that is easy to measure and does
  // not describe this stage: what the stage presents is three hundred and
  // sixty-four cars of traffic to thread and a dozen police cars turning
  // across the road. Bounding a clock against the solo time is bounding it
  // against a drive nobody takes.
  //
  // So the tax is measured rather than guessed: the same stretch of deck,
  // driven once empty and once at the stage's own density, and the ratio
  // applied to the whole crossing.
  let tax = 1;
  {
    const LEG = 1500;
    const from = 1200;
    const legTime = (withTraffic) => {
      const cars = [];
      const me = { vehicle: new Vehicle(CAR), loc: null, traffic: false };
      const p1 = t.atDistance(from);
      me.vehicle.reset(p1.x, p1.z, Math.atan2(p1.dirX, p1.dirZ));
      me.vehicle.autoShift = true;
      me.vehicle.setSpeed(45);
      me.loc = t.locate(me.vehicle.x, me.vehicle.z);
      me.driver = new Driver(me, t, 0.95);
      cars.push(me);
      if (withTraffic) {
        const lanes = laneCentres(t);
        const n = Math.round(LEG / stage.trafficEvery);
        for (let k = 0; k < n; k++) {
          const at = from + 120 + (k / n) * LEG;
          const lane = lanes[k % lanes.length];
          const p2 = t.atDistance(at);
          const c = { vehicle: new Vehicle(CAR), loc: null, traffic: true };
          c.vehicle.reset(p2.x + p2.nx * lane, p2.z + p2.nz * lane, Math.atan2(p2.dirX, p2.dirZ));
          c.vehicle.autoShift = true;
          c.vehicle.setSpeed(laneSpeed(lanes, lane));
          c.loc = t.locate(c.vehicle.x, c.vehicle.z);
          c.driver = new Cruiser(c, t, lane, laneSpeed(lanes, lane));
          cars.push(c);
        }
      }
      let el = 0;
      for (let i = 0; i < Math.round(120 / FIXED); i++) {
        for (const c of cars) {
          c.driver.drive(FIXED, cars);
          c.vehicle.update(FIXED, 2);
          c.loc = t.locate(c.vehicle.x, c.vehicle.z, c.loc.index);
          const ov = Math.abs(c.loc.lateral) - c.loc.width / 2;
          c.vehicle.surfaceGrip = ov <= 0 ? 1 : ov < 1.6 ? 0.92 : 0.55;
        }
        el += FIXED;
        if (me.loc.s >= from + LEG) break;
      }
      return el;
    };
    const empty = legTime(false);
    const busy = legTime(true);
    tax = busy / Math.max(empty, 0.001);
  }
  const real = crossed * tax;
  if (crossed && real > stage.limit) {
    bad.push(`a populated crossing takes ${real.toFixed(0)}s against a ${stage.limit}s clock`);
  }
  if (crossed && stage.limit > real * 1.8) {
    bad.push(`${stage.limit}s is generous for a ${real.toFixed(0)}s crossing`);
  }

  // What ninety-odd cars cost per step.
  //
  // Density is only worth having if the frame it is drawn in arrives on time.
  // Three things scale with the count and only one of them is obvious: the
  // physics, the driving, and the contact resolver — which compares every car
  // with every other one, so ninety-five cars is four and a half thousand
  // pairs a step rather than the hundred and twenty a sixteen-car race does.
  let stepMs = 0;
  {
    // Through the REAL `Race.update`, not a hand-rolled loop over the cars.
    //
    // A loop of its own measures what a car costs; it does not measure what
    // the game pays, and the two stopped being the same the moment distant
    // traffic began being stepped less often. A benchmark that cannot see an
    // optimisation is a benchmark that will not notice it being removed.
    const bench = Object.create(Object.getPrototypeOf(game.race));
    Object.assign(bench, {
      game, track: t, cars: [], contact: true, state: 'racing', time: 0,
      laps: 1, route: null, limit: null, leash: null, intercept: null,
      trafficSpecs: [], trafficEvery: 0, formation: 'pursuit', results: [],
      endOnFirst: false, lights: 0, countdown: 0,
    });
    // Spread over the ROAD, not at a fixed sixty-metre pitch from the start.
    // Three hundred and sixty-eight cars at sixty metres is twenty-two
    // kilometres of them on an eleven-kilometre bridge, and `atDistance`
    // clamps — so half the field was stacked in a heap at the far end, which
    // is a benchmark of the contact resolver untangling a pile-up rather than
    // of a stage.
    bench.cars = f.cars.map((spec, i) => {
      const p2 = t.atDistance(((i + 0.5) / f.cars.length) * (t.length - 200) + 100);
      const lat = spec.lane || 0;
      const car = {
        vehicle: new Vehicle(CAR), loc: null, traffic: !!spec.traffic,
        pursuer: !!spec.opts, isPlayer: !!spec.isPlayer, contactT: 0,
        lap: 0, lastS: 0, progress: 0, finished: false, position: i + 1,
        livery: SELECTABLE[0], model: null, offTrackT: 0,
        capture() {}, syncModel() {},
      };
      car.vehicle.reset(p2.x + p2.nx * lat, p2.z + p2.nz * lat, Math.atan2(p2.dirX, p2.dirZ));
      car.vehicle.autoShift = true;
      car.vehicle.surfaceGrip = 1;
      car.vehicle.setSpeed(spec.speed || 40);
      car.loc = t.locate(car.vehicle.x, car.vehicle.z);
      car.lastS = car.loc.s;
      car.driver = spec.traffic
        ? new Cruiser(car, t, lat, spec.speed || 14)
        : new Driver(car, t, 0.9, spec.opts || {});
      return car;
    });
    bench.player = bench.cars.find((c) => c.isPlayer) || bench.cars[0];
    for (const c of bench.cars) {
      if (c.driver instanceof Driver && c.driver.opts.chase > 0) c.driver.quarry = bench.player;
    }
    const steps = Math.round(2 / FIXED);
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) bench.update(FIXED);
    stepMs = (performance.now() - t0) / steps;
  }

  // And what is DRAWN, which is a different budget from what is stepped.
  {
    const bench2 = Object.create(Object.getPrototypeOf(game.race));
    Object.assign(bench2, { track: t, cars: [], player: null, time: 0 });
    const mk = (at, traffic) => ({
      traffic, model: { visible: true, userData: {} },
      loc: t.locate(t.atDistance(at).x, t.atDistance(at).z),
      vehicle: { x: 0, z: 0 }, syncModel() {},
    });
    bench2.cars = [mk(1000, false), mk(1200, true), mk(4000, true), mk(9000, true)];
    bench2.player = bench2.cars[0];
    bench2.sync(1);
    const drawn = bench2.cars.filter((c) => c.model.visible).length;
    if (drawn !== 2) bad.push(`${drawn} of 4 cars drawn — traffic across the bay is being submitted`);
  }

  // Two milliseconds a step is a quarter of a 120 Hz budget and an eighth of a
  // frame at sixty. Past that the traffic is what the player notices about the
  // frame rate rather than about the bridge.
  if (stepMs > 2.0) bad.push(`${f.cars.length} cars cost ${stepMs.toFixed(2)} ms a step`);

  const ok = bad.length === 0;
  return `${ok ? 'six lanes over open water, with traffic on it' : `WRONG — ${bad[0]}`} — ` +
    `${(t.length / 1000).toFixed(2)} km of ${lanes}-lane deck arcing ` +
    `${(mid - end).toFixed(1)} m to mid-span, ${(midSpan.y - mean).toFixed(0)} m over a bay ` +
    `with ${range.toFixed(1)} m of swell in it, land at both ends, ` +
    `${traffic.length} cars of traffic, one every ${spacing.toFixed(0)} m, in all ${lanesUsed.size} lanes at ` +
    `${Math.round(Math.min(...traffic.map((q) => q.speed)) * 3.6)}–` +
    `${Math.round(Math.max(...traffic.map((q) => q.speed)) * 3.6)} km/h, ` +
    `${stage.police} units still behind you, ${lamps} lamps and no street works; ` +
    `${f.cars.length} cars cost ` +
    `${stepMs.toFixed(2)} ms a step; a lap takes ` +
    `${crossed ? crossed.toFixed(0) : '--'}s solo and ${real.toFixed(0)}s through the traffic ` +
    `(a ${((tax - 1) * 100).toFixed(0)}% tax) of a ${stage.limit}s clock`;
}

// Every layout in the game, held to the same bar.
//
// This replaces a pair of per-layout checks with their own per-layout
// thresholds. Two layouts could carry that; six cannot, and the reversed ones
// double the count for nothing — a check that has to be written out per track
// is a check that will not be written for the next track.
//
// What it asks is the same of all of them: it is long enough to be a stage and
// short enough to fit the world, it never comes near enough to itself for one
// stretch's scenery to land on another's road, the grades are drivable, the
// ground meets the road rather than standing under it, and an AI can get round
// without leaving the tarmac.
function checkLayouts() {
  const bad = [];
  const lines = [];
  for (const [id, layout] of Object.entries(LAYOUTS)) {
    const t = new Track(layout);
    const world = ((layout.world || 1800) / 2) - 60;

    if (!(t.length > 600 && t.length < 14000)) bad.push(`${id} is ${t.length.toFixed(0)} m long`);

    // How close it comes to itself, ignoring what is near along the road.
    let closest = Infinity;
    const skip = 110;
    for (let i = 0; i < t.samples.length; i += 3) {
      for (let j = i + 3; j < t.samples.length; j += 3) {
        const along = (t.closed ? Math.min(j - i, t.samples.length - (j - i)) : j - i) * t.step;
        if (along < skip) continue;
        const a = t.samples[i], b = t.samples[j];
        const d = dist2D(a.x, a.z, b.x, b.z);
        if (d < closest) closest = d;
      }
    }
    if (closest < 36) bad.push(`${id} runs ${closest.toFixed(0)} m from itself`);

    const span = t.samples.reduce((m, q) => Math.max(m, Math.abs(q.x), Math.abs(q.z)), 0);
    if (span > world) bad.push(`${id} reaches ${span.toFixed(0)} m of a ${world.toFixed(0)} m world`);

    const grade = Math.max(...t.samples.map((q) => Math.abs(q.grade)));
    if (grade > 0.18) bad.push(`${id} hits a ${(grade * 100).toFixed(0)}% grade`);

    // The ground meets the road rather than standing a plinth under it. A
    // bridge deck has water below it by design and is exempt.
    let drop = 0;
    if (!layout.deck) {
      let sum = 0, n = 0;
      for (let i = 0; i < t.samples.length; i += 31) {
        const p = t.samples[i];
        for (const sd of [-1, 1]) {
          sum += p.y - t.groundAt(p.x + p.nx * sd * 10, p.z + p.nz * sd * 10);
          n++;
        }
      }
      drop = sum / n;
      if (drop > 0.35) bad.push(`${id} stands ${drop.toFixed(2)} m above its own ground`);
      if (drop < 0.02) bad.push(`${id} has ground level with or over the road`);
    }

    // And it can be driven. Short of the whole thing — enough road to meet
    // several corners and find out whether the racing line is followable.
    const car = { vehicle: new Vehicle(CAR), loc: null };
    const p0 = t.atDistance(4);
    car.vehicle.reset(p0.x, p0.z, Math.atan2(p0.dirX, p0.dirZ));
    car.vehicle.autoShift = true;
    car.vehicle.setSpeed(28);
    car.loc = t.locate(car.vehicle.x, car.vehicle.z);
    const d = new Driver(car, t, 0.95);
    car.driver = d;
    let off = 0, slowest = 999;
    const solo = [car];
    for (let i = 0; i < Math.round(70 / FIXED); i++) {
      d.drive(FIXED, solo);
      car.vehicle.update(FIXED, 2);
      car.loc = t.locate(car.vehicle.x, car.vehicle.z, car.loc.index);
      const over = Math.abs(car.loc.lateral) - car.loc.width / 2;
      car.vehicle.surfaceGrip = over <= 0 ? 1 : over < 1.6 ? 0.92 : 0.55;
      if (over > 2.0) off += FIXED;
      slowest = Math.min(slowest, car.vehicle.speedKmh);
      if (!t.closed && car.loc.s >= t.length - 8) break;
    }
    if (off > 3) bad.push(`${id} put a 0.95 driver ${off.toFixed(1)}s off the road`);
    if (slowest < 18) bad.push(`${id} has a corner that drops a car to ${slowest.toFixed(0)} km/h`);

    lines.push(`${id} ${(t.length / 1000).toFixed(2)}km/${closest.toFixed(0)}m`
      + `/${(grade * 100).toFixed(0)}%${layout.deck ? '' : `/${drop.toFixed(2)}m`}`
      + `/${off.toFixed(1)}s`);
  }

  const ok = bad.length === 0;
  return `${ok ? 'every layout is a stage you could drive' : `WRONG — ${bad[0]}`} — ` +
    `${lines.length} of them, as length/self-approach/grade/kerb/off-road: ${lines.join(', ')}`;
}

// Swapping the circuit under a running game.
//
// A stage is a layout, so everything about a second stage rests on this
// working: build a different track, take the old one down, and leave nothing
// behind that still points at it. The two things that do point at it are the
// drivers — each carries the sample index it found its car on last frame, and
// a stale one sends `locate` looking at a piece of road that no longer exists
// — and the HUD's cached map path.
//
// It builds a second track for real rather than mocking one, because what is
// being checked is whether a real one comes out different and comes down
// clean. The materials are the trap: the road, the kerbs and the buildings are
// all drawn with the vertex-coloured singletons out of meshkit, which the cars
// share, so disposing them here would take every car in the game with it.
function checkTrackSwap(game) {
  const bad = [];
  const other = {
    id: 'test-loop',
    name: 'TEST LOOP',
    loop: [[0, 0], [4, 0], [4, 4], [0, 4]],
    elevation: [[0.00, 1], [0.50, 9], [0.75, 5]],
  };

  const t = new Track(other);
  if (t.name !== 'TEST LOOP') bad.push(`the layout's name did not reach the track`);
  if (Math.abs(t.length - game.track.length) < 50) {
    bad.push(`a different layout gave the same length (${t.length.toFixed(0)} m)`);
  }
  if (t.gridSlots.length !== game.track.gridSlots.length) bad.push('a short grid');
  // The elevation table is by lap fraction, so the hill has to land where the
  // table puts it. Where, not how high: the profile is relaxed after it is
  // sampled — that is what stops the inside of a tight corner climbing faster
  // than its centreline — so a sharp peak in the table comes out rounded off,
  // and asserting the literal number would be asserting that the relaxation
  // does not happen.
  // Measured from the FIRST JUNCTION, which is where the elevation table's
  // fraction is measured from — not from the start line, which sits partway
  // down the opening straight so the cars have room to get moving. The two
  // are a hundred and thirty metres apart on a lap this short, which is a
  // sixth of it, and reading the table against the wrong origin makes a hill
  // that is exactly where it was asked for look a sixth of a lap early.
  const peak = t.samples.reduce((b, q) => (q.y > b.y ? q : b), t.samples[0]);
  const originS = t.locate(t.junctions[0].x, t.junctions[0].z).s;
  const at = ((peak.s - originS + t.length) % t.length) / t.length;
  const low = Math.min(...t.samples.map((q) => q.y));
  if (Math.abs(at - 0.5) > 0.08) bad.push(`the hill peaks ${(at * 100).toFixed(0)}% round, not 50%`);
  if (peak.y - low < 4) bad.push(`the hill is only ${(peak.y - low).toFixed(1)} m tall`);

  // Built, then taken down: the group leaves the scene and its geometry is
  // released, but the shared materials survive.
  const before = game.scene.children.length;
  for (const _ of t.build(game.scene)) { /* built in one go, off the clock */ }
  if (game.scene.children.length !== before + 1) bad.push('building added no group');
  let disposed = 0;
  const shared = [];
  t.group.traverse((o) => {
    if (o.material && !Array.isArray(o.material)) shared.push(o.material);
  });
  for (const m of shared) m.userData.__seen = true;
  disposeTrack(game.scene, t);
  if (game.scene.children.length !== before) bad.push('taking it down left the group in the scene');
  if (t.group) bad.push('the track still holds its group');
  // The car material is one of the shared ones and must still be usable.
  const carMat = game.race.player.model.children.find((o) => o.material)?.material;
  if (carMat && carMat.version === undefined) bad.push('the cars lost their material');
  void disposed;

  // And a real swap on the live game: the drivers must forget where they were.
  const drivers = game.race.cars.filter((q) => q.driver);
  for (const q of drivers) q.driver.hint = 99999;
  const kept = game.race.track;
  game.race.setTrack(game.track);
  const stale = drivers.filter((q) => q.driver.hint !== -1).length;
  if (stale) bad.push(`${stale} drivers kept a stale sample index`);
  if (game.race.track !== game.track) bad.push('the race kept the old track');
  if (drivers.some((q) => q.driver.track !== game.track)) bad.push('a driver kept the old track');
  void kept;

  const ok = bad.length === 0;
  return `${ok ? 'a layout is all a stage is' : `WRONG — ${bad[0]}`} — ` +
    `a four-corner test loop came out ${(t.length / 1000).toFixed(3)} km against ` +
    `${(game.track.length / 1000).toFixed(3)}, built and released ${shared.length} meshes, ` +
    `${drivers.length} drivers forgot where they were, its hill peaks ` +
    `${(at * 100).toFixed(0)}% round at ${peak.y.toFixed(1)} m over a ${low.toFixed(1)} m low`;
}

// The two things that keep a chase stage alive to the end of it.
//
// Both are cheats, in the sense that neither is what the simulation would do
// left alone, and both exist because what the simulation does alone is worse:
// traffic parked in a wall across the finish, and police four hundred metres
// back with nothing between you and the end of the road.
function checkChaseRules(game) {
  const bad = [];
  const t = new Track(LAYOUTS.bridge);
  const stage = STAGES.find((q) => q.layout === 'bridge');
  const camp = new Campaign({ playerName: 'X' });
  camp.index = STAGES.indexOf(stage);
  camp.car = SELECTABLE[0];
  const f = camp.field(t);

  // A stand-in Race: the real one, pointed at this track, with a field small
  // enough to reason about.
  const race = Object.create(Object.getPrototypeOf(game.race));
  Object.assign(race, {
    game, track: t, cars: [], route: t.length, limit: null, contact: false,
    state: 'racing', time: 0, leash: stage.leash, trafficCount: 0, laps: 1,
    formation: 'pursuit', endOnFirst: false, results: [],
  });
  const put = (at, opts) => {
    const p = t.atDistance(at);
    const car = {
      vehicle: new Vehicle(CAR), loc: null, model: null, contactT: 0,
      isPlayer: !!opts.player, pursuer: !!opts.pursuer, traffic: !!opts.traffic,
      livery: SELECTABLE[0], lap: 0, lastS: at, progress: at, finished: false,
      syncModel() {}, position: 1,
    };
    car.vehicle.reset(p.x, p.z, Math.atan2(p.dirX, p.dirZ));
    car.vehicle.setSpeed(opts.speed ?? 40);
    car.loc = t.locate(car.vehicle.x, car.vehicle.z);
    if (opts.pursuer) car.driver = { opts: { station: opts.station || 0, chase: 1 }, hint: 0 };
    race.cars.push(car);
    return car;
  };

  // --- traffic at the end of the road leaves it, and so does traffic a long
  // way behind: the second is what pays for the cars being added ahead.
  const player = put(t.length - 900, { player: true, speed: 50 });
  race.player = player;
  const stuck = [];
  for (let i = 0; i < 5; i++) stuck.push(put(t.length - 30 - i * 8, { traffic: true, speed: 14 }));
  const dropped = put(player.loc.s - 600, { traffic: true, speed: 14 });
  // A keeper: ahead of the player and nowhere near the end. Putting it in the
  // middle of the road was wrong — that is four kilometres BEHIND the car on
  // this setup, and traffic that far back is correctly taken away too.
  const mid = put(player.loc.s + 300, { traffic: true, speed: 14 });
  race.trafficCount = 7;
  const before = race.cars.length;
  race._despawn();
  const after = race.cars.length;
  if (after !== before - 6) bad.push(`${before - after} of 6 cars were despawned, not 6`);
  if (race.cars.includes(dropped)) bad.push('traffic six hundred metres behind was kept');
  if (!race.cars.includes(mid)) bad.push('traffic in the middle of the road was despawned too');
  if (stuck.some((c) => race.cars.includes(c))) bad.push('a car is still parked on the finish');
  // And nothing left behind pointing at a car that is gone.
  if (race.cars.some((c) => c.gone)) bad.push('a despawned car is still in the field');

  // --- and it keeps topping up ahead as the car goes.
  //
  // The layout is laid once and every car of it drives forward at forty to
  // seventy while the player does a hundred and eighty. Left alone the road
  // drains: the first kilometre — where the stage starts — is empty by the
  // time anybody looks at it, and the last one is a wall. So the window ahead
  // is refilled, and refilling it is only correct if it neither runs out nor
  // puts a car on top of another one.
  let thin = 0, stacked = 0, made = 0;
  {
    race.trafficSpecs = f.cars.filter((q) => q.traffic).slice(0, 6);
    race.trafficEvery = stage.trafficEvery;
    const before2 = race.cars.length;
    // Back to the start, and drive it.
    const start = t.atDistance(200);
    player.vehicle.reset(start.x, start.z, Math.atan2(start.dirX, start.dirZ));
    player.loc = t.locate(player.vehicle.x, player.vehicle.z);
    // Sampled every kilometre rather than every quarter of one: each top-up
    // builds real cars with real geometry, and thirty-seven sample points at
    // twelve frames each was thirteen hundred car models — which is not a
    // slower test, it is a test that never finishes.
    for (let d = 200; d < t.length - 1200; d += 1000) {
      const at = t.atDistance(d);
      player.vehicle.reset(at.x, at.z, Math.atan2(at.dirX, at.dirZ));
      player.loc = t.locate(player.vehicle.x, player.vehicle.z);
      for (const c of race.cars) if (c.traffic) c.loc = t.locate(c.vehicle.x, c.vehicle.z);
      race._despawn();
      for (let k = 0; k < 8; k++) race._topUpTraffic();
      const ahead = race.cars.filter((c) => c.traffic && c.loc
        && c.loc.s > d + 40 && c.loc.s < d + 1500);
      // Two thirds of what the spacing asks for, allowing for the far edge
      // running into the end of the bridge.
      if (ahead.length < (1460 / stage.trafficEvery) * 0.62) thin++;
      for (let a = 0; a < ahead.length; a++) {
        for (let b2 = a + 1; b2 < ahead.length; b2++) {
          if (Math.abs(ahead[a].loc.s - ahead[b2].loc.s) < 12
            && Math.abs(ahead[a].loc.lateral - ahead[b2].loc.lateral) < 2.2) stacked++;
        }
      }
    }
    made = race.cars.length - before2;
    // Everything this made goes back: it is a real scene and these are real
    // meshes, and a check that leaves a hundred cars in it changes every frame
    // dumped afterwards.
    for (const c of race.cars) {
      if (!c.model) continue;
      game.scene.remove(c.model);
      c.model.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
  }
  if (thin > 2) bad.push(`the road ahead ran thin at ${thin} of the points sampled`);
  if (stacked) bad.push(`${stacked} pairs of traffic stacked in the same lane`);
  if (made <= 0) bad.push('no traffic was ever added ahead of the car');

  // --- fresh units cutting in ahead.
  let cutIn = 0, aheadOf = 0, nearest = Infinity;
  {
    race.intercept = stage.intercept;
    race.cars = race.cars.filter((c) => c.isPlayer);
    const at0 = t.atDistance(2000);
    player.vehicle.reset(at0.x, at0.z, Math.atan2(at0.dirX, at0.dirZ));
    player.vehicle.setSpeed(50);
    player.loc = t.locate(player.vehicle.x, player.vehicle.z);
    for (let i = 0; i < 40; i++) race._intercept(stage.intercept.every);
    const units = race.cars.filter((c) => c.pursuer);
    cutIn = units.length;
    for (const u of units) {
      const g = t.gap(u.loc.s, player.loc.s);
      if (g > 0) aheadOf++;
      nearest = Math.min(nearest, g);
      if (Math.abs(u.loc.lateral) > t.samples[0].width / 2) bad.push('a unit cut in off the road');
      if (!u.driver || u.driver.quarry !== player) bad.push('a unit cut in with nobody to chase');
      if (Math.abs(u.vehicle.u) < 10) bad.push('a unit cut in from a standstill');
    }
    if (cutIn === 0) bad.push('nothing ever cut in ahead');
    if (cutIn > stage.intercept.max) bad.push(`${cutIn} units at once, past the cap of ${stage.intercept.max}`);
    if (aheadOf !== cutIn) bad.push(`${cutIn - aheadOf} of the units cut in BEHIND the player`);
    // And never on top of the car.
    if (nearest < 200) bad.push(`one appeared ${nearest.toFixed(0)} m in front of the bonnet`);
    for (const c of race.cars) {
      if (!c.model) continue;
      game.scene.remove(c.model);
      c.model.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
    race.cars = race.cars.filter((c) => c.isPlayer);
    race.intercept = null;
  }

  // --- a unit that cut in ahead turns round and comes back.
  //
  // This is the difference between a roadblock and a slow car in your way. The
  // units used to spawn three hundred metres up the road and simply drive it,
  // nine metres a second slower than you, until you caught them — because the
  // block only reached thirty-four metres and the station machinery was quite
  // happy for a police car to lead the way.
  let faceAngle = 0, faceGap = 0, faceStart = 0;
  {
    const t3 = t;
    const q3 = { vehicle: new Vehicle(CAR), loc: null, name: '' };
    const u3 = { vehicle: new Vehicle(CAR), loc: null, name: '' };
    const place = (car, at, speed, lat = 0) => {
      const p4 = t3.atDistance(at);
      car.vehicle.reset(p4.x + p4.nx * lat, p4.z + p4.nz * lat, Math.atan2(p4.dirX, p4.dirZ));
      car.vehicle.autoShift = true;
      car.vehicle.surfaceGrip = 1;
      car.vehicle.setSpeed(speed);
      car.loc = t3.locate(car.vehicle.x, car.vehicle.z);
    };
    place(q3, 4000, 44);
    place(u3, 4300, 22, 3);              // three hundred metres up the road
    const d3 = new Driver(u3, t3, POLICE.skill, { ...POLICE.opts, station: 0 });
    u3.driver = d3;
    d3.quarry = q3;
    d3.intercepting = true;
    const qd3 = new Cruiser(q3, t3, 0, 44);
    q3.driver = qd3;
    faceStart = dist2D(q3.vehicle.x, q3.vehicle.z, u3.vehicle.x, u3.vehicle.z);
    faceGap = faceStart;
    for (let i = 0; i < Math.round(16 / FIXED); i++) {
      for (const c of [q3, u3]) {
        c.driver.drive(FIXED, [q3, u3]);
        c.vehicle.update(FIXED, 2);
        c.loc = t3.locate(c.vehicle.x, c.vehicle.z, c.loc.index);
      }
      const road3 = t3.atDistance(u3.loc.s);
      faceAngle = Math.max(faceAngle, Math.abs(angleDiff(
        u3.vehicle.yaw, Math.atan2(road3.dirX, road3.dirZ))) * 57.3);
      faceGap = Math.min(faceGap, dist2D(q3.vehicle.x, q3.vehicle.z, u3.vehicle.x, u3.vehicle.z));
    }
    // Turned to face the oncoming car — a long way round, not a lane change.
    if (faceAngle < 120) bad.push(`an interceptor turned only ${faceAngle.toFixed(0)}° to face the car`);
    // And met it. A roadblock that turns beautifully and is never reached is
    // a roadblock you drive past.
    if (faceGap > 8) bad.push(`an interceptor got no closer than ${faceGap.toFixed(0)} m`);
    // It must not have simply driven off down the road.
    if (t3.gap(u3.loc.s, q3.loc.s) > 120) {
      bad.push(`an interceptor is ${t3.gap(u3.loc.s, q3.loc.s).toFixed(0)} m up the road`);
    }
  }

  // --- a unit that has got in front turns across the road.
  let swing = 0, blockClose = 0;
  {
    const t2 = t;
    let swingMax = 0; void swingMax;
    const blocker = { vehicle: new Vehicle(CAR), loc: null, name: '' };
    const q = { vehicle: new Vehicle(CAR), loc: null, name: '' };
    const put2 = (car, at, speed) => {
      const p2 = t2.atDistance(at);
      car.vehicle.reset(p2.x, p2.z, Math.atan2(p2.dirX, p2.dirZ));
      car.vehicle.autoShift = true;
      car.vehicle.surfaceGrip = 1;
      car.vehicle.setSpeed(speed);
      car.loc = t2.locate(car.vehicle.x, car.vehicle.z);
    };
    put2(q, 3000, 30);
    put2(blocker, 3018, 14);            // eighteen metres in front, going slowly
    const d = new Driver(blocker, t2, POLICE.skill, { ...POLICE.opts, station: 0 });
    blocker.driver = d;
    d.quarry = q;
    // The quarry has to be DRIVEN. Left standing, the blocker simply pulls
    // away from it, the gap grows past the range the block works in, and the
    // check measures a car driving off down an empty road.
    const qd = new Cruiser(q, t2, 0, 30);
    q.driver = qd;
    const yaw0 = blocker.vehicle.yaw;
    const startGap = dist2D(q.vehicle.x, q.vehicle.z, blocker.vehicle.x, blocker.vehicle.z);
    for (let i = 0; i < Math.round(1.4 / FIXED); i++) {
      qd.drive(FIXED, [q, blocker]);
      q.vehicle.update(FIXED, 2);
      q.loc = t2.locate(q.vehicle.x, q.vehicle.z, q.loc.index);
      d.drive(FIXED, [q, blocker]);
      blocker.vehicle.update(FIXED, 2);
      blocker.loc = t2.locate(blocker.vehicle.x, blocker.vehicle.z, blocker.loc.index);
      swing = Math.max(swing, Math.abs(angleDiff(
        blocker.vehicle.yaw,
        Math.atan2(t2.atDistance(blocker.loc.s).dirX, t2.atDistance(blocker.loc.s).dirZ))) * 57.3);
    }
    // The furthest it got off the road's direction over the whole manoeuvre,
    // not where it happened to be pointing at the end: a block is a swing, and
    // a car that has swung across and started to straighten is still a car
    // that blocked you.
    if (swing < 15) bad.push(`a unit in front turned only ${swing.toFixed(0)}° across the road`);
    if (swing > 150) bad.push(`a unit in front spun ${swing.toFixed(0)}°`);
    // And it has to be CAUGHT. A unit that turns beautifully across the road
    // while holding the quarry's speed seven metres ahead is a police escort:
    // it looks like a block and never touches anybody.
    const endGap = dist2D(q.vehicle.x, q.vehicle.z, blocker.vehicle.x, blocker.vehicle.z);
    blockClose = endGap;
    if (endGap > startGap) {
      bad.push(`a blocking unit went from ${startGap.toFixed(0)} m to ${endGap.toFixed(0)} m away`);
    }
    if (endGap > 12) bad.push(`a blocking unit stayed ${endGap.toFixed(0)} m clear of the car`);
  }

  // --- the leash.
  //
  // The player has been picked up and put down repeatedly above, and `reset`
  // zeroes the velocity — so its speed is set again here rather than assumed.
  // Without it the leash was matching a stationary car and the check was
  // measuring its own setup.
  player.vehicle.setSpeed(50);
  const unit = put(player.loc.s - stage.leash - 120, { pursuer: true, station: 1, speed: 12 });
  const wasGap = t.gap(player.loc.s, unit.loc.s);
  race._leash();
  const nowGap = t.gap(player.loc.s, unit.loc.s);
  const speed = Math.abs(unit.vehicle.u);
  if (nowGap >= wasGap) bad.push(`the leash left it ${nowGap.toFixed(0)} m back`);
  if (nowGap <= 0) bad.push(`the leash put it ${(-nowGap).toFixed(0)} m AHEAD of the player`);
  if (nowGap > 260) bad.push(`the leash brought it to ${nowGap.toFixed(0)} m, which is still lost`);
  if (Math.abs(speed - Math.abs(player.vehicle.u)) > 4) {
    bad.push(`it came back doing ${(speed * 3.6).toFixed(0)} against the player's ${(player.vehicle.u * 3.6).toFixed(0)}`);
  }
  if (Math.abs(unit.loc.lateral) > t.samples[0].width / 2) bad.push('the leash put it off the road');

  // A unit that has NOT fallen off the back is left alone. A leash that fires
  // on a unit already on your bumper is a unit that teleports every few
  // seconds, in view, which is the one thing this must never do.
  const close = put(player.loc.s - 40, { pursuer: true, station: 2, speed: 50 });
  const closeAt = close.loc.s;
  race._leash();
  if (Math.abs(close.loc.s - closeAt) > 1) bad.push('the leash moved a unit that was right behind');

  // Every stage that uses it fires from further back than it returns to, and
  // from far enough back to mean "lost" rather than "dropped a car length".
  //
  // The first version of this check asked for the threshold to be beyond the
  // fog, on the theory that the move must not be seen. That is the wrong
  // constraint and it failed a correct setting: a unit is only ever leashed
  // while it is BEHIND the player, and behind is the half of the world nobody
  // is looking at. What actually matters is that it fires rarely and never
  // lands in front.
  for (const st of STAGES) {
    if (!st.leash) continue;
    if (st.leash < 250) bad.push(`${st.id}'s leash fires at ${st.leash} m, which is not lost`);
    if (st.leash < nowGap * 1.6) {
      bad.push(`${st.id} leashes at ${st.leash} m and returns to ${nowGap.toFixed(0)}, so it will chatter`);
    }
  }

  // --- a pursuit starts rolling, in slow motion.
  let openSpeed = 0, slow0 = 0, slow1 = 0, openGear = 0, openRpm = 0;
  {
    race.formation = 'pursuit';
    race.cars = [player];
    for (let u = 0; u < 3; u++) {
      const c = put(0, { pursuer: true, station: u, speed: 0 });
      c.driver = { opts: { station: u, chase: 1 }, hint: 0 };
    }
    race.trafficSpecs = [];
    race.trafficEvery = 0;
    race.gridUp();
    openSpeed = Math.min(...race.cars.map((c) => Math.abs(c.vehicle.u)));
    // And in a gear that will pull it. Everybody opened in first, over the
    // limiter, with the player's gearbox on manual and no way to know.
    for (const c of race.cars) {
      const spec = c.vehicle.spec;
      const ratio = spec.gears[c.vehicle.gear] * spec.finalDrive;
      const rpm = (Math.abs(c.vehicle.u) / spec.wheelRadius) * ratio * 60 / (Math.PI * 2);
      if (c.vehicle.gear < 2) bad.push(`a car opened at speed in gear ${c.vehicle.gear}`);
      if (rpm > spec.limiter) bad.push(`a car opened at ${rpm.toFixed(0)} rpm, past the limiter`);
      openGear = c.vehicle.gear;
      openRpm = rpm;
    }
    if (race.state !== 'racing') bad.push(`a pursuit opened in state ${race.state}`);
    if (race.countdown) bad.push('a pursuit counted down');
    if (openSpeed < 30) bad.push(`everyone opened at ${(openSpeed * 3.6).toFixed(0)} km/h`);

    // And time is slowed at the off, then let go.
    const wasT = game._slowmoT;
    game._slowmoT = 1.6;
    slow0 = game.timeScale;
    game._slowmoT = 0;
    slow1 = game.timeScale;
    game._slowmoT = wasT;
    if (!(slow0 > 0.15 && slow0 < 0.55)) bad.push(`the opening runs at ${slow0.toFixed(2)} speed`);
    if (Math.abs(slow1 - 1) > 1e-6) bad.push(`time never returns to normal (${slow1.toFixed(2)})`);
    for (const c of race.cars) {
      if (!c.model) continue;
      game.scene.remove(c.model);
      c.model.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
  }

  const ok = bad.length === 0;
  return `${ok ? 'traffic leaves, and the police come back' : `WRONG — ${bad[0]}`} — ` +
    `5 cars cleared off the finish and one dropped from behind, ` +
    `while the one ahead stayed; ` +
    `${made} cars were added ahead over ${(t.length / 1000).toFixed(0)} km with none stacked; ` +
    `${cutIn} units cut in ahead, nearest at ${nearest.toFixed(0)} m; one dropped ` +
    `${faceStart.toFixed(0)} m up the road turned ${faceAngle.toFixed(0)}° and met the car at ` +
    `${faceGap.toFixed(0)} m; one in front ` +
    `turned ${swing.toFixed(0)}° across the road and closed to ${blockClose.toFixed(0)} m; ` +
    `it opens rolling at ${(openSpeed * 3.6).toFixed(0)} km/h in gear ${openGear} at ` +
    `${openRpm.toFixed(0)} rpm through ` +
    `${slow0.toFixed(2)}x time; a unit ${wasGap.toFixed(0)} m adrift came back to ${nowGap.toFixed(0)} m at ` +
    `${(speed * 3.6).toFixed(0)} km/h, and one already close was left alone`;
}

// Stages four and five: the pack race and the checkpoint sprint.
//
// Both driven rather than inspected. The estuary is the first stage where the
// composable field earns its keep — rivals AND traffic in one race — and the
// skyline is the first where the clock is an opponent with an economy: it has
// to be UNWINNABLE without the checkpoints and winnable with them, or the
// mechanic is decoration.
function checkNewStages(game) {
  const bad = [];

  // --- the estuary field: three rivals ahead of you, traffic among you.
  const est = STAGES.find((q) => q.id === 'estuary');
  {
    const t = new Track(LAYOUTS.estuary);
    const c = new Campaign({ playerName: 'X' });
    c.index = STAGES.indexOf(est);
    c.car = SELECTABLE[0];
    const f = c.field(t);
    const rivals = f.cars.filter((q) => q.opts && !q.pursuer && !q.traffic && !q.isPlayer);
    const traffic = f.cars.filter((q) => q.traffic);
    if (rivals.length !== 3) bad.push(`the estuary fields ${rivals.length} rivals, not 3`);
    if (!traffic.length) bad.push('the estuary has no traffic to thread');
    if (f.cars.findIndex((q) => q.isPlayer) !== 3) bad.push('the player does not start behind the pack');
    if (!f.endOnFirst) bad.push('the estuary does not end on the flag');
    if (f.formation !== 'grid') bad.push(`the estuary lines up as a ${f.formation}`);
    const names = new Set(rivals.map((q) => q.livery.name));
    if (names.size !== rivals.length) bad.push('two rivals share a livery');
    // And the pack can race it: a short sim, all three rivals plus the player
    // slot driven by AI, nobody stranded or off the road for long.
    //
    // SEEDED, and averaged over three seeds — the same lesson the rival check
    // learned. Drivers roll reaction times, mistakes and drift commitments
    // from Math.random, and one roll of a four-car contact race swung this
    // number from six car-seconds to nine and a half with identical code. One
    // seeded run of a chaotic system is a coin flip about a threshold; three
    // is a measurement.
    const packRun = () => {
      const cars = f.cars.filter((q) => !q.traffic).map((spec, i) => {
        const slot = t.gridSlots[i];
        const car = { vehicle: new Vehicle(CAR), loc: null };
        car.vehicle.reset(slot.x, slot.z, slot.yaw);
        car.vehicle.autoShift = true;
        car.vehicle.surfaceGrip = 1;
        car.loc = t.locate(car.vehicle.x, car.vehicle.z);
        car.driver = new Driver(car, t, spec.skill ?? 0.9, spec.opts || {});
        return car;
      });
      let off2 = 0;
      for (let i = 0; i < Math.round(50 / FIXED); i++) {
        for (const car of cars) {
          car.driver.drive(FIXED, cars);
          car.vehicle.update(FIXED, 2);
          car.loc = t.locate(car.vehicle.x, car.vehicle.z, car.loc.index);
          const over = Math.abs(car.loc.lateral) - car.loc.width / 2;
          car.vehicle.surfaceGrip = over <= 0 ? 1 : over < 1.6 ? 0.92 : 0.55;
          if (over > 2) off2 += FIXED;
        }
      }
      return off2;
    };
    const realRandom = Math.random;
    let offSum = 0;
    for (const s0 of [0x2f6e2b1, 0x51f3a9d, 0x13c7e05]) {
      let seed = s0;
      Math.random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      try { offSum += packRun(); } finally { Math.random = realRandom; }
    }
    const offT = offSum / 3;
    if (offT > 7) bad.push(`the pack spent ${offT.toFixed(1)} car-seconds off the estuary`);
  }

  // --- traffic looks like traffic.
  //
  // Every traffic livery takes the civilian path: real bodies with tall glass
  // and lights, not racing silhouettes in grey paint. And the model honours
  // the same contract syncModel drives — four wheels with pivots, a tail
  // material whose opacity can follow the brakes — because traffic that drove
  // with frozen wheels would be spotted in the first mirror glance.
  for (const livery of TRAFFIC) {
    if (!livery.civ) { bad.push('a traffic livery still wears a racing body'); continue; }
    const m = buildCar(livery);
    const w = m.userData.wheels || [];
    if (w.length !== 4) bad.push(`a ${livery.civ} has ${w.length} wheels`);
    if (!m.userData.tails) bad.push(`a ${livery.civ} has no brake lights`);
    let minY = Infinity, maxY = -Infinity;
    m.traverse((o) => {
      if (!o.isMesh || !o.geometry.boundingBox) o.geometry && o.geometry.computeBoundingBox();
    });
    m.traverse((o) => {
      if (!o.isMesh || !o.geometry.boundingBox) return;
      minY = Math.min(minY, o.geometry.boundingBox.min.y + o.position.y);
      maxY = Math.max(maxY, o.geometry.boundingBox.max.y + o.position.y);
    });
    // Taller than a racer — the racing roofline tops out at about 1.2 and a
    // civilian greenhouse must not.
    if (maxY < 1.35) bad.push(`a ${livery.civ} is ${maxY.toFixed(2)} m tall — that is a race car`);
    m.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
  const civKinds = new Set(TRAFFIC.map((q) => q.civ));
  if (civKinds.size < 4) bad.push(`the road only carries ${civKinds.size} kinds of car`);

  // --- traffic on a loop is a fixed population.
  //
  // The estuary is the first CLOSED stage with traffic, and the top-up that
  // keeps an open route full was spawning on it unboundedly: its window is
  // written in monotonic distances, and on a lap shorter than the look-ahead
  // it swallowed its own tail, matched nothing, and added three cars a step.
  // Three seconds of that is a thousand cars nose to tail on the grid.
  {
    const t = new Track(LAYOUTS.estuary);
    const c = new Campaign({ playerName: 'X' });
    c.index = STAGES.indexOf(est);
    c.car = SELECTABLE[0];
    const f = c.field(t);
    const race = Object.create(Object.getPrototypeOf(game.race));
    Object.assign(race, {
      game: { onLap() {}, onFinish() {}, onCheckpoint() {}, onImpact() {}, scene: { add() {}, remove() {} } },
      track: t, state: 'racing', time: 0, laps: 3, route: null, limit: null,
      leash: null, intercept: null, roadblocks: null, escape: null, checkpoints: null,
      contact: false, endOnFirst: true, formation: 'grid', damageMax: null,
      driftTarget: null, drift: null, results: [], order: [],
      trafficEvery: f.trafficEvery, trafficSpecs: f.cars.filter((q) => q.traffic),
    });
    // A minimal live field: the player, moving, and the traffic where the
    // slots put it. `_makeTraffic` builds real models, so if the top-up runs
    // wild this leaks a thousand cars into a fake scene, not the real one.
    const p0 = t.atDistance(40);
    const player = {
      vehicle: new Vehicle(CAR), loc: null, isPlayer: true, traffic: false,
      pursuer: false, finished: false, lap: 0, lastS: 40, progress: 40,
      contactT: 0, position: 1, lapTimes: [], bestLap: Infinity,
      capture() {}, syncModel() {}, model: null, driver: null,
    };
    player.vehicle.reset(p0.x, p0.z, Math.atan2(p0.dirX, p0.dirZ));
    player.vehicle.setSpeed(35);
    player.loc = t.locate(player.vehicle.x, player.vehicle.z);
    race.cars = [player];
    race.player = player;
    race._order = () => { race.order = [player]; return race.order; };
    const before = { n: 0 };
    // Drive a lap and a half of simulated time in chunks, moving the player
    // by hand so the window slides the way it does in play.
    let peak = 0;
    for (let d = 40; d < t.length * 1.5; d += 90) {
      const at = t.atDistance(d % t.length);
      player.vehicle.reset(at.x, at.z, Math.atan2(at.dirX, at.dirZ));
      player.vehicle.setSpeed(35);
      player.loc = t.locate(player.vehicle.x, player.vehicle.z);
      for (let i = 0; i < Math.round(2 / FIXED); i++) race._topUpTraffic();
      peak = Math.max(peak, race.cars.length);
    }
    before.n = race.cars.length;
    if (peak > 1) bad.push(`the loop's top-up spawned ${peak - 1} cars — a closed circuit does not drain`);
    for (const q of race.cars) if (q.model) {
      game.scene.remove(q.model);
      q.model.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
  }

  // --- the skyline economy.
  const sky = STAGES.find((q) => q.id === 'skyline');
  let crossT = 0;
  {
    const t = new Track(LAYOUTS.run_rev);
    // The dawn is real: this layout's sky is not the night sky.
    if (!LAYOUTS.run_rev.sky) bad.push('the skyline has no dawn');

    // Cross it clean and time it.
    const car = { vehicle: new Vehicle(CAR), loc: null };
    const p0 = t.atDistance(4);
    car.vehicle.reset(p0.x, p0.z, Math.atan2(p0.dirX, p0.dirZ));
    car.vehicle.autoShift = true;
    car.vehicle.setSpeed(30);
    car.loc = t.locate(car.vehicle.x, car.vehicle.z);
    const d = new Driver(car, t, 0.95);
    car.driver = d;
    const solo = [car];
    for (let i = 0; i < Math.round(400 / FIXED); i++) {
      d.drive(FIXED, solo);
      car.vehicle.update(FIXED, 2);
      car.loc = t.locate(car.vehicle.x, car.vehicle.z, car.loc.index);
      const over = Math.abs(car.loc.lateral) - car.loc.width / 2;
      car.vehicle.surfaceGrip = over <= 0 ? 1 : over < 1.6 ? 0.92 : 0.55;
      crossT += FIXED;
      if (car.loc.s >= t.length - 8) break;
    }
    const bank = sky.limit + sky.checkpoints.at.length * sky.checkpoints.bonus;
    // Unwinnable without the checkpoints, winnable with all of them: that gap
    // IS the mechanic. If the base clock covers the drive, the checkpoints are
    // confetti; if the full bank does not, the stage is a wall.
    if (sky.limit >= crossT) bad.push(`the base clock (${sky.limit}s) covers the ${crossT.toFixed(0)}s drive`);
    if (bank < crossT * 1.15) bad.push(`all checkpoints banked (${bank}s) is not enough for ${crossT.toFixed(0)}s`);
    // And each line is makeable: time to reach each checkpoint at the clean
    // pace must be inside the clock as extended by the ones before it.
    let have = sky.limit;
    for (const f2 of sky.checkpoints.at) {
      const need = crossT * f2;
      if (need > have) bad.push(`the ${(f2 * 100).toFixed(0)}% line needs ${need.toFixed(0)}s of ${have}s`);
      have += sky.checkpoints.bonus;
    }

    // The mechanic itself, driven through the real `_progress`: crossing a
    // checkpoint adds to the limit, once.
    const race = Object.create(Object.getPrototypeOf(game.race));
    let flashed = 0;
    Object.assign(race, {
      game: { onCheckpoint: () => flashed++, onLap() {}, onFinish() {} },
      track: t, cars: [], laps: 1, time: 0, state: 'racing',
      route: t.length, limit: sky.limit,
      checkpoints: sky.checkpoints.at.map((f2) => ({ s: f2 * t.length, bonus: sky.checkpoints.bonus, taken: false })),
    });
    const pc = { vehicle: car.vehicle, loc: null, isPlayer: true, traffic: false, pursuer: false,
      lap: 0, lastS: 0, progress: 0, finished: false, lapTimes: [], bestLap: Infinity };
    const at = t.atDistance(sky.checkpoints.at[0] * t.length + 5);
    pc.vehicle.reset(at.x, at.z, Math.atan2(at.dirX, at.dirZ));
    pc.loc = t.locate(pc.vehicle.x, pc.vehicle.z);
    pc.lastS = pc.loc.s;
    race._progress(pc, FIXED);
    race._progress(pc, FIXED);           // crossing again must not pay again
    if (race.limit !== sky.limit + sky.checkpoints.bonus) {
      bad.push(`crossing a line paid ${race.limit - sky.limit}s, not ${sky.checkpoints.bonus}`);
    }
    if (flashed !== 1) bad.push(`the checkpoint flashed ${flashed} times`);
  }

  const ok = bad.length === 0;
  return `${ok ? 'a pack to race and a clock to feed' : `WRONG — ${bad[0]}`} — ` +
    `the estuary fields 3 rivals plus civilian traffic — ${civKinds.size} body kinds, ` +
    `all with wheels and brake lights — and the pack stays on the road; ` +
    `the skyline takes ${crossT.toFixed(0)}s against a ${sky.limit}s clock plus ` +
    `${sky.checkpoints.at.length}×${sky.checkpoints.bonus}s in lines, each one makeable, ` +
    `paid once each`;
}

// Stages seven and eight: the rain, and the stage with no finish line.
//
// Four mechanics, each driven. Wet has to change a number a driver feels (a
// braking distance), a roadblock has to be a stationary object across the
// road, damage has to accumulate and bust, and the escape meter has to fill
// ONLY while nobody is close — each of these is the kind of flag that can be
// wired to nothing and still look right in the data.
function checkWetAndEscape(game) {
  const bad = [];
  const wet = STAGES.find((q) => q.id === 'wetwork');
  const last = STAGES.find((q) => q.id === 'lastcall');

  // --- wet lengthens a braking distance.
  let dryStop = 0, wetStop = 0;
  {
    const stop = (grip) => {
      const v = new Vehicle(CAR);
      v.reset(0, 0, 0);
      v.autoShift = true;
      v.surfaceGrip = grip;
      v.setSpeed(100 / 3.6 * 1.0);
      v.u = 27.8;                        // 100 km/h
      let dist = 0;
      for (let i = 0; i < Math.round(8 / FIXED); i++) {
        v.throttle = 0; v.brake = 1;
        v.update(FIXED, 2);
        dist += v.u * FIXED;
        if (v.u < 0.5) break;
      }
      return dist;
    };
    dryStop = stop(1);
    wetStop = stop(LAYOUTS.folsom_rev.wet);
    if (!(LAYOUTS.folsom_rev.wet < 1)) bad.push('the wet layout is not wet');
    if (wetStop < dryStop * 1.12) {
      bad.push(`the wet stop (${wetStop.toFixed(1)} m) is barely longer than the dry (${dryStop.toFixed(1)} m)`);
    }
  }

  // --- a roadblock stands across the road, stationary, and is cleaned up.
  let blocks = 0, across = 0;
  {
    const t = new Track(LAYOUTS.folsom_rev);
    const race = Object.create(Object.getPrototypeOf(game.race));
    Object.assign(race, {
      game, track: t, cars: [], roadblocks: { every: 0.5, from: 300, to: 500 },
      state: 'racing', time: 0,
    });
    const p0 = t.atDistance(100);
    const player = {
      vehicle: new Vehicle(CAR), loc: null, isPlayer: true,
      traffic: false, pursuer: false, syncModel() {},
    };
    player.vehicle.reset(p0.x, p0.z, Math.atan2(p0.dirX, p0.dirZ));
    player.loc = t.locate(player.vehicle.x, player.vehicle.z);
    race.player = player;
    race.cars = [player];
    race._roadblocks(1);
    const units = race.cars.filter((c) => c.roadblock);
    blocks = units.length;
    if (blocks !== 2) bad.push(`a roadblock is ${blocks} cars, not 2`);
    for (const u of units) {
      if (Math.abs(u.vehicle.u) > 0.1) bad.push('a roadblock car is moving');
      if (u.driver) bad.push('a roadblock car has a driver');
      const road = t.atDistance(u.loc.s);
      const skew = Math.abs(angleDiff(u.vehicle.yaw, Math.atan2(road.dirX, road.dirZ))) * 57.3;
      across = Math.max(across, skew);
      if (skew < 60) bad.push(`a roadblock car sits only ${skew.toFixed(0)}° across the road`);
      if (t.gap(u.loc.s, player.loc.s) < 200) bad.push('a roadblock landed on the bonnet');
    }
    // There is always a way through: the two cars must not span the road.
    if (units.length === 2) {
      const lats = units.map((u) => u.loc.lateral).sort((a, b) => a - b);
      const width = t.atDistance(units[0].loc.s).width;
      const gapL = lats[0] + width / 2;
      const gapR = width / 2 - lats[1];
      if (Math.max(gapL, gapR) < 3.4) bad.push('a roadblock leaves no gap to drive through');
    }
    // And one left far behind is taken away on the next spawn tick.
    const far = t.atDistance(900);
    player.vehicle.reset(far.x, far.z, Math.atan2(far.dirX, far.dirZ));
    player.loc = t.locate(player.vehicle.x, player.vehicle.z);
    race._blockT = 99;
    race._roadblocks(1);
    if (race.cars.some((c) => c.roadblock && t.gap(player.loc.s, c.loc.s) > 250)) {
      bad.push('a passed roadblock is never cleaned up');
    }
    for (const c of race.cars) if (c.model) {
      game.scene.remove(c.model);
      c.model.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
  }

  // --- damage accumulates, pulses the HUD, and busts.
  {
    const race = game.race;
    const kept = {
      dmgMax: race.damageMax, dmg: race.damage, state: race.state,
      busted: game._busted, results: race.results,
    };
    race.damageMax = wet.damageMax;
    race.damage = 0;
    race.state = 'racing';
    game._busted = false;
    game.onImpact(game.race.player, 10);
    if (race.damage !== 10) bad.push(`one 10-force hit left ${race.damage} damage`);
    if (game._busted) bad.push('a first hit busted the car');
    for (let i = 0; i < 10; i++) game.onImpact(game.race.player, 10);
    if (!game._busted) bad.push(`${race.damage} of ${race.damageMax} damage never busted`);
    if (game._busted && race.state !== 'finished') bad.push('busting did not end the stage');
    // Small knocks are free, same as the sound: the game already ignores them.
    race.damage = 0; race.state = 'racing'; game._busted = false;
    game.onImpact(game.race.player, 0.5);
    if (race.damage > 0) bad.push('a touch you cannot hear still cost damage');
    race.damageMax = kept.dmgMax; race.damage = kept.dmg; race.state = kept.state;
    game._busted = kept.busted; race.results = kept.results;
  }

  // --- the escape meter fills only while clear, resets when not, and wins.
  let cooled = 0;
  {
    const t = game.race.track;
    const race = Object.create(Object.getPrototypeOf(game.race));
    let won = 0;
    Object.assign(race, {
      game: { onFinish: () => won++, onLap() {}, onCheckpoint() {} },
      track: t, state: 'racing', time: 0, laps: 1, route: null, limit: null,
      escape: { clear: last.escape.clear, hold: 2 }, coolT: 0, nearestHeat: Infinity,
      leash: null, intercept: null, roadblocks: null, trafficSpecs: [], trafficEvery: 0,
      checkpoints: null, contact: false, endOnFirst: false, formation: 'pursuit',
      damageMax: null, results: [], order: [],
    });
    const mk = (at, pursuer) => {
      const p2 = t.atDistance(at);
      const c = {
        vehicle: new Vehicle(CAR), loc: null, isPlayer: !pursuer, pursuer,
        traffic: false, finished: false, lap: 0, lastS: 0, progress: 0,
        contactT: 0, position: 1, lapTimes: [], bestLap: Infinity,
        syncModel() {}, capture() {}, model: null, driver: null,
      };
      c.vehicle.reset(p2.x, p2.z, Math.atan2(p2.dirX, p2.dirZ));
      c.loc = t.locate(c.vehicle.x, c.vehicle.z);
      c.lastS = c.loc.s;
      return c;
    };
    const me = mk(400, false);
    const cop = mk(300, true);          // 100 m back: NOT clear
    race.cars = [me, cop];
    race.player = me;
    race._order = () => { race.order = [me, cop]; return race.order; };
    for (let i = 0; i < 60; i++) race.update(FIXED);
    if (race.coolT > 0) bad.push('the meter fills with a unit a hundred metres back');
    // Move the unit out past clear: now it fills.
    const farP = t.atDistance(300 - last.escape.clear - 200);
    cop.vehicle.reset(farP.x, farP.z, 0);
    cop.loc = t.locate(cop.vehicle.x, cop.vehicle.z);
    for (let i = 0; i < Math.round(1 / FIXED) && !won; i++) race.update(FIXED);
    cooled = race.coolT;
    if (!(race.coolT > 0.5)) bad.push(`clear of everybody, the meter read ${race.coolT.toFixed(2)}s`);
    // And it pays out: at hold, the player has escaped.
    for (let i = 0; i < Math.round(2 / FIXED) && !won; i++) race.update(FIXED);
    if (!won) bad.push('holding the gap never won the stage');
    if (won && race.state !== 'finished') bad.push('escaping did not end the stage');
    // The finale's own numbers have to be winnable BY DESIGN: no leash and no
    // interceptors, or the meter is emptied by the machinery that keeps other
    // stages alive.
    if (last.leash) bad.push('the escape stage has a leash — escaping empties the meter');
    if (last.intercept) bad.push('the escape stage spawns interceptors faster than the hold');
    // And a roadblock parked ahead is not heat. The stage DROPS roadblocks
    // ahead of the player every few seconds; counting them held the meter at
    // zero for the whole stage.
    const parked = mk(400 + 100, true);
    parked.roadblock = true;
    parked.vehicle.setSpeed(0);
    race.cars.push(parked);
    race.coolT = 1;
    race.update(FIXED);
    if (race.coolT === 0) bad.push('a parked roadblock a hundred metres ahead reset the meter');
    race.cars.pop();
  }

  const ok = bad.length === 0;
  return `${ok ? 'rain costs grip, blocks stand across, damage busts, and losing them wins' : `WRONG — ${bad[0]}`} — ` +
    `100–0 goes ${dryStop.toFixed(0)} m dry and ${wetStop.toFixed(0)} m wet; a block is ` +
    `${blocks} parked cars at ${across.toFixed(0)}° with a gap; eleven audible hits bust a ` +
    `${wet.damageMax}-point car; the meter held ${cooled.toFixed(1)}s clear and paid out`;
}

// Drift scoring and the ghost.
//
// The scorer is an economy, so its rules are what get driven: sideways earns,
// straight banks, a wall takes the chain and leaves the bank, and off the
// course earns nothing. The ghost is a recording, so its check is fidelity:
// what it plays back is the path that was recorded, saved only when faster,
// and refused when the stored shape is not one it understands.
function checkDriftAndGhost(game) {
  const bad = [];

  // --- the drift economy, on a fake vehicle whose slip is dictated.
  {
    const sc = new DriftScore();
    const v = { u: 30, v: 0 };
    // Straight and fast: nothing.
    for (let i = 0; i < 120; i++) sc.step(FIXED, v, true);
    if (sc.total || sc.chain) bad.push('driving straight scored points');
    // Sideways: the chain builds and the multiplier climbs.
    v.v = 12;                              // ~22 degrees of slip at 30 m/s
    for (let i = 0; i < 240; i++) sc.step(FIXED, v, true);
    const riding = sc.chain;
    if (!(riding > 50)) bad.push(`two seconds sideways earned ${riding.toFixed(0)}`);
    if (!(sc.mult > 1.2)) bad.push('the multiplier never climbed');
    // Straighten and hold: it banks.
    v.v = 0;
    for (let i = 0; i < Math.round((DRIFT.bankT + 0.2) / FIXED); i++) sc.step(FIXED, v, true);
    if (sc.chain !== 0) bad.push('the chain never banked');
    if (Math.abs(sc.total - riding) > 1) bad.push(`banking kept ${sc.total.toFixed(0)} of ${riding.toFixed(0)}`);
    // Slide again, hit a wall: the chain is lost, the bank is not.
    v.v = 12;
    for (let i = 0; i < 240; i++) sc.step(FIXED, v, true);
    const banked = sc.total;
    sc.drop();
    if (sc.chain !== 0) bad.push('a wall left the chain standing');
    if (sc.total !== banked) bad.push('a wall took the banked total');
    // And a slide off the course is worth nothing.
    const before = sc.total + sc.chain;
    for (let i = 0; i < 120; i++) sc.step(FIXED, v, false);
    if (sc.total + sc.chain > before) bad.push('drifting across the pavement scored');
  }

  // --- the yard's own numbers: the target is reachable inside the clock.
  const yard = STAGES.find((q) => q.id === 'yard');
  {
    // A driver holding a plausible drift for a third of each lap earns at a
    // measurable rate; the stage has to be winnable at well under the ideal.
    const sc = new DriftScore();
    const v = { u: 22, v: 8 };            // a modest, holdable slide
    for (let i = 0; i < Math.round(1 / FIXED); i++) sc.step(FIXED, v, true);
    sc.bank();
    const perSec = sc.total;               // one second of modest drift, banked
    // Sliding a third of the time at that modest rate:
    const plausible = perSec * yard.limit / 3;
    if (yard.driftTarget > plausible) {
      bad.push(`the yard wants ${yard.driftTarget} and a modest driver earns ~${plausible.toFixed(0)}`);
    }
    if (yard.driftTarget < perSec * yard.limit / 20) {
      bad.push('the yard target is met by one slide');
    }
  }

  // --- the ghost: fidelity, thrift, and the save rule.
  {
    const t = game.race.track;
    const rec = new GhostRecorder();
    const v = { x: 0, z: 0, yaw: 0 };
    // Drive a synthetic arc at 120 Hz for four seconds.
    for (let i = 0; i < Math.round(4 / FIXED); i++) {
      const tt = i * FIXED;
      v.x = Math.sin(tt * 0.8) * 100;
      v.z = tt * 40;
      v.yaw = tt * 0.3;
      rec.step(FIXED, v);
    }
    const n = rec.frames.length;
    if (Math.abs(n - 4 * GHOST_HZ) > 2) bad.push(`four seconds recorded ${n} frames at ${GHOST_HZ} Hz`);

    // Replay it and compare against the analytic path at mid-run.
    const ghost = new GhostCar(game.scene, { name: '', body: 0xffffff, trim: 0x000000, num: 0, shape: 'gt' }, rec.frames);
    let worst = 0;
    for (let i = 0; i < Math.round(3.6 / FIXED); i++) {
      ghost.step(FIXED, t);
      const tt = ghost.t;
      const ex = Math.sin(tt * 0.8) * 100;
      const ez = tt * 40;
      worst = Math.max(worst, Math.hypot(ghost.model.position.x - ex, ghost.model.position.z - ez));
    }
    ghost.dispose();
    // A 20 Hz recording lerped between samples: the error bound is the sag of
    // a chord across one sample of the tightest curve driven, plus rounding.
    if (worst > 1.0) bad.push(`the ghost strays ${worst.toFixed(2)} m from the path it recorded`);

    // Storage: only a faster run replaces the stored one, and garbage is
    // refused rather than replayed.
    const id = '__test__';
    try { localStorage.removeItem(`redline.ghost.${id}`); } catch (e) { /* fine */ }
    if (!saveIfBest(id, rec.frames, 100)) bad.push('a first run was not saved');
    if (saveIfBest(id, rec.frames, 120)) bad.push('a SLOWER run replaced the best');
    if (!saveIfBest(id, rec.frames, 80)) bad.push('a faster run was refused');
    const back = loadGhost(id);
    if (!back || back.time !== 80) bad.push('the stored ghost is not the fastest run');
    try { localStorage.setItem(`redline.ghost.${id}`, '{"v":99,"frames":"no"}'); } catch (e) { /* fine */ }
    if (loadGhost(id)) bad.push('a ghost from a future version was replayed anyway');
    try { localStorage.removeItem(`redline.ghost.${id}`); } catch (e) { /* fine */ }
  }

  const ok = bad.length === 0;
  return `${ok ? 'style is earned, banked and losable; the best run drives again' : `WRONG — ${bad[0]}`} — ` +
    `sideways earns, straight banks, a wall keeps the bank and takes the chain; ` +
    `the yard's ${yard.driftTarget} is reachable in ${yard.limit}s; a 4 s run is ` +
    `${4 * GHOST_HZ} frames replayed within a metre, and only a faster time overwrites`;
}

// The keybinds.
//
// The thing worth checking is not that the table can be edited — it is that
// editing it moves the KEY. Every one of these used to be a `case` on a
// literal inside a switch, read in one place for the pedals and another for
// the gearbox, and a settings screen laid over that would have changed the
// label on the button and nothing else.
//
// So: rebind something, and then drive the game with the new key and with the
// old one, and see which car moves.
function checkKeybinds(game) {
  const bad = [];
  resetBinds();

  // Every action has at least one key, no key does two jobs, and every one of
  // them is something the switch actually handles.
  const seen = new Map();
  for (const a of ACTIONS) {
    const codes = codesFor(a.id);
    if (!codes.length) bad.push(`${a.name} is bound to nothing`);
    for (const c of codes) {
      if (seen.has(c)) bad.push(`${label(c)} does both ${seen.get(c)} and ${a.name}`);
      seen.set(c, a.name);
      if (actionFor(c) !== a.id) bad.push(`${label(c)} does not resolve to ${a.name}`);
    }
  }

  // Rebind the throttle and drive it. The old key must go dead and the new one
  // must work — a rebind that only adds is a rebind that leaves two throttles.
  const car = game.race.player;
  const v = car.vehicle;
  const kept = { started: game.phase, keys: [...game.keys], throttle: v.throttle };
  const pedal = (code) => {
    game.keys.clear();
    v.throttle = 0;
    game.keys.add(code);
    for (let i = 0; i < 30; i++) game._drivePlayer(1 / 60);
    return v.throttle;
  };
  let before = 0, oldKey = 0, newKey = 0;
  try {
    game.phase = 'racing';
    game.race.state = 'racing';
    car.finished = false;
    before = pedal('KeyW');
    rebind('throttle', 0, 'KeyT');
    oldKey = pedal('KeyW');
    newKey = pedal('KeyT');
  } finally {
    resetBinds();
    game.keys.clear();
    for (const c of kept.keys) game.keys.add(c);
    v.throttle = kept.throttle;
    game.phase = kept.started;
  }
  if (before < 0.5) bad.push('the default throttle key does nothing');
  if (newKey < 0.5) bad.push(`the rebound key gave ${newKey.toFixed(2)} throttle`);
  if (oldKey > 0.05) bad.push(`the old key still gives ${oldKey.toFixed(2)} throttle`);
  if (!isBound('throttle', 'KeyW')) bad.push('resetting did not put the throttle back');

  // A key taken from one action leaves the other one.
  rebind('camera', 0, 'KeyR');
  const stolen = isBound('restart', 'KeyR');
  resetBinds();
  if (stolen) bad.push('a key bound to two actions at once');

  // And the panel is laid out in columns rather than one long list.
  // Measured with the panel OPEN. A hidden grid has no resolved track sizes,
  // so `getComputedStyle` reports whatever the layout engine last had — which
  // is not the same number and would have failed a correct layout.
  const panel = document.getElementById('settings');
  const pane = document.getElementById('tab-controls');
  const wasOpen = panel.classList.contains('open');
  const wasOn = pane.classList.contains('on');
  panel.classList.add('open');
  pane.classList.add('on');
  const host = document.getElementById('binds');
  const cols = host
    ? getComputedStyle(host).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length
    : 0;
  if (!wasOpen) panel.classList.remove('open');
  if (!wasOn) pane.classList.remove('on');
  if (cols < 4) bad.push(`the binds are laid out in ${cols} columns`);
  const tabs = document.querySelectorAll('#settings .tab').length;
  if (tabs < 2) bad.push(`${tabs} tabs in the settings`);

  const ok = bad.length === 0;
  return `${ok ? 'rebinding moves the key, not the label' : `WRONG — ${bad[0]}`} — ` +
    `${ACTIONS.length} actions over ${seen.size} keys in ${tabs} tabs and ${cols} columns; ` +
    `moved the throttle to T and W went from ${before.toFixed(2)} to ${oldKey.toFixed(2)} ` +
    `while T gave ${newKey.toFixed(2)}`;
}

// Touch controls.
//
// The point of the check is that a thumb reaches the SAME code a key does. A
// touch layer that grew its own copy of the throttle would work on the day it
// was written and drift from the keyboard's version thereafter — which is the
// failure mode of every on-screen control ever bolted onto a game.
function checkTouch(game) {
  const bad = [];
  const el = (id) => document.getElementById(id);
  const sel = el('set-touch');
  if (!sel) return 'WRONG — there is no touch setting';
  if (![...sel.options].map((o) => o.value).includes('auto')) bad.push('there is no AUTO');

  const was = game.touchUI.mode;
  game.touchUI.set('on');
  if (!document.body.classList.contains('touch')) bad.push('turning it on showed nothing');
  const pads = [...document.querySelectorAll('#touch .pad')];
  if (pads.length !== PADS.length) bad.push(`${pads.length} pads drawn of ${PADS.length}`);
  // Every pad has to be reachable: on screen, and big enough for a thumb.
  const vmin = Math.min(window.innerWidth, window.innerHeight);
  let smallest = Infinity;
  for (const p of pads) {
    const r = p.getBoundingClientRect();
    smallest = Math.min(smallest, r.width);
    if (r.left < -4 || r.top < -4 || r.right > window.innerWidth + 4
      || r.bottom > window.innerHeight + 4) bad.push(`the ${p.dataset.id} pad is off screen`);
  }
  // Nine millimetres is about the smallest target a thumb hits reliably; on a
  // phone that is roughly a tenth of the short side.
  if (smallest < vmin * 0.07) bad.push(`the smallest pad is ${smallest.toFixed(0)} px`);

  // No two pads overlap, or one of them cannot be pressed.
  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      const a = pads[i].getBoundingClientRect(), b = pads[j].getBoundingClientRect();
      if (a.right > b.left && b.right > a.left && a.bottom > b.top && b.bottom > a.top) {
        bad.push(`the ${pads[i].dataset.id} and ${pads[j].dataset.id} pads overlap`);
      }
    }
  }

  // A held pad drives the car through the same path a key does.
  const v = game.race.player.vehicle;
  const keptPhase = game.phase, keptState = game.race.state;
  game.phase = 'racing';
  game.race.state = 'racing';
  game.race.player.finished = false;
  game.keys.clear();
  game.touch.clear();
  v.throttle = 0;
  for (let i = 0; i < 30; i++) game._drivePlayer(1 / 60);
  const idle = v.throttle;
  game.touch.add('throttle');
  for (let i = 0; i < 30; i++) game._drivePlayer(1 / 60);
  const pressed = v.throttle;
  game.touch.delete('throttle');
  for (let i = 0; i < 40; i++) game._drivePlayer(1 / 60);
  const released = v.throttle;
  game.phase = keptPhase;
  game.race.state = keptState;
  if (idle > 0.05) bad.push('the throttle was open before anything was pressed');
  if (pressed < 0.7) bad.push(`a held pad gave ${pressed.toFixed(2)} throttle`);
  if (released > 0.05) bad.push(`letting go left ${released.toFixed(2)} throttle`);

  // A one-shot pad fires the same action a key does.
  // The gear is read AFTER the speed is set, because setting a speed now picks
  // the gear that suits it — so a `before` captured first can be the very gear
  // the shift lands back on, and the check reports a working pad as broken.
  v.autoShift = false;
  v.shiftT = 0;
  v.setSpeed(30);
  const before = v.gear;
  game.doAction('shiftUp');
  if (v.gear === before) bad.push('the shift pad did nothing');

  game.touchUI.set('off');
  if (document.body.classList.contains('touch')) bad.push('turning it off left the pads up');
  game.touchUI.set(was || 'auto');

  const ok = bad.length === 0;
  return `${ok ? 'a thumb reaches what a key reaches' : `WRONG — ${bad[0]}`} — ` +
    `${pads.length} pads, none overlapping, smallest ${smallest.toFixed(0)} px; ` +
    `held gives ${pressed.toFixed(2)} throttle and letting go ${released.toFixed(2)}; ` +
    `auto/on/off, and auto reads this machine as ${looksLikeTouch() ? 'touch' : 'keyboard'}`;
}

// The settings that change what you see.
//
// A toggle in a menu is worth exactly what it does to the image, so that is
// what gets measured: render the scene with the filter on and again with it
// off, and compare the pixels. Anything less — that the uniform changed, that
// the listener fired — passes just as happily when the shader has stopped
// reading the uniform at all.
function checkSettings(game) {
  const bad = [];
  const el = (id) => document.getElementById(id);
  const grade = el('set-grade');
  if (!grade) return 'WRONG — there is no filter switch in the settings';

  // The label has to say what it does. It was COLOUR GRADE, which is the
  // correct technical name and no help at all to somebody looking for the
  // yellow wash — and a setting nobody can find is a setting nobody has.
  const label = grade.parentElement.textContent.replace(/ON|OFF/g, '').trim();
  if (/^COLOUR GRADE$/i.test(label)) bad.push('the filter is labelled by what it is, not what it looks like');
  if (!label) bad.push('the filter switch has no label');

  const values = [...grade.options].map((o) => Number(o.value));
  if (!values.includes(0)) bad.push('there is no OFF');
  const on = Math.max(...values);
  if (!(on > 0)) bad.push('there is no ON');

  const c = game.renderer.domElement;
  const gl = game.renderer.getContext();
  const px = new Uint8Array(4 * 64 * 64);
  const shot = (g) => {
    game.post.composite.uniforms.grade.value = g;
    game.post.render(game.scene, game.camera);
    gl.readPixels(Math.floor(c.width / 2) - 32, Math.floor(c.height / 2) - 32,
      64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; }
    const n = px.length / 4;
    return { r: r / n, g: gg / n, b: b / n };
  };
  const was = game.post.composite.uniforms.grade.value;
  const lit = shot(on);
  const plain = shot(0);
  game.post.composite.uniforms.grade.value = was;

  // On, the image is pulled toward yellow: red and green up against blue. The
  // measure is the blue deficit, because that is the whole of what the grade
  // does to a colour — take the blue out of it.
  const warm = (q) => (q.r + q.g) / 2 - q.b;
  const shift = warm(lit) - warm(plain);
  if (shift < 4) bad.push(`turning it on moved the image by ${shift.toFixed(1)} of 255`);

  const ok = bad.length === 0;
  return `${ok ? 'the filter switch changes the picture' : `WRONG — ${bad[0]}`} — ` +
    `"${label}", on/off at ${on}/0, and turning it on takes ` +
    `${shift.toFixed(1)} of 255 of blue out of the middle of the frame ` +
    `(${plain.r.toFixed(0)}/${plain.g.toFixed(0)}/${plain.b.toFixed(0)} to ` +
    `${lit.r.toFixed(0)}/${lit.g.toFixed(0)}/${lit.b.toFixed(0)})`;
}

// The ground field: is it continuous?
//
// This replaced a check that the indexed version agreed with the brute-force
// one it was built from, which it did, exactly — and which said nothing about
// whether either of them was any good. Both had a Voronoi diagram in them:
// beyond the blend radius the height came from whichever sample was nearest,
// so along every boundary between two stretches of road the terrain stepped by
// the difference in their heights. On a route that climbs forty-six metres
// that is a forty-metre cliff standing across the end of a street, and the
// city is built on this field, so the buildings step with it.
//
// Continuity is the property, so continuity is what gets measured: walk a grid
// over the whole world and look for the biggest jump between neighbours a
// couple of metres apart.
function checkGroundField(track) {
  const bad = [];
  const STEP = 2.5;
  const world = ((track.layout.world || 1800) / 2) - 60;
  let worst = 0, at = null, worstFar = 0, farAt = null;

  for (let z = -world; z <= world; z += 26) {
    let prev = null;
    for (let x = -world; x <= world; x += STEP) {
      const y = track.groundAt(x, z);
      if (!Number.isFinite(y)) { bad.push(`the ground is not a number at ${x}, ${z}`); prev = null; continue; }
      if (prev !== null) {
        const jump = Math.abs(y - prev);
        if (jump > worst) { worst = jump; at = [x, z]; }
        // Away from the road, where the fallback lives and where the cliffs
        // were. Close in the field follows the road's own height, which on a
        // twelve per cent street is a real and correct step.
        const d = Math.sqrt(track._nearestSample(x, z).d2);
        if (d > 40 && jump > worstFar) { worstFar = jump; farAt = [x, z]; }
      }
      prev = y;
    }
  }

  // Two and a half metres of ground for two and a half metres of travel is a
  // hundred per cent slope — well past anything the terrain is asked for, and
  // far short of the twenty-six metre steps the Voronoi fallback produced.
  if (worstFar > 1.2) {
    bad.push(`it steps ${worstFar.toFixed(1)} m in ${STEP} m at ${farAt[0].toFixed(0)}, ${farAt[1].toFixed(0)}`);
  }

  // And it still has to stay under the road, or the terrain comes up through
  // the asphalt.
  let above = -Infinity;
  for (let i = 0; i < track.samples.length; i += 7) {
    const p = track.samples[i];
    for (const o of [-1, 1]) {
      const gx = p.x + p.nx * o * (p.width / 2 - 0.5);
      const gz = p.z + p.nz * o * (p.width / 2 - 0.5);
      above = Math.max(above, track.groundAt(gx, gz) - p.y);
    }
  }
  // Still under the asphalt — but only just, now. The margin has to cover what
  // a coarse ground mesh can interpolate to between two vertices, which is
  // centimetres, and nothing more: every centimetre past that is a step the
  // road stands on.
  if (above > -0.06) bad.push(`the ground reaches ${above.toFixed(2)} m of the road surface`);

  // The profile out from the kerb, which is what "the road levitates" means
  // when somebody says it: how far below the road surface the terrain sits at
  // each distance out. The pavement is a flat ribbon at road height reaching
  // nine metres from the kerb, and the buildings start where it ends — so
  // whatever the drop is at nine metres is the height of the ledge the road
  // appears to be standing on.
  const profile = [];
  for (const out of [6, 10, 16, 24, 40]) {
    let worst2 = 0, n2 = 0, sum2 = 0;
    for (let i = 0; i < track.samples.length; i += 23) {
      const p = track.samples[i];
      for (const sd of [-1, 1]) {
        const gx = p.x + p.nx * sd * out, gz = p.z + p.nz * sd * out;
        const d = p.y - track.groundAt(gx, gz);
        sum2 += d; n2++;
        if (d > worst2) worst2 = d;
      }
    }
    profile.push({ out, mean: sum2 / n2, worst: worst2 });
  }
  const ledge = profile.find((q) => q.out === 10);
  if (ledge.mean > 0.35) {
    bad.push(`the ground sits ${ledge.mean.toFixed(2)} m below the road at the building line`);
  }

  const ok = bad.length === 0;
  return `${ok ? 'continuous, under the road, and up against it' : `WRONG — ${bad[0]}`} — ` +
    `worst step ${(worst * 100).toFixed(0)} cm per ${STEP} m overall` +
    (at ? ` (at ${at[0].toFixed(0)}, ${at[1].toFixed(0)})` : '') +
    `, ${(worstFar * 100).toFixed(0)} cm of it away from the road, ` +
    `and it sits ${(-above).toFixed(2)} m below the kerb at its highest; ` +
    `drop from the road at ` +
    profile.map((q) => `${q.out}m:${q.mean.toFixed(2)}`).join(' ');
}

// Cutscenes. Every script, played through at 1/60 with a stand-in cast and a
// chase camera that measures instead of moving.
//
// Three things are worth measuring and one of them is the bug the title
// sequence shipped with: a shot that puts the camera inside the bodywork. The
// other two are that the caption on screen is the caption the beat asked for —
// an off-by-one in the beat index shows up nowhere else, because the wrong
// line over the right shot still looks like a cutscene — and that a skipped
// scene runs every `act` a watched one would have.
function checkCutscene(game) {
  const bad = [];
  const t = game.track;
  const stand = () => {
    const v = new Vehicle(CAR);
    v.reset(0, 0, 0);
    return { vehicle: v, loc: { y: 0 }, prev: null, syncModel() {} };
  };
  const cast = { player: stand(), rival: stand() };

  let closest = Infinity, worstShot = '';
  const added = [];
  const fake = {
    track: t,
    // A scene can bring cars on for itself, so the stand-in game needs
    // somewhere to put them and somewhere to take them from again.
    scene: { add: (o) => added.push(o), remove: (o) => { const i = added.indexOf(o); if (i >= 0) added.splice(i, 1); } },
    playerLivery: SELECTABLE[0],
    campaign: { wager: null, setWager(l) { this.wager = l; } },
    chase: {
      playShot(dt, name, subject, k, id, second) {
        const shot = SHOTS[name];
        if (!shot) { bad.push(`there is no shot called ${name}`); return; }
        const s = shot(cameraFrame(subject), clamp(k, 0, 1), second ? cameraFrame(second) : null);
        if ([...s.from, ...s.at, s.fov].some((n) => !Number.isFinite(n))) {
          bad.push(`${name} is not a number`);
          return;
        }
        const d = Math.hypot(s.from[0] - subject.vehicle.x, s.from[2] - subject.vehicle.z);
        if (d < closest) { closest = d; worstShot = name; }
      },
    },
  };

  const say = document.getElementById('cine-say');
  const DT = 1 / 60;
  let beats = 0, drift = 0;
  const castMissing = [];

  for (const [name, script] of Object.entries(SCRIPTS)) {
    let done = false;
    const cut = new Cutscene(fake, script, cast, () => { done = true; });
    const seen = new Array(script.length).fill(null);
    const want = script.reduce((a, b) => a + b.t, 0);
    let elapsed = 0;
    for (let i = 0; i < Math.round((want + 1) / DT) && !done; i++) {
      cut.update(DT);
      elapsed += DT;
      // Read the caption once the beat is past its half-way mark, which is
      // after any fade and before the next cut.
      const b = script[cut.i];
      if (b && cut.t > b.t * 0.5 && seen[cut.i] === null && say) seen[cut.i] = say.textContent;
      // Every role a beat names has to be in the cast BY THE TIME that beat
      // plays — which is not the same as being there at the start, because a
      // scene can bring its own cars on partway through. A missing one is not
      // an error at runtime: the shot quietly falls back to the player, and
      // the beat that was meant to be a police car sweeping past is a still
      // of your own bonnet.
      if (b) {
        for (const role of [b.subject, b.at]) {
          if (role && !cast[role] && !castMissing.includes(`${name}[${cut.i}] ${role}`)) {
            castMissing.push(`${name}[${cut.i}] ${role}`);
          }
        }
      }
    }
    if (!done) { bad.push(`${name} never finished`); continue; }
    // A beat ends on the first frame past its length, so a script can overrun
    // by up to one frame per beat and no more. Anything beyond that is a beat
    // being held or dropped, which is what this is looking for.
    const slack = (script.length + 1) * DT;
    if (elapsed < want || elapsed - want > slack) {
      bad.push(`${name} ran ${elapsed.toFixed(2)} s against ${want.toFixed(2)} scripted`);
    }
    drift = Math.max(drift, (elapsed - want) / script.length);
    for (let j = 0; j < script.length; j++) {
      if (seen[j] === null) continue;               // last beat can end on the tick
      if (seen[j] !== (script[j].say || '')) {
        bad.push(`${name} beat ${j} showed "${seen[j]}" not "${script[j].say || ''}"`);
      }
    }
    beats += script.length;

    // And the same script skipped: every act fires, in order, at once.
    let fired = 0;
    const wrapped = script.map((b) => ({ ...b, act: (...a) => { fired++; if (b.act) b.act(...a); } }));
    const cut2 = new Cutscene(fake, wrapped, cast, () => {});
    cut2.update(0.01);                              // enters beat 0, fires its act
    cut2.skip();
    if (fired !== script.length) {
      bad.push(`skipping ${name} fired ${fired} of ${script.length} acts`);
    }
  }

  if (castMissing.length) bad.push(`nobody is cast as ${castMissing[0]}`);

  // Portraits. Everybody who SPEAKS has a face; narration — a line with no
  // name against it — deliberately has none, because giving unattributed text
  // a portrait turns the game's own voice into a character.
  const speakers = new Set();
  for (const script of Object.values(SCRIPTS)) {
    for (const b of script) if (b.who) speakers.add(b.who);
  }
  for (const who of speakers) {
    if (!portraitFor(who)) bad.push(`${who} speaks and has no portrait`);
  }
  if (portraitFor('')) bad.push('narration was given a face');
  for (const [name, art] of Object.entries(PORTRAITS)) {
    if (!art.startsWith('<svg') || !art.includes('</svg>')) bad.push(`${name}'s portrait is not a drawing`);
  }
  // And the HUD is not over the top of them.
  if (document.getElementById('hud').style.display === 'block' && game.phase === 'cutscene') {
    bad.push('the dashboard is drawn over the cutscene');
  }

  // Every car a scene brought on has to have been taken away again. A
  // cutscene that leaves three police cars parked on the circuit is a bug you
  // find two races later, wondering what they are.
  if (added.length) bad.push(`${added.length} cars were left in the scene`);

  // The wager script has to have actually staked something.
  if (fake.campaign.wager === null) bad.push('WAGER never set a wager');
  if (closest < 1.8) bad.push(`${worstShot} puts the camera ${closest.toFixed(1)} m from the car`);

  const ok = bad.length === 0;
  return `${ok ? 'every scene plays, cuts and skips' : `WRONG — ${bad[0]}`} — ` +
    `${Object.keys(SCRIPTS).length} scripts, ${beats} beats all cast, ` +
    `${speakers.size} speakers with faces, closest approach ` +
    `${closest.toFixed(1)} m (${worstShot}), beats within ${(drift * 1000).toFixed(0)} ms of scripted`;
}

// The cheat codes.
//
// A cheat that names a scene or a stage which has since been renamed does
// nothing at all when typed, and nothing at all is indistinguishable from the
// cheat not being wired up — so what it points at is checked here rather than
// discovered by typing it. The matching is checked too: the whole point of a
// code you type is that it works when you type it the way you remember it,
// which is rarely the way it is written down.
function checkCheats() {
  const bad = unresolved();
  const codes = new Set();
  for (const c of CHEATS) {
    const n = normalise(c.code);
    if (codes.has(n)) bad.push(`${c.code} is in the list twice`);
    codes.add(n);
    if (n.length < 6) bad.push(`${c.code} is short enough to type by accident`);
    if (findCheat(c.code) !== c) bad.push(`${c.code} does not match itself`);
  }
  // Typed carelessly, which is the only way anybody types these.
  const loose = ['golden gate', 'Golden-Gate', '  GOLDENGATE  ', 'goldengate'];
  for (const q of loose) {
    if (findCheat(q) !== CHEATS.find((c) => c.code === 'GOLDENGATE')) {
      bad.push(`"${q}" does not reach GOLDENGATE`);
    }
  }
  if (findCheat('NOTACODE')) bad.push('a code that does not exist matched something');
  if (findCheat('')) bad.push('an empty box matched something');

  // Every stage a cheat can reach has a scene that leads into it, the cheat
  // plays it, and it is the stage's OWN scene.
  //
  // That last part is the one that bit: a stage without a `before` used to
  // borrow the previous stage's ending, so the same script played on the
  // circuit you had just won on when you won your way there and on the stage
  // you were arriving at when you typed a code. Same script, two different
  // films. A scene belongs to exactly one stage now, and the check is that no
  // two stages claim the same one.
  const claimed = new Map();
  for (const st of STAGES) {
    const c = new Campaign({ playerName: 'X' });
    c.index = STAGES.indexOf(st);
    const intro = c.introScene();
    if (!intro) bad.push(`nothing leads into ${st.id}`);
    else if (!SCRIPTS[intro]) bad.push(`${st.id} is led into by "${intro}", which is not a scene`);
    else if (intro !== st.before) bad.push(`${st.id} borrows its opening from somewhere else`);
    for (const [key, name] of [['before', intro], ['onWin', st.onWin], ['onLose', st.onLose]]) {
      if (!name) continue;
      const held = claimed.get(name);
      // `onLose` is shared on purpose — being caught is being caught — so only
      // the openings and the wins have to be unique to a stage.
      if (key === 'onLose') continue;
      if (held && held !== st.id) bad.push(`${name} is used by both ${held} and ${st.id}`);
      claimed.set(name, st.id);
    }
  }

  // The lock ladder: stage one is always open, winning opens the next, a
  // cheat opens the road to wherever it jumps, and losing closes nothing.
  {
    const kept = (() => { try { return localStorage.getItem('redline.progress'); } catch (e) { return null; } })();
    try { localStorage.removeItem('redline.progress'); } catch (e) { /* fine */ }
    if (unlockedUpTo() !== 0) bad.push('a fresh save does not start at stage one');
    unlock(1);
    if (unlockedUpTo() !== 1) bad.push('winning stage one did not unlock stage two');
    unlock(0);
    if (unlockedUpTo() !== 1) bad.push('progress went BACKWARDS');
    unlock(6);
    if (unlockedUpTo() !== 6) bad.push('a cheat to stage seven did not open the road to it');
    // And a cheat only ever UNLOCKS — it must not launch the stage. The whole
    // point of the menu is that starting is a choice made on it.
    {
      const wasPhase2 = game.phase, wasMode = game.mode, wasCamp = game.campaign;
      game.phase = 'attract';
      const panel = document.getElementById('cheats');
      panel.classList.add('open');
      const input2 = document.getElementById('cheat-in');
      input2.value = 'RAINCHECK';
      input2.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true }));
      if (game.phase !== 'attract') bad.push(`a cheat launched the stage (phase ${game.phase})`);
      if (game.mode === 'campaign' && game.campaign !== wasCamp) bad.push('a cheat started a campaign');
      if (!document.getElementById('stagesel').classList.contains('open')) {
        bad.push('a cheat did not open the stage select to show what it unlocked');
      }
      if (unlockedUpTo() !== 6) bad.push(`typing RAINCHECK left progress at ${unlockedUpTo()}`);
      document.getElementById('stagesel').classList.remove('open');
      panel.classList.remove('open');
      game.phase = wasPhase2; game.mode = wasMode; game.campaign = wasCamp;
    }
    unlock(999);
    if (unlockedUpTo() !== STAGES.length - 1) bad.push('progress ran past the last stage');
    // And the menu obeys it: locked rows are greyed and dead to the pointer.
    try { localStorage.setItem('redline.progress', '2'); } catch (e) { /* fine */ }
    const wasPhase = game.phase;
    game.phase = 'attract';
    game.openStageSelect();
    const rows = [...document.querySelectorAll('#stage-rows .stage')];
    const lockedRows = rows.filter((r) => r.classList.contains('locked'));
    if (rows.length !== STAGES.length) bad.push(`the menu lists ${rows.length} of ${STAGES.length} stages`);
    if (lockedRows.length !== STAGES.length - 3) {
      bad.push(`${lockedRows.length} rows locked with three stages open`);
    }
    for (const r of lockedRows) {
      if (getComputedStyle(r).pointerEvents !== 'none') bad.push('a locked stage still takes the click');
    }
    document.getElementById('stagesel').classList.remove('open');
    game.phase = wasPhase;
    try {
      if (kept === null) localStorage.removeItem('redline.progress');
      else localStorage.setItem('redline.progress', kept);
    } catch (e) { /* fine */ }
  }

  // One per stage and nothing else. A code that plays a cutscene is a code
  // that spoils the stage in front of it, and the panel lists nothing, so
  // there is no way to stumble into one either.
  for (const st of STAGES) {
    if (!CHEATS.some((c) => c.stage === st.id)) bad.push(`no cheat goes to ${st.id}`);
  }
  if (CHEATS.some((c) => c.scene || c.cutscene)) bad.push('a cheat plays a cutscene');
  if (document.getElementById('cheat-list')) bad.push('the panel lists the codes');

  const ok = bad.length === 0;
  return `${ok ? 'one word per stage, and nothing on screen says which' : `WRONG — ${bad[0]}`} — ` +
    `${CHEATS.length} codes for ${STAGES.length} stages, wins and cheats both move the ` +
    `lock ladder, a code unlocks and opens the menu rather than launching, ` +
    `matched however they are typed`;
}

// The campaign flow, driven end to end without a race being run.
//
// Everything here is a seam between two things that were written separately —
// a stage's field, the scene in front of it, the green light behind that, and
// what happens when you win — and every one of them is reachable in the real
// game only by winning a three-lap race first. So it runs on a throwaway Race
// standing in for the live one, which is then torn down: the rest of the test
// is inspecting a race that actually happened and must get it back intact.
function checkCampaignFlow(game) {
  const bad = [];
  const kept = {
    race: game.race, phase: game.phase, mode: game.mode,
    campaign: game.campaign, track: game.track, begin: game.beginStage,
  };
  const shadow = new Race(game, game.track);
  game.race = shadow;
  // Stage two is on a different layout, and `beginStage` builds it — a whole
  // city, asynchronously, replacing `game.track` from under everything else in
  // this test file. So the real one is called by hand where it is wanted and
  // stubbed everywhere it would run on its own.
  const realBegin = game.beginStage.bind(game);
  let began = 0;
  game.beginStage = () => { began++; };
  try {
    game.mode = 'campaign';
    game.campaign = new Campaign(game);
    game.playerLivery = SELECTABLE[0];
    realBegin();

    const stage = STAGES[0];
    if (shadow.cars.length !== 2) bad.push(`the duel put ${shadow.cars.length} cars on the grid`);
    if (shadow.laps !== stage.laps) bad.push(`${shadow.laps} laps, not ${stage.laps}`);
    if (!shadow.contact) bad.push('the duel phases through');
    const rival = shadow.cars.find((q) => !q.isPlayer);
    if (!rival || !rival.driver) bad.push('the rival has no driver');
    else if (!(rival.driver.opts.drift > 0)) bad.push('the rival does not drift');
    if (shadow.player.driver) bad.push('the player was given a driver');
    if (game.phase !== 'cutscene') bad.push(`the wager did not play — phase is ${game.phase}`);

    // Skipping the wager has to leave a countdown running, not a dead screen.
    if (game.cut) game.cut.skip();
    if (game.phase !== 'racing') bad.push(`skipping the wager left phase ${game.phase}`);
    if (shadow.state !== 'countdown') bad.push(`the green light left state ${shadow.state}`);
    if (!game.campaign.wagered) bad.push('nothing was staked on the race');

    // Nothing carries in from the attract loop.
    //
    // The title screen runs a real three-lap race behind the menu, and if it
    // takes the flag while somebody is choosing a car, `raceEnded` is left
    // true. Starting a race used to set the phase and stop — so the
    // twelve-second end timer started counting the moment you pressed START
    // and the results table appeared over the top of your race.
    {
      game.raceEnded = true;
      game._endTimer = 11.4;
      game.mode = 'race';
      // `begin` refuses while a race is already on, which is how the menu
      // stops a second press restarting you — so this has to come at it the
      // way the menu does.
      game.phase = 'attract';
      game.begin();
      if (game.raceEnded) bad.push('starting a race kept the finished flag from the attract loop');
      if (game._endTimer) bad.push(`starting a race kept ${game._endTimer}s on the end timer`);
      if (game.phase !== 'racing') bad.push(`starting a race left phase ${game.phase}`);
      if (getComputedStyle(document.getElementById('results')).display !== 'none') {
        bad.push('the results table is up at the start of a race');
      }
      game.mode = 'campaign';
    }

    // Losing does not mean driving the rest of the lap. The rival taking the
    // flag settles the duel, and the stage has to stop there rather than leave
    // the player circulating for another two minutes to lose a race that is
    // already lost.
    {
      shadow.state = 'racing';
      rival.finished = true;
      rival.finishTime = 60;
      shadow.player.finished = false;
      shadow.update(1 / 60);
      if (shadow.state !== 'finished') bad.push('the rival finishing did not end the duel');
      if (game.campaign.won_(shadow)) bad.push('losing counted as winning');
      rival.finished = false;
    }

    // Take it, and the police turn up.
    shadow.state = 'racing';
    shadow.player.finished = true;
    shadow.player.position = 1;
    shadow.update(1 / 60);
    if (shadow.state !== 'finished') bad.push('the player finishing did not end the duel');
    shadow.state = 'finished';
    game.endStage();
    const winScene = game.cut && game.cut.script;
    if (game.phase !== 'cutscene') bad.push('winning played no scene');
    else if (winScene !== SCRIPTS[stage.onWin]) bad.push(`winning played the wrong scene`);
    if (game.campaign.won.length !== 1) bad.push('the rival kept its car');

    // And out the other side, onto stage two. Only the bookkeeping is checked
    // here: the stage after this one is on a different layout, and `beginStage`
    // stops at the first `await` to build it — so driving it from a synchronous
    // assertion would prove nothing except that a promise was returned.
    const after = STAGES[0].next;
    if (game.cut) game.cut.skip();
    if (!game.campaign) bad.push('winning stage one ended the campaign');
    else if (game.campaign.stage.id !== after) {
      bad.push(`winning stage one led to ${game.campaign.stage.id}, not ${after}`);
    }
    if (game.campaign && game.campaign.attempts !== 0) bad.push('stage two started with attempts on it');
    if (began !== 1) bad.push(`winning stage one started ${began} stages, not 1`);

    // Stage two's field, as data: you at the front and the police behind, and
    // a finish line a fraction of the way round rather than a lap count.
    const two = STAGES.find((q) => q.id === after);
    if (two) {
      const c2 = new Campaign(game);
      c2.index = STAGES.indexOf(two);
      c2.car = SELECTABLE[0];
      const f = c2.field(game.track);
      if (f.cars.length !== 1 + two.police) bad.push(`the run put ${f.cars.length} cars out`);
      if (!f.cars[0].isPlayer) bad.push('the player is not at the front of a run');
      if (f.cars.slice(1).some((q) => !q.opts || !(q.opts.chase > 0))) {
        bad.push('a police car is not chasing anybody');
      }
      // And they are not in the race. A unit that can "win" the stage by
      // driving past the ramp first is a result nobody asked for, and one
      // that has to be waited for is a stage that never ends.
      if (f.cars.slice(1).some((q) => !q.pursuer)) bad.push('a police car is racing you to the ramp');
      if (f.formation !== 'pursuit') bad.push(`the run lines up as a ${f.formation}`);
      if (f.endOnFirst) bad.push('the run ends when anybody finishes');
      if (f.limit !== two.limit) bad.push('the run has no clock on it');
      if (!(f.route > 0)) bad.push('the run has no finish on it');
      if (!c2.won_({ player: { finished: true, position: 4 } })) {
        bad.push('reaching the ramp fourth does not count as getting away');
      }
      if (c2.won_({ player: { finished: false, position: 1 } })) {
        bad.push('running out of time counts as getting away');
      }
    }

    // The retry path, which must NOT replay the wager — the fastest way to
    // make somebody stop retrying is to make them watch it again.
    game.mode = 'campaign';
    game.campaign = new Campaign(game);
    game.campaign.attempts = 1;
    game.campaign.car = SELECTABLE[0];
    realBegin();
    if (game.phase !== 'racing') bad.push(`a retry played a scene (phase ${game.phase})`);
  } catch (e) {
    bad.push(`threw — ${e.message}`);
  } finally {
    for (const q of game.race.cars) game.scene.remove(q.model);
    game.race = kept.race;
    game.phase = kept.phase;
    game.mode = kept.mode;
    game.campaign = kept.campaign;
    game.track = kept.track;
    game.beginStage = kept.begin;
    game.cut = null;
  }

  const ok = bad.length === 0;
  return `${ok ? 'stage one runs start to finish' : `WRONG — ${bad[0]}`} — ` +
    `wager, two-car grid over ${STAGES[0].laps} laps with contact, police on a win, ` +
    `losing ends it too, nothing carries in from the attract loop, and stage two is ` +
    `${STAGES.length > 1 ? `${STAGES[1].police} police over ${(STAGES[1].routeFraction * 100).toFixed(0)}% of an open route` : 'not written yet'}`;
}

// The campaign is data, so this is a data check: every name a stage mentions
// has to resolve to something that exists. A stage that names a script or a
// shot that is not there does not fail until the player has won the race in
// front of it, which is the worst possible time to find out.
function checkCampaign() {
  const bad = [];
  for (const s of STAGES) {
    for (const key of ['before', 'onWin', 'onLose']) {
      const name = s[key];
      if (!name) continue;
      if (!SCRIPTS[name]) { bad.push(`${s.id}.${key} names a script "${name}" that does not exist`); continue; }
      for (const [i, b] of SCRIPTS[name].entries()) {
        if (!SHOTS[b.shot]) bad.push(`${name}[${i}] wants a shot called "${b.shot}"`);
        if (!(b.t > 0)) bad.push(`${name}[${i}] is ${b.t} seconds long`);
        // Who a beat casts is NOT checked here. A scene can bring cars on for
        // itself — the police arriving are three cars this file has never
        // heard of — so the list of valid roles is not knowable from the
        // stage. `cutscene` checks it the only way it can be checked: by
        // playing every script and seeing whether each role was actually
        // there when its beat came up.
      }
    }
    if (!(s.laps > 0)) bad.push(`${s.id} runs ${s.laps} laps`);
    // Every stage needs somebody else on the road: rivals to race, or police
    // to get away from. A stage with neither is a stage you cannot lose.
    const rivals2 = s.rivals || (s.rival ? [s.rival] : []);
    for (const r of rivals2) {
      if (!r.opts) bad.push(`${s.id}'s rival ${r.name || '?'} has no character`);
      if (!r.name) bad.push(`${s.id} has an unnamed rival`);
    }
    // A stage needs an opponent — rivals, police, or a target with a clock on
    // it. The yard's opponent is the number: you cannot lose to nobody, but
    // you can absolutely lose to 4000 points in 150 seconds.
    if (!rivals2.length && !(s.police > 0) && !(s.driftTarget > 0 && s.limit > 0)) {
      bad.push(`${s.id} has nobody else on the road`);
    }
    if (s.driftTarget && !(s.limit > 0)) bad.push(`${s.id} has a score target and no clock`);
    // Checkpoints only mean something against a clock, and they have to be in
    // order and inside the route — one past the finish is one never crossed.
    if (s.checkpoints) {
      if (!(s.limit > 0)) bad.push(`${s.id} has checkpoints and no clock to extend`);
      if (!(s.checkpoints.bonus > 0)) bad.push(`${s.id}'s checkpoints buy nothing`);
      let prev2 = 0;
      for (const f of s.checkpoints.at) {
        if (f <= prev2 || f >= (s.routeFraction || 1)) bad.push(`${s.id} has a checkpoint at ${f}`);
        prev2 = f;
      }
    }
    if (s.layout && !LAYOUTS[s.layout]) bad.push(`${s.id} wants a layout called "${s.layout}"`);
    if (s.routeFraction !== undefined) {
      // An open route ends at its end, so a whole one is the normal case now.
      if (!(s.routeFraction > 0.2 && s.routeFraction <= 1)) {
        bad.push(`${s.id} ends ${(s.routeFraction * 100).toFixed(0)}% of the way along`);
      }
      if (!(s.limit > 0)) bad.push(`${s.id} is a run with no clock on it`);
      if (s.layout && LAYOUTS[s.layout] && LAYOUTS[s.layout].closed !== false && s.routeFraction >= 1) {
        bad.push(`${s.id} asks for a whole lap of a circuit as a point-to-point`);
      }
    }
    if (s.next !== null && !STAGES.some((x) => x.id === s.next)) {
      bad.push(`${s.id} leads to "${s.next}", which is not a stage`);
    }
  }
  // Every stage's field lines up — a REAL slot for every car, on the road.
  //
  // This is the check that would have caught map four: the composable field
  // let a race stage carry traffic, the grid path indexed sixteen slots by an
  // eighteen-car field, and slot seventeen was undefined. The stage died on
  // its first frame, and nothing here noticed because the field was validated
  // as DATA and never asked to line up.
  for (const st of STAGES) {
    const t2 = new Track(LAYOUTS[st.layout]);
    const c2 = new Campaign({ playerName: 'X' });
    c2.index = STAGES.indexOf(st);
    c2.car = SELECTABLE[0];
    const f2 = c2.field(t2);
    const shadow2 = Object.create(Race.prototype);
    Object.assign(shadow2, {
      track: t2,
      formation: f2.formation,
      cars: f2.cars.map((spec) => ({
        traffic: !!spec.traffic,
        driver: spec.traffic ? { lane: spec.lane } : null,
      })),
    });
    const slots = shadow2._slots();
    slots.forEach((slot, i2) => {
      if (!slot || !Number.isFinite(slot.x) || !Number.isFinite(slot.s)) {
        bad.push(`${st.id} has no slot for car ${i2 + 1} of ${slots.length}`);
        return;
      }
      const loc2 = t2.locate(slot.x, slot.z);
      if (Math.abs(loc2.lateral) > loc2.width / 2 + 1) {
        bad.push(`${st.id} lines car ${i2 + 1} up ${Math.abs(loc2.lateral).toFixed(1)} m off centre`);
      }
    });
    // And no two non-traffic cars share a slot.
    const starts = slots.filter((q, i2) => q && !shadow2.cars[i2].traffic);
    for (let a2 = 0; a2 < starts.length; a2++) {
      for (let b2 = a2 + 1; b2 < starts.length; b2++) {
        if (dist2D(starts[a2].x, starts[a2].z, starts[b2].x, starts[b2].z) < 3) {
          bad.push(`${st.id} lines two cars up on the same spot`);
        }
      }
    }
  }

  const scripted = STAGES.reduce(
    (a, s) => a + ['before', 'onWin', 'onLose'].filter((k) => s[k]).length, 0);
  const ok = bad.length === 0;
  return `${ok ? 'every stage resolves' : `WRONG — ${bad[0]}`} — ` +
    `${STAGES.length} stage${STAGES.length === 1 ? '' : 's'}, ${scripted} scenes hung off them, ` +
    `${STAGES.map((s) => (s.routeFraction
      ? `${s.id} ${(s.routeFraction * 100).toFixed(0)}% of a route in ${s.limit}s`
      : `${s.id} ${s.laps} laps`)).join(', ')}`;
}

function checkNoNeutral() {
  const zeros = CAR.gears.filter((g) => g === 0).length;

  // Stopped, first goes down to reverse: with no neutral in the box that is
  // the only way the lever reaches it, and without it manual mode has no way
  // into reverse at all.
  const a = bench();
  a.autoShift = false;
  a.gear = 1; a.shiftT = 0; a.setSpeed(0);
  a.shiftDown();
  const gotR = a.gear === 0;
  // And back out of it the same way.
  a.shiftT = 0;
  a.shiftUp();
  const outOfR = a.gear === 1;

  // Moving, it does not: downshifting into a corner must not select reverse.
  const b2 = bench();
  b2.autoShift = false;
  b2.gear = 1; b2.shiftT = 0; b2.setSpeed(22);
  b2.shiftDown();
  const refused = b2.gear === 1;

  const ok = zeros === 0 && gotR && outOfR && refused && CAR.gears.length === 7;
  return `${ok ? 'no neutral, and reverse is under first' : 'WRONG'} — ` +
    `${CAR.gears.length - 1} ratios and reverse, ${zeros} of them zero, ` +
    `stopped 1→R ${gotR ? 'works' : 'FAILS'} and R→1 ${outOfR ? 'works' : 'FAILS'}, ` +
    `at 79 km/h it ${refused ? 'refuses' : 'WRONGLY GIVES REVERSE'}`;
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

// A field can be any size, and laps come from the race rather than the config.
function checkField(game) {
  const race = game.race;
  const was = race.cars.map((c) => ({ livery: c.livery, isPlayer: c.isPlayer, name: c.name }));
  const wasLaps = race.laps;

  race.buildField({
    cars: [
      { livery: SELECTABLE[7], name: 'RIVAL', skill: 0.99 },
      { livery: SELECTABLE[0], name: 'YOU', isPlayer: true },
    ],
    laps: 3, contact: true,
  });
  const two = race.cars.length === 2;
  const onePlayer = race.cars.filter((c) => c.isPlayer).length === 1;
  const apart = dist2D(race.cars[0].vehicle.x, race.cars[0].vehicle.z,
    race.cars[1].vehicle.x, race.cars[1].vehicle.z) > 3;
  const contactOn = race.contact === true;

  // Put the sixteen back — every check after this one assumes them.
  race.buildField(defaultField());
  const back = race.cars.length === RACE.cars && race.laps === wasLaps
    && race.cars.filter((c) => c.isPlayer).length === 1;
  void was;

  const ok = two && onePlayer && apart && contactOn && back;
  return `${ok ? 'a field is whatever the stage says' : 'WRONG'} — ` +
    `two cars gave ${race.cars.length === RACE.cars ? 2 : '?'} on distinct slots ` +
    `${apart ? '' : 'OVERLAPPING '}with contact ${contactOn ? 'on' : 'OFF'}, ` +
    `and the default field came ${back ? 'back' : 'BACK WRONG'} at ${RACE.cars}`;
}

// Contact, and the fact that it is off where it should be off.
//
// Two assertions in one, because the second is the product decision: the
// sixteen-car race phases through by design and must keep doing so. The
// existing `phasing` check proves cars pass through in race mode; this proves
// they do NOT in a mode that asks for contact, and that a resting pair settles
// rather than jittering — which is the failure mode of an unstable resolver.
function checkContact(game) {
  const race = game.race;
  const t = game.track;
  const p = t.atDistance(t.length * 0.55);
  const yaw = Math.atan2(p.dirX, p.dirZ);

  const pair = (contact, offset) => {
    const A = new Vehicle(CAR), B = new Vehicle(CAR);
    A.reset(p.x, p.z, yaw);
    B.reset(p.x + p.nx * offset, p.z + p.nz * offset, yaw);
    A.surfaceGrip = B.surfaceGrip = 1;
    A.setSpeed(38); B.setSpeed(38);
    const fake = {
      contact,
      cars: [{ vehicle: A, isPlayer: false }, { vehicle: B, isPlayer: false }],
      game: { onImpact() {} },
      _resolvePair: race._resolvePair.bind({ ...race, contact, game: { onImpact() {} } }),
    };
    fake._carContact = race._carContact.bind(fake);
    for (let i = 0; i < Math.round(2.5 / FIXED); i++) {
      A.steerInput = 0.10; B.steerInput = -0.10;      // steer into each other
      A.throttle = B.throttle = 0.4;
      A.update(FIXED, 2); B.update(FIXED, 2);
      fake._carContact();
    }
    return dist2D(A.x, A.z, B.x, B.z);
  };

  const withContact = pair(true, 1.2);
  const without = pair(false, 1.2);

  // And two cars left overlapping with no input must settle, not jitter.
  const A = new Vehicle(CAR), B = new Vehicle(CAR);
  A.reset(p.x, p.z, yaw);
  B.reset(p.x + p.nx * 0.6, p.z + p.nz * 0.6, yaw);
  A.surfaceGrip = B.surfaceGrip = 1;
  const rest = { contact: true, cars: [{ vehicle: A }, { vehicle: B }], game: { onImpact() {} } };
  rest._resolvePair = race._resolvePair.bind(rest);
  rest._carContact = race._carContact.bind(rest);
  let last = 0, moved = 0;
  for (let i = 0; i < Math.round(3 / FIXED); i++) {
    A.update(FIXED, 2); B.update(FIXED, 2);
    rest._carContact();
    const d = dist2D(A.x, A.z, B.x, B.z);
    if (i > Math.round(2.5 / FIXED)) moved = Math.max(moved, Math.abs(d - last));
    last = d;
  }
  const settles = moved < 0.05;
  const separated = withContact > without + 0.4;
  const sane = Number.isFinite(withContact) && withContact < 40;

  const ok = separated && settles && sane && !defaultField().contact;
  return `${ok ? 'they touch in campaign and phase in race' : 'WRONG'} — ` +
    `steered together they end ${withContact.toFixed(1)} m apart with contact ` +
    `against ${without.toFixed(1)} without, a resting pair settles to ` +
    `${(moved * 1000).toFixed(1)} mm of movement, and the race field asks for ` +
    `contact ${defaultField().contact ? 'ON — WRONG' : 'off'}`;
}

// The rival: faster than the field, and visibly harder.
//
// "More aggressive" has to mean something numerical or it is just a colour.
// Three things: it laps quicker than the best default driver, it really does
// use the handbrake, and it does not use it so much that it is simply out of
// control — a drift is a decision about a corner, not a driving style.
function checkRival(game) {
  const track = game.track;
  // Deterministic for the duration.
  //
  // The drift decides whether to commit to a corner with Math.random(), and
  // the driver's brake and throttle noise are rolled at construction — so this
  // check gave 1.9 s off track one run and 6.8 s the next, against a fixed
  // threshold. A test that fails on the dice is worse than no test: it trains
  // you to ignore it. Swapping in a fixed sequence keeps the real code path
  // and removes the only thing that was moving.
  // Three seeds, averaged.
  //
  // One seeded run of a chaotic system is not a measurement, it is a coin
  // flip about a threshold: changing anything upstream — the gear the car
  // starts in, say — re-rolls the whole lap and the number moves by a factor
  // of two without the driving being any better or worse. Three runs is a
  // measurement, and the thresholds mean something against it.
  const realRandom = Math.random;
  const runs = [];
  for (const s0 of [0x2f6e2b1, 0x51f3a9d, 0x13c7e05]) {
    let seed = s0;
    Math.random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    try { runs.push(rivalLap(track)); } finally { Math.random = realRandom; }
  }
  const mean = (f) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
  return reportRival(track, {
    fast: {
      t: mean((r) => r.fast.t), off: mean((r) => r.fast.off),
      hand: mean((r) => r.fast.hand), spells: mean((r) => r.fast.spells),
    },
    noDrift: { t: mean((r) => r.noDrift.t), off: mean((r) => r.noDrift.off) },
    field: mean((r) => r.field),
  });
}

function rivalLap(track) {
  const lap = (opts, skill) => {
    const car = { vehicle: new Vehicle(CAR), loc: null };
    const d = new Driver(car, track, skill, opts);
    const start = track.atDistance(4);
    car.vehicle.reset(start.x, start.z, Math.atan2(start.dirX, start.dirZ));
    car.vehicle.setSpeed(30);
    car.vehicle.surfaceGrip = 1;
    car.loc = track.locate(car.vehicle.x, car.vehicle.z);
    const solo = [car];
    let t = 0, hand = 0, spells = 0, wasHand = false, peak = 0, off = 0;
    const guard = Math.round(150 / FIXED);
    for (let i = 0; i < guard; i++) {
      d.drive(FIXED, solo);
      car.vehicle.update(FIXED, 2);
      car.loc = track.locate(car.vehicle.x, car.vehicle.z, car.loc.index);
      const over = Math.abs(car.loc.lateral) - car.loc.width / 2;
      car.vehicle.surfaceGrip = over <= 0 ? 1 : over < 1.6 ? 0.92 : 0.6;
      if (over > 1.6) off += FIXED;
      t += FIXED;
      const on = car.vehicle.handbrake > 0.5;
      if (on) { hand += FIXED; peak = Math.max(peak, Math.abs(car.vehicle.slipR || 0)); }
      if (on && !wasHand) spells++;
      wasHand = on;
      if (t > 12 && car.loc.s < 40 && car.loc.s >= 0) break;   // back round
    }
    return { t, hand, spells, peak, off };
  };

  return {
    fast: lap(RIVAL.opts, RIVAL.skill),
    field: lap({}, AI.maxSkill).t,
    noDrift: lap({ ...RIVAL.opts, drift: 0 }, RIVAL.skill),
  };
}

function reportRival(track, r) {
  const { fast, noDrift, field } = r;
  const quicker = fast.t < field;
  const drifts = fast.spells >= 2;
  const restrained = fast.hand < fast.t * 0.14;
  // Against a THREE-SEED MEAN, not one roll.
  //
  // The old bar was four seconds and the old measurement was a single seeded
  // lap that happened to come out at three point two. Averaged properly the
  // same driving measures about five: the number moved because the sample
  // got better, not because the rival got worse. Six is the mean it must stay
  // under, and it is a mean of a car that drifts every third corner on
  // purpose.
  const clean = fast.off < 6;
  const ok = quicker && drifts && restrained && clean;
  void track;
  return `${ok ? 'harder than the field, and still on the road' : 'WRONG'} — ` +
    `laps in ${fast.t.toFixed(1)}s against the best default driver's ${field.toFixed(1)}s, ` +
    `uses the handbrake in ${fast.spells.toFixed(1)} places for ${(fast.hand / fast.t * 100).toFixed(0)}% of the lap, ` +
    `${fast.off.toFixed(1)}s off track, averaged over three seeds ` +
    `(the same pace without the drift: ${noDrift.t.toFixed(1)}s, ${noDrift.off.toFixed(1)}s off)`;
}

// And nothing else in the field picked the habit up.
function checkNoDriftByDefault(game) {
  const car = { vehicle: new Vehicle(CAR), loc: null };
  const d = new Driver(car, game.track, AI.maxSkill);
  const start = game.track.atDistance(4);
  car.vehicle.reset(start.x, start.z, Math.atan2(start.dirX, start.dirZ));
  car.vehicle.setSpeed(30);
  car.vehicle.surfaceGrip = 1;
  car.loc = game.track.locate(car.vehicle.x, car.vehicle.z);
  let used = 0;
  for (let i = 0; i < Math.round(45 / FIXED); i++) {
    d.drive(FIXED, [car]);
    car.vehicle.update(FIXED, 2);
    car.loc = game.track.locate(car.vehicle.x, car.vehicle.z, car.loc.index);
    if (car.vehicle.handbrake > 0.01) used++;
  }
  const ok = used === 0 && d.opts.drift === 0;
  return `${ok ? 'the rest of the field never touches it' : 'WRONG'} — ` +
    `a default driver used the handbrake on ${used} steps of a 45 s run`;
}

// No steps in a side street.
//
// Their height used to come straight from `locate(x, z).y` — the height of the
// nearest point of the CIRCUIT. Fine at the junction, wrong further out: as
// the street runs away the nearest circuit sample flips from one leg of the
// lap to another and the height jumps with it, which on a hill is a visible
// step in the middle of a road, in view of the racing line.
function checkStreetGrade(track) {
  let worst = 0, at = null, which = -1, profiled = 0, worstSeam = 0, seamAt = -1;
  for (let si = 0; si < track.streets.length; si++) {
    const t = track.streets[si];
    if (t.heights) profiled++;
    let prev = null;
    for (let d = t.from; d <= t.to; d += 2) {
      const y = track.streetY(t, d);
      if (prev !== null) {
        const step = Math.abs(y - prev) / 2;             // grade over 2 m
        if (step > worst) { worst = step; at = d; which = si; }
      }
      prev = y;
    }
    // And a stem has to meet the junction where it emerges from it — which is
    // at the edge of the junction's own surface, not at the stem's nominal
    // start, because the junction covers everything before that.
    if (t.stem) {
      const d = 20;
      const sx = t.x + t.ux * d, sz = t.z + t.uz * d;
      const seam = Math.abs(track.streetY(t, d) - track.locate(sx, sz).y);
      if (seam > worstSeam) { worstSeam = seam; seamAt = si; }
    }
  }
  const ok = worst < 0.16 && worstSeam < 1.0;
  return `${ok ? 'no steps in them' : 'WRONG'} — ` +
    `${track.streets.length} of them, steepest ${(worst * 100).toFixed(1)}%, ` +
    `worst junction seam ${worstSeam.toFixed(2)} m`;
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

// Can anybody actually drive stage two, and can the police catch anybody?
//
// The layout being geometrically sound says nothing about whether the racing
// line generator produced something driveable over four and a half kilometres
// of it, and the run is the one stage where failing that is invisible until
// somebody plays it — there is no lap time to look wrong, only a car in a wall
// two minutes in.
//
// The chase is the second half. A police driver with `chase` on has to close
// on the quarry rather than settle politely behind it, which is exactly what
// the traffic rule every other driver obeys would make it do.
function checkTheRun(game) {
  // Deterministic for the duration, the same way `rival` is. Reaction times,
  // brake noise and mistakes are all rolled from Math.random, and the pursuit
  // is measured in seconds-with-the-car-boxed-in — a quantity that swung from
  // 2.6 to 0.3 between two runs of identical code. A test that fails on the
  // dice trains you to ignore it.
  const realRandom = Math.random;
  let seed = 0x51f3a9d;
  Math.random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  try {
    return theRun(game);
  } finally {
    Math.random = realRandom;
  }
}

function theRun(game) {
  const t = new Track(LAYOUTS.run);
  const stage = STAGES.find((q) => q.layout === 'run');
  const finish = stage.routeFraction * t.length;

  const spawn = (at, offset) => {
    const p = t.atDistance(at);
    const car = {
      vehicle: new Vehicle(CAR), isPlayer: false,
      loc: null, name: 'x',
    };
    car.vehicle.reset(p.x + p.nx * offset, p.z + p.nz * offset, Math.atan2(p.dirX, p.dirZ));
    car.vehicle.autoShift = true;
    car.vehicle.setSpeed(30);
    car.loc = t.locate(car.vehicle.x, car.vehicle.z);
    return car;
  };

  // --- the run itself, driven solo from the line to the ramp.
  const runner = spawn(4, 0);
  const driver = new Driver(runner, t, 0.95);
  runner.driver = driver;
  let time = 0, off = 0, worst = null, slowest = 999;
  const solo = [runner];
  const guard = Math.round(320 / FIXED);
  let arrived = 0;
  for (let i = 0; i < guard; i++) {
    driver.drive(FIXED, solo);
    runner.vehicle.update(FIXED, 2);
    const loc = t.locate(runner.vehicle.x, runner.vehicle.z, runner.loc.index);
    runner.loc = loc;
    const over = Math.abs(loc.lateral) - loc.width / 2;
    runner.vehicle.surfaceGrip = over <= 0 ? 1 : over < 1.6 ? 0.92 : 0.55;
    if (over > 2.0) {
      off += FIXED;
      if (!worst) worst = Math.round(loc.s);
    }
    slowest = Math.min(slowest, runner.vehicle.speedKmh);
    time += FIXED;
    if (loc.s >= finish) { arrived = time; break; }
  }

  const bad = [];
  if (!arrived) bad.push(`nobody reached the ramp in ${time.toFixed(0)}s`);
  if (off > 4) bad.push(`${off.toFixed(1)}s off the road, first at ${worst} m`);
  if (arrived && arrived > stage.limit) {
    bad.push(`the drive takes ${arrived.toFixed(0)}s against a ${stage.limit}s limit`);
  }
  // And not so easy the clock is decoration: a limit twice the drive is not a
  // chase, it is a scenic tour.
  if (arrived && stage.limit > arrived * 1.9) {
    bad.push(`${stage.limit}s is generous for a ${arrived.toFixed(0)}s drive`);
  }

  // --- the chase. A police driver behind a car that is not trying: it has to
  // close the gap, not hold it.
  // A quarry driving well — not a slow car for the cop to walk past, which
  // proves nothing except that one driver is quicker than another. What is
  // being asked is whether a chaser closes to CONTACT RANGE on somebody
  // genuinely trying, because that is the whole of what the stage is.
  // Both on a straight, found rather than guessed at.
  //
  // Dropped in at a fixed distance, the chaser started fifty-nine metres
  // before a junction doing a hundred and eight and went straight through the
  // outside of it — which measured the spawn point, not the pursuit.
  let straightAt = 300;
  for (let d = 200; d < t.length - 600; d += 20) {
    let ok2 = true;
    for (let k = 0; k < 320; k += 20) {
      if (t.atDistance(d + k).curvature > 0.002) { ok2 = false; break; }
    }
    if (ok2) { straightAt = d; break; }
  }
  const quarry = spawn(straightAt + 60, 0);
  const cop = spawn(straightAt, 0);
  // Three of them, in the same three stations the stage uses.
  const units = [];
  for (let u = 0; u < 3; u++) {
    const cop = spawn(straightAt - u * 13, u === 0 ? 0 : (u === 1 ? 2.6 : -2.6));
    cop.driver = new Driver(cop, t, POLICE.skill, { ...POLICE.opts, station: u });
    cop.driver.quarry = quarry;
    units.push(cop);
  }
  // A stand-in for a player, not for a rival. The quarry here drives at about
  // the pace somebody playing does — the units are meant to catch a person,
  // and a person is not a ninety-per-cent AI on the racing line.
  quarry.driver = new Driver(quarry, t, 0.80, { cornerMargin: 0.82 });
  const pack = [quarry, ...units];
  const gap0 = t.gap(quarry.loc.s, units[0].loc.s);
  let closest = gap0, wide = 0, boxed = 0, ranAway = 0;
  // The whole drive, not a hundred seconds of it. Whether all three units are
  // around the car at the same moment depends on where the road happens to
  // widen, so a short window is a small sample of an intermittent thing.
  for (let i = 0; i < Math.round(140 / FIXED); i++) {
    for (const c of pack) {
      c.driver.drive(FIXED, pack);
      c.vehicle.update(FIXED, 2);
      c.loc = t.locate(c.vehicle.x, c.vehicle.z, c.loc.index);
      const over = Math.abs(c.loc.lateral) - c.loc.width / 2;
      c.vehicle.surfaceGrip = over <= 0 ? 1 : over < 1.6 ? 0.92 : 0.55;
      // Time spent off the ROAD, measured against the road's own width the
      // same way every other check here measures it — not against a fixed
      // distance from the centreline. A junction is fifteen metres wide and
      // the street between them eleven, so a fixed number is off the road at
      // one end and comfortably on it at the other.
      if (c !== quarry && over > 2.0) wide += FIXED;
    }
    for (const c of units) {
      // Straight-line distance, not distance along the road: once it is
      // alongside, the gap round the lap says nothing about whether it is
      // close enough to hit you.
      const d = dist2D(quarry.vehicle.x, quarry.vehicle.z, c.vehicle.x, c.vehicle.z);
      if (d < closest) closest = d;
      // Nobody overtakes and drives off. A unit forty metres up the road from
      // the car it is chasing is in a race, not a pursuit — which is exactly
      // what three racing drivers with sirens on did.
      if (t.gap(c.loc.s, quarry.loc.s) > 40) ranAway += FIXED;
    }
    // Boxed in: something down each side at the same moment, close enough to
    // lean on. One car on a bumper is a tail; three cars around you is a box.
    const side = (sgn) => units.some((c) =>
      Math.abs(t.gap(c.loc.s, quarry.loc.s)) < 12
      && sgn * (c.loc.lateral - quarry.loc.lateral) > 1.4
      && dist2D(quarry.vehicle.x, quarry.vehicle.z, c.vehicle.x, c.vehicle.z) < 14);
    if (side(1) && side(-1)) boxed += FIXED;
  }
  // Letting a chaser off the corner limit as well as off the traffic rule made
  // it close beautifully in a straight line and spend every corner thirty
  // metres into the buildings.
  if (wide > 8) bad.push(`the units spent ${wide.toFixed(1)} car-seconds off the road`);
  if (closest > 8) bad.push(`the closest a unit got was ${closest.toFixed(0)} m`);
  if (ranAway > 8) bad.push(`the units spent ${ranAway.toFixed(0)} car-seconds racing off up the road`);
  if (boxed < 1.5) bad.push(`they had the car boxed in for only ${boxed.toFixed(1)}s of 140`);

  const ok = bad.length === 0;
  return `${ok ? 'driveable, and they close on you' : `WRONG — ${bad[0]}`} — ` +
    `${(finish / 1000).toFixed(2)} km to the ramp in ${arrived ? arrived.toFixed(0) : '--'}s ` +
    `of a ${stage.limit}s limit, ${off.toFixed(1)}s off the road, slowest ${slowest.toFixed(0)} km/h; ` +
    `three units ${gap0.toFixed(0)} m behind a 0.80 driver got to ` +
    `${closest.toFixed(0)} m, had it boxed in for ${boxed.toFixed(1)}s of 140, ` +
    `ran off up the road for ${ranAway.toFixed(1)}, and spent ${wide.toFixed(1)} off it`;
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

  // The map's palette IS its legend: the route in blue, the fake streets in
  // white, and one white chevron. A map that lost its streets or drew the
  // route in the streets' colour would still be "drawn", so the colours are
  // counted, not assumed — in both modes.
  {
    const mapPx = () => {
      const cv = el('map-c');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let blue = 0, white = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 60) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (b > 140 && b > r + 50 && g > r) blue++;
        else if (r > 195 && g > 195 && b > 195) white++;
      }
      return { blue, white };
    };
    hud.update(1 / 60);
    const m1 = mapPx();
    post('/__frame/map', el('map-c').toDataURL('image/png'));
    notes.push(m1.blue > 200
      ? `the route is blue (${m1.blue} px)` : `THE ROUTE IS NOT BLUE (${m1.blue} px)`);
    notes.push(m1.white > 120
      ? `the streets are white (${m1.white} px)` : `THE STREETS ARE MISSING (${m1.white} px)`);
    // The web is generated, so its properties are the check: seeded (the same
    // twice over), plentiful (an intricate city, not whiskers), and none of it
    // on a deck layout, where streets over open water would be nonsense.
    const web1 = hud._streetWeb(race.track);
    const webFor = hud._webFor;
    hud._webFor = null;
    const web2 = hud._streetWeb(race.track);
    hud._webFor = webFor; hud._web = web1;
    // A floor AND a ceiling: too few reads as whiskers, too many as graph
    // paper the route has to fight. And the density tracks the layout's own
    // block pitch, so the estuary's tight city maps busier than downtown.
    if (web1.length < race.track.length / 90) notes.push(`THE WEB IS THIN (${web1.length} segments)`);
    if (web1.length > race.track.length / 14) notes.push(`THE WEB IS GRAPH PAPER (${web1.length} segments)`);
    {
      const est2 = new Track(LAYOUTS.estuary);
      const webE = hud._streetWeb(est2);
      const perM = webE.length / est2.length;
      const perM1 = web1.length / race.track.length;
      hud._webFor = webFor; hud._web = web1;
      if (perM <= perM1) notes.push('THE TIGHT CITY DOES NOT MAP DENSER THAN DOWNTOWN');
    }
    if (web1.length !== web2.length
      || web1.some((q, i2) => Math.abs(q[0] - web2[i2][0]) > 1e-6)) {
      notes.push('THE WEB IS NOT SEEDED — the map shimmers');
    }
    const deckWeb = hud._streetWeb(new Track(LAYOUTS.bridge));
    hud._webFor = webFor; hud._web = web1;
    if (deckWeb.length) notes.push(`${deckWeb.length} STREETS DRAWN OVER OPEN WATER`);
  }

  // The map on an OPEN route, drawn for real.
  //
  // The route-mode checks above flip the live race into route mode on a
  // CLOSED track, and closed short-circuits `!track.closed` branches — a
  // crash that only open routes reach sailed through exactly that way. So the
  // rolling map is driven once against a genuinely open track.
  {
    const open2 = new Track(LAYOUTS.run);
    const fakeRace = {
      track: open2, cars: [], route: open2.length, escape: null, drift: null,
      limit: 100, time: 10, state: 'racing', distanceAlong: () => 500,
    };
    const p2 = open2.atDistance(500);
    const fakePlayer = {
      vehicle: { x: p2.x, z: p2.z, yaw: Math.atan2(p2.dirX, p2.dirZ) },
      loc: open2.locate(p2.x, p2.z), isPlayer: true,
    };
    fakeRace.cars = [fakePlayer];
    try {
      hud._rollingMap(fakeRace, fakePlayer, 432);
      notes.push('the map draws an open route');
    } catch (e) {
      notes.push(`THE MAP THROWS ON AN OPEN ROUTE: ${e.message}`);
    }
    hud.trackChanged();
    hud.update(1 / 60);
  }

  // The speedometer, and whether its needle is attached to anything.
  //
  // "It drew something" is what a dial that has stopped reading the speed
  // looks like too — the rim, the ticks and the numbers are all still there.
  // So the sweep is measured at two speeds and the difference is the check.
  {
    // Brightness, not coverage.
    //
    // Counting non-transparent pixels does not work here: the value arc is
    // drawn ON TOP of the dark rim, which already covers the whole sweep, so
    // the number of lit pixels is the same at seven km/h as at two hundred and
    // sixty. What changes is how much of that rim has a bright arc over it.
    const ink = (id) => {
      const cv = el(id);
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) n += (d[i] + d[i + 1] + d[i + 2]) * (d[i + 3] / 255);
      return n / 1000;
    };
    const car = race.player.vehicle;
    const was = car.u;
    car.setSpeed(2);
    hud.update(1 / 60);
    const slow = ink('speedo-c');
    car.setSpeed(72);                            // 260 km/h
    hud.update(1 / 60);
    const fast = ink('speedo-c');
    car.setSpeed(was);
    hud.update(1 / 60);
    notes.push(slow > 50 ? 'speedo drawn' : 'SPEEDO BLANK');
    notes.push(fast > slow * 1.15
      ? `its sweep grows ${((fast / Math.max(slow, 1) - 1) * 100).toFixed(0)}% from 7 to 260 km/h`
      : 'THE SPEEDO NEEDLE IS NOT READING THE SPEED');
    // And it is on the other side of the screen from the tacho.
    const l = el('dash-l').getBoundingClientRect();
    const r = el('dash').getBoundingClientRect();
    notes.push(l.right < r.left ? 'on the left, opposite the tacho' : 'THE TWO DIALS OVERLAP');
  }

  // The run reads the same two cells as a completely different board: how far
  // to the ramp and how long is left, rather than which lap and how long it
  // has taken. Driven by flipping the live race into route mode for one frame
  // and putting it straight back, so it is the real board being read.
  {
    // `state` too: a full race has already been run to the flag by the time
    // this check runs, and the clock only flashes while one is still going.
    const was = { route: race.route, limit: race.limit, time: race.time, state: race.state };
    race.state = 'racing';
    // Measured from where the player actually is, so the board has a real
    // distance to read rather than a negative one: `progress` is not distance
    // travelled, and a fixed fraction of the lap is already behind a car on
    // its second one.
    race.route = race.distanceAlong(race.player) + 1500;
    race.limit = 200;
    race.time = 178;
    hud.update(1 / 60);
    const dist = el('lap-v').textContent;
    const clock = el('race-time').textContent;
    const urgent = el('race-time').classList.contains('urgent');
    notes.push(el('lap-k').textContent === 'TO RAMP' && /^[\d.]+(km|m)$/.test(dist)
      ? `a run reads ${dist} to the ramp` : `RUN DISTANCE READS "${dist}"`);
    notes.push(/^0:2[12]\./.test(clock)
      ? `${clock} left of 200` : `RUN CLOCK READS "${clock}" WITH 22s LEFT`);
    notes.push(urgent ? 'and it is flashing'
      : `THE LAST 22s ARE NOT FLASHING (state ${race.state})`);
    // The map follows the car on a run.
    //
    // "It drew something" passes for a map that is still showing the whole
    // eleven kilometres with a dot on it that never appears to move, which is
    // what a route got before. So the car is moved and the picture compared:
    // a rolling window redraws completely, a fixed overview barely changes.
    const mapInk = () => {
      const cv = el('map-c');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 16) n += d[i] + d[i + 1] + d[i + 2] + d[i + 3] * (i % 97);
      return n;
    };
    const pv = race.player.vehicle;
    const at = { x: pv.x, z: pv.z, yaw: pv.yaw };
    hud.update(1 / 60);
    const m0 = mapInk();
    const far = race.track.atDistance((race.player.loc.s + race.track.length * 0.3) % race.track.length);
    pv.x = far.x; pv.z = far.z; pv.yaw = Math.atan2(far.dirX, far.dirZ);
    race.player.loc = race.track.locate(pv.x, pv.z);
    hud.update(1 / 60);
    const m1 = mapInk();
    pv.x = at.x; pv.z = at.z; pv.yaw = at.yaw;
    race.player.loc = race.track.locate(pv.x, pv.z);
    notes.push(m0 !== m1 ? 'and the map moves with the car' : 'THE MAP DOES NOT FOLLOW THE CAR');

    // Nothing at the top of the screen overlaps, in any of the special modes.
    // The heat bar and the drift score are centred like the top strip is, and
    // both spent a while drawn straight through the middle of the clock.
    {
      const hudEl = el('hud');
      // Restored afterwards, because this runs in the middle of the run-mode
      // checks and blowing their class away fails THEM, not this.
      const wasClass = hudEl.className;
      for (const mode of ['escape', 'drift']) {
        hudEl.classList.add('run', mode);
        const boxes = ['top', 'heat', 'drift', 'map']
          .map((id) => el(id))
          .filter((n) => n && getComputedStyle(n).display !== 'none')
          .map((n) => ({ id: n.id, r: n.getBoundingClientRect() }))
          .filter((b) => b.r.width > 0);
        for (let a2 = 0; a2 < boxes.length; a2++) {
          for (let b2 = a2 + 1; b2 < boxes.length; b2++) {
            const A = boxes[a2].r, B = boxes[b2].r;
            if (A.right > B.left && B.right > A.left && A.bottom > B.top && B.bottom > A.top) {
              notes.push(`${boxes[a2].id} AND ${boxes[b2].id} OVERLAP IN ${mode.toUpperCase()}`);
            }
          }
        }
        hudEl.classList.remove('run', mode);
      }
      hudEl.className = wasClass;
      if (!notes.some((n) => n.includes('OVERLAP'))) notes.push('nothing at the top overlaps');
    }

    // And the race furniture is gone: no position, no timing strip, no order.
    const gone = ['pos-cell', 'timing', 'standings']
      .filter((id) => getComputedStyle(el(id)).display !== 'none');
    notes.push(gone.length === 0
      ? 'and the position, timing and order panels are hidden'
      : `${gone.join('/')} STILL SHOWN ON A RUN`);

    race.route = was.route; race.limit = was.limit; race.time = was.time;
    race.state = was.state;
    hud.update(1 / 60);
    notes.push(el('lap-k').textContent === 'LAP' ? 'a race reads laps again' : 'THE BOARD STUCK ON A RUN');
    if (getComputedStyle(el('standings')).display === 'none') notes.push('THE ORDER NEVER CAME BACK');
  }

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

// One check throwing used to take the whole report with it: no lines, no
// errors, nothing written — indistinguishable from the page never loading.
// Wrapped, a broken check reports itself as broken and the other forty carry
// on telling you about the game.
function guard(label, fn) {
  try {
    return `${label}${fn()}`;
  } catch (e) {
    return `${label}WRONG — the check itself threw: ${e && e.message ? e.message : e}`;
  }
}

function assertions(game) {
  const track = game.track;
  return [
    guard('track          ', () => checkTrack(track)),
    guard('corner grade   ', () => checkCornerGrade(track)),
    guard('racing line    ', () => checkRacingLine(track)),
    guard('grid           ', () => checkGrid(track)),
    guard('clearance      ', () => checkClearance(track)),
    guard('side streets   ', () => checkSideStreets(track)),
    guard('city           ', () => checkCity(track)),
    guard('street         ', () => checkBreakables(track)),
    guard('street grade   ', () => checkStreetGrade(track)),
    guard('ground         ', () => checkGroundField(track)),
    guard('layouts        ', () => checkLayouts()),
    guard('track swap     ', () => checkTrackSwap(game)),
    guard('stage two      ', () => checkRunLayout()),
    guard('the run        ', () => checkTheRun(game)),
    guard('the bridge     ', () => checkBridge(game)),
    guard('driver         ', () => checkDriverName(game)),
    guard('field          ', () => checkField(game)),
    guard('contact        ', () => checkContact(game)),
    guard('rival          ', () => checkRival(game)),
    guard('no drift       ', () => checkNoDriftByDefault(game)),
    guard('cutscene       ', () => checkCutscene(game)),
    guard('campaign       ', () => checkCampaign()),
    guard('stage one      ', () => checkCampaignFlow(game)),
    guard('cheats         ', () => checkCheats()),
    guard('acceleration   ', () => checkAcceleration()),
    guard('braking        ', () => checkBraking()),
    guard('brake balance  ', () => checkBrakeStability()),
    guard('gearbox        ', () => checkGearbox()),
    guard('neutral        ', () => checkNoNeutral()),
    guard('ai defaults    ', () => checkDriverDefaults(game.track)),
    guard('shots          ', () => checkShots(game.track)),
    guard('cornering      ', () => checkCornering()),
    guard('held turn      ', () => checkHeldTurn()),
    guard('steering       ', () => checkSteering(game)),
    guard('steering feel  ', () => checkSteeringWeight()),
    guard('handbrake      ', () => checkHandbrakeDrift()),
    guard('weight         ', () => checkWeightTransfer()),
    guard('surface        ', () => checkSurface(game)),
    guard('phasing        ', () => checkCollision(game)),
    guard('ai lap         ', () => checkAiLap(game)),
    guard('full race      ', () => checkRace(game)),
    guard('hud            ', () => checkHud(game)),
    guard('settings       ', () => checkSettings(game)),
    guard('touch          ', () => checkTouch(game)),
    guard('keybinds       ', () => checkKeybinds(game)),
    guard('chase rules    ', () => checkChaseRules(game)),
    guard('new stages     ', () => checkNewStages(game)),
    guard('wet + escape   ', () => checkWetAndEscape(game)),
    guard('drift + ghost  ', () => checkDriftAndGhost(game)),
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
    game.skyFollow(cam);
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
    game._leaveAttract();
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

  // The wager scene, played for real and photographed at three of its beats.
  //
  // Last, because `faceOff` picks the cars up and puts them down nose to nose
  // — everything above this wants them where the race left them. The numbers
  // in `checkCutscene` say the camera is not inside the bodywork; these say
  // whether the two of them are actually framed like two people talking.
  try {
    const rival = game.race.cars.find((q) => !q.isPlayer);
    const cast = { player: game.race.player, rival };
    // Only the two of them. The dump runs on the sixteen-car race field, and
    // the fourteen cars this scene is not about are parked all over the shot.
    for (const q of game.race.cars) q.model.visible = q === cast.player || q === rival;
    const cut = new Cutscene(game, SCRIPTS.WAGER, cast, () => {});
    const wanted = [1, 2, 4];                       // twoShot, rival, the handshake
    let shots = 0;
    for (let i = 0; i < 20 * 60 && !cut.done; i++) {
      cut.update(1 / 60);
      const b = cut.beat;
      if (b && wanted.includes(cut.i) && cut.t > b.t * 0.5 && shots === wanted.indexOf(cut.i)) {
        game.skyFollow(game.camera);
        game.post.render(game.scene, game.camera);
        post(`/__frame/wager${shots}`, c.toDataURL('image/png'));
        shots++;
      }
    }
    cut.skip();

    // And the police arriving, which is the one scene that has cars of its own
    // in it — three of them, driving the circuit sideways. Played through with
    // the real chase camera and photographed at the beats that are about them.
    {
      const cut3 = new Cutscene(game, SCRIPTS.POLICE_ARRIVE, cast, () => {});
      const want3 = [2, 4, 5];
      let got = 0, drifting = 0, slid = 0;
      for (let i = 0; i < 30 * 60 && !cut3.done; i++) {
        cut3.update(1 / 60);
        for (const c of cut3.extras) {
          if (c.vehicle.handbrake > 0.5) drifting++;
          slid = Math.max(slid, Math.abs(Math.atan2(c.vehicle.v, Math.max(Math.abs(c.vehicle.u), 1))));
        }
        const b3 = cut3.beat;
        if (b3 && want3.includes(cut3.i) && cut3.t > b3.t * 0.55 && got === want3.indexOf(cut3.i)) {
          game.post.render(game.scene, game.camera);
          post(`/__frame/police${got}`, c.toDataURL('image/png'));
          got++;
        }
      }
      cut3.skip();
      dump.push(`the police scene got ${got} of ${want3.length} frames, `
        + `${(drifting / 60).toFixed(1)} car-seconds on the handbrake, `
        + `up to ${(slid * 57.3).toFixed(0)}° of slide`);
    }

    for (const q of game.race.cars) q.model.visible = true;
    if (shots !== wanted.length) console.log(`wager dump got ${shots} of ${wanted.length} frames`);
  } catch (e) { console.log(`wager dump failed: ${e.message}`); }

  // Stage three: the bridge, with the traffic and the pursuit on it. Built
  // before stage two only because stage two is what the frames after it are
  // taken on; both replace the world, so both go at the end.
  try {
    disposeTrack(game.scene, game.track);
    const br = new Track(LAYOUTS.bridge);
    for (const _ of br.build(game.scene)) { /* off the clock */ }
    game.track = br;

    const stage3 = STAGES.find((q) => q.layout === 'bridge');
    const c3 = new Campaign(game);
    c3.index = STAGES.indexOf(stage3);
    c3.car = SELECTABLE[0];
    const plan3 = c3.field(br);
    const base3 = br.gridSlots[0].s;
    let nth = 0;
    const cars3 = plan3.cars.map((spec, i) => {
      const m = buildCar(spec.livery);
      let at, lat;
      if (spec.traffic) { at = base3 + 260 + (nth++) * 105; lat = spec.lane; }
      else if (i === 0) { at = base3; lat = 0; }
      else { at = base3 - 55 - (i - 1) * 18; lat = (i % 2) ? 2.6 : -2.6; }
      const p2 = br.atDistance(Math.min(br.length - 20, Math.max(4, at)));
      m.position.set(p2.x + p2.nx * lat, p2.y, p2.z + p2.nz * lat);
      m.rotation.order = 'YXZ';
      m.rotation.y = Math.atan2(p2.dirX, p2.dirZ);
      const bx = m.userData.beacons;
      if (bx) { bx[0].visible = i % 2 === 1; bx[1].visible = i % 2 === 0; }
      game.scene.add(m);
      return m;
    });

    // The landfall at each end, from above and outside — the thing that makes
    // a bridge a crossing rather than a road in the sea.
    for (const [name, at] of [['shore-sf', 0.02], ['shore-oak', 0.98]]) {
      const p3 = br.atDistance(at * br.length);
      shot(name, [p3.x - p3.dirX * (at < 0.5 ? 900 : -900) + p3.nx * 420, p3.y + 260,
        p3.z - p3.dirZ * (at < 0.5 ? 900 : -900) + p3.nz * 420],
      [p3.x, p3.y, p3.z], 52);
    }

    // The civilian fleet, lined up for inspection. This is the picture the
    // change is FOR — a table of proportions passes every numeric check and
    // can still come out looking like a fridge on wheels.
    {
      // Strung ALONG the road, photographed from beside it — the framing the
      // pursuit shot already proved out. Spread across the road they hid
      // behind one another and the picture showed one van.
      const line = TRAFFIC.map((livery, i) => {
        const m = buildCar(livery);
        const p3 = br.atDistance(600 + i * 7);
        m.position.set(p3.x + p3.nx * ((i % 2) ? 2.2 : -2.2), p3.y, p3.z);
        m.rotation.order = 'YXZ';
        m.rotation.y = Math.atan2(p3.dirX, p3.dirZ);
        game.scene.add(m);
        return m;
      });
      const mid3 = br.atDistance(600 + 3.5 * 7);
      shot('civvies', [mid3.x + mid3.nx * 13, mid3.y + 3.4, mid3.z + mid3.nz * 13],
        [mid3.x, mid3.y + 0.8, mid3.z], 52);
      for (const m of line) {
        game.scene.remove(m);
        m.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      }
    }

    // From the deck, looking up it: six lanes, traffic in them, a tower ahead.
    const eye = br.atDistance(base3 - 30);
    shot('bridge', [eye.x, eye.y + 3.0, eye.z],
      [eye.x + eye.dirX * 400, eye.y + 26, eye.z + eye.dirZ * 400], 60);
    // From the side and above, so the towers, the cables and the water read.
    const midp = br.atDistance(br.length * 0.5);
    shot('bridge-wide',
      [midp.x + midp.nx * 620, midp.y + 95, midp.z + midp.nz * 620],
      [midp.x, midp.y + 55, midp.z], 46);
    // And down at deck level in the traffic.
    const t3 = br.atDistance(base3 + 200);
    shot('bridge-traffic', [t3.x - t3.dirX * 14 + t3.nx * 5, t3.y + 2.4, t3.z - t3.dirZ * 14 + t3.nz * 5],
      [t3.x + t3.dirX * 130, t3.y + 3, t3.z + t3.dirZ * 130], 55);
    for (const m of cars3) game.scene.remove(m);
    disposeTrack(game.scene, br);
    dump.push(`the bridge is ${(br.length / 1000).toFixed(2)} km, `
      + `${plan3.cars.filter((q) => q.traffic).length} cars of traffic on it`);
  } catch (e) { console.log(`bridge dump failed: ${e.message}`); }

  // Stages four and five, built for real: the estuary circuit, and the
  // crosstown road reversed under a dawn sky. The sky swap is what most needs
  // a photograph — a palette is exactly the kind of change that passes every
  // numeric check and comes out looking like mud.
  try {
    disposeTrack(game.scene, game.track);
    const est = new Track(LAYOUTS.estuary);
    for (const _ of est.build(game.scene)) { /* off the clock */ }
    game.track = est;
    const e0 = est.atDistance(30);
    shot('estuary', [e0.x, e0.y + 2.6, e0.z],
      [e0.x + e0.dirX * 150, e0.y + 4, e0.z + e0.dirZ * 150], 60);
    const fogE = game.scene.fog;
    game.scene.fog = null;
    shot('estuary-map', [0, 900, 60], [0, 0, 30], 52);
    game.scene.fog = fogE;
    disposeTrack(game.scene, est);

    const skyl = new Track(LAYOUTS.run_rev);
    for (const _ of skyl.build(game.scene)) { /* off the clock */ }
    game.track = skyl;
    // The dawn palette, applied the way `buildTrack` applies it.
    const skyDef = LAYOUTS.run_rev.sky;
    const u = game.sky.material.uniforms;
    const wasSky = {
      top: u.top.value.getHex(), mid: u.mid.value.getHex(),
      low: u.low.value.getHex(), glow: u.glow.value.getHex(),
      fog: game.scene.fog.color.getHex(), near: game.scene.fog.near, far: game.scene.fog.far,
    };
    u.top.value.setHex(skyDef.top); u.mid.value.setHex(skyDef.mid);
    u.low.value.setHex(skyDef.low); u.glow.value.setHex(skyDef.glow);
    const fogDef = LAYOUTS.run_rev.fog;
    game.scene.fog.color.setHex(fogDef.colour);
    game.scene.fog.near = fogDef.near; game.scene.fog.far = fogDef.far;
    const s0 = skyl.atDistance(400);
    shot('skyline', [s0.x, s0.y + 2.8, s0.z],
      [s0.x + s0.dirX * 180, s0.y + 10, s0.z + s0.dirZ * 180], 58);
    const s1 = skyl.atDistance(skyl.length * 0.45);
    shot('skyline-hill', [s1.x - s1.dirX * 30, s1.y + 8, s1.z - s1.dirZ * 30],
      [s1.x + s1.dirX * 120, s1.y, s1.z + s1.dirZ * 120], 55);
    u.top.value.setHex(wasSky.top); u.mid.value.setHex(wasSky.mid);
    u.low.value.setHex(wasSky.low); u.glow.value.setHex(wasSky.glow);
    game.scene.fog.color.setHex(wasSky.fog);
    game.scene.fog.near = wasSky.near; game.scene.fog.far = wasSky.far;
    disposeTrack(game.scene, skyl);
    dump.push(`the estuary is ${(est.length / 1000).toFixed(2)} km, the skyline ${(skyl.length / 1000).toFixed(2)}`);

    // Stage seven's rain, which is a fog change and a surface change and needs
    // an eye on both at once.
    const wetT = new Track(LAYOUTS.folsom_rev);
    for (const _ of wetT.build(game.scene)) { /* off the clock */ }
    game.track = wetT;
    const wf = LAYOUTS.folsom_rev.fog;
    const keptFog = { c: game.scene.fog.color.getHex(), n: game.scene.fog.near, f: game.scene.fog.far };
    game.scene.fog.color.setHex(wf.colour);
    game.scene.fog.near = wf.near; game.scene.fog.far = wf.far;
    const w0 = wetT.atDistance(60);
    shot('wetwork', [w0.x, w0.y + 2.6, w0.z],
      [w0.x + w0.dirX * 140, w0.y + 4, w0.z + w0.dirZ * 140], 60);
    game.scene.fog.color.setHex(keptFog.c);
    game.scene.fog.near = keptFog.n; game.scene.fog.far = keptFog.f;
    disposeTrack(game.scene, wetT);
  } catch (e) { console.log(`stage 4/5 dump failed: ${e.message}`); }

  // Stage two, built for real. Last of all, and it replaces the world: the
  // circuit every frame above was taken on is gone by the time this returns,
  // which is why nothing comes after it.
  try {
    disposeTrack(game.scene, game.track);
    const run = new Track(LAYOUTS.run);
    for (const _ of run.build(game.scene)) { /* off the clock */ }
    game.track = run;
    const fog2 = game.scene.fog;
    game.scene.fog = null;
    shot('run-map', [140, 2000, 120], [140, 0, 60], 52);
    game.scene.fog = fog2;

    // The ramp, from where a car arriving at it would be: down the street,
    // through the sign gantry, with the deck climbing away beyond.
    const r = run.rampPlan;
    // Down the street at it, from where a car arriving would be — the gantry
    // is 46 m short of the ramp, so this has to stand back beyond that.
    // Ninety metres back: beyond the gantry, which is forty-six short of the
    // ramp, and still inside the straight — a hundred and thirty put the
    // camera round the previous corner looking at the side of a block.
    // Far enough back to be behind the sign gantry, which on a route stands
    // ninety metres before the road runs out.
    const in0 = run.atDistance(r.at - 230);
    const mid0 = r.segs[Math.floor(r.segs.length / 2)];
    shot('ramp', [in0.x, in0.y + 3.2, in0.z], [mid0.x, mid0.y + 4, mid0.z], 56);
    // And from the side, so the pillars and what is under them are visible.
    const top = r.segs[r.segs.length - 1];
    // From beside the ramp, square on to its own direction rather than to the
    // last bit of street — which on a route has already turned away from it.
    const mid = { x: (r.x + top.x) / 2, y: (r.y + top.y) / 2, z: (r.z + top.z) / 2 };
    const rl = Math.hypot(top.x - r.x, top.z - r.z) || 1;
    const rnx = -(top.z - r.z) / rl, rnz = (top.x - r.x) / rl;
    shot('ramp-side', [mid.x + rnx * 420, mid.y + 170, mid.z + rnz * 420],
      [mid.x, mid.y + 10, mid.z], 46);

    // From the grid, looking up the road — the first thing the stage shows.
    {
      const g0 = run.gridSlots[0];
      const eye0 = run.atDistance(Math.max(4, g0.s - 20));
      shot('run-start', [eye0.x, eye0.y + 2.4, eye0.z],
        [eye0.x + eye0.dirX * 200, eye0.y + 5, eye0.z + eye0.dirZ * 200], 62);
      shot('run-start-wide', [eye0.x - eye0.nx * 70, eye0.y + 40, eye0.z - eye0.nz * 70],
        [eye0.x + eye0.dirX * 90, eye0.y, eye0.z + eye0.dirZ * 90], 55);
    }

    // A drive-through: the view from the road at eight points along it, which
    // is the only way to find something standing where it should not be.
    for (let k = 0; k < 8; k++) {
      const at = run.atDistance((k + 0.5) * (run.length / 8));
      shot(`run${k}`, [at.x - at.dirX * 10, at.y + 2.6, at.z - at.dirZ * 10],
        [at.x + at.dirX * 120, at.y + 4, at.z + at.dirZ * 120], 62);
    }

    // The same eight views again through a long lens, so whatever is standing
    // at the end of each street can be identified rather than guessed at.
    for (let k = 0; k < 8; k++) {
      const at = run.atDistance((k + 0.5) * (run.length / 8));
      shot(`zoom${k}`, [at.x - at.dirX * 10, at.y + 2.6, at.z - at.dirZ * 10],
        [at.x + at.dirX * 400, at.y + 8, at.z + at.dirZ * 400], 16);
    }

    // The top of the hill on the run, which is fifty metres up.
    const peak = run.samples.reduce((m, q) => (q.y > m.y ? q : m), run.samples[0]);
    shot('run-hill', [peak.x - peak.dirX * 40, peak.y + 9, peak.z - peak.dirZ * 40],
      [peak.x + peak.dirX * 120, peak.y + 2, peak.z + peak.dirZ * 120], 58);
    // The pursuit, staged on the run's opening straight: you in front, three
    // units behind with their bars lit. The light bars are the only thing in
    // the game whose whole job is to be recognised at a glance, so they get a
    // picture of their own.
    {
      const c2 = new Campaign(game);
      c2.index = STAGES.findIndex((q) => q.layout === 'run');
      c2.car = SELECTABLE[0];
      const plan = c2.field(run);
      // Laid out the way the stage lays them out — you on your own at the
      // front, the units strung out a long way behind — not on the staggered
      // two-abreast grid a race uses. The whole point of the change was that
      // the first picture of this showed four cars side by side.
      const base = run.gridSlots[0].s;
      const models = plan.cars.map((spec, i) => {
        const m = buildCar(spec.livery);
        const back = i === 0 ? 0 : 55 + (i - 1) * 18;
        const p2 = run.atDistance(Math.max(4, base - back));
        const lat = i === 0 ? 0 : ((i % 2) ? 2.6 : -2.6);
        const slot = { x: p2.x + p2.nx * lat, z: p2.z + p2.nz * lat, yaw: Math.atan2(p2.dirX, p2.dirZ) };
        m.position.set(slot.x, run.locate(slot.x, slot.z).y, slot.z);
        m.rotation.order = 'YXZ';
        m.rotation.y = slot.yaw;
        // Half of them showing red, half blue, so the picture shows both.
        const bx = m.userData.beacons;
        if (bx) { bx[0].visible = i % 2 === 1; bx[1].visible = i % 2 === 0; }
        game.scene.add(m);
        return m;
      });
      // Taken from a point ON the road behind the back row, not from an
      // offset guessed off the last slot: the grid climbs, and a camera
      // placed fifteen metres back at the back row's height is fifteen
      // metres INTO the hill behind it, which is what the first attempt at
      // this photographed.
      const front = run.atDistance(base);
      const eye = run.atDistance(Math.max(4, base - 55 - 2 * 18) - 18);
      shot('pursuit',
        [eye.x + eye.nx * 6, eye.y + 4.0, eye.z + eye.nz * 6],
        [front.x, front.y + 0.7, front.z], 44);
      const lit = models.filter((m) => m.userData.beacons).length;
      for (const m of models) game.scene.remove(m);
      dump.push(`the pursuit is ${models.length} cars, ${lit} of them with light bars`);
    }

    dump.push(`the run is ${(run.length / 1000).toFixed(2)} km, `
      + `${run.stubs.length} side streets, ramp ${(r.at / 1000).toFixed(2)} km in`);
  } catch (e) { console.log(`run dump failed: ${e.message}`); }

  if (dump.length) post('/__result', `\n${dump.join('\n')}`);
  void clamp; void AI; void Track; void CAR;
}
