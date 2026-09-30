#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createScenario, getScenario } from '../db/database.ts';
import { AppError } from '../api/errors.ts';
import {
  getOrbit,
  getStation,
  insertOrbit,
  insertStation,
  listOrbits,
  listReports,
  listStations,
} from '../api/repo.ts';
import { compareGates, passes, propagate, track } from '../api/service.ts';
import { createContext, num, parseFlags } from './util.ts';

const HELP = `
satpass - fictional two-body elliptical orbit / ground-station pass CLI

Angles accepted in DEGREES (converted to radians internally); lengths metres;
time unix seconds. Model: spherical rotating Earth, NO perturbations/refraction.

Global:
  --db <path>             SQLite file (default data/app.sqlite)

Commands:
  scenario-create --name <s>
  orbit-create --scenario <id> --a <m> --e <n> --i <deg> --raan <deg> \
               --argp <deg> --M0 <deg> --epoch <unix_s>
  station-create --scenario <id> --name <s> --lat <deg> --lon <deg> \
                 --alt <m> --el <deg>
  orbit-get --id <id>
  station-get --id <id>
  orbit-list --scenario <id> [--limit n] [--offset n]
  station-list --scenario <id> [--limit n] [--offset n]
  propagate --orbit <id> [--station <id>] --time <unix_s>
  track --orbit <id> --station <id> --from <s> --to <s> --count <n>
  passes --orbit <id> --station <id> --from <s> --to <s> \
         [--step <s>] [--el <deg>] [--save] [--rid <clientRequestId>]
  compare-gates --orbit <id> --station <id> --from <s> --to <s> \
                --gateA <deg> --gateB <deg> [--step <s>]
  report-list --scenario <id> [--limit n] [--offset n]
  export --report <id> --out <file.json>
`;

function main(): void {
  const rawArgv = process.argv.slice(2);
  // Extract global flags that may appear before the command.
  let dbPathArg: string | undefined;
  const argv: string[] = [];
  for (let i = 0; i < rawArgv.length; i++) {
    const a = rawArgv[i];
    if (a === '--db') {
      dbPathArg = rawArgv[i + 1];
      i++;
    } else if (a.startsWith('--db=')) {
      dbPathArg = a.slice('--db='.length);
    } else {
      argv.push(a);
    }
  }
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP + '\n');
    return;
  }
  const ctx = createContext(dbPathArg ? ['--db', dbPathArg, ...argv.slice(1)] : argv.slice(1));
  const f = parseFlags(ctx.rest);
  const db = ctx.db;
  const D = Math.PI / 180;

  const before = `[before] db=${ctx.dbPath}`;

  switch (cmd) {
    case 'scenario-create': {
      const name = f.get('name');
      if (!name) throw new AppError('VALIDATION', '--name required');
      console.log(before);
      const id = createScenario(db, name, ctx.now());
      console.log(`[after ] scenario #${id} created`, JSON.stringify(getScenario(db, id)));
      break;
    }
    case 'orbit-create': {
      const scenario = num(f.get('scenario'), 'scenario');
      console.log(before, `lastOrbitId=${listOrbits(db, scenario, 1, 0).total}`);
      const { id, elements } = insertOrbit(
        db,
        scenario,
        {
          semiMajorAxis: num(f.get('a'), 'a'),
          eccentricity: num(f.get('e'), 'e'),
          inclinationRad: num(f.get('i'), 'i') * D,
          raanRad: (f.get('raan') ? Number(f.get('raan')) : 0) * D,
          argPerigeeRad: (f.get('argp') ? Number(f.get('argp')) : 0) * D,
          meanAnomalyAtEpochRad: (f.get('M0') ? Number(f.get('M0')) : 0) * D,
          epochSeconds: num(f.get('epoch'), 'epoch'),
        },
        ctx.now(),
      );
      console.log(`[after ] orbit #${id} created`);
      console.log(JSON.stringify(elements, null, 2));
      break;
    }
    case 'station-create': {
      const scenario = num(f.get('scenario'), 'scenario');
      console.log(before, `stations=${listStations(db, scenario, 1, 0).total}`);
      const id = insertStation(
        db,
        scenario,
        {
          name: f.get('name') ?? '',
          latitudeRad: num(f.get('lat'), 'lat') * D,
          longitudeRad: num(f.get('lon'), 'lon') * D,
          altitudeM: f.get('alt') ? Number(f.get('alt')) : 0,
          minElevationRad: num(f.get('el'), 'el') * D,
        },
        ctx.now(),
      );
      console.log(`[after ] station #${id} created`, JSON.stringify(getStation(db, id).station));
      break;
    }
    case 'orbit-get':
      console.log(JSON.stringify(getOrbit(db, num(f.get('id'), 'id')), null, 2));
      break;
    case 'station-get':
      console.log(JSON.stringify(getStation(db, num(f.get('id'), 'id')), null, 2));
      break;
    case 'orbit-list': {
      const scenario = num(f.get('scenario'), 'scenario');
      const limit = Number(f.get('limit') ?? 20);
      const offset = Number(f.get('offset') ?? 0);
      console.log(JSON.stringify(listOrbits(db, scenario, limit, offset), null, 2));
      break;
    }
    case 'station-list': {
      const scenario = num(f.get('scenario'), 'scenario');
      const limit = Number(f.get('limit') ?? 20);
      const offset = Number(f.get('offset') ?? 0);
      console.log(JSON.stringify(listStations(db, scenario, limit, offset), null, 2));
      break;
    }
    case 'propagate': {
      const orbit = num(f.get('orbit'), 'orbit');
      const time = num(f.get('time'), 'time');
      const station = f.get('station') ? Number(f.get('station')) : undefined;
      console.log(`[before] orbit #${orbit} station=${station ?? '-'} t=${time}`);
      const result = propagate(db, { orbitId: orbit, stationId: station, timeSeconds: time });
      console.log('[after ]');
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'track': {
      const result = track(db, {
        orbitId: num(f.get('orbit'), 'orbit'),
        stationId: num(f.get('station'), 'station'),
        fromSeconds: num(f.get('from'), 'from'),
        toSeconds: num(f.get('to'), 'to'),
        count: Number(f.get('count') ?? 10),
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'passes': {
      const q = {
        orbitId: num(f.get('orbit'), 'orbit'),
        stationId: num(f.get('station'), 'station'),
        fromSeconds: num(f.get('from'), 'from'),
        toSeconds: num(f.get('to'), 'to'),
        stepSeconds: f.get('step') ? Number(f.get('step')) : undefined,
        minElevationDeg: f.get('el') ? Number(f.get('el')) : undefined,
        persist: f.has('save'),
        clientRequestId: f.get('rid'),
      };
      console.log('[before] computing passes', JSON.stringify(q));
      const { report, saved } = passes(db, q, ctx.now());
      console.log('[after ] windows:');
      for (const w of report.windows) {
        console.log(
          `  AOS=${w.startSeconds ?? '(open@start)'} LOS=${w.endSeconds ?? '(open@end)'} ` +
            `maxEl=${w.maxElevationDeg.toFixed(2)}deg undersampled=${w.possiblyUndersampled}`,
        );
      }
      for (const warning of report.warnings) console.log(`  note: ${warning}`);
      if (saved) console.log(`  saved report #${saved.id} (created=${saved.created})`);
      break;
    }
    case 'compare-gates': {
      const result = compareGates(db, {
        orbitId: num(f.get('orbit'), 'orbit'),
        stationId: num(f.get('station'), 'station'),
        fromSeconds: num(f.get('from'), 'from'),
        toSeconds: num(f.get('to'), 'to'),
        stepSeconds: f.get('step') ? Number(f.get('step')) : undefined,
        gateDegA: num(f.get('gateA'), 'gateA'),
        gateDegB: num(f.get('gateB'), 'gateB'),
      });
      console.log(
        `gate ${result.gateDegA}deg -> ${result.windowCountA} windows; ` +
          `gate ${result.gateDegB}deg -> ${result.windowCountB} windows`,
      );
      break;
    }
    case 'report-list': {
      const scenario = num(f.get('scenario'), 'scenario');
      console.log(JSON.stringify(listReports(db, scenario, Number(f.get('limit') ?? 20), Number(f.get('offset') ?? 0)), null, 2));
      break;
    }
    case 'export': {
      const id = num(f.get('report'), 'report');
      const out = resolve(f.get('out') ?? `report-${id}.json`);
      const row = db.prepare('SELECT * FROM report WHERE id=?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new AppError('NOT_FOUND', `report ${id} not found`);
      writeFileSync(out, JSON.stringify(row, null, 2));
      console.log(`exported report #${id} -> ${out}`);
      break;
    }
    default:
      throw new AppError('VALIDATION', `unknown command '${cmd}'`);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof AppError) {
    console.error(`error [${err.code}]: ${err.message}`);
    process.exitCode = 1;
  } else {
    console.error('error:', (err as Error).message);
    process.exitCode = 1;
  }
}
