/**
 * Repeatable end-to-end demo against an isolated database in ./data/demo.
 * Uses an injected fixed clock and fixed fictional fixtures, so repeated runs
 * produce identical results. Starts an ephemeral loopback-only server.
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, createScenario } from '../src/db/database.ts';
import { insertOrbit, insertStation } from '../src/api/repo.ts';
import { passes, propagate, compareGates } from '../src/api/service.ts';
import { serve } from '../src/server/index.ts';
import { FIXTURES } from '../src/fixtures/fixtures.ts';

const dir = resolve('data/demo');
const dbPath = resolve(dir, 'demo.sqlite');
rmSync(dir, { recursive: true, force: true });

const CLOCK = 1_700_000_000;
const db = openDatabase(dbPath, () => CLOCK);

const sid = createScenario(db, 'DEMO', CLOCK);
const f = FIXTURES.inclinedEllipse;
const orbitId = insertOrbit(db, sid, f.orbit, CLOCK).id;
const stationId = insertStation(db, sid, f.station, CLOCK);
db.close();

const db2 = openDatabase(dbPath, () => CLOCK);
const from = f.orbit.epochSeconds;
const to = from + 2 * 86400;

console.log('=== DEMO (fictional two-body spherical-Earth model) ===');
console.log('scenario', sid, 'orbit', orbitId, 'station', stationId);

const obs = propagate(db2, { orbitId, stationId, timeSeconds: from + 3600 });
console.log('\n[observe @ epoch+3600s]');
console.log(JSON.stringify(obs.observation, null, 2));

const report = passes(
  db2,
  { orbitId, stationId, fromSeconds: from, toSeconds: to, stepSeconds: 40, persist: true, clientRequestId: 'demo-1' },
  CLOCK,
);
console.log('\n[passes over 2 days]');
for (const w of report.report.windows) {
  console.log(
    `  AOS=${w.startSeconds?.toFixed(1) ?? '(open)'} LOS=${w.endSeconds?.toFixed(1) ?? '(open)'} maxEl=${w.maxElevationDeg.toFixed(2)}°`,
  );
}
for (const warning of report.report.warnings) console.log('  note:', warning);
console.log('  saved report id =', report.saved?.id, 'created =', report.saved?.created);

// Idempotent repeat
const again = passes(
  db2,
  { orbitId, stationId, fromSeconds: from, toSeconds: to, stepSeconds: 40, persist: true, clientRequestId: 'demo-1' },
  CLOCK,
);
console.log('  repeat submission created =', again.saved?.created, '(same id =', again.saved?.id, ')');

const cmp = compareGates(db2, {
  orbitId,
  stationId,
  fromSeconds: from,
  toSeconds: to,
  stepSeconds: 40,
  gateDegA: 5,
  gateDegB: 20,
});
console.log(`\n[gate compare] 5° -> ${cmp.windowCountA} windows, 20° -> ${cmp.windowCountB} windows`);
db2.close();

// Briefly start a loopback-only ephemeral server to demonstrate the API, then
// shut down cleanly. Nothing is exposed off-machine.
const server = await serve({ dbPath, port: 0, now: () => CLOCK, infoFile: resolve(dir, 'server.json') });
const health = await (await fetch(`${server.url}/health`)).json();
console.log('\n[server] loopback API at', server.url, 'health =', JSON.stringify(health));
console.log('[server] info file', resolve(dir, 'server.json'));
await server.close();
console.log('[done] demo artifacts in', dir);
