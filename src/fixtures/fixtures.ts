import type { OrbitInput } from '../api/repo.ts';
import type { StationInput } from '../core/station.ts';
import { DEFAULT_CONSTANTS } from '../core/constants.ts';
import { orbitalPeriod } from '../core/orbit.ts';

const D = Math.PI / 180;

/**
 * Fictional, self-consistent fixtures. They do not correspond to any real
 * spacecraft or ground facility.
 */
export interface Fixture {
  orbit: OrbitInput;
  station: StationInput;
}

export const EPOCH = 1_700_000_000; // fixed fictional unix epoch

export const FIXTURES: Record<string, Fixture> = {
  // Circular, moderately inclined orbit; equatorial station.
  circularEquatorial: {
    orbit: {
      semiMajorAxis: 7_000_000,
      eccentricity: 0,
      inclinationRad: 45 * D,
      raanRad: 0,
      argPerigeeRad: 0,
      meanAnomalyAtEpochRad: 0,
      epochSeconds: EPOCH,
    },
    station: {
      name: 'FIX-equator',
      latitudeRad: 0,
      longitudeRad: 10 * D,
      altitudeM: 0,
      minElevationRad: 10 * D,
    },
  },
  // Inclined eccentric ellipse; mid-latitude station.
  inclinedEllipse: {
    orbit: {
      semiMajorAxis: 9_000_000,
      eccentricity: 0.25,
      inclinationRad: 63 * D,
      raanRad: 30 * D,
      argPerigeeRad: 90 * D,
      meanAnomalyAtEpochRad: 200 * D,
      epochSeconds: EPOCH,
    },
    station: {
      name: 'FIX-midlat',
      latitudeRad: 40 * D,
      longitudeRad: -75 * D,
      altitudeM: 100,
      minElevationRad: 5 * D,
    },
  },
  // Polar pass geometry: inclined orbit + north-pole station.
  polarStation: {
    orbit: {
      semiMajorAxis: 7_200_000,
      eccentricity: 0.001,
      inclinationRad: 90 * D,
      raanRad: 0,
      argPerigeeRad: 0,
      meanAnomalyAtEpochRad: 90 * D,
      epochSeconds: EPOCH,
    },
    station: {
      name: 'FIX-northpole',
      latitudeRad: 90 * D,
      longitudeRad: 0,
      altitudeM: 0,
      minElevationRad: 10 * D,
    },
  },
  // Geometry that yields no pass over the requested short interval.
  noPass: {
    orbit: {
      semiMajorAxis: 7_000_000,
      eccentricity: 0,
      inclinationRad: 0.1 * D,
      raanRad: 0,
      argPerigeeRad: 0,
      meanAnomalyAtEpochRad: 0,
      epochSeconds: EPOCH,
    },
    station: {
      name: 'FIX-far',
      latitudeRad: -80 * D,
      longitudeRad: 170 * D,
      altitudeM: 0,
      minElevationRad: 20 * D,
    },
  },
};

export function fixturePeriod(f: Fixture): number {
  return orbitalPeriod(
    {
      semiMajorAxis: f.orbit.semiMajorAxis,
      eccentricity: f.orbit.eccentricity,
      inclination: f.orbit.inclinationRad,
      raan: f.orbit.raanRad,
      argPerigee: f.orbit.argPerigeeRad,
      meanAnomalyAtEpoch: f.orbit.meanAnomalyAtEpochRad,
      epochSeconds: f.orbit.epochSeconds,
    },
    DEFAULT_CONSTANTS,
  );
}

/** Invalid inputs used to exercise rejection paths. */
export const INVALID_CASES: { name: string; orbit: Partial<OrbitInput>; expectCode: string }[] = [
  {
    name: 'hyperbolic',
    expectCode: 'UNSUPPORTED_ORBIT',
    orbit: {
      semiMajorAxis: 9_000_000,
      eccentricity: 1.4,
      inclinationRad: 0,
      raanRad: 0,
      argPerigeeRad: 0,
      meanAnomalyAtEpochRad: 0,
      epochSeconds: EPOCH,
    },
  },
  {
    name: 'parabolic',
    expectCode: 'UNSUPPORTED_ORBIT',
    orbit: {
      semiMajorAxis: 9_000_000,
      eccentricity: 1,
      inclinationRad: 0,
      raanRad: 0,
      argPerigeeRad: 0,
      meanAnomalyAtEpochRad: 0,
      epochSeconds: EPOCH,
    },
  },
  {
    name: 'subsurface-perigee',
    expectCode: 'UNSUPPORTED_ORBIT',
    orbit: {
      semiMajorAxis: 6_500_000,
      eccentricity: 0.1,
      inclinationRad: 0,
      raanRad: 0,
      argPerigeeRad: 0,
      meanAnomalyAtEpochRad: 0,
      epochSeconds: EPOCH,
    },
  },
];
