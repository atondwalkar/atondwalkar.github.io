# REDLINE

A racing simulator: sixteen cars, three laps of a San Francisco street circuit,
a standing start, and a gearbox you work yourself. Runs in the browser with no
build step — three.js is vendored, everything else is plain ES modules.

```
./play.sh          # serves on http://localhost:8126 and opens it
```

## The car

The physics is a real vehicle model rather than an arcade approximation,
because the two things that make this game worth driving — the gearbox and the
handbrake — only feel like anything if they fall out of the simulation instead
of being special-cased.

Each axle carries a wheel with its own rotational speed, so it has a **slip
ratio** (is the tyre turning faster or slower than the road under it?) and a
**slip angle** (is it pointing where it is going?). A tyre model turns those two
numbers into a force; the two share a single friction budget, so grip spent
going forwards is grip not available to turn with. Weight transfer decides how
much each axle has to spend. The body is integrated from the sum, in its own
rotating frame.

**The car grips.** A textbook tyre curve falls away sharply past its best slip
angle, and that fall is the whole of understeer and snap oversteer: overshoot
the peak a little and the tyre gives you less, so you overshoot by more. It
makes a fine simulator and a miserable car to drive on a keyboard, where there
is no half-lock and so every ordinary corner is taken at full lock. Here the
curve plateaus instead — pushing past the limit scrubs a little speed and makes
the tyres squeal, and that is all. A held turn keeps 98% of its grip from
mid-corner to the exit, at every speed.

**The brake pedal is not a way to start a slide.** Getting there took three
separate fixes, and only one of them was about the brakes:

- The anti-lock system was regulating the tyres at a slip of 0.14 when they
  peak at 0.11 — holding them *past* their best, so braking spent grip the
  tyre then did not have to steer with.
- Brake force is now distributed by the load actually on each axle and capped
  by the friction circle, so a rear axle carrying a third of the car under
  heavy braking is no longer given two fifths of the braking.
- And the real culprit: available lock grows as the square of falling speed, so
  holding a steering key through a heavy stop wound on more and more of it
  until the steering was commanding a two-g turn from a car that has one and a
  half. The car slid, and it looked for all the world as though the brake had
  done it. The rack now refuses to ask for a corner the tyres could not hold.

On top of that the car has **stability control**, which does what a road car's
does: it compares the yaw rate the car is doing against the rate the steering
and the speed are asking for, and leans on the difference. An ordinary corner,
where those two agree, is untouched.

Sliding is something you ask for, not something that happens to you.

| | |
|---|---|
| Mass | 1,290 kg, 46% on the front axle |
| Engine | 480 Nm at 4,500 rpm, 7,800 rpm redline, 8,000 limiter |
| Gearbox | six speeds plus reverse, 3.55 final drive, 0.16 s shift |
| 0–100 km/h | 5.2 s |
| 0–200 km/h | 15.7 s |
| Top speed | 277 km/h, in sixth |
| 100–0 km/h | 28 m, at 1.41 g |
| Cornering | 1.39–1.46 g, held |

Every one of those figures is measured by the smoke test, not asserted in a
comment — it drives the car and times it.

## The gearbox

Gears matter here because engine torque reaches the wheels multiplied by the
ratio, and the engine only makes torque over a band. A short gear is a lot of
torque and easy wheelspin; a tall one is lazy but fast. At the redline each gear
pulls a different speed — 78, 120, 164, 209, 256 and 313 km/h — so the choice is
a real one.

The **up** and **down arrows** change up and down — or **Q** and **E**, or the
two shift keys, if your hands prefer them there; **1**–**6** go straight to a
gear. Changing up cuts the drive for a sixth of a second and drops
the revs by about two thousand, which you can hear, because the engine note is
synthesised from the rpm the physics is already calculating.

**G** hands the box to the automatic if you would rather steer.

The clutch slips below idle, so you can pull away from the grid — and light the
rear tyres up doing it if you are clumsy with the throttle.

## The steering

Below 40 km/h you get the whole lock, for hairpins and for the pit lane. Above
it you get the fraction `(40/v)²` of it — which is exactly the shape of the
angle a steady corner at the tyres' limit needs, so the ratio between what the
steering can *ask* for and what the tyres can *deliver* stays constant at about
**1.7×** at every racing speed. Enough to provoke the car deliberately; not
enough to throw it away by leaning on a key.

That ratio is the number that decides whether a car is drivable, and it is
checked: the test works out what full lock demands at six speeds and compares it
against the grip the car actually reaches on a skidpad run.

Because a key has no travel, winding lock *on* gets slower the faster you go,
while letting go and winding lock the *other* way stay quick — those are the two
things you do to catch a slide, and slowing them would turn saves into spins.

The rack also refuses to ask for more cornering than is left after whatever the
brakes are spending, which is what stops a held key from commanding an
impossible turn as you slow into a corner.

## The handbrake

**Space** locks the rear axle, and it is the only way to break traction — it is
also the one control that switches the stability control off entirely.

It works through the friction circle rather than through the tyre curve, which
is why flattening that curve did not take the drift away with it: a locked wheel
has a slip ratio of −1, so the rear axle spends its entire friction budget on
not rotating and has nothing left to corner with, and the back steps out.
Catching it with opposite lock is not scripted anywhere; it is what the
equations do. The measured difference is **86° of slide with the lever and 1°
without**, from identical steering, and the car comes back to within 2° once you
let go and straighten up.

The foot brake has anti-lock, deliberately held at a slip ratio of 0.14 — just
past the peak, where the tyre stops hardest. The handbrake is outside the
system, which is the whole point of it.

## The race

Sixteen cars on an eight-by-two grid, five red lights, and a standing start.
You start sixteenth, so there is a race to run. Three laps, and the order is
decided on distance covered until people start taking the flag, after which it
is decided on the clock.

Contact is real: each car is three circles down its centreline, so a nose in a
gap behaves differently from a door slam, and an off-centre hit puts yaw into
whoever took it. Hits land at a quarter of the full elastic exchange — a nudge
takes about 17% of the closing speed off you, where a physically complete
contact would take 64% and put you in the scenery. Hitting a barrier scrubs speed and points you back down the
road rather than ending your afternoon. Running wide is punished by the surface
itself — no invisible walls, just a car that will not turn.

## The title screen

A cutscene, and two buttons over it. No title card, no strapline, no control
list — the shot behind it is the title screen, and anything laid over it is in
the way of it.

The field is already built and the AI already knows how to drive, so nothing is
animated specially: the race is simply run behind the menu with every car
including the player's under AI control, and the camera cuts between five close
shots of one of them every four and a half seconds. Cuts rather than one long
move, because a continuous shot of a car going round a lap is a lap, not a
title sequence. Press START and the grid is re-formed from scratch, so nothing
that happened during the attract loop carries into the race.

**One car is visible.** Cars phase through each other by design — that is the
collision model — which nobody notices at racing distance in a pack and
everybody notices in a close-up, so the rest of the field is hidden. They are
still simulated, which costs nothing worth saving and means the car on screen
is driving a real race rather than an empty track.

Every camera distance is measured from the car's centre, and a car is two
metres wide. Four metres to the side is one metre off its flank: the first cut
of this had the camera inside the bodywork.

**Loading.** A spinner and a ring that fills as the city goes up, and the ring
is the interesting half. The first version was a sliding bar animated with a
pure `transform`, on the theory that browsers run those on the compositor and
it would keep moving while the thread was busy. It did not move at all — and
the reason is that JavaScript is one thread, so while the city is being built
the browser never gets a *frame* to composite in the first place. No CSS trick
fixes that from the outside.

So the fix is on the other side. `Track.build` is a generator that yields
between phases — the ground, the road, the blockades, the frontage, the blocks,
the buildings, the street — and the loader awaits a frame at each yield. The
thread comes back often enough to paint, the ring advances, and the label says
which part of the city is going up. The buttons stay hidden until there is
something behind them.

## Who is driving

The name goes in on the way to the car select, and it is the driver's name
rather than the car's. It used to be the car's: `Car` takes its name from its
livery, which is right for the fifteen the AI drives and wrong for yours, so
everybody who picked the white coupe was called GT COUPE. Leave it blank and it
falls back to the car, which is what it always was.

## Choosing a car

Before the race, every car in the game laid out in a grid at once — all
twenty-two, the six that exist only for the player and every livery the field
runs. Arrow keys move around it, **Enter** takes it racing. The chosen one is
lit and scaled up with a ring under it; the rest are dimmed and drained of
colour. Nothing moves except that ring.

It was a carousel: the chosen car turning slowly in the middle, a neighbour
either side, everything else off screen. That is fine for six cars and useless
for twenty-two — you can see what is next to what you have got, but not what
you are choosing between, so picking a car means scrolling the whole list and
remembering it. A grid shows you the field.

Two details are less obvious than they look. The cars carry their colour in
their vertices, not their materials, so tinting a material can only darken one
— a dark red car stays a red car. Draining the colour has to happen where the
vertex colour is read, which is one uniform and one line patched into the
fragment shader. And unchosen cars are knocked back less far than seems right:
the field contains cars that are nearly black to start with, and dimming those
as hard as a white one leaves a hole in the grid where a car should be.

If you take a car one of the drivers runs, that driver takes the one nobody was
using — fifteen bots share sixteen liveries, so there is always exactly one
spare. Two identical cars on the grid is worse than it sounds: the timing
screen and the mirrors both become guesswork.

## The cars

Sixteen liveries across **four body shapes** — a closed GT coupe, an
open-cockpit prototype with a roll hoop and a dorsal fin, a tall long-nosed
saloon with a ducktail, and a cab-forward hypercar with a wing you could serve
dinner off. The chassis, wheels, arches, lights and diffuser are shared,
because those are the parts every racing car has; what differs is the
proportion and, above all, the greenhouse and the wing, which are what you
actually read a car's shape by at two hundred metres.

### Using your own model

Put a glTF or GLB file at `assets/car.glb` and the whole field uses it instead.
Nothing is bundled: the good-looking car models belong to somebody, and a
licence tag on a re-upload is only worth what the uploader had the right to
give. Use something you have the right to use — there is a lot released under
CC0.

What the file needs:

- the car facing **+z** (facing +x is detected and rotated automatically);
- **four wheels as their own nodes**, named so they can be found — anything
  with `wheel`, `tyre`, `tire` or `rim` in the name. They are re-parented onto
  pivots so the fronts steer and each axle spins at its own rate, which is how
  you see the handbrake lock the rear. A model with its wheels welded into the
  body still loads; it just has wheels that do not turn;
- **any scale.** It is measured and resized so its wheelbase matches the car
  the physics is simulating, because a model that disagrees with the simulation
  about where its wheels are will not sit on the road.

The largest bright material is treated as bodywork and repainted per livery, so
the field still has sixteen colours. A missing or unreadable file costs a
console line and falls back to the built-in cars.

## The circuit

**San Francisco Street Circuit**, 1.78 km. Everything — the asphalt, the
markings, the walls, the grid, the racing line, the AI's speed profile, the lap
timing and the map — is derived from one centreline, so none of them can
disagree about where the circuit goes.

**It is laid out on a street grid, not drawn as a shape.** A city is not a
curve, it is a grid, and a circuit in a city is a lap of one: the layout is
given as twelve junctions on a 52 × 45 m block grid, and the road is generated
between them. The straights are straight to the millimetre; all of the turning
happens in an 18 m fillet in the last few metres before each corner, because a
car cannot drive a mathematical right angle. That is what driving in a city
actually feels like — nothing, nothing, nothing, then a junction. Ten of the
twelve are square turns; two make a diagonal avenue across the top of the hill,
which is the one thing a real grid city always has cutting across it.

An earlier version ran a spline through control points instead. It gave corner
radii around ninety metres and streets that bowed gently between them, and the
bowing is precisely what made it read as a race track that happened to have
buildings beside it rather than as a city.

The road is 11.6 m wide, opening to 15.4 m at the **corners** because a
junction is two streets' worth of tarmac — at the corners specifically, not at
every point of the grid. Three of the twelve are collinear, the road running
straight through them, and widening there put an unexplained bulge in the
middle of a straight where there is no junction to be wide for. Concrete walls sit 5.6 m from the white line
instead of nine metres of grass and gravel. There is no run-off. There is
pavement, and then there is wall.

**Nothing lines the street.** No painted start line, no gantry over it, no
concrete, no fencing. A city has none of those and every one of them was there
at some point: first concrete walls, which made the place read as a circuit
with a city painted on it; then steel crowd fencing, which is lighter and still
a mile of temporary structure down both sides of every road.

Taking them out is not free, and this is the interesting part. The thing that
stops a car is **a lateral distance from the road**, not a mesh, and that
distance is continuous whether or not anything is drawn on it — so removing
everything from the line means the line has to be moved onto something that is
already there. It now sits at the **building frontage**, and the pavement was
widened from four metres to nine so it runs from the kerb to the wall of the
building rather than stopping halfway with a metre-deep ditch behind it. You
are stopped by a building, at a building.

The lap counter fires on distance round the lap rather than on anything drawn,
so the start line needed nothing at all.

**Where the lap starts is not cosmetic.** The grid is laid out in the ninety
metres *behind* the line, so wherever the line falls, sixteen cars are parked
there — and left where the layout happened to begin, that was the middle of an
intersection. The lap is now rotated so it starts on the longest straight, far
enough in that the grid fits on it and no further, which leaves the rest of the
street as run-up: a 270 m straight with 165 m of it after the line.

**Every corner is a crossroads.** A corner in a city is not a bend, it is a
junction, and a junction has roads leaving it in every direction — including
the two you are not using. So each one gets both: the way straight on and the
way back off the other side, surfaced and marked like any other street and
walled off at the mouth with the same concrete the circuit is walled with. That
is how a real street race is put together — the course is a few streets and
everything else is shut off at the kerb.

They are closed with a blockade — cones right across, an arrow board, and a
piece of plant with an amber beacon turning on it — rather than with concrete,
for the same reason: a city does not pour a wall across every side street. The
plant is four kinds taken in turn, so no two junctions in a row look alike: a
tracked excavator with its boom folded down, a road roller, a site dumper
tipped up with a load of spoil in it, and a light tower on a trailer with four
lit heads on the mast, which is what actually lights a night job.

The arrow board is built the way the real ones are: a black panel carrying a
grid of amber lamps with the arrow lit *out of* the grid, and the unlit lamps
present too — a board with only the lit ones on it is a glowing arrow floating
in a black rectangle. The chevron is two lamps thick. One thick is what a real
board uses and what was here first, and at the distance you actually see one
from it reads as a horizontal bar with some speckle on the end. The sign is the one piece of signage doing a job
rather than dressing: with the walls gone and the side streets running two
blocks deep, a junction offers three ways out and only one of them is the
track. The blockade says *not here*; the arrow says where instead. The beacons are two unlit meshes with
their own materials, played against each other twice a second, which is what
reads as a police light rather than as a lamp. And they do not stop dead at the
far end either: each one runs out to a cross street and Ts into it, with the
buildings that fill in around the T hiding the fact that the cross street stops
too.

They are scenery, and deliberately so. An earlier version opened the wall at
the mouths so they could be driven into; because a side street's corridor
starts at the junction centre, and the circuit itself goes through the junction
centre, cars taking the corner registered as being in the side street, lost the
wall that keeps them on the road, and were shoved by the side street's own
walls instead. Twelve of sixteen finished that race stranded. The smoke test
now asserts the wall is unbroken across every mouth.

**Every corner gets one, including the shallow ones.** The two obvious
directions off a corner are straight on and back off the far side, and at a
forty-five degree bend both of those lie too nearly along the circuit for a
street to go anywhere but beside it — so both get refused and the corner is
left as a bend with a sign next to it. The way out is the **outward bisector**,
`u1 - u2`, which points away from the centre of the turn: about seventy degrees
off the road at a forty-one degree corner, which is what a fork in a real
street looks like and far enough across for the street to leave.

That still did not work at first, for a reason worth recording. The walk that
decides how far a street runs measures clearance against the circuit — and the
junction it is leaving *is* the circuit. At a shallow corner a street heading
out at sixty-five degrees is still only seventeen metres from that corner's own
kerb twenty-six metres along, so every one of them was refused against the very
junction it belonged to. The walk now ignores circuit within forty-six metres
of where the street starts.

**And they have to go somewhere else.** The walk that decides how far a side
street runs stops it short of any other part of the circuit, and that clearance
is twenty-two metres rather than nine. At nine, a street leaving one of the
shallow corners ran a hundred metres at three-quarters parallel and fourteen
metres from the racing line, which does not read as a turning off the course —
it reads as a second road laid beside it. Where that leaves no room for a
street, none is built and the block fills in with buildings instead.

**They do not stop, they T out.** A street that ends at a wall reads as exactly
what it is — a piece of scenery with an edge on it. So each one runs out to a
cross street and Ts into it, and the buildings that fill in around the T hide
the fact that the cross street stops too. It costs one more road segment per
junction and it is the difference between a street going somewhere and a
street ending.

**And the junction is built as a junction.** The side street is not a strip of
tarmac laid alongside the circuit; the two surfaces are one.

The hard part was the circuit itself. Its surface is a ribbon following the
filleted centreline, and *a fillet can never read as a crossroads* however well
the side streets are joined to it — because a real junction's roadway is the
union of two straight streets, which is square, while a fillet is an arc.
Laying extra tarmac around the arc does not help either: the arc is still drawn
underneath, and a curve drawn over a square still looks like a curve.

So the junction **owns** the surface. Within eighteen metres of a corner the
circuit's ribbon is not drawn at all — nor are the side streets, nor the lane
markings, the manholes, the tar seams or the cable-car rails, because anything
that follows the ribbon draws the curve back in. What is drawn instead is the
plus: rasterised rather than ribboned, since what is wanted is the union of
four rectangles and that is not a shape you can express as a strip. The
centreline stays filleted, because a car has to drive an arc through a junction
whatever shape the tarmac is; the tangent point is twelve metres out and the
junction's surface reaches eighteen, so the two meet where the road is straight
again and in line.

For the plus to contain the whole curved racing surface, the junction's
half-width **H** must satisfy `H ≥ (r(√2−1) + h) / √2`, where `r` is the corner
radius and `h` the road's half-width. The obvious move is to widen the *road*
at the junction until that holds. It does not work, in two ways. Setting `h = H`
collapses the condition to `H ≥ r` — a thirty-six metre roadway. And worse: the
wall that stops a car cutting the inside of a corner sits at `h + 5.6` from the
centreline, so its radius is `r − (h + 5.6)`. Make `h` big enough and that goes
negative — the inside of every corner opens up and you can drive through it into
the city. I did exactly that, and the inner wall quietly vanished. Both
conditions are only satisfiable when the **road is narrower than the junction**,
which is also simply true of the real thing: the tarmac at a crossroads is wider
than the lanes running through it. So the road keeps its width and radius, and
the junction is laid wider around it, its arms tapering back over the last four
metres to meet the road exactly rather than stepping down to it.

On top of that, every cosmetic street is tiled rather than
ribboned, and a tile is dropped if it falls on something already surfaced —
which is what stops two or three surfaces fighting over the same ground in the
middle of every corner, since the circuit and both side streets all pass
through the junction centre. Each arm gets a crossing and a stop bar, and every
corner of every junction gets a **curb return**: an arc tangent to both curb lines, solved once per corner from the
two road half-widths. A square corner is the single thing that most stops a
junction reading as one.

**And it is marked like a street, not like a circuit.** No red-and-white apex
kerbs, no painted strips — that is circuit furniture, and a road does not
become a race track by having it. What is down there is what a city road has: a
double yellow down the middle, dashed white between the lanes, a solid white
edge line, grey concrete curbs with red no-parking paint on the hills,
crossings and stop bars at the junctions, and a surface that is a patchwork of
resurfacing, tar seams and manhole covers rather than one flat colour. The
cable-car rails up the climb are paint as far as the physics is concerned — a
rail you could catch a wheel on would be a menace, and the real ones are flush
with the setts anyway.

**And it is a city built on hills, so the circuit climbs one.** Twenty-nine
metres up from the waterfront, over the top and back down, at grades touching
six per cent — and the car feels every bit of it, because gravity along the
road is part of the physics. Going up takes about a tenth of a g out of the
car and coming down hands it back, which is why you end up changing gear on
the way up a street here and not on the way down it.

**The pavement is not part of the road.** It used to be built into the road
ribbon, which meant every street laid its own — so a side street's pavement got
drawn straight across the racing surface of the circuit it joined, and the two
fought over the same ground for the whole width of the junction. What a
pavement actually *is*, is the ground that no road covers, and that is not
knowable until every road is down. So it is a separate pass that runs last,
emits tiles, and drops any tile whose middle is on tarmac or inside a curb
return.

**Windows go on all four faces**, which they did not while every building was
a narrow frontage seen from the street it fronts. The moment the city was
filled in with near-square blocks seen from every side, half of them showed a
blank wall — and a blank wall thirty metres high beside the road is the most
conspicuous thing in the place.

**And height is ramped by how far back a building stands.** A ninety-metre
tower on the kerb is a wall, not a building: you cannot see the top of it, you
cannot see past it, and the street stops being a street. Cities do not do this
either — the tall ones are set back and the frontage is low. So the frontage
row stays under twenty-six metres whatever district it is in, and the ceiling
rises with distance from the road until the big ones read as a skyline rather
than as a canyon. The landmarks themselves are held two hundred metres clear of
the circuit, which is past the far edge of the band the city fills: they are
placed at fixed coordinates, and when the circuit was re-laid on a grid and
re-centred, the coordinates stayed where they were and the downtown cluster
ended up standing *among* the city instead of behind it.

The same discipline applies to the buildings. Every placement pass used to run
in ignorance of the ones before it, so buildings grew through each other; the
first attempt to stop that used bounding circles, which for a long thin
building either lets the ends overlap or refuses everything that would sit
beside it — which is where the holes in the terrace came from. Placement now
keeps a spatial hash of what is already standing and rejects on proper
oriented-box overlap, with a negative margin for the row houses because a
terrace is *supposed* to share its side walls. A final sweep drops a building
into every remaining gap, largest footprint first. And the last word on whether
a lot is free goes to the same question the surfacing asks — is this ground
road? — sampled across the whole footprint, because a building can straddle a
street without any of its corners being on one. The smoke test checks both:
nothing inside anything else, nothing on a road.

The circuit passes through three districts in a lap, and you can tell where you
are by what is beside you: brick warehouses and palm trees down at the water,
painted row houses up the climb, glass towers across the top of the hill. Out
past them are the headlands across the bay, a pyramid tower downtown, and a
red-orange suspension bridge. Every building fronts onto the street it stands
on, so what you see from the car is windows and doorways rather than the blank
side walls you would get from turning them all to face the same way.

Corners are levelled rather than left to follow the hill. The road is flat
across its width, so a sample's height applies from one white line to the
other — which means the inside of a bend covers the same rise over a shorter
arc and climbs harder for it, by r / (r − halfWidth). At the radii a street
circuit turns at that is a multiplier of two to five, and a seven per cent
street becomes a one-in-three ramp on the inside of a hairpin. So the limit is
applied to the inside line and the heights are relaxed until they satisfy it.
The elevation is not lost, it moves: the corners come out close to level and
the blocks between them keep the hill.

## Night

It runs at night, lit by the city rather than by the cars. A street with lamps
every thirty metres and lit windows down both sides is a bright place, so the
ambient light does the work headlights would otherwise do — sodium-coloured
from below, moonlit from above, which is what keeps it reading as night rather
than as a dim afternoon.

What is lit is lit for real, on its own unlit mesh, so it keeps its colour
whatever the scene lighting does — a window lit from inside does not get darker
because the sun went down. Windows come on individually and in different
colours: tungsten, office fluorescent, and the occasional blue flicker of a
television. Towers light a scatter of offices per floor rather than the whole
band. Lamps have lit lenses and throw pools on the asphalt, added together
rather than painted over each other, so two overlapping pools make a brighter
patch instead of a seam. Traffic signals show one aspect.

The bridge is the thing on the horizon that says where this is, and at night a
bridge is mostly light: the deck traced end to end by a string of lamps, the
towers floodlit from below, a red aircraft beacon on each, and traffic on it
both ways — headlights running one direction, tail lights the other. Built as a
shape alone it was a girder in the fog and your eye went straight past it. A
continuous lit strip along the deck was tried first and reads as a laser; a run
of separate heads, close enough to make a line and far enough apart to twinkle
through the fog, is the real thing.

The one light on a car that changes is the brake light: dim while you are
driving, hard red the instant the pedal or the lever goes on. In a pack that is
the only warning you get that the car ahead has stopped going.

The lamps light the street for real, not with a decal. A painted patch of
brightness does not fall on the car, does not pick out the barrier, and on a
slope does not even reach — a flat card laid over a hill is buried at its
uphill end, which is exactly how it was failing: the lamps lit the road going
down and lit nothing going up. So the pools are now built as meshes that follow
the road under them, *and* a small pool of real point lights is handed each
frame to whichever standards are nearest the camera. Two hundred lamps is more
than any renderer will light a scene with; the eight closest is not, and they
are the only eight you could see the difference from.

## What gives way

Lamp standards, traffic signals and the signs at the blockades go over when you
hit them. Each is built as its own mesh rather than merged into the city,
because a merged mesh is one object and you cannot tip a single lamp post out
of one. That costs a draw call each, which for ninety slim objects is
affordable and buys the thing that most separates a street from a backdrop.

That covers lamp standards, traffic signals, the arrow boards at the blockades
and the braking boards on the approach to the heavy stops — anything on a post.

Two details. The geometry is built with its base at the origin and the mesh
placed at ground level, because falling over is a rotation about the base —
built around its middle it would sink through the pavement as it went. And the
hit takes about a tenth of the car's speed and a little of its heading, and
nothing else: a real lamp standard is a thin tube on a shear base and is
*designed* to fold, and being stopped dead by a signpost at a hundred and forty
would be worse than driving through one.

## The look

A post chain, written out rather than assembled from the three.js example
passes, because the whole thing is four shaders and going through
`EffectComposer` would mean vendoring six more files to get the same four.

The order is the part that matters. The scene renders into a half-float target
with **no** tone mapping, so what comes out is linear light with values well
above one in it — a lit window is not "white", it is several times brighter
than the road. Bloom is extracted and blurred in that space, because bloom is
something a lens does to light, not to pixels. Only at the end is the sum
tone-mapped down to what a monitor can show, graded, and encoded to sRGB. Do it
in the other order and the bright things have already been clipped to white
before you go looking for them, which is why bloom bolted onto a finished image
always looks like a blur filter.

Bloom runs at two scales — a tight one for the glow at the source and a wide
one for the haze it puts across the street, the wide one being the tight one
blurred again at half the resolution, so it reaches four times as far for a
quarter of the samples. Then ACES, so highlights roll off instead of clipping
and a lit window keeps its colour in the middle.

And then the grade: **the piss filter.** Desaturate a fifth of the way to grey,
push the whole image toward warm yellow, and lift the blacks so nothing is ever
properly black. Plus a vignette and a little grain, which also breaks up the
banding a dark gradient would otherwise show. It is the look every other game
had for about six years. It is not subtle and it is not meant to be.

The shape is described as a radius at each of seventy-two angles around a loop.
Where that radius follows `d / cos(θ − θ₀)` the points lie on a chord, which is
how the waterfront straight and the boulevard back up the hill are made — and
the radii ramp into and out of those straights over twenty-odd degrees, because
a spline handed a jump from 88 m to 210 m across eight degrees folds the road
over the top of itself. The profile is smoothed for the same reason: left raw
it has notches deep enough to bring one street within a few metres of another.
It never comes within 37 m of itself, and the smoke test fails the build if
that changes.

The **racing line** is found by relaxation: each point is repeatedly pulled
toward the midpoint of its neighbours, which straightens the path, and clamped
back inside the white lines. What falls out is the usual out-in-out, because
the shortest smooth path through a corner is exactly that.

## The drivers

Each of the fifteen does what a driver does: looks a corner ahead, works out the
fastest it could be there and still stop in time, and presses a pedal
accordingly. It aims at a point on the racing line rather than at the line
itself, so it takes an arc rather than sawing at the wheel — and it computes the
road-wheel angle the geometry needs, then asks for that fraction of the lock
actually available at this speed.

They watch the cars around them, pick the side with more road, and commit or
back out according to how brave they are. They countersteer a slide. They make
mistakes, at a rate set by their skill. The quick ones start at the front, so
the grid order means something, and the spread is about a second and a half a
lap from the front row to the back.

## Frames and steps

The physics runs at a fixed 120 Hz and the screen runs at whatever the screen
runs at, and the two do not divide into each other. Draw the newest physics
step outright and the car advances two steps one frame and three the next,
which at 60 Hz is a visible stutter on a car that is in fact moving perfectly
smoothly.

So the frame is drawn *between* the last two steps. Each car keeps the pose it
held before the step — position, heading, the lateral and longitudinal g the
body leans on, the steering angle, the grade under it — and the renderer
interpolates to the current one by however much of a step is left over in the
accumulator. It costs about eight milliseconds of lag and takes all of the
stutter out. The wheels are wound on inside the physics step at the rate the
physics is actually running, rather than at an assumed sixty frames a second.

## Controls

| | |
|---|---|
| W | throttle |
| S | brake — hold at a standstill to select reverse |
| A D / ← → | steer |
| Space | handbrake |
| ← ↑ ↓ → | on the select screen, move around the grid |
| ↑ / E / Right Shift | shift up |
| ↓ / Q / Left Shift | shift down |
| 1 – 6 | straight to a gear |
| G | automatic gearbox on / off |
| C | change camera — chase, close, bonnet, cockpit |
| L | look behind — snaps, both ways, because it is a glance |
| Tab | the full order |
| R | restart the race |
| M | mute |

## Testing

```
./.test/smoke.sh 30
```

Plays the race headlessly and prints a report. A racing game is unusually
testable, because almost everything it claims is a number you can measure, so
the test drives the car rather than eyeballing it: it times an acceleration run
and a stop, checks that six gears pull six different speeds and that changing up
drops the revs, holds full lock at four speeds and checks the car is still
pulling the same cornering force at the exit as in the middle, measures the
slide with and without the handbrake, stands on the brakes in the middle of a
corner and checks the car stays pointed where it is going while the same test
with the handbrake pulled does not, checks that braking loads the front axle, drives one car round a clean lap, and runs an
entire sixteen-car three-lap race at machine speed — about a second — to confirm
that everyone takes the flag, nobody is stranded, and the classification agrees
with the finishing times.

It also checks the circuit closes, never doubles back on itself, has a racing
line inside the white lines and straighter than the road, a grid that fits, and
nothing at all standing on the road — walls, buildings and street furniture
alike, because where a circuit doubles back the pavement of one street is the
racing surface of the next one along, and a lamp post put there is a lamp post
you drive straight through — and it drives the dashboard
through the states it has to survive, reading back the gear, the speed and the
order, confirming the rev counter and the map actually drew something, and
building the results table that nothing else touches until the flag falls.

It writes PNGs of the circuit from above, the racing line over it, the grid, the
straight, the first corner, a car close up, the chase view, and the race in
progress — the quickest way to see what a change did.

## Layout

| | |
|---|---|
| `src/defs.js` | the car, the tyres, the field, the rules |
| `src/vehicle.js` | the physics: tyres, load transfer, driveline, gearbox |
| `src/track.js` | the circuit, the city around it, the racing line and the speed profile |
| `src/ai.js` | one driver |
| `src/race.js` | sixteen of them, plus barriers, laps and order |
| `src/carmodels.js` | the four car shapes, procedurally |
| `src/carselect.js` | the car-select carousel |
| `src/carload.js` | loading a car model from assets/, if there is one |
| `src/camera.js` | the four views |
| `src/hud.js` | rev counter, timing screen and map |
| `src/fx.js` | rubber, smoke, dust and sparks |
| `src/audio.js` | the engine, synthesised from the rpm |
| `src/post.js` | bloom, tone mapping, the grade |
| `saves/city-v1/` | the previous map, kept whole and runnable |
| `src/meshkit.js` | the geometry merger everything is built with |
