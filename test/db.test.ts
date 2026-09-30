import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate, createScenario } from '../src/db/database.ts';
import { insertOrbit, insertStation, saveReport, getOrbit } from '../src/api/repo.ts';
import { AppError } from '../src/api/errors.ts';
import { FIXTURES } from '../src/fixtures/fixtures.ts';

const dbPath = join(tmpdir(), `satpass-db-${process.pid}-${Date.now()}.sqlite`);
let db = openDatabase(dbPath);

after(() => {
  db.close();
  rmSync(dbPath, { force: true });
});

test('migration is idempotent across repeat calls', () => {
  assert.doesNotThrow(() => migrate(db));
  assert.doesNotThrow(() => migrate(db));
});

test('scenario + orbit + station persist and read back', () => {
  const sid = createScenario(db, 's1', 1000);
  const f = FIXTURES.inclinedEllipse;
  const oid = insertOrbit(db, sid, f.orbit as never, 1000).id;
  const stid = insertStation(db, sid, f.station, 1000);
  const o = getOrbit(db, oid);
  assert.equal(o.scenarioId, sid);
  assert.ok(Math.abs(o.elements.semiMajorAxis - f.orbit.semiMajorAxis) < 1e-9);
  assert.ok(stid > 0);
});

test('invalid orbit insert rolls back and leaves no partial row', () => {
  const sid = createScenario(db, 'rollback', 1000);
  const before = (db.prepare('SELECT COUNT(*) n FROM orbit WHERE scenario_id=?').get(sid) as { n: number }).n;
  assert.throws(
    () => insertOrbit(db, sid, { ...FIXTURES.circularEquatorial.orbit, eccentricity: 1.5 } as never, 1000),
    AppError,
  );
  const after = (db.prepare('SELECT COUNT(*) n FROM orbit WHERE scenario_id=?').get(sid) as { n: number }).n;
  assert.equal(before, after);
  assert.equal(after, 0);
});

test('duplicate station name conflicts', () => {
  const sid = createScenario(db, 'dup', 1000);
  insertStation(db, sid, FIXTURES.circularEquatorial.station, 1000);
  assert.throws(
    () => insertStation(db, sid, FIXTURES.circularEquatorial.station, 1000),
    (e: AppError) => e.code === 'CONFLICT',
  );
});

test('report save is idempotent on clientRequestId', () => {
  const sid = createScenario(db, 'idem', 1000);
  const oid = insertOrbit(db, sid, FIXTURES.circularEquatorial.orbit as never, 1000).id;
  const stid = insertStation(db, sid, FIXTURES.circularEquatorial.station, 1000);
  const params = {
    scenarioId: sid,
    orbitId: oid,
    stationId: stid,
    fromSeconds: 0,
    toSeconds: 1000,
    stepSeconds: 30,
    minElevationRad: 0.1,
    clientRequestId: 'req-123',
    payloadJson: '{"a":1}',
  };
  const first = saveReport(db, params, 1000);
  const second = saveReport(db, { ...params, payloadJson: '{"a":2}' }, 2000);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.id, second.id);
});

test('state survives a full close/reopen cycle', () => {
  db.close();
  db = openDatabase(dbPath);
  const row = db.prepare("SELECT COUNT(*) n FROM scenario WHERE name='s1'").get() as { n: number };
  assert.equal(row.n, 1);
  const meta = db.prepare("SELECT value FROM schema_meta WHERE key='migration_version'").get() as
    | { value: string }
    | undefined;
  assert.ok(meta);
});

test('changing elements creates a new versioned orbit, not an in-place mutation', () => {
  const sid = createScenario(db, 'versioned', 1000);
  const a = insertOrbit(db, sid, FIXTURES.circularEquatorial.orbit as never, 1000);
  const b = insertOrbit(
    db,
    sid,
    { ...FIXTURES.circularEquatorial.orbit, semiMajorAxis: 7_100_000 } as never,
    2000,
  );
  assert.notEqual(a.id, b.id);
  const rows = db.prepare('SELECT version FROM orbit WHERE id IN (?,?) ORDER BY id').all(a.id, b.id) as {
    version: number;
  }[];
  assert.deepEqual(rows.map((r) => r.version), [1, 2]);
});
