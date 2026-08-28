// Cheat codes.
//
// A development door into the campaign: any stage, one typed word away, so
// something four minutes in can be looked at in four seconds. Written the way
// they were written in about 2003 — a short phrase out of the game's own
// fiction, typed in whole, no spaces.
//
// Nothing lists them. A panel that tells you the codes is not a cheat code, it
// is a level select with extra steps, and it hands a player who opened it out
// of curiosity the name of every stage in the game.

import { STAGES } from './campaign.js';

// `run` is handed the Game. Everything here goes through the same entry points
// the menu does, so a cheat cannot reach a state the game cannot.
//
// Stages only. There were codes for the five cutscenes too, and they were the
// wrong thing to ship: a cutscene is thirty seconds of the stage in front of
// it, so a code that plays one is a code that spoils one. The stage codes
// reach every scene anyway, in the place the scene is meant to be seen.
export const CHEATS = [
  { code: 'FOLSOMANDSIXTH', what: 'stage one, the duel', stage: 'folsom' },
  { code: 'GOLDENGATE', what: 'stage two, the run', stage: 'escape' },
  { code: 'SIXLANESOUT', what: 'stage three, the bridge', stage: 'bridge' },
  { code: 'NOTLUCK', what: 'stage four, the yards', stage: 'estuary' },
  { code: 'FIRSTLIGHT', what: 'stage five, the sprint', stage: 'skyline' },
  { code: 'STYLECOUNTS', what: 'stage six, the yard', stage: 'yard' },
  { code: 'RAINCHECK', what: 'stage seven, the wet', stage: 'wetwork' },
  { code: 'LASTCALL', what: 'stage eight, the escape', stage: 'lastcall' },
  // The ghost runs. `trial` rather than `stage`: a time trial on that layout,
  // against your own saved best — and the codes are refused until the campaign
  // has been finished, which makes them the one thing here that is a reward
  // rather than a door.
  { code: 'GHOSTRUN', what: 'time trial, the circuit', trial: 'folsom' },
  { code: 'GHOSTCROSSTOWN', what: 'time trial, crosstown', trial: 'run' },
  { code: 'GHOSTGATE', what: 'time trial, the bridge', trial: 'bridge' },
];

// Typed however: spaces, punctuation and case are all thrown away, because
// nobody types a cheat code carefully.
export const normalise = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function findCheat(typed) {
  const want = normalise(typed);
  return CHEATS.find((c) => normalise(c.code) === want) || null;
}

// Every code has to reach a stage that exists. A cheat naming a stage which
// has been renamed fails silently — you type it, nothing happens, and there is
// no way to tell that from the cheat not being wired up at all.
export function unresolved() {
  const bad = [];
  for (const c of CHEATS) {
    if (c.trial) continue;              // checked against LAYOUTS by the tests
    if (!STAGES.some((s) => s.id === c.stage)) {
      bad.push(`${c.code} goes to "${c.stage}", which is not a stage`);
    }
  }
  return bad;
}
