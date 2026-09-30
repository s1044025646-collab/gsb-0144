# Fictional Elliptic-Orbit Propagator & Ground-Station Visibility Backend

A **local-only** TypeScript + Node.js + SQLite backend. It propagates a
**two-body elliptic orbit** around a **spherical, uniformly rotating Earth**,
rotates state into an Earth-fixed frame at a common time, and computes
slant range / azimuth / elevation plus visibility windows for fictional ground
stations.

There is **no web UI**, **no online ephemeris**, and **no control of real
spacecraft or hardware**. Every spacecraft and station is fictional.

## Model and units

- Length: **metres**. Time: **monotonic seconds** on a scenario clock.
- Angles: **radians internally**; the API and CLI accept/print **degrees**.
- Gravity: point-mass two-body, `mu = GM` (frozen per scenario).
- Earth: sphere of radius `R`, sidereal rate `omegaE`;
  `theta(t) = theta0 + omegaE (t - thetaEpoch)`.
- Rotation order: orbit-plane (perifocal) state is mapped to the inertial frame
  by `R3(-raan) R1(-i) R3(-argp)`; ECEF is `R3(theta) r_inertial` (active
  column-vector rotations about the indicated body axes).

Kepler's equation `M = E - e sin E` is solved with Newton iteration and a
bisection fallback. Zero eccentricity and angle wrap-around are handled
explicitly. Unsupported inputs (`a <= 0`, `e >= 1`, non-finite values, or
periapsis `a(1-e) <= R`) are rejected with explicit error codes.

### Visibility windows

`f(t) = elevation(t) - minElevation` is scanned with a coarse step capped by
both `--max-step` **and one orbital period**. Each sign change is **bracketed**
and refined by **bisection** (default root tolerance `1e-3 s`); coarse samples
are never reported as boundary times. Boundary residuals (elevation minus gate
at the root) are returned. Windows already open at the start or still open at
the end are returned with `enter: null` / `exit: null` plus warnings. If the
step exceeds half an orbital period a "short windows may be missed" warning is
emitted.

### Explicitly NOT modeled

1. Perturbations (no J2, luni-solar, SRP, drag).
2. Earth flattening, precession/nutation/polar motion or real Earth attitude.
3. Atmospheric refraction, signal delay, terrain/azimuth masking.
4. Any live data or real device. See `GET /limitations` / `cli selftest`.

## Requirements

- Node.js >= 22 (developed/tested on Node 25; uses the built-in
  `node:sqlite`, so no native module build is needed).
- npm. All files stay inside this project directory.

## Install

```powershell
npm install
```

## Test

```powershell
npm test
```

Runs 20 checks covering: circular and inclined-elliptic orbits, equatorial and
polar stations, cross-day and no-pass cases, one-period state reproduction,
energy/angular-momentum conservation, inertial<->ECEF rotation round trip,
zero-eccentricity Kepler stability, angle wrap, gate boundary residual error,
unit equivalence (m vs km-scaled mu), failure paths/error codes, pagination,
idempotent repeat submission, transaction rollback, and persistence after
reopening the database.

## Repeatable end-to-end demo

```powershell
npm run demo
```

Uses an injected monotonic clock and deterministic fixtures; writes
`data/demo.sqlite`. Repeating a window report with the same idempotency key
reuses the stored result.

## CLI

The default database is `data/orbit.sqlite`; override with `$env:ORBIT_DB`.
Run `npx tsx src/cli/main.ts help` for the full list. Examples:

```powershell
npx tsx src/cli/main.ts list-fixtures
npx tsx src/cli/main.ts seed --fixture circular
npx tsx src/cli/main.ts propagate --scenario fx-circular --station eq --t 1200
npx tsx src/cli/main.ts track     --scenario fx-circular --station eq --start 0 --end 3000 --step 60
npx tsx src/cli/main.ts windows   --scenario fx-circular --station mid --start 0 --end 30000 --max-step 20
npx tsx src/cli/main.ts compare-gates --scenario fx-circular --station mid --gates 0,10,20 --start 0 --end 30000
npx tsx src/cli/main.ts conserve  --scenario fx-circular
npx tsx src/cli/main.ts export    --scenario fx-circular --out tmp/export.json
npx tsx src/cli/main.ts selftest
```

Mutating elements or stations creates a **new frozen scheme**; the source is
left unchanged:

```powershell
npx tsx src/cli/main.ts revise --scenario fx-circular --new-id fx-v2 --name "v2" --a 7200000 --e 0.01 --i 60
```

State-changing commands print `[state] ...` before and after.

## HTTP API

Start a server that binds **only to `127.0.0.1`** on an OS-assigned
**ephemeral port** (the chosen port is printed):

```powershell
npm start
```

Stop it with `Ctrl+C` in that terminal. No background/system service is
installed, and nothing is exposed off localhost.

Endpoints (JSON; paginated list endpoints accept `?limit=&offset=`):

- `GET  /health`
- `GET  /limitations`
- `POST /scenarios`, `GET /scenarios`, `GET /scenarios/:id`
- `POST /scenarios/:id/revise`
- `PUT  /scenarios/:id/orbit`
- `POST /scenarios/:id/stations`, `GET /scenarios/:id/stations`
- `GET  /scenarios/:id/propagate?t=&stationId=`
- `GET  /scenarios/:id/track?stationId=&start=&end=&step=`
- `POST /scenarios/:id/windows` (body: `stationId,start,end,maxStep,idempotencyKey?`)
- `POST /scenarios/:id/compare-gates` (body: `stationId,gates[],start,end,maxStep`)
- `GET  /scenarios/:id/reports`

Errors use a stable shape `{ ok:false, error:{ code, message, details } }`
with codes `VALIDATION`, `BAD_REQUEST`, `UNSUPPORTED_ORBIT`, `BELOW_SURFACE`,
`INVALID_RANGE`, `NOT_FOUND` (404), `CONFLICT` (409) and `PERSISTENCE` (500).

## Data, migrations, cleanup

- All databases and temp output live under `data/` and `tmp/` in this project.
- Migrations are recorded in `schema_migrations` and are safe/effective to
  re-run (repeat runs apply nothing).
- To reset a demo, delete the specific file under `data/` (e.g.
  `data/demo.sqlite`); do not touch anything outside the project.
