// REDLINE — a race at the Circuit de Valmont.
//
// Sixteen cars, three laps, a standing start and a gearbox you have to work
// yourself. This file is the wiring: it builds the world, reads the keyboard,
// runs the race a fixed step at a time, and turns what the simulation reports
// into smoke, noise and numbers on the dash.

import * as THREE from 'three';
import { Track, TRACK_NAME } from './track.js';
import { Race } from './race.js';
import { Hud } from './hud.js';
import { ChaseCamera } from './camera.js';
import { FX } from './fx.js';
import { AudioFX } from './audio.js';
import { RACE, CAR, AI, SELECTABLE } from './defs.js';
import { CarSelect } from './carselect.js';
import { Driver } from './ai.js';
import { clamp, lerp, approach, lapTime, ordinal } from './utils.js';
import { Post } from './post.js';
import { loadCarModel } from './carload.js';
import { setCarTemplate, buildCar } from './carmodels.js';
import { runSelfTest } from './selftest.js';

const FIXED = 1 / 120;              // the physics runs at a fixed 120 Hz

class Game {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.3, 3000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // No tone mapping here: the scene renders into a half-float target as
    // linear light, and the post chain tone-maps at the end, after bloom has
    // had a chance to see how bright the bright things really are.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.post = new Post(this.renderer);
    document.getElementById('game').appendChild(this.renderer.domElement);

    this._sky();
    this._lamps();
    this.audio = new AudioFX();
    this.chase = new ChaseCamera(this.camera);

    this.started = false;
    // 'menu' -> 'select' -> racing. The select screen owns the canvas while it
    // is up, so the race behind it is not being drawn at all.
    this.picking = false;
    this.time = 0;
    this.accumulator = 0;
    this.keys = new Set();
    this.fastestLap = { time: Infinity, car: null };
    this.raceEnded = false;

    this._input();
    window.addEventListener('resize', () => this._resize());
    this._resize();
  }

  // The heavy half of setting up, run in stages with the thread handed back
  // between them so the loading screen can draw. `onStep` is told what is
  // being built and how far along it is.
  async load(onStep) {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const say = async (what, at) => { onStep(what, at); await frame(); };

    await say('the circuit', 0.05);
    this.track = new Track();
    await say('the ground', 0.15);

    const stages = this.track.build(this.scene);
    const total = 7;
    for (let k = 0; ; k++) {
      const step = stages.next();
      if (step.done) break;
      await say(step.value, 0.15 + (0.75 * (k + 1)) / total);
    }

    await say('the field', 0.94);
    this.fx = new FX(this.scene);
    this.race = new Race(this, this.track);
    this.hud = new Hud(this);
    this.select = new CarSelect(this.renderer);
    await say('ready', 1);
  }

  _sky() {
    // Night. The sky is not black — a city this size puts enough light into
    // the air that the horizon glows and only the top of the dome goes dark,
    // and that gradient is most of what makes it read as a city at night
    // rather than as a scene with the lights turned off.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1400, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          top: { value: new THREE.Color(0x05070f) },
          mid: { value: new THREE.Color(0x101a2e) },
          low: { value: new THREE.Color(0x3a3040) },
          glow: { value: new THREE.Color(0x6b4a32) },
        },
        vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
        fragmentShader: `
          varying vec3 vP; uniform vec3 top; uniform vec3 mid; uniform vec3 low; uniform vec3 glow;
          void main(){
            vec3 n = normalize(vP);
            float h = n.y;
            vec3 c = h > 0.06 ? mix(mid, top, pow(clamp(h,0.0,1.0), 0.45))
                              : mix(low, mid, clamp((h + 0.25) / 0.31, 0.0, 1.0));
            // Sodium light thrown up off the streets, strongest just above the
            // rooftops and gone by halfway up the sky.
            c += glow * pow(clamp(1.0 - abs(h) * 3.4, 0.0, 1.0), 2.0);
            // Enough noise to stop the gradient banding on a dark sky, where
            // banding is the one place it always shows.
            c += (fract(sin(dot(n.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.012;
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    sky.frustumCulled = false;
    this.scene.add(sky);

    // Stars, thinned out toward the horizon where the city glow drowns them.
    {
      const n = 900, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const y = Math.pow(Math.random(), 0.55);
        const r = Math.sqrt(1 - y * y);
        pos[i * 3] = Math.cos(a) * r * 1300;
        pos[i * 3 + 1] = y * 1300;
        pos[i * 3 + 2] = Math.sin(a) * r * 1300;
        const b = 0.35 + Math.random() * 0.65;
        const warm = Math.random() < 0.25;
        col[i * 3] = b * (warm ? 1 : 0.86);
        col[i * 3 + 1] = b * 0.9;
        col[i * 3 + 2] = b;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const stars = new THREE.Points(g, new THREE.PointsMaterial({
        size: 3.2, sizeAttenuation: false, vertexColors: true,
        transparent: true, opacity: 0.85, depthWrite: false, fog: false,
      }));
      stars.frustumCulled = false;
      this.scene.add(stars);
    }

    // Night air over a bay: it does not go far, and what it goes to is the
    // colour of the glow rather than of the sky overhead.
    this.scene.fog = new THREE.Fog(0x141a26, 90, 780);

    // A lit street, not a dark one. A city block at night with lamps every
    // thirty metres, lit windows on both sides and wet-looking asphalt is a
    // bright place — you can read a newspaper under a street light. So the
    // ambient here is doing the job headlights would otherwise do, and it is
    // sodium-coloured from below and moonlit from above, which is what keeps
    // it reading as night rather than as a dim afternoon.
    this.scene.add(new THREE.HemisphereLight(0x5a6f96, 0x3a2a1c, 1.55));
    // A low moon for the edges and the roofs.
    const moon = new THREE.DirectionalLight(0xb8c8ff, 0.75);
    moon.position.set(-340, 280, 240);
    this.scene.add(moon);
    // The sodium wash coming back up off the streets, which is what stops the
    // undersides of everything being solid black — and, coming from below the
    // horizon, what makes the light look like it is coming from the city.
    const wash = new THREE.DirectionalLight(0xffb877, 0.55);
    wash.position.set(120, -40, -180);
    this.scene.add(wash);
    // A second wash from the other side, so a car is not lit from one quarter
    // only as it goes round.
    const back = new THREE.DirectionalLight(0xffc890, 0.32);
    back.position.set(-160, 60, 220);
    this.scene.add(back);
  }

  // Real light from the street lamps, for the handful of them near enough to
  // matter.
  //
  // A decal on the road is a picture of light: it does not fall on the car, it
  // does not pick out the barrier, and on a slope it does not even reach. The
  // circuit has a couple of hundred lamps and no renderer will light a scene
  // with all of them, so keep a small pool of real lights and hand them to
  // whichever standards are closest to the camera each frame. You get genuine
  // falloff and genuine shading on everything nearby, at the cost of eight
  // lights rather than two hundred.
  _lamps() {
    this.lampLights = [];
    for (let i = 0; i < 8; i++) {
      const l = new THREE.PointLight(0xffc98a, 0, 46, 1.4);
      this.scene.add(l);
      this.lampLights.push(l);
    }
  }

  _placeLamps() {
    const all = this.track.lamps;
    if (!all || !all.length || !this.lampLights) return;
    const c = this.camera.position;
    // Partial selection rather than a full sort: only the nearest eight are
    // wanted and the list is two hundred long every frame.
    const near = [];
    for (const p of all) {
      const d = (p.x - c.x) ** 2 + (p.z - c.z) ** 2;
      if (d > 90 * 90) continue;
      if (near.length < this.lampLights.length) {
        near.push({ p, d });
        if (near.length === this.lampLights.length) near.sort((a, b) => a.d - b.d);
      } else if (d < near[near.length - 1].d) {
        near[near.length - 1] = { p, d };
        near.sort((a, b) => a.d - b.d);
      }
    }
    for (let i = 0; i < this.lampLights.length; i++) {
      const l = this.lampLights[i];
      const n = near[i];
      if (!n) { l.intensity = 0; continue; }
      l.position.set(n.p.x, n.p.y, n.p.z);
      // Faded out at the edge of the range, or a lamp being handed from one
      // light to the next pops as you drive past it.
      const t = clamp(1 - Math.sqrt(n.d) / 90, 0, 1);
      l.intensity = 260 * t * t;
    }
  }

  // --------------------------------------------------------------- input

  _input() {
    document.getElementById('start').addEventListener('click', () => this.openName());
    const nameBox = document.getElementById('name');
    const nameIn = document.getElementById('name-in');
    const takeName = () => {
      // Whatever they typed, trimmed and squashed to one line; empty falls
      // back to the car's own name, which is what it used to be always.
      const typed = nameIn.value.trim().replace(/\s+/g, ' ').toUpperCase();
      this.playerName = typed || null;
      nameBox.classList.remove('open');
      this.openSelect();
    };
    document.getElementById('name-go').addEventListener('click', takeName);
    nameIn.addEventListener('keydown', (e) => {
      e.stopPropagation();                       // not steering input
      if (e.code === 'Enter') takeName();
    });
    const panel = document.getElementById('settings');
    document.getElementById('settings-btn').addEventListener('click', () => panel.classList.add('open'));
    document.getElementById('settings-close').addEventListener('click', () => panel.classList.remove('open'));
    document.getElementById('set-vol').addEventListener('input', (e) => {
      this.audio.setVolume(Number(e.target.value) / 100);
    });
    document.getElementById('set-view').addEventListener('change', (e) => {
      while (this.chase.view !== Number(e.target.value)) this.chase.cycle();
    });
    document.getElementById('set-grade').addEventListener('change', (e) => {
      this.post.composite.uniforms.grade.value = Number(e.target.value);
    });
    document.getElementById('set-bloom').addEventListener('change', (e) => {
      this.post.composite.uniforms.bloomStrength.value = Number(e.target.value);
    });
    window.addEventListener('keydown', (e) => {
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (this.keys.has(e.code)) return;            // ignore auto-repeat
      this.keys.add(e.code);
      this._press(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Tab') this.hud.showAll = false;
      if (e.code === 'KeyL') this.chase.lookBack = false;
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  _press(code) {
    if (this.picking) {
      if (code === 'ArrowLeft' || code === 'KeyA') this._pick(-1, 0);
      else if (code === 'ArrowRight' || code === 'KeyD') this._pick(1, 0);
      else if (code === 'ArrowUp' || code === 'KeyW') this._pick(0, -1);
      else if (code === 'ArrowDown' || code === 'KeyS') this._pick(0, 1);
      else if (code === 'Enter' || code === 'Space') this.begin();
      return;
    }
    if (!this.started) {
      if (code === 'Enter' || code === 'Space') this.openName();
      return;
    }
    const v = this.race.player.vehicle;
    switch (code) {
      case 'ArrowUp': case 'KeyE': case 'ShiftRight':
        if (!v.autoShift && v.shiftUp()) this.audio.shift(true);
        break;
      case 'ArrowDown': case 'KeyQ': case 'ShiftLeft':
        if (!v.autoShift && v.shiftDown()) this.audio.shift(false);
        break;
      case 'KeyG':
        v.autoShift = !v.autoShift;
        this.hud.flashLap(v.autoShift ? 'AUTOMATIC GEARBOX' : 'MANUAL GEARBOX', 1.6);
        break;
      case 'KeyC':
        this.hud.flashLap(`CAMERA · ${this.chase.cycle()}`, 1.2);
        break;
      case 'KeyL': this.chase.lookBack = true; break;
      case 'Tab': this.hud.showAll = true; break;
      case 'KeyR': this.restart(); break;
      case 'KeyM': this.audio.setVolume(this.audio.volume > 0 ? 0 : 0.75); break;
      default: {
        // Number keys go straight to a gear, which is what a sequential box
        // with paddles does not let you do — but a keyboard should.
        const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].indexOf(code);
        if (n >= 0 && !v.autoShift) {
          const want = n + 1;
          if (want !== v.gear && v.shiftT <= 0) {
            const up = want > v.gear;
            v.gear = want;
            v.shiftT = v.spec.shiftTime;
            this.audio.shift(up);
          }
        }
        break;
      }
    }
  }

  // Keyboard pedals are digital, so they are ramped: pressing throttle takes a
  // moment to reach full, which is both kinder to the tyres and closer to what
  // an ankle does.
  _drivePlayer(dt) {
    const v = this.race.player.vehicle;
    if (!this.race.started || this.race.player.finished) {
      if (this.race.player.finished) {
        v.throttle = 0;
        v.brake = 0.35;
        v.steerInput *= 0.9;
      }
      return;
    }
    // Up and down are the gearbox, so the pedals are W and S alone. The two
    // are on separate paths anyway — a shift is an event, fired once on the
    // key going down, while a pedal is a state read every frame.
    const k = this.keys;
    const gas = k.has('KeyW');
    const brake = k.has('KeyS');
    const left = k.has('KeyA') || k.has('ArrowLeft');
    const right = k.has('KeyD') || k.has('ArrowRight');

    v.throttle = approach(v.throttle, gas ? 1 : 0, dt * (gas ? 5.5 : 9));
    v.brake = approach(v.brake, brake ? 1 : 0, dt * (brake ? 7 : 11));
    // Hold the brake at a standstill for half a second to select reverse — the
    // same gesture an automatic asks for, and unambiguous enough that the grid
    // hold does not accidentally mean it.
    if (brake && Math.abs(v.u) < 0.6) this.brakeHoldT = (this.brakeHoldT || 0) + dt;
    else if (!brake || v.u > 1) this.brakeHoldT = 0;
    v.wantReverse = (this.brakeHoldT || 0) > 0.55 && v.u < 0.6;
    v.handbrake = approach(v.handbrake, k.has('Space') ? 1 : 0, dt * (k.has('Space') ? 14 : 12));

    // Positive steering is a turn to the LEFT, because positive body-x is the
    // car's left. So A asks for +1 and D for -1.
    const want = (left ? 1 : 0) - (right ? 1 : 0);

    // A key has no travel, so the ramp has to supply the modulation a wrist
    // would. Winding lock ON gets slower the faster you go; letting go, and
    // winding lock the other way, stay quick — because those are the two
    // things you do to catch a slide, and slowing them would be the difference
    // between a save and a spin.
    const adding = want !== 0 && Math.sign(want) === Math.sign(v.steerInput || want);
    const ease = 1 / (1 + Math.abs(v.u) / 30);
    const rate = want === 0 ? 4.6 : adding ? 3.4 * ease : 6.5;
    v.steerInput = approach(v.steerInput, want, dt * rate);
  }

  // ------------------------------------------------------------ callbacks

  onLightsOut() {
    this.audio.lightsOut();
    this.hud.message('GO', '', 1.3);
  }

  // Something went over. A thump, a shake, and a shower of bits.
  onKnock(o, hit) {
    this.chase.bump(0.45 + hit * 0.65);
    this.audio.impact(0.35 + hit * 0.5);
    const y = this.race.player.loc ? this.race.player.loc.y : 0;
    this.fx.spark(o.x, y + 0.6, o.z, 0.5 + hit);
  }

  onLap(car, lap, time) {
    if (lap > RACE.laps) return;
    if (time < this.fastestLap.time && time > 5) {
      this.fastestLap = { time, car };
      if (car.isPlayer) this.hud.flashLap(`FASTEST LAP · ${lapTime(time)}`, 3);
    }
    if (!car.isPlayer) return;
    // Same off-by-one as the board had: `lap` is already the lap now beginning.
    if (lap === RACE.laps) this.hud.message('FINAL LAP', '', 2.4);
    else this.hud.message(`LAP ${lap}`, lapTime(time) === '--:--.---' ? '' : lapTime(time), 1.8);
  }

  onFinish(car) {
    if (car.isPlayer) {
      this.audio.chequered();
      this.hud.message('CHEQUERED FLAG', `${ordinal(car.position)} PLACE`, 4);
    }
    if (!this.raceEnded && this.race.order[0] === car) this.raceEnded = true;
  }

  onImpact(car, force) {
    if (force < 1.2) return;
    this.audio.impact(force * 1.2);
    this.fx.spark(car.vehicle.x, 0.4, car.vehicle.z, force);
    if (car.isPlayer) this.chase.bump(clamp(force / 7, 0.15, 1.4));
  }

  // --------------------------------------------------------------- flow

  // The title screen hands over to the car select, which hands over to the
  // race. Choosing a car swaps the player's model for the chosen one; nothing
  // else about the car changes, because there is one set of physics.
  // Start goes here first: who is driving, then which car.
  openName() {
    if (this.started || this.picking) return;
    const box = document.getElementById('name');
    box.classList.add('open');
    const input = document.getElementById('name-in');
    if (this.playerName) input.value = this.playerName;
    input.focus();
    input.select();
    this.audio.unlock();
  }

  openSelect() {
    if (this.started || this.picking) return;
    this._endAttract();
    this.picking = true;
    document.getElementById('menu').style.display = 'none';
    document.getElementById('select').classList.add('open');
    this.select.show();
    this.audio.unlock();
    this._pick(0, 0);
  }

  _pick(dx, dy) {
    const moved = dx || dy;
    const livery = moved ? this.select.move(dx, dy) : this.select.chosen;
    document.getElementById('sel-name').textContent = livery.name;
    // A count rather than a row of dots. Twenty-two dots is not something
    // anybody reads; "07 / 22" is.
    const n = SELECTABLE.length;
    document.getElementById('sel-dots').textContent =
      `${String(this.select.index + 1).padStart(2, '0')} / ${n}`;
    if (moved) this.audio.shift(dx + dy > 0);
  }

  setPlayerCar(livery) {
    // Remembered, so the field builder can leave this one out when the grid is
    // formed rather than putting two of the same car on it.
    this.playerLivery = livery;
    this.race.avoidDuplicate(livery);
    const car = this.race.player;
    // The driver's name, not the car's. It was locked to whichever livery had
    // been picked, so every player was called GT COUPE.
    car.name = this.playerName || livery.name;
    this.scene.remove(car.model);
    car.livery = livery;
    car.number = livery.num;
    car.model = buildCar(livery);
    car.model.rotation.order = 'YXZ';
    this.scene.add(car.model);
    car.syncModel(this.track);
  }

  begin() {
    if (this.started) return;
    if (this.picking) {
      this.setPlayerCar(this.select.chosen);
      this.select.hide();
      document.getElementById('select').classList.remove('open');
      this.picking = false;
    }
    this.started = true;
    // Whatever was held down to get here is not a driving input.
    this.keys.clear();
    document.getElementById('menu').style.display = 'none';
    this.hud.show();
    this.audio.unlock();
  }

  restart() {
    this.fx.clear();
    this.race.gridUp();
    this.fastestLap = { time: Infinity, car: null };
    this.raceEnded = false;
    this.hud.hideResults();
    this.hud.message('', '', 0);
    this.chase.started = false;
  }

  // -------------------------------------------------------------- update

  update(dt) {
    this.time += dt;
    if (this.picking) {
      this.select.update(dt, this.camera.aspect);
      return;
    }
    if (!this.started) {
      // The title screen is a cutscene, not a still.
      //
      // The field is already built and the AI already knows how to drive, so
      // rather than animate something specially, the race is simply run behind
      // the menu with every car including the player's under AI control, and
      // the camera cuts between close shots of one of them. Press START and
      // the grid is re-formed from scratch, so nothing that happened during
      // the attract loop carries into the race.
      this._attract(dt);
      return;
    }

    const before = this.race.state;
    const lights = this.race.lights;

    this._drivePlayer(dt);

    // Fixed-step physics: a car simulation that changes behaviour with the
    // frame rate is not a simulation.
    this.accumulator = Math.min(this.accumulator + dt, 0.25);
    while (this.accumulator >= FIXED) {
      this.race.update(FIXED);
      this.accumulator -= FIXED;
    }
    // Whatever time is left over is where this frame actually falls between
    // the last two steps. Hand it to the models so they are drawn there.
    this.race.sync(this.accumulator / FIXED);

    if (this.race.lights !== lights && this.race.state === 'countdown') this.audio.light();
    if (before !== 'finished' && this.race.state === 'finished') this.hud.results(this.race);

    this.track.update(this.time, dt);
    this._trackFx(dt);
    this.fx.update(dt);
    this.chase.update(dt, this.race.player);
    // After the camera has moved, so the lights are chosen for where the
    // frame is actually being drawn from.
    this._placeLamps();
    this.hud.lights(this.race.lights);
    this.hud.update(dt);

    const near = this._nearestRival();
    this.audio.update(dt, this.race.player, near.car, near.dist);

    // Once the leader has taken the flag, give everyone else a few seconds and
    // then show the result whether or not the tail-enders are home.
    if (this.raceEnded && this.race.state === 'racing') {
      this._endTimer = (this._endTimer || 0) + dt;
      if (this._endTimer > 12) {
        this.race.state = 'finished';
        this.hud.results(this.race);
      }
    }
  }

  // The title-screen loop: the field drives itself, the camera watches one car.
  _attract(dt) {
    const race = this.race;
    if (!this._attracting) {
      this._attracting = true;
      race.state = 'racing';
      race.lights = 5;
      // The player's car has no driver of its own — it has a player. Lend it
      // one for the duration.
      const p = race.player;
      if (!p.driver) p.driver = new Driver(p, this.track, AI.maxSkill);
      p.vehicle.autoShift = true;
      // One car on screen, and one only.
      //
      // Cars phase through each other by design — that is the collision model
      // the game asked for — which nobody notices at racing distance in the
      // middle of a pack and everybody notices in a close-up. So the rest of
      // the field is hidden for the duration. They are still simulated, which
      // costs nothing worth saving and means the one car on screen is being
      // driven round a real race rather than round an empty track.
      this._star = race.cars[Math.floor(race.cars.length * 0.35)];
      for (const c of race.cars) c.model.visible = c === this._star;
    }
    this.accumulator = Math.min(this.accumulator + dt, 0.25);
    while (this.accumulator >= FIXED) {
      race.update(FIXED);
      this.accumulator -= FIXED;
    }
    race.sync(this.accumulator / FIXED);
    this.track.update(this.time, dt);
    this._placeLamps();
    this.fx.update(dt);
    this.chase.cinematic(dt, this._star, this.time);
  }

  // Put the field back the way it was before the attract loop ran on it.
  _endAttract() {
    if (!this._attracting) return;
    this._attracting = false;
    for (const c of this.race.cars) c.model.visible = true;
    const p = this.race.player;
    p.driver = null;
    p.vehicle.autoShift = false;
    this.race.gridUp();
    this.fx.clear();
    this.chase.started = false;
  }

  // Rubber, smoke and dust, for every car close enough to see.
  _trackFx(dt) {
    const camPos = this.camera.position;
    for (const car of this.race.cars) {
      const v = car.vehicle;
      const dx = v.x - camPos.x, dz = v.z - camPos.z;
      if (dx * dx + dz * dz > 200 * 200) continue;
      const y = car.loc ? car.loc.y : 0;
      const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
      for (const w of v.wheelPositions()) {
        const wx = v.x + w.x * c + w.z * s;
        const wz = v.z - w.x * s + w.z * c;
        const slip = w.front ? v.slipF : v.slipR;
        const key = `${car.number}:${w.x}:${w.z}`;
        if (v.onTrack && slip > 1.06 && v.speed > 3) {
          this.fx.skid(key, wx, y, wz, 0.34, v.forwardX, v.forwardZ, (slip - 1.0) * 1.6);
          if (!w.front && slip > 1.45 && Math.random() < dt * 34) {
            this.fx.smoke(wx, y, wz, clamp(slip - 1.4, 0, 1));
          }
        } else {
          this.fx.markLast.delete(key);
        }
        if (!v.onTrack && v.speed > 6 && Math.random() < dt * 26) this.fx.dust(wx, y, wz, 1);
      }
    }
  }

  _nearestRival() {
    const p = this.race.player.vehicle;
    let car = null, dist = Infinity;
    for (const c of this.race.cars) {
      if (c.isPlayer) continue;
      const d = Math.hypot(c.vehicle.x - p.x, c.vehicle.z - p.z);
      if (d < dist) { dist = d; car = c; }
    }
    return { car, dist };
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.post.setSize(w, h);
  }

  render(dt = 0) {
    if (this.picking) {
      this.post.render(this.select.scene, this.select.camera, dt);
      return;
    }
    this.post.render(this.scene, this.camera, dt);
  }
}

// ------------------------------------------------------------------ boot

// If there is a car model in assets/, every car uses it. This has to happen
// before the field is built, so it is awaited at the top level of the module —
// and it fails quietly, because a missing file is the normal case.
setCarTemplate(await loadCarModel());

// Let the loading screen paint and its animation start before the city is
// built. Building it blocks the main thread for a second or two, and a browser
// that has not yet drawn a frame will show nothing at all for that time — a
// black screen with two buttons on it, which is what this looked like.
await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

const game = new Game();

// Built in stages, with the loading screen updated between each. Doing it in
// the constructor meant one unbroken block of work during which the browser
// could not paint at all — which is why the loading bar never moved.
{
  const load = document.getElementById('loading');
  const label = document.getElementById('load-what');
  const ring = document.getElementById('load-ring');
  await game.load((what, at) => {
    if (label) label.textContent = what.toUpperCase();
    if (ring) ring.style.setProperty('--at', String(at));
  });
  if (load) {
    load.classList.add('done');
    setTimeout(() => { load.style.display = 'none'; }, 500);
  }
  document.getElementById('menu').classList.add('ready');
}

window.game = game;
void TRACK_NAME; void CAR; void lerp;

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  game.update(dt);
  game.render(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const params = new URLSearchParams(location.search);
if (params.has('test')) runSelfTest(game, Number(params.get('test')) || 30);
