// CIRCUIT DE VALMONT.
//
// The track is one closed spline. Everything else — the asphalt, the kerbs, the
// barriers, the grid, the racing line, the AI's speed profile, the lap timing
// and the minimap — is derived from it, so none of those can disagree with each
// other about where the circuit goes.
//
// It is described as a radius and an elevation at each of thirty angles around
// a loop. Written that way the circuit cannot cross itself (the angles only
// ever increase) while the radius is free to swing from a hundred and forty
// metres to two hundred and fifty, which is what gives it a long straight, two
// hairpins, a set of esses and a pair of fast sweepers rather than the oval
// that a constant radius would produce.

import * as THREE from 'three';
import { MeshBuilder, G, VC_MATERIAL, VC_UNLIT, poolMaterial } from './meshkit.js';
import { clamp, lerp, rand, pick } from './utils.js';

export const TRACK_NAME = 'SAN FRANCISCO STREET CIRCUIT';
// Metres between track samples. This sets the resolution of everything derived
// from the spline — the asphalt, the kerbs, the walls, the racing line — so it
// is the single biggest lever on how smooth the circuit looks.
const SAMPLE_STEP = 1.6;
const DEFAULT_WIDTH = 11.6;           // metres, edge to edge — a city street

// The street grid.
//
// A city is not a shape, it is a grid, and a circuit laid out in a city is a
// lap of it — straight streets meeting at junctions, not a curve that happens
// to have buildings beside it. So the layout is given as junctions on a grid
// and the road is generated between them: straight the whole way, with a
// fillet at each corner because a car cannot turn a mathematical right angle.
//
// PITCH is the block. Everything else — where the side streets are, where the
// buildings go, how long the straights come out — follows from it.
const PITCH_X = 52, PITCH_Z = 45;

// The turning radius at a junction, how wide the road is there, and how wide
// the junction ITSELF is — which is a different number, and has to be.
//
// For the junction to read as a plus — the union of two straight streets,
// which is what an intersection is — the whole curved racing surface has to
// fit inside it. The arc's inner edge reaches (r(root2 - 1) + h) / root2 from
// the junction centre on each axis, so the junction half-width H must satisfy
//
//     H >= (r(root2 - 1) + h) / root2
//
// The obvious move is to widen the road at the junction until it satisfies
// that. It does not work: setting h = H collapses the condition to H >= r,
// a thirty-six metre roadway — and worse, the wall that stops a car cutting
// the inside of the corner sits at h + 5.6 from the centreline, so its radius
// is r - (h + 5.6). Make h large enough and that goes negative: the inside of
// every corner opens up and you can drive straight through it into the city.
// Both conditions together are only satisfiable when the ROAD is narrower than
// the JUNCTION, which is also simply true of the real thing — the tarmac at a
// crossroads is wider than the lanes running through it.
//
// So the road keeps the width and radius it had, and the junction is laid
// wider around it, with its arms tapering back to meet the road at the seam.
const FILLET = 18;
const JUNCTION_WIDTH = 15.4;        // the ROAD, at a junction
const JUNCTION_FLAT = 6;
const JUNCTION_REACH = 20;
const JUNCTION_OWNS = 18;           // the junction lays its own surface within this
const JUNCTION_HALF = 12;           // and this is how wide the junction is
const JUNCTION_TAPER = 14;          // held to here, then narrowed to meet the road

// The lap, as (column, row) on that grid. It is rectilinear apart from one
// diagonal avenue across the top of the hill, which is the one thing a real
// grid city always has cutting across it.
const LOOP = [
  [0, 0], [5, 0], [5, 2], [8, 2], [8, 5], [6, 7],
  [2, 7], [2, 9], [-3, 9], [-3, 5], [-1, 3], [-1, 0],
];

// The hill, as height against fraction of a lap.
//
// Against DISTANCE, not against any angle or index: grade is rise per metre
// travelled, so anything else makes the same rise into a different slope
// depending on how long the street it falls on happens to be.
const ELEVATION = [
  [0.00, 0.8], [0.10, 1.0], [0.24, 12], [0.40, 26], [0.52, 30],
  [0.62, 28], [0.74, 15], [0.88, 4], [0.96, 1.2],
];

export class Track {
  constructor() {
    // Centred on the origin. The ground plane, the fog, the sky dome and the
    // landmarks across the bay are all built around 0,0, and a grid written
    // from a corner is not — so move the grid rather than every one of them.
    const raw = LOOP.map(([c, r]) => ({ x: c * PITCH_X, z: r * PITCH_Z }));
    const cx = (Math.min(...raw.map((j) => j.x)) + Math.max(...raw.map((j) => j.x))) / 2;
    const cz = (Math.min(...raw.map((j) => j.z)) + Math.max(...raw.map((j) => j.z))) / 2;
    this.junctions = raw.map((j) => ({ x: j.x - cx, z: j.z - cz }));
    this.origin = { cx, cz };            // so the blocks can be laid on the same grid
    this._sample();
    this._buildRacingLine();
    this._buildSpeedProfile();
    this._grid();
    this._hash();
    // After the spatial hash, not before: laying out the side streets asks
    // locate() where the circuit is, and locate() cannot answer until the hash
    // it searches exists.
    this._sideStreets();
  }

  // ---------------------------------------------------------- geometry

  // The centreline: straight from junction to junction, with an arc at each
  // corner.
  //
  // A fillet, not a spline. Running a curve through the junctions would bend
  // the streets between them, and a street that bows is the exact thing that
  // made the old layout read as a race track with buildings beside it rather
  // than as a city. Here the straights are straight to the millimetre and all
  // of the turning happens in the last few metres before the corner, which is
  // what driving in a city actually feels like: nothing, nothing, nothing,
  // then a junction.
  _centreline() {
    const J = this.junctions;
    const n = J.length;
    const out = [];
    this.corners = [];
    for (let i = 0; i < n; i++) {
      const a = J[(i - 1 + n) % n], b = J[i], c = J[(i + 1) % n];
      const v1x = b.x - a.x, v1z = b.z - a.z;
      const v2x = c.x - b.x, v2z = c.z - b.z;
      const l1 = Math.hypot(v1x, v1z) || 1, l2 = Math.hypot(v2x, v2z) || 1;
      const u1x = v1x / l1, u1z = v1z / l1;
      const u2x = v2x / l2, u2z = v2z / l2;
      const turn = Math.atan2(u1x * u2z - u1z * u2x, u1x * u2x + u1z * u2z);
      if (Math.abs(turn) < 1e-4) {                 // three junctions in a line
        out.push({ x: b.x, z: b.z });
        continue;
      }
      // Never eat more than four tenths of a leg, or two corners on a short
      // block run into each other and the street between them disappears.
      const r = Math.min(FILLET, 0.42 * l1, 0.42 * l2);
      const t = r * Math.abs(Math.tan(turn / 2));
      const sx = b.x - u1x * t, sz = b.z - u1z * t;
      const ex = b.x + u2x * t, ez = b.z + u2z * t;
      const sgn = Math.sign(turn);
      const cx = sx - u1z * r * sgn, cz = sz + u1x * r * sgn;
      let a0 = Math.atan2(sz - cz, sx - cx);
      const a1 = Math.atan2(ez - cz, ex - cx);
      let d = a1 - a0;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const steps = Math.max(3, Math.round((Math.abs(d) * r) / 0.8));
      out.push({ x: sx, z: sz });
      for (let k = 1; k < steps; k++) {
        const ang = a0 + (d * k) / steps;
        out.push({ x: cx + Math.cos(ang) * r, z: cz + Math.sin(ang) * r });
      }
      out.push({ x: ex, z: ez });
      this.corners.push({ x: b.x, z: b.z, turn, r, u1x, u1z, u2x, u2z });
    }

    // Subdivide the straights, so the fine polyline is dense enough for the
    // arc-length resampling that follows to land where it means to.
    const dense = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      const k = Math.max(1, Math.round(d / 1.2));
      for (let j = 0; j < k; j++) {
        dense.push({ x: lerp(a.x, b.x, j / k), z: lerp(a.z, b.z, j / k), y: 0, width: 0 });
      }
    }

    // Width: the plain street, opening out at every junction.
    //
    // Held at the full junction width out past where the junction draws its
    // own surface, and only then tapered back. A width that starts narrowing
    // immediately would leave the road narrower than the plus arm it has to
    // meet, and the two would not line up at the seam.
    for (const q of dense) {
      let w = DEFAULT_WIDTH;
      // At the CORNERS, not at every grid junction. Three of the twelve points
      // in the lap are collinear — the road runs straight through them — and
      // widening there put an unexplained bulge in the middle of a straight,
      // where there is no junction to be wide for.
      for (const j of this.corners) {
        const d = Math.hypot(q.x - j.x, q.z - j.z);
        if (d >= JUNCTION_REACH) continue;
        const t = clamp((d - JUNCTION_FLAT) / (JUNCTION_REACH - JUNCTION_FLAT), 0, 1);
        w = Math.max(w, lerp(JUNCTION_WIDTH, DEFAULT_WIDTH, t));
      }
      q.width = w;
    }

    // Height, by fraction of the lap. Needs the lap length, so measure first.
    let total = 0;
    for (let i = 0; i < dense.length; i++) {
      const a = dense[i], b = dense[(i + 1) % dense.length];
      a.d = Math.hypot(b.x - a.x, b.z - a.z);
      a.at = total;
      total += a.d;
    }
    for (const q of dense) {
      const f = q.at / total;
      let y = ELEVATION[0][1];
      for (let k = 0; k < ELEVATION.length; k++) {
        const [f0, y0] = ELEVATION[k];
        const [f1, y1] = k + 1 < ELEVATION.length ? ELEVATION[k + 1] : [1, ELEVATION[0][1]];
        if (f >= f0 && f <= f1) { y = lerp(y0, y1, (f - f0) / (f1 - f0 || 1)); break; }
      }
      q.y = y;
    }
    // Smoothing passes over the height, weighted by spacing, so the joins
    // between the elevation control points are not creases.
    for (let pass = 0; pass < 30; pass++) {
      const next = dense.map((q, i) => {
        const a = dense[(i - 1 + dense.length) % dense.length];
        const b = dense[(i + 1) % dense.length];
        return (a.y + b.y + q.y * 2) / 4;
      });
      for (let i = 0; i < dense.length; i++) dense[i].y = next[i];
    }
    return dense;
  }

  // Walk the streets, then re-space the result evenly by arc length so that
  // "twelve metres further on" means the same thing everywhere — the AI, the
  // timing and the minimap all depend on it.
  _sample() {
    const fine = this._centreline();

    // Arc length along the fine polyline.
    let total = 0;
    for (let i = 0; i < fine.length; i++) {
      const a = fine[i], b = fine[(i + 1) % fine.length];
      a.seg = Math.hypot(b.x - a.x, b.z - a.z);
      a.s = total;
      total += a.seg;
    }
    this.length = total;

    const count = Math.max(64, Math.round(total / SAMPLE_STEP));
    this.step = total / count;
    this.samples = [];
    let fi = 0, acc = 0;
    for (let i = 0; i < count; i++) {
      const target = i * this.step;
      while (fi < fine.length - 1 && fine[fi].s + fine[fi].seg < target) { fi++; acc = fine[fi].s; }
      const a = fine[fi], b = fine[(fi + 1) % fine.length];
      const t = a.seg > 1e-6 ? (target - a.s) / a.seg : 0;
      this.samples.push({
        i,
        s: target,
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        z: lerp(a.z, b.z, t),
        width: lerp(a.width, b.width, t),
      });
      void acc;
    }

    // Tangents, left normals and curvature, from the neighbours of each sample.
    const N = this.samples.length;
    for (let i = 0; i < N; i++) {
      // Also a fixed distance, for the same reason: curvature measured over
      // one sample means something different at every sampling step, and the
      // kerbs and the speed profile both read it.
      const K = Math.max(1, Math.round(2.5 / this.step));
      const p0 = this.samples[(i - K + N) % N];
      const p1 = this.samples[i];
      const p2 = this.samples[(i + K) % N];
      const dx = p2.x - p0.x, dz = p2.z - p0.z;
      const len = Math.hypot(dx, dz) || 1;
      p1.dirX = dx / len;
      p1.dirZ = dz / len;
      p1.nx = -p1.dirZ;                 // left of the direction of travel
      p1.nz = p1.dirX;
      // Menger curvature of the three points: 1 / radius of the circle they lie on.
      const a = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      const b = Math.hypot(p2.x - p1.x, p2.z - p1.z);
      const c = Math.hypot(p2.x - p0.x, p2.z - p0.z);
      const area = Math.abs((p1.x - p0.x) * (p2.z - p0.z) - (p2.x - p0.x) * (p1.z - p0.z)) / 2;
      p1.curvature = (a * b * c) > 1e-6 ? (4 * area) / (a * b * c) : 0;
      // Signed, so the AI knows which way it bends.
      const cross = (p1.x - p0.x) * (p2.z - p1.z) - (p1.z - p0.z) * (p2.x - p1.x);
      p1.bend = cross > 0 ? 1 : -1;
      p1.grade = (p2.y - p0.y) / (a + b || 1);
    }

    // --- level the corners.
    //
    // The road is level across its width, so a sample's height applies from
    // one white line to the other. The inside of a bend covers that rise in a
    // shorter arc than the centreline does, so it climbs by the same amount
    // over less ground and is steeper for it — by r / (r - halfWidth), which
    // at the radii this circuit turns at is not a correction, it is a
    // multiplier of four or five. A seven per cent street becomes a one-in-
    // three ramp on the inside of the corner, and the road looks like it rears
    // up as you turn into it.
    //
    // So cap what the inside line is allowed to do rather than what the
    // centreline is, and let the heights settle wherever they must to satisfy
    // it. The elevation is not lost, it moves: the corners come out close to
    // level and the blocks between them keep the hill, which is how a city
    // built on hills actually goes together.
    const MAX_INNER = 0.088;
    const MAX_AMP = 3;
    const cap = this.samples.map((p) => {
      const r = p.curvature > 1e-6 ? 1 / p.curvature : Infinity;
      const inner = Math.max(2.0, r - p.width / 2);
      // Capped. Once the road is wider than the corner is tight — which is
      // exactly what a plus-shaped junction is, twenty-six metres across a
      // twelve-metre radius — r / (r - halfWidth) runs away to ten or more and
      // asks for a grade of a fraction of a per cent. The relaxation cannot
      // reach it, gives up part-way, and leaves the corner steeper than if it
      // had been asked for something possible. A junction is a flat square of
      // tarmac anyway; the ribbon geometry this measure assumes is not what is
      // there.
      const amp = Number.isFinite(r) ? Math.min(MAX_AMP, r / inner) : 1;
      return MAX_INNER / amp;
    });
    // Gauss-Seidel: walk the loop repeatedly, and wherever a segment is over
    // its limit push its two ends together by the excess. Each correction
    // moves one end up exactly as far as it moves the other down, so the mean
    // height never shifts — the hill is redistributed, not flattened away.
    for (let pass = 0; pass < 400; pass++) {
      let worst = 0;
      for (let i = 0; i < N; i++) {
        const a2 = this.samples[i], b2 = this.samples[(i + 1) % N];
        const lim = Math.min(cap[i], cap[(i + 1) % N]);
        const g = (b2.y - a2.y) / this.step;
        const over = Math.abs(g) - lim;
        if (over <= 0) continue;
        worst = Math.max(worst, over);
        const shift = (over * this.step) / 2 * Math.sign(g);
        a2.y += shift;
        b2.y -= shift;
      }
      if (worst < 1e-4) break;
    }
    // Heights moved, so the grades that were read off them have to be read
    // again.
    for (let i = 0; i < N; i++) {
      const K = Math.max(1, Math.round(2.5 / this.step));
      const p0 = this.samples[(i - K + N) % N];
      const p1 = this.samples[i];
      const p2 = this.samples[(i + K) % N];
      const a = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      const b = Math.hypot(p2.x - p1.x, p2.z - p1.z);
      p1.grade = (p2.y - p0.y) / (a + b || 1);
    }

    // --- put the start of the lap on the longest straight.
    //
    // Where s = 0 falls is not a cosmetic choice: the grid is laid out in the
    // ninety metres BEHIND it, and the lap counter fires when a car crosses
    // it. Left wherever the layout happened to begin, both ended up in the
    // middle of an intersection — sixteen cars stopped across a crossroads,
    // and the timing line drawn through a junction. Rotating the sample array
    // moves all of it at once, because everything downstream is expressed in
    // terms of the index.
    {
      const straight = this.samples.map((p) => (p.curvature < 0.0025 ? 1 : 0));
      let bestAt = 0, bestLen = 0, run = 0, runAt = 0;
      for (let k = 0; k < N * 2; k++) {
        const i = k % N;
        if (straight[i]) {
          if (run === 0) runAt = i;
          run++;
          if (run > bestLen && run <= N) { bestLen = run; bestAt = runAt; }
        } else run = 0;
      }
      if (bestLen * this.step > 110) {
        // Far enough into the straight that the grid, which is laid out in the
        // ninety metres BEHIND the line, fits on it — and no further, so that
        // everything left of the straight is run-up. Put the line late and the
        // field crosses it and arrives at a corner; put it here and they get
        // the length of the street to sort themselves out on.
        const need = Math.round(105 / this.step);
        const k = (bestAt + Math.min(need, Math.round(bestLen * 0.55))) % N;
        this.samples = this.samples.slice(k).concat(this.samples.slice(0, k));
        this.samples.forEach((p, i) => { p.i = i; p.s = i * this.step; });
        this.startStraight = bestLen * this.step;
      }
    }
  }

  at(index) { return this.samples[((index % this.samples.length) + this.samples.length) % this.samples.length]; }

  // The sample nearest a distance along the lap, wrapping round.
  atDistance(s) {
    const n = this.samples.length;
    const i = Math.round((((s % this.length) + this.length) % this.length) / this.step);
    return this.samples[i % n];
  }

  // ------------------------------------------------------- racing line

  // A racing line, found by relaxation: repeatedly pull each point toward the
  // midpoint of its neighbours, which straightens the path, and clamp it back
  // inside the white lines. What falls out is the usual thing — out, in, out —
  // because the shortest smooth path through a corner is exactly that.
  _buildRacingLine() {
    const N = this.samples.length;
    const off = new Float32Array(N);
    const next = new Float32Array(N);
    const limit = (i) => this.samples[i].width / 2 - 1.25;
    // Windows are given in METRES and converted, not counted in samples.
    // Counted in samples they change meaning whenever the sampling does: at a
    // finer step the line is relaxed and measured over a shorter stretch of
    // road, reads tighter curvature than is really there, and the speed
    // profile built from it slows the whole circuit down.
    const W = Math.max(2, Math.round(12 / this.step));
    for (let pass = 0; pass < Math.round(600 * (2.5 / this.step)); pass++) {
      for (let i = 0; i < N; i++) {
        const a = this.samples[(i - W + N) % N], b = this.samples[i], c = this.samples[(i + W) % N];
        const oa = off[(i - W + N) % N], oc = off[(i + W) % N];
        // Where the midpoint of the neighbours lands, in this sample's normal.
        const mx = (a.x + oa * a.nx + c.x + oc * c.nx) / 2;
        const mz = (a.z + oa * a.nz + c.z + oc * c.nz) / 2;
        const want = (mx - b.x) * b.nx + (mz - b.z) * b.nz;
        next[i] = clamp(lerp(off[i], want, 0.35), -limit(i), limit(i));
      }
      off.set(next);
    }
    this.line = [];
    for (let i = 0; i < N; i++) {
      const b = this.samples[i];
      this.line.push({
        i,
        s: b.s,
        offset: off[i],
        x: b.x + off[i] * b.nx,
        z: b.z + off[i] * b.nz,
        y: b.y,
      });
    }
    // Curvature of the line itself — this, not the centreline's, is what sets
    // how fast a car can go.
    // Smooth the offsets before measuring, and measure over twenty metres: a
    // five-metre window reads the relaxation's own ripple as curvature and
    // reports a straight as a corner.
    for (let pass = 0; pass < Math.round(14 * (2.5 / this.step)); pass++) {
      const sm = this.line.map((p, i) => (
        this.line[(i - 1 + N) % N].offset + p.offset * 2 + this.line[(i + 1) % N].offset) / 4);
      for (let i = 0; i < N; i++) {
        const b = this.samples[i];
        this.line[i].offset = sm[i];
        this.line[i].x = b.x + sm[i] * b.nx;
        this.line[i].z = b.z + sm[i] * b.nz;
      }
    }
    for (let i = 0; i < N; i++) {
      const C = Math.max(2, Math.round(15 / this.step));
      const p0 = this.line[(i - C + N) % N], p1 = this.line[i], p2 = this.line[(i + C) % N];
      const a = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      const b = Math.hypot(p2.x - p1.x, p2.z - p1.z);
      const c = Math.hypot(p2.x - p0.x, p2.z - p0.z);
      const area = Math.abs((p1.x - p0.x) * (p2.z - p0.z) - (p2.x - p0.x) * (p1.z - p0.z)) / 2;
      p1.curvature = (a * b * c) > 1e-6 ? (4 * area) / (a * b * c) : 0;
    }
  }

  // How fast a car can be at each point: the cornering limit, then a backward
  // pass so it is already slow enough by the time it arrives, then a forward
  // pass so it does not pretend to accelerate harder than it can.
  _buildSpeedProfile(latG = 1.38, brakeG = 1.45, accelG = 0.70, vMax = 82) {
    const N = this.line.length;
    const v = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const r = this.line[i].curvature > 1e-5 ? 1 / this.line[i].curvature : 1e6;
      v[i] = Math.min(vMax, Math.sqrt(latG * 9.81 * r));
    }
    for (let pass = 0; pass < 3; pass++) {
      for (let k = N - 1; k >= 0; k--) {
        const i = k, j = (i + 1) % N;
        const d = this.step;
        const cap = Math.sqrt(v[j] * v[j] + 2 * brakeG * 9.81 * d);
        if (v[i] > cap) v[i] = cap;
      }
      for (let k = 0; k < N; k++) {
        const i = k, j = (i - 1 + N) % N;
        const d = this.step;
        const cap = Math.sqrt(v[j] * v[j] + 2 * accelG * 9.81 * d);
        if (v[i] > cap) v[i] = cap;
      }
    }
    for (let i = 0; i < N; i++) this.line[i].speed = v[i];
  }

  // ------------------------------------------------------------- lookup

  // A uniform grid of sample indices, so "where am I on the track?" is a
  // constant-time question rather than a search over six hundred samples,
  // sixteen times a frame.
  _hash() {
    this.cell = 24;
    this.buckets = new Map();
    const key = (cx, cz) => `${cx},${cz}`;
    for (const p of this.samples) {
      const cx = Math.floor(p.x / this.cell), cz = Math.floor(p.z / this.cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const k = key(cx + dx, cz + dz);
          let list = this.buckets.get(k);
          if (!list) { list = []; this.buckets.set(k, list); }
          list.push(p.i);
        }
      }
    }
  }

  // Where a world position sits on the circuit: which sample, how far along the
  // lap, and how far to the left of the centreline.
  locate(x, z, hint = -1) {
    let best = null, bestD = Infinity;
    const consider = (i) => {
      const p = this.at(i);
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bestD) { bestD = d; best = p; }
    };
    // A car moves a few metres per frame, so last frame's answer is nearly
    // this frame's: check around it first and only fall back to the grid.
    if (hint >= 0) {
      for (let d = -6; d <= 6; d++) consider(hint + d);
      if (bestD < this.cell * this.cell) return this._refine(x, z, best);
    }
    const list = this.buckets.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`);
    if (list) for (const i of list) consider(i);
    else for (const p of this.samples) consider(p.i);
    return this._refine(x, z, best);
  }

  _refine(x, z, p) {
    // Project onto the segment through this sample for a smooth distance.
    const along = (x - p.x) * p.dirX + (z - p.z) * p.dirZ;
    const lateral = (x - p.x) * p.nx + (z - p.z) * p.nz;

    // Height comes from between the samples, not from the nearest one.
    // Returning the nearest sample's y means the road is a staircase 2.5 m at
    // a tread: on an eight per cent grade that is a two-centimetre step every
    // tread, which the car sits on and jumps up as it crosses — and everything
    // that reads its height off the road, the camera included, jumps with it.
    const t = clamp(along / this.step, -1, 1);
    const nb = this.at(p.i + (t >= 0 ? 1 : -1));
    const f = Math.abs(t);
    return {
      sample: p,
      index: p.i,
      s: (p.s + along + this.length) % this.length,
      lateral,
      width: p.width,
      onTrack: Math.abs(lateral) <= p.width / 2,
      y: lerp(p.y, nb.y, f),
      grade: lerp(p.grade, nb.grade, f),
    };
  }

  // ---------------------------------------------------------- the grid

  _grid() {
    // Eight rows of two, staggered, stacked up behind the line.
    this.gridSlots = [];
    for (let i = 0; i < 16; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? 1 : -1;
      const s = (this.length - 26) - row * 8.5;
      const p = this.atDistance(s);
      const off = side * 3.4;
      this.gridSlots.push({
        x: p.x + p.nx * off,
        z: p.z + p.nz * off,
        y: p.y,
        yaw: Math.atan2(p.dirX, p.dirZ),
        s,
      });
    }
    const start = this.atDistance(0);
    this.startLine = { x: start.x, z: start.z, dirX: start.dirX, dirZ: start.dirZ, nx: start.nx, nz: start.nz };
  }

  // ------------------------------------------------------------- meshes

  // Built in stages, as a generator.
  //
  // Putting a city together takes a second or two, and JavaScript is one
  // thread: while it runs, nothing paints. That is why the loading bar sat
  // still — it was not that the animation was wrong, it was that the browser
  // never got a frame to draw it in. Yielding between phases hands the thread
  // back often enough for the loading screen to keep moving and to say what it
  // is doing.
  *build(scene) {
    const group = new THREE.Group();
    scene.add(group);
    const N = this.samples.length;

    // --- the ground the circuit sits on.
    //
    // It has to follow the circuit rather than roll independently of it: a
    // landscape with its own three metres of undulation puts the grass above
    // the track in places, which leaves the barriers and the trackside looking
    // like they are floating over a field.
    const groundGeo = new THREE.PlaneGeometry(1800, 1800, 220, 220);
    groundGeo.rotateX(-Math.PI / 2);
    {
      const pos = groundGeo.attributes.position;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i);
        // The city floor: it stays with the circuit near the road and then
        // keeps climbing away from it, because the hills here do not stop at
        // the kerb. Beyond the far edge it drops away to the bay.
        let bestD = Infinity;
        for (const p of this.samples) {
          const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
          if (d < bestD) bestD = d;
        }
        const dist = Math.sqrt(bestD);
        const bay = clamp((dist - 340) / 200, 0, 1);
        pos.setY(i, this.groundAt(x, z));
        // Blocks of city, read as a grid of paving and rooftops, going blue
        // where the streets run out and the water starts.
        const block = (Math.floor(x / 34) + Math.floor(z / 34)) % 2 ? 0.06 : 0;
        const n = Math.sin(x * 0.021 + z * 0.013) * Math.cos(z * 0.017 - x * 0.011) * 0.5 + 0.5;
        const g = 0.30 + n * 0.10 + block;
        const w = bay;
        col[i * 3] = (g * 0.98) * (1 - w) + 0.13 * w;
        col[i * 3 + 1] = (g * 0.96) * (1 - w) + 0.24 * w;
        col[i * 3 + 2] = (g * 0.92) * (1 - w) + 0.34 * w;
      }
      groundGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      groundGeo.computeVertexNormals();
    }
    group.add(new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));
    yield 'the ground';

    // --- the road, as one ribbon of triangles with the kerbs and the verge
    const road = [];
    const roadCol = [];
    const push = (ax, ay, az, bx, by, bz, cx2, cy, cz2, r, g, b) => {
      road.push(ax, ay, az, bx, by, bz, cx2, cy, cz2);
      for (let k = 0; k < 3; k++) roadCol.push(r, g, b);
    };
    const quad = (p, q, colour, l0, r0, l1, r1, lift) => {
      const [r8, g8, b8] = colour;
      const ax = p.x + p.nx * l0, az = p.z + p.nz * l0;
      const bx = p.x + p.nx * r0, bz = p.z + p.nz * r0;
      const cx2 = q.x + q.nx * l1, cz2 = q.z + q.nz * l1;
      const dx = q.x + q.nx * r1, dz = q.z + q.nz * r1;
      push(ax, p.y + lift, az, bx, p.y + lift, bz, dx, q.y + lift, dz, r8, g8, b8);
      push(ax, p.y + lift, az, dx, q.y + lift, dz, cx2, q.y + lift, cz2, r8, g8, b8);
    };

    // This is a street, so it is marked like one. No red-and-white kerbs, no
    // painted apex strips — those are circuit furniture, and a car park with
    // kerbs on it does not become a race track any more than a street does.
    // What a city road has is a double yellow down the middle, dashed white
    // between the lanes, a solid white line at the edge, crossings at the
    // junctions, a grey concrete curb and a lot of patching.
    const LANE = 2.9;                            // what a city lane measures
    for (let i = 0; i < N; i++) {
      const p = this.samples[i], q = this.samples[(i + 1) % N];
      // The junction lays its own surface, square, and this ribbon is the
      // thing that was making the corner look curved. Stop at the edge of it.
      // The centreline is straight again well before here — the fillet's
      // tangent point is twelve metres from the junction and this stops at
      // eighteen — so the two meet in line and at the same width.
      if (this.inJunction(p.x, p.z) || this.inJunction(q.x, q.z)) continue;
      const hw0 = p.width / 2, hw1 = q.width / 2;
      // Asphalt. Real road surface is a patchwork of different ages, so the
      // variation is blocky and irregular rather than a smooth wave — it is
      // resurfacing, not shading.
      const patch = Math.sin(i * 0.37) * Math.cos(i * 0.11) * 0.5 + 0.5;
      const seam = i % 23 === 0 || i % 37 === 0;
      const a = 0.115 + patch * 0.055 + (seam ? 0.03 : 0);
      quad(p, q, [a, a * 1.02, a * 1.05], -hw0, hw0, -hw1, hw1, 0.02);

      // Edge line, solid white, close in to the curb.
      quad(p, q, [0.78, 0.78, 0.75], -hw0 + 0.18, -hw0 + 0.34, -hw1 + 0.18, -hw1 + 0.34, 0.03);
      quad(p, q, [0.78, 0.78, 0.75], hw0 - 0.34, hw0 - 0.18, hw1 - 0.34, hw1 - 0.18, 0.03);

      // The double yellow down the centre: two lines with a gap, which is what
      // tells you at a glance which way the traffic on each side is going.
      const YEL = [0.76, 0.60, 0.13];
      quad(p, q, YEL, -0.30, -0.16, -0.30, -0.16, 0.031);
      quad(p, q, YEL, 0.16, 0.30, 0.16, 0.30, 0.031);

      // Dashed white lane lines, wherever the road is wide enough for more
      // than one lane each way. Three metres of paint, six of gap.
      if (hw0 > LANE * 1.6 && i % 9 < 3) {
        for (const sd of [-1, 1]) {
          quad(p, q, [0.74, 0.74, 0.72], sd * LANE - 0.07, sd * LANE + 0.07,
            sd * LANE - 0.07, sd * LANE + 0.07, 0.030);
        }
      }

      // No curb and no pavement here. A pavement is not part of a road, it is
      // what is left over between the roads, and it can only be laid once all
      // of them are down — see the pavement pass further on.
    }

    // --- crossings and stop bars, at the junctions.
    //
    // A crossing is the single thing that most says "street" rather than
    // "circuit", so they go in wherever the road is straight enough to have a
    // junction — which is where the blocks meet, and nowhere near an apex.
    for (let i = 0; i < N; i += 47) {
      const p = this.samples[i];
      if (p.curvature > 0.004) continue;         // not in the middle of a bend
      if (this.inJunction(p.x, p.z)) continue;   // the junction lays its own
      const hw = p.width / 2;
      // The stop bar, then the zebra a couple of metres beyond it.
      const bar0 = this.samples[i], bar1 = this.samples[(i + 1) % N];
      quad(bar0, bar1, [0.76, 0.76, 0.73], -hw + 0.3, -0.35, -hw + 0.3, -0.35, 0.033);
      const stripes = Math.max(4, Math.round((p.width - 1.2) / 1.35));
      for (let k = 0; k < stripes; k++) {
        if (k % 2) continue;
        const l0 = -hw + 0.5 + (k / stripes) * (p.width - 1.0);
        const l1 = -hw + 0.5 + ((k + 0.85) / stripes) * (p.width - 1.0);
        for (let j = 3; j < 7; j++) {
          const c0 = this.samples[(i + j) % N], c1 = this.samples[(i + j + 1) % N];
          quad(c0, c1, [0.74, 0.74, 0.71], l0, l1, l0, l1, 0.033);
        }
      }
    }

    // --- the things a road accumulates: manhole covers, patches, tar seams.
    for (let i = 0; i < N; i += 7) {
      const p = this.samples[i], q = this.samples[(i + 1) % N];
      const hw = p.width / 2;
      // Anything that follows the ribbon has to stop at the junction, or the
      // curve it was drawn along shows straight through the square that was
      // laid to hide it. Patches and seams are exactly that: thin, dark, and
      // arcing.
      if (this.inJunction(p.x, p.z)) continue;
      const r = (i * 2654435761) % 1000 / 1000;   // stable, not random
      if (r < 0.30) {
        // A resurfacing patch, darker than what is round it, with a tar seam.
        const c0 = -hw + r * (p.width - 3.4), c1 = c0 + 2.2 + r * 1.2;
        for (let j = 0; j < 4; j++) {
          const s0 = this.samples[(i + j) % N], s1 = this.samples[(i + j + 1) % N];
          quad(s0, s1, [0.088, 0.090, 0.094], c0, c1, c0, c1, 0.024);
        }
      } else if (r < 0.46) {
        // A manhole, which is round, but at this size four sides is plenty.
        const c = -hw + 1.2 + r * (p.width - 2.4);
        quad(p, q, [0.20, 0.19, 0.17], c - 0.35, c + 0.35, c - 0.35, c + 0.35, 0.025);
      } else if (r < 0.56) {
        // A tar seam crawling across the lane.
        quad(p, q, [0.075, 0.078, 0.080], -hw + 0.5, hw - 0.5, -hw + 0.5, hw - 0.5, 0.023);
      }
    }

    // Cable-car rails, laid down the middle of the climb and the descent the
    // way they are up a hill here. They are paint on the road as far as the
    // physics is concerned — a rail you could catch a wheel on would be a
    // menace, and the real ones are flush with the setts anyway.
    for (let i = 0; i < N; i++) {
      const p = this.samples[i], q = this.samples[(i + 1) % N];
      if (p.y < 6) continue;                         // only up on the hill
      if (this.inJunction(p.x, p.z)) continue;       // and not across a junction
      for (const side of [-1, 1]) {
        quad(p, q, [0.34, 0.33, 0.31], side * 0.62, side * 0.62 + 0.09,
          side * 0.62, side * 0.62 + 0.09, 0.035);
      }
      // The slot between them.
      if (i % 2 === 0) quad(p, q, [0.20, 0.20, 0.19], -0.06, 0.06, -0.06, 0.06, 0.033);
    }

    // No start/finish line painted on the road. A city street does not have
    // one, and the lap counter does not need one — it fires on the distance
    // round the lap, not on anything drawn. Where the line IS matters a great
    // deal, which is why the lap is rotated to start on the longest straight;
    // what it looks like matters not at all.

    // --- the side streets, surfaced like the circuit is.
    //
    // Laid as tiles rather than as one ribbon, so the bits that fall on
    // something already surfaced can be dropped. A side street's corridor
    // starts at the junction centre, which is a place the circuit goes through
    // and where the OTHER side street off the same corner also starts — so
    // without the cutout you get two or three surfaces fighting over the same
    // ground in the middle of every junction.
    for (let si = 0; si < this.streets.length; si++) {
      const t = this.streets[si];
      const nx = -t.uz, nz = t.ux;
      const hw = t.width / 2;
      const span = t.to - t.from;
      const steps = Math.max(4, Math.round(span / 2.4));
      const bands = 8;
      const at = (d) => {
        const x = t.x + t.ux * d, z = t.z + t.uz * d;
        return { x, z, nx, nz, y: this.locate(x, z).y };
      };
      const clear = (d, m) => {
        const cx = t.x + t.ux * d + nx * m, cz = t.z + t.uz * d + nz * m;
        if (this.inJunction(cx, cz)) return false;
        return !this.onCircuitRoad(cx, cz) && !this.onStubRoad(cx, cz, si);
      };
      for (let k = 0; k < steps; k++) {
        const d0 = t.from + span * (k / steps);
        const d1 = t.from + span * ((k + 1) / steps);
        const dm = (d0 + d1) / 2;
        const A = at(d0), B = at(d1);
        const a2 = 0.112 + (k % 3) * 0.011;
        for (let j = 0; j < bands; j++) {
          const l0 = -hw + (j / bands) * t.width;
          const l1 = -hw + ((j + 1) / bands) * t.width;
          const mx = t.x + t.ux * dm + nx * ((l0 + l1) / 2);
          const mz = t.z + t.uz * dm + nz * ((l0 + l1) / 2);
          if (this.inJunction(mx, mz)) continue;
          if (!clear(dm, (l0 + l1) / 2)) continue;
          quad(A, B, [a2, a2 * 1.02, a2 * 1.05], l0, l1, l0, l1, 0.02);
        }
        // A crossing over the mouth of the side street and a bar to stop at,
        // both of which are things a junction has and a strip of tarmac laid
        // alongside one does not.
        const cross = dm > 7 && dm < 12;
        if (dm > 5.5 && dm < 6.4 && clear(dm, 0)) {
          quad(A, B, [0.76, 0.76, 0.73], -hw + 0.4, -0.3, -hw + 0.4, -0.3, 0.033);
        }
        if (cross) {
          const stripes = Math.max(4, Math.round((t.width - 1.2) / 1.35));
          for (let m = 0; m < stripes; m += 2) {
            const l0 = -hw + 0.5 + (m / stripes) * (t.width - 1.0);
            const l1 = -hw + 0.5 + ((m + 0.85) / stripes) * (t.width - 1.0);
            if (clear(dm, (l0 + l1) / 2)) quad(A, B, [0.74, 0.74, 0.71], l0, l1, l0, l1, 0.033);
          }
        }
        if (!cross) {
          if (clear(dm, 0)) {
            quad(A, B, [0.74, 0.60, 0.14], -0.24, -0.10, -0.24, -0.10, 0.031);
            quad(A, B, [0.74, 0.60, 0.14], 0.10, 0.24, 0.10, 0.24, 0.031);
          }
          if (clear(dm, -hw + 0.27)) quad(A, B, [0.74, 0.74, 0.71], -hw + 0.2, -hw + 0.34, -hw + 0.2, -hw + 0.34, 0.03);
          if (clear(dm, hw - 0.27)) quad(A, B, [0.74, 0.74, 0.71], hw - 0.34, hw - 0.2, hw - 0.34, hw - 0.2, 0.03);
        }
      }
    }

    // --- and the junction boxes, which square off what the fillet rounded.
    //
    // Rasterised rather than ribboned: what is wanted is the union of four
    // rectangles, and that is not a shape you can express as a strip.
    //
    // As a LATTICE, though, not as a heap of flat tiles. Each tile was a
    // square at one height with a little overlap onto its neighbours, which is
    // fine on the level and a staircase on a hill: the surface steps at every
    // seam, the overlaps fight over the same depth, and the whole junction
    // reads as a chessboard laid on a slope. Taking the height at the four
    // CORNERS instead makes each cell a proper quadrilateral, and since
    // neighbouring cells ask for the height at the same corner coordinates
    // they get the same answer — so the surface is continuous with no cracks
    // and no steps, however steep the street.
    {
      const CELL = 2.2;
      const hAt = new Map();
      const heightAt = (x, z) => {
        // Cached: every interior corner is asked for four times over.
        const key = `${Math.round(x * 8)},${Math.round(z * 8)}`;
        let y = hAt.get(key);
        if (y === undefined) { y = this.locate(x, z).y; hAt.set(key, y); }
        return y;
      };
      for (const box of this.boxes) {
        const R = box.reach + 1;
        const n = Math.ceil((R * 2) / CELL);
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const x0 = box.x - R + i * CELL, x1 = x0 + CELL;
            const z0 = box.z - R + j * CELL, z1 = z0 + CELL;
            if (!this.onJunctionBox((x0 + x1) / 2, (z0 + z1) / 2)) continue;
            const L = 0.02;
            const y00 = heightAt(x0, z0) + L, y10 = heightAt(x1, z0) + L;
            const y11 = heightAt(x1, z1) + L, y01 = heightAt(x0, z1) + L;
            // Surface variation over a scale much larger than the cell.
            //
            // Per-cell variation was the other half of why this read as a
            // grid: a different shade on every 2.2 m square is a chessboard,
            // whatever the geometry underneath is doing. Noise on a six-metre
            // scale spans several cells, so what you see is patched asphalt —
            // which is what a junction, the most re-dug piece of road in any
            // city, actually looks like.
            const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
            const n = Math.sin(mx * 0.17) * Math.cos(mz * 0.13)
                    + Math.sin((mx + mz) * 0.071) * 0.6;
            const a2 = 0.112 + n * 0.011;
            const c = [a2, a2 * 1.02, a2 * 1.05];
            // Wound anticlockwise seen from above, which for a +Y normal in a
            // right-handed frame means going x0z0 -> x1z1 -> x1z0. Wound the
            // other way the whole junction is back-facing, gets culled, and
            // what you see through the hole is the ground — a pale grey slab
            // exactly where the road should be.
            push(x0, y00, z0, x1, y11, z1, x1, y10, z0, c[0], c[1], c[2]);
            push(x0, y00, z0, x0, y01, z1, x1, y11, z1, c[0], c[1], c[2]);
          }
        }
      }

      // --- and the markings, which are what actually say "junction".
      //
      // A square of bare tarmac reads as a yard. What makes it a crossroads is
      // the paint: a crossing over the mouth of every arm and a bar to stop at
      // behind it, on all four, including the two the circuit uses.
      const paint = (box, arm, a0, a1, l0, l1, colour, lift) => {
        const nx = -arm.uz, nz = arm.ux;
        const P = (a, l) => {
          const x = box.x + arm.ux * a + nx * l, z = box.z + arm.uz * a + nz * l;
          return { x, z, y: heightAt(x, z) + lift };
        };
        const A = P(a0, l0), B = P(a1, l0), C = P(a1, l1), D = P(a0, l1);
        push(A.x, A.y, A.z, C.x, C.y, C.z, B.x, B.y, B.z, colour[0], colour[1], colour[2]);
        push(A.x, A.y, A.z, D.x, D.y, D.z, C.x, C.y, C.z, colour[0], colour[1], colour[2]);
      };
      const WHITE = [0.76, 0.76, 0.73];
      for (const box of this.boxes) {
        for (const arm of box.arms) {
          const hw = arm.hw;
          const c0 = box.reach - 11, c1 = box.reach - 4.5;   // the crossing
          // Zebra: bars running the way the traffic runs, spaced across.
          const bars = Math.max(4, Math.round((hw * 2 - 1.2) / 1.4));
          for (let k = 0; k < bars; k++) {
            if (k % 2) continue;
            const l0 = -hw + 0.6 + (k / bars) * (hw * 2 - 1.2);
            const l1 = -hw + 0.6 + ((k + 0.8) / bars) * (hw * 2 - 1.2);
            paint(box, arm, c0, c1, l0, l1, WHITE, 0.033);
          }
          // The stop bar, on the near side of the crossing, across the half of
          // the road that approaches — which is the half a car stops in.
          paint(box, arm, c0 - 2.2, c0 - 1.2, -hw + 0.5, -0.4, WHITE, 0.033);
          // And the yellow centre, up to the crossing and no further: paint
          // does not run through an intersection.
          for (const off of [[-0.30, -0.16], [0.16, 0.30]]) {
            paint(box, arm, c0 - 1.0, box.reach + 0.6, off[0], off[1], [0.76, 0.60, 0.13], 0.031);
          }
        }
        // A manhole or two, because every junction has them.
        for (let k = 0; k < 3; k++) {
          const a = ((k * 37) % 19) - 9, l = ((k * 53) % 17) - 8;
          const x = box.x + a, z = box.z + l;
          if (!this.onJunctionBox(x, z)) continue;
          const y = heightAt(x, z) + 0.025;
          const r = 0.42;
          const cc = [0.078, 0.080, 0.084];
          push(x - r, y, z - r, x + r, y, z + r, x + r, y, z - r, cc[0], cc[1], cc[2]);
          push(x - r, y, z - r, x - r, y, z + r, x + r, y, z + r, cc[0], cc[1], cc[2]);
        }
      }
    }

    // --- pavements, once every road is down.
    //
    // A pavement is not part of a road. Building it into the road ribbon, as
    // this did, means every street lays its own — so a side street's pavement
    // gets drawn straight across the racing surface of the circuit it joins,
    // and the two fight over the same ground for the whole width of the
    // junction. What a pavement actually is, is the ground that no road
    // covers, which is a thing you cannot know until all of them are laid.
    //
    // So: emit it as tiles, and drop any tile whose middle is on tarmac.
    const CURB = [0.56, 0.55, 0.53];
    const band = (p, q, a0, a1, b0, b1, colour, lift) => {
      const am = (a0 + a1) / 2, bm = (b0 + b1) / 2;
      const cx = (p.x + p.nx * am + q.x + q.nx * bm) / 2;
      const cz = (p.z + p.nz * am + q.z + q.nz * bm) / 2;
      if (this.onAnyRoad(cx, cz)) return;
      // And the rounded corner where two roads meet, which is what makes a
      // junction look joined up rather than crossed over.
      if (this.inCurbReturn(cx, cz)) return;
      quad(p, q, colour, a0, a1, b0, b1, lift);
    };
    // The pavement now runs all the way from the kerb to the frontage. It used
    // to stop at 4.2 m, which was fine while a wall stood there; with the wall
    // gone what was left was four metres of pavement, five metres of bare
    // ground a metre lower down, and then a building.
    const PAVE = 9.1, BANDS = 6;
    for (let i = 0; i < N; i++) {
      const p = this.samples[i], q = this.samples[(i + 1) % N];
      const hw0 = p.width / 2, hw1 = q.width / 2;
      const flag = i % 3 === 0 ? [0.50, 0.49, 0.47] : [0.46, 0.45, 0.43];
      for (const sd of [-1, 1]) {
        const e = (h, o) => sd * (h + o);
        const put = (o0, o1, colour, lift) => {
          const a = e(hw0, o0), b = e(hw0, o1), c = e(hw1, o0), d = e(hw1, o1);
          band(p, q, Math.min(a, b), Math.max(a, b), Math.min(c, d), Math.max(c, d), colour, lift);
        };
        put(0, 0.35, CURB, 0.055);
        for (let k = 0; k < BANDS; k++) {
          put(0.35 + (k / BANDS) * (PAVE - 0.35), 0.35 + ((k + 1) / BANDS) * (PAVE - 0.35), flag, 0.05);
        }
        // Red kerb paint where you may not park, which on a hill is most of it.
        if (i % 31 < 9) put(0.02, 0.33, [0.42, 0.14, 0.12], 0.057);
      }
    }
    // And the same for the side streets.
    for (const t of this.streets) {
      const nx = -t.uz, nz = t.ux;
      const hw = t.width / 2;
      const span = t.to - t.from;
      const steps = Math.max(4, Math.round(span / 2.4));
      const at = (d) => {
        const x = t.x + t.ux * d, z = t.z + t.uz * d;
        return { x, z, nx, nz, y: this.locate(x, z).y };
      };
      for (let k = 0; k < steps; k++) {
        const A = at(t.from + span * (k / steps));
        const B = at(t.from + span * ((k + 1) / steps));
        const flag = k % 3 === 0 ? [0.50, 0.49, 0.47] : [0.46, 0.45, 0.43];
        for (const sd of [-1, 1]) {
          const put2 = (o0, o1, colour, lift) => {
            const a = sd * (hw + o0), b = sd * (hw + o1);
            band(A, B, Math.min(a, b), Math.max(a, b), Math.min(a, b), Math.max(a, b), colour, lift);
          };
          put2(0, 0.35, CURB, 0.052);
          for (let j = 0; j < BANDS; j++) {
            put2(0.35 + (j / BANDS) * 3.65, 0.35 + ((j + 1) / BANDS) * 3.65, flag, 0.047);
          }
        }
      }
    }

    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(road, 3));
    roadGeo.setAttribute('color', new THREE.Float32BufferAttribute(roadCol, 3));
    roadGeo.computeVertexNormals();
    group.add(new THREE.Mesh(roadGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

    yield 'the road';
    this._buildBarriers(group);
    yield 'the blockades';
    yield* this._buildScenery(group);
    this.group = group;
    return group;
  }

  _buildBarriers(group) {
    // Nothing lines the street any more.
    //
    // First it was concrete, which is what a street circuit uses and what made
    // the place read as a circuit. Then it was steel crowd fencing, which is
    // lighter and still a mile of temporary structure down both sides of every
    // road. A city has neither. What a city has beside the road is a pavement
    // and then a building, and that is now what stops you.
    //
    // Which means the line the car is stopped at has to BE the building line.
    // The thing that stops a car is a lateral distance from the road, not a
    // mesh, and that distance is continuous whether or not anything is drawn
    // on it — so if nothing is drawn there, the distance has to coincide with
    // something that is. `barrierOffset` still places the scenery; `wall` is
    // where the car stops, and it is set to the frontage the buildings are
    // built to.
    this.barrierOffset = 5.6;
    this.wall = this.barrierOffset + 3.9;
    this.props = [];
    this.breakables = [];
    const b = new MeshBuilder();

    // --- the blockades that close the side streets.
    //
    // Cones right across, an arrow board, and a piece of plant with an amber
    // beacon turning on it — which is what actually closes a street, and what
    // a city actually has standing about in one. It sits exactly where the
    // wall it replaces would have been: walk out along the street until the
    // circuit's own boundary crosses it, and stop there.
    const cones = new MeshBuilder();
    const glow = new MeshBuilder();
    const redB = new MeshBuilder();
    const blueB = new MeshBuilder();
    const signed = new Set();
    let idx = 0;
    for (const t of this.stubs) {
      let at = 0;
      for (let k = 3; k <= t.len - 2; k += 0.5) {
        const px = t.x + t.ux * k, pz = t.z + t.uz * k;
        const loc = this.locate(px, pz);
        if (Math.abs(loc.lateral) - loc.width / 2 >= this.barrierOffset) { at = k; break; }
      }
      if (!at) continue;
      const nx = -t.uz, nz = t.ux;
      const yaw = Math.atan2(t.ux, t.uz);
      const base = (o, ahead = 0) => {
        const x = t.x + t.ux * (at + ahead) + nx * o;
        const z = t.z + t.uz * (at + ahead) + nz * o;
        return { x, z, y: this.locate(x, z).y };
      };
      const hw = t.width / 2;

      // Cones, right across and a little way up the pavement either side, in
      // two staggered rows so the line reads as deliberate rather than as a
      // fence made of cones.
      const n = Math.round((hw * 2 + 5) / 1.5);
      for (let k = 0; k <= n; k++) {
        const o = -hw - 2.5 + (k / n) * (hw * 2 + 5);
        const p2 = base(o, (k % 2) * 1.6);
        // The same clearance the concrete had to keep. The blockade stands
        // where the wall would have stood, and the ends of it run out onto the
        // pavement — which at a junction is close enough to the racing surface
        // that a cone can end up standing on it.
        if (!this.roomFor(p2.x, p2.z, 0.3, this.barrierOffset - 1.4)) continue;
        this.props.push({ x: p2.x, z: p2.z, r: 0.3, kind: 'cone' });
        cones.add(G.box(0.62, 0.06, 0.62), 0x1e2023, { x: p2.x, y: p2.y + 0.03, z: p2.z, ry: yaw });
        cones.add(G.cone(0.29, 0.82, 10), 0xdd5a1e, { x: p2.x, y: p2.y + 0.44, z: p2.z });
        cones.add(G.cone(0.20, 0.16, 10), 0xf0f0ea, { x: p2.x, y: p2.y + 0.53, z: p2.z });
      }

      // An arrow board across the mouth, facing back down the street the cars
      // arrive on, pointing the way the course goes. (See `arrowBoard`.)
      //
      // ONE per junction, on the arm that is straight ahead of a driver coming
      // into the corner. The other arm of the crossroads is off to the side
      // and behind him; a sign there is a sign nobody reads, and two of them
      // at one junction is two answers to a question with one answer.
      //
      // Built the way the real ones are: a black panel carrying a grid of
      // amber lamps, with the arrow lit out of the grid rather than painted
      // on. The unlit lamps are there too, dark, because a board with only the
      // lit ones on it is a glowing arrow floating in a black rectangle.
      if (t.corner && t.ahead) {
        const s2 = base(0, 3.2);
        if (this.arrowBoard(group, s2.x, s2.y, s2.z, Math.atan2(-t.ux, -t.uz), t.corner.turn)) {
          signed.add(t.corner);
        }
      }

      // And a piece of plant, parked across the mouth.
      //
      // Not a police car. A road closed for a race is closed by whoever is
      // doing the work on it, and what stands at the mouth of a closed street
      // is a machine — an excavator, a roller, a dumper, a light tower — with
      // an amber beacon on it. Four kinds, taken in turn, so no two junctions
      // in a row look the same.
      const c = base(hw * 0.30, 5.5);
      const ang = yaw + 0.42;
      if (!this.roomFor(c.x, c.z, 3.2, this.barrierOffset - 1.4)) continue;
      this.props.push({ x: c.x, z: c.z, r: 3.2, kind: 'plant' });

      // Local frame for the machine: `f` runs along it, `r` across.
      const put = (geo, colour, lo, opts = {}) => {
        cones.add(geo, colour, {
          x: c.x + Math.cos(ang) * (lo.r || 0) + Math.sin(ang) * (lo.f || 0),
          y: c.y + (lo.y || 0),
          z: c.z - Math.sin(ang) * (lo.r || 0) + Math.cos(ang) * (lo.f || 0),
          ry: ang + (opts.turn || 0), rx: opts.rx || 0, rz: opts.rz || 0,
          mottle: opts.mottle || 0,
        });
      };
      const YEL = 0xe0a020, DARK = 0x2a2d31, STEEL = 0x8f959b, RUST = 0x7a4a2a;
      // Tracks, wheels and a beacon are shared between the machines.
      const tracks = () => {
        for (const sd of [-1, 1]) {
          put(G.box(0.72, 0.66, 3.6), DARK, { r: sd * 1.05, y: 0.36 }, { mottle: 0.05 });
          for (let k = -2; k <= 2; k++) {
            put(G.cyl(0.36, 0.36, 0.74, 12), 0x3a3e44, { r: sd * 1.05, y: 0.36, f: k * 0.78 },
              { rz: Math.PI / 2 });
          }
        }
      };
      const wheels = (rr, ff, rad) => {
        for (const sd of [-1, 1]) {
          for (const fz of ff) {
            put(G.cyl(rad, rad, 0.5, 16), 0x1b1d20, { r: sd * rr, y: rad, f: fz }, { rz: Math.PI / 2 });
            put(G.cyl(rad * 0.45, rad * 0.45, 0.54, 10), STEEL, { r: sd * rr, y: rad, f: fz }, { rz: Math.PI / 2 });
          }
        }
      };
      const beacon = (y2, f2 = 0) => {
        put(G.cyl(0.10, 0.10, 0.34, 8), DARK, { y: y2 - 0.2, f: f2 });
        (idx % 2 ? redB : blueB).add(G.cyl(0.17, 0.19, 0.3, 10), 0xffa81e, {
          x: c.x + Math.sin(ang) * f2, y: c.y + y2, z: c.z + Math.cos(ang) * f2,
        });
      };

      const kind2 = idx % 4;
      if (kind2 === 0) {
        // Excavator: tracks, a slewing house, and a boom folded over.
        tracks();
        put(G.cyl(1.05, 1.15, 0.26, 16), DARK, { y: 0.82 });
        put(G.box(2.15, 1.5, 2.6), YEL, { y: 1.62, f: -0.35 }, { mottle: 0.04 });
        put(G.box(1.25, 1.05, 1.15), 0x1e2a33, { r: -0.5, y: 1.9, f: 1.05 });   // cab glass
        put(G.box(1.34, 1.12, 1.2), YEL, { r: -0.5, y: 1.9, f: 1.02 });
        put(G.box(2.2, 0.5, 0.5), DARK, { y: 1.1, f: -1.6 });                   // counterweight
        // Boom, stick and bucket, folded down in front.
        put(G.box(0.52, 0.52, 3.4), YEL, { r: 0.62, y: 2.6, f: 1.5 }, { rx: 0.75 });
        put(G.box(0.42, 0.42, 2.8), YEL, { r: 0.62, y: 2.5, f: 3.6 }, { rx: -0.95 });
        put(G.box(0.9, 0.72, 0.95), STEEL, { r: 0.62, y: 1.0, f: 4.5 }, { rx: 0.5 });
        for (let k = -1; k <= 1; k++) {
          put(G.box(0.12, 0.34, 0.14), STEEL, { r: 0.62 + k * 0.3, y: 0.62, f: 4.9 }, { rx: 0.5 });
        }
        beacon(2.62, -1.0);
      } else if (kind2 === 1) {
        // Road roller: a big smooth drum at the front, wheels behind.
        put(G.cyl(0.86, 0.86, 2.0, 20), STEEL, { y: 0.86, f: 1.5 }, { rz: Math.PI / 2, mottle: 0.05 });
        put(G.box(0.34, 0.9, 0.34), DARK, { y: 1.4, f: 1.5 });
        put(G.box(1.9, 0.8, 2.6), YEL, { y: 1.05, f: -0.4 }, { mottle: 0.04 });
        put(G.box(1.5, 1.0, 1.4), 0x1e2a33, { y: 1.9, f: -0.5 });
        for (const sd of [-1, 1]) {
          put(G.box(0.1, 1.35, 0.1), DARK, { r: sd * 0.8, y: 2.2, f: -1.3 });
          put(G.box(0.1, 1.35, 0.1), DARK, { r: sd * 0.8, y: 2.2, f: 0.4 });
        }
        put(G.box(1.9, 0.12, 1.9), YEL, { y: 2.9, f: -0.45 });
        wheels(0.86, [-1.6], 0.66);
        beacon(3.1, -0.45);
      } else if (kind2 === 2) {
        // Site dumper, tipped up with a load of spoil in it.
        wheels(0.98, [1.5, -1.5], 0.72);
        put(G.box(1.9, 0.5, 4.4), DARK, { y: 0.82 });
        put(G.box(1.8, 1.5, 1.5), YEL, { y: 1.8, f: -1.2 }, { mottle: 0.04 });
        put(G.box(1.5, 0.95, 1.2), 0x1e2a33, { y: 2.1, f: -1.15 });
        put(G.box(2.1, 1.15, 2.9), YEL, { y: 1.8, f: 0.9 }, { rx: -0.24, mottle: 0.05 });
        put(G.box(1.85, 0.55, 2.5), RUST, { y: 2.34, f: 0.95 }, { rx: -0.24, mottle: 0.16 });
        beacon(2.85, -1.2);
      } else {
        // Light tower on a trailer, which is what actually lights a night job.
        put(G.box(1.5, 0.34, 2.9), YEL, { y: 0.62 }, { mottle: 0.04 });
        wheels(0.86, [-0.4], 0.44);
        put(G.box(0.22, 0.3, 1.1), DARK, { y: 0.42, f: 1.9 }, { rx: 0.22 });
        put(G.box(0.95, 0.85, 1.2), STEEL, { y: 1.2, f: -0.9 }, { mottle: 0.06 });
        put(G.box(0.4, 4.6, 0.4), STEEL, { y: 3.1, f: 0.5 });
        put(G.box(0.28, 3.0, 0.28), 0xa8aeb4, { y: 6.4, f: 0.5 });
        put(G.box(2.3, 0.16, 0.3), DARK, { y: 7.7, f: 0.5 });
        for (const sd of [-1, 1]) {
          for (const k of [0.42, 1.15]) {
            put(G.box(0.62, 0.5, 0.24), DARK, { r: sd * k, y: 7.42, f: 0.5 }, { rx: 0.4 });
            glow.add(G.box(0.5, 0.1, 0.4), 0xfff0cc, {
              x: c.x + Math.cos(ang) * sd * k + Math.sin(ang) * 0.5,
              y: c.y + 7.24,
              z: c.z - Math.sin(ang) * sd * k + Math.cos(ang) * 0.5,
              ry: ang, rx: 0.4,
            });
          }
        }
        beacon(1.85, -0.9);
      }
      idx++;
    }
    // --- and a board at every corner that did not get one from a side street.
    //
    // Not every corner has a street leaving it: the shallow ones point too
    // nearly along the circuit for a side street to go anywhere, so they have
    // none, and losing the street lost the sign with it. The sign is the part
    // that matters — it is what tells you a forty-five degree corner is coming
    // and which way it goes — so where there is no blockade to hang it on, one
    // goes up on its own, on the OUTSIDE of the turn, which is the half of the
    // junction a driver is looking at as they arrive.
    for (const c of this.corners) {
      if (signed.has(c)) continue;
      // On the verge of the street the driver is arriving down, a little
      // before the junction and on the OUTSIDE of the turn — which is where a
      // direction sign goes, and which is not where the outward bisector is,
      // because that is now a road.
      const rx = c.u1z, rz = -c.u1x;             // right of travel along u1
      const side = c.turn > 0 ? 1 : -1;          // outside of the bend
      const face = Math.atan2(-c.u1x, -c.u1z);
      let done = false;
      for (const back of [14, 20, 27]) {
        for (const out of [JUNCTION_HALF + 2, JUNCTION_HALF + 6]) {
          const x = c.x - c.u1x * back + rx * side * out;
          const z = c.z - c.u1z * back + rz * side * out;
          if (!this.clearOfStubs(x, z, 2.4)) continue;
          if (this.arrowBoard(group, x, this.locate(x, z).y, z, face, c.turn)) { done = true; break; }
        }
        if (done) break;
      }
    }

    group.add(cones.build());
    group.add(glow.build(VC_UNLIT));

    // Two materials, flashed against each other in update(). Unlit, so they
    // keep their colour whatever the night is doing, and transparent so the
    // flash is a fade rather than a hard switch.
    this.beacons = [
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 1 }),
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.2 }),
    ];
    group.add(redB.build(this.beacons[0]));
    group.add(blueB.build(this.beacons[1]));

    group.add(b.build());
  }

  // An arrow board: a black panel carrying a grid of amber lamps, with the
  // arrow lit out of the grid rather than painted on. `face` is the way it
  // looks, `turn` the corner it is announcing.
  //
  // The unlit lamps are built too, dark. A board with only the lit ones on it
  // is a glowing arrow floating in a black rectangle.
  arrowBoard(group, x, y, z, face, turn) {
    if (!this.roomFor(x, z, 2.4, this.barrierOffset - 1.4)) return false;
    // Local +x on a panel turned to `face` runs to the LEFT of a driver
    // looking at it, and a positive turn is a left-hander — so the arrow
    // points toward +x when the course goes left.
    const dir = turn > 0 ? 1 : -1;
    const COLS = 9, ROWS = 5, PITCH = 0.46;
    // Shaft down the middle row and a chevron at the pointing end, two lamps
    // thick. One lamp thick is what a real board uses and what was here first,
    // and at the distance you actually see one of these from it reads as a
    // horizontal bar with some speckle on the end rather than as an arrow.
    const on = new Set();
    for (let c = 0; c < COLS; c++) on.add(`${c},2`);
    for (const [c, r] of [
      [COLS - 5, 0], [COLS - 4, 0],
      [COLS - 4, 1], [COLS - 3, 1],
      [COLS - 3, 3], [COLS - 4, 3],
      [COLS - 4, 4], [COLS - 5, 4],
      [COLS - 2, 2], [COLS - 1, 2],
    ]) on.add(`${c},${r}`);
    const lampAt = (c, r) => ({
      x: Math.cos(face) * (dir * (c - (COLS - 1) / 2) * PITCH) + Math.sin(face) * 0.11,
      y: 2.55 + ((ROWS - 1) / 2 - r) * PITCH,
      z: -Math.sin(face) * (dir * (c - (COLS - 1) / 2) * PITCH) + Math.cos(face) * 0.11,
    });
    this.breakable(group, x, y, z, 'sign', (m) => {
      for (const sd of [-1, 1]) {
        m.add(G.box(0.15, 1.55, 0.15), 0x5f666d,
          { x: Math.cos(face) * sd * 1.55, y: 0.78, z: -Math.sin(face) * sd * 1.55, ry: face });
      }
      m.add(G.box(0.34, 0.16, 0.9), 0x5f666d, { y: 0.08, ry: face });
      m.add(G.box(COLS * PITCH + 0.55, ROWS * PITCH + 0.5, 0.16), 0x191b1e, { y: 2.55, ry: face });
      m.add(G.box(COLS * PITCH + 0.8, 0.14, 0.24), 0xd8892a, { y: 3.42, ry: face });
      m.add(G.box(COLS * PITCH + 0.8, 0.14, 0.24), 0xd8892a, { y: 1.68, ry: face });
      for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
          if (on.has(`${c},${r}`)) continue;
          m.add(G.sphere(0.11, 8, 6), 0x2e3135, lampAt(c, r));
        }
      }
    }, (g) => {
      for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
          if (!on.has(`${c},${r}`)) continue;
          g.add(G.sphere(0.17, 8, 6), 0xffa022, lampAt(c, r));
        }
      }
    });
    this.props.push({ x, z, r: 2.4, kind: 'sign' });
    return true;
  }

  // One piece of street furniture that can be knocked over, as its own mesh.
  //
  // Its own, because a merged mesh is one object and you cannot tip a single
  // lamp post out of one. It costs a draw call each, which for a couple of
  // hundred slim objects is affordable and buys the thing that most makes a
  // street feel like a place rather than a backdrop: it gives way when you hit
  // it. Everything that does NOT fall — hydrants, trees, parked cars — stays
  // in the merged city mesh where it belongs.
  //
  // The geometry is built with its base at the origin and the mesh placed at
  // ground level, because tipping is a rotation about the base. Built around
  // its middle it would sink through the pavement as it went over.
  breakable(group, x, y, z, kind, build, glow) {
    if (!this.breakables) this.breakables = [];
    // A group, not a mesh, because some of these have a part that has to stay
    // lit whatever the night is doing — the lamps on an arrow board — and that
    // needs its own material. Both halves hang off the same node so they go
    // over together.
    const mesh = new THREE.Group();
    const mb = new MeshBuilder();
    build(mb);
    mesh.add(mb.build());
    if (glow) {
      const gb = new MeshBuilder();
      glow(gb);
      mesh.add(gb.build(VC_UNLIT));
    }
    mesh.position.set(x, y, z);
    group.add(mesh);
    const o = { mesh, x, z, r: kind === 'sign' ? 2.6 : 0.9, kind, fall: 0, axis: null };
    this.breakables.push(o);
    return o;
  }

  // The flashing lights on the blockades, and anything currently falling over.
  update(t, dt = 0) {
    if (this.beacons) {
      const phase = (t * 2.2) % 1;
      this.beacons[0].opacity = phase < 0.5 ? 1 : 0.12;
      this.beacons[1].opacity = phase < 0.5 ? 0.12 : 1;
    }
    if (!this.breakables || !dt) return;
    for (const o of this.breakables) {
      if (!o.axis || o.fall >= 1) continue;
      // Falls fast and stops flat. Anything more than that — bouncing,
      // settling, sliding — is a physics engine for street furniture, and the
      // whole event is over in half a second at racing speed anyway.
      o.fall = Math.min(1, o.fall + dt * 2.6);
      const a = (o.fall * o.fall) * 1.48;      // accelerating, to just past flat
      o.mesh.rotation.set(o.axis.x * a, 0, o.axis.z * a);
    }
  }

  // Knock something down. `dirX/dirZ` is the way the car was going, which is
  // the way the thing goes over.
  knock(o, dirX, dirZ) {
    if (o.axis) return false;
    const len = Math.hypot(dirX, dirZ) || 1;
    // Rotate about the horizontal axis perpendicular to the impact, so it
    // falls away from the car rather than toward it.
    o.axis = { x: (dirZ / len), z: -(dirX / len) };
    o.fall = 0;
    return true;
  }

  // The height of the city floor at a point. The ground mesh and everything
  // standing on it have to agree about this, so they both come here — a
  // building placed against its own idea of the ground floats or sinks.
  groundAt(x, z) {
    // A weighted blend of every sample within forty metres, not the nearest
    // one. Nearest-sample gives a field that jumps wherever the closest bit of
    // track changes — and where the circuit doubles back, the stretch nearest
    // one patch of ground is twenty metres higher than the stretch nearest the
    // patch beside it, so the ground tears and pushes up through the road.
    // The weight falls smoothly to zero at the edge, so the field is
    // continuous everywhere.
    const R2 = 1600;
    let wsum = 0, ysum = 0, bestD = Infinity, bestY = 0;
    for (const p of this.samples) {
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bestD) { bestD = d; bestY = p.y; }
      if (d > R2) continue;
      const w = (R2 - d) / R2;
      wsum += w * w;
      ysum += p.y * w * w;
    }
    const near = wsum > 0 ? ysum / wsum : bestY;
    const dist = Math.sqrt(bestD);
    const fall = clamp((dist - 22) / 300, 0, 1);
    const hill = Math.sin(x * 0.0052) * Math.cos(z * 0.0061) * 26 + Math.sin(z * 0.0091) * 11;
    const bay = clamp((dist - 340) / 200, 0, 1);
    const wide = (near - 1.1) + hill * fall * fall * (1 - bay) - bay * (near + 6);
    if (dist > 34) return wide;

    // Close in, follow the road's own height rather than a blend of forty
    // metres of it. On a six per cent grade a forty-metre average lags the
    // road by more than a metre, which is more than the clearance — so the
    // averaged ground rises through the asphalt on every slope. Blended out
    // over the next twenty metres, and hard-capped below the road either way,
    // so no amount of interpolation can put it back on top.
    const under = this.locate(x, z).y - 1.0;
    const w = clamp((dist - 12) / 22, 0, 1);
    return Math.min(lerp(under, wide, w), under);
  }

  // The patch of light a lamp throws, as a mesh that follows the road under
  // it rather than a flat card laid over it.
  //
  // A flat thirty-metre square centred on the road's height is buried at its
  // uphill end and floating at its downhill end the moment the street is on a
  // grade — and since it is drawn with depth testing on, the buried half is
  // simply not there. Which is exactly the way round it was failing: the
  // lamps lit the road going down the hill and lit nothing going up it.
  _poolGeometry(px, pz, size) {
    const seg = 10;
    const g = new THREE.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = px + pos.getX(i), z = pz + pos.getZ(i);
      // Follow the road's plane the whole way out rather than switching to
      // the ground beyond the pavement: the two are a metre apart, and a
      // switch between them puts a hard-edged step across the middle of the
      // pool. Out where they diverge the light has faded to nothing anyway.
      pos.setX(i, x);
      pos.setZ(i, z);
      pos.setY(i, this.locate(x, z).y + 0.10);
    }
    g.computeVertexNormals();
    return g.toNonIndexed();
  }

  // The streets the circuit does not take.
  //
  // A corner in a city is not a bend, it is a junction, and a junction has
  // roads leaving it in every direction — including the two you are not using.
  // Leave those out and the layout reads as a closed loop of tarmac with
  // scenery either side; put them in and every corner reads as somewhere you
  // turn off rather than somewhere the road happens to bend.
  //
  // They are scenery, not racing surface. The circuit's wall runs unbroken
  // across the mouth of each one, which is exactly how a real street race is
  // put together — the course is a few streets and everything else is shut off
  // at the kerb — and it is also the only version that cannot go wrong. The
  // stub corridors start at the junction centre, and the circuit drives
  // straight through the junction centre: any rule that opened the wall there
  // was a rule that could catch a car mid-corner and treat the racing line as
  // a side street. It did, and it stranded twelve of them in a race.
  _sideStreets() {
    // How far a side street runs before it Ts out, and how far the cross
    // street at the top of the T runs either way.
    //
    // Both were about a third of this. At forty-odd metres you can see the far
    // end of every one of them from the racing line, and a street whose end
    // you can see is a set, not a street. Run them out far enough that the T
    // is a couple of blocks away and half hidden behind what has been built
    // around it, and they read as roads going somewhere.
    const STUB = 135;
    const BAR = 58;
    this.stubs = [];
    this.streets = [];

    // Every cosmetic street is the same thing: a straight run of road with a
    // width, from one offset to another along its own direction. The stem of a
    // T and the bar across the top of it differ only in their numbers, and
    // writing them as one kind means the surfacing, the pavements, the curb
    // returns and the "is this tarmac" test are each written once.
    const street = (x, z, ux, uz, from, to, width) =>
      this.streets.push({ x, z, ux, uz, from, to, width });

    let corner = null, ahead = false;
    const add = (x, z, dx, dz) => {
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      // Do not drive a side street into another part of the circuit. Walk out
      // along it and stop at whatever length stays clear of the road.
      // Walk out and stop short of any OTHER part of the circuit. Started
      // beyond the junction's own box, because the thing this street leaves
      // from is a piece of circuit and would otherwise reject every one of
      // them the moment the junction was widened.
      // Walk out and stop well clear of any OTHER part of the circuit.
      //
      // Twenty-two metres, not nine. At nine, a street leaving a shallow
      // corner runs a hundred metres at three-quarters parallel and fourteen
      // metres from the racing line — which does not read as a turning off the
      // course, it reads as a second road laid beside it. A side street has to
      // go somewhere else.
      let reach = STUB;
      for (let d = JUNCTION_OWNS + 8; d <= STUB + BAR; d += 2) {
        const px = x + ux * d, pz = z + uz * d;
        const loc = this.locate(px, pz);
        // Only against OTHER parts of the circuit. The junction this street
        // leaves is a piece of circuit too, and at a shallow corner a street
        // heading out at sixty-five degrees is still only seventeen metres
        // from that corner's own kerb twenty-six metres along — so measured
        // against everything, every shallow corner refused to grow a street at
        // all and was left as a bend with a sign beside it.
        if (Math.hypot(loc.sample.x - x, loc.sample.z - z) < 46) continue;
        if (Math.abs(loc.lateral) - loc.width / 2 < 22) { reach = d - 16; break; }
      }
      if (reach < JUNCTION_OWNS + 12) return false;   // no room for a street
      const t = { x, z, ux, uz, len: reach, width: DEFAULT_WIDTH, corner, ahead };
      this.stubs.push(t);
      // The stem, started back inside the junction so the surfaces overlap.
      street(x, z, ux, uz, -10, reach, DEFAULT_WIDTH);
      // And the bar across the top of the T.
      //
      // A cosmetic street that stops dead at a wall reads as exactly what it
      // is — a piece of scenery with an edge. One that Ts into a cross street
      // reads as a street going somewhere, because that is what the junction
      // at the end of a real street looks like, and the buildings that fill in
      // around it hide the fact that the cross street stops too.
      const bx = x + ux * reach, bz = z + uz * reach;
      let half = BAR;
      for (let d = 10; d <= BAR; d += 2) {
        for (const sd of [-1, 1]) {
          const px = bx - uz * sd * d, pz = bz + ux * sd * d;
          const loc = this.locate(px, pz);
          if (Math.abs(loc.lateral) < loc.width / 2 + 9) half = Math.min(half, d - 8);
        }
      }
      if (half >= 12) {
        street(bx, bz, -uz, ux, -half, half, DEFAULT_WIDTH);
        t.bar = half;
      }
      return true;
    };

    // Only where the circuit changes direction. A corner is the one place a
    // junction has to be there — you are turning, so something must be the
    // thing you are turning off. Mid-block cross streets everywhere turned the
    // whole map into a grid, which is more city than is wanted here: what is
    // wanted is that every corner reads as a junction rather than as a bend.
    //
    // The way straight on, and the way back off the other side. Those two plus
    // the two the circuit uses make the crossroads.
    const SQUARE = 1.05;                 // sixty degrees, in radians
    for (const c of this.corners) {
      corner = c;
      let any = false;
      // Straight on, and back off the far side — but only at a corner square
      // enough for them to go anywhere.
      //
      // "Straight on" continues the leg you arrived down, by construction. At
      // a right angle the course leaves at ninety degrees and the two separate
      // immediately; at forty-one degrees they diverge so slowly that the side
      // street sits eleven metres off the kerb for a hundred metres, which
      // does not read as a fork, it reads as a second carriageway laid beside
      // the racing line. No amount of clearance-walking fixes that, because
      // the street is not running into anything — it is just running alongside.
      // So at the shallow corners these two are not offered at all.
      if (Math.abs(c.turn) > SQUARE) {
        ahead = true;
        any = add(c.x, c.z, c.u1x, c.u1z);
        ahead = false;
        any = add(c.x, c.z, -c.u2x, -c.u2z) || any;
      }

      // Which leaves the shallow corners with nothing, and a corner with no
      // street off it looks wrong.
      //
      // The way out is the OUTWARD BISECTOR, `u1 - u2`, which points away from
      // the centre of the turn. For a forty-one degree corner that is about
      // seventy degrees off the road — which is exactly what a fork in a real
      // street looks like, and far enough across for the street to leave.
      if (!any) {
        let ox = c.u1x - c.u2x, oz = c.u1z - c.u2z;
        const ol = Math.hypot(ox, oz) || 1;
        add(c.x, c.z, ox / ol, oz / ol);
      }
    }

    this._junctionBoxes();
    this._junctionCorners();
  }

  // Where two roads meet, the pavement corner between them is rounded off.
  //
  // A square corner is the single thing that stops a junction reading as a
  // junction: real ones have a curb return, an arc tangent to both curb lines,
  // and without it the side street looks like a strip of tarmac laid beside
  // the circuit rather than joined to it. Worked out once, here, because the
  // pavement pass has to ask about it for every tile it lays.
  _junctionCorners() {
    this.returns = [];
    const R = 7.5;
    for (const c of this.corners) {
      const loc = this.locate(c.x, c.z);
      const hwRoad = loc.width / 2;
      // All four arms of the crossroads, as a direction out of the junction
      // and the half-width of the road along it.
      const arms = [
        { ux: -c.u1x, uz: -c.u1z, hw: hwRoad },      // the way in
        { ux: c.u2x, uz: c.u2z, hw: hwRoad },        // the way out
        { ux: c.u1x, uz: c.u1z, hw: DEFAULT_WIDTH / 2 },
        { ux: -c.u2x, uz: -c.u2z, hw: DEFAULT_WIDTH / 2 },
      ];
      arms.sort((a, b) => Math.atan2(a.uz, a.ux) - Math.atan2(b.uz, b.ux));
      for (let i = 0; i < arms.length; i++) {
        const A = arms[i], B = arms[(i + 1) % arms.length];
        // Normals of each arm, pointed into the wedge between them.
        const nA = { x: -A.uz, z: A.ux };
        const nB = { x: -B.uz, z: B.ux };
        if (nA.x * B.ux + nA.z * B.uz < 0) { nA.x = -nA.x; nA.z = -nA.z; }
        if (nB.x * A.ux + nB.z * A.uz < 0) { nB.x = -nB.x; nB.z = -nB.z; }
        // The arc's centre: the point standing (hw + R) off both curb lines.
        const det = nA.x * nB.z - nA.z * nB.x;
        if (Math.abs(det) < 0.15) continue;          // arms nearly in line
        const da = A.hw + R, db = B.hw + R;
        const cx = c.x + (da * nB.z - db * nA.z) / det;
        const cz = c.z + (db * nA.x - da * nB.x) / det;
        this.returns.push({ jx: c.x, jz: c.z, cx, cz, nA, nB, da, db, R });
      }
    }
  }

  // The square of tarmac where four streets meet.
  //
  // The circuit's own surface is a ribbon following a filleted centreline, and
  // a fillet can never read as a crossroads however well the side streets are
  // joined to it: a real junction's roadway is the UNION OF TWO STRAIGHT
  // STREETS, which is square, while a fillet is an arc that cuts the corner of
  // the block clean off. With 15.4 m streets the road would need a radius over
  // forty-five metres before the arc stopped eating into the block, and the
  // blocks here are fifty metres across — so it cannot be fixed by widening
  // the curve. The centreline stays filleted, because a car has to drive an
  // arc through the junction whatever shape the tarmac is; the SURFACE gets
  // the square it should have had, laid over the top.
  _junctionBoxes() {
    // What the road measures at a given distance out, so the junction's arms
    // can be made to meet it exactly rather than stepping down to it.
    const roadHalf = (d) => {
      const t = clamp((d - JUNCTION_FLAT) / (JUNCTION_REACH - JUNCTION_FLAT), 0, 1);
      return lerp(JUNCTION_WIDTH, DEFAULT_WIDTH, t) / 2;
    };
    const end = roadHalf(JUNCTION_OWNS);
    this.boxes = this.corners.map((c) => ({
      x: c.x,
      z: c.z,
      reach: JUNCTION_OWNS,
      arms: [
        { ux: -c.u1x, uz: -c.u1z, hw: JUNCTION_HALF, taper: end },
        { ux: c.u2x, uz: c.u2z, hw: JUNCTION_HALF, taper: end },
        { ux: c.u1x, uz: c.u1z, hw: DEFAULT_WIDTH / 2 },
        { ux: -c.u2x, uz: -c.u2z, hw: DEFAULT_WIDTH / 2 },
      ],
    }));
  }

  // Inside this, the junction draws the road and nothing else does. The
  // circuit's ribbon and the side streets both stop at the edge of it, which
  // is the only way the surface in the middle can be a plus rather than a
  // curve with tarmac added round the outside of it.
  inJunction(x, z) {
    if (!this.boxes) return false;
    for (const b of this.boxes) {
      const dx = x - b.x, dz = z - b.z;
      if (dx * dx + dz * dz <= b.reach * b.reach) return true;
    }
    return false;
  }

  onJunctionBox(x, z) {
    if (!this.boxes) return false;
    for (const b of this.boxes) {
      const dx = x - b.x, dz = z - b.z;
      if (Math.abs(dx) > b.reach + 2 || Math.abs(dz) > b.reach + 2) continue;
      for (const a of b.arms) {
        const along = dx * a.ux + dz * a.uz;
        if (along < -0.5 || along > b.reach) continue;
        // Full width until the taper starts, then closing on the road's own
        // width so the two meet in line instead of in a step.
        let hw = a.hw;
        if (a.taper !== undefined && along > JUNCTION_TAPER) {
          hw = lerp(a.hw, a.taper, (along - JUNCTION_TAPER) / (b.reach - JUNCTION_TAPER));
        }
        if (Math.abs(dx * -a.uz + dz * a.ux) <= hw) return true;
      }
    }
    return false;
  }

  // Is this point in the bite a curb return takes out of a pavement corner?
  inCurbReturn(x, z) {
    if (!this.returns) return false;
    for (const r of this.returns) {
      const sx = x - r.jx, sz = z - r.jz;
      const ua = sx * r.nA.x + sz * r.nA.z;
      const ub = sx * r.nB.x + sz * r.nB.z;
      if (ua < 0 || ua > r.da || ub < 0 || ub > r.db) continue;
      if (Math.hypot(x - r.cx, z - r.cz) > r.R) return true;
    }
    return false;
  }

  // What is tarmac and what is not.
  //
  // Three of these rather than one, because the pavement pass needs "any road
  // at all" while the side-street pass needs "anything laid before me" — a
  // street may not cut a hole in itself.
  onCircuitRoad(x, z) {
    const loc = this.locate(x, z);
    return Math.abs(loc.lateral) <= loc.width / 2;
  }

  onStubRoad(x, z, before = Infinity) {
    if (!this.streets) return false;
    const n = Math.min(before, this.streets.length);
    for (let i = 0; i < n; i++) {
      const t = this.streets[i];
      const dx = x - t.x, dz = z - t.z;
      const along = dx * t.ux + dz * t.uz;
      if (along < t.from || along > t.to) continue;
      if (Math.abs(dx * -t.uz + dz * t.ux) <= t.width / 2) return true;
    }
    return false;
  }

  onAnyRoad(x, z) {
    return this.onCircuitRoad(x, z) || this.onStubRoad(x, z) || this.onJunctionBox(x, z);
  }

  // Which street a building here should front on to.
  //
  // Everything used to square up to the circuit, because the circuit was the
  // only street there was. Now there are side streets, and a building beside
  // one that faces the racing line instead presents it a blank side wall —
  // which is exactly what the whole city looked like before the frontage was
  // turned to face the road at all. So: the nearest street wins, and the side
  // streets are checked first because a building close to one is close to it
  // whatever the circuit is doing further off.
  streetYaw(x, z) {
    let best = null, bestD = Infinity;
    if (this.streets) {
      for (const t of this.streets) {
        const dx = x - t.x, dz = z - t.z;
        const along = dx * t.ux + dz * t.uz;
        if (along < t.from - 6 || along > t.to + 6) continue;
        const d = Math.abs(dx * -t.uz + dz * t.ux);
        if (d < bestD) { bestD = d; best = Math.atan2(t.ux, t.uz); }
      }
    }
    const loc = this.locate(x, z);
    const circuit = Math.abs(loc.lateral);
    if (best !== null && bestD < circuit) return best;
    return Math.atan2(loc.sample.dirX, loc.sample.dirZ);
  }

  // Room for a building or a lamp post, given the side streets as well as the
  // circuit — a warehouse in the middle of a crossroads is worse than one on
  // the racing line, because at least you can see that one coming.
  // The stretch of a side street the circuit's wall would otherwise cross.
  inStubMouth(x, z) {
    if (!this.stubs) return false;
    for (const t of this.stubs) {
      const dx = x - t.x, dz = z - t.z;
      const along = dx * t.ux + dz * t.uz;
      if (along < -2 || along > t.len) continue;
      if (Math.abs(dx * -t.uz + dz * t.ux) < t.width / 2 + 1.4) return true;
    }
    return false;
  }

  clearOfStubs(x, z, r) {
    if (!this.stubs) return true;
    for (const t of this.stubs) {
      const dx = x - t.x, dz = z - t.z;
      const along = dx * t.ux + dz * t.uz;
      if (along < -6 || along > t.len + 3) continue;
      if (Math.abs(dx * -t.uz + dz * t.ux) < t.width / 2 + 4.4 + r) return false;
    }
    return true;
  }

  // Is there room to put something here, or is this ground part of the
  // circuit? Offsetting from one sample is not enough on its own: where the
  // track curves back, a point well outside one corner is on top of the next.
  roomFor(x, z, r, need) {
    const loc = this.locate(x, z);
    return Math.abs(loc.lateral) - loc.width / 2 - r >= need;
  }

  // The city. Buildings line the streets, and which buildings depends on where
  // you are: warehouses and piers down at the water, painted row houses up the
  // climb, towers across the top of the hill. That is the shape of the place,
  // and it is legible from the car because the circuit climbs through all
  // three in a lap.
  *_buildScenery(group) {
    const b = new MeshBuilder();
    this.lamps = [];
    // Two more meshes: the things that are lit from inside, and the pools they
    // throw on the ground. Both are one draw call for the whole city.
    const lit = new MeshBuilder();
    const pools = new MeshBuilder();
    // Clear of the circuit AND clear of the side streets: a warehouse standing
    // in the middle of a crossroads is worse than one on the racing line,
    // because at least you can see that one coming.
    const roomFor = (x, z, r, need) =>
      this.roomFor(x, z, r, need) && this.clearOfStubs(x, z, r);

    // --- what is already standing here.
    //
    // Nothing was keeping track, so every pass placed buildings in ignorance
    // of the ones before it and they grew through each other. A bounding
    // circle is not good enough to fix it either: a building is a rectangle,
    // and rejecting on circles either lets long thin ones overlap at the ends
    // or refuses everything that would sit next to them, which is where the
    // holes in the terrace came from. So: proper oriented-box overlap, by
    // separating axis, against the neighbours in a spatial hash.
    const CELL = 48;
    const lots = new Map();
    const cellsOf = (b) => {
      const r = Math.hypot(b.w, b.d) / 2 + 2;
      const out = [];
      for (let cx = Math.floor((b.x - r) / CELL); cx <= Math.floor((b.x + r) / CELL); cx++) {
        for (let cz = Math.floor((b.z - r) / CELL); cz <= Math.floor((b.z + r) / CELL); cz++) {
          out.push(`${cx},${cz}`);
        }
      }
      return out;
    };
    const cornersOf = (b) => {
      const c = Math.cos(b.ry), sn = Math.sin(b.ry);
      const hw = b.w / 2, hd = b.d / 2;
      return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => ({
        x: b.x + u * c + v * sn,
        z: b.z - u * sn + v * c,
      }));
    };
    const overlap = (A, B, gap) => {
      for (const box of [A, B]) {
        const c = Math.cos(box.ry), sn = Math.sin(box.ry);
        for (const ax of [{ x: c, z: -sn }, { x: sn, z: c }]) {
          let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
          for (const q of cornersOf(A)) {
            const d = q.x * ax.x + q.z * ax.z;
            aMin = Math.min(aMin, d); aMax = Math.max(aMax, d);
          }
          for (const q of cornersOf(B)) {
            const d = q.x * ax.x + q.z * ax.z;
            bMin = Math.min(bMin, d); bMax = Math.max(bMax, d);
          }
          if (aMax < bMin + gap || bMax < aMin + gap) return false;
        }
      }
      return true;
    };
    // A lot is free if nothing already placed overlaps it. `gap` is negative
    // for a terrace, whose whole point is that it shares its side walls.
    const free = (b, gap) => {
      for (const key of cellsOf(b)) {
        const list = lots.get(key);
        if (!list) continue;
        for (const o of list) if (overlap(b, o, gap)) return false;
      }
      return true;
    };
    const claim = (b) => {
      for (const key of cellsOf(b)) {
        if (!lots.has(key)) lots.set(key, []);
        lots.get(key).push(b);
      }
    };
    // Place it if it fits, and say whether it did.
    // Takes the STREET's yaw, the same as building() does, and turns it the
    // quarter that building() turns it by so the box it tests is the box that
    // gets built. Passing the frontage angle in already rotated puts the
    // overlap test at right angles to the thing it is testing.
    const put = (x, z, yaw, w, d, h, palette, glassy, need, gap = 0.8) => {
      const b = { x, z, ry: yaw + Math.PI / 2, w, d };
      if (!roomFor(x, z, Math.hypot(w, d) / 2, need)) return false;
      if (!free(b, gap)) return false;
      // And not standing on tarmac. The corridor tests above are approximate —
      // they work on a radius and a corridor width — so the last word goes to
      // the same question the surfacing asks: is this ground road? Sampled
      // across the footprint, because a building can straddle a street without
      // any of its corners being on one.
      {
        // Sampled exactly as the smoke test samples it — same grid, same
        // extent. A placement rule that is a hair tighter or looser than the
        // rule that checks it will disagree with it about one building in two
        // thousand, and that one building is on the road.
        const c = Math.cos(b.ry), sn = Math.sin(b.ry);
        for (let u = -2; u <= 2; u++) {
          for (let v = -2; v <= 2; v++) {
            const lu = (u / 4) * w, lv = (v / 4) * d;
            if (this.onAnyRoad(x + lu * c + lv * sn, z - lu * sn + lv * c)) return false;
          }
        }
      }
      building(x, z, yaw, w, d, h, palette, glassy);
      claim(b);
      return true;
    };
    const N = this.samples.length;

    // --- palettes
    const RENDER = [0xd8d3c6, 0xe6e0d2, 0xc9c2b4, 0xbfb8a9, 0xd0c8b8];
    const PAINTED = [0xd8756a, 0x6f9bc4, 0x8fae7a, 0xd8b364, 0xb08cc0, 0xe0ddd2, 0xc4705a];
    const BRICK = [0x8c5b46, 0x9a6a4e, 0x7d5340, 0x8f6248];
    const TOWER = [0x8e979e, 0x7d868d, 0x9aa3aa, 0x69727a];
    const GLASS = 0x39586b;
    // What is on behind the glass. Mostly tungsten, some of it fluorescent
    // office white, a little of it the blue flicker of a television — a street
    // where every window is the same colour reads as a texture, not a city.
    const LAMPLIGHT = [0xffd9a0, 0xffc478, 0xffe8c4, 0xf0e2c0, 0xffb45e];
    const OFFICE = [0xd8e8f0, 0xc4dcea, 0xe4eef4];
    const TELLY = [0x6ea8e0, 0x8ec0ea];
    const litColour = (tall) => (Math.random() < 0.08 ? pick(TELLY)
      : tall && Math.random() < 0.62 ? pick(OFFICE) : pick(LAMPLIGHT));

    // A building: a box with a grid of windows, a roofline and something on
    // the roof. Everything about it scales with its height, so a two-storey
    // warehouse and a thirty-storey tower are the same eleven lines of code.
    const building = (x, z, yaw, w, d, h, palette, glassy) => {
      const y = this.groundAt(x, z);
      const body = pick(palette);
      // `yaw` is the direction the street runs. A building turned to face that
      // way presents its side wall to the road and its windows to its
      // neighbours, which is what was happening: the windows were there, they
      // were just looking up and down the street. Turn it a quarter so the
      // frontage — the face the windows go on, and the face `d` is measured
      // away from — squares up to the kerb.
      const ry = yaw + Math.PI / 2;
      b.add(G.box(w, h, d), body, { x, y: y + h / 2, z, ry, mottle: 0.07 });

      // Windows, as recessed bands on the two long faces. Individual panes on
      // anything short enough that you would see them.
      const floors = Math.max(1, Math.round(h / 3.4));

      // All four faces, not two.
      //
      // Windows used to go on the long pair only, which was fine while every
      // building was a narrow frontage seen from the street it fronts. The
      // moment the city was filled in with near-square blocks seen from every
      // side, half of them showed a blank wall — and a blank wall thirty
      // metres high beside the road is the most conspicuous thing in the place.
      //
      // A face is described by how wide it is, how far out it sits, and the
      // quarter-turn that puts a window on it. Everything below is written
      // once and run twice.
      const faces = [
        { span: w, out: d / 2, turn: 0 },
        { span: d, out: w / 2, turn: Math.PI / 2 },
      ];
      // Local (along the face, out of the face) to world, through the
      // building's own rotation.
      const on = (f, along, sd, out, fy) => {
        const lx = f.turn === 0 ? along : sd * (f.out + out);
        const lz = f.turn === 0 ? sd * (f.out + out) : along;
        return {
          x: x + Math.cos(ry) * lx + Math.sin(ry) * lz,
          y: fy,
          z: z - Math.sin(ry) * lx + Math.cos(ry) * lz,
          ry: ry + f.turn,
        };
      };

      for (let f2 = 0; f2 < floors; f2++) {
        const fy = y + 1.9 + f2 * (h / floors);
        if (fy > y + h - 0.9) continue;
        const tall = glassy || floors > 7;
        if (tall) {
          // Too tall to pick out individual panes: a continuous band of glass
          // wrapping the floor reads better and costs two boxes instead of
          // forty. Two, because one slab only stands proud of one pair of
          // faces — the other pair needs its own.
          const bh = (h / floors) * 0.52;
          b.add(G.box(w * 0.88, bh, d + 0.06), GLASS, { x, y: fy, z, ry });
          b.add(G.box(w + 0.06, bh, d * 0.88), GLASS, { x, y: fy, z, ry });
        }
        for (const f of faces) {
          if (tall) {
            // A tower is never all on or all off. Break the band into offices
            // and light some of them — an unlit band with a few bright panels
            // in it is what a downtown block looks like from the street.
            const cells = Math.max(3, Math.round(f.span / 3.4));
            const cw = (f.span * 0.88) / cells;
            for (let k = 0; k < cells; k++) {
              if (Math.random() > 0.38) continue;
              const along = (k - (cells - 1) / 2) * cw;
              for (const sd of [-1, 1]) {
                if (Math.random() < 0.45) continue;
                lit.add(G.box(cw * 0.84, (h / floors) * 0.44, 0.06), litColour(true),
                  { ...on(f, along, sd, 0.06, fy), mottle: 0.10 });
              }
            }
          } else {
            const per = Math.max(2, Math.round(f.span / 2.6));
            const pw = f.span / per;
            for (let k = 0; k < per; k++) {
              const along = (k - (per - 1) / 2) * pw;
              for (const sd of [-1, 1]) {
                b.add(G.box(pw * 0.44, 1.35, 0.10), 0x2c3a44, on(f, along, sd, 0.03, fy));
                // Proud of the dark pane, not inside it, or the two fight over
                // the same depth and the window flickers between lit and unlit.
                if (Math.random() < 0.42) {
                  lit.add(G.box(pw * 0.40, 1.24, 0.06), litColour(false),
                    { ...on(f, along, sd, 0.07, fy), mottle: 0.12 });
                }
              }
            }
          }
        }
      }

      // Roofline: a cornice, and then a water tank, a stair head or an aerial.
      b.add(G.box(w + 0.5, 0.45, d + 0.5), body, { x, y: y + h + 0.2, z, ry, mottle: 0.05 });
      const r = Math.random();
      if (r < 0.34) {
        // The wooden water tank on legs, which is half the skyline here.
        b.add(G.cyl(w * 0.16, w * 0.16, h * 0.10 + 1.4, 16), 0x7a5a3c,
          { x, y: y + h + 1.6 + (h * 0.10) / 2, z, mottle: 0.1 });
        b.add(G.cone(w * 0.17, 0.8, 16), 0x6a4c32, { x, y: y + h + 2.4 + h * 0.10, z });
        for (const sx of [-1, 1]) for (const sd of [-1, 1]) {
          b.add(G.box(0.12, 1.6, 0.12), 0x5f4630,
            { x: x + sx * w * 0.11, y: y + h + 1.0, z: z + sd * w * 0.11 });
        }
      } else if (r < 0.62) {
        b.add(G.box(w * 0.3, 2.2, d * 0.3), body, { x, y: y + h + 1.5, z, ry });
      } else if (r < 0.78) {
        b.add(G.cyl(0.10, 0.10, h * 0.22 + 4, 10), 0x8a9098, { x, y: y + h + (h * 0.22 + 4) / 2, z });
      }
      // The footprint as built, not just a radius — the smoke test checks that
      // no two of these overlap and that none of them stands on a road, and
      // neither question can be answered from a bounding circle.
      this.props.push({ x, z, r: Math.hypot(w, d) / 2, kind: 'building', w, d, ry });
    };

    // --- line both sides of every street
    //
    // Walked plot by plot rather than at a fixed stride, because the frontage
    // is what runs along the street and the districts do not share one. A
    // twenty-five-foot row house and a warehouse stepped at the same interval
    // gives you either gaps in the terrace or warehouses buried in each other;
    // stepping by the frontage just placed keeps both of them a street.
    for (let i = 0; i < N;) {
      const p = this.samples[i];
      const yaw = Math.atan2(p.dirX, p.dirZ);
      // Height and character by district: the water is low and industrial,
      // the climb is residential, the top of the hill is downtown.
      const up = p.y;
      let front, palette, glassy = false, gap;
      if (up < 5) {
        front = rand(17, 26); palette = BRICK; gap = 1.10;
      } else if (up < 17) {
        // Row houses share their side walls, so barely any gap at all.
        front = rand(7.5, 10); palette = PAINTED; gap = 1.02;
      } else {
        front = rand(17, 28); palette = TOWER; gap = 1.14;
      }
      for (const side of [-1, 1]) {
        const w = front;
        // The frontage is the row you drive past, so it stays low whatever
        // district it is in — the towers belong behind it.
        const h = up < 5 ? rand(7, 13) : up < 17 ? rand(11, 19) : rand(16, 26);
        const dep = up < 5 ? rand(14, 26) : up < 17 ? rand(11, 16) : rand(17, 30);
        if (up >= 17) glassy = Math.random() < 0.55;
        const off = side * (p.width / 2 + this.barrierOffset + 3.5 + dep / 2);
        const x = p.x + p.nx * off, z = p.z + p.nz * off;
        // A terrace shares its side walls, so the row houses are allowed to
        // touch; a warehouse is not.
        put(x, z, yaw, w, dep, h, palette, glassy,
          this.barrierOffset, up < 17 && up >= 5 ? -0.2 : 0.8);
      }
      i += Math.max(2, Math.round((front * gap) / this.step));
    }

    yield 'the frontage';

    // --- a second and third rank behind the first, so the streets have depth.
    //
    // Ranked back from the road rather than laid out on the block grid: the
    // grid is how the CIRCUIT is set out, not how the whole map should look,
    // and filling every block from it turned the place into a chessboard. What
    // is wanted behind the frontage is depth, which is buildings of varying
    // size at varying distances, slightly off-square to each other.
    for (let i = 0; i < N; i += 15) {
      const p = this.samples[i];
      const jitter = rand(-0.25, 0.25);
      for (const side of [-1, 1]) {
        for (const rank of [1, 2, 3]) {
          const dep = rand(18, 34);
          const off = side * (p.width / 2 + this.barrierOffset + 32 * rank + dep / 2);
          const x = p.x + p.nx * off + rand(-9, 9), z = p.z + p.nz * off + rand(-9, 9);
          const gy = this.groundAt(x, z);
          if (gy < -2) continue;                       // out over the water
          const up = p.y;
          const back = 32 * rank;
          const h = Math.min(16 + clamp((back - 14) / 90, 0, 1) * 78,
            up > 17 ? rand(30, 96) : up > 5 ? rand(12, 26) : rand(8, 18));
          // Ranked back from the circuit, but fronting whatever street it
          // actually ends up beside.
          const yaw = this.streetYaw(x, z) + jitter;
          put(x, z, yaw, rand(16, 30), dep, h,
            up > 17 ? TOWER : up > 5 ? RENDER : BRICK, up > 17 && Math.random() < 0.6,
            this.barrierOffset + 6);
        }
      }
    }

    yield 'the blocks';

    // --- fill in whatever is left.
    //
    // The frontage and the ranks are placed by walking the circuit, so they
    // leave holes wherever the geometry did not happen to offer a spot — and
    // now that overlapping is properly refused, the holes are real holes
    // rather than buildings inside other buildings. This sweeps the whole city
    // on a lattice and drops a building into every gap big enough to take one,
    // trying a large footprint first and working down.
    {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of this.samples) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      const REACH = 190;
      const SIZES = [[30, 26], [24, 20], [18, 16], [13, 12], [9, 9]];
      for (let x = minX - REACH; x <= maxX + REACH; x += 11) {
        for (let z = minZ - REACH; z <= maxZ + REACH; z += 11) {
          const loc = this.locate(x, z);
          if (Math.abs(loc.lateral) > REACH) continue;
          const gy = this.groundAt(x, z);
          if (gy < -2) continue;                       // out over the water
          // Square to the nearest street — which may well be a side street,
          // not the circuit.
          const yaw = this.streetYaw(x, z);
          const up = loc.sample.y;
          // Height ramped by how far back it stands.
          //
          // A ninety-metre tower on the kerb is a wall, not a building: from
          // the car you cannot see the top of it, cannot see past it, and the
          // street stops being a street. Cities do not do this either — the
          // tall ones are set back and the frontage is low. So the ceiling
          // rises with distance from the road, and the big ones end up where
          // they read as a skyline instead of as a canyon.
          const back = Math.abs(loc.lateral) - loc.width / 2;
          const ceiling = 16 + clamp((back - 14) / 90, 0, 1) * 78;
          for (const [w, d] of SIZES) {
            const h = Math.min(ceiling,
              up > 17 ? rand(26, 92) : up > 5 ? rand(11, 24) : rand(8, 17));
            const palette = up > 17 ? TOWER : up > 5 ? (Math.random() < 0.5 ? PAINTED : RENDER) : BRICK;
            if (put(x + rand(-2, 2), z + rand(-2, 2), yaw, w, d, h, palette,
              up > 17 && Math.random() < 0.6, this.barrierOffset + 1.5)) break;
          }
        }
      }
    }

    yield 'the buildings';

    // --- street furniture, on the pavement.
    //
    // Lamp standards, traffic signals and signs are built as their OWN meshes
    // rather than merged into the city, because they can be knocked over. A
    // merged mesh is one object; you cannot tip one lamp post out of it. It
    // costs a draw call each, which for a couple of hundred slim objects is
    // affordable and buys the thing that most makes a street feel like a place
    // rather than a backdrop: it gives way when you hit it.
    //
    // Everything that does NOT fall — hydrants, trees, parked cars — stays in
    // the merged mesh where it belongs.
    const breakable = (x, y, z, kind, build) => this.breakable(group, x, y, z, kind, build);

    for (let i = 0; i < N; i += 6) {
      const p = this.samples[i];
      const side = (i / 6) % 2 ? 1 : -1;
      const off = side * (p.width / 2 + this.barrierOffset + 2.4);
      const x = p.x + p.nx * off, z = p.z + p.nz * off;
      // ...and clear of every OTHER stretch too, not just this one. Where the
      // circuit doubles back, the pavement of one street is the racing surface
      // of the next one along.
      if (!roomFor(x, z, 2.2, this.barrierOffset - 1.6)) continue;
      const y = p.y;
      const kind = (i / 6) % 5;
      if (kind === 0) {
        // Lamp standard with a swan neck over the road. Its own mesh, built
        // about its base, so it can be knocked flat.
        const armY = Math.atan2(p.nx * -side, p.nz * -side);
        const ox = -p.nx * side, oz = -p.nz * side;
        breakable(x, y, z, 'lamp', (m) => {
          m.add(G.cyl(0.13, 0.16, 7.5, 14), 0x3f464d, { y: 3.75 });
          m.add(G.box(0.16, 0.16, 2.1), 0x3f464d, { x: ox * 1.0, y: 7.4, z: oz * 1.0, ry: armY });
          m.add(G.box(0.54, 0.22, 0.96), 0x4a4a44, { x: ox * 1.9, y: 7.28, z: oz * 1.9 });
          // The lens, in the same mesh: unlit would mean a second object to
          // knock over in step with this one, and a lamp on the ground with
          // its light still burning in mid-air is worse than a dimmer lamp.
          m.add(G.box(0.46, 0.10, 0.86), 0xffe0b4, { x: ox * 1.9, y: 7.12, z: oz * 1.9 });
        });
        const hx = x + ox * 1.9, hz = z + oz * 1.9;
        // Pushed in toward the road rather than left under the standard —
        // the light that matters is the light on the asphalt.
        const px = hx - p.nx * side * 3.4, pz = hz - p.nz * side * 3.4;
        pools.add(this._poolGeometry(px, pz, 30), 0xb08048, {});
        this.lamps.push({ x: hx, y: y + 7.1, z: hz });
      } else if (kind === 1) {
        b.add(G.cyl(0.16, 0.20, 0.85, 14), 0xc23c2c, { x, y: y + 0.42, z });  // hydrant
        b.add(G.sphere(0.19, 14, 10), 0xc23c2c, { x, y: y + 0.9, z });
        b.add(G.box(0.5, 0.11, 0.11), 0xc23c2c, { x, y: y + 0.66, z });
      } else if (kind === 2) {
        // A street tree in a grate — palms down at the water, planes up top.
        const th = rand(5, 8);
        b.add(G.cyl(0.17, 0.22, th, 12), 0x6a5540, { x, y: y + th / 2, z });
        if (p.y < 6) {
          for (let f = 0; f < 7; f++) {
            const a = (f / 7) * Math.PI * 2;
            b.add(G.box(0.5, 0.1, 2.9), 0x4e6b39, {
              x: x + Math.cos(a) * 1.2, y: y + th - 0.2, z: z + Math.sin(a) * 1.2,
              ry: -a, rx: 0.42,
            });
          }
        } else {
          b.add(G.icosa(rand(1.9, 2.7), 1), pick([0x3f6b34, 0x4a7538, 0x365c2c]),
            { x, y: y + th + 0.9, z, mottle: 0.13 });
        }
      } else if (kind === 3) {
        // Traffic signals on a mast arm — also its own mesh, also breakable.
        const armY2 = Math.atan2(p.nx * -side, p.nz * -side);
        const sx = -p.nx * side, sz = -p.nz * side;
        const on = Math.random() < 0.55 ? 0 : 2;
        breakable(x, y, z, 'signal', (m) => {
          m.add(G.cyl(0.12, 0.14, 5.4, 14), 0x2f3439, { y: 2.7 });
          m.add(G.box(0.14, 0.14, 2.6), 0x2f3439, { x: sx * 1.3, y: 5.2, z: sz * 1.3, ry: armY2 });
          m.add(G.box(0.34, 0.95, 0.28), 0x24282c, { x: sx * 2.5, y: 4.7, z: sz * 2.5 });
          for (let l = 0; l < 3; l++) {
            m.add(G.sphere(l === on ? 0.11 : 0.10, 12, 9),
              l === on ? [0xff4a3a, 0xffcc44, 0x44ff8a][l] : [0x3a1614, 0x2e2718, 0x14301e][l],
              { x: sx * 2.5, y: 5.02 - l * 0.31, z: sz * 2.5 + 0.15 });
          }
        });
      } else {
        // A parked car, kerbside, which is what a city street is full of.
        const col = pick([0x8c9298, 0x2f3a45, 0xa8422f, 0x39543f, 0xd0cec6, 0x2c2f33]);
        b.add(G.box(1.75, 0.72, 4.3), col, { x, y: y + 0.62, z, ry: Math.atan2(p.dirX, p.dirZ), mottle: 0.05 });
        b.add(G.box(1.6, 0.62, 2.1), col, { x, y: y + 1.24, z, ry: Math.atan2(p.dirX, p.dirZ), mottle: 0.05 });
        b.add(G.box(1.5, 0.42, 1.5), 0x1f2a31, { x, y: y + 1.3, z, ry: Math.atan2(p.dirX, p.dirZ) });
        for (const sx of [-1, 1]) for (const sd of [-1.4, 1.4]) {
          b.add(G.cyl(0.31, 0.31, 0.2, 14), 0x1b1d20, {
            x: x + Math.cos(Math.atan2(p.dirX, p.dirZ)) * sx * 0.8 + Math.sin(Math.atan2(p.dirX, p.dirZ)) * sd,
            y: y + 0.31,
            z: z - Math.sin(Math.atan2(p.dirX, p.dirZ)) * sx * 0.8 + Math.cos(Math.atan2(p.dirX, p.dirZ)) * sd,
            rz: Math.PI / 2, ry: Math.atan2(p.dirX, p.dirZ),
          });
        }
      }
      this.props.push({ x, z, r: 2.2, kind: 'street' });
    }

    // --- braking boards on the approach to the heaviest stops.
    //
    // On their own posts, and knocked flat like everything else on a post. A
    // sign that a car drives through is the one thing on the street that most
    // obviously is not there.
    for (const zone of this._brakingZones()) {
      for (let d = 0; d < 3; d++) {
        const p = this.atDistance(zone - 45 - d * 45);
        const off = -(p.width / 2 + 2.4);
        const bx = p.x + p.nx * off, bz = p.z + p.nz * off;
        const yaw = Math.atan2(p.dirX, p.dirZ);
        this.breakable(group, bx, p.y, bz, 'board', (m) => {
          m.add(G.box(0.14, 1.7, 0.14), 0x53585f, { y: 0.85 });
          m.add(G.box(1.3, 1.3, 0.10), 0xf2f2ee, { y: 1.7, ry: yaw });
          m.add(G.box(1.42, 0.10, 0.14), 0x2a2e33, { y: 2.4, ry: yaw });
        });
      }
    }

    group.add(b.build());
    // The lit things go in after, unlit so the scene lighting cannot dim them;
    // the pools go in last and add rather than cover, so two lamps overlapping
    // make a brighter patch instead of a seam.
    group.add(lit.build(VC_UNLIT));
    const pool = new THREE.Mesh(pools.build().geometry, poolMaterial());
    pool.renderOrder = 3;
    group.add(pool);
    yield 'the street';
    this._buildLandmarks(group);
  }

  // The things on the horizon that say where this is. None of them is anywhere
  // near the circuit — they sit hundreds of metres out across the water and the
  // hills, purely to be looked at — so none of them needs a clearance check.
  _buildLandmarks(group) {
    const b = new MeshBuilder();
    const lit = new MeshBuilder();

    // Landmarks are the skyline, and the skyline has to stay on the horizon.
    //
    // They are placed at fixed coordinates around the origin, and when the
    // circuit was re-laid on a grid and re-centred, the coordinates stayed
    // where they were — so the downtown cluster ended up standing among the
    // city instead of behind it. A hundred-metre slab with no windows on it,
    // two streets from the racing line, is the most conspicuous object in the
    // place. Two hundred metres clear is past the far edge of the band the
    // city fills, so they cannot land inside it or on top of anything in it.
    const far = (x, z, m = 200) => {
      const loc = this.locate(x, z);
      return Math.abs(loc.lateral) - loc.width / 2 > m;
    };

    // Lit floors, so a distant tower reads as a building rather than as a
    // shape. Cheap: a band per floor, no glass and no dark panes, because at
    // this distance that is all you can see of it anyway.
    const floorsOn = (x, z, y, w, d, h, ry) => {
      const floors = Math.max(3, Math.round(h / 3.6));
      for (let f = 0; f < floors; f++) {
        const fy = y + 2.4 + f * (h / floors);
        if (fy > y + h - 1.2) break;
        const bh = (h / floors) * 0.42;
        const cells = Math.max(3, Math.round(w / 4.2));
        for (let k = 0; k < cells; k++) {
          if (Math.random() > 0.34) continue;
          const ox = (k - (cells - 1) / 2) * (w * 0.86 / cells);
          for (const sd of [-1, 1]) {
            if (Math.random() < 0.4) continue;
            lit.add(G.box((w * 0.86 / cells) * 0.8, bh, 0.06), pick([0xffd9a0, 0xd8e8f0, 0xffc478]), {
              x: x + Math.cos(ry) * ox + Math.sin(ry) * sd * (d / 2 + 0.05),
              y: fy,
              z: z - Math.sin(ry) * ox + Math.cos(ry) * sd * (d / 2 + 0.05),
              ry, mottle: 0.12,
            });
          }
        }
      }
    };

    // --- the headlands across the bay, in receding bands.
    //
    // Sunk well below the waterline and squashed flat, so what you see is the
    // top of a landmass rising out of the water. Left as whole spheres sitting
    // at their own height they read as green boulders floating in the fog,
    // which is what they were.
    for (let band = 0; band < 3; band++) {
      const dist = 640 + band * 200;
      const shade = [0x6d7b64, 0x6a757a, 0x737e88][band];
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2 + band * 0.14;
        const r = rand(70, 150);
        const flat = rand(0.26, 0.44) * (1 - band * 0.15);
        b.add(G.icosa(r, 1), shade, {
          x: Math.cos(a) * dist + rand(-60, 60),
          y: -r * flat * 0.55 - 8,               // most of it is under the water
          z: Math.sin(a) * dist + rand(-60, 60),
          sy: flat, ry: rand(0, 3), mottle: 0.08,
        });
      }
    }

    // --- the bridge.
    //
    // It is the thing on the horizon that says where this is, and at night a
    // bridge is mostly light: the deck lit end to end, the towers picked out,
    // traffic on it both ways, and an aircraft beacon on each tower. Built as
    // a shape alone it was a red-orange girder in the fog and your eye went
    // straight past it. Almost everything added here goes into the unlit
    // builder, so it survives the tone mapping and blooms.
    const BRIDGE = 0xc0472a;
    {
      const bx = -560, bz = 330, ang = 0.7;
      const span = 340, deckY = 34, towerY = 118;
      const dirX = Math.cos(ang), dirZ = Math.sin(ang);
      const half = span * 0.5;
      // Along the bridge by `t` in [-1, 1], and out to one side by `o`.
      const at = (t, o) => ({
        x: bx + dirX * t * half - dirZ * o,
        z: bz + dirZ * t * half + dirX * o,
      });

      // The deck, its stiffening truss underneath, and the roadway on top.
      b.add(G.box(span * 2.4, 2.6, 17), BRIDGE, { x: bx, y: deckY, z: bz, ry: -ang });
      b.add(G.box(span * 2.4, 3.4, 12), 0x8a3a22, { x: bx, y: deckY - 3.2, z: bz, ry: -ang });
      b.add(G.box(span * 2.4, 0.5, 15), 0x2a2c30, { x: bx, y: deckY + 1.5, z: bz, ry: -ang });
      // The lane line down the middle of it, which is what makes it read as a
      // road rather than as a beam.
      lit.add(G.box(span * 2.35, 0.08, 0.5), 0xd8c88a, { x: bx, y: deckY + 1.8, z: bz, ry: -ang });

      for (const end of [-1, 1]) {
        const T = at(end, 0);
        for (const sd of [-1, 1]) {
          const p2 = at(end, sd * 6);
          b.add(G.box(10, towerY, 10), BRIDGE, { x: p2.x, y: towerY / 2, z: p2.z, ry: -ang });
          // The towers step in as they rise, which is most of their outline.
          b.add(G.box(8, 16, 8), BRIDGE, { x: p2.x, y: towerY - 6, z: p2.z, ry: -ang });
          b.add(G.box(6, 10, 6), BRIDGE, { x: p2.x, y: towerY + 6, z: p2.z, ry: -ang });
          // Floodlit from below, the way they actually are.
          // Floodlit from below, the way they actually are — bright enough to
          // pick the towers out of the sky rather than merely tint them.
          for (let f = 0; f < 5; f++) {
            lit.add(G.box(5.2, 1.2, 5.2), 0xffa858,
              { x: p2.x, y: deckY + 6 + f * 19, z: p2.z, ry: -ang });
          }
        }
        // The cross-bracing between the two legs.
        for (let k = 0; k < 6; k++) {
          const y = 16 + k * ((towerY - 20) / 5);
          b.add(G.box(3.2, 3.0, 13.5), BRIDGE, { x: T.x, y, z: T.z, ry: -ang });
        }
        // Aircraft warning beacon on the top of each tower.
        lit.add(G.sphere(1.5, 10, 8), 0xff2a20, { x: T.x, y: towerY + 12, z: T.z });
        b.add(G.cyl(0.5, 0.5, 8, 8), 0xb0aca4, { x: T.x, y: towerY + 7, z: T.z });
      }

      // The main cables, as a chain of short segments following the sag, with
      // hangers dropped from them to the deck.
      const sag = (t) => deckY + 5 + (towerY - deckY - 12) * t * t;
      for (const sd of [-1, 1]) {
        for (let k = -34; k <= 34; k++) {
          const t = k / 34;
          const p2 = at(t, sd * 6);
          b.add(G.box(1.6, 1.6, span / 30), BRIDGE, { x: p2.x, y: sag(t), z: p2.z, ry: -ang });
          if (k % 2 === 0 && sag(t) > deckY + 6) {
            b.add(G.box(0.45, sag(t) - deckY, 0.45), BRIDGE,
              { x: p2.x, y: deckY + (sag(t) - deckY) / 2, z: p2.z });
          }
        }
        // The back-stays running down from the towers to the anchorages.
        for (let k = 0; k <= 22; k++) {
          const t = k / 22;
          for (const end of [-1, 1]) {
            const u = end * (1 + t * 0.7);
            const p2 = at(u, sd * 6);
            b.add(G.box(1.4, 1.4, span / 24), BRIDGE,
              { x: p2.x, y: towerY - 12 - t * (towerY - deckY - 6), z: p2.z, ry: -ang });
          }
        }
      }

      // Deck lighting. At this distance a single lamp is a couple of pixels,
      // so what has to carry across the water is the RUN of them tracing the
      // deck. A continuous lit strip does that and looks like a laser; a
      // string of separate heads, close enough together to read as a line and
      // separate enough to twinkle through the fog, is the real thing.
      for (let k = -46; k <= 46; k++) {
        const t = (k / 46) * 1.16;
        for (const sd of [-1, 1]) {
          const p2 = at(t, sd * 7.6);
          if (k % 2 === 0) b.add(G.cyl(0.3, 0.36, 7, 8), 0x6a5f58, { x: p2.x, y: deckY + 5.2, z: p2.z });
          lit.add(G.sphere(0.95, 8, 6), 0xffe0ac, { x: p2.x, y: deckY + 8.4, z: p2.z });
        }
      }

      // And traffic. Headlights one way, tail lights the other — the single
      // thing that makes a bridge at night look like it is in use.
      for (let k = 0; k < 46; k++) {
        const t = rand(-1.12, 1.12);
        const lane = k % 2 ? 1 : -1;
        const p2 = at(t, lane * 3.6);
        const y = deckY + 2.4;
        b.add(G.box(1.7, 1.3, 4.0), pick([0x2f3a45, 0x8c9298, 0x39543f, 0xa8422f]),
          { x: p2.x, y, z: p2.z, ry: -ang, mottle: 0.06 });
        // Facing the way its lane runs, so the reds and the whites separate
        // into two streams the way they do on a real carriageway.
        const f = lane > 0 ? 1 : -1;
        const nose = at(t + f * 0.008, lane * 3.6);
        const tail = at(t - f * 0.008, lane * 3.6);
        lit.add(G.box(1.2, 0.26, 0.3), 0xfff2d8, { x: nose.x, y, z: nose.z, ry: -ang });
        lit.add(G.box(1.2, 0.22, 0.3), 0xff2a1c, { x: tail.x, y, z: tail.z, ry: -ang });
      }
    }

    // --- a pyramid tower downtown, and the cluster of blocks around it
    {
      const px = 470, pz = -470;
      const py = this.groundAt(px, pz);
      b.add(G.cyl(0.5, 15, 190, 4), 0xd0cec6, { x: px, y: py + 95, z: pz, ry: Math.PI / 4 });
      b.add(G.cyl(0.2, 1.6, 26, 4), 0xd0cec6, { x: px, y: py + 200, z: pz, ry: Math.PI / 4 });
      // Floors up the pyramid, narrowing as it does.
      //
      // It was a blank white spike, and the two pylons beside it blank white
      // slabs — the last things in the place built without windows, and a
      // hundred and ninety metres of blank wall is not something you fail to
      // notice at the end of a street. The bands are sized to the section at
      // each height, and doubled so they stand proud of all four faces.
      {
        const FLOORS = 42;
        for (let k = 1; k < FLOORS; k++) {
          const t = k / FLOORS;
          const r = lerp(15, 0.5, t) * 0.98;
          const y = py + t * 190;
          b.add(G.box(r * 2, 2.2, r * 2 + 0.12), 0x3a4550, { x: px, y, z: pz, ry: Math.PI / 4 });
          b.add(G.box(r * 2 + 0.12, 2.2, r * 2), 0x3a4550, { x: px, y, z: pz, ry: Math.PI / 4 });
          if (Math.random() < 0.55) {
            const c2 = pick([0xffd9a0, 0xd8e8f0, 0xffc478]);
            b.add(G.box(r * 1.5, 1.5, r * 2 + 0.2), c2, { x: px, y, z: pz, ry: Math.PI / 4 });
            b.add(G.box(r * 2 + 0.2, 1.5, r * 1.5), c2, { x: px, y, z: pz, ry: Math.PI / 4 });
          }
        }
      }
      for (const sx of [-1, 1]) {
        const bx = px + sx * 13;
        b.add(G.box(7, 62, 7), 0xc4c2ba, { x: bx, y: py + 62, z: pz, ry: Math.PI / 4 });
        floorsOn(bx, pz, py + 31, 7, 7, 62, Math.PI / 4);
        floorsOn(bx, pz, py + 31, 7, 7, 62, Math.PI * 0.75);
      }
      for (let i = 0, tries = 0; i < 16 && tries < 300; tries++) {
        const a = rand(0, Math.PI * 2), d = rand(60, 260);
        const x = px + Math.cos(a) * d, z = pz + Math.sin(a) * d;
        if (!far(x, z)) continue;
        i++;
        const h = rand(45, 140), w = rand(20, 34), dep = rand(20, 34);
        const ry = rand(0, 1.5);
        const gy = this.groundAt(x, z);
        b.add(G.box(w, h, dep), pick([0x8e979e, 0x7d868d, 0x9aa3aa]),
          { x, y: gy + h / 2, z, ry, mottle: 0.07 });
        floorsOn(x, z, gy, w, dep, h, ry);
        floorsOn(x, z, gy, dep, w, h, ry + Math.PI / 2);
      }
    }

    // --- piers and warehouses along the waterfront edge
    for (let i = 0; i < 9; i++) {
      const a = -0.9 + i * 0.16;
      const d = 560;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const y = this.groundAt(x, z);
      if (y > 2) continue;
      const shed = pick([0x9a8f7c, 0x8b8073, 0x7f7b70]);
      b.add(G.box(26, 9, 62), shed, { x, y: y + 4.5, z, ry: a, mottle: 0.07 });
      // Windows. These were the one thing in the place built as plain boxes —
      // every other building in the city gets them on all four faces, and a
      // blank nine-metre wall at the end of a street is conspicuous however
      // far away it is.
      for (let k = -4; k <= 4; k++) {
        for (const sd of [-1, 1]) {
          const wx = x + Math.cos(a) * sd * 13.1 + Math.sin(a) * k * 6.0;
          const wz = z - Math.sin(a) * sd * 13.1 + Math.cos(a) * k * 6.0;
          b.add(G.box(0.12, 1.8, 3.4), 0x2c3a44, { x: wx, y: y + 6.2, z: wz, ry: a });
          if (Math.random() < 0.4) {
            lit.add(G.box(0.1, 1.6, 3.1), pick([0xffd9a0, 0xd8e8f0]),
              { x: wx + Math.cos(a) * sd * 0.06, y: y + 6.2, z: wz - Math.sin(a) * sd * 0.06, ry: a });
          }
        }
      }
    }

    group.add(b.build());
    group.add(lit.build(VC_UNLIT));
  }

  // Where the speed profile says the biggest stops are — used for the braking
  // boards, and a decent summary of the circuit's character.
  _brakingZones() {
    const N = this.line.length;
    const drops = [];
    for (let i = 0; i < N; i++) {
      const a = this.line[i].speed;
      const b = this.line[(i + 12) % N].speed;
      drops.push({ s: this.line[i].s, drop: a - b });
    }
    drops.sort((p, q) => q.drop - p.drop);
    const picked = [];
    for (const d of drops) {
      if (picked.some((p) => Math.abs(p - d.s) < 120 || Math.abs(p - d.s) > this.length - 120)) continue;
      picked.push(d.s);
      if (picked.length === 3) break;
    }
    return picked;
  }

  // How far apart two points are along the lap, signed, taking the short way.
  gap(sA, sB) {
    let d = sA - sB;
    while (d > this.length / 2) d -= this.length;
    while (d < -this.length / 2) d += this.length;
    return d;
  }
}
