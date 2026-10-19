import type { Bounds, BuildingProperties, SceneSettings } from './types';

export type ArchitectureLod = 'near' | 'far';
export interface ArchitectureAsset {
  uri: string;
  bytes: number;
  sha256: string;
  triangles: number;
}
export interface ArchitectureManifest {
  version: 1;
  baseDataset: string;
  origin: [number, number];
  bounds: Bounds;
  buildings: BuildingProperties[];
  inferred: string[];
  lods: Record<ArchitectureLod, ArchitectureAsset>;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid architecture: ${message}`);
}
function object(value: unknown): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
}
function finite(value: unknown): asserts value is number {
  check(typeof value === 'number' && Number.isFinite(value), 'expected finite number');
}
function string(value: unknown): asserts value is string {
  check(typeof value === 'string' && !/[\u0000-\u001f]/.test(value), 'expected text');
}
function tuple(value: unknown, length: number): asserts value is number[] {
  check(Array.isArray(value) && value.length === length, 'coordinate arity');
  value.forEach(finite);
}

export function parseArchitectureManifest(value: unknown, baseDataset: string): ArchitectureManifest {
  object(value);
  check(value.version === 1 && value.baseDataset === baseDataset, 'version or base dataset mismatch');
  tuple(value.origin, 2);
  tuple(value.bounds, 4);
  const [west, south, east, north] = value.bounds;
  check(west >= -180 && east <= 180 && south >= -90 && north <= 90 && west < east && south < north,
    'invalid geographic bounds');
  check(value.origin[0] >= west && value.origin[0] <= east && value.origin[1] >= south && value.origin[1] <= north,
    'origin outside bounds');
  check(Array.isArray(value.buildings) && value.buildings.length > 0 && value.buildings.length <= 100,
    'expected bounded building sample');
  const identifiers = new Set<string>();
  const buildings = value.buildings.map((building: unknown): BuildingProperties => {
    object(building);
    string(building.id); string(building.name); string(building.kind); finite(building.height);
    check(/^(way|relation)\/\d+$/.test(building.id) && !identifiers.has(building.id), 'invalid or duplicate source ID');
    identifiers.add(building.id);
    check(building.height > 0 && building.height <= 500, 'invalid source height');
    check(building.basis === 'height' || building.basis === 'levels' || building.basis === 'fallback', 'unknown height basis');
    check(typeof building.estimated === 'boolean' && building.estimated === (building.basis !== 'height'),
      'height inference must be disclosed');
    return { id: building.id, name: building.name, kind: building.kind, height: building.height,
      basis: building.basis, estimated: building.estimated };
  });
  check(Array.isArray(value.inferred) && value.inferred.length > 0, 'inferred construction disclosure required');
  const inferred = value.inferred.map((item: unknown) => {
    string(item); check(item.trim().length > 0, 'empty inference disclosure'); return item;
  });
  object(value.lods);
  const lods = value.lods;
  const asset = (lod: ArchitectureLod): ArchitectureAsset => {
    const item = lods[lod];
    object(item);
    string(item.uri); string(item.sha256); finite(item.bytes); finite(item.triangles);
    check(new RegExp(`^[a-f0-9]{32}/${lod}\\.glb$`).test(item.uri), 'unsafe or mismatched immutable asset path');
    check(/^[a-f0-9]{64}$/.test(item.sha256), 'invalid SHA-256');
    check(Number.isSafeInteger(item.bytes) && item.bytes > 0, 'invalid asset bytes');
    check(Number.isSafeInteger(item.triangles) && item.triangles > 0
      && item.triangles < (lod === 'near' ? 300000 : 45000), 'triangle budget exceeded');
    return { uri: item.uri, sha256: item.sha256, bytes: item.bytes, triangles: item.triangles };
  };
  const near = asset('near'), far = asset('far');
  check(near.uri.split('/')[0] === far.uri.split('/')[0], 'mixed immutable packages');
  check(near.bytes + far.bytes < 16 * 1024 * 1024, 'download budget exceeded');
  return { version: 1, baseDataset, origin: [value.origin[0], value.origin[1]],
    bounds: [west, south, east, north], buildings, inferred, lods: { near, far } };
}

export function architectureLod(
  distance: number, current?: ArchitectureLod, quality: SceneSettings['quality'] = 'medium',
): ArchitectureLod | undefined {
  if (!Number.isFinite(distance) || distance < 0) throw new RangeError('Invalid architectural camera distance');
  if (distance > (current ? 6500 : 6000)) return undefined;
  if (quality === 'low') return 'far';
  return distance <= (current === 'near' ? 400 : current === 'far' ? 300 : 350) ? 'near' : 'far';
}
