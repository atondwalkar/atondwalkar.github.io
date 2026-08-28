// Cutscenes.
//
// A script is a flat list of beats, and a beat is a shot held for a number of
// seconds with a line of dialogue over it. Nothing here interprets a language:
// `act` is a plain function, so a beat can do anything the game can do without
// a mini-language to write, document and debug.
//
// Two things are less obvious than they look.
//
// The player owns ITS OWN CLOCK. The title sequence reads `game.time` and gets
// away with it because it only ever wants `t % SHOT`; a script that did the
// same would play differently at ten seconds and at an hour.
//
// And `skip()` fires every `act` that has not run yet. A skipped cutscene that
// leaves the world in a different state from a watched one is the signature
// bug of every skip button ever written — you get a race with no rival in it,
// or a wager nobody made.

import { clamp } from './utils.js';
import { Car } from './race.js';
import { Driver } from './ai.js';
import { POLICE } from './defs.js';
import { portraitFor } from './portraits.js';

export class Cutscene {
  // `cast` maps a role name to a Car: { player, rival, ... }. A beat's `act`
  // is handed (game, cast, cutscene) — the third so a scene can bring cars on
  // and hand them to the player that is going to drive them.
  constructor(game, script, cast, onDone) {
    this.game = game;
    this.script = script;
    this.cast = cast;
    this.onDone = onDone || (() => {});
    this.i = 0;
    this.t = 0;
    this.clock = 0;
    // Cars a scene brings on for itself. The race behind a cutscene is idling
    // on the brakes — that is what makes two people talking look like two
    // people talking — so anything that has to MOVE cannot be one of its cars.
    // These are driven here, at the fixed step, and taken away at the end.
    this.extras = [];
    this.entered = false;
    this.done = false;
    this.el = {
      root: document.getElementById('cine'),
      who: document.getElementById('cine-who'),
      say: document.getElementById('cine-say'),
      line: document.getElementById('cine-line'),
      face: document.getElementById('cine-face'),
    };
    if (this.el.root) this.el.root.classList.add('open');
  }

  get beat() { return this.script[this.i]; }

  update(dt) {
    if (this.done) return;
    const b = this.beat;
    if (!b) { this.finish(); return; }

    if (!this.entered) {
      this.entered = true;
      if (b.act) b.act(this.game, this.cast, this);
      this._caption(b);
    }

    this.t += dt;
    this.clock += dt;
    this._extras(dt);
    const k = clamp(this.t / b.t, 0, 1);

    const subject = this.cast[b.subject] || this.cast.player;
    const second = b.at ? this.cast[b.at] : null;
    if (subject) this.game.chase.playShot(dt, b.shot, subject, k, this.i, second);

    // In over a quarter of a second, hold, out over the last quarter — so a
    // line does not blink on and off between cuts.
    if (this.el.line) {
      const fade = Math.min(1, Math.min(this.t, b.t - this.t) / 0.25);
      this.el.line.style.opacity = b.say ? Math.max(0, fade) : 0;
    }

    if (this.t >= b.t) {
      this.t = 0;
      this.i++;
      this.entered = false;
      if (this.i >= this.script.length) this.finish();
    }
  }

  // Bring a car on for the length of this scene. Everything a script adds to
  // the world goes through here, so `finish` can take all of it away again —
  // an act that adds to the scene itself leaks its cars the moment anybody
  // calls it without a cutscene to hand, which is exactly what a skipped copy
  // does.
  bring(car) {
    this.game.scene.add(car.model);
    this.extras.push(car);
    return car;
  }

  // The extras, stepped at the same fixed rate the race runs at. Capped at
  // eight steps a frame so a long frame — the first one after a city is built,
  // say — does not teleport a car across a junction.
  _extras(dt) {
    if (!this.extras.length) return;
    const t = this.game.track;
    const STEP = 1 / 120;
    const n = Math.min(8, Math.max(1, Math.round(dt / STEP)));
    for (let k = 0; k < n; k++) {
      for (const c of this.extras) {
        c.driver.drive(STEP, this.extras);
        c.vehicle.update(STEP, 2);
        c.loc = t.locate(c.vehicle.x, c.vehicle.z, c.loc ? c.loc.index : -1);
        const over = Math.abs(c.loc.lateral) - c.loc.width / 2;
        c.vehicle.surfaceGrip = over <= 0 ? 1 : over < 1.6 ? 0.92 : 0.55;
      }
      // The same building line the race holds its own cars to. A police car
      // committed to a junction sideways with nothing to stop it ends up
      // parked on the pavement in the middle of the shot, which is what the
      // first version of this scene photographed.
      if (this.game.race) this.game.race.constrain(this.extras);
    }
    const on = Math.floor(this.clock * 5) % 2;
    for (const c of this.extras) {
      c.prev = null;
      c.syncModel(t);
      const b = c.model.userData.beacons;
      if (b) { b[0].visible = on === 0; b[1].visible = on === 1; }
    }
  }

  _caption(b) {
    if (!this.el.who) return;
    this.el.who.textContent = b.who || '';
    this.el.say.textContent = b.say || '';
    if (this.el.face) {
      const art = portraitFor(b.who);
      this.el.face.innerHTML = art;
      this.el.face.classList.toggle('on', !!art);
    }
  }

  // Everything a watched cutscene would have done, done at once.
  skip() {
    if (this.done) return;
    for (let j = this.entered ? this.i + 1 : this.i; j < this.script.length; j++) {
      const b = this.script[j];
      if (b.act) b.act(this.game, this.cast, this);
    }
    this.finish();
  }

  finish() {
    if (this.done) return;
    this.done = true;
    for (const c of this.extras) this.game.scene.remove(c.model);
    this.extras = [];
    if (this.el.root) this.el.root.classList.remove('open');
    this.onDone();
  }
}

// Stage two cars alongside each other on the road, a lane apart and one of
// them half a length back, for a scene that is two people talking rather than
// two cars racing. Alongside rather than nose to nose: a street race is agreed
// between two cars pointing the same way down the road they are about to use.
export function faceOff(game, cast) {
  const t = game.track;
  const p = t.atDistance(t.length - 60);
  const yaw = Math.atan2(p.dirX, p.dirZ);
  const place = (car, side, back) => {
    if (!car) return;
    const off = side * 3.0;
    car.vehicle.reset(p.x + p.nx * off - p.dirX * back, p.z + p.nz * off - p.dirZ * back, yaw);
    car.loc = t.locate(car.vehicle.x, car.vehicle.z);
    car.prev = null;
    car.syncModel(t);
  };
  place(cast.player, 1, 0);
  place(cast.rival, -1, 1.5);
}

// Three units coming up the road behind you, flat out, with the lights on.
//
// They are real cars with real drivers, not an animation: spawned a couple of
// hundred metres back at eighty miles an hour and pointed at the same racing
// line everything else uses, with the drift dialled all the way up and its
// trigger dropped so they commit to every junction sideways. What the camera
// sees is three police cars actually driving the circuit, which is the only
// way to get the tyre smoke, the countersteer and the lights sweeping the
// buildings without hand-animating any of it.
export function policeArrive(game, cast, cut) {
  if (!cut) return;                  // nothing to hang them off, so nothing to bring on
  const t = game.track;
  const here = cast.player && cast.player.loc ? cast.player.loc.s : 0;
  cast.cops = [];
  for (let i = 0; i < 3; i++) {
    const car = new Car(POLICE.livery, false);
    car.name = `${POLICE.name} ${i + 1}`;
    const at = t.atDistance(here - 210 - i * 30);
    const off = (i - 1) * 3.4;
    car.vehicle.reset(at.x + at.nx * off, at.z + at.nz * off, Math.atan2(at.dirX, at.dirZ));
    car.vehicle.autoShift = true;
    car.vehicle.surfaceGrip = 1;
    car.vehicle.setSpeed(44);
    car.loc = t.locate(car.vehicle.x, car.vehicle.z);
    car.driver = new Driver(car, t, 0.97, {
      ...POLICE.opts,
      chase: 0,                 // nobody to chase yet — this is the arrival
      // Hard enough to be the point of the shot, not so hard they spend it in
      // the scenery: at a flat 1.0 with the trigger on the floor they threw
      // the car at every bend in the road, including the ones that are not
      // corners, and arrived at the camera facing a wall.
      drift: 0.85,
      driftMinTurn: 0.022,
    });
    cut.bring(car);
    cast.cops.push(car);
    cast[`cop${i + 1}`] = car;
  }
}

// The scripts.
//
// Short. A cutscene between two races is a beat, not a scene — the second time
// through, every extra second is a second of not driving.
export const SCRIPTS = {
  WAGER: [
    { t: 3.0, shot: 'highWide', subject: 'player', who: '', say: 'FOLSOM AND SIXTH. 2:40 AM.',
      act: faceOff },
    { t: 3.4, shot: 'twoShot', subject: 'player', at: 'rival',
      who: 'KESTREL', say: 'YOU ACTUALLY BROUGHT IT.' },
    { t: 3.0, shot: 'closeFront', subject: 'rival',
      who: 'KESTREL', say: 'SLIPS. THREE LAPS. YOU LOSE, I DRIVE IT HOME.' },
    { t: 2.8, shot: 'closeFront', subject: 'player', who: 'YOU', say: 'NAME THE CORNER.' },
    { t: 2.6, shot: 'wheelArch', subject: 'player', who: '', say: 'PINK SLIPS ON THE LINE.',
      act: (g) => { if (g.campaign) g.campaign.setWager(g.playerLivery); } },
  ],

  POLICE_ARRIVE: [
    { t: 2.4, shot: 'closeFront', subject: 'player', who: '', say: 'YOU WIN.' },
    { t: 2.8, shot: 'orbit', subject: 'player',
      who: 'KESTREL', say: 'TAKE IT. IT WAS NEVER GOING TO BE THE CAR.',
      act: policeArrive },
    // Now watch them work. Four shots of the units and not one of the two of
    // you: the scene is not about the wager any more.
    { t: 2.6, shot: 'headOn', subject: 'cop1', who: '', say: 'SIRENS. FOUR BLOCKS OUT.' },
    { t: 2.4, shot: 'wheelArch', subject: 'cop2', who: '', say: '' },
    { t: 2.6, shot: 'trackPast', subject: 'cop1', who: '', say: 'AND THEY ARE NOT SLOWING DOWN.' },
    { t: 2.2, shot: 'lowRear', subject: 'cop3', who: '', say: '' },
    { t: 2.8, shot: 'highWide', subject: 'player', at: 'cop1',
      who: 'KESTREL', say: 'GO. THE BRIDGE. DO NOT STOP.' },
  ],

  LOST_THE_CAR: [
    { t: 2.6, shot: 'closeFront', subject: 'rival', who: 'KESTREL', say: 'SLIPS ARE SLIPS.' },
    { t: 2.4, shot: 'highWide', subject: 'player', who: '', say: 'RUN IT BACK.' },
  ],

  // Stage two's opening, on stage two's road with stage two's cast. Short:
  // the police are already behind you and the clock is already running, so
  // anything longer than this is time spent not driving away.
  ON_THE_RUN: [
    { t: 2.4, shot: 'lowRear', subject: 'player', at: 'rival',
      who: '', say: 'THREE UNITS. ONE ROAD OUT.' },
    { t: 2.6, shot: 'headOn', subject: 'player', who: 'YOU', say: 'THE BRIDGE, THEN.' },
  ],

  // And stage three's.
  THE_APPROACH: [
    { t: 2.6, shot: 'highWide', subject: 'player', who: '', say: 'THE GOLDEN GATE. SIX LANES AND NOWHERE TO TURN OFF.' },
    { t: 2.4, shot: 'wheelArch', subject: 'player', who: 'YOU', say: 'MARIN OR NOTHING.' },
  ],

  // Stage four: the morning after the bridge, in the Oakland yards.
  THE_YARDS: [
    { t: 2.6, shot: 'highWide', subject: 'player', who: '', say: 'OAKLAND. THE CONTAINER YARDS, JUST BEFORE FOUR.',
      act: faceOff },
    { t: 2.8, shot: 'twoShot', subject: 'player', at: 'rival',
      who: 'MARLOWE', say: 'THE ONE WHO CROSSED THE BRIDGE WITH THE HEAT ON. THREE OF US SAY IT WAS LUCK.' },
    { t: 2.4, shot: 'closeFront', subject: 'player', who: 'YOU', say: 'THREE LAPS SAYS IT WAS NOT.' },
  ],
  YARDS_WON: [
    { t: 2.6, shot: 'orbit', subject: 'player', who: 'MARLOWE', say: 'NOT LUCK, THEN.' },
    { t: 2.6, shot: 'lowRear', subject: 'player', who: '', say: 'WORD MOVES FAST ON THIS SIDE OF THE BAY.' },
  ],
  YARDS_LOST: [
    { t: 2.4, shot: 'closeFront', subject: 'rival', who: 'MARLOWE', say: 'LUCK.' },
    { t: 2.2, shot: 'highWide', subject: 'player', who: '', say: 'RUN IT BACK.' },
  ],

  // Stage five: back over the hills at dawn, against the clock.
  FIRST_LIGHT: [
    { t: 2.8, shot: 'highWide', subject: 'player', who: '', say: 'FIRST LIGHT. THE CITY THE OTHER WAY, BEFORE IT WAKES.' },
    { t: 2.6, shot: 'closeFront', subject: 'rival', who: 'KESTREL', say: 'EVERY LINE BUYS YOU SECONDS. MISS ONE AND IT IS OVER.' },
  ],
  SKYLINE_WON: [
    { t: 2.6, shot: 'orbit', subject: 'player', who: '', say: 'EVERY LINE MADE, WITH THE SUN COMING UP.' },
    { t: 2.4, shot: 'lowRear', subject: 'player', who: 'KESTREL', say: 'ONE MORE THING TO SETTLE.' },
  ],
  OUT_OF_TIME: [
    { t: 2.4, shot: 'closeFront', subject: 'player', who: '', say: 'THE CLOCK RAN OUT FIRST.' },
    { t: 2.2, shot: 'highWide', subject: 'player', who: '', say: 'AGAIN, BEFORE THE STREETS FILL.' },
  ],

  ACROSS: [
    { t: 2.8, shot: 'lowRear', subject: 'player', who: '', say: 'MARIN COUNTY. THE LIGHTS BEHIND YOU STOP AT THE COUNTY LINE.' },
    { t: 3.0, shot: 'highWide', subject: 'player', who: 'YOU', say: 'THAT IS TWO CARS I DID NOT LOSE TONIGHT.' },
    { t: 2.6, shot: 'orbit', subject: 'player', who: '', say: 'GONE.' },
  ],

  ESCAPE: [
    { t: 3.0, shot: 'headOn', subject: 'player', who: '', say: 'THE RAMP. NOTHING BEHIND YOU BUT LIGHTS.' },
    { t: 3.2, shot: 'highWide', subject: 'player', who: '', say: 'GONE.' },
  ],

  PULLED_OVER: [
    { t: 2.8, shot: 'orbit', subject: 'player', who: '', say: 'BOXED IN. ENGINE OFF.' },
    { t: 2.4, shot: 'closeFront', subject: 'player', who: '', say: 'AGAIN.' },
  ],
};
