import { resolve } from 'node:path';
import { openDatabase, type DB } from '../db/database.ts';
import { AppError } from '../api/errors.ts';

export interface CliContext {
  db: DB;
  now: () => number;
  dbPath: string;
}

export function createContext(argv: string[]): CliContext & { rest: string[] } {
  const dbFlag = argv.indexOf('--db');
  let dbPath = resolve('data/app.sqlite');
  const rest = [...argv];
  if (dbFlag !== -1 && argv[dbFlag + 1]) {
    dbPath = resolve(argv[dbFlag + 1]);
    rest.splice(dbFlag, 2);
  }
  const now = () => Date.now() / 1000;
  const db = openDatabase(dbPath, now);
  return { db, now, dbPath, rest };
}

export function num(value: string | undefined, label: string): number {
  if (value === undefined) throw new AppError('VALIDATION', `missing --${label}`);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new AppError('VALIDATION', `--${label} must be numeric, got ${value}`);
  return n;
}

export function opt(value: string | undefined, fallback: string): string {
  return value ?? fallback;
}

/** Tiny `--flag value` / `--flag=value` parser. */
export function parseFlags(args: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      map.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        map.set(a.slice(2), next);
        i++;
      } else {
        map.set(a.slice(2), 'true');
      }
    }
  }
  return map;
}

export function fmt(value: unknown): string {
  return typeof value === 'number' ? value.toFixed(4) : String(value);
}
