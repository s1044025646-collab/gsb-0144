import type { DB } from '../db/database.ts';
import { MAX_SCAN_STEP_S } from '../core/constants.ts';
import { findPasses, sampleTrack } from '../core/passes.ts';
import { propagateInertial } from '../core/orbit.ts';
import { observe } from '../core/station.ts';
import { AppError } from './errors.ts';
import {
  getOrbit,
  getStation,
  requireScenarioConstants,
  saveReport,
  type OrbitInput,
  type StationInput,
} from './repo.ts';

export interface PropagateQuery {
  orbitId: number;
  stationId?: number;
  timeSeconds: number;
}

export function propagate(db: DB, q: PropagateQuery) {
  const { elements, scenarioId } = getOrbit(db, q.orbitId);
  const c = requireScenarioConstants(db, scenarioId);
  if (!Number.isFinite(q.timeSeconds))
    throw new AppError('VALIDATION', 'timeSeconds must be a finite number (unix seconds)');
  if (q.stationId !== undefined) {
    const st = getStation(db, q.stationId);
    if (st.scenarioId !== scenarioId)
      throw new AppError('CONFLICT', 'orbit and station belong to different scenarios');
    return { kind: 'observation', observation: observe(elements, st.station, q.timeSeconds, c) };
  }
  const state = propagateInertial(elements, q.timeSeconds, c);
  return { kind: 'state', state };
}

export interface TrackQuery {
  orbitId: number;
  stationId: number;
  fromSeconds: number;
  toSeconds: number;
  count: number;
}

export function track(db: DB, q: TrackQuery) {
  const { elements, scenarioId } = getOrbit(db, q.orbitId);
  const c = requireScenarioConstants(db, scenarioId);
  const st = getStation(db, q.stationId);
  if (st.scenarioId !== scenarioId)
    throw new AppError('CONFLICT', 'orbit and station belong to different scenarios');
  if (!(q.toSeconds > q.fromSeconds)) throw new AppError('BAD_RANGE', 'toSeconds must exceed fromSeconds');
  if (!Number.isInteger(q.count) || q.count < 2 || q.count > 5000)
    throw new AppError('VALIDATION', 'count must be an integer in [2,5000]');
  return { samples: sampleTrack(elements, st.station, q.fromSeconds, q.toSeconds, q.count, c) };
}

export interface PassQuery {
  orbitId: number;
  stationId: number;
  fromSeconds: number;
  toSeconds: number;
  stepSeconds?: number;
  minElevationDeg?: number;
  clientRequestId?: string;
  persist?: boolean;
}

export function passes(db: DB, q: PassQuery, now: number) {
  const { id: orbitDbId, elements, scenarioId } = getOrbit(db, q.orbitId);
  const c = requireScenarioConstants(db, scenarioId);
  const { id: stationDbId, station } = getStation(db, q.stationId);
  if (!Number.isFinite(q.fromSeconds) || !Number.isFinite(q.toSeconds) || q.toSeconds <= q.fromSeconds)
    throw new AppError('BAD_RANGE', 'require finite fromSeconds < toSeconds');
  if (q.stepSeconds !== undefined && (q.stepSeconds <= 0 || q.stepSeconds > MAX_SCAN_STEP_S))
    throw new AppError('VALIDATION', `stepSeconds must be in (0, ${MAX_SCAN_STEP_S}]`);

  const gate =
    q.minElevationDeg === undefined
      ? undefined
      : (q.minElevationDeg * Math.PI) / 180;
  const report = findPasses(elements, station, {
    fromSeconds: q.fromSeconds,
    toSeconds: q.toSeconds,
    stepSeconds: q.stepSeconds,
    minElevationRad: gate,
    model: c,
  });

  let saved: { id: number; created: boolean } | undefined;
  if (q.persist) {
    saved = saveReport(
      db,
      {
        scenarioId,
        orbitId: orbitDbId,
        stationId: stationDbId,
        fromSeconds: q.fromSeconds,
        toSeconds: q.toSeconds,
        stepSeconds: report.stepSeconds,
        minElevationRad: gate ?? station.minElevationRad,
        clientRequestId: q.clientRequestId,
        payloadJson: JSON.stringify(report),
      },
      now,
    );
  }
  return { report, saved };
}

/** Compare visibility at two elevation gates; returns counts and the diff. */
export function compareGates(
  db: DB,
  q: Omit<PassQuery, 'minElevationDeg' | 'persist'> & { gateDegA: number; gateDegB: number },
) {
  const a = passes(db, { ...q, minElevationDeg: q.gateDegA, persist: false }, 0).report;
  const b = passes(db, { ...q, minElevationDeg: q.gateDegB, persist: false }, 0).report;
  return {
    gateDegA: q.gateDegA,
    gateDegB: q.gateDegB,
    windowCountA: a.windows.length,
    windowCountB: b.windows.length,
    reportA: a,
    reportB: b,
  };
}

export type { OrbitInput, StationInput };
