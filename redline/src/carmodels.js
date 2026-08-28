// The cars. One procedural GT body, coloured per livery, with the wheels kept
// as separate objects so they can be steered and spun by the simulation.
//
// The model faces +z, which is the same forward the physics uses, so the mesh
// rotation is simply the car's yaw. Everything is built to the dimensions the
// physics actually uses — the wheelbase, the track width and the wheel radius
// all come out of the car spec — so the wheels sit under the arches rather
// than near them.

import * as THREE from 'three';
import { MeshBuilder, G, VC_MATERIAL_DS, VC_UNLIT } from './meshkit.js';
import { CAR } from './defs.js';

const GLASS = 0x22303a;

// Tinted glass: dark enough to read as glass from outside, open enough to see
// the road through from the driver's seat. depthWrite off so the cabin, the
// wheel and the road beyond all still draw behind it.
const GLAZING = new THREE.MeshLambertMaterial({
  vertexColors: true, transparent: true, opacity: 0.30,
  depthWrite: false, side: THREE.DoubleSide,
});
const TYRE = 0x1b1d20;
const RIM = 0x9aa0a8;
const CARBON = 0x26292d;

// Number roundels are drawn to a canvas, because a two-digit number built out
// of boxes is not legible at the distance you actually see other cars from.
const numberCache = new Map();
function numberTexture(num, fg, bg) {
  const key = `${num}|${fg}|${bg}`;
  if (numberCache.has(key)) return numberCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = `#${bg.toString(16).padStart(6, '0')}`;
  g.beginPath();
  g.arc(64, 64, 58, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = `#${fg.toString(16).padStart(6, '0')}`;
  g.font = 'bold 84px "DejaVu Sans", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(num), 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  numberCache.set(key, tex);
  return tex;
}


// Clone the loaded model and paint it in this car's colours. The wheel
// references have to be re-found on the clone: cloning gives fresh objects,
// and the template's own wheel list points at the template's wheels, so using
// it directly would steer one car and spin fifteen sets of nothing.
function cloneTemplate(livery) {
  const root = template.clone(true);
  const twin = new Map();
  (function pair(a, c) {
    twin.set(a, c);
    a.children.forEach((ch, i) => { if (c.children[i]) pair(ch, c.children[i]); });
  }(template, root));

  const wheels = [];
  for (const w of template.userData.wheels || []) {
    const pivot = twin.get(w.pivot);
    if (pivot) wheels.push({ pivot, mesh: twin.get(w.mesh) || pivot, front: w.front });
  }

  const paint = new Set((template.userData.paintable || []).map((m) => m.uuid));
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const many = Array.isArray(o.material);
    const list = many ? o.material : [o.material];
    const next = list.map((m) => (paint.has(m.uuid)
      ? Object.assign(m.clone(), { color: new THREE.Color(livery.body) })
      : m));
    o.material = many ? next : next[0];
  });

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 4.6),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.025;
  root.add(shadow);

  root.userData.wheels = wheels;
  root.userData.shadow = shadow;
  root.userData.livery = livery;
  return root;
}

function buildWheel(radius, width, front) {
  const b = new MeshBuilder();
  // The tyre lies on its side, so it spins about x. Thirty-two segments rather
  // than twenty: a wheel is the one round thing on the car you stare at, and
  // it is round enough now that you cannot count the facets at a standstill.
  b.add(G.cyl(radius, radius, width, 32), TYRE, { rz: Math.PI / 2, mottle: 0.035 });
  // A shoulder either side, so the tread reads as a separate surface.
  for (const sx of [-1, 1]) {
    b.add(G.cyl(radius * 0.985, radius * 0.94, width * 0.09, 32), 0x232629,
      { x: sx * width * 0.5, rz: Math.PI / 2 });
  }
  // One white sidewall mark, which is what makes the rotation readable.
  b.add(G.box(0.03, radius * 1.7, 0.012), 0xd0d0cc, { x: width / 2 + 0.004 });
  b.add(G.torus(radius * 0.80, 0.010, 6, 28), 0xbdbdb8, { x: width / 2 + 0.004, ry: Math.PI / 2 });

  // The brake disc and caliper, visible through the spokes.
  b.add(G.cyl(radius * 0.66, radius * 0.66, 0.045, 26), 0x6e747a, { rz: Math.PI / 2, mottle: 0.05 });
  b.add(G.cyl(radius * 0.30, radius * 0.30, 0.07, 18), 0x4e5459, { rz: Math.PI / 2 });
  for (let v = 0; v < 22; v++) {
    const a = (v / 22) * Math.PI * 2;
    b.add(G.box(0.035, radius * 0.30, 0.028), 0x555b61,
      { y: Math.cos(a) * radius * 0.48, z: Math.sin(a) * radius * 0.48, rx: -a });
  }
  b.add(G.box(0.10, radius * 0.42, 0.16), front ? 0xc23c2c : 0xb8963a,
    { y: radius * 0.60, z: -radius * 0.10, rx: 0.3 });

  // The rim: a face, a lip and seven spokes.
  for (const sx of [-1, 1]) {
    b.add(G.cyl(radius * 0.62, radius * 0.60, 0.05, 28), RIM, { x: sx * width * 0.46, rz: Math.PI / 2 });
    b.add(G.torus(radius * 0.615, 0.030, 8, 28), 0x8a9198, { x: sx * width * 0.47, ry: Math.PI / 2 });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      b.add(G.box(0.052, radius * 0.56, 0.042), RIM, {
        x: sx * width * 0.45,
        y: Math.cos(a) * radius * 0.28,
        z: Math.sin(a) * radius * 0.28,
        rx: -a,
      });
    }
    b.add(G.cyl(0.062, 0.062, 0.055, 14), 0xc8a23a, { x: sx * width * 0.49, rz: Math.PI / 2 });
    for (let n = 0; n < 5; n++) {
      const a = (n / 5) * Math.PI * 2;
      b.add(G.cyl(0.017, 0.017, 0.05, 8), 0x9aa0a8, {
        x: sx * width * 0.49,
        y: Math.cos(a) * radius * 0.11,
        z: Math.sin(a) * radius * 0.11,
        rz: Math.PI / 2,
      });
    }
  }
  return b.build();
}

// Four silhouettes. The chassis, wheels, arches, lights and diffuser are
// shared — those are the parts every racing car has — and what differs is the
// proportion and, above all, the greenhouse and the wing, which are what you
// actually read a car's shape by at two hundred metres.
const STYLES = {
  // A closed GT coupe: the shape everything else is a departure from.
  gt: {
    W: 1.95, nose: 2.28, tail: -2.30, waist: 0.78, roof: 1.20,
    flare: 0.03, cabin: 'coupe', cabZ: 0, wing: 'high', bonnet: 1.32,
  },
  // An open-cockpit prototype: no roof, a roll hoop, a dorsal fin down the
  // long tail, and a swan-neck wing.
  proto: {
    W: 2.00, nose: 2.42, tail: -2.44, waist: 0.70, roof: 1.06,
    flare: 0.07, cabin: 'open', cabZ: 0.18, wing: 'swan', bonnet: 1.50,
  },
  // A long-nosed saloon, taller and squarer, with a ducktail rather than a
  // wing — the one that looks out of place and quite pleased about it.
  muscle: {
    W: 1.92, nose: 2.44, tail: -2.18, waist: 0.88, roof: 1.36,
    flare: 0.01, cabin: 'saloon', cabZ: -0.26, wing: 'duck', bonnet: 1.56,
  },
  // Cab-forward, very low, very wide, with a wing you could serve dinner off.
  hyper: {
    W: 2.04, nose: 2.22, tail: -2.38, waist: 0.72, roof: 1.12,
    flare: 0.06, cabin: 'coupe', cabZ: -0.22, wing: 'huge', bonnet: 1.20,
  },
};

// An external model, if one was loaded. Every car is a clone of it.

// A model loaded from a file, if there is one. Every car is a clone of it.
let template = null;
export function setCarTemplate(group) { template = group; }
export const usingExternalModel = () => !!template;

export function buildCar(livery) {
  if (template) return cloneTemplate(livery);
  const root = new THREE.Group();
  const b = new MeshBuilder();
  const body = livery.body;
  const trim = livery.trim;

  const st = STYLES[livery.shape] || STYLES.gt;
  const W = st.W;                       // overall width
  const HW = W / 2;
  const NOSE = st.nose, TAIL = st.tail; // the two ends
  const WR = CAR.wheelRadius;           // 0.34
  const FZ = CAR.wheelbase * (1 - CAR.weightFront);    // front axle, +1.41
  const RZ = -CAR.wheelbase * CAR.weightFront;         // rear axle,  -1.21
  const TR = CAR.track / 2;             // half the track width

  // Heights the whole shape is hung off. The waistline is just above the top
  // of a tyre, which is what makes a car look like it is sitting on its wheels
  // rather than hovering over them.
  const FLOOR = 0.085;
  const WAIST = st.waist;
  const ROOF = st.roof;

  // --- underbody, splitter and diffuser
  b.add(G.box(W * 0.94, 0.05, 4.30), CARBON, { y: FLOOR, z: 0 });
  b.add(G.box(W * 1.00, 0.045, 0.46), CARBON, { y: FLOOR - 0.015, z: NOSE - 0.16 });
  b.add(G.box(W * 0.60, 0.06, 0.26), CARBON, { y: FLOOR + 0.02, z: NOSE + 0.02 });
  // The diffuser: strakes tucked up under the tail, not hanging below it.
  b.add(G.box(W * 0.80, 0.06, 0.62), CARBON, { y: 0.20, z: TAIL + 0.30, rx: -0.30 });
  for (let i = -2; i <= 2; i++) {
    b.add(G.box(0.045, 0.16, 0.58), CARBON, { x: i * 0.30, y: 0.24, z: TAIL + 0.30, rx: -0.30 });
  }

  // --- the tub, from the bulkhead back to the rear deck. Built as a stack of
  // slightly different widths rather than one box, which chamfers the top and
  // bottom edges and catches the light along the flank.
  b.add(G.box(W * 0.90, WAIST - 0.16, 2.62), body, { y: (WAIST + 0.16) / 2, z: -0.10, mottle: 0.045 });
  b.add(G.box(W * 0.84, 0.10, 2.60), body, { y: WAIST - 0.05, z: -0.10, mottle: 0.03 });
  b.add(G.box(W * 0.78, 0.07, 2.56), body, { y: WAIST + 0.01, z: -0.10, mottle: 0.03 });
  b.add(G.box(W * 0.84, 0.09, 2.58), body, { y: 0.20, z: -0.10, mottle: 0.03 });
  // The nose: two boxes stepping down and in toward the splitter.
  b.add(G.box(W * 0.84, 0.40, 0.62), body, { y: 0.48, z: 1.32, mottle: 0.045 });
  b.add(G.box(W * 0.80, 0.34, 0.64), body, { y: 0.42, z: 1.86, mottle: 0.045 });
  b.add(G.box(W * 0.60, 0.26, 0.34), body, { y: 0.33, z: NOSE - 0.10, mottle: 0.045 });
  // The tail, and the deck the wing sits over.
  b.add(G.box(W * 0.88, 0.42, 1.00), body, { y: 0.50, z: -1.72, mottle: 0.045 });
  b.add(G.box(W * 0.80, 0.10, 0.70), body, { y: 0.76, z: -1.62, mottle: 0.04 });

  // --- arches. A blistered fender over each wheel: a slab standing proud of
  // the bodyside, stepped down at each end so it reads as a curve rather than
  // a box. A ring drawn round the wheel was tried and looked like a hoop
  // hovering beside the car, because that is what an open cylinder is.
  for (const [zc, len, out] of [[FZ, 1.16, st.flare], [RZ, 1.26, st.flare + 0.03]]) {
    for (const sx of [-1, 1]) {
      const x = sx * (HW - 0.09 + out);
      b.add(G.box(0.19, 0.26, len), body, { x, y: WAIST - 0.13, z: zc, mottle: 0.045 });
      for (const e of [-1, 1]) {
        b.add(G.box(0.17, 0.19, 0.22), body,
          { x: sx * (HW - 0.10 + out * 0.5), y: WAIST - 0.20, z: zc + e * (len / 2 + 0.10), mottle: 0.045 });
      }
      // A dark liner just inside it, so there is shadow where the tyre goes.
      b.add(G.box(0.05, 0.30, len * 0.94), 0x14161a, { x: sx * (HW - 0.20), y: WAIST - 0.22, z: zc });
    }
  }
  // Sills, between the arches.
  for (const sx of [-1, 1]) {
    b.add(G.box(0.24, 0.34, 1.86), body, { x: sx * (HW - 0.10), y: 0.40, z: 0.10, mottle: 0.045 });
    b.add(G.box(0.10, 0.09, 1.60), trim, { x: sx * (HW + 0.02), y: 0.26, z: 0.10 });
  }

  // --- greenhouse.
  //
  // A screen is a thin plate standing on its edge and leaning back, so the box
  // is long in y and thin in z before it is rotated. Built the other way round
  // — thin in y, long in z — it comes out as a half-metre wedge of glass
  // hanging off the front of the roof.
  const gb = new MeshBuilder();            // everything transparent
  const GH = ROOF - WAIST;                 // how tall the glass house is
  const CZ = st.cabZ;                      // where the cabin sits fore and aft
  // Glass goes into its own builder, not the shell's. The shell is merged into
  // one mesh with one opaque material, so there is no way to make part of it
  // see-through — and from the cockpit and the bonnet you are sitting behind
  // the windscreen looking at it, with the A-pillars and the screen itself
  // blanking out the road. A second mesh costs one more draw call per car and
  // gets you a windscreen you can see through.
  const screen = (baseZ, topZ, w, colour) => {
    const dz = topZ - baseZ;
    gb.add(G.box(w, Math.hypot(GH, dz), 0.05), colour, {
      y: (WAIST + ROOF) / 2, z: (baseZ + topZ) / 2, rx: Math.atan2(dz, GH),
    });
  };
  const mirrors = () => {
    for (const sx of [-1, 1]) {
      b.add(G.box(0.15, 0.08, 0.09), trim, { x: sx * (HW - 0.02), y: WAIST + 0.16, z: CZ + 0.86 });
      b.add(G.box(0.06, 0.04, 0.13), CARBON, { x: sx * (HW - 0.09), y: WAIST + 0.14, z: CZ + 0.86 });
    }
  };

  if (st.cabin === 'open') {
    // A prototype: a low wraparound screen, no roof, a hoop over the driver's
    // head and a fin running back from it down the tail.
    screen(CZ + 1.00, CZ + 0.62, W * 0.62, GLASS);
    for (const sx of [-1, 1]) {
      gb.add(G.box(0.05, GH * 0.8, 0.85), GLASS, { x: sx * W * 0.29, y: WAIST + GH * 0.4, z: CZ + 0.30 });
      b.add(G.box(0.10, GH * 0.95, 0.10), body, { x: sx * W * 0.30, y: WAIST + GH * 0.5, z: CZ - 0.16 });
    }
    b.add(G.box(W * 0.44, 0.10, 0.14), 0x8f959c, { y: ROOF, z: CZ - 0.22 });          // hoop, top
    // A headrest fairing, then the fin.
    b.add(G.box(0.40, GH * 0.7, 0.55), body, { y: WAIST + GH * 0.35, z: CZ - 0.62, mottle: 0.04 });
    b.add(G.box(0.09, 0.46, 1.55), body, { y: WAIST + 0.20, z: CZ - 1.42, mottle: 0.04 });
    b.add(G.box(0.09, 0.30, 0.55), trim, { y: WAIST + 0.30, z: CZ - 2.02 });
    mirrors();
  } else if (st.cabin === 'saloon') {
    // Taller and squarer, with a proper glasshouse and a thin B-pillar.
    screen(CZ + 1.26, CZ + 0.72, W * 0.74, GLASS);
    screen(CZ - 1.10, CZ - 0.66, W * 0.72, GLASS);
    b.add(G.box(W * 0.72, 0.10, 1.40), body, { y: ROOF, z: CZ + 0.03, mottle: 0.035 });
    for (const sx of [-1, 1]) {
      const x = sx * W * 0.35;
      gb.add(G.box(0.04, GH, 1.28), GLASS, { x, y: (WAIST + ROOF) / 2, z: CZ + 0.04 });
      b.add(G.box(0.07, Math.hypot(GH, 0.54), 0.12), body,
        { x, y: (WAIST + ROOF) / 2, z: CZ + 0.99, rx: Math.atan2(-0.54, GH) });
      b.add(G.box(0.07, Math.hypot(GH, 0.44), 0.12), body,
        { x, y: (WAIST + ROOF) / 2, z: CZ - 0.88, rx: Math.atan2(0.44, GH) });
      b.add(G.box(0.06, GH, 0.09), body, { x, y: (WAIST + ROOF) / 2, z: CZ + 0.10 });  // B-pillar
    }
    mirrors();
  } else {
    // The coupe.
    screen(CZ + 1.20, CZ + 0.58, W * 0.70, GLASS);
    screen(CZ - 0.98, CZ - 0.56, W * 0.66, GLASS);
    b.add(G.box(W * 0.66, 0.09, 1.16), body, { y: ROOF, z: CZ + 0.01, mottle: 0.035 });
    for (const sx of [-1, 1]) {
      const x = sx * W * 0.32;
      gb.add(G.box(0.04, GH, 1.06), GLASS, { x, y: (WAIST + ROOF) / 2, z: CZ + 0.02 });
      // The pillars follow the screens, so they lean with them.
      b.add(G.box(0.07, Math.hypot(GH, 0.62), 0.11), body,
        { x, y: (WAIST + ROOF) / 2, z: CZ + 0.89, rx: Math.atan2(-0.62, GH) });        // A-pillar
      b.add(G.box(0.07, Math.hypot(GH, 0.42), 0.11), body,
        { x, y: (WAIST + ROOF) / 2, z: CZ - 0.77, rx: Math.atan2(0.42, GH) });         // C-pillar
    }
    b.add(G.box(W * 0.58, 0.06, 0.06), 0x8f959c, { y: ROOF - 0.05, z: CZ - 0.42 });    // roll hoop
    mirrors();
  }

  // --- the rear wing, which is the other half of a car's signature
  if (st.wing === 'duck') {
    // A ducktail: no wing at all, just the boot lip turned up.
    b.add(G.box(W * 0.80, 0.09, 0.34), body, { y: WAIST + 0.06, z: TAIL + 0.26, rx: 0.30, mottle: 0.04 });
    b.add(G.box(W * 0.80, 0.03, 0.10), trim, { y: WAIST + 0.13, z: TAIL + 0.14, rx: 0.30 });
  } else {
    const H = st.wing === 'huge' ? 1.26 : st.wing === 'swan' ? 1.20 : 1.14;
    const CH = st.wing === 'huge' ? 0.58 : 0.46;                      // chord
    b.add(G.box(W * 0.96, 0.05, CH), CARBON, { y: H, z: TAIL + 0.20, rx: 0.16 });
    b.add(G.box(W * 0.96, 0.04, CH * 0.5), CARBON, { y: H - 0.13, z: TAIL + 0.30, rx: 0.24 });
    for (const sx of [-1, 1]) {
      b.add(G.box(0.035, 0.34, CH * 1.15), trim, { x: sx * W * 0.48, y: H - 0.11, z: TAIL + 0.22 });
      if (st.wing === 'swan') {
        // Swan neck: the mounts come down from above the plane, not below it.
        b.add(G.box(0.06, 0.30, 0.08), CARBON, { x: sx * 0.30, y: H + 0.14, z: TAIL + 0.30 });
        b.add(G.box(0.06, 0.08, 0.42), CARBON, { x: sx * 0.30, y: H + 0.27, z: TAIL + 0.52 });
      } else {
        b.add(G.box(0.06, H - 0.70, 0.08), CARBON, { x: sx * 0.32, y: (H + 0.70) / 2 - 0.06, z: TAIL + 0.28 });
      }
    }
  }

  // --- lights, ducts and pipes
  //
  // The lenses go in the unlit builder, so at night a headlight is a headlight
  // rather than a pale rectangle that gets darker as the light does.
  const lb = new MeshBuilder();
  for (const sx of [-1, 1]) {
    // Headlamp lenses, not headlamps: the street is lit, so these are glass
    // catching what is around them rather than anything switched on.
    b.add(G.box(0.40, 0.13, 0.07), 0x2a2a26, { x: sx * 0.56, y: 0.52, z: NOSE - 0.02 });
    b.add(G.box(0.36, 0.11, 0.05), 0xdfe2e4, { x: sx * 0.56, y: 0.52, z: NOSE + 0.01 });
    b.add(G.box(0.34, 0.11, 0.06), 0x481410, { x: sx * 0.54, y: 0.60, z: TAIL + 0.03 });
    b.add(G.box(0.30, 0.16, 0.09), 0x14161a, { x: sx * 0.50, y: 0.26, z: NOSE - 0.06 });
    b.add(G.box(0.26, 0.14, 0.09), 0x14161a, { x: sx * (HW - 0.06), y: 0.56, z: -0.98 });
    b.add(G.cyl(0.05, 0.05, 0.14, 8), 0x6e737a, { x: sx * 0.20, y: 0.28, z: TAIL + 0.05, rx: Math.PI / 2 });
  }
  b.add(G.box(0.76, 0.07, 0.34), 0x14161a, { y: WAIST - 0.09, z: st.bonnet });            // bonnet vent

  // --- a stripe over the length of the car, so liveries read apart at speed
  if (st.cabin !== 'open') b.add(G.box(0.24, 0.02, 1.36), trim, { y: ROOF + 0.05, z: st.cabZ - 0.05 });
  b.add(G.box(0.22, 0.02, 0.60), trim, { y: WAIST - 0.09, z: st.bonnet });

  const shell = b.build(VC_MATERIAL_DS);
  root.add(shell);

  // Rendered after the shell and writing no depth, so the interior behind it
  // still draws. Tinted rather than clear — a windscreen you cannot see at all
  // looks like the car has had it knocked out.
  const glazing = gb.build(GLAZING);
  glazing.renderOrder = 2;
  root.add(glazing);

  // Lenses, unlit.
  root.add(lb.build(VC_UNLIT));

  // Tail lights on their own mesh with their own material, because they are
  // the one light on the car that changes: dim while you are driving, hard red
  // the moment the brakes go on. That is the signal you actually race off in a
  // pack, so it has to be visible and it has to be instant.
  const tb = new MeshBuilder();
  for (const sx of [-1, 1]) {
    tb.add(G.box(0.32, 0.10, 0.05), 0xff2a1c, { x: sx * 0.54, y: 0.60, z: TAIL - 0.01 });
  }
  const tailMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.34,
  });
  const tails = tb.build(tailMat);
  tails.userData.tailMaterial = tailMat;
  root.add(tails);
  root.userData.tails = tailMat;

  // --- the number, on both doors and the nose
  const tex = numberTexture(livery.num, 0x14161a, 0xf2f2ee);
  const numMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  for (const sx of [-1, 1]) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.52), numMat);
    plate.position.set(sx * (HW + 0.015), 0.52, 0.10);
    plate.rotation.y = sx * Math.PI / 2;
    root.add(plate);
  }
  const nose = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.44), numMat);
  nose.position.set(0, 0.61, 1.90);
  nose.rotation.x = -1.15;
  root.add(nose);

  // --- wheels, kept separate so they can be steered and spun
  const wheels = [];
  for (const spec of [
    { x: -TR, z: FZ, front: true }, { x: TR, z: FZ, front: true },
    { x: -TR, z: RZ, front: false }, { x: TR, z: RZ, front: false },
  ]) {
    const pivot = new THREE.Group();
    pivot.position.set(spec.x, WR, spec.z);
    const mesh = buildWheel(WR, spec.front ? 0.28 : 0.34, spec.front);
    pivot.add(mesh);
    root.add(pivot);
    wheels.push({ pivot, mesh, front: spec.front });
  }

  // A contact shadow. It does more for grounding the car than anything else.
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 1.06, 4.5),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.025;
  root.add(shadow);

  // --- a light bar, for the cars that are not in the race.
  //
  // Two halves that alternate rather than one bar that pulses: a police car
  // reads as a police car from the colours swapping side to side, and a single
  // flashing block reads as a warning triangle. Unlit and above one, so the
  // bloom chain picks them out of a night street the way it picks out a
  // window — which is most of what makes them visible at two hundred metres.
  if (livery.police) {
    const beacons = [];
    for (const [sx, col] of [[-1, 0xff2a1e], [1, 0x2a6bff]]) {
      const lens = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.13, 0.20),
        new THREE.MeshBasicMaterial({ color: col }),
      );
      lens.position.set(sx * 0.24, st.roof + 0.30, st.cabZ - 0.10);
      root.add(lens);
      beacons.push(lens);
    }
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(1.06, 0.10, 0.24),
      new THREE.MeshLambertMaterial({ color: 0x16191f }),
    );
    bar.position.set(0, st.roof + 0.22, st.cabZ - 0.10);
    root.add(bar);
    root.userData.beacons = beacons;
  }

  root.userData.wheels = wheels;
  root.userData.shell = shell;
  root.userData.shadow = shadow;
  root.userData.livery = livery;
  return root;
}
