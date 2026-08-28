// The campaign.
//
// A list of stages, each a race with stakes, a cutscene in front of it and one
// of two behind it depending on how it went. The stages are data; the only
// code here is what carries state between them — which car you are driving,
// what is on the line, and how many times you have had to run this one back.
//
// Losing costs nothing permanent, deliberately. A pink-slip race you can lose
// for good is a pink-slip race you save-scum, and the wager is there to give
// the first corner some weight, not to end the evening.

import { RIVAL, POLICE, TRAFFIC, SELECTABLE, LIVERIES } from './defs.js';

export const STAGES = [
  {
    id: 'folsom',
    name: 'FOLSOM & SIXTH',
    blurb: 'THREE LAPS. PINK SLIPS.',
    laps: 3,
    contact: true,
    rival: RIVAL,
    before: 'WAGER',
    onWin: 'POLICE_ARRIVE',
    onLose: 'LOST_THE_CAR',
    layout: 'folsom',
    next: 'escape',
  },
  {
    id: 'escape',
    name: 'CROSSTOWN',
    blurb: 'GET TO THE RAMP.',
    layout: 'run',
    before: 'ON_THE_RUN',
    // Four and a half kilometres of city, driven four fifths of the way round
    // — the last fifth exists so the geometry closes and is never reached.
    // Expressed as a fraction here and turned into metres against whatever
    // that layout actually measures, so a change to the loop moves the ramp
    // with it instead of stranding it in the middle of a block.
    // The whole road. It is an open route now, not four fifths of a lap, so
    // the finish is where the tarmac runs out and the on-ramp begins.
    routeFraction: 1,
    laps: 1,
    contact: true,
    // How long you have, and how many of them are behind you.
    limit: 175,
    police: 3,
    // Lose them by this much and they turn up again — what you notice is not
    // the move, which happens behind you, but that they are still there.
    leash: 340,
    // And fresh ones cutting in ahead, so a lead is not the end of the stage.
    intercept: { every: 8, from: 260, to: 520, max: 10 },
    rival: null,
    onWin: 'ESCAPE',
    onLose: 'PULLED_OVER',
    next: 'bridge',
  },
  {
    id: 'bridge',
    name: 'THE GOLDEN GATE',
    blurb: 'SIX LANES. NOWHERE TO TURN OFF.',
    layout: 'bridge',
    before: 'THE_APPROACH',
    routeFraction: 1,
    laps: 1,
    contact: true,
    // Eight minutes.
    //
    // The clock used to be set against a clean solo lap — a hundred and
    // fifty-five seconds — and that number turns out to describe a drive
    // nobody takes. Measured properly, on the deck this stage actually
    // presents, threading three hundred and sixty-four cars of traffic costs
    // about a hundred and fifty per cent on top: a POPULATED crossing at
    // ninety-five per cent skill is three hundred and eighty-one seconds.
    //
    // So three hundred and seventy, which was two minutes more than the old
    // figure and looked generous, was in fact unwinnable — by the AI, never
    // mind by a person with police turning across the road in front of them.
    // Four hundred and eighty is a quarter more than the measured crossing.
    limit: 480,
    police: 3,
    leash: 380,
    intercept: { every: 7, from: 300, to: 620, max: 12 },
    // Traffic as a SPACING, not as a count.
    //
    // It was a count, and a count does not survive the road changing length:
    // eighteen cars is thick on a two-kilometre deck and one car every six
    // hundred metres on an eleven-kilometre one, which is an empty bridge with
    // eighteen cars parked on it. What matters is how often you have to go
    // round something, so that is the number that gets written down and the
    // count is worked out from whatever the deck measures.
    trafficEvery: 30,
    rival: null,
    onWin: 'ACROSS',
    onLose: 'PULLED_OVER',
    next: null,
  },
];

// The centre of each lane on a road, from its width and its lane width.
//
// Six lanes on a 21.6 m deck are centred at ±1.8, ±5.4 and ±9.0 — the numbers
// halfway BETWEEN the painted lines, which is where a car goes. Derived rather
// than written down so that changing the deck's width moves the traffic with
// it instead of leaving it parked on the markings.
export function laneCentres(track) {
  const layout = (track && track.layout) || {};
  const width = layout.width || 11.6;
  const lane = layout.lane || 2.9;
  const n = Math.max(1, Math.round(width / lane));
  const out = [];
  for (let k = 0; k < n; k++) out.push((k - (n - 1) / 2) * lane);
  return out;
}

// How many cars of traffic a stage puts on a road: its spacing divided into
// the length of the road, or a flat count if that is what it asked for.
//
// Capped, because this is one car and one driver each and a bridge is long.
// The cap is a backstop against a layout change producing a thousand cars, not
// a tuning knob: ninety-five cars measured at 0.15 ms a step, so the number
// that matters here is how much road there is between them, not how many of
// them there are.
// How fast a lane moves.
//
// By LANE, not by car. Give two cars in the same lane speeds five metres a
// second apart and the quick one drives into the back of the slow one and
// stays there — which is what put stacks of cars down the bridge. Real traffic
// sorts itself this way round anyway: slow on the outside, quick on the
// inside, and everybody in a lane doing roughly what the lane is doing.
export function laneSpeed(lanes, lane) {
  const k = lanes.indexOf(lane);
  const f = lanes.length > 1 ? k / (lanes.length - 1) : 0.5;
  return 11 + f * 9;                    // 40 to 72 km/h across the deck
}

export function trafficCount(stage, track) {
  if (stage.traffic) return stage.traffic;
  if (!stage.trafficEvery || !track) return 0;
  return Math.min(TRAFFIC_CAP, Math.round(track.length / stage.trafficEvery));
}

// A backstop against a layout change producing a thousand cars, not a tuning
// knob — the number that matters is the spacing. Raised with the density,
// because a cap below what the spacing asks for silently makes the spacing a
// lie: at one car every thirty metres an eleven-kilometre bridge wants three
// hundred and sixty-four of them.
const TRAFFIC_CAP = 420;

export class Campaign {
  constructor(game) {
    this.game = game;
    this.index = 0;
    this.attempts = 0;
    this.car = null;         // the livery the player chose, kept across retries
    this.wagered = null;     // what is on the line this stage
    this.won = [];           // liveries taken off rivals
  }

  get stage() { return STAGES[this.index]; }

  // The scene that leads INTO this stage. Its own, always.
  //
  // It used to fall back to the PREVIOUS stage's `onWin` when a stage had none
  // of its own, which made the same scene play in two different worlds: in
  // normal play it ran on the circuit you had just won on, with the rival in
  // it; reached by a cheat it ran on the stage you were arriving at, with
  // police in it. Same script, two different films — which is exactly what it
  // looked like.
  //
  // Every stage has its own `before` now, so a scene only ever plays in one
  // place with one cast, whichever way you got there. What normal play shows
  // in ADDITION is the last stage's payoff, which is correct: winning has an
  // ending and arriving has an opening, and they are not the same beat.
  introScene() { return this.stage.before || null; }

  setWager(livery) { this.wagered = livery || this.car; }

  // The field for the current stage.
  //
  // A duel is the rival at the front and you behind it. A run is you at the
  // front and the police behind, which is the same list read the other way up
  // — the grid is in order, so whoever is meant to be chasing goes last.
  //
  // The rival takes a livery nobody else is using and, more importantly, one
  // that is not YOURS — losing your own car to a car that looks like it is
  // reads as a bug however correct the bookkeeping is.
  field(track) {
    const s = this.stage;
    const mine = this.car || SELECTABLE[0];

    // Four independent blocks, not a branch.
    //
    // This used to be `if (rival) { rival; me } else { me; traffic; police }`,
    // so a stage was EITHER a duel OR a pursuit and could never be both. That
    // one `if` ruled out most of what a campaign wants: a race through
    // traffic, a race the police join, a duel with civilians in the way. The
    // grid is in order, so who goes where in the list is the only thing that
    // decides who starts in front.
    const rivals = s.rivals || (s.rival ? [s.rival] : []);
    const chase = (s.police || 0) > 0;
    const me = { livery: mine, isPlayer: true, name: this.game.playerName || mine.name };
    const cars = [];

    // Rivals start ahead of you in a race and you start ahead of the police in
    // a pursuit, so a stage with both puts you in the middle — which is
    // exactly where a race with the police joining it should put you.
    const taken = new Set([mine.name]);
    for (const r of rivals) {
      const livery = LIVERIES.find((l) => !taken.has(l.name)) || LIVERIES[0];
      taken.add(livery.name);
      cars.push({ livery, name: r.name, skill: r.skill, opts: r.opts });
    }
    cars.push(me);

    // Traffic, in the middle of each lane. They were at 0 and ±3.6 and ±7.2,
    // which are the lane LINES on a six-lane deck rather than the lanes
    // between them, so every car sat astride a marking.
    //
    // Interleaved, so consecutive cars are not in adjacent lanes and every
    // lane is used: stepping by two through six lanes only ever lands on the
    // odd ones, which is what put eighteen cars into half a bridge.
    const all = laneCentres(track);
    const lanes = all.filter((_, k) => k % 2 === 0).concat(all.filter((_, k) => k % 2 === 1));
    for (let i = 0; i < trafficCount(s, track); i++) {
      const k = i % lanes.length;
      cars.push({
        livery: TRAFFIC[i % TRAFFIC.length],
        name: '',
        traffic: true,
        lane: lanes[k],
        speed: laneSpeed(lanes, lanes[k]),
      });
    }

    for (let i = 0; i < (s.police || 0); i++) {
      cars.push({
        livery: POLICE.livery,
        name: `${POLICE.name} ${i + 1}`,
        skill: POLICE.skill,
        // Each unit takes a different place in the box: the bumper and both
        // flanks. Three cars all trying to sit on the same bumper is a queue,
        // not a pursuit.
        opts: { ...POLICE.opts, station: i },
        pursuer: true,
      });
    }

    return {
      cars,
      laps: s.laps,
      contact: s.contact,
      limit: s.limit ?? null,
      // Flags of their own now, rather than inferred from whether there
      // happens to be a rival: a race the police join still ends when somebody
      // takes the flag, and it still lines up as a grid.
      endOnFirst: s.endOnFirst ?? rivals.length > 0,
      formation: s.formation || (chase && !rivals.length ? 'pursuit' : 'grid'),
      leash: s.leash ?? null,
      intercept: s.intercept ?? null,
      // A fraction of whatever the layout came out at, so a change to the loop
      // moves the finish with it instead of stranding it inside a block.
      route: s.routeFraction && track ? s.routeFraction * track.length : null,
      // Metres between cars of traffic — carried through so the race can keep
      // topping it up ahead of the player rather than laying it out once.
      trafficEvery: s.trafficEvery || null,
    };
  }

  // On to the next one, keeping the car you drove here in.
  advance() {
    const next = STAGES.findIndex((x) => x.id === this.stage.next);
    if (next < 0) return false;
    this.index = next;
    this.attempts = 0;
    this.wagered = null;
    return true;
  }

  // Did the player take the stage?
  //
  // Two different questions depending on what the stage is. A duel is won by
  // finishing first. A run is won by REACHING THE RAMP, full stop — the police
  // drive the same road and one of them crossing the line ahead of you does
  // not mean you were caught, it means a police car got there first, which is
  // not the thing being asked. Running out of time is how a run is lost, and
  // that leaves the player unfinished.
  won_(race) {
    const p = race.player;
    if (!p) return false;
    return this.stage.routeFraction ? p.finished : (p.finished && p.position === 1);
  }
}
