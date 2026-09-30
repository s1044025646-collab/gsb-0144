import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { DB } from '../db/database.js';
import { DomainError } from '../core/errors.js';
import { service } from '../core/service.js';
import { modelLimitations } from '../db/repo.js';

type Handler = (body: any, query: URL, params: Record<string, string>) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

function num(value: unknown, name: string, required = true): number | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new DomainError('VALIDATION', `${name} is required.`);
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n))
    throw new DomainError('VALIDATION', `${name} must be a finite number.`, { value });
  return n;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new DomainError('BAD_REQUEST', 'Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new DomainError('BAD_REQUEST', 'Body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function buildRoutes(db: DB): Route[] {
  const r = (
    method: string,
    path: string,
    handler: Handler,
  ): Route => {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/:[A-Za-z]+/g, (m) => {
          keys.push(m.slice(1));
          return '([^/]+)';
        }) +
        '$',
    );
    return { method, pattern, keys, handler };
  };

  const elements = (b: any): import('../core/orbit.js').OrbitalElementsInput => ({
    a: num(b.a, 'a') as number,
    e: num(b.e, 'e') as number,
    iDeg: num(b.iDeg, 'iDeg') as number,
    raanDeg: num(b.raanDeg, 'raanDeg', false) ?? 0,
    argpDeg: num(b.argpDeg, 'argpDeg', false) ?? 0,
    nu0Deg: num(b.nu0Deg, 'nu0Deg', false) ?? 0,
  });

  return [
    r('GET', '/health', () => ({ ok: true, model: 'two-body-spherical-earth' })),
    r('GET', '/limitations', () => ({
      model: 'two-body-spherical-earth',
      notModeled: modelLimitations(),
      units: { length: 'metre', time: 'second', angle: 'radian internal / degree at API' },
    })),

    r('POST', '/scenarios/:id/revise', (b, _q, p) =>
      service.revise(
        db,
        p.id,
        required(b.newId, 'newId'),
        required(b.name, 'name'),
        b.orbit
          ? {
              orbit: {
                t0: num(b.orbit.t0, 'orbit.t0', false) ?? 0,
                elements: elements(b.orbit),
              },
            }
          : {},
      ),
    ),

    r('POST', '/scenarios', (b) =>
      service.createScenario(db, {
        id: required(b.id, 'id'),
        name: required(b.name, 'name'),
        theta0Deg: num(b.theta0Deg, 'theta0Deg', false),
        thetaEpoch: num(b.thetaEpoch, 'thetaEpoch', false),
        constants: b.constants,
      }),
    ),
    r('GET', '/scenarios', (_b, q) =>
      service.listScenarios(db, q.searchParams.get('limit'), q.searchParams.get('offset')),
    ),
    r('GET', '/scenarios/:id', (_b, _q, p) => service.getScenario(db, p.id)),

    r('PUT', '/scenarios/:id/orbit', (b, _q, p) =>
      service.setOrbit(
        db,
        p.id,
        num(b.t0, 't0', false) ?? 0,
        elements(b),
        typeof b.orbitId === 'string' ? b.orbitId : undefined,
      ),
    ),

    r('POST', '/scenarios/:id/stations', (b, _q, p) =>
      service.addStation(db, p.id, {
        id: required(b.id, 'id'),
        name: required(b.name, 'name'),
        latDeg: num(b.latDeg, 'latDeg') as number,
        lonDeg: num(b.lonDeg, 'lonDeg') as number,
        altM: num(b.altM, 'altM', false),
        minElevDeg: num(b.minElevDeg, 'minElevDeg') as number,
      }),
    ),
    r('GET', '/scenarios/:id/stations', (_b, q, p) =>
      service.listStations(
        db,
        p.id,
        q.searchParams.get('limit'),
        q.searchParams.get('offset'),
      ),
    ),

    r('GET', '/scenarios/:id/propagate', (b, q, p) =>
      service.propagate(
        db,
        p.id,
        q.searchParams.get('stationId'),
        num(Object.fromEntries(q.searchParams).t ?? b.t, 't') as number,
      ),
    ),

    r('GET', '/scenarios/:id/track', (_b, q, p) =>
      service.track(
        db,
        p.id,
        q.searchParams.get('stationId'),
        num(Object.fromEntries(q.searchParams).start, 'start') as number,
        num(Object.fromEntries(q.searchParams).end, 'end') as number,
        num(Object.fromEntries(q.searchParams).step, 'step') as number,
      ),
    ),

    r('POST', '/scenarios/:id/windows', (b, _q, p) =>
      service.windows(
        db,
        p.id,
        required(b.stationId, 'stationId'),
        {
          start: num(b.start, 'start') as number,
          end: num(b.end, 'end') as number,
          maxStep: num(b.maxStep, 'maxStep') as number,
          rootTol: num(b.rootTol, 'rootTol', false),
        },
        typeof b.idempotencyKey === 'string' ? b.idempotencyKey : undefined,
      ),
    ),

    r('POST', '/scenarios/:id/compare-gates', (b, _q, p) =>
      service.compareGates(
        db,
        p.id,
        required(b.stationId, 'stationId'),
        Array.isArray(b.gates)
          ? b.gates.map((g: unknown) => Number(g))
          : failArg('gates must be an array'),
        {
          start: num(b.start, 'start') as number,
          end: num(b.end, 'end') as number,
          maxStep: num(b.maxStep, 'maxStep') as number,
        },
      ),
    ),

    r('GET', '/scenarios/:id/reports', (_b, q, p) =>
      service.listReports(
        db,
        p.id,
        q.searchParams.get('limit'),
        q.searchParams.get('offset'),
      ),
    ),
  ];
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new DomainError('VALIDATION', `${name} is required and must be a string.`);
  return value;
}

function failArg(message: string): never {
  throw new DomainError('VALIDATION', message);
}

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/**
 * Binds ONLY to 127.0.0.1. Port 0 asks the OS for an ephemeral port, so there
 * are no fixed-port conflicts and nothing is exposed on the network.
 */
export function startApiServer(db: DB, host = '127.0.0.1', port = 0): Promise<StartedServer> {
  const routes = buildRoutes(db);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/') {
        return send(res, 200, {
          name: 'fictional-orbit-groundstation-api',
          endpoints: routes.map((rt) => rt.method + ' ' + rt.pattern.source),
        });
      }
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        const params: Record<string, string> = {};
        route.keys.forEach((key, i) => (params[key] = decodeURIComponent(match[i + 1])));
        const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
        const result = await route.handler(body, url, params);
        return send(res, 200, { ok: true, data: result });
      }
      return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'No route.' } });
    } catch (err) {
      if (err instanceof DomainError) {
        return send(res, err.httpStatus, {
          ok: false,
          error: { code: err.code, message: err.message, details: err.details ?? null },
        });
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      return send(res, 500, { ok: false, error: { code: 'PERSISTENCE', message } });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo;
      resolve({
        server,
        port: address.port,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((e) => (e ? rej(e) : res())),
          ),
      });
    });
  });
}
