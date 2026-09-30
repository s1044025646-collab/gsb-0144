import { DB } from '../db/database.js';
import { service } from './service.js';
import { OrbitalElementsInput } from './orbit.js';

/**
 * Entirely fictional but physically consistent fixtures. They do not describe
 * any real spacecraft or facility.
 */
export interface Fixture {
  scenario: { id: string; name: string; theta0Deg: number };
  orbit: { t0: number; elements: OrbitalElementsInput };
  stations: {
    id: string;
    name: string;
    latDeg: number;
    lonDeg: number;
    altM: number;
    minElevDeg: number;
  }[];
  description: string;
}

export const FIXTURES: Record<string, Fixture> = {
  circular: {
    description: 'Near-circular low fictional orbit; equatorial + mid-latitude stations.',
    scenario: { id: 'fx-circular', name: 'Fictional Circular LEO', theta0Deg: 0 },
    orbit: {
      t0: 0,
      elements: { a: 7_000_000, e: 0, iDeg: 53, raanDeg: 30, argpDeg: 0, nu0Deg: 0 },
    },
    stations: [
      { id: 'eq', name: 'Equatorial Fictional Site', latDeg: 0, lonDeg: 20, altM: 0, minElevDeg: 10 },
      { id: 'mid', name: 'Mid-Latitude Fictional Site', latDeg: 45, lonDeg: -75, altM: 100, minElevDeg: 10 },
    ],
  },
  inclinedEllipse: {
    description: 'Tilted eccentric orbit; polar and equatorial stations, cross-day window.',
    scenario: { id: 'fx-ellipse', name: 'Fictional Inclined Ellipse', theta0Deg: 120 },
    orbit: {
      t0: 0,
      elements: { a: 12_000_000, e: 0.35, iDeg: 98, raanDeg: 215, argpDeg: 60, nu0Deg: 200 },
    },
    stations: [
      { id: 'pole', name: 'Polar Fictional Site', latDeg: 89.5, lonDeg: 0, altM: 0, minElevDeg: 5 },
      { id: 'eq', name: 'Equatorial Fictional Site', latDeg: 0, lonDeg: 130, altM: 0, minElevDeg: 5 },
      { id: 'blind', name: 'Never-Sees-It Fictional Site', latDeg: 10, lonDeg: 0, altM: 0, minElevDeg: 80 },
    ],
  },
};

export function seedFixture(db: DB, key: string): Fixture {
  const fx = FIXTURES[key];
  if (!fx) throw new Error(`unknown fixture '${key}'`);
  service.createScenario(db, {
    id: fx.scenario.id,
    name: fx.scenario.name,
    theta0Deg: fx.scenario.theta0Deg,
  });
  service.setOrbit(db, fx.scenario.id, fx.orbit.t0, fx.orbit.elements, `orb-${key}`);
  for (const st of fx.stations) {
    service.addStation(db, fx.scenario.id, st);
  }
  return fx;
}
