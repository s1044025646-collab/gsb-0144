import { TWO_PI } from './constants.ts';

/** Wrap an angle into [0, 2π); stable across multi-turn inputs. */
export function wrapTwoPi(a: number): number {
  if (!Number.isFinite(a)) return Number.NaN;
  let r = a % TWO_PI;
  if (r < 0) r += TWO_PI;
  // Guard against -0 and floating residue landing on 2π.
  if (r >= TWO_PI) r -= TWO_PI;
  return r;
}

/** Wrap an angle into (-π, π]. */
export function wrapPi(a: number): number {
  let r = wrapTwoPi(a);
  if (r > Math.PI) r -= TWO_PI;
  return r;
}

/** Smallest signed angular difference b - a in (-π, π]. */
export function angleDiff(b: number, a: number): number {
  return wrapPi(b - a);
}

export function degToRad(d: number): number {
  return d * (Math.PI / 180);
}

export function radToDeg(r: number): number {
  return r * (180 / Math.PI);
}

/**
 * Quadratic mean for combining e.g. numeric tolerances; kept tiny & explicit.
 */
export function hypot3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}
