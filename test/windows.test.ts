import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezeConstants } from '../src/core/constants.js';
import { toElements, propagateInertial, lookAngles, greenwichAngle, inertialToEcef } from '../src/core/orbit.js';
import { computeWindows } from '../src/core/windows.js';

const c = freezeConstants();
const spin = { theta0: 0, thetaEpoch: 0 };

const epoch = {
  t0: 0,
  elements: toElements({
    a: 7_000_000,
    e: 0,
    iDeg: 53,
    raanDeg: 0,
    argpDeg: 0,
    nu0Deg: 0,
  }),
};

const station = {
  id: 's',
  latDeg: 45,
  lonDeg: 0,
  altM: 0,
  minElevDeg: 10,
};

function elevationAt(t: number) {
  const s = propagateInertial(epoch, c, t);
  const ecef = inertialToEcef(s, greenwichAngle(spin, c, t));
  return lookAngles(station, ecef, c).elevation;
}

test('boundaries are bracketed+bisected, not coarse samples, and meet gate', () => {
  const report = computeWindows(epoch, spin, station, c, {
    start: 0,
    end: 20_000,
    maxStep: 30,
    rootTol: 1e-4,
  });
  assert.ok(report.windows.length >= 1);
  for (const w of report.windows) {
    assert.ok(w.enter !== null && w.exit !== null);
    const enterE = elevationAt(w.enter);
    const exitE = elevationAt(w.exit);
    assert.ok(Math.abs(enterE - station.minElevDeg) < 1e-3, `enter residual ${enterE}`);
    assert.ok(Math.abs(exitE - station.minElevDeg) < 1e-3, `exit residual ${exitE}`);
    assert.ok(w.exit - w.enter > 0);
    assert.ok(w.maxElevation >= station.minElevDeg);
  }
});

test('coarse step larger than visibility never claims a precise false boundary', () => {
  // Wide scan still returns continuous window with bisected roots.
  const report = computeWindows(epoch, spin, station, c, {
    start: 0,
    end: 20_000,
    maxStep: 4000,
  });
  assert.ok(report.warnings.some((w) => w.includes('short visibility')));
  for (const w of report.windows) {
    if (w.enter !== null) {
      assert.ok(Math.abs(elevationAt(w.enter) - 10) < 1e-2);
    }
  }
});

test('unclosed window at interval edges is flagged', () => {
  // Pick an interval known to start inside a pass.
  const first = computeWindows(epoch, spin, station, c, {
    start: 0,
    end: 20_000,
    maxStep: 20,
  });
  const w = first.windows[0];
  assert.ok(w);
  const report = computeWindows(epoch, spin, station, c, {
    start: (w.enter as number) + 5,
    end: (w.exit as number) - 5,
    maxStep: 5,
  });
  assert.equal(report.windows.length, 1);
  assert.equal(report.windows[0].enter, null);
  assert.equal(report.windows[0].exit, null);
  assert.ok(report.warnings.length >= 2);
});

test('invalid range and step are rejected', () => {
  assert.throws(() =>
    computeWindows(epoch, spin, station, c, { start: 10, end: 0, maxStep: 10 }),
  );
  assert.throws(() =>
    computeWindows(epoch, spin, station, c, { start: 0, end: 10, maxStep: 0 }),
  );
});
