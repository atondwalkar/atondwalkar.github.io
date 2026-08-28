// Drift scoring.
//
// Points accrue while the car is genuinely sideways and genuinely moving, and
// a chain multiplier builds the longer the slide is held — so one long drift
// through a corner is worth more than three stabs at it. The chain BANKS when
// the car straightens up cleanly and is LOST to a wall: risk is the mechanic,
// and a scoring system with no way to lose the chain is a taximeter.
//
// All of it reads numbers the vehicle already computes. The slip angle is the
// same atan2(v, u) the drift AI regulates and the HUD's grip light reads —
// this is a THIRD reader of that number, not a second definition of it.

import { clamp } from './utils.js';

// Below `minSlip` (radians) it is cornering, not drifting; below `minSpeed`
// (m/s) it is a handbrake turn in a car park. `bankT` seconds of running
// straight banks the chain; a hit loud enough for the damage model to notice
// drops it.
export const DRIFT = {
  minSlip: 0.18,               // ~10 degrees
  minSpeed: 8,                 // 29 km/h
  bankT: 0.8,
  rate: 18,                    // points per second at minSlip, scales up
  chainRate: 0.25,             // multiplier gained per second sideways
  chainMax: 5,
};

export class DriftScore {
  constructor() {
    this.total = 0;
    this.chain = 0;            // unbanked points riding on the current run
    this.mult = 1;
    this.straightT = 0;
    this.sliding = false;
  }

  // One fixed step. `v` is the vehicle, `onTrack` whether the points count —
  // a drift across the pavement is worth nothing, or the fastest line through
  // the score is off the course.
  step(dt, v, onTrack) {
    const slip = Math.abs(Math.atan2(v.v, Math.max(Math.abs(v.u), 1)));
    const speed = Math.abs(v.u);
    const drifting = slip > DRIFT.minSlip && speed > DRIFT.minSpeed && onTrack;

    if (drifting) {
      this.sliding = true;
      this.straightT = 0;
      // Steeper and faster is worth more, linearly in both — the exotic
      // scoring curves of the genre are tuning, and tuning starts simple.
      const k = (slip / DRIFT.minSlip) * (speed / 20);
      this.chain += DRIFT.rate * k * this.mult * dt;
      this.mult = Math.min(DRIFT.chainMax, this.mult + DRIFT.chainRate * dt);
    } else if (this.sliding) {
      // Straight: hold for `bankT` and the chain banks.
      this.straightT += dt;
      if (this.straightT >= DRIFT.bankT) this.bank();
    }
  }

  bank() {
    this.total += this.chain;
    this.chain = 0;
    this.mult = 1;
    this.sliding = false;
    this.straightT = 0;
  }

  // A wall or another car: the chain is gone, the banked total stays.
  drop() {
    this.chain = 0;
    this.mult = 1;
    this.sliding = false;
    this.straightT = 0;
  }
}
