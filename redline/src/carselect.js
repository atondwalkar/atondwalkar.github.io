// The car-select screen.
//
// A grid: every car in the game laid out at once, seen three-quarters on, with
// the chosen one lit and the rest greyed back. Arrow keys move around it.
//
// It was a carousel — the chosen car turning slowly in the middle with a
// neighbour either side and everything else off screen. That is fine for six
// cars and useless for twenty-two: you cannot see what you are choosing
// between, only what is next to what you have got, so picking a car means
// scrolling the whole list and remembering it. A grid shows you the field.
//
// It renders into the same canvas as the race, from its own scene, so it costs
// nothing while a race is running and needs no second renderer.

import * as THREE from 'three';
import { buildCar } from './carmodels.js';
import { SELECTABLE } from './defs.js';
import { clamp, damp } from './utils.js';

const COLS = 6;
const STEP_X = 5.6;              // metres between cars across the grid
const STEP_Z = 7.4;              // and down it — a car is four and a half long
const FACING = -0.62;            // three-quarters on, and the same for all of them
// How far an unchosen car is knocked back. Not as far as it looks like it
// should go: the field includes cars that are nearly black to start with, and
// dimming those as hard as a white one leaves a hole in the grid where a car
// should be. Enough to read as unselected, not enough to disappear.
const OFF_DIM = 0.66;
const OFF_GREY = 0.72;
const PICKED_SCALE = 1.14;

export class CarSelect {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    // A background of its own. Without one the scene renders transparent —
    // there is no sky dome here to fill the frame the way the race has — and
    // what you get is whatever was behind the canvas, which is nothing.
    this.scene.background = new THREE.Color(0x0b0f14);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
    this.index = 0;
    this.active = false;
    this.rows = Math.ceil(SELECTABLE.length / COLS);

    this.scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x30343a, 2.1));
    const key = new THREE.DirectionalLight(0xfff3e0, 2.3);
    key.position.set(-6, 11, 9);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7fb0e0, 1.5);
    rim.position.set(8, 5, -9);
    this.scene.add(rim);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      // Light enough that a near-black car still has an edge against it. Two
      // of the field are all but black to start with, and on a floor as dark
      // as they are they leave a hole in the grid rather than a car.
      new THREE.MeshLambertMaterial({ color: 0x2b323c }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    this.scene.add(floor);

    // The ring marks the chosen car and slides to it, which is the only thing
    // on this screen that moves.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.6, 2.95, 48),
      new THREE.MeshBasicMaterial({ color: 0xe8452f, transparent: true, opacity: 0.85 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    this.scene.add(ring);
    this.ring = ring;
    this.ringAt = new THREE.Vector2();

    this.cars = SELECTABLE.map((livery, i) => {
      const model = buildCar(livery);
      model.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        o.material = o.material.clone();
        // The cars carry their colour in the vertices, not the material, so
        // tinting the material can only darken them — a dark red car is still
        // a red car. Draining the colour has to happen where the vertex colour
        // is read, so each material gets a uniform and one line of shader that
        // mixes it toward its own brightness.
        const grey = { value: 0 };
        o.material.userData.grey = grey;
        o.material.onBeforeCompile = (shader) => {
          shader.uniforms.uGrey = grey;
          shader.fragmentShader = shader.fragmentShader
            .replace('void main() {', 'uniform float uGrey;\nvoid main() {')
            .replace('#include <color_fragment>', `#include <color_fragment>
              diffuseColor.rgb = mix(diffuseColor.rgb,
                vec3(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114))), uGrey);`);
        };
      });
      model.rotation.y = FACING;                // no spin: every car sits still
      const pivot = new THREE.Group();
      pivot.add(model);
      const at = this.slotOf(i);
      pivot.position.set(at.x, 0, at.z);
      this.scene.add(pivot);
      return { livery, model, pivot };
    });

    // Framed so the whole grid is on screen at once — every car, always. That
    // is the entire point of laying them out in a grid.
    const span = this.rows * STEP_Z;
    const wide = COLS * STEP_X;
    this.centre = new THREE.Vector3(0, 0, span / 2 - STEP_Z / 2);
    // Far enough back to clear the wider of the two dimensions, with room for
    // the last row to sit above the bottom edge.
    const reach = Math.max(span * 0.60, wide * 0.50) + 9;
    this.eye = new THREE.Vector3(0, 5.5 + reach * 0.66, this.centre.z + reach * 1.12);
  }

  slotOf(i) {
    const col = i % COLS, row = Math.floor(i / COLS);
    // The last row is usually short; centre it under the rest rather than
    // leaving it hanging off to the left.
    const inRow = Math.min(COLS, SELECTABLE.length - row * COLS);
    return { x: (col - (inRow - 1) / 2) * STEP_X, z: row * STEP_Z };
  }

  get chosen() { return this.cars[this.index].livery; }

  show() {
    this.active = true;
    const at = this.slotOf(this.index);
    this.ringAt.set(at.x, at.z);
  }

  hide() { this.active = false; }

  // dx moves across the grid, dy down it. Both clamp rather than wrap: a list
  // that wraps round makes it impossible to tell you have reached the end.
  move(dx, dy) {
    const n = SELECTABLE.length;
    let col = this.index % COLS, row = Math.floor(this.index / COLS);
    if (dx) col = clamp(col + dx, 0, Math.min(COLS, n - row * COLS) - 1);
    if (dy) {
      row = clamp(row + dy, 0, this.rows - 1);
      col = Math.min(col, Math.min(COLS, n - row * COLS) - 1);
    }
    this.index = clamp(row * COLS + col, 0, n - 1);
    return this.cars[this.index].livery;
  }

  update(dt, aspect) {
    if (!this.active) return;

    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      const on = i === this.index;
      c.pivot.scale.setScalar(on ? PICKED_SCALE : 1);
      const dim = on ? 1 : OFF_DIM;
      const grey = on ? 0 : OFF_GREY;
      c.model.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        if (o.material.color) o.material.color.setScalar(dim);
        if (o.material.userData.grey) o.material.userData.grey.value = grey;
      });
    }

    const at = this.slotOf(this.index);
    this.ringAt.x = damp(this.ringAt.x, at.x, 14, dt);
    this.ringAt.y = damp(this.ringAt.y, at.z, 14, dt);
    this.ring.position.set(this.ringAt.x, 0.01, this.ringAt.y);

    // The camera does not move. It leaned toward whichever car was chosen,
    // which gave the grid some parallax and also meant the whole thing shifted
    // every time you pressed a key — on a screen whose entire purpose is to
    // let you compare twenty-two cars against each other, nothing should move
    // except the marker saying which one you are on.
    this.camera.aspect = aspect;
    this.camera.position.copy(this.eye);
    // Aimed a little short of the middle: perspective puts the near row lower
    // in frame than the far one, so aiming dead centre crops the front of the
    // grid off the bottom edge.
    this.camera.lookAt(this.centre.x, 0.5, this.centre.z + 2.2);
    this.camera.updateProjectionMatrix();
  }

  render() {
    if (!this.active) return;
    this.renderer.render(this.scene, this.camera);
  }
}
