import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson';
import { deriveHeight, geometryBounds, insideBoundary, validateRing } from '../web/core/geo';
import type { BuildingFeature } from '../web/core/types';

export interface OverpassResponse {
  elements: Record<string, unknown>[];
  osm3s?: { timestamp_osm_base?: string };
}

export function validateOverpass(value: unknown, requireElements = false): OverpassResponse {
  if (!value || typeof value !== 'object') throw new Error('Invalid Overpass response');
  const data = value as Record<string, unknown>;
  if (data.remark) throw new Error(`Overpass incomplete response: ${String(data.remark)}`);
  if (!Array.isArray(data.elements)) throw new Error('Overpass response has no elements array');
  if (requireElements && !data.elements.length) throw new Error('Overpass required layer is empty');
  const osm3s = data.osm3s;
  return {
    elements: data.elements as Record<string, unknown>[],
    osm3s: osm3s && typeof osm3s === 'object' && 'timestamp_osm_base' in osm3s
      && typeof osm3s.timestamp_osm_base === 'string' ? { timestamp_osm_base: osm3s.timestamp_osm_base } : undefined,
  };
}

export function mergeSurfaceData(inputs: unknown[]): OverpassResponse {
  if (inputs.length !== 3) throw new Error('Surface requires roads, water and green datasets.');
  const datasets = inputs.map((input) => validateOverpass(input));
  const elements = new Map<string, Record<string, unknown>>();
  for (const dataset of datasets) {
    for (const element of dataset.elements) elements.set(`${element.type}/${element.id}`, element);
  }
  const timestamps = datasets.flatMap((dataset) => dataset.osm3s?.timestamp_osm_base ? [dataset.osm3s.timestamp_osm_base] : []).sort();
  return { elements: [...elements.values()], osm3s: { timestamp_osm_base: timestamps[0] } };
}

export function normalizeBuildings(collection: FeatureCollection, boundary: Polygon | MultiPolygon) {
  const features: BuildingFeature[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const feature of collection.features) {
    const id = String(feature.id ?? feature.properties?.id ?? '');
    const geometry = feature.geometry;
    const tags = feature.properties ?? {};
    if (!id || seen.has(id) || !tags.building || tags.building === 'no' || !geometry
      || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') || tags.tainted) {
      skipped++;
      continue;
    }
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    if (!polygons.every((rings) => rings.length > 0 && rings.every(validateRing))) {
      skipped++;
      continue;
    }
    const box = geometryBounds(geometry);
    // Include border-crossing footprints; reject buildings wholly outside the municipality.
    if (!insideBoundary([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], boundary)
      && !polygons.some(([ring]) => ring.some((point) => insideBoundary(point, boundary)))) {
      skipped++;
      continue;
    }
    seen.add(id);
    features.push({
      type: 'Feature', geometry,
      properties: {
        id, name: String(tags.name ?? ''), kind: String(tags.building ?? 'yes'),
        ...deriveHeight(tags),
      },
    });
  }
  return { features, skipped };
}
