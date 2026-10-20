import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { ArchitecturalMesh, type ArchitectureMaterial } from '../../web/core/architectural-mesh';
import { emitArchitecture, type ArchitectureLod } from '../../web/core/building-architecture';
import type { XY } from '../../web/core/architectural-geometry';
import type { BuildingFeature, BuildingProperties } from '../../web/core/types';
import { compactBatch, encodeGlb } from './compact';

interface BufferView {
  buffer: number; byteOffset: number; byteLength: number; byteStride?: number; target?: number;
  extensions?: { EXT_meshopt_compression: {
    buffer: number; byteOffset: number; byteLength: number; byteStride: number; count: number; mode: string;
  } };
}
interface Accessor {
  bufferView: number; componentType: number; count: number; type: string; normalized?: boolean; min?: number[]; max?: number[];
}
interface MetadataProperty { values: number; stringOffsets?: number }
interface SchemaProperty { type: 'STRING' | 'SCALAR' | 'BOOLEAN'; componentType?: 'FLOAT64' }

export interface ArchitectureBatch {
  bytes: Uint8Array; origin: XY; triangles: number; vertices: number; decodedBytes: number;
}

export async function buildBatch(features: BuildingFeature[], lod: ArchitectureLod): Promise<ArchitectureBatch> {
  if (!features.length) throw new Error('Empty architecture batch.');
  if (new Set(features.map(f => f.properties.id)).size !== features.length) throw new Error('Duplicate building ID in architecture batch.');
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of features) {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) for (const ring of polygon) for (const [x, y] of ring) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Invalid architecture coordinates: ${feature.properties.id}`);
      bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
      bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
    }
  }
  const origin: XY = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  const bodies = features.map(feature => {
    const mesh = new ArchitecturalMesh(), result = emitArchitecture(mesh, feature, lod, origin);
    if (mesh.triangles > 45_000) throw new Error(`Architecture body exceeds its geometry budget: ${feature.properties.id}`);
    for (const surface of mesh.getSurfaces().values()) for (let i = 0; i < surface.positions.length; i += 3) {
      const point = [surface.positions[i], surface.positions[i + 2], -surface.positions[i + 1]];
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], point[axis]); maximum[axis] = Math.max(maximum[axis], point[axis]);
      }
    }
    return { mesh, materials: result.materials, model: result.model, heightReference: result.heightReference };
  });
  const step = Math.max(...maximum.map((value, axis) => value - minimum[axis])) / 65535;
  if (!Number.isFinite(step) || step <= 0) throw new Error('Empty or non-finite architecture batch.');
  await MeshoptEncoder.ready;
  const bufferViews: BufferView[] = [], accessors: Accessor[] = [], chunks: { offset: number; bytes: Uint8Array }[] = [];
  let byteLength = 0, decodedBytes = 0, vertices = 0, triangles = 0;
  const store = (bytes: Uint8Array) => {
    const offset = byteLength;
    chunks.push({ offset, bytes });
    byteLength += Math.ceil(bytes.byteLength / 8) * 8;
    return offset;
  };
  const attribute = (data: Uint8Array, stride: number, type: string, componentType: number, normalized = false, range?: number[][]) => {
    const count = data.byteLength / stride, mode = type === 'INDICES' ? 'TRIANGLES' : 'ATTRIBUTES';
    const compressed = MeshoptEncoder.encodeGltfBuffer(data, count, stride, mode, 0), offset = store(compressed);
    const bufferView = bufferViews.length;
    bufferViews.push({
      buffer: 1, byteOffset: decodedBytes, byteLength: data.byteLength, target: mode === 'TRIANGLES' ? 34963 : 34962,
      ...(mode === 'ATTRIBUTES' ? { byteStride: stride } : {}),
      extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: offset, byteLength: compressed.byteLength, byteStride: stride, count, mode } },
    });
    decodedBytes += data.byteLength;
    accessors.push({
      bufferView, componentType, count, type: type === 'INDICES' ? 'SCALAR' : type,
      ...(normalized ? { normalized: true } : {}), ...(range ? { min: range[0], max: range[1] } : {}),
    });
    return accessors.length - 1;
  };
  const bytesOf = (data: Uint16Array | Uint32Array | Int8Array) => new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const materials: ArchitectureMaterial[] = [];
  const primitives = [];
  const groups: { material: number; original: ArchitectureMaterial; featureIds: number[] }[] = [];
  for (let material = 0; material < 8; material++) {
    const variants = new Map<string, typeof groups[number]>();
    for (const [featureId, body] of bodies.entries()) {
      if (!body.mesh.getSurfaces().has(material)) continue;
      const source = body.materials[material];
      const original: ArchitectureMaterial = { ...source, pbrMetallicRoughness: { ...source.pbrMetallicRoughness, baseColorFactor: [1, 1, 1, 1] } };
      const key = JSON.stringify(original);
      const group: typeof groups[number] = variants.get(key) ?? { material, original, featureIds: [] };
      group.featureIds.push(featureId);
      variants.set(key, group);
    }
    groups.push(...variants.values());
  }
  for (const { material, original, featureIds: members } of groups) {
    const positions: number[] = [], normals: number[] = [], colors: number[] = [], featureIds: number[] = [], indices: number[] = [];
    const unique = new Map<string, number>();
    for (const featureId of members) {
      const body = bodies[featureId];
      const surface = body.mesh.getSurfaces().get(material);
      if (!surface) continue;
      const color = body.materials[material].pbrMetallicRoughness.baseColorFactor.map(value => Math.round(value * 255));
      for (const index of surface.indices) {
        const i = index * 3;
        const point = [surface.positions[i], surface.positions[i + 2], -surface.positions[i + 1]];
        const position = point.map((value, axis) => Math.max(0, Math.min(65535, Math.round((value - minimum[axis]) / step))));
        const normal = [surface.normals[i], surface.normals[i + 2], -surface.normals[i + 1]].map(value => Math.round(value * 127));
        const key = [...position, ...normal, ...color, featureId].join(',');
        let vertex = unique.get(key);
        if (vertex === undefined) {
          vertex = unique.size; unique.set(key, vertex);
          positions.push(...position, 0); normals.push(...normal, 0); colors.push(...color); featureIds.push(featureId);
        }
        indices.push(vertex);
      }
    }
    if (!indices.length) continue;
    const reordered = new Uint32Array(indices);
    const [remap, count] = MeshoptEncoder.reorderMesh(reordered, true, true);
    const p = new Uint16Array(count * 4), n = new Int8Array(count * 4), c = new Uint8Array(count * 4), f = new Uint32Array(count);
    for (let old = 0; old < remap.length; old++) {
      const next = remap[old];
      if (next === 0xffffffff) continue;
      for (let axis = 0; axis < 4; axis++) {
        p[next * 4 + axis] = positions[old * 4 + axis]; n[next * 4 + axis] = normals[old * 4 + axis];
        c[next * 4 + axis] = colors[old * 4 + axis];
      }
      f[next] = featureIds[old];
    }
    const min = [65535, 65535, 65535], max = [0, 0, 0];
    for (let i = 0; i < count; i++) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], p[i * 4 + axis]); max[axis] = Math.max(max[axis], p[i * 4 + axis]);
    }
    primitives.push({
      attributes: {
        POSITION: attribute(bytesOf(p), 8, 'VEC3', 5123, false, [min, max]),
        NORMAL: attribute(bytesOf(n), 4, 'VEC3', 5120, true),
        COLOR_0: attribute(c, 4, 'VEC4', 5121, true),
        _FEATURE_ID_0: attribute(bytesOf(f), 4, 'SCALAR', 5125),
      },
      indices: attribute(bytesOf(reordered), 4, 'INDICES', 5125), material: materials.length, mode: 4,
      extensions: { EXT_mesh_features: { featureIds: [{ featureCount: features.length, attribute: 0, propertyTable: 0, label: 'building' }] } },
    });
    materials.push(original);
    vertices += count; triangles += reordered.length / 3;
  }
  const metadataView = (bytes: Uint8Array) => {
    bufferViews.push({ buffer: 0, byteOffset: store(bytes), byteLength: bytes.byteLength });
    return bufferViews.length - 1;
  };
  const properties: Record<string, MetadataProperty> = {}, schema: Record<string, SchemaProperty> = {};
  const encoder = new TextEncoder();
  const fields: (keyof BuildingProperties | 'model' | 'heightReference')[] = ['id', 'name', 'kind', 'height', 'basis', 'estimated'];
  if (bodies.some(body => body.model)) fields.push('model');
  if (bodies.some(body => body.heightReference)) fields.push('heightReference');
  for (const key of fields) {
    if (key === 'height') {
      const bytes = new Uint8Array(features.length * 8), view = new DataView(bytes.buffer);
      features.forEach((feature, i) => view.setFloat64(i * 8, feature.properties.height, true));
      properties[key] = { values: metadataView(bytes) }; schema[key] = { type: 'SCALAR', componentType: 'FLOAT64' };
    } else if (key === 'estimated') {
      const bytes = new Uint8Array(Math.ceil(features.length / 8));
      features.forEach((feature, i) => { if (feature.properties.estimated) bytes[i >> 3] |= 1 << (i % 8); });
      properties[key] = { values: metadataView(bytes) }; schema[key] = { type: 'BOOLEAN' };
    } else {
      const strings = features.map((feature, i) => encoder.encode(key === 'model' || key === 'heightReference'
        ? bodies[i][key] ? JSON.stringify(bodies[i][key]) : '' : feature.properties[key]));
      const offsets = new Uint32Array(features.length + 1);
      strings.forEach((value, i) => { offsets[i + 1] = offsets[i] + value.byteLength; });
      const bytes = new Uint8Array(offsets.at(-1)!);
      strings.forEach((value, i) => bytes.set(value, offsets[i]));
      properties[key] = { values: metadataView(bytes), stringOffsets: metadataView(bytesOf(offsets)) }; schema[key] = { type: 'STRING' };
    }
  }
  const document = {
    asset: { version: '2.0', generator: 'City Lab source-aligned architecture batches' },
    extensionsUsed: ['KHR_mesh_quantization', 'EXT_meshopt_compression', 'EXT_mesh_features', 'EXT_structural_metadata'],
    extensionsRequired: ['KHR_mesh_quantization', 'EXT_meshopt_compression'],
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: minimum, scale: [step, step, step] }],
    meshes: [{ primitives }], materials, accessors, bufferViews,
    buffers: [{ byteLength }, { byteLength: decodedBytes, extensions: { EXT_meshopt_compression: { fallback: true } } }],
    extensions: { EXT_structural_metadata: {
      schema: { id: 'city_buildings', classes: { building: { properties: schema } } },
      propertyTables: [{ class: 'building', count: features.length, properties }],
    } },
  };
  return compactBatch({ bytes: encodeGlb(document, chunks, byteLength), origin, vertices, triangles, decodedBytes });
}
