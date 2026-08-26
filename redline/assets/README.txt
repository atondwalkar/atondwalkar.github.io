Put a glTF or GLB file here as  car.glb  and every car in the race uses it.

example-car.glb is a working one, included so the loading path is provably
working rather than merely written: rename or copy it to car.glb and reload.
It is Kenney's Car Kit sedan (kenney.nl), released under CC0 — see CREDITS.txt.
It is a placeholder, not a recommendation: it is a single-material toy model,
so the livery tint lands on its windows along with its bodywork, and it has
less detail than the cars the game builds for itself.

A model does better here if it has:

  * separate materials for bodywork, glass and tyres, so repainting per livery
    touches the paint and nothing else;
  * four wheels as their own nodes, named with "wheel", "tyre", "tire" or
    "rim", so they can be steered and spun;
  * the car facing +z (facing +x is detected and turned automatically).

Scale does not matter. The model is measured and resized so its wheelbase
matches the car the physics simulates.

Use something you have the right to use. A licence tag on a re-upload is worth
whatever the uploader had the right to give, which for a model of a real car
from a commercial game is nothing: those belong to the publisher and to the
manufacturer whose car it is.
