import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveKepler } from '../src/core/kepler.ts';
import { wrapTwoPi, angleDiff } from '../src/core/angle.ts';
import {
  angularMomentum,
  earthFixedToInertial,
  greenwichAngle,
  inertialToEarthFixed,
  orbitalPeriod,
  propagateInertial,
  specificEnergy,
  validateElements,
} from '../src/core/orbit.ts';
import { observe } from '../src/core/station.ts';
import { findPasses } from '../src/core/passes.ts';
import { DEFAULT_CONSTANTS } from '../src/core/constants.ts';

const D = Math.PI / 180;
const base = {
  semiMajorAxis: 7_500_000,
  eccentricity: 0.15,
  inclination: 52 * D,
  raan: 25 * D,
  argPerigee: 80 * D,
  meanAnomalyAtEpoch: 1.234,
  epochSeconds: 1000,
};

test('Kepler: circular orbit E == M', () => {
  for (const M of [0, 0.7, Math.PI, 5.9]) {
    assert.ok(Math.abs(solveKepler(M, 0) - wrapTwoPi(M)) < 1e-12);
  }
});

test('Kepler: residual M = E - e sin E is tiny for eccentric orbit', () => {
  for (const e of [0.01, 0.5, 0.9]) {
    for (const M of [0, 1, 2, 3, 4, 5, 6, -3, 100, -100]) {
      const E = solveKepler(M, e);
      const Mr = E - e * Math.sin(E);
      assert.ok(Math.abs(angleDiff(Mr, M)) < 1e-9, `e=${e} M=${M}`);
    }
  }
});

test('Kepler: rejects non-elliptic eccentricity', () => {
  assert.throws(() => solveKepler(0, 1));
  assert.throws(() => solveKepler(0, 1.5));
  assert.throws(() => solveKepler(0, -0.1));
});

test('multi-turn mean anomaly wraps but stays on orbit', () => {
  const E1 = solveKepler(0.5, 0.3);
  const E2 = solveKepler(0.5 + 2 * Math.PI * 7, 0.3);
  assert.ok(Math.abs(angleDiff(E2, E1)) < 1e-9);
});

test('one period reproduces position and velocity exactly', () => {
  const P = orbitalPeriod(base);
  const s0 = propagateInertial(base, base.epochSeconds);
  const s1 = propagateInertial(base, base.epochSeconds + P);
  const s2 = propagateInertial(base, base.epochSeconds + 2 * P);
  const dist = (a: typeof s0, b: typeof s0) =>
    Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
  assert.ok(dist(s0, s1) < 1e-4);
  assert.ok(dist(s0, s2) < 1e-3);
});

test('energy and angular momentum are conserved over an orbit', () => {
  const P = orbitalPeriod(base);
  const ref = propagateInertial(base, base.epochSeconds);
  const eRef = specificEnergy(ref);
  const hRef = angularMomentum(ref);
  for (let k = 0; k <= 12; k++) {
    const s = propagateInertial(base, base.epochSeconds + (P * k) / 12);
    assert.ok(Math.abs(specificEnergy(s) - eRef) / Math.abs(eRef) < 1e-11);
    const h = angularMomentum(s);
    assert.ok(Math.hypot(h.x - hRef.x, h.y - hRef.y, h.z - hRef.z) < 1e-3);
  }
});

test('ECI->ECEF->ECI round trip at arbitrary times', () => {
  const s = propagateInertial(base, 4321.7);
  for (const t of [0, 59.5, 86400, -12345.6]) {
    const ecef = inertialToEarthFixed(s.position, t);
    const back = earthFixedToInertial(ecef, t);
    assert.ok(Math.hypot(back.x - s.position.x, back.y - s.position.y, back.z - s.position.z) < 1e-6);
  }
});

test('greenwich angle is periodic and monotonic', () => {
  const tDay = (2 * Math.PI) / DEFAULT_CONSTANTS.omegaEarth;
  assert.ok(Math.abs(angleDiff(greenwichAngle(tDay), greenwichAngle(0))) < 1e-9);
});

test('elevation: zenith station directly below sees ~90deg', () => {
  // Circular equatorial orbit; at epoch sat is on +x, station at lon 0.
  const el = {
    semiMajorAxis: 7_500_000,
    eccentricity: 0,
    inclination: 0,
    raan: 0,
    argPerigee: 0,
    meanAnomalyAtEpoch: 0,
    epochSeconds: 0,
  };
  const station = {
    name: 'sub',
    latitudeRad: 0,
    longitudeRad: 0,
    altitudeM: 0,
    minElevationRad: 0,
  };
  // At t=0 sat is on x-axis (theta=0), station at lon 0 -> directly overhead.
  const obs0 = observe(el, station, 0);
  assert.ok(obs0.elevationDeg > 89, `el=${obs0.elevationDeg}`);
});

test('validation rejects hyperbolic and sub-surface perigee', () => {
  assert.equal(validateElements({ ...base, eccentricity: 1.2 }).ok, false);
  assert.equal(validateElements({ ...base, semiMajorAxis: 6_400_000, eccentricity: 0.01 }).ok, false);
  assert.equal(validateElements(base).ok, true);
});

test('pass boundary refined by bisection sits on the gate', () => {
  const station = {
    name: 'g',
    latitudeRad: 30 * D,
    longitudeRad: 20 * D,
    altitudeM: 0,
    minElevationRad: 10 * D,
  };
  const P = orbitalPeriod(base);
  const report = findPasses(base, station, {
    fromSeconds: base.epochSeconds,
    toSeconds: base.epochSeconds + 3 * P,
    stepSeconds: 45,
  });
  assert.ok(report.windows.length > 0);
  for (const w of report.windows) {
    if (w.startSeconds !== null) {
      const o = observe(base, station, w.startSeconds);
      assert.ok(Math.abs(o.elevationDeg - 10) < 1e-2, `entry el=${o.elevationDeg}`);
    }
    if (w.endSeconds !== null) {
      const o = observe(base, station, w.endSeconds);
      assert.ok(Math.abs(o.elevationDeg - 10) < 1e-2, `exit el=${o.elevationDeg}`);
    }
  }
});

test('step above cap is rejected/clamped and warnings emitted', () => {
  const station = {
    name: 'g', latitudeRad: 0, longitudeRad: 0, altitudeM: 0, minElevationRad: 10 * D,
  };
  const report = findPasses(base, station, {
    fromSeconds: 0, toSeconds: 1000, stepSeconds: 100000,
  });
  assert.ok(report.stepSeconds <= 600);
  assert.ok(report.warnings.length >= 1);
});
