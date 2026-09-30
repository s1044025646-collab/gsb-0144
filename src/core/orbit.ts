import { DEFAULT_CONSTANTS, EPS, type ModelConstants } from './constants.ts';
import { wrapTwoPi } from './angle.ts';
import { solveKepler } from './kepler.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Classical orbital elements at an epoch.
 *
 * Angles in radians: inclination i, raan (longitude of ascending node) Ω,
 * argument of perigee ω. `semiMajorAxis` in metres, dimensionless `eccentricity`.
 * `meanAnomalyAtEpoch` (rad) is the mean anomaly at `epochSeconds` (unix s).
 */
export interface OrbitalElements {
  semiMajorAxis: number;
  eccentricity: number;
  inclination: number;
  raan: number;
  argPerigee: number;
  meanAnomalyAtEpoch: number;
  epochSeconds: number;
}

export interface InertialState {
  position: Vec3;
  velocity: Vec3;
  /** Elapsed seconds since the element epoch. */
  dt: number;
  /** Mean anomaly at the requested time (unwrapped, may exceed 2π). */
  meanAnomaly: number;
  eccentricAnomaly: number;
  trueAnomaly: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate elements against model assumptions.
 * Rejects non-elliptic orbits and perigee below the spherical surface.
 */
export function validateElements(
  el: Partial<OrbitalElements>,
  c: ModelConstants = DEFAULT_CONSTANTS,
): ValidationResult {
  const errors: string[] = [];
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

  if (!num(el.semiMajorAxis) || (el.semiMajorAxis as number) <= 0)
    errors.push('semiMajorAxis must be a positive finite number (metres)');
  if (!num(el.eccentricity) || (el.eccentricity as number) < 0 || (el.eccentricity as number) >= 1)
    errors.push('eccentricity must satisfy 0 <= e < 1 (elliptic only; hyperbolic/parabolic rejected)');
  for (const [k, label] of [
    ['inclination', 'inclination'],
    ['raan', 'raan'],
    ['argPerigee', 'argPerigee'],
    ['meanAnomalyAtEpoch', 'meanAnomalyAtEpoch'],
    ['epochSeconds', 'epochSeconds'],
  ] as const) {
    if (!num(el[k])) errors.push(`${label} must be a finite number (radians / unix seconds)`);
  }

  if (errors.length === 0) {
    const a = el.semiMajorAxis as number;
    const e = el.eccentricity as number;
    const perigee = a * (1 - e);
    if (perigee <= c.earthRadius) {
      errors.push(
        `perigee radius ${perigee.toFixed(1)} m is at/below Earth radius ${c.earthRadius} m: orbit intersects the surface and is unsupported`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Rotation from the perifocal (PQW) frame to the inertial (ECI-like) frame.
 *
 * The combined matrix below applies, in order, the standard 3-1-3 Euler set:
 *   R = R3(Ω) · R1(i) · R3(ω)
 * i.e. a vector expressed in perifocal coordinates is first rotated by ω
 * about z, then by inclination i about the (new) x, then by RAAN Ω about z.
 */
function perifocalToInertialMatrix(el: OrbitalElements): number[] {
  const cO = Math.cos(el.raan);
  const sO = Math.sin(el.raan);
  const ci = Math.cos(el.inclination);
  const si = Math.sin(el.inclination);
  const cw = Math.cos(el.argPerigee);
  const sw = Math.sin(el.argPerigee);

  const m11 = cO * cw - sO * sw * ci;
  const m12 = -cO * sw - sO * cw * ci;
  const m21 = sO * cw + cO * sw * ci;
  const m22 = -sO * sw + cO * cw * ci;
  const m31 = sw * si;
  const m32 = cw * si;
  return [m11, m12, 0, m21, m22, 0, m31, m32, 0];
}

function matVec(m: number[], v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

/**
 * Propagate elements to an absolute unix time and return inertial
 * position and velocity (perifocal -> inertial via the documented 3-1-3 set).
 */
export function propagateInertial(
  el: OrbitalElements,
  timeSeconds: number,
  c: ModelConstants = DEFAULT_CONSTANTS,
): InertialState {
  const v = validateElements(el, c);
  if (!v.ok) throw new RangeError(v.errors.join('; '));

  const dt = timeSeconds - el.epochSeconds;
  const n = Math.sqrt(c.mu / (el.semiMajorAxis ** 3)); // mean motion rad/s
  const M = el.meanAnomalyAtEpoch + n * dt;
  const E = solveKepler(wrapTwoPi(M), el.eccentricity);

  const a = el.semiMajorAxis;
  const e = el.eccentricity;

  // Perifocal position / velocity.
  const p: Vec3 = {
    x: a * (Math.cos(E) - e),
    y: a * Math.sqrt(1 - e * e) * Math.sin(E),
    z: 0,
  };
  const factor = Math.sqrt(c.mu * a) / a; // sqrt(mu a)/a
  const denom = 1 - e * Math.cos(E);
  const vel: Vec3 = {
    x: -(factor * Math.sin(E)) / denom,
    y: (factor * Math.sqrt(1 - e * e) * Math.cos(E)) / denom,
    z: 0,
  };

  const m = perifocalToInertialMatrix(el);
  const position = matVec(m, p);
  const velocity = matVec(m, vel);

  // True anomaly via atan2, stable at e=0 (ν reduces to E ≡ M).
  const trueAnomaly = Math.atan2(
    Math.sqrt(1 - e * e) * Math.sin(E),
    Math.cos(E) - e,
  );

  return {
    position,
    velocity,
    dt,
    meanAnomaly: M,
    eccentricAnomaly: E,
    trueAnomaly: wrapTwoPi(trueAnomaly),
  };
}

/** Orbital period in seconds (Kepler III). */
export function orbitalPeriod(el: OrbitalElements, c: ModelConstants = DEFAULT_CONSTANTS): number {
  return 2 * Math.PI * Math.sqrt(el.semiMajorAxis ** 3 / c.mu);
}

/** Specific orbital energy ε = v²/2 − μ/r (J/kg). */
export function specificEnergy(s: InertialState, c: ModelConstants = DEFAULT_CONSTANTS): number {
  const r = Math.sqrt(s.position.x ** 2 + s.position.y ** 2 + s.position.z ** 2);
  const v2 = s.velocity.x ** 2 + s.velocity.y ** 2 + s.velocity.z ** 2;
  return v2 / 2 - c.mu / r;
}

/** Specific angular momentum vector h = r × v (m²/s). */
export function angularMomentum(s: InertialState): Vec3 {
  const { position: r, velocity: v } = s;
  return {
    x: r.y * v.z - r.z * v.y,
    y: r.z * v.x - r.x * v.z,
    z: r.x * v.y - r.y * v.x,
  };
}

/** Greenwich rotation angle θ(t) = θ0 + ωe·t, wrapped to [0,2π). */
export function greenwichAngle(timeSeconds: number, c: ModelConstants = DEFAULT_CONSTANTS): number {
  return wrapTwoPi(c.thetaAtEpoch + c.omegaEarth * timeSeconds);
}

/**
 * Rotate an inertial vector to Earth-fixed (ECEF-like) coordinates.
 *
 * A single rotation by −θ about the z axis (Rz(−θ)), since the Earth rotates
 * by +θ relative to inertia. Order relative to the orbital 3-1-3 transform is:
 * first orbital PQW->ECI, then ECI->ECEF with Rz(−θ(t)).
 */
export function inertialToEarthFixed(p: Vec3, timeSeconds: number, c: ModelConstants = DEFAULT_CONSTANTS): Vec3 {
  const theta = greenwichAngle(timeSeconds, c);
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  return {
    x: ct * p.x + st * p.y,
    y: -st * p.x + ct * p.y,
    z: p.z,
  };
}

/** Inverse of inertialToEarthFixed: Rz(+θ). Exact for round-trip tests. */
export function earthFixedToInertial(p: Vec3, timeSeconds: number, c: ModelConstants = DEFAULT_CONSTANTS): Vec3 {
  const theta = greenwichAngle(timeSeconds, c);
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  return {
    x: ct * p.x - st * p.y,
    y: st * p.x + ct * p.y,
    z: p.z,
  };
}

export function vecNorm(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vecDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Guard re-export for tests that want the numerical floor. */
export { EPS };
