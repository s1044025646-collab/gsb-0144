import {
  TAU,
  Vec3,
  clamp,
  deg2rad,
  matVec,
  mul3,
  norm2pi,
  rotXYZ,
  transpose3,
  vcross,
  vdot,
  vnorm,
  vscale,
  vsub,
} from './math.js';
import { FrozenConstants } from './constants.js';
import { fail } from './errors.js';

/**
 * Classical Keplerian orbital elements.
 * Angles in degrees at the input boundary, stored internally in radians.
 *  a   semi-major axis [m]                 (a > 0 required => bound ellipse)
 *  e   eccentricity [1]                    (0 <= e < 1)
 *  i   inclination [deg]                   [0, 180]
 *  raan right ascension of ascending node  [deg], any value (wrap-safe)
 *  argp argument of perigee [deg], any value (wrap-safe)
 *  nu0 true anomaly at epoch t0 [deg], any value (wrap-safe)
 */
export interface OrbitalElementsInput {
  a: number;
  e: number;
  iDeg: number;
  raanDeg: number;
  argpDeg: number;
  nu0Deg: number;
}

export interface OrbitalElements {
  a: number;
  e: number;
  i: number;
  raan: number;
  argp: number;
  nu0: number;
}

export interface OrbitEpoch {
  /** Epoch seconds on the scenario clock for nu0. */
  t0: number;
  elements: OrbitalElements;
}

export function toElements(input: OrbitalElementsInput): OrbitalElements {
  return {
    a: input.a,
    e: input.e,
    i: deg2rad(input.iDeg),
    raan: deg2rad(input.raanDeg),
    argp: deg2rad(input.argpDeg),
    nu0: deg2rad(input.nu0Deg),
  };
}

export function validateElements(
  el: OrbitalElements,
  c: FrozenConstants,
): void {
  if (!Number.isFinite(el.a) || !Number.isFinite(el.e)) {
    fail('VALIDATION', 'Orbital elements must be finite numbers.');
  }
  if (el.a <= 0) {
    fail(
      'UNSUPPORTED_ORBIT',
      'Only bound elliptic orbits are supported: semi-major axis a must be > 0 (a<=0 implies parabolic/hyperbolic).',
      { a: el.a },
    );
  }
  if (el.e < 0) {
    fail('VALIDATION', 'Eccentricity must be >= 0.', { e: el.e });
  }
  if (el.e >= 1) {
    fail(
      'UNSUPPORTED_ORBIT',
      'Hyperbolic/parabolic orbits (e >= 1) are not supported.',
      { e: el.e },
    );
  }
  if (![el.i, el.raan, el.argp, el.nu0].every(Number.isFinite)) {
    fail('VALIDATION', 'All angular elements must be finite numbers.');
  }
  if (el.i < 0 || el.i > Math.PI) {
    fail('VALIDATION', 'Inclination must be in [0, 180] degrees.', {
      iRad: el.i,
    });
  }
  const periapsis = el.a * (1 - el.e);
  if (periapsis <= c.earthRadius) {
    fail(
      'BELOW_SURFACE',
      `Periapsis radius ${periapsis.toFixed(3)} m is at or below the spherical Earth radius ${c.earthRadius} m; orbit intersects the surface and is unsupported.`,
      { periapsis, earthRadius: c.earthRadius },
    );
  }
}

/** Solve Kepler's equation M = E - e sin E for E (radians), stable at e=0. */
export function solveKepler(
  meanAnomaly: number,
  e: number,
  options: { tol?: number; maxIter?: number } = {},
): number {
  const tol = options.tol ?? 1e-12;
  const maxIter = options.maxIter ?? 60;
  const m = norm2pi(meanAnomaly);
  if (e === 0) return m;
  // Initial guess; higher-order start for larger e.
  let E = e < 0.8 ? m : Math.PI;
  for (let iter = 0; iter < maxIter; iter++) {
    const f = E - e * Math.sin(E) - m;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) <= tol) return norm2pi(E);
  }
  // Bisection fallback on [0, 2pi) guarantees convergence (monotonic residual).
  let lo = 0;
  let hi = TAU;
  E = m;
  for (let iter = 0; iter < 80; iter++) {
    const f = E - e * Math.sin(E) - m;
    if (f > 0) hi = E;
    else lo = E;
    const next = (lo + hi) / 2;
    if (Math.abs(next - E) <= tol) return norm2pi(next);
    E = next;
  }
  return norm2pi(E);
}

export function trueFromEccentric(E: number, e: number): number {
  // Half-angle form is stable at e=0 and avoids quadrant ambiguity.
  const s = Math.sqrt((1 + e) / (1 - e)) * Math.tan(E / 2);
  return norm2pi(2 * Math.atan(s));
}

export function eccentricFromTrue(nu: number, e: number): number {
  const s = Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2);
  return norm2pi(2 * Math.atan(s));
}

export function meanMotion(a: number, mu: number): number {
  return Math.sqrt(mu / (a * a * a));
}

export function orbitalPeriod(a: number, mu: number): number {
  return TAU / meanMotion(a, mu);
}

export interface OrbitalState {
  t: number;
  /** Position in Earth-centered inertial frame [m]. */
  rI: Vec3;
  /** Velocity in inertial frame [m/s]. */
  vI: Vec3;
  /** Mean anomaly [rad]. */
  m: number;
  /** Eccentric anomaly [rad]. */
  E: number;
  /** True anomaly [rad]. */
  nu: number;
  /** Radius magnitude [m]. */
  r: number;
}

/**
 * Perifocal -> inertial rotation.
 * The perifocal frame has P toward periapsis, Q in-plane along motion, W = h_hat.
 * r_I = R3(-raan) R1(-i) R3(-argp) r_P (active column-vector convention).
 */
export function perifocalToInertialMatrix(el: OrbitalElements): number[][] {
  // rotXYZ(a,b,c) = Rz(c) Ry(b) Rx(a). Use explicit Rz/Rx rotations to express
  // R3(-raan) R1(-i) R3(-argp). Build directly to avoid unused middle rotations.
  const rz = (a: number): number[][] => [
    [Math.cos(a), -Math.sin(a), 0],
    [Math.sin(a), Math.cos(a), 0],
    [0, 0, 1],
  ];
  const rx = (a: number): number[][] => [
    [1, 0, 0],
    [0, Math.cos(a), -Math.sin(a)],
    [0, Math.sin(a), Math.cos(a)],
  ];
  return mul3(mul3(rz(-el.raan), rx(-el.i)), rz(-el.argp));
}

export function propagateInertial(
  epoch: OrbitEpoch,
  c: FrozenConstants,
  t: number,
): OrbitalState {
  const el = epoch.elements;
  const n = meanMotion(el.a, c.mu);
  const E0 = eccentricFromTrue(el.nu0, el.e);
  const m0 = E0 - el.e * Math.sin(E0);
  const m = norm2pi(m0 + n * (t - epoch.t0));
  const E = solveKepler(m, el.e);
  const nu = trueFromEccentric(E, el.e);

  const r = el.a * (1 - el.e * Math.cos(E));
  const cosNu = Math.cos(nu);
  const sinNu = Math.sin(nu);
  // Position in perifocal frame.
  const p = el.a * (1 - el.e * el.e);
  const rP: Vec3 = {
    x: (p / (1 + el.e * cosNu)) * cosNu,
    y: (p / (1 + el.e * cosNu)) * sinNu,
    z: 0,
  };
  // Velocity in perifocal frame (specific angular momentum h = sqrt(mu p)).
  const h = Math.sqrt(c.mu * p);
  const vP: Vec3 = {
    x: (-c.mu / h) * sinNu,
    y: (c.mu / h) * (el.e + cosNu),
    z: 0,
  };

  const q = perifocalToInertialMatrix(el);
  return {
    t,
    rI: matVec(q, rP),
    vI: matVec(q, vP),
    m,
    E,
    nu,
    r,
  };
}

/** Greenwich rotation angle theta(t) = theta0 + omegaE * (t - thetaEpoch). */
export interface EarthSpin {
  theta0: number;
  thetaEpoch: number;
}

export function greenwichAngle(spin: EarthSpin, c: FrozenConstants, t: number) {
  return norm2pi(
    spin.theta0 + c.earthAngularVelocity * (t - spin.thetaEpoch),
  );
}

/**
 * Inertial -> Earth-fixed-Earth-rotating (ECEF) at a common instant.
 * r_ECEF = R3(theta) r_I. Matrix order: rotate about Z by +theta (active).
 */
export function inertialToEcef(state: OrbitalState, theta: number): Vec3 {
  const rz = [
    [Math.cos(theta), -Math.sin(theta), 0],
    [Math.sin(theta), Math.cos(theta), 0],
    [0, 0, 1],
  ];
  return matVec(rz, state.rI);
}

/** ECEF -> inertial (inverse), used for the round-trip test. */
export function ecefToInertial(rEcef: Vec3, theta: number): Vec3 {
  const rz = [
    [Math.cos(theta), -Math.sin(theta), 0],
    [Math.sin(theta), Math.cos(theta), 0],
    [0, 0, 1],
  ];
  return matVec(transpose3(rz), rEcef);
}

export interface GroundStation {
  id: string;
  /** Geodetic/spherical latitude [deg], [-90, 90]. */
  latDeg: number;
  /** Longitude [deg], [-180, 180] or arbitrary (wrap-safe). */
  lonDeg: number;
  /** Station altitude above the spherical surface [m]. */
  altM: number;
  /** Minimum elevation gate [deg]. */
  minElevDeg: number;
}

export function stationEcef(station: GroundStation, c: FrozenConstants): Vec3 {
  const lat = deg2rad(station.latDeg);
  const lon = deg2rad(station.lonDeg);
  const radius = c.earthRadius + station.altM;
  return {
    x: radius * Math.cos(lat) * Math.cos(lon),
    y: radius * Math.cos(lat) * Math.sin(lon),
    z: radius * Math.sin(lat),
  };
}

export interface LookAngles {
  /** Slant range [m]. */
  range: number;
 /** Azimuth [deg] measured clockwise from local north, [0,360). */
  azimuth: number;
  /** Elevation [deg] above local tangent plane, [-90, 90]. */
  elevation: number;
}

/**
 * Range / azimuth / elevation from a ground station to an ECEF target.
 * Local ENU basis at the station; elevation=asin(up dot rho_hat),
 * azimuth=atan2(east, north) measured from north clockwise.
 */
export function lookAngles(
  station: GroundStation,
  targetEcef: Vec3,
  c: FrozenConstants,
): LookAngles {
  const lat = deg2rad(clamp(station.latDeg, -90, 90));
  const lon = deg2rad(station.lonDeg);
  const stationPos = stationEcef(station, c);
  const rho = vsub(targetEcef, stationPos);
  const range = vnorm(rho);

  const east = { x: -Math.sin(lon), y: Math.cos(lon), z: 0 };
  const north = {
    x: -Math.sin(lat) * Math.cos(lon),
    y: -Math.sin(lat) * Math.sin(lon),
    z: Math.cos(lat),
  };
  const up = {
    x: Math.cos(lat) * Math.cos(lon),
    y: Math.cos(lat) * Math.sin(lon),
    z: Math.sin(lat),
  };

  const eComp = vdot(rho, east);
  const nComp = vdot(rho, north);
  const uComp = vdot(rho, up);

  const elevation = Math.asin(clamp(uComp / range, -1, 1));
  const azimuth = norm2pi(Math.atan2(eComp, nComp));

  return {
    range,
    azimuth: (azimuth * 180) / Math.PI,
    elevation: (elevation * 180) / Math.PI,
  };
}

/** Specific orbital energy [J/kg] — conserved in the two-body problem. */
export function specificEnergy(state: OrbitalState, mu: number): number {
  return vdot(state.vI, state.vI) / 2 - mu / state.r;
}

/** Specific angular momentum vector [m^2/s] — conserved. */
export function angularMomentum(state: OrbitalState): Vec3 {
  return vcross(state.rI, state.vI);
}

// Keep vscale referenced for utility completeness.
void vscale;
