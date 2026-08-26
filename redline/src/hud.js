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
      curLap: $('cur-lap'), lastLap: $('last-lap'), bestLap: $('best-lap'), gap: $('gap-ahead'),
      speed: $('speed'), gear: $('gear'), autobox: $('autobox'),
      thr: $('thr').firstElementChild, brk: $('brk').firstElementChild,
      hbk: $('hbk').firstElementChild, wheel: $('wheel').firstElementChild,
      grip: $('grip'), standings: $('standings'), rows: $('standings-rows'),
      lights: $('lights'), message: $('message'), flash: $('flash-lap'),
      results: $('results'), resultRows: $('results-rows'), resultsSub: $('results-sub'),
    };
    this.tacho = $('tacho-c').getContext('2d');
    this.map = $('map-c').getContext('2d');
    this.messageT = 0;
    this.flashT = 0;
    this.showAll = false;
    this._cache = {};
    this._mapPath = null;
  }

  show() { this.el.hud.style.display = 'block'; }

  // Only touch the DOM when the value has actually changed.
  _set(key, el, value) {
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    el.textContent = value;
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
    this._set('pos', this.el.pos, `${car.position}/${RACE.cars}`);
    // The lap you are ON is the number of times you have crossed the line,
    // not that plus one.
    //
    // The grid is behind the start line, so the first crossing a few seconds
    // after the lights is the START of lap one, not the end of one — the lap
    // counter already treats it that way, and `lap` is the count of crossings.
    // Displaying `lap + 1` meant the board read "1/3" on the grid, which is
    // right, and then flicked to "2/3" the moment you crossed the line for the
    // first time, which is a lap you had not driven.
    const lap = clamp(Math.max(car.lap, 1), 1, RACE.laps);
    this._set('lap', this.el.lap, `${lap}/${RACE.laps}`);
    this.el.lap.classList.toggle('final', lap === RACE.laps && race.state === 'racing');
    this._set('rt', this.el.raceTime, lapTime(race.state === 'countdown' ? 0 : race.time));

    // --- timing
    const cur = race.started && !car.finished ? race.time - car.lapStart : 0;
    this._set('cur', this.el.curLap, lapTime(cur));
    this._set('last', this.el.lastLap, lapTime(car.lastLap));
    this._set('best', this.el.bestLap, lapTime(car.bestLap));
    this._set('gap', this.el.gap, car.position === 1 ? 'LEADER' : gapTime(race.gapAhead(car)));

    // --- dash
    this._set('spd', this.el.speed, String(Math.round(Math.abs(v.speedKmh))));
    const gearName = v.gear === 0 ? 'R' : v.gear === 1 ? 'N' : String(v.gear - 1);
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
    this._standings(race, car);
    this._map(race, car);

    // --- transient text
    this.messageT = Math.max(0, this.messageT - dt);
    this.el.message.style.opacity = this.messageT > 0 ? Math.min(1, this.messageT * 2.2) : 0;
    this.flashT = Math.max(0, this.flashT - dt);
    this.el.flash.style.opacity = this.flashT > 0 ? Math.min(1, this.flashT * 2.2) : 0;
  }

  // The rev counter, drawn as an arc with the redline marked. It is the one
  // instrument that has to be readable out of the corner of your eye.
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
      path.closePath();
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
      const x = X(car.vehicle.x), z = Z(car.vehicle.z);
      c.fillStyle = `#${car.livery.body.toString(16).padStart(6, '0')}`;
      c.beginPath();
      c.arc(x, z, car.isPlayer ? 7 : 5, 0, Math.PI * 2);
      c.fill();
      if (car.isPlayer) {
        c.strokeStyle = '#fff';
        c.lineWidth = 2.5;
        c.stroke();
      }
    }
    void player;
  }

  results(race) {
    const order = race.order;
    const winner = order[0];
    this.el.resultsSub.textContent =
      `${race.track.constructor.name === 'Track' ? 'CIRCUIT DE VALMONT' : ''} · ${RACE.laps} LAPS · ${RACE.cars} CARS`;
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

  hideResults() { this.el.results.classList.remove('open'); }
}

void CAR;
