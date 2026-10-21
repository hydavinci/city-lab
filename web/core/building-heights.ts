import type { Bounds, BuildingFeature, BuildingProperties } from './types';
import { geometryBounds } from './geo';
import { landmarkFor } from './landmarks';
import { buildingHeightRecords } from './building-height-references';

export interface BuildingHeightRecord {
  sourceId: string;
  bounds: Bounds;
  name: string;
  height: number;
  approximate?: boolean;
  floors?: number;
  checkedAt: string;
  identity: string;
  sources: { label: string; url: string }[];
}

export interface HeightReference {
  provider: string;
  name: string;
  height: number;
  approximate?: boolean;
  floors?: number;
  checkedAt: string;
  sources: { label: string; url: string }[];
}

export interface BuildingHeightProvider {
  id: string;
  resolve(feature: BuildingFeature): HeightReference | undefined;
}

function metadata(provider: string, record: BuildingHeightRecord): HeightReference {
  const { name, height, approximate, floors, checkedAt, sources } = record;
  return { provider, name, height, ...(approximate === undefined ? {} : { approximate }),
    ...(floors === undefined ? {} : { floors }), checkedAt,
    sources: sources.map(source => ({ ...source })) };
}

export function createHeightProvider(id: string, records: readonly BuildingHeightRecord[]): BuildingHeightProvider {
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid building height provider ID.');
  const indexed = new Map<string, BuildingHeightRecord>();
  for (const record of records) {
    if (indexed.has(record.sourceId)) throw new Error(`Duplicate building height record: ${record.sourceId}`);
    if (!/^way\/\d+$|^relation\/\d+$/.test(record.sourceId) || !record.name.trim()
      || !Number.isFinite(record.height) || record.height <= 0 || record.height > 1000
      || record.approximate !== undefined && typeof record.approximate !== 'boolean'
      || record.floors !== undefined && (!Number.isSafeInteger(record.floors) || record.floors <= 0 || record.floors > 200)
      || !/^\d{4}-\d{2}-\d{2}$/.test(record.checkedAt) || !Number.isFinite(Date.parse(record.checkedAt))
      || !record.identity.trim() || record.bounds.length !== 4 || !record.bounds.every(Number.isFinite)
      || record.bounds[0] >= record.bounds[2] || record.bounds[1] >= record.bounds[3]
      || record.bounds[0] < -180 || record.bounds[2] > 180 || record.bounds[1] < -90 || record.bounds[3] > 90
      || !record.sources.length || record.sources.some(source => !source.label.trim() || !/^https:\/\/[^/\s]+\/\S*$/.test(source.url))) {
      throw new Error(`Invalid building height record: ${record.sourceId}`);
    }
    indexed.set(record.sourceId, structuredClone(record));
  }
  return {
    id,
    resolve(feature) {
      if (feature.properties.basis !== 'fallback' || !feature.properties.estimated) return undefined;
      const record = indexed.get(feature.properties.id);
      if (!record || landmarkFor(feature)) return undefined;
      const bounds = geometryBounds(feature.geometry);
      if (bounds.some((value, axis) => !Number.isFinite(value) || Math.abs(value - record.bounds[axis]) > 0.00002)) {
        throw new Error(`Height reference footprint changed; review its identity: ${record.sourceId}`);
      }
      return metadata(id, record);
    },
  };
}

export const verifiedHeightProvider = createHeightProvider('verified-building-heights-v1', buildingHeightRecords);
export const referenceHeightFor = (feature: BuildingFeature): HeightReference | undefined => verifiedHeightProvider.resolve(feature);

export function parseHeightReference(input: unknown, source: BuildingProperties): HeightReference | undefined {
  if (input === undefined || input === '') return undefined;
  const record = buildingHeightRecords.find(record => record.sourceId === source.id);
  const reference = record && metadata(verifiedHeightProvider.id, record);
  if (source.basis !== 'fallback' || !source.estimated || !reference || input !== JSON.stringify(reference)) {
    throw new Error('Invalid or outdated architecture height metadata.');
  }
  return reference;
}
