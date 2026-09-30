import { FrozenConstants } from './constants.js';
import {
  EarthSpin,
  GroundStation,
  OrbitEpoch,
  greenwichAngle,
  inertialToEcef,
  lookAngles,
  orbitalPeriod,
  propagateInertial,
} from './orbit.js';

export interface VisibilitySample {
  t: number;
  elevation: number | null;
  azimuth: number | null;
  range: number | null;
}

export interface VisibilityWindow {
  /** Enter time [s]. null when the window was already open at interval start. */
  enter: number | null;
  /** Exit time [s]. null when the window remains open at interval end. */
  exit: number | null;
  maxElevation: number;
  maxElevationTime: number;
  /** Root-location residual at the bracketed boundaries [deg], |f| there. */
  boundaryResidualDeg: number;
}

export interface WindowOptions {
  /** Search start [s], inclusive. */
  start: number;
  /** Search end [s], inclusive. */
  end: number;
  /**
   * Maximum permitted coarse scan step [s]. The solver uses at most this and
   * also at most one orbital period, whichever is smaller.
   */
  maxStep: number;
  /** Bisection refinement tolerance in seconds. */
  rootTol?: number;
}

export interface WindowReport {
  stationId: string;
  minElevDeg: number;
  start: number;
  end: number;
  usedStep: number;
  windows: VisibilityWindow[];
  warnings: string[];
}

function elevationAt(
  epoch: OrbitEpoch,
  spin: EarthSpin,
  station: GroundStation,
  c: FrozenConstants,
  t: number,
): VisibilitySample {
  const state = propagateInertial(epoch, c, t);
  const theta = greenwichAngle(spin, c, t);
  const ecef = inertialToEcef(state, theta);
  const look = lookAngles(station, ecef, c);
  return { t, ...look };
}

function geometryAt(
  epoch: OrbitEpoch,
  spin: EarthSpin,
  station: GroundStation | null,
  c: FrozenConstants,
  t: number,
): VisibilitySample {
  const state = propagateInertial(epoch, c, t);
  const theta = greenwichAngle(spin, c, t);
  const ecef = inertialToEcef(state, theta);
  if (!station) return { t, elevation: null, azimuth: null, range: null };
  const look = lookAngles(station, ecef, c);
  return { t, ...look };
}

/**
 * f(t) = elevation(t) - gate. A visibility interval is where f >= 0.
 * Coarse scan finds sign changes; bisection refines each root to rootTol.
 */
export function computeWindows(
  epoch: OrbitEpoch,
  spin: EarthSpin,
  station: GroundStation,
  c: FrozenConstants,
  options: WindowOptions,
): WindowReport {
  if (!(options.end > options.start)) {
    const err = new Error('end must be greater than start') as Error & {
      code?: string;
    };
    err.code = 'INVALID_RANGE';
    throw err;
  }
  if (!(options.maxStep > 0)) {
    const err = new Error('maxStep must be > 0') as Error & { code?: string };
    err.code = 'INVALID_RANGE';
    throw err;
  }

  const gate = station.minElevDeg;
  const period = orbitalPeriod(epoch.elements.a, c.mu);
  const usedStep = Math.min(options.maxStep, period);
  const rootTol = options.rootTol ?? 1e-3;
  const warnings: string[] = [];

  if (usedStep > period / 2) {
    warnings.push(
      `Coarse step ${usedStep.toFixed(1)}s exceeds half a period; short visibility windows may be missed. Reduce maxStep.`,
    );
  }

  const f = (t: number) =>
    (elevationAt(epoch, spin, station, c, t).elevation as number) - gate;

  const refine = (lo: number, hi: number, flo: number, fhi: number): number => {
    // Bisect on a guaranteed sign change. f is continuous under the model.
    let a = lo;
    let b = hi;
    let fa = flo;
    let fb = fhi;
    for (let k = 0; k < 100 && b - a > rootTol; k++) {
      const mid = (a + b) / 2;
      const fm = f(mid);
      if (fa * fm <= 0) {
        b = mid;
        fb = fm;
      } else {
        a = mid;
        fa = fm;
      }
    }
    const root = (a + b) / 2;
    return root;
  };

  const windows: VisibilityWindow[] = [];
  let tPrev = options.start;
  let fPrev = f(tPrev);
  let openWindow: VisibilityWindow | null = null;

  if (fPrev >= 0) {
    openWindow = {
      enter: null,
      exit: null,
      maxElevation: fPrev + gate,
      maxElevationTime: tPrev,
      boundaryResidualDeg: Math.abs(fPrev),
    };
  }

  let t = options.start;
  while (t < options.end) {
    const tNext = Math.min(t + usedStep, options.end);
    const fNext = f(tNext);

    if (fPrev * fNext < 0 || (fPrev < 0 && fNext === 0) || (fPrev === 0 && fNext > 0)) {
      const root = refine(t, tNext, fPrev, fNext);
      if (fPrev < 0) {
        // entering
        openWindow = {
          enter: root,
          exit: null,
          maxElevation: gate,
          maxElevationTime: root,
          boundaryResidualDeg: Math.abs(f(root)),
        };
      } else if (fPrev >= 0 && openWindow) {
        // exiting
        openWindow.exit = root;
        openWindow.boundaryResidualDeg = Math.max(
          openWindow.boundaryResidualDeg,
          Math.abs(f(root)),
        );
        windows.push(openWindow);
        openWindow = null;
      }
    } else if (fPrev === 0 && fNext < 0 && openWindow) {
      openWindow.exit = t;
      windows.push(openWindow);
      openWindow = null;
    }

    // Track peak elevation across the segment while a window is open.
    if (openWindow) {
      const mid = (t + tNext) / 2;
      const sMid = elevationAt(epoch, spin, station, c, mid);
      if ((sMid.elevation as number) > openWindow.maxElevation) {
        openWindow.maxElevation = sMid.elevation as number;
        openWindow.maxElevationTime = mid;
      }
      const sEnd = elevationAt(epoch, spin, station, c, tNext);
      if ((sEnd.elevation as number) > openWindow.maxElevation) {
        openWindow.maxElevation = sEnd.elevation as number;
        openWindow.maxElevationTime = tNext;
      }
    }

    tPrev = tNext;
    fPrev = fNext;
    t = tNext;
  }

  if (openWindow) {
    windows.push(openWindow);
    warnings.push(
      'A visibility window is still open at the end of the interval; exit boundary is unclosed (extend the search end time).',
    );
  }
  if (f(options.start) >= 0) {
    warnings.push(
      'A visibility window was already open at the start of the interval; enter boundary is unclosed (extend the search start earlier).',
    );
  }

  return {
    stationId: station.id,
    minElevDeg: gate,
    start: options.start,
    end: options.end,
    usedStep,
    windows,
    warnings,
  };
}

export function sampleTrack(
  epoch: OrbitEpoch,
  spin: EarthSpin,
  station: GroundStation | null,
  c: FrozenConstants,
  start: number,
  end: number,
  step: number,
): VisibilitySample[] {
  if (!(end >= start) || !(step > 0)) {
    const err = new Error('require end>=start and step>0') as Error & {
      code?: string;
    };
    err.code = 'INVALID_RANGE';
    throw err;
  }
  const out: VisibilitySample[] = [];
  for (let t = start; t <= end + 1e-9; t += step) {
    const tt = Math.min(t, end);
    out.push(geometryAt(epoch, spin, station, c, tt));
    if (tt === end) break;
  }
  return out;
}
