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
import { MeshBuilder, G, VC_MATERIAL, VC_MATERIAL_DS, VC_UNLIT, poolMaterial } from './meshkit.js';
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
const JUNCTION_TAPER = 14;

// How far the ground field blends the road's own height across, and the cell
// size of the index that makes that blend cheap — the two are the same number
// on purpose, so the 3x3 block around a point covers exactly the radius.
const GROUND_R = 40;

// How far below the road the ground sits at the kerb, and how far the wider
// field sits below the road it is averaged from. Both were a metre or more,
// which put the whole road on a plinth; a kerb is fifteen centimetres and the
// land beyond a pavement is not much further down than that.
// How far past the edge of the city the water starts, and how far it takes to
// become all water. The margin has to clear the buildings, which stand a
// hundred and thirty metres back from the road at the third rank.
// How far back from the road the shore towns stand.
const SHORE_CLEAR = 58;

const BAY_MARGIN = 210;
const BAY_FADE = 230;

const KERB_DROP = 0.18;
const GROUND_FALL = 0.34;

// The freeway ramp: how the deck climbs and how far it reaches.
const RAMP = { segments: 14, seg: 22, rise: 0.075, bend: 0.055, width: 11 };

// How far into an open route the start line goes: the grid is laid out in the
// ninety metres before it, and a route has no road before its first metre.
const GRID_RUNUP = 130;

// Sea level, for the layouts whose road is over water.
const SEA_Y = -6;

// The colour of open water at night.
//
// Nearly black in the troughs, a cold sheen on the crests where the sky is on
// the face of them, and a glint where the short chop catches. `lit` is how
// much light there is falling on it — the bridge and the city are the only
// things out here throwing any.
//
// One function, used by the bay around a city and by the sea under a bridge,
// because they are the same water and were two different flat colours.
function waterColour(x, z, lit) {
  const h = swell(x, z);
  const crest = clamp((h + 1.9) / 3.8, 0, 1);
  const chop = clamp(
    (Math.sin(x * 0.041 - z * 0.029) + Math.sin(z * 0.052 + x * 0.017)) * 0.5 + 0.5, 0, 1);
  const l = 0.048 + crest * crest * 0.075 + Math.pow(chop, 5) * 0.10 + lit * lit * 0.05;
  return [l * 0.72 + lit * lit * 0.035, l * 0.92, l * 1.35 + 0.018];
}

// The swell. Four wavelengths at four angles, because one is a corrugated
// roof and two is a grid — what stops it reading as either is that no two of
// them line up. Read by the water's geometry and by its colour, so the crests
// are where the light is.
function swell(x, z) {
  // Four wavelengths, from a kilometre and a half down to seventy metres.
  //
  // The long ones alone are invisible from a bridge: one crest fills the whole
  // view and the water reads as a tilted sheet. What makes it look like water
  // from the deck is the short chop on top, and the short chop is the reason
  // the mesh under it has to be fine enough to carry it.
  return Math.sin(x * 0.0042 + z * 0.0011) * 1.5
    + Math.sin(x * 0.0009 - z * 0.0051) * 1.1
    + Math.sin((x + z) * 0.0135) * 0.45
    + Math.sin(x * 0.041 - z * 0.029) * 0.20
    + Math.sin(z * 0.052 + x * 0.017) * 0.14;
}

// The bridge, as the ramp needs to know it: how long the deck is and how high.
// Both are read off the numbers the bridge is actually built from below.
const BRIDGE_DECK = 340 * 2.4;
const BRIDGE_DECK_Y = 34;

// The layouts.
//
// A layout is the two things that make one circuit different from another —
// where the junctions are, and how high the road is at each point of the lap —
// and nothing else. Everything downstream of them (the fillets, the side
// streets, the blockades, the city, the scenery) is derived, so a new stage is
// a table of numbers rather than a second copy of this file.
//
// `loop` is (column, row) on the street grid. It is rectilinear apart from the
// diagonal avenue across the top of the hill, which is the one thing a real
// grid city always has cutting across it.
//
// `elevation` is height against FRACTION OF A LAP, not against any angle or
// index: grade is rise per metre travelled, so anything else makes the same
// rise into a different slope depending on how long the street it falls on
// happens to be.
export const LAYOUTS = {
  folsom: {
    id: 'folsom',
    name: TRACK_NAME,
    loop: [
      [0, 0], [5, 0], [5, 2], [8, 2], [8, 5], [6, 7],
      [2, 7], [2, 9], [-3, 9], [-3, 5], [-1, 3], [-1, 0],
    ],
    elevation: [
      [0.00, 0.8], [0.10, 1.0], [0.24, 12], [0.40, 26], [0.52, 30],
      [0.62, 28], [0.74, 15], [0.88, 4], [0.96, 1.2],
    ],
  },

  // Stage two: an open route across the whole city to the Golden Gate on-ramp.
  //
  // Not a lap. It starts down on the eastern waterfront, winds west and north
  // through eighteen junctions, climbs over the hill and comes out on the
  // headland with the bridge dead ahead — and it never crosses itself, so the
  // road in front of you is always road you have not driven.
  //
  // It was a closed loop driven four fifths of the way round, which is the
  // cheap way to get a long route out of code that assumes a lap. It reads as
  // one, too: the road bends back toward where it started, and the ramp has to
  // stand wherever the loop happens to pass rather than where the bridge is.
  run: {
    id: 'run',
    // Named for what it is — the length of the city, east to west — rather
    // than for what it ends at. It shared a name with the bridge stage, which
    // made two entirely different stages read as the same one everywhere the
    // name is shown.
    name: 'CROSSTOWN',
    closed: false,
    loop: [
      [9, -6], [2, -6], [2, -2], [6, -2], [6, 2], [1, 2],
      [1, 6], [5, 6], [5, 10], [-1, 10], [-1, 5], [-5, 5],
      [-5, 1], [-9, 1], [-9, 6], [-6, 6], [-6, 10], [-11, 10],
    ],
    // Slid east of where its own bounding box would centre it, so the far end
    // comes out the right distance from the bridge for the on-ramp to climb.
    // The bridge is fixed scenery in world coordinates; the city is the thing
    // that can move.
    offset: { x: 250, z: -30 },
    // A bigger world than the circuit needs. The route is a kilometre across
    // and the ground plane has to reach past the far side of it, or the city
    // ends in mid-air a block after the last junction.
    world: 2600,
    // Moved and turned to face the route's exit, so the on-ramp climbs onto
    // the deck rather than alongside it.
    //
    // Placed so the deck's near end lands about three hundred and eighty
    // metres past where the road runs out. That number is the on-ramp: any
    // closer and it is a wall, any further and it is a flat grey strip you
    // cannot tell from the street — which is what it was at seven hundred,
    // climbing four metres over the whole of it. At this distance it climbs
    // twenty-four, which reads as a ramp from the road, and the near tower
    // stands a couple of hundred metres beyond the top of it.
    bridge: { x: -1078, z: 330, ang: 0 },
    // Down at the water, up over the hill, and down again to the approach.
    // Not all the way down: the deck is thirty-four metres up and a ramp that
    // has to find all of that from sea level is a wall.
    elevation: [
      [0.00, 1.5], [0.08, 3], [0.18, 18], [0.30, 34], [0.42, 46],
      [0.52, 40], [0.62, 20], [0.72, 14], [0.86, 12], [1.00, 10],
    ],
  },

  // Stage three: the bridge itself.
  //
  // Six lanes, two miles of it, a hundred metres over the water. Nearly
  // straight — a bridge is — with one shallow kink at mid-span so it is not a
  // ruler, and a deck that arcs the way a suspended one does.
  //
  // `deck` turns off everything a street has and turns on everything a bridge
  // has: no blocks, no side streets, no blockades, no pavements full of
  // furniture; towers, cables, hangers, railings and open water instead.
  bridge: {
    id: 'bridge',
    name: 'THE GOLDEN GATE',
    closed: false,
    deck: true,
    width: 21.6,                 // six lanes at 3.6 m
    lane: 3.6,                   // and marked as six
    // Eleven kilometres of it. Long enough that the far end is over the
    // horizon from the near one, which is the point: a bridge you can see the
    // end of from the start is a bridge you are already across.
    world: 12000,
    // You can see a long way over water at night, and everything worth seeing
    // out here is a light. Far enough that both towers are in view from
    // mid-span; close enough that the far end of the deck still fades out
    // rather than ending in mid-air.
    fog: { near: 200, far: 3400, colour: 0x121826 },
    loop: [
      [-105, 0], [-70, 0.5], [-35, 0.9], [0, 1.0],
      [35, 0.9], [70, 0.5], [105, 0],
    ],
    // The deck rises to mid-span and falls away again, which is the shape a
    // suspended span actually takes — and comes DOWN at both ends, because a
    // bridge that begins at thirty-four metres begins in mid-air.
    elevation: [
      [0.00, 7], [0.05, 22], [0.12, 36], [0.30, 44], [0.50, 46],
      [0.70, 44], [0.88, 36], [0.95, 22], [1.00, 7],
    ],
    // Where the land is: a fraction along the route, a radius, and how much
    // city stands on it. San Francisco at the near end and a great deal more
    // of Oakland at the far one — which is the right way round, and which is
    // also what tells you at a glance which way you are going.
    land: [
      { at: 0, r: 520, town: 0.75, tall: 0.30 },
      { at: 1, r: 900, town: 1.0, tall: 0.22 },
    ],
  },
};

// Give a built track back.
//
// Materials are the trap. Most of the geometry in here is drawn with the three
// vertex-coloured materials out of meshkit, and those are module singletons
// shared with the cars — disposing one while tearing a track down leaves every
// car in the game drawn with a disposed program. So the shared ones are named
// and skipped, and only materials this track made for itself are released.
const SHARED_MATERIALS = new Set([VC_MATERIAL, VC_MATERIAL_DS, VC_UNLIT]);

export function disposeTrack(scene, track) {
  if (!track || !track.group) return;
  scene.remove(track.group);
  track.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const m = o.material;
    if (!m) return;
    for (const one of Array.isArray(m) ? m : [m]) {
      if (!SHARED_MATERIALS.has(one)) one.dispose();
    }
  });
  track.group = null;
}

export class Track {
  constructor(layout = LAYOUTS.folsom) {
    this.layout = layout;
    // Closed unless the layout says otherwise.
    //
    // Everything here was written for a lap: the centreline wraps, distance
    // along the road is modulo its length, the racing line relaxes round a
    // ring and the speed profile makes two circular passes over it. An open
    // route is the same code with the wrap replaced by a clamp — which is what
    // `_w` is — plus a handful of places where the first and last samples have
    // no neighbour and the loop has to stop one short instead of coming round.
    this.closed = layout.closed !== false;
    // Centred on the origin. The ground plane, the fog, the sky dome and the
    // landmarks across the bay are all built around 0,0, and a grid written
    // from a corner is not — so move the grid rather than every one of them.
    const raw = layout.loop.map(([c, r]) => ({ x: c * PITCH_X, z: r * PITCH_Z }));
    const cx = (Math.min(...raw.map((j) => j.x)) + Math.max(...raw.map((j) => j.x))) / 2;
    const cz = (Math.min(...raw.map((j) => j.z)) + Math.max(...raw.map((j) => j.z))) / 2;
    const off = layout.offset || { x: 0, z: 0 };
    this.junctions = raw.map((j) => ({ x: j.x - cx + off.x, z: j.z - cz + off.z }));
    // Read by the results panel, which used to sniff `constructor.name` and
    // compare it against a circuit name that no longer matched anything.
    this.name = layout.name;
    this.origin = { cx, cz };            // so the blocks can be laid on the same grid
    this._sample();
    this._buildRacingLine();
    this._buildSpeedProfile();
    this._grid();
    this._hash();
    this._groundIndex();
    // After the spatial hash, not before: laying out the side streets asks
    // locate() where the circuit is, and locate() cannot answer until the hash
    // it searches exists.
    // A bridge has no side streets, and therefore none of what `_sideStreets`
    // sets up on its way: the junction boxes the road surfacing lays its plus
    // shapes from, and the lists everything downstream iterates. Empty rather
    // than absent, so nothing has to ask whether they exist.
    if (!layout.deck) this._sideStreets();
    else { this.streets = []; this.stubs = []; this.boxes = []; }
    // The ramp's footprint, worked out before anything is built so the city
    // can be told to leave room for it. Buildings go up first and the ramp
    // last, and a deck that climbs over the rooftops looks exactly as wrong
    // going THROUGH one as you would expect.
    this.rampPlan = (layout.ramp || (!this.closed && !layout.deck)) ? this._rampPlan() : null;
    // How far the city reaches: the centre of the route and the furthest any
    // of it gets from that centre. The water is put outside this, rather than
    // outside a distance from the nearest ROAD — see `_bayAt`.
    {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of this.samples) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      const cx2 = (minX + maxX) / 2, cz2 = (minZ + maxZ) / 2;
      let r = 0;
      for (const p of this.samples) r = Math.max(r, Math.hypot(p.x - cx2, p.z - cz2));
      this.extent = { x: cx2, z: cz2, r };
    }
  }

  // Where the deck goes.
  //
  // Two shapes for two kinds of stage. On a lap the route ends partway round,
  // so the ramp peels off the side of the street and climbs away over the
  // rooftops — it is a place to arrive at, and it stops in mid-air because
  // nothing past the finish is ever seen from the road.
  //
  // On a route it is an ON-RAMP: it starts where the road runs out, turns onto
  // the bearing of the bridge, and climbs until it meets the deck. Which means
  // its length is not a constant — it is however far the bridge is, and its
  // grade is however much height that leaves to find.
  _rampPlan() {
    const open = !this.closed;
    const at = open ? this.length : this.layout.ramp * this.length;
    const p = this.atDistance(at);
    const segs = [];

    let n = RAMP.segments, seg = RAMP.seg, rise = RAMP.rise, bend = RAMP.bend;
    let turn = 0;
    if (open) {
      // Aim at the near end of the deck, and work out what it takes to get up
      // to it. `ang` is the deck's own bearing, so its near end is the centre
      // stepped back along it toward the city.
      const B = this.layout.bridge || { x: -560, z: 330, ang: 0.7 };
      const bdx = Math.cos(B.ang), bdz = Math.sin(B.ang);
      const half = BRIDGE_DECK / 2;
      const e1 = { x: B.x + bdx * half, z: B.z + bdz * half };
      const e2 = { x: B.x - bdx * half, z: B.z - bdz * half };
      const near = (e1.x - p.x) ** 2 + (e1.z - p.z) ** 2 < (e2.x - p.x) ** 2 + (e2.z - p.z) ** 2
        ? e1 : e2;
      const dx = near.x - p.x, dz = near.z - p.z;
      const dist = Math.hypot(dx, dz);
      // Everything but the last twenty metres, so the deck stops short of the
      // bridge rather than inside its end.
      const reach = Math.max(60, dist - 20);
      n = Math.max(6, Math.round(reach / RAMP.seg));
      seg = reach / n;
      rise = (BRIDGE_DECK_Y - p.y) / reach;
      // The whole turn onto the bearing, spread over the first third of it.
      const want = Math.atan2(dx, dz);
      const have = Math.atan2(p.dirX, p.dirZ);
      let d = want - have;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      turn = d;
      bend = 0;
    }

    let cx = p.x, cz = p.z, cy = p.y + 0.15, ang = 0;
    for (let i = 0; i < n; i++) {
      if (open) {
        // Eased onto the bearing over the first third, then dead straight at
        // the bridge for the rest of the climb.
        const k = clamp((i + 0.5) / (n / 3), 0, 1);
        ang = turn * k * k * (3 - 2 * k) / 1;
      } else {
        ang += bend;
      }
      const dx = p.dirX * Math.cos(ang) + p.nx * Math.sin(ang);
      const dz = p.dirZ * Math.cos(ang) + p.nz * Math.sin(ang);
      segs.push({
        x: cx + dx * seg * 0.5,
        z: cz + dz * seg * 0.5,
        y: cy + rise * seg * 0.5,
        dx, dz, yaw: Math.atan2(dx, dz), i,
      });
      cx += dx * seg; cz += dz * seg; cy += rise * seg;
    }
    return { at, x: p.x, y: p.y, z: p.z, segs, seg, rise, open };
  }

  // An index into an array of N, wrapped on a lap and clamped on a route.
  // The one place the difference between the two lives.
  _w(i, N) {
    if (this.closed) return ((i % N) + N) % N;
    return i < 0 ? 0 : (i >= N ? N - 1 : i);
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
    // On a route the two end junctions have nothing on one side of them to
    // turn from or into, so they are kept as they are and everything between
    // is filleted exactly as on a lap.
    if (!this.closed) out.push({ x: J[0].x, z: J[0].z });
    const lo = this.closed ? 0 : 1;
    const hi = this.closed ? n : n - 1;
    for (let i = lo; i < hi; i++) {
      const a = J[this._w(i - 1, n)], b = J[i], c = J[this._w(i + 1, n)];
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
    if (!this.closed) out.push({ x: J[n - 1].x, z: J[n - 1].z });

    // Subdivide the straights, so the fine polyline is dense enough for the
    // arc-length resampling that follows to land where it means to.
    const dense = [];
    const segs = out.length - (this.closed ? 0 : 1);
    for (let i = 0; i < segs; i++) {
      const a = out[i], b = out[this._w(i + 1, out.length)];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      const k = Math.max(1, Math.round(d / 1.2));
      for (let j = 0; j < k; j++) {
        dense.push({ x: lerp(a.x, b.x, j / k), z: lerp(a.z, b.z, j / k), y: 0, width: 0 });
      }
    }
    if (!this.closed) {
      const e = out[out.length - 1];
      dense.push({ x: e.x, z: e.z, y: 0, width: 0 });
    }

    // Width: the plain street, opening out at every junction.
    //
    // Held at the full junction width out past where the junction draws its
    // own surface, and only then tapered back. A width that starts narrowing
    // immediately would leave the road narrower than the plus arm it has to
    // meet, and the two would not line up at the seam.
    const baseWidth = this.layout.width || DEFAULT_WIDTH;
    for (const q of dense) {
      let w = baseWidth;
      // A bridge has no junctions to open out at.
      if (this.layout.deck) { q.width = w; continue; }
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
      const a = dense[i], b = dense[this._w(i + 1, dense.length)];
      a.d = Math.hypot(b.x - a.x, b.z - a.z);
      a.at = total;
      total += a.d;
    }
    for (const q of dense) {
      const f = q.at / total;
      const E = this.layout.elevation;
      let y = E[0][1];
      for (let k = 0; k < E.length; k++) {
        const [f0, y0] = E[k];
        // Past the last control point a lap comes back round to its first
        // height, because it has to meet itself. A route does not: it ends
        // where it ends, and pulling it back down to its starting height would
        // put the on-ramp underwater.
        const [f1, y1] = k + 1 < E.length ? E[k + 1] : [1, this.closed ? E[0][1] : E[E.length - 1][1]];
        if (f >= f0 && f <= f1) { y = lerp(y0, y1, (f - f0) / (f1 - f0 || 1)); break; }
      }
      q.y = y;
    }
    // Smoothing passes over the height, weighted by spacing, so the joins
    // between the elevation control points are not creases.
    for (let pass = 0; pass < 30; pass++) {
      const next = dense.map((q, i) => {
        const a = dense[this._w(i - 1, dense.length)];
        const b = dense[this._w(i + 1, dense.length)];
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
      const a = fine[i], b = fine[this._w(i + 1, fine.length)];
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
      const a = fine[fi], b = fine[this._w(fi + 1, fine.length)];
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
      const p0 = this.samples[this._w(i - K, N)];
      const p1 = this.samples[i];
      const p2 = this.samples[this._w(i + K, N)];
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
      for (let i = 0; i < N - (this.closed ? 0 : 1); i++) {
        const a2 = this.samples[i], b2 = this.samples[this._w(i + 1, N)];
        const lim = Math.min(cap[i], cap[this._w(i + 1, N)]);
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
      const p0 = this.samples[this._w(i - K, N)];
      const p1 = this.samples[i];
      const p2 = this.samples[this._w(i + K, N)];
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
    if (this.closed) {
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

  at(index) { return this.samples[this._w(index, this.samples.length)]; }

  // The sample nearest a distance along the road — wrapping round on a lap,
  // and held at the two ends on a route, where there is nothing beyond them.
  atDistance(s) {
    const n = this.samples.length;
    const d = this.closed ? ((s % this.length) + this.length) % this.length : clamp(s, 0, this.length);
    return this.samples[this._w(Math.round(d / this.step), n)];
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
        const a = this.samples[this._w(i - W, N)], b = this.samples[i], c = this.samples[this._w(i + W, N)];
        const oa = off[this._w(i - W, N)], oc = off[this._w(i + W, N)];
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
        this.line[this._w(i - 1, N)].offset + p.offset * 2 + this.line[this._w(i + 1, N)].offset) / 4);
      for (let i = 0; i < N; i++) {
        const b = this.samples[i];
        this.line[i].offset = sm[i];
        this.line[i].x = b.x + sm[i] * b.nx;
        this.line[i].z = b.z + sm[i] * b.nz;
      }
    }
    for (let i = 0; i < N; i++) {
      const C = Math.max(2, Math.round(15 / this.step));
      const p0 = this.line[this._w(i - C, N)], p1 = this.line[i], p2 = this.line[this._w(i + C, N)];
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
    // The two passes stop one short of the ends on a route. There is nothing
    // past the last sample to brake for — it is a ramp onto a bridge — and
    // nothing before the first to have accelerated from.
    const lo = this.closed ? 0 : 1;
    const hi = this.closed ? N : N - 1;
    for (let pass = 0; pass < 3; pass++) {
      for (let k = hi - 1; k >= 0; k--) {
        const i = k, j = this._w(i + 1, N);
        const d = this.step;
        const cap = Math.sqrt(v[j] * v[j] + 2 * brakeG * 9.81 * d);
        if (v[i] > cap) v[i] = cap;
      }
      for (let k = lo; k < N; k++) {
        const i = k, j = this._w(i - 1, N);
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
      s: this.closed
        ? (p.s + along + this.length) % this.length
        : clamp(p.s + along, 0, this.length),
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
    //
    // On a lap the line is at s = 0 and the grid is in the ninety metres
    // before it, which is the end of the sample array. A route has no road
    // before its start, so the line moves forward instead — far enough in that
    // the whole grid fits on the road ahead of the first metre of it.
    const line = this.closed ? this.length : GRID_RUNUP;
    this.gridSlots = [];
    for (let i = 0; i < 16; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? 1 : -1;
      const s = (line - 26) - row * 8.5;
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
    const start = this.atDistance(this.closed ? 0 : line);
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
    const WORLD = this.layout.world || 1800;
    // Segments scale with the world, so a bigger map is not a coarser one —
    // eight metres a quad either way, which is what the road's own kerbs are
    // built to. Except over water, which is flat: an eleven-kilometre bay at
    // eight metres a quad is two million vertices of dead level blue.
    // Over water the field is a formula rather than a search, so a finer mesh
    // costs almost nothing — and it has to be finer than the swell it carries
    // or the swell is invisible. Forty-eight segments over twelve kilometres
    // is a quarter-kilometre a quad, which is a flat sheet however it is
    // coloured: a blank canvas with a bridge on it.
    const SEG = this.layout.deck ? 420 : Math.round(220 * (WORLD / 1800));
    const groundGeo = new THREE.PlaneGeometry(WORLD, WORLD, SEG, SEG);
    groundGeo.rotateX(-Math.PI / 2);
    {
      const pos = groundGeo.attributes.position;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i);
        // The city floor: it stays with the circuit near the road and then
        // keeps climbing away from it, because the hills here do not stop at
        // the kerb. Beyond the far edge it drops away to the bay.
        //
        // Through the index, not by sweeping the samples: this loop runs for
        // every one of forty-eight thousand vertices, and doing it the direct
        // way here cost as much again as the `groundAt` below — which needs
        // the same number and gets it the same cheap way.
        const dist = Math.sqrt(this._nearestSample(x, z).d2);
        const bay = this._bayAt(x, z);
        // Height first, then colour: the deck branch below returns early, and
        // with the height set after it the water came out perfectly flat and
        // beautifully shaded, which is a lit sheet of paper.
        pos.setY(i, this.groundAt(x, z));
        if (this.layout.deck) {
          const w = waterColour(x, z, clamp(1 - dist / 420, 0, 1));
          // The landfalls are towns, not sea. Colouring the whole plane as
          // water and then standing a city on it leaves the city on black
          // ground — which from two miles out is a skyline floating in a void.
          const k = this.layout.land ? this.landAt(x, z) : 0;
          if (k <= 0.01) {
            col[i * 3] = w[0]; col[i * 3 + 1] = w[1]; col[i * 3 + 2] = w[2];
            continue;
          }
          const n2 = Math.sin(x * 0.021 + z * 0.013) * Math.cos(z * 0.017 - x * 0.011) * 0.5 + 0.5;
          const block = (Math.floor(x / 34) + Math.floor(z / 34)) % 2 ? 0.05 : 0;
          const g2 = 0.24 + n2 * 0.08 + block;
          col[i * 3] = lerp(w[0], g2 * 0.98, k);
          col[i * 3 + 1] = lerp(w[1], g2 * 0.96, k);
          col[i * 3 + 2] = lerp(w[2], g2 * 0.92, k);
          continue;
        }
        // Blocks of city, read as a grid of paving and rooftops, going blue
        // where the streets run out and the water starts.
        const block = (Math.floor(x / 34) + Math.floor(z / 34)) % 2 ? 0.06 : 0;
        const n = Math.sin(x * 0.021 + z * 0.013) * Math.cos(z * 0.017 - x * 0.011) * 0.5 + 0.5;
        const g = 0.30 + n * 0.10 + block;
        // ...but only where there IS city. Past a hundred metres or so from
        // any road there are no more buildings, and the paving grid carried on
        // regardless: a pale grey plain stretching to the waterline, which
        // from the on-ramp — where the headland is deliberately cleared so the
        // bridge can be seen — is several hundred metres of blank canvas.
        //
        // Out there it is headland: scrub and rock, dark, with the same noise
        // breaking it up so it is not a flat colour either.
        const wild = clamp((dist - 95) / 150, 0, 1);
        const scrub = 0.055 + n * 0.045;
        // The bay was a flat blue — one colour over everything past the
        // shoreline, which from anywhere with a view is a blank canvas with a
        // city sitting on it. It is the same water as the sea under the
        // bridge, so it gets the same treatment: swell, chop and a sheen that
        // picks up the city behind it.
        const w = bay;
        const sea = waterColour(x, z, clamp(1 - (dist - 340) / 500, 0, 1));
        // Paving near the roads, scrub away from them, water past the shore.
        const land = [
          lerp(g * 0.98, scrub * 1.05, wild),
          lerp(g * 0.96, scrub * 1.30, wild),
          lerp(g * 0.92, scrub * 0.80, wild),
        ];
        col[i * 3] = land[0] * (1 - w) + sea[0] * w;
        col[i * 3 + 1] = land[1] * (1 - w) + sea[1] * w;
        col[i * 3 + 2] = land[2] * (1 - w) + sea[2] * w;
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
      // (On a six-lane deck the same pass runs; what changes is how many
      // dashed lines fit between the edges, which falls out of the width.)
      quad(p, q, [0.78, 0.78, 0.75], -hw0 + 0.18, -hw0 + 0.34, -hw1 + 0.18, -hw1 + 0.34, 0.03);
      quad(p, q, [0.78, 0.78, 0.75], hw0 - 0.34, hw0 - 0.18, hw1 - 0.34, hw1 - 0.18, 0.03);

      // The double yellow down the centre: two lines with a gap, which is what
      // tells you at a glance which way the traffic on each side is going.
      //
      // Not on the bridge. All six lanes there run the same way — the traffic
      // on it is going where you are going — and a double yellow down the
      // middle of a one-way roadway says the opposite of what is true, which
      // matters on the one stage where which lane is free is the whole game.
      if (this.layout.deck) {
        quad(p, q, [0.74, 0.74, 0.72], -0.09, 0.09, -0.09, 0.09, 0.031);
      } else {
        const YEL = [0.76, 0.60, 0.13];
        quad(p, q, YEL, -0.30, -0.16, -0.30, -0.16, 0.031);
        quad(p, q, YEL, 0.16, 0.30, 0.16, 0.30, 0.031);
      }

      // Dashed white lane lines, one at every lane boundary that fits. Three
      // metres of paint, six of gap.
      //
      // Every boundary, not just the first: a six-lane bridge deck marked as a
      // two-lane street is eleven metres of unbroken asphalt either side of the
      // centre, and nothing about it tells you where the lanes are — which on
      // the one stage with traffic in it is the only information that matters.
      const lane = this.layout.lane || LANE;
      if (i % 9 < 3) {
        for (let k = 1; k * lane < hw0 - 0.6; k++) {
          for (const sd of [-1, 1]) {
            quad(p, q, [0.74, 0.74, 0.72], sd * k * lane - 0.07, sd * k * lane + 0.07,
              sd * k * lane - 0.07, sd * k * lane + 0.07, 0.030);
          }
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
    // ...but there are no junctions on a bridge, and a zebra crossing across
    // six lanes a hundred metres over the water is the single most obviously
    // wrong thing that can be painted on one.
    for (let i = 0; !this.layout.deck && i < N; i += 47) {
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
        return { x, z, nx, nz, y: this.streetY(t, d) };
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
        return { x, z, nx, nz, y: this.streetY(t, d) };
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
    if (this.rampPlan) { this._buildRamp(group); yield 'the ramp'; }
    this.group = group;
    return group;
  }

  // The freeway ramp a run ends at.
  //
  // A deck that leaves the street at the finish, climbs away over the roofs
  // and stops in mid-air, on pillars, with a sign over the road in front of
  // it. Stopping in mid-air is deliberate: the stage ends the moment you reach
  // it, so nothing past that point is ever seen from anywhere but the sky, and
  // a kilometre of freeway built to be driven off the end of is a kilometre of
  // freeway nobody drives.
  //
  // It is scenery, not road. The wall the car stops at is a lateral distance
  // from the CIRCUIT and nothing here changes it, so the ramp cannot be driven
  // up — it is the thing you arrive at, which is the whole of what the stage
  // asks for.
  _buildRamp(group) {
    const plan = this.rampPlan;
    const b = new MeshBuilder();
    const W = RAMP.width;
    const pitch = -Math.atan(plan.rise);
    const LEN = plan.seg;

    for (const g of plan.segs) {
      b.add(G.box(W, 0.9, LEN), 0x4b5058, { x: g.x, y: g.y, z: g.z, ry: g.yaw, rx: pitch });
      // Parapets down both edges. The offset is across the deck, which is the
      // segment's direction turned a quarter turn — not the street's.
      for (const side of [-1, 1]) {
        b.add(G.box(0.5, 1.1, LEN), 0xd8d4c8, {
          x: g.x + (-g.dz * side) * (W / 2 - 0.25),
          y: g.y + 0.9,
          z: g.z + (g.dx * side) * (W / 2 - 0.25),
          ry: g.yaw, rx: pitch,
        });
      }
      // A pillar under every other one, standing on whatever the ground does
      // there rather than on a guess at it.
      if (g.i % 2 === 1) {
        const ground = this.groundAt(g.x, g.z);
        const h = Math.max(1, g.y - 0.45 - ground);
        b.add(G.box(2.2, h, 2.2), 0xb9b4a6, { x: g.x, y: ground + h / 2, z: g.z, ry: g.yaw });
        b.add(G.box(3.4, 0.7, 3.4), 0xa9a496, { x: g.x, y: ground + 0.35, z: g.z, ry: g.yaw });
      }
    }

    // A gantry across the street ahead of it, with a sign slung between the
    // legs. Set back so a car arriving at speed sees the sign against the deck
    // rather than through it.
    const g0 = this.atDistance(plan.at - (plan.open ? 90 : 46));
    const gy = g0.y;
    const half = (g0.width || DEFAULT_WIDTH) / 2 + 2.4;
    for (const side of [-1, 1]) {
      b.add(G.box(0.7, 7.2, 0.7), 0x6f7580,
        { x: g0.x + g0.nx * side * half, y: gy + 3.6, z: g0.z + g0.nz * side * half });
    }
    const yaw = Math.atan2(g0.dirX, g0.dirZ);
    b.add(G.box(half * 2, 0.5, 0.5), 0x6f7580, { x: g0.x, y: gy + 7.1, z: g0.z, ry: yaw });
    group.add(b.build());

    // The sign panel, lit. Green with white bands, which at night is one of
    // the few things in a city genuinely brighter than the street around it —
    // unlit and above one, so the bloom chain finds it.
    const sign = new MeshBuilder();
    sign.add(G.box(7.0, 2.4, 0.16), 0x1c6b3a, { x: g0.x, y: gy + 5.6, z: g0.z, ry: yaw });
    sign.add(G.box(6.2, 0.34, 0.22), 0xf4f6f8, { x: g0.x, y: gy + 6.3, z: g0.z, ry: yaw });
    sign.add(G.box(2.6, 0.5, 0.22), 0xf4f6f8, { x: g0.x, y: gy + 5.2, z: g0.z, ry: yaw });
    group.add(sign.build(VC_UNLIT));

    this.ramp = { x: plan.x, y: plan.y, z: plan.z, at: plan.at };
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
    // On a bridge the thing that stops you is the railing, which is at the
    // edge of the deck — not a building line ten metres past a pavement that
    // is not there. Drive at it and you bounce off it; there is nothing on the
    // other side but a hundred metres of air.
    this.barrierOffset = this.layout.deck ? 0.5 : 5.6;
    this.wall = this.layout.deck ? 1.2 : this.barrierOffset + 3.9;
    this.props = [];
    this.breakables = [];

    // None of what follows belongs on a bridge.
    //
    // What follows is street works: cones across the mouth of a closed side
    // street, a piece of plant with a beacon on it, and an amber arrow board
    // at every corner telling you which way the road bends. A bridge has no
    // side streets to close, and its corners are one-degree kinks in a deck
    // that goes one way — so what it got was a row of construction signs
    // standing out in the bay beside it, pointing at nothing.
    if (this.layout.deck) return;

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
  // The smooth half of the ground field.
  //
  // A weighted blend of every sample within forty metres plus the hills, with
  // no reference to the NEAREST sample — so it is continuous everywhere, which
  // `groundAt` is deliberately not: close to the road that follows
  // `locate().y`, and `locate` jumps wherever the nearest piece of circuit
  // changes from one leg of the lap to another. That is right for the ground
  // beside the road and wrong for anything laid across the city, which is why
  // the side streets take their height from here.
  smoothGroundAt(x, z) {
    // Inverse-square weighted over EVERY sample, with no cutoff.
    //
    // `groundAt` blends only what is within forty metres and falls back to the
    // nearest sample's height when nothing is — and that fallback is the
    // discontinuity all over again, just moved further out. It does not show
    // in the terrain, where the hills dominate at that range, but a side
    // street a hundred and thirty metres from the circuit lives entirely in
    // the fallback, and a twenty-six metre jump in it survives forty passes of
    // smoothing as a two-metre step in the road.
    //
    // Weighting every sample by 1/(d² + k) has no cutoff to fall off, so it is
    // continuous everywhere by construction. It costs the same: one pass over
    // the samples either way.
    let wsum = 0, ysum = 0;
    for (const p of this.samples) {
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      const w = 1 / (d + 900);          // k = 30 m, so nearby samples dominate
      wsum += w;
      ysum += p.y * w;
    }
    const near = ysum / wsum;
    const dist = Math.sqrt(this._nearestSample(x, z).d2);
    const fall = clamp((dist - 22) / 300, 0, 1);
    const hill = Math.sin(x * 0.0052) * Math.cos(z * 0.0061) * 26 + Math.sin(z * 0.0091) * 11;
    const bay = clamp((dist - 340) / 200, 0, 1);
    return (near - 1.1) + hill * fall * fall * (1 - bay) - bay * (near + 6);
  }

  // A second index over the samples, coarser than the one `locate` uses.
  //
  // `locate` buckets at 24 m and spreads each sample over a 3x3 block, so one
  // lookup gives everything within 24 m — which is right for finding the piece
  // of road a car is on and not enough for the ground field, which blends over
  // forty and needs the distance to the nearest sample out to five hundred.
  //
  // What this stores is the OCCUPIED cells, as a flat list with their centres.
  // A ring search outward from the query point is the obvious structure and
  // the wrong one here: most of the world is empty, the circuit occupies about
  // ninety cells of it, and a point in the far corner makes a ring search walk
  // hundreds of cells that were never going to contain anything. Ninety
  // distances to ninety cell centres is less work than that, and it bounds the
  // answer exactly: no sample in a cell can be nearer than its centre less the
  // cell's half-diagonal, or further than its centre plus it.
  _groundIndex() {
    this.gcell = GROUND_R;
    // Keyed by string and read back as objects. Packing (cx, cz) into one
    // integer and unpacking it again is where this went wrong the first time:
    // the obvious `cx * 4096 + cz` is not invertible for negative cz, and half
    // the city is at negative z. The cell keeps its own centre instead, so
    // nothing has to be decoded at all.
    const by = new Map();
    this.gcells = [];
    for (const p of this.samples) {
      const cx = Math.floor(p.x / this.gcell), cz = Math.floor(p.z / this.gcell);
      const k = `${cx},${cz}`;
      let cell = by.get(k);
      if (!cell) {
        cell = { x: (cx + 0.5) * this.gcell, z: (cz + 0.5) * this.gcell, list: [], y: 0 };
        by.set(k, cell);
        this.gcells.push(cell);
      }
      cell.list.push(p);
    }
    // Each cell's mean height, and where its samples actually sit — the
    // centroid, not the cell's geometric centre. A cell clipped by a road
    // running through one corner of it has all its samples in that corner, and
    // lumping them at the middle of the square moves the terrain twenty metres
    // sideways from the road it is supposed to follow.
    for (const c of this.gcells) {
      let sx = 0, sz = 0, sy = 0;
      for (const p of c.list) { sx += p.x; sz += p.z; sy += p.y; }
      c.x = sx / c.list.length;
      c.z = sz / c.list.length;
      c.y = sy / c.list.length;
      c.n = c.list.length;
    }
    this._gd = new Float64Array(this.gcells.length);
  }

  // Squared distance to every occupied cell centre, kept for the two readers
  // below so the pass is done once per query rather than once per reader.
  // Squared, and compared squared, so the inner loop takes no square roots —
  // this is the pass that runs for every one of fifty thousand ground
  // vertices and ninety avoidable roots each is most of its cost.
  _cellDistances(x, z) {
    const cells = this.gcells, d = this._gd;
    let best = Infinity;
    for (let i = 0; i < cells.length; i++) {
      const dx = cells[i].x - x, dz = cells[i].z - z;
      const q = dx * dx + dz * dz;
      d[i] = q;
      if (q < best) best = q;
    }
    return best;
  }

  // The nearest sample to a point, exactly.
  //
  // The distance to it matters a long way out — the hills fade in over three
  // hundred metres of it and the bay over two hundred more — so this cannot
  // stop at the blend radius the way the blend does.
  _nearestSample(x, z, bestCell = null) {
    const cells = this.gcells, d = this._gd;
    const bc = bestCell === null ? this._cellDistances(x, z) : bestCell;
    // The nearest sample is at most a half-diagonal beyond the nearest cell
    // centre, so no cell whose centre is further than that plus another
    // half-diagonal can hold it.
    const cut = Math.sqrt(bc) + this.gcell * Math.SQRT2;
    const cut2 = cut * cut;
    let best = null, bestD = Infinity;
    for (let i = 0; i < cells.length; i++) {
      if (d[i] > cut2) continue;
      for (const p of cells[i].list) {
        const q = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
        if (q < bestD) { bestD = q; best = p; }
      }
    }
    return { p: best || this.samples[0], d2: bestD };
  }

  // A continuous height field over the whole world.
  //
  // Every occupied cell, weighted by how many samples are in it and by the
  // inverse square of its distance — so nearby road dominates, distant road
  // contributes a little, and nothing ever switches on or off. There is no
  // cutoff to fall off the edge of, which is the whole point: this is what
  // gets used where the blend radius finds nothing, and a fallback with a
  // discontinuity in it is not a fallback, it is the bug moved further out.
  //
  // Cells rather than samples, so it costs a pass over about a hundred of them
  // instead of several thousand. Lumping a cell at its centroid makes the
  // field slightly coarser than a per-sample version and exactly as smooth,
  // and it is only ever read beyond thirty-four metres, where the road's own
  // height has already stopped being followed.
  _fieldAt(x, z) {
    const cells = this.gcells;
    let wsum = 0, ysum = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const dx = c.x - x, dz = c.z - z;
      const w = c.n / (dx * dx + dz * dz + 900);      // k = 30 m
      wsum += w;
      ysum += c.y * w;
    }
    return wsum > 0 ? ysum / wsum : 0;
  }

  // How much of this point is water.
  //
  // Outside the CITY, not away from the nearest road. It used to be the
  // second: three hundred and forty metres from any piece of tarmac and the
  // ground turned into bay — which is right at the edge of a compact circuit
  // and wrong the moment a route weaves, because the middle of a large block
  // is also three hundred and forty metres from any road. What that produced
  // was flat teal lakes lying among the rooftops at street level, one of them
  // straight down the road from the start of stage two.
  //
  // A bay is a thing the city stops at, so it is measured from how far the
  // city reaches.
  // How much land there is at a point on a deck layout: 1 at the middle of a
  // landfall, 0 out over the water. Smoothstepped, so the shoreline is a
  // beach rather than a step.
  landAt(x, z) {
    const land = this.layout.land;
    if (!land) return 0;
    let best = 0;
    for (const L of land) {
      const p = this._landAnchor(L);
      const d = Math.hypot(x - p.x, z - p.z);
      const k = clamp(1 - d / L.r, 0, 1);
      best = Math.max(best, k * k * (3 - 2 * k));
    }
    return best;
  }

  _landAnchor(L) {
    if (!L._at) {
      const p = this.atDistance(clamp(L.at, 0, 1) * this.length);
      L._at = { x: p.x, z: p.z, y: p.y };
    }
    return L._at;
  }

  _bayAt(x, z) {
    if (this.layout.deck) return 1 - this.landAt(x, z);
    const e = this.extent;
    if (!e) return 0;
    const r = Math.hypot(x - e.x, z - e.z);
    return clamp((r - (e.r + BAY_MARGIN)) / BAY_FADE, 0, 1);
  }

  groundAt(x, z) {
    // Open water, if the road is a bridge. There is no city floor under a
    // suspended span — there is the bay, a hundred metres down.
    if (this.layout.deck) {
      const k = this.landAt(x, z);
      if (k <= 0) return SEA_Y + swell(x, z);
      // The shore rises to just under the road at the end it belongs to, and
      // falls back to the sea over the width of the landfall.
      const land = this.layout.land;
      let top = SEA_Y;
      for (const L of land) {
        const p = this._landAnchor(L);
        const d = Math.hypot(x - p.x, z - p.z);
        const kk = clamp(1 - d / L.r, 0, 1);
        const kkk = kk * kk * (3 - 2 * kk);
        top = Math.max(top, lerp(SEA_Y, p.y - KERB_DROP, kkk));
      }
      return lerp(SEA_Y + swell(x, z), top, k);
    }
    // The city floor, and the one number the terrain, the pavements, the
    // street furniture and every building in the place have to agree about.
    //
    // Three parts, and the whole difficulty is making the joins between them
    // invisible. Close to the road it follows the ROAD'S own height, because a
    // forty-metre average lags a six per cent street by more than the
    // clearance and the ground comes up through the asphalt. Further out it
    // follows the FIELD, which is smooth and continuous everywhere. Further
    // out still it climbs into the hills and then falls away to the bay.
    //
    // It used to have a fourth part, and that part was a bug: beyond forty
    // metres of every sample it took the height of whichever piece of road was
    // nearest, which is a Voronoi diagram. Every boundary between two stretches
    // was a cliff as tall as the difference between them — up to forty metres
    // on a route that climbs that far — and since most of the city is out
    // there, what you saw from the road was a flat pale wall standing across
    // the end of the street. There is no nearest-sample height in here now.
    const near = this._fieldAt(x, z);
    const dist = Math.sqrt(this._nearestSample(x, z).d2);
    const fall = clamp((dist - 22) / 300, 0, 1);
    const hill = Math.sin(x * 0.0052) * Math.cos(z * 0.0061) * 26 + Math.sin(z * 0.0091) * 11;
    const bay = this._bayAt(x, z);
    // Swell out over the water, fading in as the land runs out. Colouring a
    // flat plane as if it had waves on it works until the light rakes across
    // it, at which point it is a painting of the sea.
    const wide = (near - GROUND_FALL) + hill * fall * fall * (1 - bay)
      - bay * (near + 6) + bay * swell(x, z);

    // Close in, follow the road rather than the field. Blended out over the
    // twenty-two metres from the kerb, by which point the two agree anyway.
    //
    // A KERB below it, not a metre.
    //
    // A metre is what it was, and a metre is a plinth: the pavement is a flat
    // ribbon at road height reaching nine metres from the kerb, the buildings
    // start where it ends, and what stood between them was a metre-high step
    // down to bare ground running the length of every street. From inside the
    // city the road is on a plateau — which is exactly what "the road
    // levitates above the ground" means.
    //
    // The drop only ever needed to be enough that a coarse ground mesh cannot
    // interpolate its way up through the asphalt between two vertices, and
    // that is centimetres, not metres.
    const under = this.locate(x, z).y - KERB_DROP;
    const w = clamp((dist - 12) / 22, 0, 1);
    const blended = lerp(under, wide, w);

    // And hard-capped below the road, so no amount of interpolation can put
    // the terrain on top of it. The cap fades out too: a `min` that switches
    // off at a fixed distance is a step of exactly the size it was suppressing,
    // which is what put a four-metre wall in a ring around every street.
    const capW = clamp((dist - 16) / 18, 0, 1);
    return lerp(Math.min(blended, under), blended, capW);
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
    const street = (x, z, ux, uz, from, to, width, stem = false) =>
      this.streets.push({ x, z, ux, uz, from, to, width, stem });

    // The height of a side street, sampled and then smoothed.
    //
    // Taking it straight from `locate(x, z).y` — the height of the nearest
    // point of the CIRCUIT — is fine at the junction and wrong further out:
    // as the street runs away, the nearest circuit sample flips from one leg
    // of the lap to another, and the height jumps with it. On a hill that is a
    // visible step in the middle of a road, and it is visible from the racing
    // line.
    //
    // So sample it, then smooth it, pinning the junction end where it has to
    // meet the road it leaves.
    this._streetHeights = (t) => {
      const N = Math.max(8, Math.round((t.to - t.from) / 2.0));
      const y = [];
      // Shape from the terrain, datum from the road.
      //
      // Two things have to be true and they pull against each other: the
      // street must MEET the junction it leaves exactly, and it must not step
      // anywhere along its length. Taking the height straight from the circuit
      // (`locate().y`) satisfies the first and fails the second — the nearest
      // piece of circuit flips from one leg of the lap to another and the road
      // jumps twenty metres with it. Taking it from the smooth field satisfies
      // the second and fails the first, because an inverse-distance average
      // lags the road on a gradient and arrives three metres out.
      //
      // So take the SHAPE from the smooth field and the DATUM from the road:
      // anchor the whole profile so that it is exactly right at the anchor
      // point, then follow the terrain's gradient from there. Continuous
      // everywhere, and exact where it has to be.
      for (let i = 0; i <= N; i++) {
        const d = t.from + ((t.to - t.from) * i) / N;
        y.push(this.smoothGroundAt(t.x + t.ux * d, t.z + t.uz * d));
      }
      // Anchored where it has to MATCH, not where it starts.
      //
      // A stem nominally begins ten metres back inside the junction, but the
      // junction lays its own surface over the first eighteen — so the stem
      // only becomes visible at the edge of that, and that edge is the only
      // place the two have to agree. Anchoring at the nominal start instead
      // left thirty metres for the terrain's gradient to drift from the
      // road's, and on a hill that arrives at the seam nearly two metres out.
      // A bar is anchored at its middle, to the end of the stem running into
      // it, for the same reason: that is where they meet.
      const seamD = t.from + JUNCTION_OWNS + 2;
      const ai = t.stem
        ? Math.round(((seamD - t.from) / (t.to - t.from)) * N)
        : Math.round(N / 2);
      const anchor = t.stem
        ? this.locate(t.x + t.ux * seamD, t.z + t.uz * seamD).y
        : (t.parent ? this.streetY(t.parent, t.parent.to) : y[ai] + 1.1);
      const shift = anchor - y[ai];
      for (let i = 0; i <= N; i++) y[i] += shift;

      // A few passes to take the edge off, holding the anchor.
      for (let pass = 0; pass < 12; pass++) {
        const next = y.slice();
        for (let i = 1; i < N; i++) next[i] = (y[i - 1] + y[i + 1] + y[i] * 2) / 4;
        next[ai] = y[ai];
        for (let i = 0; i <= N; i++) y[i] = next[i];
      }
      t.heights = y;
      t.hN = N;
    };

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
      street(x, z, ux, uz, -10, reach, DEFAULT_WIDTH, true);
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
        // The bar takes its datum from the stem that runs into it.
        this.streets[this.streets.length - 1].parent = this.streets[this.streets.length - 2];
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

    // Stems first: a bar's datum is the end of the stem that runs into it.
    for (const t of this.streets) if (t.stem) this._streetHeights(t);
    for (const t of this.streets) if (!t.stem) this._streetHeights(t);
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
  // The smoothed height of a side street `d` metres along it.
  streetY(t, d) {
    if (!t.heights) return this.locate(t.x + t.ux * d, t.z + t.uz * d).y;
    const f = clamp((d - t.from) / (t.to - t.from), 0, 1) * t.hN;
    const i = Math.min(t.hN - 1, Math.floor(f));
    return lerp(t.heights[i], t.heights[i + 1], f - i);
  }

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
    if (this.layout.deck) {
      yield* this._buildDeck(group);
      return;
    }
    yield* this._buildCity(group);
  }

  // The bridge, as the road rather than as scenery.
  //
  // Everything here is hung off the route itself, so the structure follows
  // whatever shape the layout gives it: the truss under the deck, the railings
  // at its edge, two towers a quarter and three quarters along, the main cables
  // slung between them in a catenary, the hangers dropping from the cables to
  // the deck, and a lamp every forty metres. The far bridge in the other two
  // stages is a shape on the horizon; this one is a thing you drive on, so it
  // is built from the inside out.
  *_buildDeck(group) {
    const b = new MeshBuilder();
    const lit = new MeshBuilder();
    const pools = new MeshBuilder();
    this.lamps = [];
    this.props = [];
    const N = this.samples.length;
    const L = this.length;
    const ORANGE = 0xc0472a, DARK = 0x8a3a22, STEEL = 0x6f7580;

    // --- the truss under the deck, and the deck's own edge beams.
    // Every sixth sample, not every third. The truss is one box per segment
    // per side and the deck is now eleven kilometres long; at the old spacing
    // that alone was thirty thousand boxes.
    const TRUSS = 6;
    for (let i = 0; i < N - 1; i += TRUSS) {
      const p = this.samples[i], q = this.samples[Math.min(i + TRUSS, N - 1)];
      const len = Math.max(1, Math.hypot(q.x - p.x, q.z - p.z));
      const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2, my = (p.y + q.y) / 2;
      const yaw = Math.atan2(p.dirX, p.dirZ);
      const hw = p.width / 2;
      b.add(G.box(hw * 2 + 2.4, 2.8, len + 0.2), DARK, { x: mx, y: my - 2.2, z: mz, ry: yaw });
      b.add(G.box(hw * 2 + 3.2, 1.1, len + 0.2), ORANGE, { x: mx, y: my - 0.7, z: mz, ry: yaw });
      // Railings: a low wall and a rail above it, both sides.
      for (const sd of [-1, 1]) {
        const ox = p.nx * sd * (hw + 0.6), oz = p.nz * sd * (hw + 0.6);
        b.add(G.box(0.36, 1.05, len + 0.2), ORANGE, { x: mx + ox, y: my + 0.52, z: mz + oz, ry: yaw });
        b.add(G.box(0.5, 0.16, len + 0.2), 0x8f4a30, { x: mx + ox, y: my + 1.12, z: mz + oz, ry: yaw });
      }
    }
    yield 'the deck';

    // --- the towers, and the cables between them.
    const TOWER_AT = [0.25, 0.75];
    const TOWER_H = 118;
    const towers = TOWER_AT.map((f) => {
      const p = this.atDistance(f * L);
      const yaw = Math.atan2(p.dirX, p.dirZ);
      const hw = p.width / 2;
      for (const sd of [-1, 1]) {
        const x = p.x + p.nx * sd * (hw + 3.2), z = p.z + p.nz * sd * (hw + 3.2);
        // A leg that steps in as it rises, which is most of the outline.
        b.add(G.box(7.5, TOWER_H, 7.5), ORANGE, { x, y: p.y - 4 + TOWER_H / 2, z, ry: yaw });
        b.add(G.box(6.2, 18, 6.2), ORANGE, { x, y: p.y + TOWER_H - 12, z, ry: yaw });
        b.add(G.box(5.0, 12, 5.0), ORANGE, { x, y: p.y + TOWER_H + 2, z, ry: yaw });
        // Floodlit from below, which is what picks a tower out of a night sky.
        for (let k = 0; k < 5; k++) {
          lit.add(G.box(4.0, 1.0, 4.0), 0xffa858, { x, y: p.y + 12 + k * 21, z, ry: yaw });
        }
        // The aircraft beacon on top.
        lit.add(G.sphere(1.5, 10, 8), 0xff3a2a, { x, y: p.y + TOWER_H + 9, z });
      }
      // Cross-braces between the two legs, which is what makes it a portal
      // rather than two posts.
      for (const h of [0.30, 0.62, 0.92]) {
        b.add(G.box(hw * 2 + 8, 3.4, 3.0), ORANGE,
          { x: p.x, y: p.y + TOWER_H * h, z: p.z, ry: yaw });
      }
      return { p, top: p.y + TOWER_H, hw };
    });
    yield 'the towers';

    // --- the main cables and their hangers.
    //
    // A real catenary between the two towers, and a straight run down to deck
    // height at each end — so the cable is highest at the towers and lowest at
    // mid-span, which is the shape everybody knows a suspension bridge by, and
    // the shape you get wrong by drawing it the other way up.
    const SAG = 62;
    const cableY = (f) => {
      const a = TOWER_AT[0], c = TOWER_AT[1];
      const deck = this.atDistance(clamp(f, 0, 1) * L).y;
      if (f <= a) return lerp(deck + 3, towers[0].top - 6, f / a);
      if (f >= c) return lerp(towers[1].top - 6, deck + 3, (f - c) / (1 - c));
      const u = (f - a) / (c - a);                 // 0..1 between the towers
      const sag = 4 * u * (1 - u);                 // 0 at the towers, 1 mid-span
      return lerp(towers[0].top - 6, towers[1].top - 6, u) - SAG * sag;
    };
    const STEP = 26;
    const spans = Math.max(8, Math.round(L / STEP));
    for (const sd of [-1, 1]) {
      let prev = null;
      for (let k = 0; k <= spans; k++) {
        const f = k / spans;
        const p = this.atDistance(f * L);
        const hw = p.width / 2;
        const here = {
          x: p.x + p.nx * sd * (hw + 3.2),
          y: cableY(f),
          z: p.z + p.nz * sd * (hw + 3.2),
        };
        if (prev) {
          const dx = here.x - prev.x, dy = here.y - prev.y, dz = here.z - prev.z;
          const len = Math.hypot(dx, dy, dz) || 1;
          b.add(G.box(1.5, 1.5, len), ORANGE, {
            x: (prev.x + here.x) / 2, y: (prev.y + here.y) / 2, z: (prev.z + here.z) / 2,
            ry: Math.atan2(dx, dz), rx: -Math.asin(clamp(dy / len, -1, 1)),
          });
        }
        // A hanger down to the deck, wherever the cable is above it.
        const drop = here.y - (p.y + 1.2);
        if (drop > 3 && f > 0.02 && f < 0.98) {
          b.add(G.box(0.42, drop, 0.42), 0x9a4a2e,
            { x: here.x, y: p.y + 1.2 + drop / 2, z: here.z });
        }
        prev = here;
      }
    }
    yield 'the cables';

    // --- lamps down both sides, and the pools they throw.
    // Lamps every forty metres, MERGED rather than built one mesh each.
    //
    // The city's lamp standards are separate objects because you can knock
    // them over, and ninety of those is a fair price for a street that gives
    // way when you hit it. An eleven-kilometre deck wants two hundred and
    // seventy of them, which is two hundred and seventy draw calls for the
    // privilege of flattening a lamp post you are never going to hit at a
    // hundred and eighty in the outside lane. Merged, they cost one.
    //
    // Spaced at a hundred and twenty first, to save exactly that, and the deck
    // came out unlit — one pool of light every two seconds and pitch dark in
    // between. The lighting is not decoration on this stage: it is how you see
    // which lane is free.
    const every = Math.max(1, Math.round(40 / this.step));
    for (let i = every; i < N - every; i += every) {
      const p = this.samples[i];
      const sd = (i / every) % 2 ? 1 : -1;
      const hw = p.width / 2;
      const x = p.x + p.nx * sd * (hw + 1.4), z = p.z + p.nz * sd * (hw + 1.4);
      const armY = Math.atan2(p.nx * -sd, p.nz * -sd);
      const ox = -p.nx * sd, oz = -p.nz * sd;
      b.add(G.cyl(0.14, 0.17, 8.4, 8), 0x9a4a2e, { x, y: p.y + 4.2, z });
      b.add(G.box(0.16, 0.16, 2.0), 0x9a4a2e,
        { x: x + ox * 1.0, y: p.y + 8.3, z: z + oz * 1.0, ry: armY });
      b.add(G.box(0.5, 0.2, 0.9), 0x4a4a44, { x: x + ox * 1.8, y: p.y + 8.18, z: z + oz * 1.8 });
      lit.add(G.box(0.44, 0.1, 0.8), 0xffe0b4, { x: x + ox * 1.8, y: p.y + 8.02, z: z + oz * 1.8 });
      const hx = x + ox * 1.8, hz = z + oz * 1.8;
      pools.add(this._poolGeometry(hx - p.nx * sd * 3.4, hz - p.nz * sd * 3.4, 40), 0xb08048, {});
      this.lamps.push({ x: hx, y: p.y + 8.0, z: hz });
    }

    group.add(b.build());
    group.add(lit.build(VC_UNLIT));
    const pool = new THREE.Mesh(pools.build().geometry, poolMaterial());
    pool.renderOrder = 3;
    group.add(pool);
    yield 'the lights';
    if (this.layout.land) { yield* this._buildShore(group); }
    // No landmarks. They are placed at fixed world coordinates a few hundred
    // metres out — a downtown cluster, the hills, and a Golden Gate Bridge —
    // all of which is correct scenery for a city and wrong for a stage that IS
    // the bridge: a second one across the horizon, and a wall of towers
    // standing in the water directly behind this one. What belongs behind a
    // bridge at night is the bay and the sky.
  }

  // The cities at each end of the bridge.
  //
  // A span that begins and ends in open water begins and ends nowhere: you
  // drive onto it out of nothing and off it into nothing, and the one thing a
  // bridge is FOR — getting from somewhere to somewhere else — never appears.
  // So there is a city at each end, and they are not the same size: a smaller
  // one behind you and a great deal more of it ahead, which is the right way
  // round and is also what tells you which way you are going.
  //
  // Not the same builder as the circuit's city. That one lays a frontage along
  // a street and ranks blocks behind it, which is what a street wants and has
  // nothing to say about a shoreline seen from two miles out at sixty metres.
  // This scatters blocks on a jittered grid, keeps them off the road and out
  // of the water, and lets the skyline fall away from the middle.
  *_buildShore(group) {
    const b = new MeshBuilder();
    const lit = new MeshBuilder();
    const RENDER = [0xd8d3c6, 0xc9c2b4, 0xbfb8a9, 0x9aa3aa, 0x8e979e, 0x7d868d];
    const GLASS = 0x39586b;
    const WARM = [0xffd9a0, 0xffc478, 0xffe8c4, 0xd8e8f0, 0xc4dcea];

    for (const L of this.layout.land) {
      const anchor = this._landAnchor(L);
      const STEP = 34;
      const reach = L.r * 0.92;
      for (let gx = -reach; gx <= reach; gx += STEP) {
        for (let gz = -reach; gz <= reach; gz += STEP) {
          const x = anchor.x + gx + rand(-9, 9);
          const z = anchor.z + gz + rand(-9, 9);
          const d = Math.hypot(x - anchor.x, z - anchor.z);
          if (d > reach) continue;
          // Density falls off toward the water, so the town thins out into a
          // shoreline instead of ending on a circle.
          const k = 1 - d / reach;
          if (Math.random() > L.town * (0.25 + k * 0.9)) continue;
          // Off the road, and on dry land.
          // Well back from the road. Twenty-six metres put tower blocks up
          // against the parapet of a six-lane freeway, which reads as a
          // canyon rather than as a city the road runs out of.
          const loc = this.locate(x, z);
          if (Math.abs(loc.lateral) < loc.width / 2 + SHORE_CLEAR) continue;
          const gy = this.groundAt(x, z);
          if (gy < SEA_Y + 1.5) continue;

          const tall = Math.random() < L.tall * k * k;
          const w = tall ? rand(16, 26) : rand(13, 24);
          const dep = tall ? rand(16, 26) : rand(13, 24);
          const h = tall ? rand(40, 120) * (0.4 + k) : rand(9, 26) * (0.5 + k);
          const ry = rand(0, Math.PI * 2);
          b.add(G.box(w, h, dep), pick(RENDER), { x, y: gy + h / 2, z, ry, mottle: 0.07 });

          // Windows, as lit bands: at this range individual panes are one
          // pixel, and what reads is how much of the block is on.
          const floors = Math.max(2, Math.round(h / 3.6));
          for (let f = 1; f < floors; f++) {
            if (Math.random() > 0.55) continue;
            const fy = gy + (f / floors) * h;
            const bh = (h / floors) * 0.42;
            lit.add(G.box(w * 0.86, bh, dep + 0.1), pick(WARM),
              { x, y: fy, z, ry, mottle: 0.2 });
            lit.add(G.box(w + 0.1, bh, dep * 0.86), pick(WARM),
              { x, y: fy, z, ry, mottle: 0.2 });
          }
          if (tall) {
            b.add(G.box(w * 0.9, 1.2, dep * 0.9), GLASS, { x, y: gy + h + 0.6, z, ry });
            lit.add(G.sphere(0.9, 8, 6), 0xff3a2a, { x, y: gy + h + 2.6, z });
          }
        }
      }
      yield `the shore`;
    }
    group.add(b.build());
    group.add(lit.build(VC_UNLIT));
  }

  *_buildCity(group) {
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
    // The ramp is built last and the city first, so its footprint is claimed
    // here, before a single building goes up. A deck climbing away over the
    // rooftops looks exactly as wrong going THROUGH one as you would expect,
    // and the pillars under it have to stand on the ground rather than in
    // somebody's third floor.
    if (this.rampPlan) {
      const P = this.rampPlan;
      for (const g of P.segs) {
        // On a route the ramp is the last thing you see, and the bridge is
        // behind it. Nineteen metres of clearance leaves a street of blocks
        // standing between the two, and the payoff for three and a half
        // kilometres is a tower glimpsed down an alley. So the headland is
        // cleared right out — a hundred and eighty metres either side, tapered
        // in over the first few segments so the city does not simply stop at a
        // straight edge.
        const wide = P.open
          ? lerp(RAMP.width + 30, 180, clamp(g.i / 5, 0, 1))
          : RAMP.width + 8;
        claim({ x: g.x, z: g.z, ry: g.yaw, w: wide, d: P.seg + 6 });
      }
    }
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
      const B = this.layout.bridge || { x: -560, z: 330, ang: 0.7 };
      const bx = B.x, bz = B.z, ang = B.ang;
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

  // How far apart two points are along the road, signed.
  //
  // On a lap that means the short way round, because a car ten metres behind
  // you is also a lap-minus-ten in front of you and only one of those is the
  // useful reading. On a route there is no way round: the difference IS the
  // answer, and taking the short way would report a car a mile back as being
  // just ahead the moment the route got longer than twice the gap.
  gap(sA, sB) {
    let d = sA - sB;
    if (!this.closed) return d;
    while (d > this.length / 2) d -= this.length;
    while (d < -this.length / 2) d += this.length;
    return d;
  }
}
