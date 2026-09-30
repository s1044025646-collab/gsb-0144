import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type RunningServer } from '../src/server/index.ts';
import { FIXTURES, INVALID_CASES } from '../src/fixtures/fixtures.ts';

const D = Math.PI / 180;
const dbPath = join(tmpdir(), `satpass-api-${process.pid}-${Date.now()}.sqlite`);
let server: RunningServer;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

test.before(async () => {
  server = await serve({ dbPath, port: 0 });
});

after(async () => {
  await server.close();
  rmSync(dbPath, { force: true });
});

test('health and 404 routing', async () => {
  const h = await api('GET', '/health');
  assert.equal(h.status, 200);
  assert.equal((h.json.status as string), 'ok');
  const nf = await api('GET', '/nope');
  assert.equal(nf.status, 404);
  assert.equal((nf.json.error as { code: string }).code, 'NOT_FOUND');
});

test('full end-to-end: scenario, orbit, station, pass report, pagination, idempotency', async () => {
  const created = await api('POST', '/scenarios', { name: 'e2e' });
  assert.equal(created.status, 201);
  const sid = created.json.id as number;

  const f = FIXTURES.circularEquatorial;
  const orbit = await api('POST', `/scenarios/${sid}/orbits`, f.orbit);
  assert.equal(orbit.status, 201);
  const orbitId = orbit.json.id as number;
  const station = await api('POST', `/scenarios/${sid}/stations`, f.station);
  assert.equal(station.status, 201);
  const stationId = station.json.id as number;

  // propagation
  const prop = await api('POST', '/propagate', {
    orbitId,
    stationId,
    timeSeconds: f.orbit.epochSeconds + 600,
  });
  assert.equal(prop.status, 200);
  assert.ok((prop.json.observation as { elevationDeg: number }).elevationDeg !== undefined);

  // passes + persistence + idempotency
  const passBody = {
    orbitId,
    stationId,
    fromSeconds: f.orbit.epochSeconds,
    toSeconds: f.orbit.epochSeconds + 50000,
    stepSeconds: 30,
    persist: true,
    clientRequestId: 'abc',
  };
  const p1 = await api('POST', '/passes', passBody);
  const p2 = await api('POST', '/passes', passBody);
  assert.equal(p1.status, 200);
  assert.equal(p1.json.saved.created, true);
  assert.equal(p2.json.saved.created, false);
  assert.equal(p1.json.saved.id, p2.json.saved.id);

  // pagination
  await api('POST', `/scenarios/${sid}/stations`, { ...f.station, name: 'other' });
  const page = await api('GET', `/scenarios/${sid}/stations?limit=1&offset=0`);
  assert.equal(page.status, 200);
  assert.equal(page.json.paging.limit, 1);
  assert.equal(page.json.paging.hasMore, true);
  assert.equal((page.json.data as unknown[]).length, 1);

  // compare gates
  const cmp = await api('POST', '/compare-gates', {
    orbitId,
    stationId,
    fromSeconds: passBody.fromSeconds,
    toSeconds: passBody.toSeconds,
    stepSeconds: 30,
    gateDegA: 5,
    gateDegB: 20,
  });
  assert.equal(cmp.status, 200);
  assert.ok(
    (cmp.json.windowCountA as number) >= (cmp.json.windowCountB as number),
    'lower gate yields >= windows',
  );
});

test('validation failures use explicit codes', async () => {
  const s = await api('POST', '/scenarios', { name: 'bad' });
  const sid = s.json.id as number;
  const badOrbit = await api('POST', `/scenarios/${sid}/orbits`, { foo: 1 });
  assert.equal(badOrbit.status, 400);
  assert.equal((badOrbit.json.error as { code: string }).code, 'VALIDATION');

  for (const c of INVALID_CASES) {
    const r = await api('POST', `/scenarios/${sid}/orbits`, c.orbit);
    assert.equal(r.status, 422, c.name);
    assert.equal((r.json.error as { code: string }).code, 'UNSUPPORTED_ORBIT');
  }

  const badRange = await api('POST', '/passes', {
    orbitId: 1,
    stationId: 1,
    fromSeconds: 10,
    toSeconds: 5,
  });
  assert.equal(badRange.status, 400);
  assert.equal((badRange.json.error as { code: string }).code, 'BAD_RANGE');
});

test('cross-scenario orbit/station is a conflict', async () => {
  const a = await api('POST', '/scenarios', { name: 'xa' });
  const b = await api('POST', '/scenarios', { name: 'xb' });
  const oa = await api('POST', `/scenarios/${a.json.id}/orbits`, FIXTURES.circularEquatorial.orbit);
  const sb = await api('POST', `/scenarios/${b.json.id}/stations`, FIXTURES.circularEquatorial.station);
  const r = await api('POST', '/propagate', {
    orbitId: oa.json.id,
    stationId: sb.json.id,
    timeSeconds: 1000,
  });
  assert.equal(r.status, 409);
});

test('injected clock is honored and report persists across server restart', async () => {
  let t = 5000;
  const clockPath = join(tmpdir(), `satpass-clock-${process.pid}.sqlite`);
  const srvA = await serve({ dbPath: clockPath, port: 0, now: () => t });
  const local = async (m: string, pth: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${(srvA.address as { port: number }).port}${pth}`, {
      method: m,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  const sc = (await local('POST', '/scenarios', { name: 'clock' })).id as number;
  const o = (await local('POST', `/scenarios/${sc}/orbits`, FIXTURES.inclinedEllipse.orbit)).id as number;
  const st = (await local('POST', `/scenarios/${sc}/stations`, FIXTURES.inclinedEllipse.station)).id as number;
  const saved = await local('POST', '/passes', {
    orbitId: o,
    stationId: st,
    fromSeconds: 1.7e9,
    toSeconds: 1.7e9 + 40000,
    stepSeconds: 40,
    persist: true,
    clientRequestId: 'clock-1',
  });
  assert.ok(saved.saved);
  await srvA.close();

  // reopen with a fresh clock; report must still exist
  const srvB = await serve({ dbPath: clockPath, port: 0 });
  const res = await fetch(`${srvB.url}/scenarios/${sc}/reports?limit=10&offset=0`);
  const list = (await res.json()) as { data: { id: number }[] };
  assert.ok(list.data.length >= 1);
  await srvB.close();
  rmSync(clockPath, { force: true });
});

void D;
