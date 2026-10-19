import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildArchitecture } from '../../web/core/building-architecture';
import { polygonArea, projectRings, type XY } from '../../web/core/architectural-geometry';
import type { BuildingFeature } from '../../web/core/types';

interface GLTF {
  nodes: { name: string; extras: { source: BuildingFeature['properties'] }; mesh: number }[];
  meshes: { primitives: { attributes: { POSITION: number; NORMAL: number }; indices: number; material: number }[] }[];
  materials: { name: string; emissiveFactor?: number[] }[];
  accessors: { bufferView: number; componentType: number; type: string; count: number; min?: number[]; max?: number[] }[];
  bufferViews: { byteOffset: number; byteLength: number }[];
  buffers: { byteLength: number; uri?: string }[];
}

function fixture(kind = 'yes', height = 12.8, courtyard = false): BuildingFeature {
  const outer = [[120.62, 31.32], [120.6203, 31.32], [120.6203, 31.3202], [120.62, 31.3202], [120.62, 31.32]];
  const hole = [[120.6201, 31.32007], [120.6202, 31.32007], [120.6202, 31.32014], [120.6201, 31.32014], [120.6201, 31.32007]];
  return { type: 'Feature', properties: { id: 'way/42', name: 'Source', kind, height, basis: 'levels', estimated: true },
    geometry: { type: 'Polygon', coordinates: courtyard ? [outer, hole] : [outer] } };
}

function unpack(bytes: ArrayBuffer) {
  const view = new DataView(bytes), jsonLength = view.getUint32(12, true);
  expect(view.getUint32(0, true)).toBe(0x46546c67);
  expect(view.getUint32(4, true)).toBe(2);
  expect(view.getUint32(8, true)).toBe(bytes.byteLength);
  expect(view.getUint32(16, true)).toBe(0x4e4f534a);
  expect(jsonLength % 4).toBe(0);
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength))) as GLTF;
  const binaryStart = 28 + jsonLength;
  expect(view.getUint32(binaryStart - 4, true)).toBe(0x004e4942);
  expect(view.getUint32(binaryStart - 8, true)).toBe(document.buffers[0].byteLength);
  const values = (index: number): number[][] => {
    const a = document.accessors[index], b = document.bufferViews[a.bufferView];
    const size = a.type === 'VEC3' ? 3 : 1;
    expect(b.byteOffset % 4).toBe(0);
    expect(b.byteOffset + a.count * size * 4).toBeLessThanOrEqual(document.buffers[0].byteLength);
    return Array.from({ length: a.count }, (_, row) => Array.from({ length: size }, (_, col) => {
      const offset = binaryStart + b.byteOffset + (row * size + col) * 4;
      return a.componentType === 5126 ? view.getFloat32(offset, true) : view.getUint32(offset, true);
    }));
  };
  const primitives = document.meshes[0].primitives.map(p => ({
    material: document.materials[p.material], positions: values(p.attributes.POSITION),
    normals: values(p.attributes.NORMAL), indices: values(p.indices).flat(),
    accessor: document.accessors[p.attributes.POSITION],
  }));
  return { document, primitives };
}

function inside(point: XY, ring: XY[]): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

describe('full city architectural bodies', () => {
  it.each([
    ['yes', 12.8, 'historic'], ['apartments', 35, 'residential'], ['office', 80, 'office'],
    ['retail', 15, 'commercial'], ['industrial', 16, 'industrial'], ['unknown', 25, 'neutral'],
  ] as const)('builds source-linked %s bodies, not accents or an opaque duplicate box', (kind, height, style) => {
    const feature = fixture(kind, height);
    const before = structuredClone(feature);
    const result = buildArchitecture(feature, 'near');
    const mid = buildArchitecture(feature, 'mid');
    expect(result.style).toBe(style);
    expect(result.buildings).toEqual([feature.properties]);
    expect(feature).toEqual(before);
    expect(result.bytes).toEqual(buildArchitecture(feature, 'near').bytes);
    expect(result.triangles).toBeGreaterThan(mid.triangles);
    expect(result.triangles).toBeLessThanOrEqual(45_000);
    expect(result.bytes.byteLength).toBeLessThan(4 * 1024 * 1024);
    const { document, primitives } = unpack(result.bytes);
    expect(document.nodes[0].name).toBe('way/42');
    expect(document.nodes[0].extras.source).toEqual(feature.properties);
    expect(document.buffers.every(buffer => !buffer.uri)).toBe(true);
    expect(primitives.some(p => p.material.name === 'Window - warm' && p.material.emissiveFactor?.[0])).toBe(true);
    let triangles = 0;
    for (const primitive of primitives) {
      expect(primitive.positions.length).toBe(primitive.normals.length);
      expect(primitive.indices.length % 3).toBe(0);
      triangles += primitive.indices.length / 3;
      for (const index of primitive.indices) expect(index).toBeLessThan(primitive.positions.length);
      const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
      for (const point of primitive.positions) for (let axis = 0; axis < 3; axis++) {
        expect(Number.isFinite(point[axis])).toBe(true);
        minimum[axis] = Math.min(minimum[axis], point[axis]);
        maximum[axis] = Math.max(maximum[axis], point[axis]);
      }
      expect(minimum[2]).toBeGreaterThanOrEqual(0.499);
      expect(maximum[2]).toBeLessThanOrEqual(height + 0.501);
      expect(primitive.accessor.min).toEqual(minimum);
      expect(primitive.accessor.max).toEqual(maximum);
      for (const n of primitive.normals) expect(Math.hypot(...n)).toBeCloseTo(1, 5);
    }
    expect(triangles).toBe(result.triangles);
  });

  it.each(['yes', 'apartments', 'industrial'])('preserves courtyard roof coverage for %s in both LODs', kind => {
    const feature = fixture(kind, kind === 'yes' ? 12.8 : 22, true);
    for (const lod of ['near', 'mid'] as const) {
      const result = buildArchitecture(feature, lod), { primitives } = unpack(result.bytes);
      const projected = projectRings(feature.geometry.coordinates as number[][][], result.origin);
      const roof = primitives.find(p => p.material.name === 'Roof')!;
      let area = 0;
      for (let i = 0; i < roof.indices.length; i += 3) {
        const triangle = roof.indices.slice(i, i + 3).map(index => roof.positions[index].slice(0, 2) as XY);
        const triangleArea = Math.abs(polygonArea(triangle));
        if (triangleArea < 1e-7) continue;
        const centre: XY = [triangle.reduce((sum, p) => sum + p[0], 0) / 3, triangle.reduce((sum, p) => sum + p[1], 0) / 3];
        expect(inside(centre, projected[0])).toBe(true);
        expect(inside(centre, projected[1])).toBe(false);
        area += triangleArea;
      }
      expect(area).toBeCloseTo(Math.abs(polygonArea(projected[0])) - Math.abs(polygonArea(projected[1])), 3);
    }
  });

  it.each(['yes', 'industrial'])('keeps %s ridge caps and tile rolls outward-facing in both LODs', kind => {
    for (const courtyard of [false, true]) for (const lod of ['near', 'mid'] as const) {
      const { primitives } = unpack(buildArchitecture(fixture(kind, 12.8, courtyard), lod).bytes);
      const detail = primitives.find(p => p.material.name === 'Roof detail')!;
      expect(detail.normals.length).toBeGreaterThan(0);
      const upward = detail.normals.map(normal => normal[2]);
      expect(Math.min(...upward)).toBeGreaterThan(-1e-6);
      expect(Math.max(...upward)).toBeGreaterThan(0.5);
    }
  });

  it('leaves actual openings in the wall with glass behind the reveals', () => {
    const { primitives } = unpack(buildArchitecture(fixture('apartments', 20), 'near').bytes);
    const panes = primitives.filter(p => p.material.name.startsWith('Window'));
    const wall = primitives.find(p => p.material.name === 'Wall')!;
    let checked = 0;
    for (const pane of panes) for (let i = 0; i < pane.indices.length; i += 3) {
      const points = pane.indices.slice(i, i + 3).map(index => pane.positions[index]);
      if (points.some(p => p[1] < 0.20 || p[1] > 0.24)) continue;
      checked++;
      const x = points.reduce((sum, p) => sum + p[0], 0) / 3, z = points.reduce((sum, p) => sum + p[2], 0) / 3;
      for (let j = 0; j < wall.indices.length; j += 3) {
        const face = wall.indices.slice(j, j + 3).map(index => wall.positions[index]);
        if (face.some(p => Math.abs(p[1]) > 0.001)) continue;
        const triangle = face.map(p => [p[0], p[2]] as XY);
        expect(inside([x, z], triangle), 'glass occluded by an uncut exterior wall').toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(6);
  });

  it('retains all multipolygon parts and adapts decoration density on very large bodies', () => {
    const feature = fixture('office', 400);
    const ring = (feature.geometry.coordinates as number[][][])[0];
    feature.geometry = { type: 'MultiPolygon', coordinates: [[ring], [ring.map(([x, y]) => [x + 0.001, y])]] };
    const result = buildArchitecture(feature, 'near');
    expect(result.triangles).toBeLessThanOrEqual(45_000);
    const roof = unpack(result.bytes).primitives.find(p => p.material.name === 'Roof')!;
    expect(Math.max(...roof.positions.map(p => p[0]))).toBeGreaterThan(100);
  });

  it('keeps the complete 161-edge source body within the near geometry budget', () => {
    const tile = JSON.parse(readFileSync('public/data/c8a953228b2ff6af/tiles/4828_1252.json', 'utf8')) as {
      features: BuildingFeature[];
    };
    const feature = tile.features.find(f => f.properties.id === 'way/482784880')!;
    const before = structuredClone(feature);
    const result = buildArchitecture(feature, 'near');
    expect(result.triangles).toBeLessThanOrEqual(45_000);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(result.triangles).toBeGreaterThan(buildArchitecture(feature, 'mid').triangles);
    expect(result.buildings).toEqual([feature.properties]);
    expect(feature).toEqual(before);
  });

  it('reports invalid geometry and height instead of returning a partial replacement', () => {
    const feature = fixture();
    feature.properties.height = NaN;
    expect(() => buildArchitecture(feature, 'near')).toThrow(/height/i);
    feature.properties.height = 12;
    feature.geometry = { type: 'Polygon', coordinates: [[[120, 31], [120, 31], [120, 31]]] };
    expect(() => buildArchitecture(feature, 'near')).toThrow(/footprint/i);
  });
});
