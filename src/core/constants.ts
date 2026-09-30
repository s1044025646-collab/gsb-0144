/**
 * FROZEN model constants for a scenario. Every value is fixed when a scenario is
 * created and never mutated. Units are SI unless otherwise stated:
 *  - length: metres
 *  - time:   seconds (TAI-like monotonic elapsed time; no leap-second modeling)
 *  - angle:  radians internally (degrees only at the API/CLI boundary)
 *  - mass:   kilograms (only used to dimension mu)
 */

/**
 * Default spherical-Earth constants. These are deliberately simplified and
 * FICTIONAL reference values: no WGS84, no nutation, no polar motion.
 */
export const DEFAULT_CONSTANTS = {
  /** Standard gravitational parameter mu = GM [m^3/s^2]. */
  mu: 3.986004418e14,
  /** Mean spherical Earth radius [m]. */
  earthRadius: 6_371_000,
  /**
   * Earth sidereal rotation rate [rad/s]. theta_ECEF(t) = theta0 + omegaE*(t-epoch0).
   */
  earthAngularVelocity: 7.292115146706979e-5,
} as const;

export interface FrozenConstants {
  mu: number;
  earthRadius: number;
  earthAngularVelocity: number;
}

export function freezeConstants(
  override: Partial<FrozenConstants> = {},
): FrozenConstants {
  return Object.freeze({
    mu: override.mu ?? DEFAULT_CONSTANTS.mu,
    earthRadius: override.earthRadius ?? DEFAULT_CONSTANTS.earthRadius,
    earthAngularVelocity:
      override.earthAngularVelocity ?? DEFAULT_CONSTANTS.earthAngularVelocity,
  });
}

export const MODEL_LIMITATIONS = [
  'Two-body point-mass gravity only; no J2, luni-solar, SRP, or other perturbations.',
  'Spherical uniformly rotating Earth; no flattening, precession, nutation, polar motion, or real Earth attitude.',
  'No atmospheric refraction, signal delay, or obstruction masking beyond a scalar elevation gate.',
  'Fictional fixtures only; never connected to live ephemeris or real spacecraft.',
] as const;
