import { Cartesian3, Matrix4, Transforms } from 'cesium';
import { geometryBounds } from '../../web/core/geo';
import type { ArchitectureLod } from '../../web/core/building-architecture';
import type { Bounds, BuildingFeature } from '../../web/core/types';
import type { ArchitectureBatch } from './mesh';
import { architectureExclusionFor, landmarkFor } from '../../web/core/landmarks';
import { referenceHeightFor } from '../../web/core/building-heights';

export interface ArchitectureTile {
  id: string; bounds: Bounds; features: BuildingFeature[]; lod?: ArchitectureLod; children: ArchitectureTile[];
}
export interface TileDocument {
  boundingVolume: { region: number[] };
  geometricError: number;
  refine: 'REPLACE';
  transform?: number[];
  content?: { uri: string };
  children?: TileDocument[];
  extras: { buildings: number; lod?: ArchitectureLod; triangles?: number; decodedBytes?: number };
}

function boundsOf(features: BuildingFeature[]): Bounds {
  const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of features) {
    const box = geometryBounds(feature.geometry);
    bounds[0] = Math.min(bounds[0], box[0]); bounds[1] = Math.min(bounds[1], box[1]);
    bounds[2] = Math.max(bounds[2], box[2]); bounds[3] = Math.max(bounds[3], box[3]);
  }
  return bounds;
}

function spans(bounds: Bounds): [number, number] {
  return [(bounds[2] - bounds[0]) * 111320 * Math.cos((bounds[1] + bounds[3]) * Math.PI / 360),
    (bounds[3] - bounds[1]) * 111320];
}

function halves(features: BuildingFeature[], bounds: Bounds): BuildingFeature[][] {
  const span = spans(bounds), axis = span[0] > span[1] ? 0 : 1;
  const sorted = features.map(feature => ({ feature, box: geometryBounds(feature.geometry) }))
    .sort((a, b) => a.box[axis] + a.box[axis + 2] - b.box[axis] - b.box[axis + 2]
      || a.feature.properties.id.localeCompare(b.feature.properties.id)).map(entry => entry.feature);
  const middle = Math.ceil(sorted.length / 2);
  return [sorted.slice(0, middle), sorted.slice(middle)];
}

function groups(features: BuildingFeature[], count: number, metres: number): BuildingFeature[][] {
  const bounds = boundsOf(features);
  if (features.length === 1 || features.length <= count && Math.max(...spans(bounds)) <= metres) return [features];
  return halves(features, bounds).flatMap(part => groups(part, count, metres));
}

export function partitionArchitecture(input: BuildingFeature[]): ArchitectureTile {
  if (!input.length) throw new Error('Empty city architecture dataset.');
  if (new Set(input.map(f => f.properties.id)).size !== input.length) throw new Error('Duplicate building ID in city architecture.');
  const features = [...input].sort((a, b) => a.properties.id.localeCompare(b.properties.id));
  const content = (features: BuildingFeature[], id: string, lod: ArchitectureLod): ArchitectureTile => ({
    id, features, lod, bounds: boundsOf(features),
    children: lod === 'near' ? [] : groups(features, lod === 'far' ? 64 : 16, lod === 'far' ? 700 : 240)
      .map((part, i) => content(part, `${id}-${i}`, lod === 'far' ? 'mid' : 'near')),
  });
  const spatial = (features: BuildingFeature[], id: string): ArchitectureTile => {
    const bounds = boundsOf(features);
    if (features.length === 1 || features.length <= 256 && Math.max(...spans(bounds)) <= 2400) return content(features, id, 'far');
    return { id, features, bounds, children: halves(features, bounds).map((part, i) => spatial(part, `${id}-${i}`)) };
  };
  const excluded = new Set(features.filter(architectureExclusionFor).map(feature => feature.properties.id));
  const rendered = (node: ArchitectureTile): ArchitectureTile | undefined => {
    const features = node.features.filter(feature => !excluded.has(feature.properties.id));
    if (!features.length) return undefined;
    const bounds: Bounds = [...node.bounds];
    for (const feature of features) {
      const model = landmarkFor(feature);
      if (!model) continue;
      // Include eaves, facade relief and the historical lean beyond the frozen footprint.
      const dy = 20 / 111320, dx = dy / Math.cos((model.bounds[1] + model.bounds[3]) * Math.PI / 360);
      bounds[0] = Math.min(bounds[0], model.bounds[0] - dx); bounds[1] = Math.min(bounds[1], model.bounds[1] - dy);
      bounds[2] = Math.max(bounds[2], model.bounds[2] + dx); bounds[3] = Math.max(bounds[3], model.bounds[3] + dy);
    }
    return { ...node, features, bounds, children: node.children.flatMap(child => {
      const result = rendered(child);
      return result ? [result] : [];
    }) };
  };
  // Partition the complete source first so one exclusion cannot renumber unrelated batches.
  const root = rendered(spatial(features, 'r'));
  if (!root) throw new Error('No above-ground architecture remains after source exclusions.');
  return root;
}

export async function createTileset(
  root: ArchitectureTile,
  encode: (node: ArchitectureTile) => Promise<Omit<ArchitectureBatch, 'bytes'> & { uri: string }>,
) {
  const visit = async (node: ArchitectureTile, parent: Matrix4): Promise<TileDocument> => {
    const radians = Math.PI / 180;
    const document: TileDocument = {
      boundingVolume: { region: [
        node.bounds[0] * radians, node.bounds[1] * radians, node.bounds[2] * radians, node.bounds[3] * radians,
        0, Math.max(...node.features.map(f => landmarkFor(f)?.height ?? referenceHeightFor(f)?.height ?? f.properties.height)) + 20,
      ] },
      geometricError: node.lod === 'near' ? 0 : node.lod === 'mid' ? 3 : node.lod === 'far' ? 24 : Math.max(64, ...spans(node.bounds)),
      refine: 'REPLACE', extras: { buildings: node.features.length, ...(node.lod ? { lod: node.lod } : {}) },
    };
    let transform = parent;
    if (node.lod) {
      const batch = await encode(node);
      transform = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(...batch.origin));
      document.transform = Matrix4.toArray(Matrix4.multiply(Matrix4.inverseTransformation(parent, new Matrix4()), transform, new Matrix4()));
      document.content = { uri: batch.uri };
      document.extras.triangles = batch.triangles; document.extras.decodedBytes = batch.decodedBytes;
    }
    if (node.children.length) {
      document.children = [];
      for (const child of node.children) document.children.push(await visit(child, transform));
    }
    return document;
  };
  const document = await visit(root, Matrix4.IDENTITY);
  return { asset: { version: '1.1' }, geometricError: document.geometricError, root: document };
}
