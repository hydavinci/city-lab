import type { BuildingFeature, SceneSettings } from './types';

export type CityStyle = 'historic' | 'residential' | 'office' | 'commercial' | 'industrial' | 'neutral';
export type CityLod = 'near' | 'mid';

export function cityStyle(feature: BuildingFeature): CityStyle {
  const { kind, height } = feature.properties;
  if (/^(temple|shrine|pagoda)$/.test(kind)) return 'historic';
  if (/^(apartments|residential|house|detached|terrace|dormitory)$/.test(kind)) return 'residential';
  if (/^(office|civic|government)$/.test(kind)) return 'office';
  if (/^(commercial|retail|hotel|supermarket)$/.test(kind)) return 'commercial';
  if (/^(industrial|warehouse|garage|garages|shed)$/.test(kind)) return 'industrial';
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const points = polygons.flatMap(p => p[0]);
  // This envelope infers a regional style, never a surveyed building classification.
  if (height <= 15 && points.length && points.every(([x, y]) => x >= 120.595 && x <= 120.642 && y >= 31.29 && y <= 31.34)) {
    const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
    const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
    if ((maxX - minX) * (maxY - minY) * 10560000000 <= 1800) return 'historic';
  }
  return 'neutral';
}

export function cityLod(distance: number, previous?: CityLod, quality: SceneSettings['quality'] = 'medium'): CityLod | undefined {
  if (!Number.isFinite(distance) || distance < 0) throw new Error('Invalid city architecture distance.');
  if (distance > (previous ? 1050 : 950)) return undefined;
  if (quality === 'low') return 'mid';
  const near = previous === 'near' ? 280 : previous === 'mid' ? 210 : 240;
  return distance <= near ? 'near' : 'mid';
}

export function cityBudget(quality: SceneSettings['quality']): { near: number; mid: number; triangles: number; bytes: number } {
  return {
    low: { near: 0, mid: 48, triangles: 160_000, bytes: 16 * 1024 * 1024 },
    medium: { near: 36, mid: 100, triangles: 650_000, bytes: 64 * 1024 * 1024 },
    high: { near: 72, mid: 180, triangles: 1_300_000, bytes: 128 * 1024 * 1024 },
  }[quality];
}
