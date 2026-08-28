// The numbers. Everything the simulation reads about a car lives here, in real
// units — kilograms, metres, newton-metres, revolutions per minute — so the
// physics can be written as physics rather than as fudge factors.

export const RACE = {
  laps: 3,
  cars: 16,                 // you and fifteen others
  gridGap: 8.5,             // metres between rows on the grid
  gridStagger: 3.4,         // and the sideways offset of alternate rows
  countdown: 5,             // red lights, then green
  formationTime: 0,         // no formation lap: this is a standing start
};

// The torque curve, in newton-metres against rpm. A modern turbocharged GT
// engine: a big flat plateau, falling away past peak power.
const TORQUE = [
  [800, 210], [1500, 340], [2500, 430], [3500, 470], [4500, 480],
  [5500, 465], [6500, 430], [7200, 380], [7800, 300], [8200, 180],
];

export const CAR = {
  name: 'GT',
  mass: 1290,               // kg, with driver and fuel
  wheelbase: 2.62,          // m
  track: 1.60,              // m between the wheels on an axle
  cgHeight: 0.40,           // m — the higher it is, the more weight transfers,
                            // and the more the rear unloads on the way into a corner
  weightFront: 0.46,        // static fraction on the front axle
  wheelRadius: 0.34,        // m
  wheelInertia: 1.5,        // kg m^2 per driven wheel
  engineInertia: 0.28,      // kg m^2, crank plus flywheel
  idleRpm: 950,
  stallRpm: 700,
  redline: 7800,
  limiter: 8000,            // hard cut
  torque: TORQUE,
  // Six speeds and a final drive. Top gear pulls about 300 km/h at the redline.
  // [R, 1..6]. No neutral.
  //
  // There was one, at index 1, and it earned nothing: you cannot coast to any
  // advantage in a race this short, selecting it by hand only ever cost you
  // drive, and it sat between first and reverse so that shifting down twice at
  // a standstill put you in reverse by accident. Reverse is chosen the way it
  // always was — hold the brake at a standstill — not by shifting past a
  // neutral to reach it.
  gears: [-3.30, 3.60, 2.35, 1.72, 1.35, 1.10, 0.90],
  finalDrive: 3.55,
  shiftTime: 0.16,          // seconds of cut torque while the gear changes
  clutchTorque: 620,        // Nm the clutch can hold while it is slipping
  driveline: 0.90,          // efficiency
  // Tyres. muPeak is the coefficient at the slip where grip peaks.
  tyre: {
    muPeak: 1.78,
    peakSlipRatio: 0.11,    // longitudinal slip at peak grip
    peakSlipAngle: 0.145,   // radians of slip angle at peak grip (~8.3 degrees)
    stiffness: 12,          // how sharply force builds before the peak
    // What is left once a tyre is past its best slip. The classic tyre curve
    // drops away sharply here, and that drop is the whole of understeer and
    // snap oversteer: overshoot the peak by a little and the tyre gives you
    // less, so you overshoot by more. It makes a fine simulator and a bad car
    // to drive on a keyboard, where there is no half-lock and every ordinary
    // corner is therefore taken at full lock. At 0.96 the curve plateaus:
    // pushing past the limit scrubs a little speed and squeals, and that is
    // all. Sliding is something you ask for with the handbrake.
    falloff: 0.96,
    loadSensitivity: 0.000032, // grip per newton lost as load rises
    rearGrip: 1.12,         // wider tyres on the driven axle
    // What the car will actually hold in a steady corner, in g. Not the same
    // as muPeak: load sensitivity and lateral transfer both take a bite, and
    // the steering and the stability control both need to know the real
    // figure rather than the optimistic one. Measured by the smoke test.
    holdG: 1.45,
  },
  // The slip the anti-lock system holds the tyres at. It has to sit BELOW
  // peakSlipRatio: regulating above the peak spends the friction budget on
  // braking and leaves the tyre nothing to corner with, so the car slides
  // under the ordinary brake pedal.
  absSlip: 0.085,
  brakeTorque: 15000,       // Nm at the wheels, total — enough to lock them,
                            // which is what makes the anti-lock system matter
  brakeBias: 0.68,          // fraction to the front, before distribution
  handbrakeTorque: 8500,    // Nm on the rear axle, enough to lock it outright:
                            // this is the drift lever, and it has no ABS
  steerLock: 0.55,          // radians at the front wheels, about 31 degrees
  // Below this speed you get the whole steering lock; above it you get the
  // fraction (v/u)², which is exactly the shape of the angle a steady corner
  // at the tyres' limit needs. The ratio between what the steering can ask for
  // and what the tyres can deliver is therefore constant at any racing speed,
  // and is set by the lock and this number together — about 1.25 as tuned, so
  // holding a key gives very nearly the quickest turn the car has and only a
  // little more than it can use.
  //
  // It is the single most important number for whether the car is drivable.
  // With a plain 1/(1 + u²/f²) rolloff the ratio ran to more than five at
  // speed, so four fifths of the steering's travel could do nothing but scrub
  // the fronts or spin it; tightening that rolloff far enough to fix the top
  // end then took away the lock the hairpins need. A knee fixes both ends at
  // once: everything below walking-out-of-a-hairpin pace keeps full lock.
  fullLockBelow: 9.5,       // m/s, about 34 km/h
  steerMargin: 1.45,        // how far past the Ackermann angle the rack may go
  dragArea: 0.78,           // Cd * A, m^2
  downforce: 1.05,          // N per (m/s)^2 at the aero centre
  rollingResistance: 0.014,
  rearDrive: 1.0,           // rear-wheel drive: all torque to the back axle
  // How hard the stability control leans on a yaw departure, in units of "how
  // much of the error it takes out per second". Zero is a bare vehicle model
  // that will spin you for braking in a corner; this is enough that the foot
  // brake is never how a slide starts. The handbrake bypasses it entirely.
  stability: 7.5,
};

export const AIR_DENSITY = 1.225;
export const GRAVITY = 9.81;

// Damage and contact. Racing here is close but not destructive: a hit scrubs
// speed and unsettles the car rather than ending anyone's race.
// Hitting the scenery. There is no car-to-car contact — cars pass through one
// another — so this is entirely about the barriers.
export const CONTACT = {
  // How hard a hit lands, as a fraction of the full elastic exchange. At 1 a
  // glance off the armco sends you across the track; a quarter of it still
  // costs you the corner.
  strength: 0.25,
  restitution: 0.28,        // how much of the closing speed comes back
  yawKick: 1.5,             // rad/s^2 per metre of off-centre impact
};

// The rival you race for pink slips.
//
// Not simply a high skill number. Skill moves five things at once and tops out
// at about 0.93 of the physical limit; this is a driver with a character:
// plans on more deceleration than anyone else (so brakes visibly later), uses
// more of the corner, will not move over, and throws the car at the tight ones
// on the handbrake.
export const RIVAL = {
  name: 'KESTREL',
  skill: 0.99,
  opts: {
    brakeG: 1.44,          // against the 1.41 g the car actually stops at
    cornerMargin: 0.96,    // where the field uses 0.90
    aggression: 0.98,
    block: 0.85,
    drift: 0.34,          // some corners, not every corner
  },
};

// Car-to-car contact.
//
// A car is two discs, at the axles, not an oriented box. An OBB needs a
// contact manifold and is where stability at 120 Hz goes to die; two discs
// give the same silhouette for this purpose and reduce to the same maths the
// barrier resolver already uses — project out the overlap, cancel the closing
// speed, scrub the rest.
// The police.
//
// Not a faster car — the same physics package as everything else, because
// there is one — but a driver with no interest in a racing line. Full
// aggression and full blocking, and the `chase` flag that makes it steer at
// the car it is following rather than at the road.
export const POLICE = {
  name: 'UNIT',
  // As quick as the quickest thing in the field. Slower than the car it is
  // chasing is not a pursuit, it is an escort — and at 0.93 with a 0.93 corner
  // margin it stalled at seventeen metres and stayed there, close enough to
  // look like it was trying and never close enough to touch anybody.
  skill: 0.97,
  livery: { name: 'PD', body: 0xf2f4f6, trim: 0x16191f, num: 0, shape: 'muscle', police: true },
  opts: {
    brakeG: 1.44, cornerMargin: 0.98, aggression: 1.0, block: 0.9, drift: 0,
    chase: 1,
  },
};

// Traffic: ordinary cars, in ordinary colours.
//
// Muted and a little drab on purpose. The field's liveries are chosen to be
// told apart at two hundred metres; these are chosen NOT to be — a bridge full
// of racing colours reads as more competitors, and the whole point of them is
// that they are not in the race.
export const TRAFFIC = [
  { name: '', body: 0xb8bcc0, trim: 0x2b3038, num: 0, shape: 'muscle' },
  { name: '', body: 0x38424e, trim: 0x1a1f26, num: 0, shape: 'gt' },
  { name: '', body: 0x8f9aa2, trim: 0x2a3038, num: 0, shape: 'muscle' },
  { name: '', body: 0x6d5a48, trim: 0x2a231c, num: 0, shape: 'gt' },
  { name: '', body: 0x2f4a3c, trim: 0x18241d, num: 0, shape: 'muscle' },
  { name: '', body: 0xd8d4cc, trim: 0x33383e, num: 0, shape: 'gt' },
];

export const HULL = {
  radius: 1.05,             // metres, per disc
  fore: 1.35, aft: -1.35,   // where the discs sit, in body coordinates
  restitution: 0.16,        // how much closing speed comes back
  friction: 0.55,           // tangential scrub, as a fraction of the normal impulse
  yawScale: 0.55,           // a door rub should not spin you the way a wall does
  slop: 0.02,               // penetration tolerated before it is corrected
  correction: 0.65,         // fraction of the remaining overlap fixed per step
  maxDeltaV: 9,             // m/s, the cap that stops two overlapping cars launching
};

// Sixteen liveries, so you can tell who just went past.
// Sixteen liveries, so you can tell who just went past — and four body shapes
// across them, so the grid is a field of cars rather than one car in sixteen
// colours. `shape` picks the silhouette; see carmodels.js.
export const LIVERIES = [
  { name: 'VALENTI', body: 0xd8342c, trim: 0xf2e9d8, num: 4, shape: 'gt' },
  { name: 'KOBAYASHI', body: 0x1f4fa8, trim: 0xe8eef6, num: 7, shape: 'proto' },
  { name: 'ANDERSEN', body: 0x1f9e5a, trim: 0x12331f, num: 11, shape: 'hyper' },
  { name: 'MOREAU', body: 0xe8b21f, trim: 0x2b2418, num: 2, shape: 'muscle' },
  { name: 'DUARTE', body: 0x8d3fbf, trim: 0xefe2f7, num: 23, shape: 'gt' },
  { name: 'HOLLAND', body: 0xe2761f, trim: 0x2a1a0d, num: 16, shape: 'proto' },
  { name: 'PETROV', body: 0x2fb5c4, trim: 0x0d2b30, num: 33, shape: 'hyper' },
  { name: 'OKAFOR', body: 0xbf2470, trim: 0xf7e2ed, num: 9, shape: 'muscle' },
  { name: 'LINDQVIST', body: 0x9aa4ad, trim: 0x2b3138, num: 44, shape: 'gt' },
  { name: 'RIVERA', body: 0x2d6b2f, trim: 0xd8e8c8, num: 5, shape: 'proto' },
  { name: 'BAUER', body: 0x24272b, trim: 0xd0a53a, num: 18, shape: 'hyper' },
  { name: 'NAKAMURA', body: 0xf0f2f4, trim: 0xc4262c, num: 27, shape: 'muscle' },
  { name: 'SILVA', body: 0x1b3f8f, trim: 0xf2c21f, num: 6, shape: 'gt' },
  { name: 'ASHFORD', body: 0x7a3220, trim: 0xe0cfa8, num: 31, shape: 'proto' },
  { name: 'KOVAC', body: 0x3b8a86, trim: 0xf0efe6, num: 14, shape: 'hyper' },
  { name: 'MENDOZA', body: 0xc9c11f, trim: 0x1e2a12, num: 21, shape: 'muscle' },
];

// The player is number one, in whichever of these they pick. Same mechanical
// package underneath — the physics runs one car spec — so the choice is the
// body and the colours, not a performance decision.
export const PLAYER_CARS = [
  { name: 'GT COUPE', body: 0xe6e8ea, trim: 0x1a6fd0, num: 1, shape: 'gt',
    blurb: 'Closed cockpit. The shape everything else is a departure from.' },
  { name: 'PROTOTYPE', body: 0x1f9e5a, trim: 0x0e2a18, num: 1, shape: 'proto',
    blurb: 'Open top, roll hoop, a fin down the tail and a swan-neck wing.' },
  { name: 'HYPERCAR', body: 0xd8342c, trim: 0x1b1d20, num: 1, shape: 'hyper',
    blurb: 'Cab forward, very low, very wide, and a wing you could dine off.' },
  { name: 'MUSCLE', body: 0xe8b21f, trim: 0x2b2418, num: 1, shape: 'muscle',
    blurb: 'Long nose, tall glass, a ducktail instead of a wing.' },
  { name: 'GT — MIDNIGHT', body: 0x1b2b52, trim: 0xc9a227, num: 1, shape: 'gt',
    blurb: 'The coupe again, in the colours it should have had.' },
  { name: 'PROTOTYPE — SILVER', body: 0xc6cace, trim: 0xc8342c, num: 1, shape: 'proto',
    blurb: 'Unpainted, the way they used to run them.' },
];

export const PLAYER_LIVERY = PLAYER_CARS[0];

// Everything you can choose from: the six that exist only for the player, and
// then every car the field runs. There is no reason a livery should be off
// limits because a bot happens to use it — if you pick one, that bot takes
// another, which the field builder handles.
export const SELECTABLE = [
  ...PLAYER_CARS,
  ...LIVERIES.map((l) => ({
    ...l,
    num: 1,
    blurb: `The car ${l.name} runs, in your hands and carrying number one.`,
  })),
];

// How good the field is. Spread across the grid so the front runners are
// genuinely quicker rather than just luckier.
export const AI = {
  minSkill: 0.80,
  maxSkill: 0.99,
  lookahead: 26,            // metres of track the driver is reading ahead
  cornerMargin: 0.90,       // fraction of the physical limit they will use
  reaction: 0.16,           // seconds before they respond to something new
  aggression: [0.35, 0.95], // willingness to take a line that is not free
};
