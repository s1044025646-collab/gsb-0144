import type { DB } from '../db/database.ts';
import { constantsOf, getScenario } from '../db/database.ts';
import type { ModelConstants } from '../core/constants.ts';
import { validateElements, type OrbitalElements } from '../core/orbit.ts';
import { AppError } from './errors.ts';

export interface OrbitInput {
  semiMajorAxis: number;
  eccentricity: number;
  inclinationRad: number;
  raanRad: number;
  argPerigeeRad: number;
  meanAnomalyAtEpochRad: number;
  epochSeconds: number;
}

export interface StationInput {
  name: string;
  latitudeRad: number;
  longitudeRad: number;
  altitudeM: number;
  minElevationRad: number;
}

export function toElements(row: Record<string, unknown>): OrbitalElements {
  return {
    semiMajorAxis: row.semi_major_axis as number,
    eccentricity: row.eccentricity as number,
    inclination: row.inclination as number,
    raan: row.raan as number,
    argPerigee: row.arg_perigee as number,
    meanAnomalyAtEpoch: row.mean_anomaly_at_epoch as number,
    epochSeconds: row.epoch_seconds as number,
  };
}

export function requireScenarioConstants(db: DB, scenarioId: number): ModelConstants {
  const row = getScenario(db, scenarioId);
  if (!row) throw new AppError('NOT_FOUND', `scenario ${scenarioId} not found`);
  return constantsOf(row);
}

/**
 * Insert an orbit as a new immutable versioned row. Changing elements always
 * produces a fresh record (and thus a fresh scenario/report lineage) rather
 * than mutating history in place.
 */
export function insertOrbit(
  db: DB,
  scenarioId: number,
  input: Partial<OrbitInput>,
  now: number,
): { id: number; elements: OrbitalElements } {
  const c = requireScenarioConstants(db, scenarioId);
  const required: (keyof OrbitInput)[] = [
    'semiMajorAxis',
    'eccentricity',
    'inclinationRad',
    'raanRad',
    'argPerigeeRad',
    'meanAnomalyAtEpochRad',
    'epochSeconds',
  ];
  const missing = required.filter((k) => typeof input[k] !== 'number' || !Number.isFinite(input[k] as number));
  if (missing.length) {
    throw new AppError('VALIDATION', `missing or non-numeric fields: ${missing.join(', ')}`);
  }
  const elements: OrbitalElements = {
    semiMajorAxis: input.semiMajorAxis as number,
    eccentricity: input.eccentricity as number,
    inclination: input.inclinationRad as number,
    raan: input.raanRad as number,
    argPerigee: input.argPerigeeRad as number,
    meanAnomalyAtEpoch: input.meanAnomalyAtEpochRad as number,
    epochSeconds: input.epochSeconds as number,
  };
  const v = validateElements(elements, c);
  if (!v.ok) throw new AppError('UNSUPPORTED_ORBIT', v.errors.join('; '), v.errors);

  const versionRow = db
    .prepare('SELECT COALESCE(MAX(version),0)+1 AS v FROM orbit WHERE scenario_id=?')
    .get(scenarioId) as { v: number };

  const res = db
    .prepare(
      `INSERT INTO orbit(scenario_id, version, created_at_seconds, semi_major_axis, eccentricity,
         inclination, raan, arg_perigee, mean_anomaly_at_epoch, epoch_seconds)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      scenarioId,
      versionRow.v,
      now,
      elements.semiMajorAxis,
      elements.eccentricity,
      elements.inclination,
      elements.raan,
      elements.argPerigee,
      elements.meanAnomalyAtEpoch,
      elements.epochSeconds,
    );
  return { id: Number(res.lastInsertRowid), elements };
}

export function getOrbit(db: DB, id: number): { id: number; scenarioId: number; elements: OrbitalElements } {
  const row = db.prepare('SELECT * FROM orbit WHERE id=?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new AppError('NOT_FOUND', `orbit ${id} not found`);
  return {
    id: row.id as number,
    scenarioId: row.scenario_id as number,
    elements: toElements(row),
  };
}

export function listOrbits(db: DB, scenarioId: number, limit: number, offset: number) {
  const rows = db
    .prepare('SELECT * FROM orbit WHERE scenario_id=? ORDER BY id LIMIT ? OFFSET ?')
    .all(scenarioId, limit, offset) as Record<string, unknown>[];
  const total = (
    db.prepare('SELECT COUNT(*) AS n FROM orbit WHERE scenario_id=?').get(scenarioId) as { n: number }
  ).n;
  return { total, items: rows };
}

export function insertStation(db: DB, scenarioId: number, input: Partial<StationInput>, now: number): number {
  requireScenarioConstants(db, scenarioId);
  const s = sanitizeStation(input);
  try {
    const res = db
      .prepare(
        `INSERT INTO station(scenario_id, name, created_at_seconds, latitude_rad, longitude_rad,
           altitude_m, min_elevation_rad) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        scenarioId,
        s.name,
        now,
        s.latitudeRad,
        s.longitudeRad,
        s.altitudeM,
        s.minElevationRad,
      );
    return Number(res.lastInsertRowid);
  } catch (err) {
    throw mapSqlite(err, `station '${s.name}' already exists in this scenario`);
  }
}

export function sanitizeStation(input: Partial<StationInput>): StationInput {
  const errors: string[] = [];
  const name = (input.name ?? '').toString().trim();
  if (!name) errors.push('name is required');
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  for (const [k, label] of [
    ['latitudeRad', 'latitudeRad'],
    ['longitudeRad', 'longitudeRad'],
    ['altitudeM', 'altitudeM'],
    ['minElevationRad', 'minElevationRad'],
  ] as const) {
    if (!num(input[k])) errors.push(`${label} must be a finite number`);
  }
  if (errors.length) throw new AppError('VALIDATION', errors.join('; '));
  const lat = input.latitudeRad as number;
  const el = input.minElevationRad as number;
  if (lat < -Math.PI / 2 || lat > Math.PI / 2)
    errors.push('latitudeRad must be within [-π/2, π/2]');
  if (el < -Math.PI / 2 || el > Math.PI / 2)
    errors.push('minElevationRad must be within [-π/2, π/2]');
  if ((input.altitudeM as number) < 0) errors.push('altitudeM must be >= 0');
  if (errors.length) throw new AppError('VALIDATION', errors.join('; '));
  return {
    name,
    latitudeRad: lat,
    longitudeRad: input.longitudeRad as number,
    altitudeM: input.altitudeM as number,
    minElevationRad: el,
  };
}

export function getStation(db: DB, id: number) {
  const row = db.prepare('SELECT * FROM station WHERE id=?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new AppError('NOT_FOUND', `station ${id} not found`);
  return {
    id: row.id as number,
    scenarioId: row.scenario_id as number,
    station: {
      name: row.name as string,
      latitudeRad: row.latitude_rad as number,
      longitudeRad: row.longitude_rad as number,
      altitudeM: row.altitude_m as number,
      minElevationRad: row.min_elevation_rad as number,
    },
  };
}

export function listStations(db: DB, scenarioId: number, limit: number, offset: number) {
  const rows = db
    .prepare('SELECT * FROM station WHERE scenario_id=? ORDER BY id LIMIT ? OFFSET ?')
    .all(scenarioId, limit, offset) as Record<string, unknown>[];
  const total = (
    db.prepare('SELECT COUNT(*) AS n FROM station WHERE scenario_id=?').get(scenarioId) as { n: number }
  ).n;
  return { total, items: rows };
}

/**
 * Persist a report. Idempotent on (scenarioId, clientRequestId): a repeated
 * submission returns the stored report instead of inserting a duplicate.
 */
export function saveReport(
  db: DB,
  params: {
    scenarioId: number;
    orbitId: number;
    stationId: number;
    fromSeconds: number;
    toSeconds: number;
    stepSeconds: number;
    minElevationRad: number;
    clientRequestId?: string;
    payloadJson: string;
  },
  now: number,
): { id: number; created: boolean } {
  if (params.clientRequestId) {
    const existing = db
      .prepare('SELECT id FROM report WHERE scenario_id=? AND client_request_id=?')
      .get(params.scenarioId, params.clientRequestId) as { id: number } | undefined;
    if (existing) return { id: existing.id, created: false };
  }
  try {
    const res = db
      .prepare(
        `INSERT INTO report(scenario_id, orbit_id, station_id, created_at_seconds, client_request_id,
           from_seconds, to_seconds, step_seconds, min_elevation_rad, payload_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        params.scenarioId,
        params.orbitId,
        params.stationId,
        now,
        params.clientRequestId ?? null,
        params.fromSeconds,
        params.toSeconds,
        params.stepSeconds,
        params.minElevationRad,
        params.payloadJson,
      );
    return { id: Number(res.lastInsertRowid), created: true };
  } catch (err) {
    if (params.clientRequestId) {
      const existing = db
        .prepare('SELECT id FROM report WHERE scenario_id=? AND client_request_id=?')
        .get(params.scenarioId, params.clientRequestId) as { id: number } | undefined;
      if (existing) return { id: existing.id, created: false };
    }
    throw mapSqlite(err, 'could not persist report');
  }
}

export function listReports(db: DB, scenarioId: number, limit: number, offset: number) {
  const rows = db
    .prepare('SELECT id, scenario_id, orbit_id, station_id, created_at_seconds, from_seconds, to_seconds, client_request_id FROM report WHERE scenario_id=? ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(scenarioId, limit, offset) as Record<string, unknown>[];
  const total = (
    db.prepare('SELECT COUNT(*) AS n FROM report WHERE scenario_id=?').get(scenarioId) as { n: number }
  ).n;
  return { total, items: rows };
}

export function getReport(db: DB, id: number) {
  const row = db.prepare('SELECT * FROM report WHERE id=?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new AppError('NOT_FOUND', `report ${id} not found`);
  return row;
}

function mapSqlite(err: unknown, conflictMessage: string): Error {
  const code = (err as { code?: string }).code;
  const errstr = (err as { errstr?: string }).errstr ?? '';
  const message = (err as Error).message ?? '';
  const isConstraint =
    (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) ||
    /constraint failed/i.test(errstr) ||
    /UNIQUE constraint failed/i.test(message);
  if (isConstraint) {
    return new AppError('CONFLICT', conflictMessage);
  }
  return new AppError('PERSISTENCE', (err as Error).message);
}
