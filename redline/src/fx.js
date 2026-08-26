// The things a car leaves behind: rubber on the road, smoke off a spinning
// tyre, dust when it runs wide, and sparks when it does not miss.
//
// All of it lives in a handful of pre-allocated buffers that are written in
// place, so a sixteen-car race does not allocate anything per frame.

import * as THREE from 'three';
import { clamp, rand } from './utils.js';

const MARKS = 3000;             // quads of rubber before the oldest is reused
const PUFFS = 420;              // smoke and dust particles
const SPARKS = 260;

export class FX {
  constructor(scene) {
    this.scene = scene;

    // --- skid marks: a ring buffer of flat quads laid on the road
    const mg = new THREE.BufferGeometry();
    this.markPos = new Float32Array(MARKS * 6 * 3);
    this.markAlpha = new Float32Array(MARKS * 6);
    mg.setAttribute('position', new THREE.BufferAttribute(this.markPos, 3));
    mg.setAttribute('alpha', new THREE.BufferAttribute(this.markAlpha, 1));
    const mm = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      vertexShader: `
        attribute float alpha;
        varying float vA;
        void main() {
          vA = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying float vA;
        void main() {
          if (vA <= 0.001) discard;
          gl_FragColor = vec4(0.04, 0.04, 0.045, vA);
        }`,
    });
    this.marks = new THREE.Mesh(mg, mm);
    this.marks.frustumCulled = false;
    this.marks.renderOrder = 1;
    scene.add(this.marks);
    this.markIdx = 0;
    this.markLast = new Map();          // per wheel, the previous contact point

    // --- smoke and dust
    const pg = new THREE.BufferGeometry();
    this.puffPos = new Float32Array(PUFFS * 3);
    this.puffCol = new Float32Array(PUFFS * 3);
    this.puffSize = new Float32Array(PUFFS);
    pg.setAttribute('position', new THREE.BufferAttribute(this.puffPos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(this.puffCol, 3));
    pg.setAttribute('size', new THREE.BufferAttribute(this.puffSize, 1));
    const pm = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      uniforms: { scale: { value: 600 } },
      vertexShader: `
        attribute float size;
        varying vec3 vC;
        uniform float scale;
        void main() {
          vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale / max(-mv.z, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vC;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = dot(d, d);
          if (r > 0.25) discard;
          gl_FragColor = vec4(vC, (0.25 - r) * 3.2);
        }`,
    });
    this.puffs = new THREE.Points(pg, pm);
    this.puffs.frustumCulled = false;
    scene.add(this.puffs);
    this.puffState = [];
    for (let i = 0; i < PUFFS; i++) {
      this.puffState.push({ life: 0, max: 1, vx: 0, vy: 0, vz: 0, size: 1, r: 1, g: 1, b: 1 });
      this.puffSize[i] = 0;
    }
    this.puffIdx = 0;

    // --- sparks
    const sg = new THREE.BufferGeometry();
    this.sparkPos = new Float32Array(SPARKS * 3);
    this.sparkCol = new Float32Array(SPARKS * 3);
    sg.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(this.sparkCol, 3));
    this.sparks = new THREE.Points(sg, new THREE.PointsMaterial({
      size: 0.16, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
    }));
    this.sparks.frustumCulled = false;
    scene.add(this.sparks);
    this.sparkState = [];
    for (let i = 0; i < SPARKS; i++) this.sparkState.push({ life: 0, vx: 0, vy: 0, vz: 0 });
    this.sparkIdx = 0;
  }

  // A stripe of rubber between where this wheel was and where it is now.
  skid(key, x, y, z, width, dirX, dirZ, strength) {
    const last = this.markLast.get(key);
    this.markLast.set(key, { x, y, z });
    if (!last) return;
    const dx = x - last.x, dz = z - last.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05 || d > 6) return;
    const nx = -dirZ * width * 0.5, nz = dirX * width * 0.5;
    const i = this.markIdx;
    this.markIdx = (this.markIdx + 1) % MARKS;
    const o = i * 18;
    const p = this.markPos;
    const set = (k, px, py, pz) => { p[o + k * 3] = px; p[o + k * 3 + 1] = py; p[o + k * 3 + 2] = pz; };
    set(0, last.x - nx, last.y + 0.012, last.z - nz);
    set(1, last.x + nx, last.y + 0.012, last.z + nz);
    set(2, x + nx, y + 0.012, z + nz);
    set(3, last.x - nx, last.y + 0.012, last.z - nz);
    set(4, x + nx, y + 0.012, z + nz);
    set(5, x - nx, y + 0.012, z - nz);
    const a = clamp(strength, 0, 1) * 0.62;
    for (let k = 0; k < 6; k++) this.markAlpha[i * 6 + k] = a;
    this.marks.geometry.attributes.position.needsUpdate = true;
    this.marks.geometry.attributes.alpha.needsUpdate = true;
  }

  puff(x, y, z, { vx = 0, vy = 0.6, vz = 0, size = 1.2, life = 1.1, colour = [0.72, 0.72, 0.74] } = {}) {
    const i = this.puffIdx;
    this.puffIdx = (this.puffIdx + 1) % PUFFS;
    const s = this.puffState[i];
    s.life = life; s.max = life;
    s.vx = vx; s.vy = vy; s.vz = vz;
    s.size = size;
    [s.r, s.g, s.b] = colour;
    this.puffPos[i * 3] = x;
    this.puffPos[i * 3 + 1] = y;
    this.puffPos[i * 3 + 2] = z;
  }

  smoke(x, y, z, strength) {
    this.puff(x, y + 0.1, z, {
      vx: rand(-1.2, 1.2), vy: rand(0.5, 1.6), vz: rand(-1.2, 1.2),
      size: rand(1.1, 2.2), life: rand(0.8, 1.6) * (0.6 + strength),
      colour: [0.74, 0.74, 0.76],
    });
  }

  dust(x, y, z, strength) {
    this.puff(x, y + 0.05, z, {
      vx: rand(-1.6, 1.6), vy: rand(0.3, 1.1), vz: rand(-1.6, 1.6),
      size: rand(1.0, 2.0), life: rand(0.6, 1.2),
      colour: [0.52, 0.45, 0.32],
    });
    void strength;
  }

  spark(x, y, z, force) {
    const n = clamp(Math.round(force * 1.6), 3, 24);
    for (let k = 0; k < n; k++) {
      const i = this.sparkIdx;
      this.sparkIdx = (this.sparkIdx + 1) % SPARKS;
      const s = this.sparkState[i];
      s.life = rand(0.25, 0.6);
      s.vx = rand(-6, 6); s.vy = rand(1, 6); s.vz = rand(-6, 6);
      this.sparkPos[i * 3] = x;
      this.sparkPos[i * 3 + 1] = y;
      this.sparkPos[i * 3 + 2] = z;
      const c = rand(0.75, 1);
      this.sparkCol[i * 3] = 1;
      this.sparkCol[i * 3 + 1] = c * 0.8;
      this.sparkCol[i * 3 + 2] = c * 0.25;
    }
  }

  update(dt) {
    // Smoke drifts, rises and fades.
    for (let i = 0; i < PUFFS; i++) {
      const s = this.puffState[i];
      if (s.life <= 0) { this.puffSize[i] = 0; continue; }
      s.life -= dt;
      const t = clamp(s.life / s.max, 0, 1);
      this.puffPos[i * 3] += s.vx * dt;
      this.puffPos[i * 3 + 1] += s.vy * dt;
      this.puffPos[i * 3 + 2] += s.vz * dt;
      s.vy *= 1 - dt * 0.6;
      s.vx *= 1 - dt * 1.2;
      s.vz *= 1 - dt * 1.2;
      this.puffSize[i] = s.size * (1.6 - t * 0.6) * (t > 0 ? 1 : 0);
      const fade = t * t;
      this.puffCol[i * 3] = s.r * fade + 0.5 * (1 - fade);
      this.puffCol[i * 3 + 1] = s.g * fade + 0.5 * (1 - fade);
      this.puffCol[i * 3 + 2] = s.b * fade + 0.5 * (1 - fade);
      if (s.life <= 0) this.puffSize[i] = 0;
    }
    this.puffs.geometry.attributes.position.needsUpdate = true;
    this.puffs.geometry.attributes.size.needsUpdate = true;
    this.puffs.geometry.attributes.color.needsUpdate = true;

    for (let i = 0; i < SPARKS; i++) {
      const s = this.sparkState[i];
      if (s.life <= 0) { this.sparkCol[i * 3] = this.sparkCol[i * 3 + 1] = this.sparkCol[i * 3 + 2] = 0; continue; }
      s.life -= dt;
      s.vy -= 22 * dt;
      this.sparkPos[i * 3] += s.vx * dt;
      this.sparkPos[i * 3 + 1] += s.vy * dt;
      this.sparkPos[i * 3 + 2] += s.vz * dt;
      const f = clamp(s.life * 3, 0, 1);
      this.sparkCol[i * 3] = f;
      this.sparkCol[i * 3 + 1] = f * 0.8;
      this.sparkCol[i * 3 + 2] = f * 0.25;
    }
    this.sparks.geometry.attributes.position.needsUpdate = true;
    this.sparks.geometry.attributes.color.needsUpdate = true;
  }

  // Called once a lap's worth of rubber is meaningless — at a restart.
  clear() {
    this.markAlpha.fill(0);
    this.marks.geometry.attributes.alpha.needsUpdate = true;
    this.markLast.clear();
    for (const s of this.puffState) s.life = 0;
    for (const s of this.sparkState) s.life = 0;
  }
}
