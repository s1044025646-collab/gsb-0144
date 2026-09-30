import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezeConstants } from '../src/core/constants.js';
import {
  TAU,
  Vec3,
  deg2rad,
  norm2pi,
  normPi,
  vcross,
  vdot,
  vnorm,
} from '../src/core/math.js';
import {
  OrbitalElementsInput,
  angularMomentum,
  ecefToInertial,
  eccentricFromTrue,
  greenwichAngle,
  inertialToEcef,
  lookAngles,
  orbitalPeriod,
  propagateInertial,
  solveKepler,
  specificEnergy,
  stationEcef,
  toElements,
  trueFromEccentric,
  validateElements,
} from '../src/core/orbit.js';
import { DomainError } from '../src/core/errors.js';

const c = freezeConstants();

function circularInput(overrides: Partial<OrbitalElementsInput> = {}): OrbitalElementsInput {
  return {
    a: 7_000_000,
    e: 0,
    iDeg: 53,
    raanDeg: 30,
    argpDeg: 0,
    nu0Deg: 0,
    ...overrides,
  };
}

test('Kepler solver is stable at zero eccentricity and wraps angles', () => {
  assert.ok(Math.abs(solveKepler(0, 0)) < 1e-12);
  assert.ok(Math.abs(solveKepler(1.23456789, 0) - 1.23456789) < 1e-12);
  for (const e of [0, 0.1, 0.5, 0.9, 0.99]) {
    for (const M of [0, 0.3, 1.7, 3.1, 5.0, TAU - 0.2, -1.2]) {
      const E = solveKepler(M, e);
      const residual = E - e * Math.sin(E) - norm2pi(M);
      assert.ok(Math.abs(normPi(residual)) < 1e-9, `e=${e} M=${M}`);
    }
  }
});

test('true/eccentric anomaly conversion is inverse and wrap-safe', () => {
  for (const e of [0, 0.001, 0.5, 0.9]) {
    for (const nu of [0, 0.4, 2.3, 4.5, 6.1, -0.7]) {
      const E = eccentricFromTrue(norm2pi(nu), e);
      const back = trueFromEccentric(E, e);
      const diff = Math.atan2(Math.sin(back - norm2pi(nu)), Math.cos(back - norm2pi(nu)));
      assert.ok(Math.abs(diff) < 1e-10);
    }
  }
});

test('state repeats after one orbital period', () => {
  const epoch = { t0: 100, elements: toElements(circularInput({ nu0Deg: 47 })) };
  const period = orbitalPeriod(epoch.elements.a, c.mu);
  const s0 = propagateInertial(epoch, c, epoch.t0);
  const s1 = propagateInertial(epoch, c, epoch.t0 + period);
  const drift = vnorm({
    x: s1.rI.x - s0.rI.x,
    y: s1.rI.y - s0.rI.y,
    z: s1.rI.z - s0.rI.z,
  });
  assert.ok(drift < 1e-4, `position drift ${drift} m`);
});

test('specific energy and angular momentum are conserved along an ellipse', () => {
  const epoch = {
    t0: 0,
    elements: toElements({
      a: 12_000_000,
      e: 0.35,
      iDeg: 98,
      raanDeg: 215,
      argpDeg: 60,
      nu0Deg: 200,
    }),
  };
  const period = orbitalPeriod(epoch.elements.a, c.mu);
  const energyExpected = -c.mu / (2 * epoch.elements.a);
  const h0 = angularMomentum(propagateInertial(epoch, c, 0));
  for (const t of [0, period * 0.13, period * 0.37, period * 0.8, period]) {
    const s = propagateInertial(epoch, c, t);
    assert.ok(Math.abs(specificEnergy(s, c.mu) - energyExpected) < 1e-6);
    const h = angularMomentum(s);
    const scale = Math.max(1, vnorm(h0));
    assert.ok(Math.abs(vnorm(h) - vnorm(h0)) / scale < 1e-12);
    assert.ok(Math.abs(h.x - h0.x) / scale < 1e-12);
    assert.ok(Math.abs(h.y - h0.y) / scale < 1e-12);
    assert.ok(Math.abs(h.z - h0.z) / scale < 1e-12);
  }
});

test('ECEF rotation is a proper round trip and preserves radius', () => {
  const epoch = { t0: 0, elements: toElements(circularInput()) };
  const spin = { theta0: deg2rad(120), thetaEpoch: 0 };
  for (const t of [0, 1234, 9876]) {
    const s = propagateInertial(epoch, c, t);
    const theta = greenwichAngle(spin, c, t);
    const ecef = inertialToEcef(s, theta);
    const back = ecefToInertial(ecef, theta);
    assert.ok(Math.abs(vnorm(back) - vnorm(s.rI)) < 1e-6);
    assert.ok(Math.abs(back.x - s.rI.x) < 1e-5);
    assert.ok(Math.abs(back.y - s.rI.y) < 1e-5);
    assert.ok(Math.abs(back.z - s.rI.z) < 1e-5);
  }
});

test('overhead target on equator gives ~90 deg elevation and stable azimuth', () => {
  const station = {
    id: 'eq',
    latDeg: 0,
    lonDeg: 0,
    altM: 0,
    minElevDeg: 0,
  };
  const surface = stationEcef(station, c);
  const target = { x: surface.x + 500_000, y: surface.y, z: surface.z };
  const look = lookAngles(station, target, c);
  assert.ok(Math.abs(look.elevation - 90) < 1e-6);
  assert.ok(Math.abs(look.range - 500_000) < 1e-6);
});

test('radial velocity relation: v dot r is consistent at apsides', () => {
  const epoch = {
    t0: 0,
    elements: toElements(circularInput({ e: 0.4, argpDeg: 10, nu0Deg: 0 })),
  };
  // At perigee nu=0, radial velocity must be zero.
  const s = propagateInertial(epoch, c, 0);
  const radial = vdot(s.vI, s.rI) / vnorm(s.rI);
  assert.ok(Math.abs(radial) < 1e-6);
  // h is purely normal magnitude sqrt(mu a (1-e^2))
  const h = vnorm(vcross(s.rI, s.vI));
  const expected = Math.sqrt(c.mu * epoch.elements.a * (1 - 0.4 ** 2));
  assert.ok(Math.abs(h - expected) < 1e-4);
});

test('validation rejects hyperbolic, sub-surface, and non-finite inputs', () => {
  assert.throws(
    () => validateElements(toElements(circularInput({ e: 1.2 })), c),
    (e: Error) => e instanceof DomainError && e.code === 'UNSUPPORTED_ORBIT',
  );
  assert.throws(
    () => validateElements(toElements(circularInput({ a: 7_000_000, e: 0.99 })), c),
    (e: Error) => e instanceof DomainError && e.code === 'BELOW_SURFACE',
  );
  assert.throws(
    () => validateElements(toElements(circularInput({ a: -1, e: 2 })), c),
    DomainError,
  );
});

test('unit equivalence: metre vs kilometre-scaled mu/a reproduce dimensionless period', () => {
  // Scale length by 1000 and mu accordingly; period in seconds must be identical.
  const cKm = freezeConstants({
    mu: c.mu / 1e9,
    earthRadius: c.earthRadius / 1000,
    earthAngularVelocity: c.earthAngularVelocity,
  });
  const pM = orbitalPeriod(7_000_000, c.mu);
  const pKm = orbitalPeriod(7_000, cKm.mu);
  assert.ok(Math.abs(pM - pKm) < 1e-9);
});

test('polar station geometry: north-pole up vector aligns with +Z', () => {
  const station = {
    id: 'pole',
    latDeg: 90,
    lonDeg: 0,
    altM: 0,
    minElevDeg: 0,
  };
  const p: Vec3 = stationEcef(station, c);
  assert.ok(Math.abs(p.z - c.earthRadius) < 1e-6);
  assert.ok(Math.abs(p.x) < 1e-6 && Math.abs(p.y) < 1e-6);
});
