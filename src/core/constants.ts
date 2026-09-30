/**
 * Frozen model constants.
 *
 * Units (SI unless noted):
 *   length  : metres
 *   time    : SI seconds (unix epoch seconds everywhere in storage/API)
 *   angles  : radians internally; the CLI/API accept degrees and convert
 *
 * Scope statement (see README): this is a *fictional* two-body model over a
 * spherical, uniformly rotating Earth. It deliberately contains NO
 * perturbations (J2, drag, third body), NO atmospheric refraction, and NO
 * real Earth attitude / polar motion / nutation.
 */

export interface ModelConstants {
  /** Newton gravitational parameter of the Earth, m^3 s^-2. */
  readonly mu: number;
  /** Spherical Earth radius, m. */
  readonly earthRadius: number;
  /** Earth sidereal rotation rate, rad s^-1 (uniform). */
  readonly omegaEarth: number;
  /** Reference Greenwich/rotation angle at unix epoch t=0, rad. */
  readonly thetaAtEpoch: number;
}

/**
 * Fictional-but-self-consistent constants. They are close to familiar values
 * but the whole package must never be mistaken for operational data.
 */
export const DEFAULT_CONSTANTS: ModelConstants = Object.freeze({
  mu: 3.986004418e14,
  earthRadius: 6_371_000,
  omegaEarth: 7.2921159e-5,
  thetaAtEpoch: 0,
});

export const TWO_PI = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const SECONDS_PER_DAY = 86_400;

/**
 * Maximum allowed propagation/pass-search interval and scan cap.
 * The scan step is capped so bracket search cannot silently skip structure;
 * windows shorter than the step are still possible and are flagged.
 */
export const MAX_SCAN_STEP_S = 600;
export const DEFAULT_SCAN_STEP_S = 60;

/** Bisection refinement controls for threshold crossing. */
export const BISECT_MAX_ITER = 80;
export const BISECT_TIME_TOL_S = 1e-4;

/** Numerical guards. */
export const EPS = 1e-12;
