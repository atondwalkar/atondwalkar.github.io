// The dashboard. Two canvases do the work — the rev counter and the track map —
// and the rest is text that is only rewritten when it changes, because setting
// textContent on a dozen elements sixty times a second is a real cost for
// something nobody can read that fast.

import { RACE, CAR } from './defs.js';
import { clamp, lerp, lapTime, gapTime, ordinal } from './utils.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor(game) {
    this.game = game;
    this.el = {
      hud: $('hud'), pos: $('pos-v'), lap: $('lap-v'), raceTime: $('race-time'),
      lapK: $('lap-k'), rtK: $('rt-k'),
      curLap: $('cur-lap'), lastLap: $('last-lap'), bestLap: $('best-lap'), gap: $('gap-ahead'),
      speed: $('speed'), gear: $('gear'), autobox: $('autobox'),
      thr: $('thr').firstElementChild, brk: $('brk').firstElementChild,
      hbk: $('hbk').firstElementChild, wheel: $('wheel').firstElementChild,
      grip: $('grip'), standings: $('standings'), rows: $('standings-rows'),
      lights: $('lights'), message: $('message'), flash: $('flash-lap'),
      results: $('results'), resultRows: $('results-rows'), resultsSub: $('results-sub'),
    };
    this.tacho = $('tacho-c').getContext('2d');
    this.speedo = $('speedo-c').getContext('2d');
    this.map = $('map-c').getContext('2d');
    this.messageT = 0;
    this.flashT = 0;
    this.showAll = false;
    this._cache = {};
    this._mapPath = null;
  }

  show() { this.el.hud.style.display = 'block'; }
  hide() { this.el.hud.style.display = 'none'; }

  // Only touch the DOM when the value has actually changed.
  _set(key, el, value) {
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    el.textContent = value;
  }

  // The two on-screen message timers, on their own so every phase can tick
  // them. They used to live at the bottom of update(), which runs only while
  // racing — so hud.message() was silently a no-op on the title screen, during
  // car select and (once there was one) during a cutscene.
  tickText(dt) {
    this.messageT = Math.max(0, this.messageT - dt);
    this.el.message.style.opacity = this.messageT > 0 ? Math.min(1, this.messageT * 2.2) : 0;
    this.flashT = Math.max(0, this.flashT - dt);
    this.el.flash.style.opacity = this.flashT > 0 ? Math.min(1, this.flashT * 2.2) : 0;
  }

  message(main, sub = '', time = 2.6) {
    this.el.message.querySelector('.main').textContent = main;
    this.el.message.querySelector('.sub').textContent = sub;
    this.messageT = time;
  }

  flashLap(text, time = 2.4) {
    this.el.flash.textContent = text;
    this.flashT = time;
  }

  lights(n) {
    const on = this.game.race.state === 'countdown';
    this.el.lights.style.display = on ? 'flex' : 'none';
    [...this.el.lights.children].forEach((i, k) => i.classList.toggle('on', k < n));
  }

  update(dt) {
    const g = this.game;
    const race = g.race;
    const car = race.player;
    const v = car.vehicle;

    // --- top strip
    this._set('pos', this.el.pos, `${car.position}/${race.cars.length}`);
    // The lap you are ON is the number of times you have crossed the line,
    // not that plus one.
    //
    // The grid is behind the start line, so the first crossing a few seconds
    // after the lights is the START of lap one, not the end of one — the lap
    // counter already treats it that way, and `lap` is the count of crossings.
    // Displaying `lap + 1` meant the board read "1/3" on the grid, which is
    // right, and then flicked to "2/3" the moment you crossed the line for the
    // first time, which is a lap you had not driven.
    // A run hides the race furniture wholesale rather than filling it with
    // meaningless numbers: "3rd of 4" against three police cars is not a
    // position, and a best lap on a road with no laps on it is blank forever.
    this.el.hud.classList.toggle('run', race.route !== null);
    if (race.route !== null) {
      // A run has no laps and no elapsed time worth reading: what matters is
      // how far there is to go and how long there is to do it in. Same two
      // cells, relabelled, rather than a second strip that only ever appears
      // on one stage.
      const left = Math.max(0, race.route - race.distanceAlong(car));
      this._set('lapk', this.el.lapK, 'TO RAMP');
      this._set('lap', this.el.lap, left > 950 ? `${(left / 1000).toFixed(1)}km` : `${Math.round(left)}m`);
      this.el.lap.classList.toggle('final', left < 400 && race.state === 'racing');
      const clock = Math.max(0, (race.limit ?? 0) - race.time);
      this._set('rtk', this.el.rtK, 'CLOCK');
      this._set('rt', this.el.raceTime, lapTime(race.state === 'countdown' ? race.limit ?? 0 : clock));
      this.el.raceTime.classList.toggle('urgent', clock < 30 && race.state === 'racing');
    } else {
      const lap = clamp(Math.max(car.lap, 1), 1, race.laps);
      this._set('lapk', this.el.lapK, 'LAP');
      this._set('lap', this.el.lap, `${lap}/${race.laps}`);
      this.el.lap.classList.toggle('final', lap === race.laps && race.state === 'racing');
      this._set('rtk', this.el.rtK, 'RACE');
      this._set('rt', this.el.raceTime, lapTime(race.state === 'countdown' ? 0 : race.time));
      this.el.raceTime.classList.remove('urgent');
    }

    // --- timing
    const cur = race.started && !car.finished ? race.time - car.lapStart : 0;
    this._set('cur', this.el.curLap, lapTime(cur));
    this._set('last', this.el.lastLap, lapTime(car.lastLap));
    this._set('best', this.el.bestLap, lapTime(car.bestLap));
    this._set('gap', this.el.gap, car.position === 1 ? 'LEADER' : gapTime(race.gapAhead(car)));

    // --- dash
    this._set('spd', this.el.speed, String(Math.round(Math.abs(v.speedKmh))));
    const gearName = v.gear === 0 ? 'R' : String(v.gear);
    this._set('gear', this.el.gear, gearName);
    const nearRed = v.rpm > v.spec.redline * 0.94;
    this.el.gear.classList.toggle('shift', nearRed);
    this._set('auto', this.el.autobox, v.autoShift ? 'AUTO BOX' : 'MANUAL BOX');
    this.el.autobox.classList.toggle('on', v.autoShift);

    // --- pedals
    this.el.thr.style.width = `${v.throttle * 100}%`;
    this.el.brk.style.width = `${v.brake * 100}%`;
    this.el.hbk.style.width = `${v.handbrake * 100}%`;
    // Positive steering is left, so the marker moves the other way.
    this.el.wheel.style.left = `${50 - v.steerInput * 46}%`;
    const slip = Math.max(v.slipF, v.slipR);
    const sliding = slip > 1.05;
    const label = !v.onTrack ? 'OFF TRACK'
      : v.handbrake > 0.15 ? 'DRIFTING'
      : sliding ? 'AT THE LIMIT' : 'GRIP OK';
    this._set('grip', this.el.grip, label);
    this.el.grip.classList.toggle('slide', sliding || !v.onTrack);

    this._tacho(v);
    this._speedo(v);
    this._standings(race, car);
    this._map(race, car);

    // --- transient text
    this.tickText(dt);
  }

  // The rev counter, drawn as an arc with the redline marked. It is the one
  // instrument that has to be readable out of the corner of your eye.
  // The speedometer, drawn as the tacho's mirror image.
  //
  // Same arc, same rim, same tick weight — because two dials on one dashboard
  // that are drawn to different rules read as two different instruments
  // borrowed from two different cars. What differs is what they are of: this
  // one is swept anticlockwise from the right, so the two needles open away
  // from each other as the speed comes up rather than both sweeping the same
  // way across a screen you are trying to see the road through.
  _speedo(v) {
    const c = this.speedo;
    const W = 260, R = 104, cx = W / 2, cy = W / 2;
    // Clockwise, like every speedometer ever fitted to a car — and like the
    // rev counter beside it. It was mirrored, so the two needles opened away
    // from each other, which is tidy and is not what a driver expects: you
    // read a dial by where the needle is round the face, and a dial that runs
    // backwards has to be thought about rather than glanced at.
    const A0 = Math.PI * 0.76, A1 = Math.PI * 2.24;
    const TOP = 300;                             // km/h at full sweep
    c.clearRect(0, 0, W, W);

    c.lineWidth = 15;
    c.lineCap = 'butt';
    c.strokeStyle = 'rgba(10, 13, 17, 0.82)';
    c.beginPath(); c.arc(cx, cy, R, A0, A1); c.stroke();

    const frac = clamp(Math.abs(v.speedKmh) / TOP, 0, 1);
    const grad = c.createLinearGradient(0, 0, W, W);
    grad.addColorStop(0, '#4fa8e8');
    grad.addColorStop(0.62, '#e8ecf0');
    grad.addColorStop(1, '#e8452f');
    c.strokeStyle = grad;
    c.beginPath(); c.arc(cx, cy, R, A0, lerp(A0, A1, frac)); c.stroke();

    // Ticks every twenty, numbered every sixty — the same density of marks as
    // the tacho's thousands and two-thousands, so the pair look related.
    c.lineWidth = 2;
    c.font = '10px "DejaVu Sans Mono", monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let k = 0; k <= TOP; k += 20) {
      const a = lerp(A0, A1, k / TOP);
      c.strokeStyle = 'rgba(190, 205, 220, 0.55)';
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * (R - 9), cy + Math.sin(a) * (R - 9));
      c.lineTo(cx + Math.cos(a) * (R + 9), cy + Math.sin(a) * (R + 9));
      c.stroke();
      if (k % 60 === 0) {
        c.fillStyle = 'rgba(190, 205, 220, 0.7)';
        c.fillText(String(k), cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24));
      }
    }

    // Reverse, where the tacho puts its shift light: the one state where the
    // number in the middle is telling you something other than how fast you
    // are going forwards.
    if (v.gear === 0 && Math.abs(v.speedKmh) > 1) {
      c.font = '11px "DejaVu Sans Mono", monospace';
      c.fillStyle = '#e8452f';
      c.fillText('REVERSE', cx, cy - R - 12);
    }
  }

  _tacho(v) {
    const c = this.tacho;
    const W = 260, R = 104, cx = W / 2, cy = W / 2;
    const A0 = Math.PI * 0.76, A1 = Math.PI * 2.24;
    c.clearRect(0, 0, W, W);

    c.lineWidth = 15;
    c.lineCap = 'butt';
    c.strokeStyle = 'rgba(10, 13, 17, 0.82)';
    c.beginPath(); c.arc(cx, cy, R, A0, A1); c.stroke();

    const redFrac = v.spec.redline / v.spec.limiter;
    c.strokeStyle = 'rgba(232, 69, 47, 0.30)';
    c.beginPath(); c.arc(cx, cy, R, lerp(A0, A1, redFrac), A1); c.stroke();

    const frac = clamp(v.rpm / v.spec.limiter, 0, 1);
    const grad = c.createLinearGradient(0, 0, W, W);
    grad.addColorStop(0, '#4fa8e8');
    grad.addColorStop(0.62, '#e8ecf0');
    grad.addColorStop(1, '#e8452f');
    c.strokeStyle = frac > redFrac ? '#e8452f' : grad;
    c.beginPath(); c.arc(cx, cy, R, A0, lerp(A0, A1, frac)); c.stroke();

    // Ticks, every thousand.
    c.lineWidth = 2;
    c.font = '10px "DejaVu Sans Mono", monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let r = 0; r <= v.spec.limiter; r += 1000) {
      const a = lerp(A0, A1, r / v.spec.limiter);
      const past = r >= v.spec.redline;
      c.strokeStyle = past ? 'rgba(232,69,47,0.85)' : 'rgba(190, 205, 220, 0.55)';
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * (R - 9), cy + Math.sin(a) * (R - 9));
      c.lineTo(cx + Math.cos(a) * (R + 9), cy + Math.sin(a) * (R + 9));
      c.stroke();
      if (r % 2000 === 0) {
        c.fillStyle = past ? 'rgba(232,69,47,0.9)' : 'rgba(190, 205, 220, 0.7)';
        c.fillText(String(r / 1000), cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24));
      }
    }

    // The shift light, above the dial rather than across its face.
    //
    // It used to sit at cy - R + 4, which is inside the rim — straight on top
    // of the numbers and the needle sweep at exactly the revs you are trying
    // to read them at. A shift light is the one thing you look at while the
    // dial is at its busiest, so it gets clear air of its own.
    const shift = clamp((v.rpm - v.spec.redline * 0.86) / (v.spec.redline * 0.14), 0, 1);
    {
      // There are twenty-six pixels of clear canvas above the rim and this
      // uses eight of them. The lamps are drawn unlit as well as lit, so the
      // strip is always there to be read rather than appearing from nowhere at
      // the moment you most need to have already found it.
      const y = cy - R - 15;
      for (let i = 0; i < 5; i++) {
        const on = shift >= (i + 0.5) / 5;
        c.fillStyle = on
          ? (shift > 0.92 ? '#e8452f' : shift > 0.6 ? '#e8a92f' : '#35d06a')
          : 'rgba(150, 170, 190, 0.15)';
        c.fillRect(cx - 49 + i * 20, y, 16, 7);
      }
    }
    c.font = '9px "DejaVu Sans Mono", monospace';
    c.fillStyle = 'rgba(190, 205, 220, 0.5)';
    c.fillText('RPM ×1000', cx, cy + 42);
  }

  _standings(race, player) {
    const order = race.order || race.cars;
    const show = this.showAll ? order : this._window(order, player);
    const key = show.map((c) => `${c.position}${c.name}${c.finished ? 'F' : ''}`).join('|') + this.showAll;
    if (this._cache.order === key && !this.showAll) {
      // Positions are stable; still refresh the gaps, which are not.
      show.forEach((c, i) => {
        const row = this.el.rows.children[i];
        if (row) row.lastElementChild.textContent = this._gapText(race, c);
      });
      return;
    }
    this._cache.order = key;
    this.el.rows.innerHTML = show.map((c) => `
      <div class="row${c.isPlayer ? ' you' : ''}">
        <div class="p">${c.position}</div>
        <div class="sw" style="background:#${c.livery.body.toString(16).padStart(6, '0')}"></div>
        <div class="n">${c.name}</div>
        <div class="g">${this._gapText(race, c)}</div>
      </div>`).join('');
  }

  _gapText(race, car) {
    if (car.position === 1) return car.finished ? 'WIN' : 'LEAD';
    const ahead = race.order && race.order[car.position - 2];
    if (!ahead) return '';
    const laps = Math.floor((ahead.progress - car.progress) / race.track.length);
    if (laps >= 1) return `+${laps}L`;
    return `+${(race.gapAhead(car)).toFixed(1)}`;
  }

  // Five cars either side of you, which is all that can affect your race.
  _window(order, player) {
    const i = order.indexOf(player);
    const start = clamp(i - 3, 0, Math.max(0, order.length - 8));
    return order.slice(start, start + 8);
  }

  // The track map, drawn once into a Path2D and then reused every frame.
  _map(race, player) {
    const c = this.map;
    const W = 432;
    const track = race.track;

    // Two maps, because there are two kinds of stage.
    //
    // A circuit fits on the panel: the whole lap, always the same way up, with
    // everybody's dot on it — that is a timing screen, and on a two-kilometre
    // loop it tells you where the field is. A route does not fit and would not
    // help if it did. Eleven kilometres squeezed into two hundred pixels is a
    // line with a dot on it that does not appear to move, and what you need on
    // a run is the next few hundred metres and who is in them.
    //
    // So a route gets a scrolling window: centred on the car, turned so the
    // way you are going is up, and scaled to show a few hundred metres of road
    // rather than all of it.
    const rolling = race.route !== null;
    if (rolling) this._rollingMap(race, player, W);
    else this._wholeMap(race, player, W);
    void c;
  }

  // The whole circuit, fixed, north-up.
  _wholeMap(race, player, W) {
    const c = this.map;
    const track = race.track;
    if (!this._mapPath) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of track.samples) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      const pad = 26;
      const scale = Math.min((W - pad * 2) / (maxX - minX), (W - pad * 2) / (maxZ - minZ));
      this._mapT = {
        scale,
        ox: W / 2 - ((minX + maxX) / 2) * scale,
        oz: W / 2 - ((minZ + maxZ) / 2) * scale,
      };
      const path = new Path2D();
      track.samples.forEach((p, i) => {
        const x = p.x * scale + this._mapT.ox, z = p.z * scale + this._mapT.oz;
        if (i === 0) path.moveTo(x, z); else path.lineTo(x, z);
      });
      if (track.closed) path.closePath();
      this._mapPath = path;
    }
    const T = this._mapT;
    const X = (x) => x * T.scale + T.ox;
    const Z = (z) => z * T.scale + T.oz;

    c.clearRect(0, 0, W, W);
    c.lineJoin = 'round';
    // The circuit drawn as a pale road on a dark surround, not the other way
    // round. It was a near-black line inside a faint grey halo — which is what
    // the real thing looks like from above at night, and which on a small
    // translucent panel is very close to invisible. The map is a diagram; it
    // should read at a glance from the corner of your eye.
    c.lineWidth = 15;
    c.strokeStyle = 'rgba(10, 14, 20, 0.75)';
    c.stroke(this._mapPath);
    c.lineWidth = 10;
    c.strokeStyle = 'rgba(240, 245, 250, 0.92)';
    c.stroke(this._mapPath);

    // The start line.
    const sl = track.startLine;
    c.strokeStyle = '#e8452f';                 // was white, on white
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(X(sl.x + sl.nx * 8), Z(sl.z + sl.nz * 8));
    c.lineTo(X(sl.x - sl.nx * 8), Z(sl.z - sl.nz * 8));
    c.stroke();

    for (const car of race.cars) {
      if (car.traffic) continue;
      this._carDot(c, X(car.vehicle.x), Z(car.vehicle.z), car);
    }
    void player;
  }

  // A window on the road ahead, centred on the car and turned to face the way
  // it is going.
  _rollingMap(race, player, W) {
    const c = this.map;
    const track = race.track;
    const v = player.vehicle;
    const AHEAD = 340;                          // metres of road shown
    const scale = W / (AHEAD * 1.35);
    const cx = W / 2, cy = W * 0.66;            // the car sits low, looking up

    // World to panel, rotated so the car's heading points up the screen.
    const sy = Math.sin(v.yaw), cy2 = Math.cos(v.yaw);
    const to = (x, z) => {
      const dx = x - v.x, dz = z - v.z;
      // Forward is +z in the body frame and +x is the car's LEFT, so screen-x
      // is the NEGATED lateral: get this the other way round and the map is a
      // mirror, which is worse than no map at all.
      const fwd = dx * sy + dz * cy2;
      const lat = dx * cy2 - dz * sy;
      return [cx - lat * scale, cy - fwd * scale];
    };

    c.clearRect(0, 0, W, W);
    c.lineJoin = 'round';
    c.lineCap = 'round';

    // The road, from a bit behind to well ahead. Walked by distance rather
    // than drawn from a cached path, because the path moves every frame.
    const here = player.loc ? player.loc.s : 0;
    const step = Math.max(track.step * 2, 6);
    const draw = (width, style) => {
      c.lineWidth = width;
      c.strokeStyle = style;
      c.beginPath();
      let first = true;
      for (let d = -AHEAD * 0.35; d <= AHEAD; d += step) {
        const s = here + d;
        if (!track.closed && (s < 0 || s > track.length)) continue;
        const p = track.atDistance(s);
        const [x, y] = to(p.x, p.z);
        if (first) { c.moveTo(x, y); first = false; } else { c.lineTo(x, y); }
      }
      c.stroke();
    };
    draw(Math.max(6, 15 * scale * 0.9), 'rgba(10, 14, 20, 0.75)');
    draw(Math.max(4, 11 * scale * 0.9), 'rgba(240, 245, 250, 0.92)');

    // Where it ends, if the end is in view — the thing the whole stage is for.
    if (!track.closed && here + AHEAD > track.length - 4) {
      const e = track.atDistance(track.length - 2);
      const [ex, ey] = to(e.x, e.z);
      c.strokeStyle = '#35d06a';
      c.lineWidth = 4;
      c.beginPath();
      c.moveTo(...to(e.x + e.nx * 14, e.z + e.nz * 14));
      c.lineTo(...to(e.x - e.nx * 14, e.z - e.nz * 14));
      c.stroke();
      void ex; void ey;
    }

    for (const car of race.cars) {
      // Traffic is not on the map. Ninety commuters and three police cars is
      // ninety-three dots, and the three that matter are indistinguishable in
      // it — which is the opposite of what a minimap is for.
      if (car.traffic) continue;
      const [x, y] = to(car.vehicle.x, car.vehicle.z);
      if (x < -20 || x > W + 20 || y < -20 || y > W + 20) continue;
      this._carDot(c, x, y, car);
    }
  }

  // One car's dot. Pursuers get a light bar rather than a body colour: three
  // identical white saloons are three identical white dots, and what you need
  // to know at a glance is not what colour they are.
  _carDot(c, x, y, car) {
    const cop = car.pursuer;
    const on = Math.floor(this.game.time * 5) % 2;
    c.fillStyle = cop
      ? (on ? '#ff2a1e' : '#2a6bff')
      : `#${car.livery.body.toString(16).padStart(6, '0')}`;
    c.beginPath();
    c.arc(x, y, car.isPlayer ? 7 : (cop ? 6 : 5), 0, Math.PI * 2);
    c.fill();
    if (cop) {
      // A ring in the other colour, so a unit reads as a unit even on the
      // frame its dot is the same colour as somebody's paint.
      c.strokeStyle = on ? '#2a6bff' : '#ff2a1e';
      c.lineWidth = 2.5;
      c.stroke();
    }
    if (car.isPlayer) {
      c.strokeStyle = '#fff';
      c.lineWidth = 2.5;
      c.stroke();
    }
  }

  results(race) {
    const order = race.order;
    const winner = order[0];
    this.el.resultsSub.textContent =
      race.route !== null
        ? `${race.track.name} · ${(race.route / 1000).toFixed(2)} KM · ${race.cars.length} CARS`
        : `${race.track.name} · ${race.laps} LAP${race.laps === 1 ? '' : 'S'} · ${race.cars.length} CARS`;
    this.el.resultRows.innerHTML = order.map((c, i) => {
      const gap = i === 0 ? '—'
        : c.finished ? `+${(c.finishTime - winner.finishTime).toFixed(3)}`
        : `+${Math.max(1, Math.floor((winner.progress - c.progress) / race.track.length))}L`;
      return `<tr class="${c.isPlayer ? 'you' : ''}">
        <td>${ordinal(i + 1)}</td>
        <td><span class="swatch" style="background:#${c.livery.body.toString(16).padStart(6, '0')}"></span>${c.name}</td>
        <td>${c.finished ? lapTime(c.finishTime) : 'DNF'}</td>
        <td>${lapTime(c.bestLap)}</td>
        <td>${gap}</td>
      </tr>`;
    }).join('');
    this.el.results.classList.add('open');
  }

  // The minimap path is built once from the track's samples and cached. Swap
  // the track without this and it draws the old circuit forever — silently.
  trackChanged() { this._mapPath = null; this._mapT = null; this._cache = {}; }

  hideResults() { this.el.results.classList.remove('open'); }
}

void CAR;
