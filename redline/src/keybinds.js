// The keyboard, as data.
//
// Every key the game reads goes through here, so that changing one is a matter
// of writing a different code into a table rather than of finding every place
// that compared against `'KeyW'`. It was the latter — the pedals were read in
// one function, the gearbox in a switch in another, and the camera and the
// mute in the same switch — and a rebindable control that is spelled out in
// three files is a rebindable control that works in two of them.
//
// Each action holds a LIST of codes, because several of these have always had
// two ways to press them and taking that away to make rebinding easier would
// be making the game worse to make the settings screen simpler.

export const ACTIONS = [
  { id: 'throttle', name: 'THROTTLE', hold: true },
  { id: 'brake', name: 'BRAKE', hold: true },
  { id: 'left', name: 'STEER LEFT', hold: true },
  { id: 'right', name: 'STEER RIGHT', hold: true },
  { id: 'handbrake', name: 'HANDBRAKE', hold: true },
  { id: 'shiftUp', name: 'SHIFT UP' },
  { id: 'shiftDown', name: 'SHIFT DOWN' },
  { id: 'gearbox', name: 'AUTO GEARBOX' },
  { id: 'camera', name: 'CAMERA' },
  { id: 'lookBack', name: 'LOOK BEHIND', hold: true },
  { id: 'standings', name: 'FULL ORDER', hold: true },
  { id: 'restart', name: 'RESTART' },
  { id: 'mute', name: 'MUTE' },
];

const DEFAULTS = {
  throttle: ['KeyW'],
  brake: ['KeyS'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  shiftUp: ['ArrowUp', 'KeyE', 'ShiftRight'],
  shiftDown: ['ArrowDown', 'KeyQ', 'ShiftLeft'],
  gearbox: ['KeyG'],
  camera: ['KeyC'],
  lookBack: ['KeyL'],
  standings: ['Tab'],
  restart: ['KeyR'],
  mute: ['KeyM'],
};

const KEY = 'redline.keys';

// What the keyboard is bound to right now. Copied out of the defaults rather
// than aliased, or "reset to defaults" would reset to whatever you last did.
let binds = Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, v.slice()]));

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return binds;
    const saved = JSON.parse(raw);
    for (const a of ACTIONS) {
      if (Array.isArray(saved[a.id]) && saved[a.id].length) binds[a.id] = saved[a.id].slice();
    }
  } catch (e) { /* a private window, or nothing saved: the defaults stand */ }
  return binds;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(binds)); } catch (e) { /* not fatal */ }
}

export const codesFor = (id) => binds[id] || [];
export const defaultsFor = (id) => (DEFAULTS[id] || []).slice();

// Is this key one of the ones bound to that action?
export const isBound = (id, code) => (binds[id] || []).includes(code);

// Which action a key press means, or null. First match wins, and since a code
// can only be bound to one action at a time — `rebind` takes it off whatever
// held it — there is never more than one.
export function actionFor(code) {
  for (const a of ACTIONS) if (isBound(a.id, code)) return a.id;
  return null;
}

// Bind a key to an action, taking it off whatever else had it.
//
// Taking it off matters: two actions sharing a key means one of them silently
// stops working, and the one that stops is whichever comes later in a list the
// player cannot see. Rebinding leaves the action's other keys alone — the slot
// being replaced is named — so STEER LEFT keeps its arrow when you move A.
export function rebind(id, slot, code) {
  if (!binds[id]) return false;
  if (RESERVED.includes(code)) return false;
  for (const a of ACTIONS) {
    if (a.id === id) continue;
    binds[a.id] = binds[a.id].filter((c) => c !== code);
  }
  const list = binds[id].filter((c) => c !== code);
  list[Math.min(slot, list.length)] = code;
  binds[id] = list.filter(Boolean);
  save();
  return true;
}

export function resetBinds() {
  binds = Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, v.slice()]));
  save();
  return binds;
}

// Keys the game will not take. Escape closes things and F-keys and the browser
// shortcuts belong to the browser; binding driving to one of them produces a
// car that cannot be steered and a settings panel that cannot be closed.
const RESERVED = ['Escape', 'F5', 'F11', 'F12', 'Enter'];

// How a code should be written on the screen. `KeyW` is not a key anybody has
// ever seen on a keyboard.
export function label(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6)}`;
  const named = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Space: 'SPACE', ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT',
    ControlLeft: 'L CTRL', ControlRight: 'R CTRL', AltLeft: 'L ALT', AltRight: 'R ALT',
    Tab: 'TAB', Backspace: 'BKSP', CapsLock: 'CAPS',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=',
    Backquote: '`',
  };
  return named[code] || code.toUpperCase();
}

load();
