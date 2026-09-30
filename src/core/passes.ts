import {
  BISECT_MAX_ITER,
  BISECT_TIME_TOL_S,
  DEFAULT_SCAN_STEP_S,
  MAX_SCAN_STEP_S,
  DEFAULT_CONSTANTS,
  type ModelConstants,
} from './constants.ts';
import type { OrbitalElements } from './orbit.ts';
import { observe, type Observation, type Station } from './station.ts';

export interface PassWindow {
  /** AOS / acquisition of signal (entry), unix s; null if already visible. */
  startSeconds: number | null;
  /** LOS / loss of signal (exit), unix s; null if still visible at interval end. */
  endSeconds: number | null;
  maxElevationDeg: number;
  maxElevationTimeSeconds: number;
  /** true when the window is open at the start/end of the search interval. */
  openAtStart: boolean;
  openAtEnd: boolean;
  /** true when the window duration is shorter than one scan step (may be missed on coarser scans). */
  possiblyUndersampled: boolean;
}

export interface PassReport {
  fromSeconds: number;
  toSeconds: number;
  stepSeconds: number;
  station: string;
  minElevationDeg: number;
  windows: PassWindow[];
  /** Windows that cross an interval boundary and therefore are not closed. */
  unclosedWindowCount: number;
  warnings: string[];
}

function elevationAt(
  el: OrbitalElements,
  station: Station,
  t: number,
  c: ModelConstants,
): number {
  return observe(el, station, t, c).elevationRad;
}

/**
 * Locate f(t)=threshold within a sign-changing bracket [lo,hi] using bisection.
 * `fLo` is the (already computed) value at lo. Returns the refined time.
 */
function bisectCrossing(
  f: (t: number) => number,
  lo: number,
  hi: number,
  fLo: number,
  fHi: number,
  threshold: number,
): number {
  let a = lo;
  let b = hi;
  let fa = fLo - threshold;
  let fb = fHi - threshold;
  for (let i = 0; i < BISECT_MAX_ITER; i++) {
    const mid = 0.5 * (a + b);
    if (b - a <= BISECT_TIME_TOL_S) return mid;
    const fm = f(mid) - threshold;
    if (fa === 0) return a;
    if (fb === 0) return b;
    if (fa * fm <= 0) {
      b = mid;
      fb = fm;
    } else {
      a = mid;
      fa = fm;
    }
  }
  return 0.5 * (a + b);
}

export interface FindPassesOptions {
  fromSeconds: number;
  toSeconds: number;
  stepSeconds?: number;
  model?: ModelConstants;
  /** Override the station gate; defaults to station.minElevationRad. */
  minElevationRad?: number;
}

/**
 * Search visibility windows over [from,to].
 *
 * Method: a coarse sign scan at a capped step detects brackets where the
 * elevation crosses the gate; every entry/exit boundary is then refined with
 * bisection to BISECT_TIME_TOL_S. Coarse samples are never reported as exact
 * crossing times.
 *
 * Limitations flagged in the report:
 *  - windows shorter than one step can be missed entirely (undersampled);
 *  - windows open at a boundary are reported with a null edge and counted.
 */
export function findPasses(
  el: OrbitalElements,
  station: Station,
  opts: FindPassesOptions,
): PassReport {
  const c = opts.model ?? DEFAULT_CONSTANTS;
  const warnings: string[] = [];
  const from = opts.fromSeconds;
  const to = opts.toSeconds;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new RangeError('require finite fromSeconds < toSeconds');
  }

  let step = opts.stepSeconds ?? DEFAULT_SCAN_STEP_S;
  if (!Number.isFinite(step) || step <= 0) {
    throw new RangeError('stepSeconds must be positive');
  }
  if (step > MAX_SCAN_STEP_S) {
    warnings.push(
      `requested step ${step}s exceeds cap ${MAX_SCAN_STEP_S}s; reduced to the cap (short windows may be missed)`,
    );
    step = MAX_SCAN_STEP_S;
  }

  const gate = opts.minElevationRad ?? station.minElevationRad;
  const f = (t: number) => elevationAt(el, station, t, c);

  const windows: PassWindow[] = [];
  let current: PassWindow | null = null;
  let maxEl = -Infinity;
  let maxElT = from;

  let tPrev = from;
  let ePrev = f(from) - gate;
  if (ePrev >= 0) {
    current = {
      startSeconds: null,
      endSeconds: null,
      maxElevationDeg: -Infinity,
      maxElevationTimeSeconds: from,
      openAtStart: true,
      openAtEnd: false,
      possiblyUndersampled: false,
    };
    maxEl = f(from);
    maxElT = from;
  }

  const flush = (endTime: number | null, openAtEnd: boolean) => {
    if (!current) return;
    current.endSeconds = endTime;
    current.openAtEnd = openAtEnd;
    current.maxElevationDeg = (maxEl * 180) / Math.PI;
    current.maxElevationTimeSeconds = maxElT;
    windows.push(current);
    current = null;
    maxEl = -Infinity;
  };

  let t = from;
  while (t < to) {
    const tNext = Math.min(t + step, to);
    const eNow = f(tNext) - gate;

    if (current && eNow > maxEl) {
      maxEl = eNow + gate;
      maxElT = tNext;
    }

    if (ePrev < 0 && eNow >= 0) {
      // Entry bracket [t, tNext].
      const entry = bisectCrossing(f, t, tNext, ePrev + gate, eNow + gate, gate);
      current = {
        startSeconds: entry,
        endSeconds: null,
        maxElevationDeg: -Infinity,
        maxElevationTimeSeconds: entry,
        openAtStart: false,
        openAtEnd: false,
        possiblyUndersampled: false,
      };
      maxEl = f(entry);
      maxElT = entry;
    } else if (current && ePrev >= 0 && eNow < 0) {
      // Exit bracket.
      const exit = bisectCrossing(f, t, tNext, ePrev + gate, eNow + gate, gate);
      flush(exit, false);
    }

    ePrev = eNow;
    t = tNext;
  }

  if (current) flush(null, true);

  // Mark windows shorter than a step as potentially undersampled.
  for (const w of windows) {
    if (w.startSeconds !== null && w.endSeconds !== null) {
      const dur = w.endSeconds - w.startSeconds;
      if (dur < step) w.possiblyUndersampled = true;
    }
  }

  const unclosed = windows.filter((w) => w.openAtStart || w.openAtEnd).length;
  if (unclosed > 0) {
    warnings.push(
      `${unclosed} window(s) are open at a search boundary and are unclosed within the interval`,
    );
  }
  warnings.push(
    `coarse scan step ${step}s: visibility windows shorter than ~${step}s may be missed; refine the step to verify`,
  );

  return {
    fromSeconds: from,
    toSeconds: to,
    stepSeconds: step,
    station: station.name,
    minElevationDeg: (gate * 180) / Math.PI,
    windows,
    unclosedWindowCount: unclosed,
    warnings,
  };
}

/** Convenience: single observation details used by trajectory listings. */
export function sampleTrack(
  el: OrbitalElements,
  station: Station,
  fromSeconds: number,
  toSeconds: number,
  count: number,
  c: ModelConstants = DEFAULT_CONSTANTS,
): Observation[] {
  if (count < 2) throw new RangeError('count must be >= 2');
  const out: Observation[] = [];
  const span = toSeconds - fromSeconds;
  for (let i = 0; i < count; i++) {
    const t = fromSeconds + (span * i) / (count - 1);
    out.push(observe(el, station, t, c));
  }
  return out;
}
