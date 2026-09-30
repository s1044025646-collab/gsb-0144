import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES, fixturePeriod, INVALID_CASES } from '../src/fixtures/fixtures.ts';
import { findPasses } from '../src/core/passes.ts';
import { orbitalPeriod, validateElements } from '../src/core/orbit.ts';
import { observe } from '../src/core/station.ts';
import { DEFAULT_CONSTANTS } from '../src/core/constants.ts';

function asElements(f: (typeof FIXTURES)[string]) {
  return {
    semiMajorAxis: f.orbit.semiMajorAxis,
    eccentricity: f.orbit.eccentricity,
    inclination: f.orbit.inclinationRad,
    raan: f.orbit.raanRad,
    argPerigee: f.orbit.argPerigeeRad,
    meanAnomalyAtEpoch: f.orbit.meanAnomalyAtEpochRad,
    epochSeconds: f.orbit.epochSeconds,
  };
}

test('all valid fixtures pass validation', () => {
  for (const [name, f] of Object.entries(FIXTURES)) {
    assert.equal(validateElements(asElements(f)).ok, true, name);
  }
});

test('all invalid fixtures are rejected', () => {
  for (const c of INVALID_CASES) {
    const v = validateElements({
      semiMajorAxis: c.orbit.semiMajorAxis,
      eccentricity: c.orbit.eccentricity,
      inclination: c.orbit.inclinationRad,
      raan: c.orbit.raanRad,
      argPerigee: c.orbit.argPerigeeRad,
      meanAnomalyAtEpoch: c.orbit.meanAnomalyAtEpochRad,
      epochSeconds: c.orbit.epochSeconds,
    });
    assert.equal(v.ok, false, c.name);
  }
});

test('circular equatorial fixture produces passes across a day; some cross-day windows', () => {
  const f = FIXTURES.circularEquatorial;
  const el = asElements(f);
  const day = 86400;
  const report = findPasses(el, f.station, {
    fromSeconds: f.orbit.epochSeconds,
    toSeconds: f.orbit.epochSeconds + day,
    stepSeconds: 30,
  });
  assert.ok(report.windows.length > 0);
  // Every closed boundary must sit on the 10deg gate.
  for (const w of report.windows) {
    if (w.startSeconds !== null)
      assert.ok(Math.abs(observe(el, f.station, w.startSeconds).elevationDeg - 10) < 1e-2);
    if (w.endSeconds !== null)
      assert.ok(Math.abs(observe(el, f.station, w.endSeconds).elevationDeg - 10) < 1e-2);
  }
});

test('inclined ellipse: period consistent with Kepler III and passes exist over 2 days', () => {
  const f = FIXTURES.inclinedEllipse;
  const el = asElements(f);
  assert.ok(Math.abs(fixturePeriod(f) - orbitalPeriod(el)) < 1e-6);
  const report = findPasses(el, f.station, {
    fromSeconds: f.orbit.epochSeconds,
    toSeconds: f.orbit.epochSeconds + 2 * 86400,
    stepSeconds: 40,
  });
  assert.ok(report.windows.length > 0);
});

test('polar station fixture returns finite azimuth even at the exact pole', () => {
  const f = FIXTURES.polarStation;
  const el = asElements(f);
  const obs = observe(el, f.station, f.orbit.epochSeconds + 1200);
  assert.ok(Number.isFinite(obs.azimuthDeg));
  assert.ok(obs.azimuthDeg >= 0 && obs.azimuthDeg <= 360);
});

test('no-pass fixture has zero windows in a short interval', () => {
  const f = FIXTURES.noPass;
  const el = asElements(f);
  const report = findPasses(el, f.station, {
    fromSeconds: f.orbit.epochSeconds,
    toSeconds: f.orbit.epochSeconds + orbitalPeriod(el),
    stepSeconds: 60,
  });
  assert.equal(report.windows.length, 0);
});

test('search interval starting inside a pass yields an open-at-start window', () => {
  const f = FIXTURES.circularEquatorial;
  const el = asElements(f);
  // First find a real window, then start the search inside it.
  const full = findPasses(el, f.station, {
    fromSeconds: f.orbit.epochSeconds,
    toSeconds: f.orbit.epochSeconds + 40000,
    stepSeconds: 30,
  });
  const w = full.windows.find((x) => x.startSeconds !== null && x.endSeconds !== null);
  assert.ok(w);
  const mid = ((w!.startSeconds as number) + (w!.endSeconds as number)) / 2;
  const report = findPasses(el, f.station, {
    fromSeconds: mid,
    toSeconds: mid + 100000,
    stepSeconds: 30,
  });
  assert.ok(report.windows[0]?.openAtStart === true);
  assert.ok(report.unclosedWindowCount >= 1);
});

test('unit equivalence: degree/radian gates agree numerically', () => {
  const f = FIXTURES.circularEquatorial;
  const el = asElements(f);
  const args = {
    fromSeconds: f.orbit.epochSeconds,
    toSeconds: f.orbit.epochSeconds + 30000,
    stepSeconds: 30,
  };
  const byRad = findPasses(el, f.station, { ...args, minElevationRad: 0.17453292519943295 });
  const byDeg = findPasses(el, f.station, { ...args });
  assert.equal(byRad.windows.length, byDeg.windows.length);
});

test('model constants are frozen', () => {
  assert.equal(Object.isFrozen(DEFAULT_CONSTANTS), true);
  assert.throws(() => {
    (DEFAULT_CONSTANTS as { mu: number }).mu = 1;
  });
});
