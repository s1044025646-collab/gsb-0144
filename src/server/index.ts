import { createServer, type AddressInfo } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDatabase } from '../db/database.ts';
import { handle } from './router.ts';

export interface ServeOptions {
  dbPath: string;
  host?: string;
  /** 0 => let the OS assign an ephemeral free port. */
  port?: number;
  now?: () => number;
  /** When set, write the chosen port/url/pid here (used by the demo/tests). */
  infoFile?: string;
}

export interface RunningServer {
  close: () => Promise<void>;
  address: AddressInfo;
  url: string;
  pid: number;
}

/**
 * Start the API. Binds only to loopback (127.0.0.1) and, by default, uses an
 * OS-assigned ephemeral port. No external network exposure.
 */
export function serve(opts: ServeOptions): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const db = openDatabase(opts.dbPath, opts.now ?? (() => Date.now() / 1000));
  const server = createServer((req, res) => {
    const base = `http://${host}:0`;
    const url = new URL(req.url ?? '/', base);
    void handle({ db, now: opts.now ?? (() => Date.now() / 1000) }, req, res, url).then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such route' } }));
      }
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const address = server.address() as AddressInfo;
      const url = `http://${host}:${address.port}`;
      if (opts.infoFile) {
        const dir = dirname(opts.infoFile);
        if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
        writeFileSync(
          opts.infoFile,
          JSON.stringify({ url, port: address.port, host, pid: process.pid }, null, 2),
        );
      }
      const running: RunningServer = {
        address,
        url,
        pid: process.pid,
        close: () =>
          new Promise<void>((resClose, rejClose) => {
            server.close((err) => {
              if (err) rejClose(err);
              else {
                db.close();
                resClose();
              }
            });
          }),
      };
      resolvePromise(running);
    });
  });
}

// CLI entry: node src/server/index.ts [dbPath] [port]
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const dbPath = resolve(process.argv[2] ?? 'data/app.sqlite');
  const port = process.argv[3] ? Number(process.argv[3]) : 0;
  const infoFile = resolve('data/server.json');
  serve({ dbPath, port, infoFile }).then((s) => {
    // eslint-disable-next-line no-console
    console.log(`[server] listening on ${s.url} (pid ${s.pid}), db ${dbPath}`);
    console.log(`[server] info written to ${infoFile}`);
  });
}
