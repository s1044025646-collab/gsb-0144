export const TAU = Math.PI * 2;

export function deg2rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function rad2deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function norm2pi(angle: number): number {
  const r = angle % TAU;
  return r < 0 ? r + TAU : r;
}

export function normPi(angle: number): number {
  const r = norm2pi(angle);
  return r > Math.PI ? r - TAU : r;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function nearZero(x: number, eps = 1e-12): boolean {
  return Math.abs(x) <= eps;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vadd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vsub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vscale(a: Vec3, eps: number): Vec3 {
  return { x: a.x * eps, y: a.y * eps, z: a.z * eps };
}

export function vdot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vcross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function vnorm(a: Vec3): number {
  return Math.sqrt(vdot(a, a));
}

export function matVec(m: number[][], v: Vec3): Vec3 {
  return {
    x: m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
    y: m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
    z: m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
  };
}

export function transpose3(m: number[][]): number[][] {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

/** Rotation about X by a, then Y by b, then Z by c, applied to a column vector: Rz(c) Ry(b) Rx(a) v. */
export function rotXYZ(a: number, b: number, c: number): number[][] {
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cc = Math.cos(c), sc = Math.sin(c);
  const rx = [
    [1, 0, 0],
    [0, ca, -sa],
    [0, sa, ca],
  ];
  const ry = [
    [cb, 0, sb],
    [0, 1, 0],
    [-sb, 0, cb],
  ];
  const rz = [
    [cc, -sc, 0],
    [sc, cc, 0],
    [0, 0, 1],
  ];
  return mul3(mul3(rz, ry), rx);
}

export function mul3(a: number[][], b: number[][]): number[][] {
  const r = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) r[i][j] += a[i][k] * b[k][j];
    }
  }
  return r;
}
