import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail } from '../core/errors.js';

const MIGRATIONS: { id: number; name: string; statements: string[] }[] = [
  {
    id: 1,
    name: 'initial_schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS scenarios (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, mu REAL NOT NULL,
        earth_radius REAL NOT NULL, earth_angular_velocity REAL NOT NULL,
        theta0 REAL NOT NULL, theta_epoch REAL NOT NULL, created_at REAL NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS orbits (
        id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL UNIQUE REFERENCES scenarios(id) ON DELETE CASCADE,
        a REAL NOT NULL, e REAL NOT NULL, i_deg REAL NOT NULL, raan_deg REAL NOT NULL,
        argp_deg REAL NOT NULL, nu0_deg REAL NOT NULL, t0 REAL NOT NULL, created_at REAL NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS stations (
        id TEXT NOT NULL,
        scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
        name TEXT NOT NULL, lat_deg REAL NOT NULL, lon_deg REAL NOT NULL,
        alt_m REAL NOT NULL, min_elev_deg REAL NOT NULL, created_at REAL NOT NULL,
        PRIMARY KEY (scenario_id, id))`,
      `CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
        station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
        kind TEXT NOT NULL, params_json TEXT NOT NULL, result_json TEXT NOT NULL,
        idempotency_key TEXT UNIQUE, created_at REAL NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_stations_scenario ON stations(scenario_id)`,
      `CREATE INDEX IF NOT EXISTS idx_reports_scenario ON reports(scenario_id, created_at)`,
    ],
  },
  {
    id: 2,
    name: 'station_composite_key',
    statements: [
      `PRAGMA foreign_keys = OFF`,
      `CREATE TABLE reports_new (
        id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
        station_id TEXT,
        kind TEXT NOT NULL, params_json TEXT NOT NULL, result_json TEXT NOT NULL,
        idempotency_key TEXT UNIQUE, created_at REAL NOT NULL)`,
      `INSERT INTO reports_new
        SELECT id, scenario_id, station_id, kind, params_json, result_json, idempotency_key, created_at
        FROM reports`,
      `DROP TABLE reports`,
      `ALTER TABLE reports_new RENAME TO reports`,
      `CREATE INDEX IF NOT EXISTS idx_reports_scenario ON reports(scenario_id, created_at)`,
      `CREATE TABLE stations_new (
        id TEXT NOT NULL,
        scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
        name TEXT NOT NULL, lat_deg REAL NOT NULL, lon_deg REAL NOT NULL,
        alt_m REAL NOT NULL, min_elev_deg REAL NOT NULL, created_at REAL NOT NULL,
        PRIMARY KEY (scenario_id, id))`,
      `INSERT INTO stations_new
        SELECT id, scenario_id, name, lat_deg, lon_deg, alt_m, min_elev_deg, created_at
        FROM stations`,
      `DROP TABLE stations`,
      `ALTER TABLE stations_new RENAME TO stations`,
      `CREATE INDEX IF NOT EXISTS idx_stations_scenario ON stations(scenario_id)`,
      `PRAGMA foreign_keys = ON`,
    ],
  },
];

export function openDatabase(
  path: string,
  now: () => number = () => Date.now() / 1000,
) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  return { db, now };
}

export type DB = ReturnType<typeof openDatabase>;

/** Repeatable: each migration runs once and is recorded; re-running is a no-op. */
export function migrate(db: DB): number[] {
  const applied: number[] = [];
  db.db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at REAL NOT NULL)`,
  );
  const existing = new Set(
    (db.db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map(
      (r) => r.id,
    ),
  );
  for (const m of MIGRATIONS) {
    if (existing.has(m.id)) continue;
    db.db.exec('BEGIN');
    try {
      for (const statement of m.statements) db.db.exec(statement);
      db.db
        .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run(m.id, m.name, db.now());
      db.db.exec('COMMIT');
    } catch (e) {
      db.db.exec('ROLLBACK');
      throw e;
    }
    applied.push(m.id);
  }
  return applied;
}

export function inTransaction<T>(db: DB, fn: () => T): T {
  db.db.exec('BEGIN');
  try {
    const result = fn();
    db.db.exec('COMMIT');
    return result;
  } catch (e) {
    db.db.exec('ROLLBACK');
    throw e;
  }
}

export function transactionRollsBack(db: DB): boolean {
  const before = (
    db.db.prepare('SELECT COUNT(*) AS n FROM scenarios').get() as { n: number }
  ).n;
  try {
    inTransaction(db, () => {
      db.db
        .prepare(
          `INSERT INTO scenarios (id,name,mu,earth_radius,earth_angular_velocity,theta0,theta_epoch,created_at)
           VALUES ('__rollback_probe__','x',1,1,1,0,0,0)`,
        )
        .run();
      throw new Error('forced rollback');
    });
  } catch {
    // expected
  }
  const after = (
    db.db.prepare('SELECT COUNT(*) AS n FROM scenarios').get() as { n: number }
  ).n;
  return before === after;
}

export interface Page {
  limit: number;
  offset: number;
}

export function paginate(
  limitRaw: unknown,
  offsetRaw: unknown,
  maxLimit = 200,
): Page {
  const limit = Number(limitRaw ?? 50);
  const offset = Number(offsetRaw ?? 0);
  if (!Number.isInteger(limit) || limit <= 0 || limit > maxLimit) {
    fail('VALIDATION', `limit must be an integer in [1, ${maxLimit}].`, { limitRaw });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    fail('VALIDATION', 'offset must be a non-negative integer.', { offsetRaw });
  }
  return { limit, offset };
}
