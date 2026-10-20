import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { buildBatch } from '../../pipeline/architecture/mesh';
import { buildArchitecture, emitArchitecture } from '../../web/core/building-architecture';
import { ArchitecturalMesh, type ArchitectureMaterial } from '../../web/core/architectural-mesh';
import * as compaction from '../../pipeline/architecture/compact';
import { polygonArea, projectRings, type XY } from '../../web/core/architectural-geometry';
import type { BuildingFeature } from '../../web/core/types';

interface View {
  buffer: number; byteOffset?: number; byteLength: number; byteStride?: number;
  extensions?: { EXT_meshopt_compression: {
    buffer: number; byteOffset: number; byteLength: number; byteStride: number; count: number;
    mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES'; filter?: 'NONE';
  } };
}
interface Gltf {
  extensionsRequired: string[];
  nodes: { mesh: number; translation: number[]; scale: number[] }[];
  meshes: { primitives: {
    attributes: Record<string, number>; indices: number; material: number;
    extensions: { EXT_mesh_features: { featureIds: { featureCount: number; attribute: number; propertyTable: number }[] } };
  }[] }[];
  materials: ArchitectureMaterial[];
  accessors: { bufferView: number; byteOffset?: number; componentType: number; normalized?: boolean; type: string; count: number }[];
  bufferViews: View[];
  buffers: { byteLength: number; extensions?: { EXT_meshopt_compression: { fallback: boolean } } }[];
  extensions: { EXT_structural_metadata: {
    schema: { classes: { building: { properties: Record<string, { type: string }> } } };
    propertyTables: { count: number; properties: Record<string, { values: number; stringOffsets?: number }> }[];
  } };
}

function fixture(id: string, kind = 'yes', height = 12.8, courtyard = false, dx = 0): BuildingFeature {
  const outer = [[120.62, 31.32], [120.6203, 31.32], [120.6203, 31.3202], [120.62, 31.3202], [120.62, 31.32]];
  const hole = [[120.6201, 31.32007], [120.6202, 31.32007], [120.6202, 31.32014], [120.6201, 31.32014], [120.6201, 31.32007]];
  return { type: 'Feature', properties: { id, name: '苏州 source', kind, height, basis: 'levels', estimated: true },
    geometry: { type: 'Polygon', coordinates: (courtyard ? [outer, hole] : [outer]).map(ring => ring.map(([x, y]) => [x + dx, y])) } };
}

async function unpack(bytes: Uint8Array) {
  await MeshoptDecoder.ready;
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(header.getUint32(0, true)).toBe(0x46546c67);
  expect(header.getUint32(8, true)).toBe(bytes.byteLength);
  const jsonLength = header.getUint32(12, true);
  const document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Gltf;
  const binary = bytes.subarray(28 + jsonLength);
  const views = document.bufferViews.map(view => {
    const compression = view.extensions?.EXT_meshopt_compression;
    if (!compression) return binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    expect(compression.buffer).toBe(0);
    expect(compression.count * compression.byteStride).toBe(view.byteLength);
    const decoded = new Uint8Array(view.byteLength);
    MeshoptDecoder.decodeGltfBuffer(decoded, compression.count, compression.byteStride,
      binary.subarray(compression.byteOffset, compression.byteOffset + compression.byteLength), compression.mode, compression.filter);
    return decoded;
  });
  const values = (index: number) => {
    const a = document.accessors[index], view = document.bufferViews[a.bufferView], buffer = views[a.bufferView];
    const data = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const width = ({ SCALAR: 1, VEC3: 3, VEC4: 4 } as Record<string, number>)[a.type];
    const size = ({ 5120: 1, 5121: 1, 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[a.componentType];
    return Array.from({ length: a.count }, (_, row) => Array.from({ length: width }, (_, col) => {
      const offset = (a.byteOffset ?? 0) + row * (view.byteStride ?? width * size) + col * size;
      const value = a.componentType === 5120 ? data.getInt8(offset) : a.componentType === 5121 ? data.getUint8(offset)
        : a.componentType === 5123 ? data.getUint16(offset, true) : a.componentType === 5125 ? data.getUint32(offset, true)
          : data.getFloat32(offset, true);
      return !a.normalized ? value : a.componentType === 5120 ? Math.max(-1, value / 127) : value / (a.componentType === 5121 ? 255 : 65535);
    }));
  };
  const metadata = document.extensions.EXT_structural_metadata;
  const table = metadata.propertyTables[0];
  const sources = Array.from({ length: table.count }, (_, index) => Object.fromEntries(Object.entries(table.properties).map(([name, p]) => {
    const bytes = views[p.values], data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = metadata.schema.classes.building.properties[name].type;
    if (type === 'BOOLEAN') return [name, Boolean(bytes[index >> 3] & (1 << (index % 8)))];
    if (type !== 'STRING') return [name, data.getFloat64(index * 8, true)];
    const offsets = views[p.stringOffsets!], offset = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength);
    return [name, new TextDecoder().decode(bytes.subarray(offset.getUint32(index * 4, true), offset.getUint32((index + 1) * 4, true)))];
  })));
  const node = document.nodes[0];
  const primitives = document.meshes[0].primitives.map(p => ({
    material: document.materials[p.material].name,
    positions: values(p.attributes.POSITION).map(point => point.map((x, i) => x * node.scale[i] + node.translation[i])),
    normals: values(p.attributes.NORMAL), colors: values(p.attributes.COLOR_0),
    features: values(p.attributes._FEATURE_ID_0).flat(), indices: values(p.indices).flat(),
  }));
  return { document, sources, primitives };
}

describe('persistent architecture batches', () => {
  it.each(['far', 'mid', 'near'] as const)('applies generic reference heights with unchanged source fields in %s', async lod => {
    const sourcesById = ['4828_1253', '4823_1252'].flatMap(tile =>
      (JSON.parse(readFileSync(`public/data/c8a953228b2ff6af/tiles/${tile}.json`, 'utf8')) as { features: BuildingFeature[] }).features);
    const features = ['way/802754584', 'way/822365267', 'way/822365266']
      .map(id => sourcesById.find(feature => feature.properties.id === id)!);
    const before = structuredClone(features);
    const { document, sources, primitives } = await unpack((await buildBatch(features, lod)).bytes);
    for (const [index, height] of [303.2, 175, 12.8].entries()) {
      const { heightReference, ...original } = sources[index];
      expect(original).toEqual(before[index].properties);
      if (index < 2) expect(JSON.parse(String(heightReference))).toMatchObject({
        provider: 'verified-building-heights-v1', height, floors: index === 0 ? 68 : 48,
      });
      else expect(heightReference).toBe('');
      const top = Math.max(...primitives.flatMap(p =>
        p.positions.filter((_, vertex) => p.features[vertex] === index).map(point => point[1])));
      expect(Math.abs(top - (height + 0.46))).toBeLessThanOrEqual(document.nodes[0].scale[1] / 2 + 1e-6);
    }
    expect(features).toEqual(before);
  });

  it.each(['far', 'mid', 'near'] as const)('keeps landmark provenance separate from unchanged OSM fields in %s batches', async lod => {
    const tile = JSON.parse(readFileSync('public/data/c8a953228b2ff6af/tiles/4826_1252.json', 'utf8')) as { features: BuildingFeature[] };
    const gate = tile.features.find(feature => feature.properties.id === 'way/933819302')!;
    const ordinary = fixture('way/ordinary'), before = structuredClone(gate);
    const { document, sources, primitives } = await unpack((await buildBatch([ordinary, gate], lod)).bytes);
    expect(sources[0]).toEqual({ ...ordinary.properties, model: '' });
    const { model, ...original } = sources[1];
    expect(original).toEqual(before.properties);
    expect(JSON.parse(String(model))).toMatchObject({
      id: 'gate-to-the-east', name: '东方之门', height: 301.8, heightBasis: 'verified',
    });
    const top = Math.max(...primitives.flatMap(p => p.positions.map(point => point[1])));
    expect(Math.abs(top - 302.3)).toBeLessThanOrEqual(document.nodes[0].scale[1] / 2 + 1e-6);
    expect(gate).toEqual(before);
  });

  it.each(['far', 'mid', 'near'] as const)('preserves each building material state in mixed-style %s batches', async lod => {
    const features = [fixture('way/temple', 'temple'), fixture('way/office', 'office', 80, false, 0.0006)];
    for (const ordered of [features, [...features].reverse()]) {
      const expected = ordered.map(feature => emitArchitecture(new ArchitecturalMesh(), feature, lod).materials);
      const { document, primitives } = await unpack((await buildBatch(ordered, lod)).bytes);
      for (const [index, primitive] of primitives.entries()) {
        const material = document.materials[document.meshes[0].primitives[index].material];
        const checked = new Set<string>();
        for (const vertex of primitive.indices) {
          const feature = primitive.features[vertex], color = primitive.colors[vertex].map(value => Math.round(value * 255));
          const key = `${feature}:${color}`;
          if (checked.has(key)) continue;
          checked.add(key);
          const original = expected[feature].find(value =>
            value.pbrMetallicRoughness.baseColorFactor.map(channel => Math.round(channel * 255)).join() === color.join());
          expect(original).toBeDefined();
          expect(material.pbrMetallicRoughness).toEqual({
            ...original!.pbrMetallicRoughness, baseColorFactor: [1, 1, 1, 1],
          });
          expect(material.emissiveFactor).toEqual(original!.emissiveFactor);
        }
      }
    }
  });

  it('coalesces identical render-state materials without dropping geometry or source fields', async () => {
    const features = [fixture('way/42'), fixture('way/43', 'office', 80, false, 0.0006)];
    const batch = await buildBatch(features, 'far');
    const { document, sources, primitives } = await unpack(batch.bytes);
    const signatures = document.materials.map(({ name: _name, ...parameters }) => JSON.stringify(parameters));
    expect(new Set(signatures).size).toBe(signatures.length);
    expect(sources).toEqual(features.map(feature => feature.properties));
    const expectedTriangles = features.reduce((sum, feature) => {
      const mesh = new ArchitecturalMesh();
      emitArchitecture(mesh, feature, 'far');
      return sum + mesh.triangles;
    }, 0);
    expect(primitives.reduce((sum, primitive) => sum + primitive.indices.length / 3, 0)).toBe(expectedTriangles);
  });

  it.each(['far', 'mid', 'near'] as const)('preserves every oriented triangle and vertex attribute when compacting %s', async lod => {
    const spy = vi.spyOn(compaction, 'compactBatch').mockImplementationOnce(async batch => batch);
    let original;
    try { original = await buildBatch([fixture('way/42'), fixture('way/43', 'office', 80, true, 0.0006)], lod); }
    finally { spy.mockRestore(); }
    const compacted = await compaction.compactBatch(original);
    const before = await unpack(original.bytes), after = await unpack(compacted.bytes);
    const triangles = ({ document, primitives }: typeof before) => primitives.flatMap((primitive, index) => {
      const { name: _name, ...material } = document.materials[index];
      const result: string[] = [];
      for (let i = 0; i < primitive.indices.length; i += 3) {
        const corners = primitive.indices.slice(i, i + 3).map(vertex => [
          primitive.positions[vertex], primitive.normals[vertex], primitive.colors[vertex], primitive.features[vertex],
        ]);
        const oriented = [0, 1, 2].map(start => JSON.stringify([...corners.slice(start), ...corners.slice(0, start)])).sort()[0];
        result.push(JSON.stringify(material) + oriented);
      }
      return result;
    }).sort();
    expect(triangles(after)).toEqual(triangles(before));
    expect(after.sources).toEqual(before.sources);
    expect(compacted.triangles).toBe(original.triangles);
    expect(compacted.vertices).toBe(original.vertices);
    expect((await compaction.compactBatch(compacted)).bytes).toEqual(compacted.bytes);
  });

  it('shares compressed geometry/materials while preserving every source field and feature ID', async () => {
    const features = [fixture('way/42'), fixture('way/43', 'office', 80, false, 0.0006)];
    features[1].properties.estimated = false;
    features[1].properties.basis = 'height';
    const before = structuredClone(features);
    const batch = await buildBatch(features, 'near');
    const { document, sources, primitives } = await unpack(batch.bytes);
    expect(features).toEqual(before);
    expect(batch.bytes).toEqual((await buildBatch(features, 'near')).bytes);
    expect(document.nodes).toHaveLength(1);
    expect(primitives.length).toBeLessThanOrEqual(8);
    expect(document.extensionsRequired).toEqual(expect.arrayContaining(['KHR_mesh_quantization', 'EXT_meshopt_compression']));
    expect(document.buffers[1].extensions?.EXT_meshopt_compression.fallback).toBe(true);
    expect(sources).toEqual(features.map(f => f.properties));
    const seen = new Set<number>();
    let triangles = 0;
    for (const [index, primitive] of primitives.entries()) {
      const ids = document.meshes[0].primitives[index].extensions.EXT_mesh_features.featureIds[0];
      expect(ids).toMatchObject({ featureCount: 2, attribute: 0, propertyTable: 0 });
      expect(primitive.positions.length).toBe(primitive.normals.length);
      expect(primitive.positions.length).toBe(primitive.colors.length);
      triangles += primitive.indices.length / 3;
      for (let i = 0; i < primitive.indices.length; i += 3) {
        const featureIds = primitive.indices.slice(i, i + 3).map(j => primitive.features[j]);
        expect(new Set(featureIds).size).toBe(1);
        expect(featureIds[0]).toBeGreaterThanOrEqual(0);
        expect(featureIds[0]).toBeLessThan(features.length);
        seen.add(featureIds[0]);
      }
      for (const normal of primitive.normals) expect(Math.hypot(...normal)).toBeCloseTo(1, 2);
    }
    expect([...seen].sort()).toEqual([0, 1]);
    expect(triangles).toBe(batch.triangles);
    expect(batch.vertices).toBeLessThan(batch.triangles * 3);
    const raw = features.reduce((sum, feature) => sum + buildArchitecture(feature, 'near').bytes.byteLength, 0);
    expect(batch.bytes.byteLength).toBeLessThan(raw / 4);
  });

  it.each(['far', 'mid', 'near'] as const)('keeps the real footprint, courtyard and height at %s LOD', async lod => {
    const feature = fixture('way/courtyard', 'industrial', 22, true);
    const batch = await buildBatch([feature], lod);
    const { document, primitives } = await unpack(batch.bytes);
    const roof = primitives.find(p => p.material.split(' / ').includes('Roof'))!;
    const projected = projectRings(feature.geometry.coordinates as number[][][], batch.origin);
    const expectedArea = Math.abs(polygonArea(projected[0])) - Math.abs(polygonArea(projected[1]));
    let area = 0;
    for (let i = 0; i < roof.indices.length; i += 3) {
      const color = roof.colors[roof.indices[i]];
      if (![0.24, 0.34, 0.38].every((value, axis) => Math.abs(value - color[axis]) < 1 / 255)) continue;
      const points = roof.indices.slice(i, i + 3).map(j => [roof.positions[j][0], -roof.positions[j][2]] as XY);
      const triangleArea = Math.abs(polygonArea(points));
      if (triangleArea < 0.01) continue;
      area += triangleArea;
      const centre = [points.reduce((sum, p) => sum + p[0], 0) / 3, points.reduce((sum, p) => sum + p[1], 0) / 3];
      const hole = projected[1], xs = hole.map(p => p[0]), ys = hole.map(p => p[1]);
      expect(centre[0] > Math.min(...xs) && centre[0] < Math.max(...xs)
        && centre[1] > Math.min(...ys) && centre[1] < Math.max(...ys)).toBe(false);
    }
    expect(area).toBeCloseTo(expectedArea, 1);
    const heights = primitives.flatMap(p => p.positions.map(point => point[1]));
    const error = document.nodes[0].scale[0];
    expect(Math.min(...heights)).toBeCloseTo(0.5, 3);
    expect(Math.max(...heights)).toBeLessThanOrEqual(22.5 + error);
    expect(error).toBeLessThan(0.001);
  });

  it('retains architecture in far models while reducing facade microgeometry', async () => {
    const feature = fixture('way/42');
    const [far, mid, near] = await Promise.all(['far', 'mid', 'near'].map(lod => buildBatch([feature], lod as 'far' | 'mid' | 'near')));
    expect(far.triangles).toBeLessThan(mid.triangles);
    expect(mid.triangles).toBeLessThan(near.triangles);
    const { primitives } = await unpack(far.bytes);
    expect(primitives.flatMap(p => p.material.split(' / '))).toEqual(expect.arrayContaining(['Roof', 'Wall', 'Window - warm']));
    expect(far.triangles).toBeGreaterThan(12);
  });

  it('rejects empty batches, duplicate IDs, invalid heights and non-finite coordinates', async () => {
    await expect(buildBatch([], 'far')).rejects.toThrow(/empty/i);
    const feature = fixture('way/42');
    await expect(buildBatch([feature, feature], 'far')).rejects.toThrow(/duplicate/i);
    await expect(buildBatch([{ ...feature, properties: { ...feature.properties, height: NaN } }], 'near')).rejects.toThrow();
    const invalid = fixture('way/43');
    invalid.geometry = { type: 'Polygon', coordinates: [[[NaN, 31], [120, 31], [120, 32], [NaN, 31]]] };
    await expect(buildBatch([invalid], 'far')).rejects.toThrow();
  });
});
