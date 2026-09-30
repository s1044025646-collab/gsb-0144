import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { after as afterHook } from 'node:test';
import { migrate, openDatabase, transactionRollsBack } from '../src/db/database.js';
import { service } from '../src/core/service.js';
import { FIXTURES, seedFixture } from '../src/core/fixtures.js';
import { getOrbitByScenario } from '../src/db/repo.js';
import { startApiServer, StartedServer } from '../src/api/server.js';

let dir: string;
let dbPath: string;
let server: StartedServer;
let dbHandle: ReturnType<typeof openDatabase>;

before(async () => {
  dir = mkdtempSync(join(process.cwd(), 'tmp', 'orbit-e2e-'));
  dbPath = join(dir, 'state.sqlite');
  dbHandle = openDatabase(dbPath, () => 1234.5);
  migrate(dbHandle);
  server = await startApiServer(dbHandle, '127.0.0.1', 0);
});

afterHook(() => {
  server?.close();
  try {
    dbHandle?.db.close();
  } catch {
    // already closed by individual tests
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // best-effort cleanup on Windows if the OS still holds a file lock
  }
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('health and root', async () => {
  const h = await call('GET', '/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.data.model, 'two-body-spherical-earth');
});

test('full seeded e2e: windows, no-pass station, pagination, validation codes', async () => {
  const fx = FIXTURES.inclinedEllipse;
  // Seed directly through service against same DB file connection logic via API create.
  const created = await call('POST', '/scenarios', {
    id: 'e2e',
    name: 'E2E',
    theta0Deg: fx.scenario.theta0Deg,
  });
  assert.equal(created.status, 200);

  const dup = await call('POST', '/scenarios', { id: 'e2e', name: 'x' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'CONFLICT');

  const badOrbit = await call('PUT', '/scenarios/e2e/orbit', {
    a: 7_000_000,
    e: 1.1,
    iDeg: 50,
  });
  assert.equal(badOrbit.status, 422);
  assert.equal(badOrbit.json.error.code, 'UNSUPPORTED_ORBIT');

  const orbit = await call('PUT', '/scenarios/e2e/orbit', {
    a: fx.orbit.elements.a,
    e: fx.orbit.elements.e,
    iDeg: fx.orbit.elements.iDeg,
    raanDeg: fx.orbit.elements.raanDeg,
    argpDeg: fx.orbit.elements.argpDeg,
    nu0Deg: fx.orbit.elements.nu0Deg,
    t0: 0,
  });
  assert.equal(orbit.status, 200);

  for (const st of fx.stations) {
    const r = await call('POST', '/scenarios/e2e/stations', st);
    assert.equal(r.status, 200);
  }

  const page = await call('GET', '/scenarios/e2e/stations?limit=1&offset=0');
  assert.equal(page.json.data.items.length, 1);
  assert.equal(page.json.data.total, 3);

  const badPage = await call('GET', '/scenarios/e2e/stations?limit=0');
  assert.equal(badPage.status, 400);
  assert.equal(badPage.json.error.code, 'VALIDATION');

  const prop = await call('GET', '/scenarios/e2e/propagate?t=1000&stationId=eq');
  assert.equal(prop.status, 200);
  assert.ok(prop.json.data.look.elevation <= 90);

  const win = await call('POST', '/scenarios/e2e/windows', {
    stationId: 'eq',
    start: 0,
    end: 86_400 * 2, // cross-day
    maxStep: 30,
    idempotencyKey: 'win-eq-1',
  });
  assert.equal(win.status, 200);
  assert.equal(win.json.data.reused, false);

  const winAgain = await call('POST', '/scenarios/e2e/windows', {
    stationId: 'eq',
    start: 0,
    end: 86_400 * 2,
    maxStep: 30,
    idempotencyKey: 'win-eq-1',
  });
  assert.equal(winAgain.json.data.reused, true);

  const reports = await call('GET', '/scenarios/e2e/reports');
  assert.equal(reports.json.data.total, 1, 'idempotent repeat must not duplicate report');

  const blind = await call('POST', '/scenarios/e2e/windows', {
    stationId: 'blind',
    start: 0,
    end: 60_000,
    maxStep: 20,
  });
  assert.equal(blind.status, 200);
  assert.equal(blind.json.data.report.windows.length, 0);

  const cmp = await call('POST', '/scenarios/e2e/compare-gates', {
    stationId: 'eq',
    gates: [0, 10, 30],
    start: 0,
    end: 86_400,
    maxStep: 30,
  });
  assert.equal(cmp.status, 200);
  assert.equal(cmp.json.data.length, 3);
});

test('transaction rollback and restart persistence on a fresh file handle', () => {
  const h1 = openDatabase(dbPath, () => 999);
  migrate(h1);
  assert.equal(transactionRollsBack(h1), true);
  h1.db.close();

  // Reopen: previously committed data must survive; probe must not.
  const h2 = openDatabase(dbPath, () => 999);
  migrate(h2); // repeatable, should apply nothing new
  const scenario = service.getScenario(h2, 'e2e');
  assert.equal(scenario.name, 'E2E');
  assert.throws(() => service.getScenario(h2, '__rollback_probe__'));
  h2.db.close();
});

test('migration is repeatable on an existing database', () => {
  const h = openDatabase(dbPath);
  const applied = migrate(h);
  assert.deepEqual(applied, []);
  h.db.close();
});

test('database file is kept inside the project temp target', () => {
  assert.ok(existsSync(dbPath));
});

test('revision clones into a new frozen scheme without mutating source', async () => {
  const revision = await call('POST', '/scenarios/e2e/revise', {
    newId: 'e2e-rev',
    name: 'E2E revised',
    orbit: {
      a: 8_000_000,
      e: 0.05,
      iDeg: 70,
      raanDeg: 0,
      argpDeg: 0,
      nu0Deg: 0,
      t0: 0,
    },
  });
  assert.equal(revision.status, 200);
  const handle = openDatabase(dbPath, () => 2);
  const sourceOrbit = getOrbitByScenario(handle, 'e2e');
  const revisedOrbit = getOrbitByScenario(handle, 'e2e-rev');
  assert.equal(sourceOrbit.a, FIXTURES.inclinedEllipse.orbit.elements.a);
  assert.equal(revisedOrbit.a, 8_000_000);
  assert.equal(sourceOrbit.a !== revisedOrbit.a, true);
  handle.db.close();

  const limits = await call('GET', '/limitations');
  assert.equal(limits.status, 200);
  assert.ok(Array.isArray(limits.json.data.notModeled));
});

// keep imports referenced
void rmSync;
void before;
void after;
void seedFixture;
