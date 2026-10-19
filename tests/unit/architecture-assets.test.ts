import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { Cartesian3, Matrix4, Transforms } from 'cesium';
import { describe, expect, it } from 'vitest';
import type { BuildingFeature, BuildingProperties } from '../../web/core/types';

interface Source {
  baseDataset: string;
  origin: [number, number];
  buildings: BuildingFeature[];
  water: { id: string; geometry: unknown }[];
}
interface GLTF {
  nodes: { name: string; mesh?: number; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes: { primitives: { attributes: { POSITION: number }; indices: number; material: number; mode?: number }[] }[];
  materials: { name: string }[];
  buffers: { uri?: string }[];
  images: { uri?: string; bufferView?: number }[];
  accessors: { bufferView: number; byteOffset?: number; count: number; componentType: number; type: string }[];
  bufferViews: { byteOffset?: number; byteStride?: number }[];
}
interface Publication {
  baseDataset: string;
  buildings: BuildingProperties[];
  inferred: string[];
  lods: Record<'near' | 'far', { uri: string; bytes: number; sha256: string; triangles: number }>;
}

const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;

function values(document: GLTF, binary: Buffer, index: number): number[][] {
  const accessor = document.accessors[index], view = document.bufferViews[accessor.bufferView];
  const components = accessor.type === 'VEC3' ? 3 : 1;
  const bytes = accessor.componentType === 5123 ? 2 : 4;
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count }, (_, row) => Array.from({ length: components }, (_, column) => {
    const at = offset + row * (view.byteStride ?? components * bytes) + column * bytes;
    return accessor.componentType === 5126 ? binary.readFloatLE(at)
      : accessor.componentType === 5123 ? binary.readUInt16LE(at) : binary.readUInt32LE(at);
  }));
}

function inside(point: number[], ring: number[][]): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

function area(ring: number[][]): number {
  return Math.abs(ring.reduce((sum, a, i) => {
    const b = ring[(i + 1) % ring.length];
    return sum + a[0] * b[1] - b[0] * a[1];
  }, 0) / 2);
}

describe('source-aligned Gusu architectural package', () => {
  it('retains all 45 original feature properties, heights, rings and courtyard holes', async () => {
    const source = await json<Source>('assets/gusu/source.json');
    const base = await json<{ dataset: string }>('public/data/manifest.json');
    const tile = await json<{ features: BuildingFeature[] }>(`public/data/${base.dataset}/tiles/4825_1252.json`);
    expect(source.baseDataset).toBe(base.dataset);
    expect(source.buildings).toHaveLength(45);
    for (const building of source.buildings) {
      expect(building).toEqual(tile.features.find(feature => feature.properties.id === building.properties.id));
      expect(building.properties.height).toBe(12.8);
      expect(building.properties.estimated).toBe(true);
    }
    const courtyard = source.buildings.find(feature => feature.properties.id === 'relation/8507458')!;
    expect(courtyard.geometry.type).toBe('Polygon');
    expect(courtyard.geometry.coordinates).toHaveLength(2);
    const surface = await json<{ features: Source['water'] }>(`public/data/${base.dataset}/surface.json`);
    expect(source.water).toEqual([surface.features.find(feature => feature.id === 'way/525823909')]);
  });

  it('ships editable source and self-contained near/far meshes within the real budgets', async () => {
    const source = await json<Source>('assets/gusu/source.json');
    const manifest = await json<Publication>('public/architecture/manifest.json');
    expect(manifest.baseDataset).toBe(source.baseDataset);
    expect(manifest.buildings).toEqual(source.buildings.map(feature => feature.properties));
    expect(manifest.inferred.join(' ')).toContain('no architectural survey');
    expect((await stat('assets/gusu/gusu-block.blend')).size).toBeGreaterThan(100000);
    const frame = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(
      Cartesian3.fromDegrees(...source.origin)), new Matrix4());
    let totalBytes = 0;
    for (const lod of ['near', 'far'] as const) {
      const item = manifest.lods[lod], bytes = await readFile(`public/architecture/${item.uri}`);
      expect(bytes.length).toBe(item.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.sha256);
      expect(bytes.readUInt32LE(8)).toBe(bytes.length);
      totalBytes += bytes.length;
      const jsonLength = bytes.readUInt32LE(12);
      const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString()) as GLTF;
      const binary = bytes.subarray(28 + jsonLength);
      expect(document.buffers.every(buffer => !buffer.uri)).toBe(true);
      expect(document.images.every(image => !image.uri && image.bufferView !== undefined)).toBe(true);
      expect(document.nodes.map(node => node.name).sort()).toEqual(source.buildings.map(b => b.properties.id).sort());
      expect(document.materials.some(material => material.name.startsWith('Window - warm'))).toBe(true);
      let triangles = 0;
      for (const node of document.nodes) {
        expect(node.translation ?? [0, 0, 0]).toEqual([0, 0, 0]);
        expect(node.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1]);
        expect(node.scale ?? [1, 1, 1]).toEqual([1, 1, 1]);
        const feature = source.buildings.find(building => building.properties.id === node.name)!;
        const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
        const projected = polygons.map(polygon => polygon.map(ring => ring.map(point => {
          const position = Matrix4.multiplyByPoint(frame, Cartesian3.fromDegrees(point[0], point[1]), new Cartesian3());
          return [position.x, position.y];
        })));
        let roofArea = 0, roofFaces = 0;
        for (const primitive of document.meshes[node.mesh!].primitives) {
          expect(primitive.mode ?? 4).toBe(4);
          const positions = values(document, binary, primitive.attributes.POSITION);
          const indices = values(document, binary, primitive.indices).flat();
          triangles += indices.length / 3;
          expect(Math.min(...positions.map(point => point[2]))).toBeGreaterThanOrEqual(0.49);
          expect(Math.max(...positions.map(point => point[2]))).toBeLessThanOrEqual(feature.properties.height + 0.501);
          if (document.materials[primitive.material].name !== 'Roof - overlapping blue gray tiles') continue;
          for (let i = 0; i < indices.length; i += 3) {
            const triangle = indices.slice(i, i + 3).map(index => positions[index]);
            const center = [0, 1].map(axis => triangle.reduce((sum, point) => sum + point[axis], 0) / 3);
            const triangleArea = area(triangle);
            roofArea += triangleArea;
            if (triangleArea < 1e-7) continue;
            roofFaces++;
            expect(projected.some(polygon => inside(center, polygon[0]) &&
              polygon.slice(1).every(hole => !inside(center, hole))), `${lod} ${node.name} roof outside footprint`).toBe(true);
          }
        }
        const footprintArea = projected.reduce((sum, polygon) =>
          sum + area(polygon[0]) - polygon.slice(1).reduce((holes, hole) => holes + area(hole), 0), 0);
        expect(roofFaces).toBeGreaterThan(2);
        expect(roofArea).toBeCloseTo(footprintArea, 2);
      }
      expect(triangles).toBe(item.triangles);
      expect(triangles).toBeLessThan(lod === 'near' ? 300000 : 45000);
    }
    expect(totalBytes).toBeLessThan(16 * 1024 * 1024);
  });
});
