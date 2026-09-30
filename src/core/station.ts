import { DEFAULT_CONSTANTS, type ModelConstants } from './constants.ts';
import { radToDeg } from './angle.ts';
import {
  inertialToEarthFixed,
  propagateInertial,
  vecDot,
  vecNorm,
  vecSub,
  type OrbitalElements,
  type Vec3,
} from './orbit.ts';

/**
 * Ground station on the spherical surface.
 * latitude/longitude in radians; altitudeM above the model Earth radius.
 * minElevationRad is the acquisition gate.
 */
export interface Station {
  id?: number;
  name: string;
  latitudeRad: number;
  longitudeRad: number;
  altitudeM: number;
  minElevationRad: number;
}

export interface Observation {
  timeSeconds: number;
  satEarthFixed: Vec3;
  stationEarthFixed: Vec3;
  range: number;
  azimuthRad: number;
  elevationRad: number;
  elevationDeg: number;
  azimuthDeg: number;
}

/** Geocentric station position in the Earth-fixed frame (spherical Earth). */
export function stationPosition(station: Station, c: ModelConstants = DEFAULT_CONSTANTS): Vec3 {
  const R = c.earthRadius + station.altitudeM;
  const clat = Math.cos(station.latitudeRad);
  return {
    x: R * clat * Math.cos(station.longitudeRad),
    y: R * clat * Math.sin(station.longitudeRad),
    z: R * Math.sin(station.latitudeRad),
  };
}

/** Local East-North-Up basis at a station. */
function stationBasis(station: Station): { east: Vec3; north: Vec3; up: Vec3 } {
  const lat = station.latitudeRad;
  const lon = station.longitudeRad;
  const clat = Math.cos(lat);
  const slat = Math.sin(lat);
  const clon = Math.cos(lon);
  const slon = Math.sin(lon);
  // At the exact poles longitude is undefined; keep east continuous (+y at the
  // north pole) so azimuth remains defined for polar-station fixtures.
  const east: Vec3 =
    Math.abs(clat) < 1e-12
      ? { x: -slon, y: clon, z: 0 }
      : { x: -slon, y: clon, z: 0 };
  const north: Vec3 = { x: -slat * clon, y: -slat * slon, z: clat };
  const up: Vec3 = { x: clat * clon, y: clat * slon, z: slat };
  return { east, north, up };
}

/**
 * Geometric observation at an absolute time.
 * Elevation is above the local tangent plane; azimuth is clockwise from north
 * (0=N, π/2=E), wrapped to [0,2π).
 */
export function observe(
  el: OrbitalElements,
  station: Station,
  timeSeconds: number,
  c: ModelConstants = DEFAULT_CONSTANTS,
): Observation {
  const state = propagateInertial(el, timeSeconds, c);
  const satEcf = inertialToEarthFixed(state.position, timeSeconds, c);
  const staEcf = stationPosition(station, c);
  const los = vecSub(satEcf, staEcf);
  const range = vecNorm(los);

  const { east, north, up } = stationBasis(station);
  const upComp = vecDot(los, up) / range;
  const eastComp = vecDot(los, east) / range;
  const northComp = vecDot(los, north) / range;

  const elevationRad = Math.asin(Math.max(-1, Math.min(1, upComp)));
  let azimuthRad = Math.atan2(eastComp, northComp);
  if (azimuthRad < 0) azimuthRad += 2 * Math.PI;

  return {
    timeSeconds,
    satEarthFixed: satEcf,
    stationEarthFixed: staEcf,
    range,
    azimuthRad,
    elevationRad,
    elevationDeg: radToDeg(elevationRad),
    azimuthDeg: radToDeg(azimuthRad),
  };
}
