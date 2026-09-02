// The dashboard. Two canvases do the work — the rev counter and the track map —
// and the rest is text that is only rewritten when it changes, because setting
// textContent on a dozen elements sixty times a second is a real cost for
// something nobody can read that fast.

import { RACE, CAR } from './defs.js';
import { clamp, lerp, lapTime, gapTime, ordinal } from './utils.js';

// How hard the minimap leans away from the viewer: 1 is a ceiling plan, and
// the GPS-on-the-dash look sits around three fifths.
const MAP_TILT = 0.62;

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor(game) {
    this.game = game;
    this.el = {
      hud: $('hud'), pos: $('pos-v'), lap: $('lap-v'), raceTime: $('race-time'),
      lapK: $('lap-k'), rtK: $('rt-k'),
      heat: $('heat'), heatBar: document.querySelector('#heat .bar i'),
      dmgCell: $('dmg-cell'), dmgV: $('dmg-v'),
      driftTotal: $('drift-total'), driftChain: $('drift-chain'),
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
    this._webFor = null;
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
    this.el.hud.classList.toggle('run', race.route !== null || !!race.escape || !!race.drift);
    this.el.hud.classList.toggle('escape', !!race.escape);
    this.el.hud.classList.toggle('drift', !!race.drift);
    // The score: banked total large, the chain and its multiplier riding
    // above it in amber — the number you are one wall away from losing.
    if (race.drift && this.el.driftTotal) {
      this._set('dtot', this.el.driftTotal, String(Math.floor(race.drift.total)));
      const c = race.drift.chain;
      this._set('dch', this.el.driftChain,
        c > 0.5 ? `+${Math.floor(c)} ×${race.drift.mult.toFixed(1)}` : '');
      this.el.driftChain.classList.toggle('hot', race.drift.mult > 2.5);
    }
    // The heat meter: how close the player is to having lost them. Filling
    // while nobody is near; red and empty the moment somebody is.
    if (race.escape && this.el.heatBar) {
      const k = clamp((race.coolT || 0) / race.escape.hold, 0, 1);
      this.el.heatBar.style.width = `${(k * 100).toFixed(1)}%`;
      this.el.heat.classList.toggle('hot', race.nearestHeat <= race.escape.clear);
    }
    // Damage, where the stage takes it.
    if (this.el.dmgCell) {
      const on = !!race.damageMax;
      this.el.dmgCell.style.display = on ? '' : 'none';
      if (on) {
        const k = (race.damage || 0) / race.damageMax;
        this.el.dmgV.textContent = `${Math.round(k * 100)}%`;
        this.el.dmgV.classList.toggle('warn', k > 0.5 && k <= 0.8);
        this.el.dmgV.classList.toggle('crit', k > 0.8);
      }
    }
    if (race.drift) {
      // The board is target and clock: how many points still owed, how long.
      const owed = Math.max(0, race.driftTarget - race.drift.total - race.drift.chain);
      this._set('lapk', this.el.lapK, 'TO GO');
      this._set('lap', this.el.lap, String(Math.ceil(owed)));
      this.el.lap.classList.toggle('final', owed < race.driftTarget * 0.15);
      const clock = Math.max(0, (race.limit ?? 0) - race.time);
      this._set('rtk', this.el.rtK, 'CLOCK');
      this._set('rt', this.el.raceTime, lapTime(race.state === 'countdown' ? race.limit ?? 0 : clock));
      this.el.raceTime.classList.toggle('urgent', clock < 30 && race.state === 'racing');
    } else if (race.escape) {
      // No distance readout — there is nowhere to get to. The clock stays.
      const clock = Math.max(0, (race.limit ?? 0) - race.time);
      this._set('rtk', this.el.rtK, 'CLOCK');
      this._set('rt', this.el.raceTime, lapTime(race.state === 'countdown' ? race.limit ?? 0 : clock));
      this.el.raceTime.classList.toggle('urgent', clock < 30 && race.state === 'racing');
    } else if (race.route !== null) {
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
    // One map for every stage: the navigator. It used to split — a fixed
    // north-up overview for circuits, the rolling window for routes — and the
    // overview was the weaker of the two everywhere it applied: on a lap you
    // still care most about the next three corners, and a chevron crawling
    // round a static squiggle tells you less about them than the road ahead
    // drawn ahead. The whole-lap picture the overview used to give is not
    // lost; it was never load-bearing.
    this._rollingMap(race, player, 432);
  }

  // The street web the map draws under the route.
  //
  // Generated, cached per track, and SEEDED from the layout's name — the same
  // city every time you look, which is the difference between a map and
  // static. The recipe walks the route and hangs street-shapes off it: full
  // crossings through the road, avenue fragments running parallel a block
  // out, and stubs that turn an L partway — the three shapes a real street
  // grid is mostly made of. Density and length are rolled per piece, which is
  // where the intricacy comes from; the seed is where the stillness does.
  _streetWeb(track) {
    if (this._webFor === track) return this._web;
    const segs = [];
    if (!track.layout.deck) {
      let seed = 0x9e3779b9;
      for (const ch of track.layout.id) seed = ((seed * 31) + ch.charCodeAt(0)) >>> 0;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      // The spawn interval comes off the layout's own block pitch, so the
      // map's density reflects the city's: the estuary's small tight blocks
      // give a busier web than downtown's long ones, and a layout with no
      // pitch of its own gets the default city's. One knob, already tuned by
      // the road it belongs to.
      const pitch = track.layout.pitch || { x: 52, z: 45 };
      const step = (pitch.x + pitch.z) * 0.72;
      for (let d = 0; d < track.length; d += step) {
        const p = track.atDistance(d);
        const along = Math.atan2(p.dirX, p.dirZ);
        const pieces = rnd() < 0.35 ? 2 : 1;
        for (let k = 0; k < pieces; k++) {
          const roll = rnd();
          if (roll < 0.42) {
            // A crossing: straight through the road, longer on one side.
            const ang = along + Math.PI / 2 + (rnd() - 0.5) * 0.12;
            const ux = Math.sin(ang), uz = Math.cos(ang);
            const l1 = 25 + rnd() * 85, l2 = 25 + rnd() * 85;
            segs.push([p.x - ux * l1, p.z - uz * l1, p.x + ux * l2, p.z + uz * l2]);
          } else if (roll < 0.72) {
            // An avenue fragment, a block out, running with the road.
            const side = rnd() < 0.5 ? -1 : 1;
            const off = 26 + rnd() * 46;
            const cx = p.x + p.nx * side * off, cz = p.z + p.nz * side * off;
            const ang = along + (rnd() - 0.5) * 0.1;
            const ux = Math.sin(ang), uz = Math.cos(ang);
            const len = 70 + rnd() * 130;
            segs.push([cx - ux * len / 2, cz - uz * len / 2, cx + ux * len / 2, cz + uz * len / 2]);
            // A third of the avenues carry one short cross-bar — enough to
            // knit the strokes into blocks here and there without turning the
            // panel into graph paper. The first cut gave every avenue one or
            // two, and the map was so busy the route had to fight it.
            if (rnd() < 0.35) {
              const at2 = (rnd() - 0.5) * len * 0.8;
              const bx = cx + ux * at2, bz = cz + uz * at2;
              const bl = 22 + rnd() * 45;
              segs.push([bx - uz * bl, bz + ux * bl, bx + uz * bl, bz - ux * bl]);
            }
          } else {
            // A stub that turns: out from the road, then an L at 45 or 90.
            const side = rnd() < 0.5 ? -1 : 1;
            const ang = along + Math.PI / 2 * side + (rnd() - 0.5) * 0.14;
            const ux = Math.sin(ang), uz = Math.cos(ang);
            const l1 = 26 + rnd() * 55;
            const ex = p.x + ux * l1, ez = p.z + uz * l1;
            segs.push([p.x, p.z, ex, ez]);
            const turn = (rnd() < 0.5 ? 1 : -1) * (rnd() < 0.4 ? Math.PI / 4 : Math.PI / 2);
            const a2 = ang + turn;
            const l2 = 30 + rnd() * 65;
            segs.push([ex, ez, ex + Math.sin(a2) * l2, ez + Math.cos(a2) * l2]);
          }
        }
      }
    }
    this._webFor = track;
    this._web = segs;
    return segs;
  }

  // The tilt: the map squashed vertically about a pivot, which is the classic
  // GPS-on-the-dash look — you are looking at a table, not at a ceiling plan.
  // An affine squash rather than true perspective, because 2D canvas has no
  // perspective and at this size the difference is invisible.
  _tilted(c, pivotY, draw) {
    c.save();
    c.translate(0, pivotY * (1 - MAP_TILT));
    c.scale(1, MAP_TILT);
    draw();
    c.restore();
  }

  // The chevron: the player is a heading, not a dot. `angle` is screen-space,
  // 0 pointing up.
  _chevron(c, x, y, angle) {
    c.save();
    c.translate(x, y);
    c.rotate(angle);
    c.beginPath();
    c.moveTo(0, -10);
    c.lineTo(7.5, 8);
    c.lineTo(0, 3.6);
    c.lineTo(-7.5, 8);
    c.closePath();
    c.fillStyle = '#ffffff';
    c.fill();
    c.lineWidth = 2.5;
    c.strokeStyle = 'rgba(10, 14, 20, 0.9)';
    c.stroke();
    c.restore();
  }

  // A window on the road ahead, centred on the car and turned to face the way
  // it is going.
  _rollingMap(race, player, W) {
    const c = this.map;
    const track = race.track;
    const v = player.vehicle;
    // Two hundred metres of road, not three-forty: a navigator is about the
    // next two corners, and zoom is what makes the chevron feel like it is
    // moving.
    const AHEAD = 210;
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
    this._tilted(c, cy, () => {
    c.lineJoin = 'round';
    c.lineCap = 'round';

    // The fake streets first, in white: a generated web, not the literal side
    // streets. The world's cosmetic streets are sparse — one stub per corner —
    // and a map that reflects them faithfully reads as a road with whiskers.
    // A navigator's map wants a CITY under the route, so the map draws one of
    // its own: it is the one place in the game where the streets are allowed
    // to be fiction, because a minimap is already a fiction about what the
    // world looks like from above.
    const here = player.loc ? player.loc.s : 0;
    const web = this._streetWeb(track);
    if (web.length) {
      c.lineWidth = Math.min(6, Math.max(2.2, 4.6 * scale * 0.9));
      c.strokeStyle = 'rgba(235, 240, 246, 0.7)';
      c.beginPath();
      for (const q of web) {
        // Cheap cull by world distance to the car before projecting.
        const mx = (q[0] + q[2]) / 2, mz = (q[1] + q[3]) / 2;
        if ((mx - v.x) * (mx - v.x) + (mz - v.z) * (mz - v.z) > AHEAD * AHEAD * 1.7) continue;
        const [x1, y1] = to(q[0], q[1]);
        const [x2, y2] = to(q[2], q[3]);
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
      }
      c.stroke();
    }

    // The route, walked by distance rather than drawn from a cached path,
    // because the path moves every frame — in BLUE, the one colour nothing
    // else on the map uses.
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
    draw(Math.min(18, Math.max(6, 15 * scale * 0.9)), 'rgba(8, 18, 38, 0.8)');
    draw(Math.min(13, Math.max(4, 11 * scale * 0.9)), '#4593f0');

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
      if (car.traffic || car.isPlayer) continue;
      const [x, y] = to(car.vehicle.x, car.vehicle.z);
      if (x < -20 || x > W + 20 || y < -20 || y > W + 20) continue;
      this._carDot(c, x, y, car);
    }
    // The map is rotated so the heading is up, which makes the player's
    // chevron a fixture: centre of the panel, pointing at the top of it.
    this._chevron(c, cx, cy, 0);
    });
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
  // A hit landed: pulse the damage number so it is seen to move.
  damaged(k) {
    if (!this.el.dmgV) return;
    this.el.dmgV.style.transform = 'scale(1.3)';
    setTimeout(() => { this.el.dmgV.style.transform = ''; }, 120);
    void k;
  }

  trackChanged() { this._webFor = null; this._web = null; this._cache = {}; }

  hideResults() { this.el.results.classList.remove('open'); }
}

void CAR;
