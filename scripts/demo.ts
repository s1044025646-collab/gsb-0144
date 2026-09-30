/**
 * Repeatable end-to-end demo. Runs entirely against project-local files:
 *   data/demo.sqlite  and  tmp/demo-export.json
 * No network services, no real devices. All inputs are fictional.
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate, openDatabase } from '../src/db/database.js';
import { service } from '../src/core/service.js';
import { seedFixture } from '../src/core/fixtures.js';

let clock = 1_700_000_000;
const now = () => clock++;

const dbPath = resolve('data/demo.sqlite');
rmSync(dbPath, { force: true });

const db = openDatabase(dbPath, now);
console.log('applying migrations:', migrate(db));

const fx = seedFixture(db, 'inclinedEllipse');
console.log('seeded:', fx.description);

const scenarioId = fx.scenario.id;
const propagated = service.propagate(db, scenarioId, 'eq', 1200);
console.log('propagate t=1200s =>', {
  radiusKm: propagated.radiusM / 1000,
  anomalies: propagated.anomalies,
  look: propagated.look,
});

const track = service.track(db, scenarioId, 'eq', 0, 600, 120);
console.log(`track samples: ${track.samples.length}`);

const win = service.windows(
  db,
  scenarioId,
  'eq',
  { start: 0, end: 172_800, maxStep: 20, rootTol: 1e-3 },
  'demo-eq-fixed-key',
);
console.log('windows:', win.report.windows);
console.log('warnings:', win.report.warnings);

const winRepeat = service.windows(
  db,
  scenarioId,
  'eq',
  { start: 0, end: 172_800, maxStep: 20 },
  'demo-eq-fixed-key',
);
console.log('repeated submission reused stored report:', winRepeat.reused);

const compare = service.compareGates(db, scenarioId, 'eq', [0, 5, 20], {
  start: 0,
  end: 86_400,
  maxStep: 20,
});
console.log(
  'gate comparison counts:',
  compare.map((g) => ({ gate: g.gateDeg, windows: g.windowCount, visibleS: g.totalVisibleS })),
);

// Persist via CLI export logic path is exercised in shell demo; here snapshot DB state.
const reports = service.listReports(db, scenarioId, 10, 0);
console.log('stored reports:', reports.total);
db.db.close();
console.log('done; database at', dbPath);
