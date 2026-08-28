// Touch controls.
//
// A phone has no keyboard, so the game grows a set of thumb-sized targets over
// the picture. What it does NOT grow is a second copy of the driving code: a
// control here holds an ACTION — the same action a key holds — and one-shot
// controls call the same `doAction` a key press calls. Add a control to the
// table and it works; there is nowhere else to change.
//
// Laid out for two thumbs in landscape: steering under the left, the pedals
// under the right, and the gearbox in between where neither has to leave the
// wheel to reach it. Everything is `position: absolute` against the viewport
// rather than anchored to the HUD, because the HUD moves and thumbs do not.

// id: the action held or fired. hold: held down rather than tapped.
export const PADS = [
  { id: 'left', label: '◀', cls: 'steer l', hold: true },
  { id: 'right', label: '▶', cls: 'steer r', hold: true },
  { id: 'throttle', label: 'GO', cls: 'pedal go', hold: true },
  { id: 'brake', label: 'BRAKE', cls: 'pedal stop', hold: true },
  { id: 'handbrake', label: 'HAND', cls: 'small hand', hold: true },
  { id: 'shiftUp', label: '＋', cls: 'small up' },
  { id: 'shiftDown', label: '－', cls: 'small down' },
  { id: 'camera', label: 'CAM', cls: 'small cam' },
];

// Whether this looks like a device that wants them.
//
// Coarse pointer AND no hover is the pair that actually means "finger": either
// on its own catches a laptop with a touchscreen, which has a keyboard and
// does not want half its screen covered in buttons.
export function looksLikeTouch() {
  try {
    return window.matchMedia('(pointer: coarse)').matches
      && window.matchMedia('(hover: none)').matches;
  } catch (e) {
    return 'ontouchstart' in window;
  }
}

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('touch');
    this.on = false;
    if (!this.root) return;
    this.root.innerHTML = '';
    for (const pad of PADS) {
      const b = document.createElement('button');
      b.className = `pad ${pad.cls}`;
      b.textContent = pad.label;
      b.dataset.id = pad.id;
      this._bind(b, pad);
      this.root.appendChild(b);
    }
  }

  _bind(el, pad) {
    const g = this.game;
    const down = (e) => {
      e.preventDefault();
      // Captured, so a thumb that slides off the button still counts as held.
      // Without it, dragging a finger off the throttle leaves the throttle on
      // for ever — there is no pointerup to come.
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
      el.classList.add('on');
      g.audio.unlock();
      if (pad.hold) g.touch.add(pad.id);
      else g.doAction(pad.id);
    };
    const up = (e) => {
      if (e) e.preventDefault();
      el.classList.remove('on');
      if (pad.hold) g.touch.delete(pad.id);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // 'auto' | 'on' | 'off'
  set(mode) {
    this.mode = mode;
    const want = mode === 'on' || (mode !== 'off' && looksLikeTouch());
    this.on = want;
    document.body.classList.toggle('touch', want);
    if (!want) this.game.touch.clear();
    return want;
  }
}
