import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DB } from '../db/database.ts';
import { createScenario, getScenario } from '../db/database.ts';
import { AppError, httpStatus, type ErrorCode } from '../api/errors.ts';
import { pageEnvelope, parsePage } from '../api/pagination.ts';
import {
  getOrbit,
  getReport,
  getStation,
  insertOrbit,
  insertStation,
  listOrbits,
  listReports,
  listStations,
} from '../api/repo.ts';
import { compareGates, passes, propagate, track } from '../api/service.ts';

export interface RouterDeps {
  db: DB;
  now: () => number;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(json);
}

function sendError(res: ServerResponse, code: ErrorCode, message: string, details?: unknown): void {
  send(res, httpStatus(code), { error: { code, message, details: details ?? null } });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError('VALIDATION', 'request body must be a JSON object');
  }
}

function idParam(value: string | undefined, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new AppError('VALIDATION', `${label} must be a positive integer id`);
  return n;
}

/** Dispatch a request. Returns true if handled. */
export async function handle(
  deps: RouterDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const { db, now } = deps;
  const method = req.method ?? 'GET';
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const seg = p.split('/').filter(Boolean);

  try {
    // Health
    if (method === 'GET' && p === '/health') return send(res, 200, { status: 'ok', timeSeconds: now() }), true;

    // Scenarios
    if (method === 'POST' && p === '/scenarios') {
      const body = await readJson(req);
      const name = (body.name ?? '').toString().trim();
      if (!name) throw new AppError('VALIDATION', 'name is required');
      const id = createScenario(db, name, now());
      return send(res, 201, { id, scenario: getScenario(db, id) }), true;
    }
    if (method === 'GET' && seg[0] === 'scenarios' && seg.length === 2) {
      const id = idParam(seg[1], 'scenarioId');
      const row = getScenario(db, id);
      if (!row) throw new AppError('NOT_FOUND', `scenario ${id} not found`);
      return send(res, 200, row), true;
    }

    // Orbits: /scenarios/:id/orbits, /orbits/:id
    if (method === 'POST' && seg[0] === 'scenarios' && seg[2] === 'orbits' && seg.length === 3) {
      const scenarioId = idParam(seg[1], 'scenarioId');
      const body = await readJson(req);
      const { id, elements } = insertOrbit(db, scenarioId, body as never, now());
      return send(res, 201, { id, version: body, elements }), true;
    }
    if (method === 'GET' && seg[0] === 'scenarios' && seg[2] === 'orbits' && seg.length === 3) {
      const scenarioId = idParam(seg[1], 'scenarioId');
      const page = parsePage(url.searchParams);
      const { total, items } = listOrbits(db, scenarioId, page.limit, page.offset);
      return send(res, 200, pageEnvelope(`/scenarios/${scenarioId}/orbits`, page, total, items)), true;
    }
    if (method === 'GET' && seg[0] === 'orbits' && seg.length === 2) {
      return send(res, 200, getOrbit(db, idParam(seg[1], 'orbitId'))), true;
    }

    // Stations
    if (method === 'POST' && seg[0] === 'scenarios' && seg[2] === 'stations' && seg.length === 3) {
      const scenarioId = idParam(seg[1], 'scenarioId');
      const body = await readJson(req);
      const id = insertStation(db, scenarioId, body as never, now());
      return send(res, 201, { id, station: getStation(db, id) }), true;
    }
    if (method === 'GET' && seg[0] === 'scenarios' && seg[2] === 'stations' && seg.length === 3) {
      const scenarioId = idParam(seg[1], 'scenarioId');
      const page = parsePage(url.searchParams);
      const { total, items } = listStations(db, scenarioId, page.limit, page.offset);
      return send(res, 200, pageEnvelope(`/scenarios/${scenarioId}/stations`, page, total, items)), true;
    }
    if (method === 'GET' && seg[0] === 'stations' && seg.length === 2) {
      return send(res, 200, getStation(db, idParam(seg[1], 'stationId'))), true;
    }

    // Compute endpoints
    if (method === 'POST' && p === '/propagate') {
      const body = await readJson(req);
      return send(res, 200, propagate(db, body as never)), true;
    }
    if (method === 'POST' && p === '/track') {
      const body = await readJson(req);
      return send(res, 200, track(db, body as never)), true;
    }
    if (method === 'POST' && p === '/passes') {
      const body = await readJson(req);
      return send(res, 200, passes(db, body as never, now())), true;
    }
    if (method === 'POST' && p === '/compare-gates') {
      const body = await readJson(req);
      return send(res, 200, compareGates(db, body as never)), true;
    }

    // Reports
    if (method === 'GET' && seg[0] === 'scenarios' && seg[2] === 'reports' && seg.length === 3) {
      const scenarioId = idParam(seg[1], 'scenarioId');
      const page = parsePage(url.searchParams);
      const { total, items } = listReports(db, scenarioId, page.limit, page.offset);
      return send(res, 200, pageEnvelope(`/scenarios/${scenarioId}/reports`, page, total, items)), true;
    }
    if (method === 'GET' && seg[0] === 'reports' && seg.length === 2) {
      return send(res, 200, getReport(db, idParam(seg[1], 'reportId'))), true;
    }

    return false;
  } catch (err) {
    if (err instanceof AppError) return sendError(res, err.code, err.message, err.details), true;
    const e = err as Error;
    return sendError(res, 'INTERNAL', e.message), true;
  }
}
