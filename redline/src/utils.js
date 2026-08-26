// Small maths shared by the whole game. Nothing here knows about cars or
// tracks; it is all scalars, angles and the odd bit of geometry.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, rate, dt) => a + (b - a) * Math.min(1, rate * dt);
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

export function rand(a = 1, b) {
  if (b === undefined) { b = a; a = 0; }
  return a + Math.random() * (b - a);
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Shortest signed difference between two angles, in (-pi, pi].
export function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Move `a` toward `b` by at most `maxStep`.
export function approach(a, b, maxStep) {
  const d = b - a;
  if (d > maxStep) return a + maxStep;
  if (d < -maxStep) return a - maxStep;
  return b;
}

export const dist2D = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);

// Linear interpolation through a table of [x, y] pairs, flat outside the ends.
// Engine torque curves and grip-versus-load curves are both this shape.
export function curve(table, x) {
  if (x <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x > x1) continue;
    const [x0, y0] = table[i - 1];
    return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
  }
  return last[1];
}

// A closed Catmull-Rom spline through the given points, which is what the
// track's centreline is. Returns the point at parameter t in [0, n).
export function catmullRom(points, t, out = { x: 0, y: 0, z: 0 }) {
  const n = points.length;
  const i = Math.floor(t) % n;
  const f = t - Math.floor(t);
  const p0 = points[(i - 1 + n) % n];
  const p1 = points[i];
  const p2 = points[(i + 1) % n];
  const p3 = points[(i + 2) % n];
  const f2 = f * f, f3 = f2 * f;
  const a = -0.5 * f3 + f2 - 0.5 * f;
  const b = 1.5 * f3 - 2.5 * f2 + 1;
  const c = -1.5 * f3 + 2 * f2 + 0.5 * f;
  const d = 0.5 * f3 - 0.5 * f2;
  out.x = p0.x * a + p1.x * b + p2.x * c + p3.x * d;
  out.y = p0.y * a + p1.y * b + p2.y * c + p3.y * d;
  out.z = p0.z * a + p1.z * b + p2.z * c + p3.z * d;
  return out;
}

// Seconds as m:ss.mmm — how a lap time is written.
export function lapTime(t) {
  if (!isFinite(t) || t <= 0) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}

// A gap, written the way timing screens write it.
export function gapTime(t) {
  if (!isFinite(t)) return '--';
  return `${t >= 0 ? '+' : '-'}${Math.abs(t).toFixed(3)}`;
}

export const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
