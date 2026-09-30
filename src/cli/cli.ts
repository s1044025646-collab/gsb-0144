#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrate, openDatabase, transactionRollsBack } from '../db/database.js';
import {
  constantsOf,
  epochOf,
  getOrbitByScenario,
  getScenario,
  listStations,
  modelLimitations,
  spinOf,
} from '../db/repo.js';
import { service } from '../core/service.js';
import { FIXTURES, seedFixture } from '../core/fixtures.js';
import { DomainError } from '../core/errors.js';
import {
  greenwichAngle,
  inertialToEcef,
  lookAngles,
  orbitalPeriod,
  propagateInertial,
  specificEnergy,
  angularMomentum,
} from '../core/orbit.js';
import { startApiServer } from '../api/server.js';

interface CliCtx {
  dbPath: string;
}

const ctx: CliCtx = { dbPath: process.env.ORBIT_DB ?? resolve('data/orbit.sqlite') };

function db() {
  const handle = openDatabase(ctx.dbPath);
  migrate(handle);
  return handle;
}

function print(title: string, value: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function printState(d: ReturnType<typeof db>, scenarioId: string): void {
  try {
    const scenario = getScenario(d, scenarioId);
    let orbit = null;
    try {
      orbit = getOrbitByScenario(d, scenarioId);
    } catch {
      orbit = null;
    }
    const stations = listStations(d, scenarioId, 100, 0);
    console.log(
      `[state] scenario=${scenario.id} mu=${scenario.mu.toExponential(3)} R=${scenario.earth_radius} orbit=${orbit ? `${orbit.a}m e=${orbit.e}` : '<none>'} stations=${stations.total}`,
    );
  } catch {
    console.log(`[state] scenario '${scenarioId}' does not exist yet.`);
  }
}

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; positional: string[]; args: Args } {
  const args: Args = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else positional.push(token);
  }
  return { cmd: positional[0] ?? 'help', positional: positional.slice(1), args };
}

function s(value: string | boolean | undefined, name: string): string {
  if (typeof value !== 'string') throw new DomainError('BAD_REQUEST', `--${name} is required`);
  return value;
}
function n(value: string | boolean | undefined, name: string): number {
  const raw = s(value, name);
  const num = Number(raw);
  if (!Number.isFinite(num))
    throw new DomainError('BAD_REQUEST', `--${name} must be numeric`);
  return num;
}

export async function runCli(argv: string[]): Promise<number> {
  const { cmd, positional, args } = parseArgs(argv);
  const d = db();
  try {
    switch (cmd) {
      case 'init':
        print('Migrations applied; database ready', { dbPath: ctx.dbPath });
        return 0;

      case 'list-fixtures':
        print('Available fictional fixtures', Object.keys(FIXTURES));
        return 0;

      case 'seed': {
        const key = s(args.fixture ?? positional[0], 'fixture');
        printState(d, FIXTURES[key]?.scenario.id ?? key);
        const fx = seedFixture(d, key);
        print('Seeded fixture', { key: fx.scenario.id, description: fx.description });
        printState(d, fx.scenario.id);
        return 0;
      }

      case 'create-scenario': {
        const id = s(args.id, 'id');
        printState(d, id);
        const row = service.createScenario(d, {
          id,
          name: s(args.name, 'name'),
          theta0Deg: args['theta0-deg'] !== undefined ? n(args['theta0-deg'], 'theta0-deg') : 0,
        });
        print('Created scenario (constants frozen)', row);
        printState(d, id);
        return 0;
      }

      case 'revise': {
        const sourceId = s(args.scenario, 'scenario');
        const newId = s(args['new-id'], 'new-id');
        printState(d, sourceId);
        printState(d, newId);
        const hasOrbit = args.a !== undefined;
        const created = service.revise(
          d,
          sourceId,
          newId,
          s(args.name ?? `Revision of ${sourceId}`, 'name'),
          hasOrbit
            ? {
                orbit: {
                  t0: n(args.t0 ?? '0', 't0'),
                  elements: {
                    a: n(args.a, 'a'),
                    e: n(args.e ?? '0', 'e'),
                    iDeg: n(args.i ?? '0', 'i'),
                    raanDeg: n(args.raan ?? '0', 'raan'),
                    argpDeg: n(args.argp ?? '0', 'argp'),
                    nu0Deg: n(args.nu ?? '0', 'nu'),
                  },
                },
              }
            : {},
        );
        print('Created new frozen revision (source left unchanged)', created);
        printState(d, newId);
        return 0;
      }

      case 'set-orbit': {
        const scenarioId = s(args.scenario, 'scenario');
        printState(d, scenarioId);
        const row = service.setOrbit(
          d,
          scenarioId,
          n(args.t0 ?? '0', 't0'),
          {
            a: n(args.a, 'a'),
            e: n(args.e ?? '0', 'e'),
            iDeg: n(args.i ?? '0', 'i'),
            raanDeg: n(args.raan ?? '0', 'raan'),
            argpDeg: n(args.argp ?? '0', 'argp'),
            nu0Deg: n(args.nu ?? '0', 'nu'),
          },
          typeof args['orbit-id'] === 'string' ? args['orbit-id'] : undefined,
        );
        print('Orbit set (replaces prior orbit for this scenario)', row);
        printState(d, scenarioId);
        return 0;
      }

      case 'add-station': {
        const scenarioId = s(args.scenario, 'scenario');
        printState(d, scenarioId);
        const station = service.addStation(d, scenarioId, {
          id: s(args.id, 'id'),
          name: s(args.name ?? args.id, 'name'),
          latDeg: n(args.lat, 'lat'),
          lonDeg: n(args.lon, 'lon'),
          altM: args.alt !== undefined ? n(args.alt, 'alt') : 0,
          minElevDeg: n(args['min-elev'] ?? '5', 'min-elev'),
        });
        print('Station added', station);
        printState(d, scenarioId);
        return 0;
      }

      case 'propagate': {
        const scenarioId = s(args.scenario, 'scenario');
        const t = n(args.t, 't');
        const result = service.propagate(d, scenarioId,
          typeof args.station === 'string' ? args.station : null, t);
        print(`Propagated to t=${t} s`, result);
        return 0;
      }

      case 'track': {
        const scenarioId = s(args.scenario, 'scenario');
        const result = service.track(
          d,
          scenarioId,
          typeof args.station === 'string' ? args.station : null,
          n(args.start, 'start'),
          n(args.end, 'end'),
          n(args.step, 'step'),
        );
        print(`Track ${result.samples.length} samples`, result);
        return 0;
      }

      case 'windows': {
        const scenarioId = s(args.scenario, 'scenario');
        const result = service.windows(
          d,
          scenarioId,
          s(args.station, 'station'),
          {
            start: n(args.start, 'start'),
            end: n(args.end, 'end'),
            maxStep: n(args['max-step'] ?? '60', 'max-step'),
            rootTol: args['root-tol'] !== undefined ? n(args['root-tol'], 'root-tol') : 1e-3,
          },
          typeof args.idempotency === 'string' ? args.idempotency : undefined,
        );
        print('Visibility windows (bracketed + bisected)', result);
        return 0;
      }

      case 'compare-gates': {
        const scenarioId = s(args.scenario, 'scenario');
        const gates = s(args.gates, 'gates').split(',').map(Number);
        const result = service.compareGates(
          d,
          scenarioId,
          s(args.station, 'station'),
          gates,
          {
            start: n(args.start, 'start'),
            end: n(args.end, 'end'),
            maxStep: n(args['max-step'] ?? '60', 'max-step'),
          },
        );
        print('Elevation-gate comparison', result);
        return 0;
      }

      case 'export': {
        const scenarioId = s(args.scenario, 'scenario');
        const out = s(args.out ?? 'tmp/export.json', 'out');
        const scenario = getScenario(d, scenarioId);
        const orbit = getOrbitByScenario(d, scenarioId);
        const stations = listStations(d, scenarioId, 200, 0).items;
        const payload = {
          exportedAt: new Date(0).toISOString(),
          units: { length: 'metre', time: 'second', angle: 'degree at boundary / radian internal' },
          scenario,
          orbit,
          stations,
          limitations: modelLimitations(),
        };
        mkdirSync(dirname(resolve(out)), { recursive: true });
        writeFileSync(resolve(out), JSON.stringify(payload, null, 2));
        print('Exported scenario snapshot', resolve(out));
        return 0;
      }

      case 'conserve': {
        const scenarioId = s(args.scenario, 'scenario');
        const scenario = getScenario(d, scenarioId);
        const orbit = getOrbitByScenario(d, scenarioId);
        const c = constantsOf(scenario);
        const period = orbitalPeriod(orbit.a, c.mu);
        const epoch = epochOf(orbit);
        const s0 = propagateInertial(epoch, c, 0);
        const s1 = propagateInertial(epoch, c, period);
        const e0 = specificEnergy(s0, c.mu);
        const e1 = specificEnergy(s1, c.mu);
        const h0 = angularMomentum(s0);
        const h1 = angularMomentum(s1);
        print('Conservation over one period', {
          periodS: period,
          positionDriftM: Math.hypot(s1.rI.x - s0.rI.x, s1.rI.y - s0.rI.y, s1.rI.z - s0.rI.z),
          energyDiff: e1 - e0,
          angularMomentumDiff: { x: h1.x - h0.x, y: h1.y - h0.y, z: h1.z - h0.z },
        });
        return 0;
      }

      case 'serve': {
        const started = await startApiServer(d, '127.0.0.1', 0);
        console.log(`API listening ONLY on http://127.0.0.1:${started.port}`);
        console.log('Ctrl+C to stop.');
        await new Promise(() => {});
        return 0;
      }

      case 'selftest': {
        print('Transaction rollback probe', { rolledBack: transactionRollsBack(d) });
        print('Model limitations', modelLimitations());
        return 0;
      }

      case 'help':
      default:
        printHelp();
        return cmd === 'help' ? 0 : 2;
    }
  } catch (err) {
    if (err instanceof DomainError) {
      console.error(`ERROR [${err.code}] ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details));
      return 1;
    }
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function printHelp(): void {
  console.log(`Fictional two-body orbit & ground-station backend

Commands:
  init                                      Create/migrate local SQLite DB
  list-fixtures                             List fictional scenarios
  seed --fixture circular|inclinedEllipse   Load a fictional fixture
  create-scenario --id ID --name N [--theta0-deg D]
  revise --scenario ID --new-id ID2 --name N [--a M --e E ...]   Clone to a new frozen scheme
  set-orbit --scenario ID --a M --e E --i D --raan D --argp D --nu D [--t0 S]
  add-station --scenario ID --id ID --lat D --lon D [--alt M] [--min-elev D]
  propagate --scenario ID --t S [--station ID]
  track --scenario ID [--station ID] --start S --end S --step S
  windows --scenario ID --station ID --start S --end S [--max-step S] [--idempotency K]
  compare-gates --scenario ID --station ID --gates 0,5,10 --start S --end S
  export --scenario ID [--out tmp/export.json]
  conserve --scenario ID                    One-period energy/momentum check
  selftest                                  Transaction rollback + limitations
  serve                                     Localhost-only ephemeral HTTP API

Units: length=metre, time=second, CLI angles=degree. DB: ${ctx.dbPath}
Model: two-body point mass + spherical uniformly rotating Earth.
Explicitly NOT modeled: perturbations, atmospheric refraction, real Earth attitude.`);
}

// Unused imports kept for potential direct geometry scripting; reference them.
void greenwichAngle;
void inertialToEcef;
void lookAngles;
void spinOf;
