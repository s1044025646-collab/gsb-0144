import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONSTANTS } from '../core/constants.ts';
import { MIGRATION_STATEMENTS, MIGRATION_VERSION } from './schema.ts';

export type DB = DatabaseSync;

/**
 * Open (creating the file/folder if needed) and apply idempotent migrations.
 * Safe to call repeatedly against the same database.
 */
export function openDatabase(filePath: string, now: () => number = () => Date.now() / 1000): DB {
  const dir = dirname(filePath);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec('PRAGMA foreign_keys = ON');
  // node:sqlite runs each exec implicitly; wrap all DDL in one transaction.
  db.exec('BEGIN');
  try {
    for (const stmt of MIGRATION_STATEMENTS) db.exec(stmt);
    db.prepare(
      `INSERT INTO schema_meta(key,value) VALUES('migration_version',?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(MIGRATION_VERSION);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface ScenarioRow {
  id: number;
  name: string;
  created_at_seconds: number;
  mu: number;
  earth_radius: number;
  omega_earth: number;
  theta_at_epoch: number;
}

export function createScenario(
  db: DB,
  name: string,
  now: number,
  constants = DEFAULT_CONSTANTS,
): number {
  const stmt = db.prepare(
    `INSERT INTO scenario(name, created_at_seconds, mu, earth_radius, omega_earth, theta_at_epoch)
     VALUES (?,?,?,?,?,?)`,
  );
  const res = stmt.run(
    name,
    now,
    constants.mu,
    constants.earthRadius,
    constants.omegaEarth,
    constants.thetaAtEpoch,
  );
  return Number(res.lastInsertRowid);
}

export function getScenario(db: DB, id: number): ScenarioRow | undefined {
  return db.prepare('SELECT * FROM scenario WHERE id=?').get(id) as ScenarioRow | undefined;
}

export function constantsOf(row: ScenarioRow) {
  return Object.freeze({
    mu: row.mu,
    earthRadius: row.earth_radius,
    omegaEarth: row.omega_earth,
    thetaAtEpoch: row.theta_at_epoch,
  });
}
