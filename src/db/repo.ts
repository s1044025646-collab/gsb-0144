import { DB, inTransaction, paginate } from './database.js';
import { DomainError, fail } from '../core/errors.js';
import {
  FrozenConstants,
  MODEL_LIMITATIONS,
  freezeConstants,
} from '../core/constants.js';
import {
  EarthSpin,
  GroundStation,
  OrbitalElementsInput,
  OrbitEpoch,
  toElements,
  validateElements,
} from '../core/orbit.js';

export interface ScenarioRow {
  id: string;
  name: string;
  mu: number;
  earth_radius: number;
  earth_angular_velocity: number;
  theta0: number;
  theta_epoch: number;
  created_at: number;
}

export interface CreateScenarioInput {
  id: string;
  name: string;
  constants?: Partial<FrozenConstants>;
  theta0Deg?: number;
  thetaEpoch?: number;
}

export function createScenario(db: DB, input: CreateScenarioInput): ScenarioRow {
  validateId(input.id, 'scenario id');
  if (!input.name || typeof input.name !== 'string') {
    fail('VALIDATION', 'name is required.');
  }
  const c = freezeConstants(input.constants ?? {});
  for (const [k, v] of Object.entries(c)) {
    if (!Number.isFinite(v) || v <= 0) fail('VALIDATION', `${k} must be > 0 and finite.`);
  }
  const theta0 = ((input.theta0Deg ?? 0) * Math.PI) / 180;
  const thetaEpoch = input.thetaEpoch ?? 0;
  try {
    db.db
      .prepare(
        `INSERT INTO scenarios (id,name,mu,earth_radius,earth_angular_velocity,theta0,theta_epoch,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.name,
        c.mu,
        c.earthRadius,
        c.earthAngularVelocity,
        theta0,
        thetaEpoch,
        db.now(),
      );
  } catch (e) {
    if ((e as Error).message?.includes('UNIQUE')) {
      fail('CONFLICT', `Scenario '${input.id}' already exists.`);
    }
    throw e;
  }
  return getScenario(db, input.id);
}

export function getScenario(db: DB, id: string): ScenarioRow {
  const row = db.db.prepare('SELECT * FROM scenarios WHERE id=?').get(id) as
    | ScenarioRow
    | undefined;
  if (!row) fail('NOT_FOUND', `Scenario '${id}' not found.`);
  return row;
}

export function listScenarios(
  db: DB,
  limitRaw: unknown,
  offsetRaw: unknown,
): { items: ScenarioRow[]; total: number; limit: number; offset: number } {
  const { limit, offset } = paginate(limitRaw, offsetRaw);
  const total = (db.db.prepare('SELECT COUNT(*) n FROM scenarios').get() as { n: number }).n;
  const items = db.db
    .prepare('SELECT * FROM scenarios ORDER BY created_at,id LIMIT ? OFFSET ?')
    .all(limit, offset) as unknown as ScenarioRow[];
  return { items, total, limit, offset };
}

export function constantsOf(row: ScenarioRow): FrozenConstants {
  return freezeConstants({
    mu: row.mu,
    earthRadius: row.earth_radius,
    earthAngularVelocity: row.earth_angular_velocity,
  });
}

export function spinOf(row: ScenarioRow): EarthSpin {
  return { theta0: row.theta0, thetaEpoch: row.theta_epoch };
}

export interface OrbitRow {
  id: string;
  scenario_id: string;
  a: number;
  e: number;
  i_deg: number;
  raan_deg: number;
  argp_deg: number;
  nu0_deg: number;
  t0: number;
  created_at: number;
}

export function setOrbit(
  db: DB,
  id: string,
  scenarioId: string,
  t0: number,
  el: OrbitalElementsInput,
): OrbitRow {
  validateId(id, 'orbit id');
  const scenario = getScenario(db, scenarioId);
  const elements = toElements(el);
  validateElements(elements, constantsOf(scenario));
  if (!Number.isFinite(t0)) fail('VALIDATION', 'epoch t0 must be finite seconds.');
  inTransaction(db, () => {
    db.db.prepare('DELETE FROM orbits WHERE scenario_id=?').run(scenarioId);
    db.db
      .prepare(
        `INSERT INTO orbits (id,scenario_id,a,e,i_deg,raan_deg,argp_deg,nu0_deg,t0,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        scenarioId,
        el.a,
        el.e,
        el.iDeg,
        el.raanDeg,
        el.argpDeg,
        el.nu0Deg,
        t0,
        db.now(),
      );
  });
  return getOrbitByScenario(db, scenarioId);
}

export function getOrbitByScenario(db: DB, scenarioId: string): OrbitRow {
  const row = db.db
    .prepare('SELECT * FROM orbits WHERE scenario_id=?')
    .get(scenarioId) as OrbitRow | undefined;
  if (!row) fail('NOT_FOUND', `No orbit defined for scenario '${scenarioId}'.`);
  return row;
}

export function epochOf(row: OrbitRow): OrbitEpoch {
  return {
    t0: row.t0,
    elements: toElements({
      a: row.a,
      e: row.e,
      iDeg: row.i_deg,
      raanDeg: row.raan_deg,
      argpDeg: row.argp_deg,
      nu0Deg: row.nu0_deg,
    }),
  };
}

export interface StationInput {
  id: string;
  name: string;
  latDeg: number;
  lonDeg: number;
  altM?: number;
  minElevDeg: number;
}

export interface StationRow {
  id: string;
  scenario_id: string;
  name: string;
  lat_deg: number;
  lon_deg: number;
  alt_m: number;
  min_elev_deg: number;
  created_at: number;
}

export function addStation(db: DB, scenarioId: string, input: StationInput): StationRow {
  validateId(input.id, 'station id');
  getScenario(db, scenarioId);
  validateStation(input);
  try {
    db.db
      .prepare(
        `INSERT INTO stations (id,scenario_id,name,lat_deg,lon_deg,alt_m,min_elev_deg,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        scenarioId,
        input.name,
        input.latDeg,
        input.lonDeg,
        input.altM ?? 0,
        input.minElevDeg,
        db.now(),
      );
  } catch (e) {
    if ((e as Error).message?.includes('UNIQUE')) {
      fail('CONFLICT', `Station '${input.id}' already exists.`);
    }
    throw e;
  }
  return getStation(db, scenarioId, input.id);
}

export function validateStation(input: StationInput): void {
  if (!Number.isFinite(input.latDeg) || input.latDeg < -90 || input.latDeg > 90) {
    fail('VALIDATION', 'latDeg must be in [-90, 90].', { latDeg: input.latDeg });
  }
  if (!Number.isFinite(input.lonDeg)) {
    fail('VALIDATION', 'lonDeg must be finite.');
  }
  if (
    !Number.isFinite(input.minElevDeg) ||
    input.minElevDeg < -90 ||
    input.minElevDeg > 90
  ) {
    fail('VALIDATION', 'minElevDeg must be in [-90, 90].', {
      minElevDeg: input.minElevDeg,
    });
  }
  if (input.altM !== undefined && (!Number.isFinite(input.altM) || input.altM < 0)) {
    fail('VALIDATION', 'altM must be a finite non-negative number.');
  }
}

export function getStation(db: DB, scenarioId: string, id: string): StationRow {
  const row = db.db
    .prepare('SELECT * FROM stations WHERE scenario_id=? AND id=?')
    .get(scenarioId, id) as StationRow | undefined;
  if (!row) fail('NOT_FOUND', `Station '${id}' not found in '${scenarioId}'.`);
  return row;
}

export function stationOf(row: StationRow): GroundStation {
  return {
    id: row.id,
    latDeg: row.lat_deg,
    lonDeg: row.lon_deg,
    altM: row.alt_m,
    minElevDeg: row.min_elev_deg,
  };
}

export function listStations(
  db: DB,
  scenarioId: string,
  limitRaw: unknown,
  offsetRaw: unknown,
) {
  getScenario(db, scenarioId);
  const { limit, offset } = paginate(limitRaw, offsetRaw);
  const total = (
    db.db
      .prepare('SELECT COUNT(*) n FROM stations WHERE scenario_id=?')
      .get(scenarioId) as { n: number }
  ).n;
  const items = db.db
    .prepare(
      'SELECT * FROM stations WHERE scenario_id=? ORDER BY id LIMIT ? OFFSET ?',
    )
    .all(scenarioId, limit, offset) as unknown as StationRow[];
  return { items, total, limit, offset };
}

export interface ReportRow {
  id: string;
  scenario_id: string;
  station_id: string | null;
  kind: string;
  params_json: string;
  result_json: string;
  idempotency_key: string | null;
  created_at: number;
}

/**
 * Idempotent report insertion. A repeated submission carrying the same
 * idempotency_key returns the previously stored result instead of recomputing.
 */
export function saveReportIdempotent<T>(
  db: DB,
  report: {
    id: string;
    scenarioId: string;
    stationId?: string | null;
    kind: string;
    params: unknown;
    idempotencyKey?: string;
  },
  compute: () => T,
): { result: T; reused: boolean } {
  if (report.idempotencyKey) {
    const existing = db.db
      .prepare('SELECT * FROM reports WHERE idempotency_key=?')
      .get(report.idempotencyKey) as ReportRow | undefined;
    if (existing) {
      return { result: JSON.parse(existing.result_json) as T, reused: true };
    }
  }
  const result = compute();
  try {
    db.db
      .prepare(
        `INSERT INTO reports (id,scenario_id,station_id,kind,params_json,result_json,idempotency_key,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        report.id,
        report.scenarioId,
        report.stationId ?? null,
        report.kind,
        JSON.stringify(report.params),
        JSON.stringify(result),
        report.idempotencyKey ?? null,
        db.now(),
      );
  } catch (e) {
    if ((e as Error).message?.includes('UNIQUE')) {
      const existing = db.db
        .prepare('SELECT * FROM reports WHERE idempotency_key=?')
        .get(report.idempotencyKey as string) as unknown as ReportRow;
      return { result: JSON.parse(existing.result_json) as T, reused: true };
    }
    throw e;
  }
  return { result, reused: false };
}

export function listReports(
  db: DB,
  scenarioId: string,
  limitRaw: unknown,
  offsetRaw: unknown,
) {
  getScenario(db, scenarioId);
  const { limit, offset } = paginate(limitRaw, offsetRaw);
  const total = (
    db.db
      .prepare('SELECT COUNT(*) n FROM reports WHERE scenario_id=?')
      .get(scenarioId) as { n: number }
  ).n;
  const items = db.db
    .prepare(
      'SELECT * FROM reports WHERE scenario_id=? ORDER BY created_at,id LIMIT ? OFFSET ?',
    )
    .all(scenarioId, limit, offset) as unknown as ReportRow[];
  return { items, total, limit, offset };
}

export function modelLimitations(): readonly string[] {
  return MODEL_LIMITATIONS;
}

/**
 * Clone a scenario into a new, independently frozen scheme. Model constants and
 * spin are copied verbatim; the orbit may be replaced and stations may be
 * cloned. The source scenario is never mutated.
 */
export function cloneScenario(
  db: DB,
  sourceId: string,
  newId: string,
  newName: string,
): ScenarioRow {
  validateId(newId, 'new scenario id');
  const src = getScenario(db, sourceId);
  return createScenario(db, {
    id: newId,
    name: newName,
    constants: {
      mu: src.mu,
      earthRadius: src.earth_radius,
      earthAngularVelocity: src.earth_angular_velocity,
    },
    theta0Deg: (src.theta0 * 180) / Math.PI,
    thetaEpoch: src.theta_epoch,
  });
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}

function validateId(id: string, label: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    fail('VALIDATION', `${label} must match [A-Za-z0-9._-]{1,64}.`, { id });
  }
}

