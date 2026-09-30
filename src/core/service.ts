import { DB } from '../db/database.js';
import {
  StationInput,
  addStation,
  cloneScenario,
  constantsOf,
  createScenario,
  epochOf,
  getOrbitByScenario,
  getScenario,
  getStation,
  listReports as dbListReports,
  listScenarios,
  listStations,
  saveReportIdempotent,
  setOrbit,
  spinOf,
  stationOf,
} from '../db/repo.js';
import {
  greenwichAngle,
  inertialToEcef,
  lookAngles,
  orbitalPeriod,
  propagateInertial,
  OrbitalElementsInput,
} from './orbit.js';
import { computeWindows, sampleTrack } from './windows.js';
import { fail } from './errors.js';

let idCounter = 0;
export function generateId(prefix: string, now: () => number): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_${now().toString(36)}_${idCounter.toString(36)}${Math.floor(
    (now() % 1) * 1e6,
  ).toString(36)}`;
}

export const service = {
  createScenario: (
    db: DB,
    input: Parameters<typeof createScenario>[1],
  ) => createScenario(db, input),

  getScenario: (db: DB, id: string) => getScenario(db, id),
  listScenarios: (db: DB, limit: unknown, offset: unknown) =>
    listScenarios(db, limit, offset),

  setOrbit: (
    db: DB,
    scenarioId: string,
    t0: number,
    elements: OrbitalElementsInput,
    orbitId?: string,
  ) =>
    setOrbit(
      db,
      orbitId ?? generateId('orb', db.now),
      scenarioId,
      t0,
      elements,
    ),

  addStation: (db: DB, scenarioId: string, input: StationInput) =>
    addStation(db, scenarioId, input),

  /**
   * Create a new frozen revision from an existing scenario. Copies constants,
   * spin, orbit, and stations; changes are applied only to the new scheme.
   */
  revise: (
    db: DB,
    sourceId: string,
    newId: string,
    newName: string,
    changes: { orbit?: { t0: number; elements: OrbitalElementsInput } } = {},
  ) => {
    const created = cloneScenario(db, sourceId, newId, newName);
    const sourceOrbit = getOrbitByScenario(db, sourceId);
    if (changes.orbit) {
      service.setOrbit(
        db,
        newId,
        changes.orbit.t0,
        changes.orbit.elements,
        `orb-${newId}`,
      );
    } else {
      service.setOrbit(
        db,
        newId,
        sourceOrbit.t0,
        {
          a: sourceOrbit.a,
          e: sourceOrbit.e,
          iDeg: sourceOrbit.i_deg,
          raanDeg: sourceOrbit.raan_deg,
          argpDeg: sourceOrbit.argp_deg,
          nu0Deg: sourceOrbit.nu0_deg,
        },
        `orb-${newId}`,
      );
    }
    const stations = listStations(db, sourceId, 200, 0).items;
    for (const st of stations) {
      addStation(db, newId, {
        id: st.id,
        name: st.name,
        latDeg: st.lat_deg,
        lonDeg: st.lon_deg,
        altM: st.alt_m,
        minElevDeg: st.min_elev_deg,
      });
    }
    return created;
  },
  listStations: (db: DB, scenarioId: string, limit: unknown, offset: unknown) =>
    listStations(db, scenarioId, limit, offset),

  /** Propagate to an absolute time and return inertial + ECEF + look geometry. */
  propagate(db: DB, scenarioId: string, stationId: string | null, t: number) {
    const scenario = getScenario(db, scenarioId);
    const orbitRow = getOrbitByScenario(db, scenarioId);
    const c = constantsOf(scenario);
    const spin = spinOf(scenario);
    if (!Number.isFinite(t)) fail('VALIDATION', 't must be finite seconds.');
    const state = propagateInertial(epochOf(orbitRow), c, t);
    const theta = greenwichAngle(spin, c, t);
    const ecef = inertialToEcef(state, theta);
    let look = null;
    if (stationId) {
      const station = stationOf(getStation(db, scenarioId, stationId));
      look = lookAngles(station, ecef, c);
    }
    return {
      t,
      thetaRad: theta,
      thetaDeg: (theta * 180) / Math.PI,
      anomalies: {
        meanDeg: (state.m * 180) / Math.PI,
        eccentricDeg: (state.E * 180) / Math.PI,
        trueDeg: (state.nu * 180) / Math.PI,
      },
      radiusM: state.r,
      inertial: state.rI,
      velocityI: state.vI,
      ecef,
      look,
      periodS: orbitalPeriod(orbitRow.a, c.mu),
      model: 'two-body-spherical-earth',
    };
  },

  track(
    db: DB,
    scenarioId: string,
    stationId: string | null,
    start: number,
    end: number,
    step: number,
  ) {
    const scenario = getScenario(db, scenarioId);
    const orbitRow = getOrbitByScenario(db, scenarioId);
    const c = constantsOf(scenario);
    const station = stationId
      ? stationOf(getStation(db, scenarioId, stationId))
      : null;
    return {
      scenarioId,
      stationId,
      samples: sampleTrack(
        epochOf(orbitRow),
        spinOf(scenario),
        station,
        c,
        start,
        end,
        step,
      ),
    };
  },

  windows(
    db: DB,
    scenarioId: string,
    stationId: string,
    opts: { start: number; end: number; maxStep: number; rootTol?: number },
    idempotencyKey?: string,
  ) {
    const scenario = getScenario(db, scenarioId);
    const orbitRow = getOrbitByScenario(db, scenarioId);
    const station = stationOf(getStation(db, scenarioId, stationId));
    const c = constantsOf(scenario);
    const params = { scenarioId, stationId, ...opts };
    const reportId = generateId('rpt', db.now);
    const { result, reused } = saveReportIdempotent(
      db,
      {
        id: reportId,
        scenarioId,
        stationId,
        kind: 'visibility_windows',
        params,
        idempotencyKey,
      },
      () =>
        computeWindows(
          epochOf(orbitRow),
          spinOf(scenario),
          station,
          c,
          {
            start: opts.start,
            end: opts.end,
            maxStep: opts.maxStep,
            rootTol: opts.rootTol ?? 1e-3,
          },
        ),
    );
    return { reportId: reused ? '(reused)' : reportId, reused, report: result };
  },

  /**
   * Compare two elevation gates over the same interval. Uses a temporary gate
   * copy (the stored station gate is immutable here) and reports window counts.
   */
  compareGates(
    db: DB,
    scenarioId: string,
    stationId: string,
    gates: number[],
    opts: { start: number; end: number; maxStep: number },
  ) {
    if (!Array.isArray(gates) || gates.length < 1 || gates.length > 10) {
      fail('VALIDATION', 'gates must be an array of 1..10 elevations in degrees.');
    }
    gates.forEach((g) => {
      if (!Number.isFinite(g) || g < -90 || g > 90)
        fail('VALIDATION', 'each gate must be in [-90, 90] degrees.', { g });
    });
    const scenario = getScenario(db, scenarioId);
    const orbitRow = getOrbitByScenario(db, scenarioId);
    const baseStation = stationOf(getStation(db, scenarioId, stationId));
    const c = constantsOf(scenario);
    return gates.map((gate) => {
      const station = { ...baseStation, minElevDeg: gate };
      const report = computeWindows(
        epochOf(orbitRow),
        spinOf(scenario),
        station,
        c,
        opts,
      );
      return {
        gateDeg: gate,
        windowCount: report.windows.length,
        totalVisibleS: report.windows.reduce(
          (sum, w) =>
            sum +
            (w.enter === null || w.exit === null
              ? 0
              : w.exit - w.enter),
          0,
        ),
        windows: report.windows,
        warnings: report.warnings,
      };
    });
  },

  listReports: (db: DB, scenarioId: string, limit: unknown, offset: unknown) =>
    dbListReports(db, scenarioId, limit, offset),
};
