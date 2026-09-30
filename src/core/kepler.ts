import { EPS, TWO_PI } from './constants.ts';

/**
 * Solve Kepler's equation  M = E - e sin E  for eccentric anomaly E.
 *
 * Uses Newton-Raphson with a fixed, deterministic iteration budget. The
 * eccentricity is required to satisfy 0 <= e < 1 (elliptic only). Mean
 * anomaly is wrapped to [0, 2π) so multi-turn inputs converge to the same
 * branch; callers that need cumulative anomaly keep it externally.
 */
export function solveKepler(meanAnomaly: number, eccentricity: number): number {
  if (!Number.isFinite(eccentricity) || eccentricity < 0 || eccentricity >= 1) {
    throw new RangeError(
      `unsupported eccentricity ${eccentricity}: only 0 <= e < 1 (elliptic) is supported`,
    );
  }
  if (!Number.isFinite(meanAnomaly)) {
    throw new RangeError('mean anomaly must be finite');
  }

  let M = meanAnomaly % TWO_PI;
  if (M < 0) M += TWO_PI;

  // Circular case has an exact answer; avoids 0/0-style guards downstream.
  if (eccentricity === 0) return M;

  // Initial guess: E0 = M + e sin M (good across the whole ellipse).
  let E = M + eccentricity * Math.sin(M);
  for (let iter = 0; iter < 100; iter++) {
    const f = E - eccentricity * Math.sin(E) - M;
    const fp = 1 - eccentricity * Math.cos(E);
    const delta = f / fp;
    E -= delta;
    if (Math.abs(delta) < EPS) break;
  }
  return E;
}
