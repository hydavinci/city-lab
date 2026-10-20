import type { Bounds } from './types';
import type { ArchitectureAddition, ArchitectureExclusion } from './landmarks';

export interface ArchitectureManifest {
  version: 1;
  dataset: string;
  sourceDataset: string;
  generatedAt: string;
  tileset: string;
  bounds: Bounds;
  buildings: number;
  sourceBuildings?: number;
  exclusions?: ArchitectureExclusion[];
  additions?: ArchitectureAddition[];
  heightReferences?: { provider: string; buildings: number };
  lods: Record<'far' | 'mid' | 'near', {
    buildings: number; tiles: number; triangles: number; bytes: number; decodedBytes: number;
  }>;
  inference: string;
}

export function parseCityArchitectureManifest(input: unknown, sourceDataset: string, buildings?: number): ArchitectureManifest {
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
  if (!object(input) || input.version !== 1 || input.sourceDataset !== sourceDataset
    || typeof input.dataset !== 'string' || !/^[a-f0-9]{16}$/.test(input.dataset)
    || input.tileset !== `${input.dataset}/tileset.json` || !positive(input.buildings)
    || typeof input.generatedAt !== 'string' || !Number.isFinite(Date.parse(input.generatedAt))
    || typeof input.inference !== 'string' || !input.inference
    || !Array.isArray(input.bounds) || input.bounds.length !== 4 || !input.bounds.every(Number.isFinite)
    || input.bounds[0] >= input.bounds[2] || input.bounds[1] >= input.bounds[3] || !object(input.lods)) {
    throw new Error('Invalid or source-mismatched city architecture manifest.');
  }
  let sourceBuildings = input.buildings;
  if (input.sourceBuildings !== undefined || input.exclusions !== undefined || input.additions !== undefined) {
    const additions = input.additions === undefined ? [] : input.additions;
    if (!positive(input.sourceBuildings) || !Array.isArray(input.exclusions) || !Array.isArray(additions)
      || input.exclusions.length + additions.length === 0
      || input.exclusions.some(entry => !object(entry) || typeof entry.id !== 'string'
        || !/^(way|relation)\/\d+$/.test(entry.id) || entry.reason !== 'underground'
        || typeof entry.evidence !== 'string' || !entry.evidence.trim())
      || additions.some(entry => !object(entry) || typeof entry.id !== 'string'
        || !/^(node|way|relation)\/\d+$/.test(entry.id) || entry.kind !== 'attraction'
        || typeof entry.evidence !== 'string' || !entry.evidence.trim())
      || new Set([...input.exclusions, ...additions].map(entry => entry.id)).size !== input.exclusions.length + additions.length
      || input.sourceBuildings - input.exclusions.length + additions.length !== input.buildings) {
      throw new Error('Invalid city architecture source exclusion/addition accounting.');
    }
    sourceBuildings = input.sourceBuildings;
  }
  if (buildings !== undefined && sourceBuildings !== buildings) throw new Error('City architecture source building count mismatch.');
  if (input.heightReferences !== undefined) {
    const references = input.heightReferences;
    if (!object(references) || typeof references.provider !== 'string' || !/^[\w-]+$/.test(references.provider)
      || !positive(references.buildings) || references.buildings > input.buildings) {
      throw new Error('Invalid city architecture height reference accounting.');
    }
  }
  for (const lod of ['far', 'mid', 'near']) {
    const item = input.lods[lod];
    if (!object(item) || item.buildings !== input.buildings
      || !['tiles', 'triangles', 'bytes', 'decodedBytes'].every(key => positive(item[key]))) {
      throw new Error(`Incomplete city architecture LOD: ${lod}.`);
    }
  }
  return input as unknown as ArchitectureManifest;
}
