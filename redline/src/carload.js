// Loading a car model from a file.
//
// The built-in cars are built from primitives, which keeps the project free of
// assets but caps how good they can look. This is the way out: drop a glTF or
// GLB file in assets/ and the whole field uses it instead.
//
// Nothing is bundled, because the good-looking car models are somebody's
// property — the game ones are owned by their publishers, and the cars
// themselves are licensed from the manufacturers who made them. Use something
// you have the right to use. There is plenty released under CC0.
//
// What the file has to provide:
//
//   * the car facing +z, or +x with `turn: 90` in the manifest;
//   * four wheels as their own nodes, named so they can be found — anything
//     with "wheel", "tyre", "tire" or "rim" in the name will do. They are
//     re-parented onto pivots so the fronts steer and both axles spin at their
//     own rate, which is how you see the handbrake lock the rear;
//   * any scale at all. It is measured and resized so its wheelbase matches
//     the car the physics is simulating, because a model that disagrees with
//     the simulation about where its wheels are will not sit on the road.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CAR } from './defs.js';

const WHEEL_NAME = /wheel|tyre|tire|rim/i;
// A steering wheel is a wheel by name and nothing else. Real models are full
// of things like this, which is why matching on the name alone is not enough.
const NOT_A_WHEEL = /steer|spare|fifth/i;
// Materials that are plainly not paintwork. A real car model separates these
// out, and tinting the glass and the badges along with the bodywork is what
// makes a repainted model look like a boiled sweet.
const NOT_PAINT = /glass|window|light|lamp|badge|logo|decal|tyre|tire|rubber|carbon|chrome|mirror|grill|rotor|disc|caliper|interior|int_|seat|belt/i;
const IS_PAINT = /body|paint|ext|chassis|shell|livery|car_?paint/i;

// Load assets/car.glb if it is there. Returns null if it is not, or if it
// cannot be used — the game falls back to the built-in cars either way, so a
// missing or broken file costs a log line and nothing else.
export async function loadCarModel(url = './assets/car.glb', timeoutMs = 8000) {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) return null;
  } catch (e) {
    return null;
  }
  const loader = new GLTFLoader();
  const gltf = await Promise.race([
    loader.loadAsync(url),
    new Promise((_, bad) => setTimeout(() => bad(new Error('timed out')), timeoutMs)),
  ]).catch((e) => {
    console.warn(`car model ${url}: ${e.message}`);
    return null;
  });
  if (!gltf) return null;
  try {
    return normalise(gltf.scene);
  } catch (e) {
    console.warn(`car model ${url}: ${e.message}`);
    return null;
  }
}

// Take whatever came out of the file and make it into the shape the rest of
// the game expects: sitting on y = 0, facing +z, sized to the simulated
// wheelbase, with its wheels on pivots.
function normalise(scene) {
  const root = new THREE.Group();
  root.add(scene);

  // --- find the wheels before anything is moved.
  //
  // Not by picking four tidily-named nodes: a real model splits each corner
  // into a tyre and a rim, sometimes a brake disc and a caliper too, and calls
  // the lot something like LOD_A_TYRE_REAR_mm_tyre. So gather everything that
  // looks like part of a wheel and group it by where it actually is — four
  // corners, found by position, however many meshes each turns out to contain.
  const parts = [];
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const name = `${o.name || ''} ${o.parent ? o.parent.name || '' : ''}`;
    if (!WHEEL_NAME.test(name) || NOT_A_WHEEL.test(name)) return;
    parts.push({ mesh: o, at: new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()) });
  });

  // --- orient. A model built facing +x or -z is common enough to be worth
  // detecting rather than demanding the user fix it: the car is longer than it
  // is wide, so whichever horizontal axis is longer is the one it faces.
  let box = new THREE.Box3().setFromObject(scene);
  let size = box.getSize(new THREE.Vector3());
  if (size.x > size.z) {
    scene.rotation.y = Math.PI / 2;
    scene.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(scene);
    size = box.getSize(new THREE.Vector3());
  }

  // --- scale to the wheelbase if the wheels were found, or to overall length
  // if they were not. The wheelbase is the better measure: it is the number
  // the physics actually uses.
  let scale;
  if (parts.length >= 2) {
    const zs = parts.map((p) => new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3()).z);
    const span = Math.max(...zs) - Math.min(...zs);
    scale = span > 0.2 ? CAR.wheelbase / span : 4.6 / size.z;
  } else {
    scale = 4.6 / size.z;
  }
  scene.scale.multiplyScalar(scale);
  scene.updateMatrixWorld(true);

  // --- sit it on the ground, centred between the axles
  box = new THREE.Box3().setFromObject(scene);
  const centre = box.getCenter(new THREE.Vector3());
  scene.position.x -= centre.x;
  scene.position.z -= centre.z;
  scene.position.y -= box.min.y;
  scene.updateMatrixWorld(true);

  // --- re-parent each corner's meshes onto one pivot, so the fronts steer
  // and each axle spins at its own rate.
  const rigged = [];
  if (parts.length) {
    for (const p of parts) p.at.copy(new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3()));
    // Split front from rear and left from right about the car's own middle.
    const mid = (key) => {
      const vs = parts.map((p) => p.at[key]).sort((a, b) => a - b);
      return (vs[0] + vs[vs.length - 1]) / 2;
    };
    const mz = mid('z'), mx = mid('x');
    const corners = new Map();
    for (const p of parts) {
      const key = `${p.at.z > mz ? 'F' : 'R'}${p.at.x > mx ? 'R' : 'L'}`;
      if (!corners.has(key)) corners.set(key, []);
      corners.get(key).push(p);
    }
    for (const [key, group] of corners) {
      const centre = new THREE.Vector3();
      for (const p of group) centre.add(p.at);
      centre.divideScalar(group.length);

      // A pivot to steer on, and a spinner inside it to roll on, so the two
      // rotations cannot fight each other.
      const pivot = new THREE.Group();
      pivot.position.copy(centre);
      root.add(pivot);
      const spinner = new THREE.Group();
      pivot.add(spinner);

      // attach(), not add(). A wheel here is several meshes deep inside a
      // hierarchy that has its own rotations and scales, so its local position
      // means nothing on its own — subtracting a world-space centre from it,
      // which is what this did at first, left two of the four corners hanging
      // in the air beside the car. attach() re-parents while preserving the
      // world transform, and works that arithmetic out properly.
      for (const p of group) spinner.attach(p.mesh);
      rigged.push({ pivot, mesh: spinner, front: key[0] === 'F' });
    }
  }

  // A model whose wheels could not be told apart still gets a car; it just has
  // wheels that do not turn, which is better than no car.
  root.userData.wheels = rigged.length === 4 ? rigged : [];
  root.userData.external = true;
  root.userData.paintable = findPaintable(scene);
  return root;
}

// Which materials are the paintwork, so the liveries can still be applied.
// Named materials are believed first — a model that calls something BODY or
// CHASSIS is telling you what it is — and only if nothing is named usefully
// does this fall back to guessing at the largest bright material.
function findPaintable(scene) {
  const area = new Map();
  scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const n = o.geometry ? o.geometry.attributes.position.count : 0;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m.color) area.set(m, (area.get(m) || 0) + n);
    }
  });
  const named = [...area.keys()].filter(
    (m) => IS_PAINT.test(m.name || '') && !NOT_PAINT.test(m.name || ''));
  if (named.length) return named;

  let best = null, most = 0;
  for (const [m, n] of area) {
    if (NOT_PAINT.test(m.name || '')) continue;
    const l = m.color.r + m.color.g + m.color.b;
    if (l < 0.25) continue;
    if (m.transparent && m.opacity < 0.9) continue;
    if (n > most) { most = n; best = m; }
  }
  return best ? [best] : [];
}
