import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchitecturalMesh } from '../../web/core/architectural-mesh';
import { buildArchitecture, emitArchitecture } from '../../web/core/building-architecture';
import { landmarkFor, landmarks } from '../../web/core/landmarks';
import { partitionArchitecture, createTileset } from '../../pipeline/architecture/tiles';
import { parseCityArchitectureManifest } from '../../web/core/architecture-manifest';
import type { BuildingFeature } from '../../web/core/types';

const heights = [
  ['462717395', 240], ['462717396', 282], ['462717408', 169], ['462717409', 230],
  ['461664710', 145], ['461664711', 200], ['462717390', 221.6], ['462717391', 194.7],
  ['462717385', 160.3], ['462717384', 132.9], ['462717392', 107.8],
  ['522129366', 100], ['522129367', 100], ['482784886', 150], ['482789311', 150],
  ['494180282', 214.8], ['494180284', 164.9],
] as const;
const buildings = ['4826_1252', '4828_1252', '4829_1253'].flatMap(tile =>
  (JSON.parse(readFileSync(`public/data/c8a953228b2ff6af/tiles/${tile}.json`, 'utf8')) as {
    features: BuildingFeature[];
  }).features);

function wheel(): BuildingFeature {
  const definition = landmarks.find(record => record.id === 'suzhou-eye');
  expect(definition, 'the current wheel must be registered, independently of building-only source collection').toBeDefined();
  return {
    type: 'Feature', properties: {
      id: 'way/1332906658', name: '苏州之眼', kind: 'attraction:big_wheel',
      height: 128, basis: 'reference', estimated: false,
    },
    geometry: { type: 'Polygon', coordinates: [[
      [120.7085976, 31.3168759], [120.707673, 31.316811], [120.707722, 31.3166795],
      [120.7079148, 31.3165256], [120.7081187, 31.3163636], [120.7085416, 31.3161626],
      [120.7088632, 31.3160001], [120.7088256, 31.3166857], [120.7085976, 31.3168759],
    ]] },
  };
}

describe('Jinji Lake source-grounded skyline', () => {
  it.each(heights)('models way/%s at %sm without changing original OSM properties', (id, height) => {
    const feature = buildings.find(f => f.properties.id === `way/${id}`)!;
    const before = structuredClone(feature);
    expect(landmarkFor(feature)?.height).toBe(height);
    const triangleCounts: number[] = [];
    for (const lod of ['far', 'mid', 'near'] as const) {
      const mesh = new ArchitecturalMesh(), result = emitArchitecture(mesh, feature, lod);
      expect(result.model?.height).toBe(height);
      expect(result.model?.sources.length).toBeGreaterThan(0);
      const z = [...mesh.getSurfaces().values()].flatMap(surface => surface.positions.filter((_, i) => i % 3 === 2));
      expect(Math.max(...z)).toBeCloseTo(height + 0.5, 2);
      expect(Math.min(...z)).toBeGreaterThanOrEqual(0.49);
      expect(mesh.triangles).toBeLessThan(45_000);
      triangleCounts.push(mesh.triangles);
    }
    expect(triangleCounts[0]).toBeLessThan(triangleCounts[1]);
    expect(triangleCounts[1]).toBeLessThan(triangleCounts[2]);
    const { bytes } = buildArchitecture(feature, 'near'), view = new DataView(bytes);
    const document = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, view.getUint32(12, true))));
    expect(document.nodes[0].extras.source).toEqual(before.properties);
    expect(feature).toEqual(before);
  });

  it('keeps Media Plaza wings low rather than extruding whole parcels to tower height', () => {
    for (const id of ['494180283', '494180285']) {
      const feature = buildings.find(f => f.properties.id === `way/${id}`)!;
      const model = landmarkFor(feature);
      expect(model).toBeDefined();
      expect(model!.height).toBeLessThan(50);
      expect(model!.heightBasis).toBe('estimated');
    }
    for (const id of ['494186753', '482784880']) {
      expect(landmarkFor(buildings.find(f => f.properties.id === `way/${id}`)!)).toBeUndefined();
    }
  });

  it.each(['far', 'mid', 'near'] as const)('renders an open wheel with 28 separate glazed cabins in %s', lod => {
    const feature = wheel(), mesh = new ArchitecturalMesh(), result = emitArchitecture(mesh, feature, lod);
    expect(result.model).toMatchObject({
      id: 'suzhou-eye', height: 128, heightBasis: 'verified',
      source: { type: 'osm-attraction', tags: { attraction: 'big_wheel', name: '苏州之眼' } },
    });
    const positions = [...mesh.getSurfaces().values()].flatMap(surface => surface.positions);
    expect(positions.every(Number.isFinite)).toBe(true);
    const z = positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...z)).toBeCloseTo(128.5, 2);
    expect(Math.min(...z)).toBeGreaterThanOrEqual(0.49);
    expect(mesh.triangles).toBeLessThan(45_000);
    const glass = mesh.getSurfaces().get(6)!;
    expect(glass).toBeDefined();
    const components = new Map<string, Set<string>>();
    const key = (i: number) => glass.positions.slice(i * 3, i * 3 + 3).map(n => n.toFixed(4)).join(',');
    for (let i = 0; i < glass.indices.length; i += 3) {
      const vertices = glass.indices.slice(i, i + 3).map(key);
      for (const a of vertices) {
        const adjacent = components.get(a) ?? new Set<string>();
        vertices.forEach(b => adjacent.add(b));
        components.set(a, adjacent);
      }
    }
    let count = 0;
    while (components.size) {
      count++;
      const pending = [components.keys().next().value!];
      while (pending.length) {
        const point = pending.pop()!, adjacent = components.get(point);
        if (!adjacent) continue;
        components.delete(point);
        pending.push(...adjacent);
      }
    }
    expect(count, 'cabins must be actual disconnected meshes, not a count in metadata').toBe(28);
    // Large solid disks would close the wheel even if it had 28 decorative cabins.
    for (const surface of mesh.getSurfaces().values()) for (let i = 0; i < surface.indices.length; i += 3) {
      const points = surface.indices.slice(i, i + 3).map(index => surface.positions.slice(index * 3, index * 3 + 3));
      const a = points[1].map((v, j) => v - points[0][j]), b = points[2].map((v, j) => v - points[0][j]);
      const area = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]) / 2;
      expect(area).toBeLessThan(200);
    }
  });

  it('accounts separately for a supplemental attraction without pretending it came from the building snapshot', () => {
    const lod = { buildings: 3, tiles: 1, triangles: 100, bytes: 100, decodedBytes: 200 };
    const manifest = {
      version: 1, dataset: 'a'.repeat(16), sourceDataset: 'source', generatedAt: '2026-10-19T00:00:00Z',
      tileset: `${'a'.repeat(16)}/tileset.json`, bounds: [120.66, 31.31, 120.74, 31.33],
      buildings: 3, sourceBuildings: 2, exclusions: [],
      additions: [{ id: 'way/1332906658', kind: 'attraction', evidence: 'OSM attraction=big_wheel; separate 2026-10-19 snapshot.' }],
      lods: { far: lod, mid: lod, near: lod }, inference: 'Approximation',
    };
    expect(parseCityArchitectureManifest(manifest, 'source', 2)).toEqual(manifest);
    for (const invalid of [
      { ...manifest, sourceBuildings: 3 }, { ...manifest, additions: [] },
      { ...manifest, additions: [...manifest.additions, ...manifest.additions] },
      { ...manifest, additions: [{ ...manifest.additions[0], kind: 'building' }] },
    ]) expect(() => parseCityArchitectureManifest(invalid, 'source', 2)).toThrow();
  });

  it('puts each supplemented object in exactly one batch at each LOD with tall bounding volumes', async () => {
    const selected = buildings.filter(f => heights.some(([id]) => `way/${id}` === f.properties.id));
    selected.push(wheel());
    const tree = partitionArchitecture(selected), seen = { far: new Set<string>(), mid: new Set<string>(), near: new Set<string>() };
    const document = await createTileset(tree, async node => {
      for (const feature of node.features) {
        expect(seen[node.lod!].has(feature.properties.id)).toBe(false);
        seen[node.lod!].add(feature.properties.id);
      }
      return { origin: [120.70, 31.32], triangles: 1, vertices: 3, decodedBytes: 100, uri: `${node.id}.glb` };
    });
    expect(document.root.boundingVolume.region[5]).toBeGreaterThan(282);
    Object.values(seen).forEach(ids => expect(ids.size).toBe(selected.length));
  });
});
