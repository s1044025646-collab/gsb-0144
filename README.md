# Ellipse Pass Predictor (fictional two-body model)

A Windows-friendly, **local-only** backend for propagating **two-body
elliptical** orbits around a **spherical, uniformly rotating Earth** and
computing **ground-station visibility windows**. It provides an HTTP API, a
CLI, fictional orbit/station fixtures, and automated tests.

> Scope / safety: this is a deliberately simplified *fictional* model. It has
> **no** perturbations (J2, drag, third body), **no** atmospheric refraction,
> and **no** real Earth attitude / polar motion / nutation. It never calls
> online ephemerides and never controls real spacecraft. Do not use for
> operational decisions.

## Units and conventions

- Length: **metres**. Time: **Unix seconds** (SI seconds since epoch).
- Angles: **radians internally**; the CLI and fixture helpers accept **degrees**
  and convert. Azimuth is clockwise from north (0=N, π/2=E); elevation is above
  the station local tangent plane.
- Orbital elements: semi-major axis `a` (m), eccentricity `e`, inclination
  `i`, RAAN `Ω`, argument of perigee `ω`, mean anomaly at epoch `M0`, and the
  element epoch `t0` (unix s).
- Rotation order:
  1. Perifocal (PQW) → inertial via the standard **3-1-3** Euler set
     `R = Rz(Ω)·Rx(i)·Rz(ω)`.
  2. Inertial → Earth-fixed via a single `Rz(−θ(t))`, where
     `θ(t) = θ0 + ωe·t` (Greenwich rotation angle).
- Kepler's equation `M = E − e·sin E` is solved with Newton-Raphson (exact at
  `e=0`); multi-turn mean anomalies are wrapped stably. Hyperbolic/parabolic
  orbits (`e ≥ 1`) and perigee at/below the surface are rejected with explicit
  errors.
- Visibility boundaries are **bracketed** by a capped coarse sign scan and then
  **refined with bisection** to 1e-4 s. Coarse samples are never reported as
  exact crossing times.
- The scan step is capped at **600 s**. Windows shorter than one step may be
  missed (`possiblyUndersampled` / warnings), and windows open at a search
  boundary are returned with a null edge and counted as unclosed.

## Requirements

- Node.js **>= 22.5** (developed on Node 25). TypeScript runs directly via the
  built-in type-stripping; SQLite uses the built-in `node:sqlite`.
- **Zero third-party runtime dependencies** — no `npm install` is required.

## Getting started (PowerShell, Windows)

```powershell
cd E:\GSB\0144\A

# repeatable end-to-end demo (fixed clock + fixtures, isolated ./data/demo)
npm run demo

# run all automated tests
npm test

# start the local API (binds 127.0.0.1 on an OS-assigned free port)
npm start
# the chosen URL/pid are written to data/server.json; Ctrl+C to stop

# remove project-local data/build artifacts and stop the recorded project server
npm run clean
```

All data and temp files stay under `./data`. Start/stop/clean only manage this
project; the server binds **loopback only** and defaults to an **ephemeral
port** (pass a port only for local experimentation, e.g. `node src/server/index.ts data/app.sqlite 8080`).

## CLI

Global `--db <path>` may appear before the command. See `node src/cli/index.ts help`.

```powershell
node src/cli/index.ts scenario-create --name DEMO
node src/cli/index.ts orbit-create  --scenario 1 --a 9000000 --e 0.25 --i 63 `
  --raan 30 --argp 90 --M0 200 --epoch 1700000000
node src/cli/index.ts station-create --scenario 1 --name FIX-midlat `
  --lat 40 --lon -75 --alt 100 --el 5
node src/cli/index.ts propagate --orbit 1 --station 1 --time 1700003600
node src/cli/index.ts track --orbit 1 --station 1 --from 1700000000 --to 1700172800 --count 12
node src/cli/index.ts passes --orbit 1 --station 1 --from 1700000000 --to 1700172800 `
  --step 40 --save --rid run-1
node src/cli/index.ts compare-gates --orbit 1 --station 1 --from 1700000000 --to 1700172800 `
  --gateA 5 --gateB 20 --step 40
node src/cli/index.ts report-list --scenario 1
node src/cli/index.ts export --report 1 --out data/report-1.json
```

Mutating commands print `[before]` / `[after ]` state. Changing elements or
stations creates new versioned records; a scenario freezes its own snapshot of
the model constants.

## HTTP API

Base URL and port are printed at startup and stored in `data/server.json`.

- `GET  /health`
- `POST /scenarios` · `GET /scenarios/:id`
- `POST /scenarios/:id/orbits` · `GET /scenarios/:id/orbits?limit&offset` · `GET /orbits/:id`
- `POST /scenarios/:id/stations` · `GET /scenarios/:id/stations?limit&offset` · `GET /stations/:id`
- `POST /propagate` `{orbitId, stationId?, timeSeconds}`
- `POST /track` `{orbitId, stationId, fromSeconds, toSeconds, count}`
- `POST /passes` `{orbitId, stationId, fromSeconds, toSeconds, stepSeconds?, minElevationDeg?, persist?, clientRequestId?}`
- `POST /compare-gates` `{..., gateDegA, gateDegB}`
- `GET  /scenarios/:id/reports?limit&offset` · `GET /reports/:id`

Errors are JSON: `{ "error": { "code", "message", "details" } }` with codes
`VALIDATION` (400), `NOT_FOUND` (404), `CONFLICT` (409),
`UNSUPPORTED_ORBIT` (422), `BAD_RANGE` (400), `PERSISTENCE`/`INTERNAL` (5xx).
List endpoints return an envelope `{ data, paging: { total, limit, offset,
hasMore, next } }`. Repeating a `POST /passes` with the same
`clientRequestId` within a scenario is idempotent and returns the stored report.

### Quick API call (PowerShell)

```powershell
$u = (Get-Content data/server.json | ConvertFrom-Json).url
Invoke-RestMethod "$u/health"
```

## Project layout

- `src/core/` — constants, angles, Kepler solver, orbit/ECI-ECEF geometry,
  station geometry, bracket+bisection pass search.
- `src/db/` — SQLite open + idempotent migration.
- `src/api/` — validation, repository, compute services, pagination, errors.
- `src/server/` — dependency-free `node:http` loopback API.
- `src/cli/` — command-line interface.
- `src/fixtures/` — fictional circular, inclined-ellipse, polar, equatorial and
  no-pass fixtures plus invalid-input cases.
- `scripts/demo.ts` — repeatable demo; `scripts/clean.ps1` — project cleanup.
- `test/` — physics invariants, fixtures, DB transactions/rollback,
  persistence across restart, HTTP end-to-end, and CLI tests.

## What the tests verify

- One-period position/velocity reproduction; specific-energy and
  angular-momentum conservation over an orbit; ECI↔ECEF round-trip.
- Circular, inclined-ellipse, equatorial, polar-station, cross-day and no-pass
  fixtures; stable azimuth at the exact pole; zero-eccentricity stability.
- Refined entry/exit crossings sit on the elevation gate (threshold error);
  degree/radian gate unit equivalence; step-cap behavior.
- Validation/failure paths, transaction rollback, idempotent submissions,
  paging, explicit error codes, injected clocks, and persistence across a full
  close/reopen cycle.
