/**
 * Idempotent schema migration. Running it repeatedly must not error or
 * duplicate structure. Model constants are snapshotted per scenario so a
 * scenario stays reproducible even if the global defaults ever change.
 */
export const MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS scenario (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE,
     created_at_seconds REAL NOT NULL,
     mu REAL NOT NULL,
     earth_radius REAL NOT NULL,
     omega_earth REAL NOT NULL,
     theta_at_epoch REAL NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS orbit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     scenario_id INTEGER NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
     version INTEGER NOT NULL DEFAULT 1,
     created_at_seconds REAL NOT NULL,
     semi_major_axis REAL NOT NULL,
     eccentricity REAL NOT NULL,
     inclination REAL NOT NULL,
     raan REAL NOT NULL,
     arg_perigee REAL NOT NULL,
     mean_anomaly_at_epoch REAL NOT NULL,
     epoch_seconds REAL NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS station (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     scenario_id INTEGER NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     created_at_seconds REAL NOT NULL,
     latitude_rad REAL NOT NULL,
     longitude_rad REAL NOT NULL,
     altitude_m REAL NOT NULL,
     min_elevation_rad REAL NOT NULL,
     UNIQUE(scenario_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS report (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     scenario_id INTEGER NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
     orbit_id INTEGER NOT NULL REFERENCES orbit(id) ON DELETE CASCADE,
     station_id INTEGER NOT NULL REFERENCES station(id) ON DELETE CASCADE,
     created_at_seconds REAL NOT NULL,
     client_request_id TEXT,
     from_seconds REAL NOT NULL,
     to_seconds REAL NOT NULL,
     step_seconds REAL NOT NULL,
     min_elevation_rad REAL NOT NULL,
     payload_json TEXT NOT NULL,
     UNIQUE(scenario_id, client_request_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_report_scenario ON report(scenario_id, created_at_seconds)`,
] as const;

export const MIGRATION_VERSION = '1';
