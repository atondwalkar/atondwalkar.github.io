// Model construction kit.
//
// Everything visible is still generated at load time, but instead of one flat
// box per part, parts are built from real primitives (capsules, spheres,
// lathes, tori), given a colour per surface, and merged into a single
// vertex-coloured mesh. That buys three things at once: many more triangles,
// per-part colour without a texture, and FEWER draw calls than the old
// one-mesh-per-box approach — a soldier went from ~14 meshes to 5.
//
// `mottle` jitters the colour per triangle. On fabric it reads as weave and
// wear at distance, which is what keeps the flat-shaded look from going
// plastic.

import * as THREE from 'three';
import { mergeGeometries } from '../vendor/BufferGeometryUtils.js';

// One material for every merged mesh in the game: colour comes from the
// vertices, so a soldier, his rifle and his helmet all share this.
export const VC_MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true });
export const VC_MATERIAL_DS = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
// Anything that is itself a light source — a lit window, a lamp lens, a
// headlight, a tail light. Unlit, so it keeps its colour whatever the scene
// lighting is doing, which at night is the entire point: a window lit from
// inside does not get darker because the sun went down.
export const VC_UNLIT = new THREE.MeshBasicMaterial({ vertexColors: true });

// The soft pool a lamp throws on the ground. One radial-falloff texture,
// added rather than blended, so overlapping pools build up the way light does
// instead of painting over each other.
let _pool = null;
export function poolTexture() {
  if (_pool) return _pool;
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.42)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.10)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, n, n);
  _pool = new THREE.CanvasTexture(c);
  _pool.colorSpace = THREE.SRGBColorSpace;
  return _pool;
}

export function poolMaterial() {
  return new THREE.MeshBasicMaterial({
    map: poolTexture(), vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

// Cached primitives — a soldier reuses the same sphere dozens of times, and
// cloning a cached geometry is far cheaper than regenerating it.
const cache = new Map();
function cached(key, make) {
  let g = cache.get(key);
  if (!g) { g = make().toNonIndexed(); cache.set(key, g); }
  return g;
}

export const G = {
  box: (w, h, d) => cached(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)),
  sphere: (r, w = 12, h = 8) => cached(`s${r},${w},${h}`, () => new THREE.SphereGeometry(r, w, h)),
  dome: (r, w = 14, h = 8, frac = 0.55) =>
    cached(`d${r},${w},${h},${frac}`, () => new THREE.SphereGeometry(r, w, h, 0, Math.PI * 2, 0, Math.PI * frac)),
  cyl: (rt, rb, h, seg = 12, open = false) =>
    cached(`c${rt},${rb},${h},${seg},${open}`, () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open)),
  capsule: (r, len, cap = 4, seg = 12) =>
    cached(`k${r},${len},${cap},${seg}`, () => new THREE.CapsuleGeometry(r, len, cap, seg)),
  cone: (r, h, seg = 10) => cached(`n${r},${h},${seg}`, () => new THREE.ConeGeometry(r, h, seg)),
  torus: (r, tube, rad = 8, tub = 16, arc = Math.PI * 2) =>
    cached(`t${r},${tube},${rad},${tub},${arc}`, () => new THREE.TorusGeometry(r, tube, rad, tub, arc)),
  plane: (w, h) => cached(`p${w},${h}`, () => new THREE.PlaneGeometry(w, h)),
  icosa: (r, detail = 1) => cached(`i${r},${detail}`, () => new THREE.IcosahedronGeometry(r, detail)),
  // A flat annulus facing +Z — an aperture you genuinely look through, unlike
  // an open cylinder, which is invisible when viewed down its own axis.
  ring: (ri, ro, seg = 16) => cached(`r${ri},${ro},${seg}`, () => new THREE.RingGeometry(ri, ro, seg)),
};

export class MeshBuilder {
  constructor() {
    this.parts = [];
    this.bounds = new THREE.Box3();
  }

  // geo: a cached primitive. opts: position/rotation/scale plus the colour.
  add(geo, colour, opts = {}) {
    const g = geo.clone();
    _p.set(opts.x || 0, opts.y || 0, opts.z || 0);
    _e.set(opts.rx || 0, opts.ry || 0, opts.rz || 0);
    _q.setFromEuler(_e);
    _s.set(opts.sx ?? opts.s ?? 1, opts.sy ?? opts.s ?? 1, opts.sz ?? opts.s ?? 1);
    _m.compose(_p, _q, _s);
    g.applyMatrix4(_m);

    const pos = g.attributes.position;
    const count = pos.count;
    const col = new Float32Array(count * 3);
    _c.set(colour);
    const mottle = opts.mottle || 0;
    // Geometry is non-indexed, so three consecutive vertices are one triangle
    // and a per-triangle factor gives flat facets rather than a gradient.
    for (let i = 0; i < count; i += 3) {
      const f = mottle ? 1 + (Math.random() - 0.5) * mottle : 1;
      for (let k = 0; k < 3; k++) {
        col[(i + k) * 3] = _c.r * f;
        col[(i + k) * 3 + 1] = _c.g * f;
        col[(i + k) * 3 + 2] = _c.b * f;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(g);
    return this;
  }

  // Mirror the last N additions across X — arms, legs, boots, pouches.
  mirrorLast(n = 1) {
    const start = this.parts.length - n;
    const flip = new THREE.Matrix4().makeScale(-1, 1, 1);
    for (let i = start; i < start + n; i++) {
      const g = this.parts[i].clone();
      g.applyMatrix4(flip);
      // Mirroring inverts winding; flipping the normals keeps lighting right.
      const nrm = g.attributes.normal;
      for (let v = 0; v < nrm.count; v++) nrm.setX(v, -nrm.getX(v));
      this.parts.push(g);
    }
    return this;
  }

  get triangles() {
    return this.parts.reduce((n, g) => n + g.attributes.position.count / 3, 0);
  }

  build(material = VC_MATERIAL) {
    if (!this.parts.length) return new THREE.Mesh(new THREE.BufferGeometry(), material);
    const merged = mergeGeometries(this.parts, false);
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.matrixAutoUpdate = true;
    return mesh;
  }
}

// Glass, lenses and glowing bits keep their own unlit material so they read as
// emissive against the shaded body.
export function glowMesh(geo, colour, opts = {}) {
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: colour, transparent: opts.opacity !== undefined, opacity: opts.opacity ?? 1,
    side: opts.side || THREE.FrontSide, depthWrite: opts.opacity === undefined,
  }));
  m.position.set(opts.x || 0, opts.y || 0, opts.z || 0);
  m.rotation.set(opts.rx || 0, opts.ry || 0, opts.rz || 0);
  m.scale.set(opts.sx ?? opts.s ?? 1, opts.sy ?? opts.s ?? 1, opts.sz ?? opts.s ?? 1);
  return m;
}
