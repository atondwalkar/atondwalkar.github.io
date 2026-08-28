// REDLINE — a race at the Circuit de Valmont.
//
// Sixteen cars, three laps, a standing start and a gearbox you have to work
// yourself. This file is the wiring: it builds the world, reads the keyboard,
// runs the race a fixed step at a time, and turns what the simulation reports
// into smoke, noise and numbers on the dash.

import * as THREE from 'three';
import { Track, LAYOUTS, disposeTrack, TRACK_NAME } from './track.js';
import { Race, defaultField } from './race.js';
import { Hud } from './hud.js';
import { ChaseCamera } from './camera.js';
import { FX } from './fx.js';
import { AudioFX } from './audio.js';
import { RACE, CAR, AI, SELECTABLE } from './defs.js';
import { CarSelect } from './carselect.js';
import { Driver } from './ai.js';
import { Cutscene, SCRIPTS } from './cutscene.js';
import { Campaign, STAGES } from './campaign.js';
import { findCheat } from './cheats.js';
import { TouchControls, looksLikeTouch } from './touch.js';
import { ACTIONS, actionFor, codesFor, isBound, rebind, resetBinds, label } from './keybinds.js';
import { clamp, lerp, approach, lapTime, ordinal, dist2D } from './utils.js';
import { Post } from './post.js';
import { loadCarModel } from './carload.js';
import { setCarTemplate, buildCar } from './carmodels.js';
import { runSelfTest } from './selftest.js';

const FIXED = 1 / 120;              // the physics runs at a fixed 120 Hz

// What the game is doing. `attract` is the title cutscene, `select` is the car
// grid, `cutscene` is a scripted scene between campaign stages, `racing` is
// the race. The name box and the settings panel are deliberately not phases:
// they are overlays that leave whatever is behind them running.
// The sky dome and the star shell. Both ride with the camera, so these are
// distances from the VIEWER, not from the middle of the map: far enough out to
// sit beyond the fog and well inside the camera's 3000 m far plane.
// How long the opening slow motion lasts and how slow it gets.
const SLOWMO_TIME = 1.6;
const SLOWMO_MIN = 0.32;

// The night sky the game has always had, as data so a layout can override it.
const SKY_NIGHT = { top: 0x05070f, mid: 0x101a2e, low: 0x3a3040, glow: 0x6b4a32 };

const SKY_R = 2400;
const STAR_R = 2200;

const PHASE = { ATTRACT: 'attract', SELECT: 'select', CUTSCENE: 'cutscene', RACING: 'racing' };
const MODE = { RACE: 'race', CAMPAIGN: 'campaign' };

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

    // One state, read in one place.
    //
    // This was three booleans — started, picking, _attracting — read in
    // priority order in three separate ladders, where the ordering was
    // load-bearing and nothing enforced it. A fourth state (a cutscene) would
    // have made that ladder four deep in three places. `started` and `picking`
    // survive as accessors below because the smoke test assigns to them.
    this.phase = PHASE.ATTRACT;
    this.mode = MODE.RACE;
    // 'menu' -> 'select' -> racing. The select screen owns the canvas while it
    // is up, so the race behind it is not being drawn at all.
    this.time = 0;
    this.accumulator = 0;
    this.keys = new Set();
    // Actions currently held by a finger on the screen.
    this.touch = new Set();
    this.fastestLap = { time: Infinity, car: null };
    this.raceEnded = false;

    this._input();
    window.addEventListener('resize', () => this._resize());
    this._resize();
  }

  // Kept so the smoke test — which assigns `game.started` to drive the frame
  // dumps — keeps working, and so the read sites elsewhere read as English.
  get started() { return this.phase === PHASE.RACING; }
  set started(on) { this.phase = on ? PHASE.RACING : PHASE.ATTRACT; }

  get picking() { return this.phase === PHASE.SELECT; }
  set picking(on) {
    if (on) this.phase = PHASE.SELECT;
    else if (this.phase === PHASE.SELECT) this.phase = PHASE.ATTRACT;
  }

  // The heavy half of setting up, run in stages with the thread handed back
  // between them so the loading screen can draw. `onStep` is told what is
  // being built and how far along it is.
  async load(onStep) {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const say = async (what, at) => { onStep(what, at); await frame(); };

    await say('the circuit', 0.05);
    await this.buildTrack(LAYOUTS.folsom, say);

    await say('the field', 0.94);
    this.fx = new FX(this.scene);
    this.race = new Race(this, this.track);
    this.hud = new Hud(this);
    this.select = new CarSelect(this.renderer);
    await say('ready', 1);
  }

  // Put a layout in the world, taking down whatever was there.
  //
  // Staged the same way the first load is, and for the same reason: building a
  // city is a second or two of one blocked thread, and between stages is the
  // only time the loading screen gets to draw. `say` is optional so a swap
  // between stages can happen behind a cutscene without a loading screen.
  async buildTrack(layout, say = null) {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    if (this.track) {
      disposeTrack(this.scene, this.track);
      // The lamp lights belong to the old street furniture.
      for (const l of this.lampLights || []) l.intensity = 0;
    }
    this.track = new Track(layout);
    // Fog is a property of the place, not of the game.
    //
    // Ninety to seven hundred and eighty metres is right for a street circuit
    // where the next block is the horizon. Over open water at night it is
    // wrong twice over: it hides an eleven-kilometre bridge from six hundred
    // metres away, and it turns everything past that into one flat colour —
    // which is what "blank canvas" looks like from the middle of the bay.
    const f = layout.fog || { near: 90, far: 780 };
    this.scene.fog.near = f.near;
    this.scene.fog.far = f.far;
    this.scene.fog.color.setHex(f.colour ?? 0x141a26);
    // The sky is a property of the place too. The shader has always taken
    // exactly these four colours; they were simply hard-coded to night.
    const skyC = layout.sky || SKY_NIGHT;
    const u = this.sky.material.uniforms;
    u.top.value.setHex(skyC.top);
    u.mid.value.setHex(skyC.mid);
    u.low.value.setHex(skyC.low);
    u.glow.value.setHex(skyC.glow);
    if (say) await say('the ground', 0.15);

    const stages = this.track.build(this.scene);
    const total = 7;
    for (let k = 0; ; k++) {
      const step = stages.next();
      if (step.done) break;
      if (say) await say(step.value, 0.15 + (0.75 * (k + 1)) / total);
      else await frame();
    }
    // Everything that cached a position on the old circuit has to be told.
    if (this.race) this.race.setTrack(this.track);
    if (this.hud) this.hud.trackChanged();
    return this.track;
  }

  _sky() {
    // Night. The sky is not black — a city this size puts enough light into
    // the air that the horizon glows and only the top of the dome goes dark,
    // and that gradient is most of what makes it read as a city at night
    // rather than as a scene with the lights turned off.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_R, 28, 18),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          top: { value: new THREE.Color(SKY_NIGHT.top) },
          mid: { value: new THREE.Color(SKY_NIGHT.mid) },
          low: { value: new THREE.Color(SKY_NIGHT.low) },
          glow: { value: new THREE.Color(SKY_NIGHT.glow) },
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
    this.sky = sky;

    // Stars, thinned out toward the horizon where the city glow drowns them.
    {
      const n = 1600, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const y = Math.pow(Math.random(), 0.55);
        const r = Math.sqrt(1 - y * y);
        pos[i * 3] = Math.cos(a) * r * STAR_R;
        pos[i * 3 + 1] = y * STAR_R;
        pos[i * 3 + 2] = Math.sin(a) * r * STAR_R;
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
      this.stars = stars;
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
    document.getElementById('start').addEventListener('click', () => {
      this.mode = MODE.RACE;
      this.campaign = null;
      this.openName();
    });
    document.getElementById('campaign-btn').addEventListener('click', () => this.startCampaign());
    this._cheatPanel();
    this.touchUI = new TouchControls(this);
    this._touchSetting();
    this._settingsTabs();
    this._bindPanel();
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
    // The yellow-green wash, on a switch.
    //
    // It was already here and already worked, under the label COLOUR GRADE —
    // which is what it is and not what it looks like, so nobody found it. A
    // setting nobody can find is a setting that does not exist.
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
      if (isBound('standings', e.code)) this.hud.showAll = false;
      if (isBound('lookBack', e.code)) this.chase.lookBack = false;
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.touch.clear(); });
  }

  _press(code) {
    if (this.phase === PHASE.CUTSCENE) {
      if (code === 'Space' || code === 'Enter' || code === 'Escape') this.cut.skip();
      return;
    }
    if (this.phase === PHASE.SELECT) {
      if (code === 'ArrowLeft' || code === 'KeyA') this._pick(-1, 0);
      else if (code === 'ArrowRight' || code === 'KeyD') this._pick(1, 0);
      else if (code === 'ArrowUp' || code === 'KeyW') this._pick(0, -1);
      else if (code === 'ArrowDown' || code === 'KeyS') this._pick(0, 1);
      else if (code === 'Enter' || code === 'Space') this.begin();
      return;
    }
    if (this.phase === PHASE.ATTRACT) {
      if (code === 'Enter' || code === 'Space') this.openName();
      // Every scene, playable from the title screen without racing to it.
      // Written before any campaign flow existed, because a cutscene that is
      // only reachable by winning a three-lap race is a cutscene nobody tests.
      else if (code === 'KeyK') this.debugCutscene();
      return;
    }
    const act = actionFor(code);
    if (act) { this.doAction(act); return; }
    this.doAction(null, code);
  }

  // What an action DOES, separated from what pressed it.
  //
  // Every one of these used to be a `case` on a key literal. Routing them
  // through the action name let the settings screen rebind them; routing them
  // through one method lets a thumb on a screen do the same thing a key does,
  // rather than the touch controls growing a second copy of the gearbox.
  doAction(id, code = null) {
    const v = this.race.player.vehicle;
    switch (id) {
      case 'shiftUp':
        if (!v.autoShift && v.shiftUp()) this.audio.shift(true);
        break;
      case 'shiftDown':
        if (!v.autoShift && v.shiftDown()) this.audio.shift(false);
        break;
      case 'gearbox':
        v.autoShift = !v.autoShift;
        this.hud.flashLap(v.autoShift ? 'AUTOMATIC GEARBOX' : 'MANUAL GEARBOX', 1.6);
        break;
      case 'camera':
        this.hud.flashLap(`CAMERA · ${this.chase.cycle()}`, 1.2);
        break;
      case 'lookBack': this.chase.lookBack = true; break;
      case 'standings': this.hud.showAll = true; break;
      case 'restart': this.restart(); break;
      case 'mute': this.audio.setVolume(this.audio.volume > 0 ? 0 : 0.75); break;
      default: {
        if (!code) break;
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
    // A thumb on the screen holds an ACTION; a finger on a keyboard holds a
    // KEY that maps to one. Both end up here.
    const held = (id) => this.touch.has(id) || codesFor(id).some((c) => k.has(c));
    const gas = held('throttle');
    const brake = held('brake');
    const left = held('left');
    const right = held('right');

    v.throttle = approach(v.throttle, gas ? 1 : 0, dt * (gas ? 5.5 : 9));
    v.brake = approach(v.brake, brake ? 1 : 0, dt * (brake ? 7 : 11));
    // Hold the brake at a standstill for half a second to select reverse — the
    // same gesture an automatic asks for, and unambiguous enough that the grid
    // hold does not accidentally mean it.
    if (brake && Math.abs(v.u) < 0.6) this.brakeHoldT = (this.brakeHoldT || 0) + dt;
    else if (!brake || v.u > 1) this.brakeHoldT = 0;
    v.wantReverse = (this.brakeHoldT || 0) > 0.55 && v.u < 0.6;
    const hand = held('handbrake');
    v.handbrake = approach(v.handbrake, hand ? 1 : 0, dt * (hand ? 14 : 12));

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
    if (lap > this.race.laps) return;
    if (time < this.fastestLap.time && time > 5) {
      this.fastestLap = { time, car };
      if (car.isPlayer) this.hud.flashLap(`FASTEST LAP · ${lapTime(time)}`, 3);
    }
    if (!car.isPlayer) return;
    // Same off-by-one as the board had: `lap` is already the lap now beginning.
    if (lap === this.race.laps) this.hud.message('FINAL LAP', '', 2.4);
    else this.hud.message(`LAP ${lap}`, lapTime(time) === '--:--.---' ? '' : lapTime(time), 1.8);
  }

  onFinish(car) {
    if (car.isPlayer) {
      this.audio.chequered();
      this.hud.message('CHEQUERED FLAG', `${ordinal(car.position)} PLACE`, 4);
    }
    if (!this.raceEnded && this.race.order[0] === car) this.raceEnded = true;
  }

  // A checkpoint bought some time. Loud, because the whole mechanic is the
  // clock nearly running out: the player has to see the purchase land.
  onCheckpoint(bonus) {
    this.hud.flashLap(`CHECKPOINT · +${bonus} SECONDS`, 1.6);
    this.audio.light();
  }

  onImpact(car, force) {
    if (force < 1.2) return;
    this.audio.impact(force * 1.2);
    this.fx.spark(car.vehicle.x, 0.4, car.vehicle.z, force);
    if (car.isPlayer) this.chase.bump(clamp(force / 7, 0.15, 1.4));
    // Damage, where the stage has it. Only impacts that would already have
    // made a noise count, and only the player takes it — a damage model for
    // three hundred cars of traffic is bookkeeping nobody reads.
    if (car.isPlayer && this.race.damageMax && this.race.state === 'racing') {
      this.race.damage = Math.min(this.race.damageMax, (this.race.damage || 0) + force);
      this.hud.damaged(this.race.damage / this.race.damageMax);
      if (this.race.damage >= this.race.damageMax && !this._busted) {
        this._busted = true;
        // Busted: the stage ends as a loss, through the same path a clock
        // running out takes.
        this.race.state = 'finished';
        this.race.results = this.race.order.slice();
      }
    }
  }

  // --------------------------------------------------------------- flow

  // The title screen hands over to the car select, which hands over to the
  // race. Choosing a car swaps the player's model for the chosen one; nothing
  // else about the car changes, because there is one set of physics.
  // Start goes here first: who is driving, then which car.
  openName() {
    if (this.phase !== PHASE.ATTRACT) return;
    const box = document.getElementById('name');
    box.classList.add('open');
    const input = document.getElementById('name-in');
    if (this.playerName) input.value = this.playerName;
    input.focus();
    input.select();
    this.audio.unlock();
  }

  openSelect() {
    if (this.phase === PHASE.RACING || this.phase === PHASE.SELECT) return;
    this._leaveAttract();
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
    if (this.phase === PHASE.RACING) return;
    if (this.phase === PHASE.SELECT) {
      this.setPlayerCar(this.select.chosen);
      this.select.hide();
      document.getElementById('select').classList.remove('open');
    }
    // Always, whichever way we got here. Attract lends the player's car an AI
    // driver and forces its gearbox to automatic; starting a race without
    // giving those back leaves you as a passenger.
    if (this.mode === MODE.CAMPAIGN && this.campaign) {
      this._leaveAttract();
      this.keys.clear();
      document.getElementById('menu').style.display = 'none';
      this.beginStage();
      return;
    }
    this._leaveAttract();
    document.getElementById('menu').style.display = 'none';
    this.hud.show();
    this.audio.unlock();
    // Through the SAME reset a campaign stage goes through.
    //
    // This used to set the phase and stop, which left `raceEnded` and the
    // twelve-second end timer holding whatever the attract loop had put in
    // them — and the attract loop runs a real three-lap race behind the menu,
    // so if it took the flag while you were choosing a car, the timer started
    // counting the moment you pressed START and the results table appeared
    // over the top of your race.
    this._greenLight();
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
    if (this.phase === PHASE.SELECT) {
      this.select.update(dt, this.camera.aspect);
      return;
    }
    if (this.phase === PHASE.CUTSCENE) {
      this._cutsceneTick(dt);
      return;
    }
    if (this.phase === PHASE.ATTRACT) {
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

    // Slow motion is a change to how much TIME passes, not a change to the
    // step: the step stays at 1/120 so the physics is identical, and what
    // shrinks is how many of them a frame is worth. A simulation that runs a
    // different step in slow motion is a different simulation.
    if (this._slowmoT) this._slowmoT = Math.max(0, this._slowmoT - dt);
    dt *= this.timeScale;

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
    if (before !== 'finished' && this.race.state === 'finished') {
      if (this.mode === MODE.CAMPAIGN) this.endStage();
      else this.hud.results(this.race);
    }

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
    this.audio.siren(this._nearestSiren());

    // Once the leader has taken the flag, give everyone else a few seconds and
    // then show the result whether or not the tail-enders are home.
    // ...but only in a race. In a duel there are no tail-enders, so a win
    // would otherwise sit on the track for twelve seconds before anything
    // happened.
    if (this.raceEnded && this.race.state === 'racing' && this.mode === MODE.RACE) {
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

  // The touch-controls setting: auto, on, off.
  //
  // Auto is a guess and guesses are wrong sometimes — a tablet with a keyboard
  // wants none of this, a desktop being tested for a phone wants all of it —
  // so the guess is a default and not a decision. Remembered, because a player
  // who had to turn it on once should not have to again.
  _touchSetting() {
    const sel = document.getElementById('set-touch');
    if (!sel) return;
    let saved = 'auto';
    try { saved = localStorage.getItem('redline.touch') || 'auto'; } catch (e) { /* private window */ }
    sel.value = saved;
    this.touchUI.set(saved);
    sel.addEventListener('change', (e) => {
      this.touchUI.set(e.target.value);
      try { localStorage.setItem('redline.touch', e.target.value); } catch (err) { /* not fatal */ }
    });
  }

  _settingsTabs() {
    const tabs = [...document.querySelectorAll('#settings .tab')];
    const panes = [...document.querySelectorAll('#settings .pane')];
    for (const t of tabs) {
      t.addEventListener('click', () => {
        for (const o of tabs) o.classList.toggle('on', o === t);
        for (const p of panes) p.classList.toggle('on', p.id === `tab-${t.dataset.tab}`);
      });
    }
  }

  // The keybind editor.
  //
  // Click a key, press a new one. The listening state is a class on the button
  // rather than a modal, because a modal over a settings panel over a title
  // screen is three layers deep for something that lasts one keystroke.
  //
  // The capture listener is the load-bearing part: it runs BEFORE the game's
  // own key handler and stops the event there, so binding the throttle to R
  // does not also restart the race on the way past.
  _bindPanel() {
    const host = document.getElementById('binds');
    if (!host) return;
    let listening = null;                       // { id, slot, el }

    const draw = () => {
      host.innerHTML = '';
      for (const a of ACTIONS) {
        const name = document.createElement('div');
        name.className = 'act';
        name.textContent = a.name;
        host.appendChild(name);
        const set = document.createElement('div');
        set.className = 'set';
        const codes = codesFor(a.id);
        codes.forEach((code, slot) => {
          const b = document.createElement('button');
          b.className = 'key';
          b.textContent = label(code);
          b.addEventListener('click', () => {
            if (listening) listening.el.classList.remove('listening');
            listening = { id: a.id, slot, el: b };
            b.classList.add('listening');
            b.textContent = 'PRESS…';
          });
          set.appendChild(b);
        });
        host.appendChild(set);
      }
    };

    window.addEventListener('keydown', (e) => {
      if (!listening) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') rebind(listening.id, listening.slot, e.code);
      listening.el.classList.remove('listening');
      listening = null;
      draw();
    }, true);                                   // capture: before the game sees it

    document.getElementById('binds-reset').addEventListener('click', () => {
      resetBinds();
      draw();
    });
    draw();
  }

  // The cheat panel: a box to type a code into, and the codes listed under it.
  _cheatPanel() {
    const panel = document.getElementById('cheats');
    const input = document.getElementById('cheat-in');
    const said = document.getElementById('cheat-said');
    if (!panel) return;
    const open = () => {
      if (this.phase !== PHASE.ATTRACT) return;
      panel.classList.add('open');
      said.textContent = '';
      input.value = '';
      input.focus();
      this.audio.unlock();
    };
    const close = () => { panel.classList.remove('open'); input.blur(); };
    document.getElementById('cheats-btn').addEventListener('click', open);
    document.getElementById('cheats-close').addEventListener('click', close);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();                       // not a driving input
      if (e.code === 'Escape') { close(); return; }
      if (e.code !== 'Enter') return;
      const hit = findCheat(input.value);
      if (!hit) { said.textContent = 'NOTHING HAPPENS'; input.select(); return; }
      close();
      this.jumpToStage(hit.stage);
    });
  }

  // Straight into a stage, skipping the menus in front of it.
  //
  // Through the same entry point the campaign uses, with whatever car and name
  // were last chosen filled in — a cheat that reached a state the game cannot
  // otherwise reach would be a way of finding bugs that are not there.
  async jumpToStage(id) {
    const i = STAGES.findIndex((s) => s.id === id);
    if (i < 0 || this.phase === PHASE.RACING) return;
    this.mode = MODE.CAMPAIGN;
    this.campaign = new Campaign(this);
    this.campaign.index = i;
    this.playerLivery = this.playerLivery || SELECTABLE[0];
    this.playerName = this.playerName || 'PLAYER';
    this._leaveAttract();
    this.keys.clear();
    document.getElementById('menu').style.display = 'none';
    this.hud.show();
    this.audio.unlock();
    await this.beginStage();
  }

  // Step through the scripts in order, one per press.
  debugCutscene(name) {
    const names = Object.keys(SCRIPTS);
    const at = name ? names.indexOf(name) : ((this._debugCut ?? -1) + 1) % names.length;
    if (at < 0) return null;
    this._debugCut = at;
    const pick = names[at];
    const cars = this.race.cars;
    this.hud.flashLap(`CUTSCENE · ${pick}`, 1.4);
    this.playCutscene(pick, { player: this.race.player, rival: cars.find((c) => !c.isPlayer) },
      () => { this.phase = PHASE.ATTRACT; this._attracting = false; });
    return pick;
  }

  // Play a scripted scene. The world keeps running behind it.
  playCutscene(name, cast, onDone) {
    this._leaveAttract();
    // The cars idle on the brakes while the scene runs — `race.update` holds
    // every car when the state is not 'racing', which is exactly the staged,
    // waiting look a wager scene wants.
    this.race.state = 'grid';
    this.race.countdown = RACE.countdown;
    // No dashboard over a cutscene. A rev counter and a lap board on top of
    // two people talking is the single fastest way to make a scene look like
    // a paused race rather than a scene.
    this.hud.hide();
    this.phase = PHASE.CUTSCENE;
    this.cut = new Cutscene(this, SCRIPTS[name], cast, () => {
      this.cut = null;
      onDone();
    });
  }

  // --- campaign flow

  startCampaign() {
    if (this.phase === PHASE.RACING) return;
    this.mode = MODE.CAMPAIGN;
    this.campaign = new Campaign(this);
    this.openName();
  }

  // Called once the player has a name and a car: put the stage's circuit in
  // the world, set its field up, and play the scene in front of it.
  //
  // Async, because a stage can be on a different layout and building a city is
  // a second or two — which the loading screen has to be up for, or the game
  // simply stops responding for two seconds with a race on screen.
  async beginStage() {
    const c = this.campaign;
    c.car = this.playerLivery;
    const want = LAYOUTS[c.stage.layout] || LAYOUTS.folsom;
    if (this.track.layout !== want) {
      const load = document.getElementById('loading');
      const label = document.getElementById('load-what');
      const ring = document.getElementById('load-ring');
      if (load) { load.style.display = ''; load.classList.remove('done'); }
      await this.buildTrack(want, async (what, at) => {
        if (label) label.textContent = what.toUpperCase();
        if (ring) ring.style.setProperty('--at', String(at));
        await new Promise((r) => requestAnimationFrame(() => r()));
      });
      if (load) {
        load.classList.add('done');
        setTimeout(() => { load.style.display = 'none'; }, 500);
      }
    }
    this.race.buildField(c.field(this.track));
    const cast = {
      player: this.race.player,
      rival: this.race.cars.find((x) => !x.isPlayer),
    };
    this.hud.show();
    // The opening scene plays once. Watching the wager three times over is the
    // fastest way to make somebody stop retrying.
    //
    // The same scene whichever way you arrived. It used to be found two
    // different ways — declared for stage one, borrowed from the last stage's
    // ending for the others — and the borrowed one played on a different track
    // with a different cast depending on whether you had won your way there or
    // typed a code.
    const intro = c.attempts === 0 ? c.introScene() : null;
    if (intro) {
      this.playCutscene(intro, cast, () => this._greenLight());
    } else {
      this._greenLight();
    }
  }

  // Time, slowed and let go.
  //
  // A pursuit stage opens with everybody already at a hundred and fifty, which
  // is not something to be dropped into cold: a second and a half of slow
  // motion is enough to see where the road goes and where the police are
  // before any of it matters. It scales the whole fixed step, so the physics,
  // the AI and the audio all slow together — anything less and it is a video
  // effect over a game running at full speed.
  get timeScale() {
    if (!this._slowmoT) return 1;
    const k = clamp(1 - this._slowmoT / SLOWMO_TIME, 0, 1);
    return lerp(SLOWMO_MIN, 1, k * k);
  }

  _greenLight() {
    this.race.gridUp();
    this.fastestLap = { time: Infinity, car: null };
    this.raceEnded = false;
    this._endTimer = 0;
    this.hud.hideResults();
    this.hud.show();
    this.chase.started = false;
    this._busted = false;
    this.race.damage = 0;
    this.keys.clear();
    // A rolling start gets the slow-motion opening; a standing one has five
    // seconds of red lights to do the same job.
    this._slowmoT = this.race.formation === 'pursuit' ? SLOWMO_TIME : 0;
    this.phase = PHASE.RACING;
  }

  // The stage is over. Which scene depends on whether you took it.
  endStage() {
    const c = this.campaign;
    if (!c) return;
    const won = c.won_(this.race);
    const cast = {
      player: this.race.player,
      rival: this.race.cars.find((x) => !x.isPlayer),
    };
    if (won && c.wagered) c.won.push(c.wagered);
    this.playCutscene(won ? c.stage.onWin : c.stage.onLose, cast, () => {
      if (won && c.advance()) {
        this.beginStage();
        return;
      }
      if (won) {
        // The campaign is over. Back to the title screen, which means back to
        // the circuit the title screen is a shot of — leaving the run layout
        // up would put the attract camera on a road with no race on it.
        this.endCampaign();
        return;
      }
      c.attempts++;
      this.beginStage();
    });
  }

  // Metres to the closest car with a light bar on it, or null if none of them
  // are out. Straight-line, not distance round the lap: what the player is
  // listening for is how close the thing behind them is, and once it is
  // alongside, the gap round the lap says nothing about that at all.
  _nearestSiren() {
    let best = null;
    const p = this.race.player;
    if (!p) return null;
    for (const car of this.race.cars) {
      if (car === p || !car.model || !car.model.userData.beacons) continue;
      const d = dist2D(p.vehicle.x, p.vehicle.z, car.vehicle.x, car.vehicle.z);
      if (best === null || d < best) best = d;
    }
    return best;
  }

  async endCampaign() {
    this.mode = MODE.RACE;
    this.campaign = null;
    if (this.track.layout !== LAYOUTS.folsom) await this.buildTrack(LAYOUTS.folsom);
    this.race.buildField(defaultField());
    this.phase = PHASE.ATTRACT;
    document.getElementById('menu').style.display = '';
    this.hud.hideResults();
  }

  // The world keeps running behind a cutscene: the cars idle, the lamps and
  // the beacons keep moving, the city is still there. Same body as the attract
  // loop minus the camera, which the Cutscene owns.
  _cutsceneTick(dt) {
    if (!this.cut) { this.phase = PHASE.ATTRACT; return; }
    this.accumulator = Math.min(this.accumulator + dt, 0.25);
    while (this.accumulator >= FIXED) {
      this.race.update(FIXED);
      this.accumulator -= FIXED;
    }
    this.race.sync(this.accumulator / FIXED);
    this.track.update(this.time, dt);
    this._placeLamps();
    this.fx.update(dt);
    this.hud.tickText(dt);
    this.cut.update(dt);
  }

  // Put the field back the way it was before the attract loop ran on it.
  _leaveAttract() {
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
    if (this.phase === PHASE.SELECT) {
      this.post.render(this.select.scene, this.select.camera, dt);
      return;
    }
    this.skyFollow(this.camera);
    this.post.render(this.scene, this.camera, dt);
  }

  // The sky goes where the camera goes.
  //
  // It was a sphere of fixed radius sitting at the origin, which is fine for a
  // circuit two kilometres across and wrong the moment a stage is bigger than
  // the dome: on an eleven-kilometre bridge you drive out through the side of
  // it somewhere around the first tower, and the stars end up bunched behind
  // you in a patch of sky. Centred on the viewer it cannot be outrun, whatever
  // the map measures — which is what a skybox is.
  //
  // A method rather than two lines in `render`, because anything else that
  // points a camera at this scene has to do it too. The frame dumps place
  // their own cameras kilometres from the last rendered one, and without this
  // they photograph the OUTSIDE of the dome: a black dome sitting on the
  // horizon with the stars in front of it.
  skyFollow(camera) {
    if (this.sky) this.sky.position.copy(camera.position);
    if (this.stars) this.stars.position.copy(camera.position);
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
