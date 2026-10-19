import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import type { ArchitectureMaterial } from '../../web/core/architectural-mesh';
import type { ArchitectureBatch } from './mesh';

interface BufferView {
  buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number;
  extensions?: { EXT_meshopt_compression: {
    buffer: number; byteOffset: number; byteLength: number; byteStride: number; count: number;
    mode: 'ATTRIBUTES' | 'TRIANGLES';
  } };
}
interface Accessor {
  bufferView: number; componentType: number; count: number; type: string;
  normalized?: boolean; min?: number[]; max?: number[];
}
interface Primitive {
  attributes: Record<string, number>; indices: number; material: number; mode: number;
  extensions: Record<string, unknown>;
}
interface Document {
  meshes: { primitives: Primitive[] }[]; materials: ArchitectureMaterial[];
  accessors: Accessor[]; bufferViews: BufferView[];
  buffers: { byteLength: number; extensions?: Record<string, unknown> }[];
  extensions: { EXT_structural_metadata: {
    propertyTables: { properties: Record<string, { values: number; stringOffsets?: number }> }[];
  } };
}
interface Chunk { offset: number; bytes: Uint8Array }

export function encodeGlb(document: object, chunks: Chunk[], byteLength: number): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(document)), jsonLength = Math.ceil(text.byteLength / 4) * 4;
  const bytes = new Uint8Array(28 + jsonLength + byteLength), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength); bytes.set(text, 20);
  view.setUint32(20 + jsonLength, byteLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  for (const chunk of chunks) bytes.set(chunk.bytes, 28 + jsonLength + chunk.offset);
  return bytes;
}

export async function compactBatch(batch: ArchitectureBatch): Promise<ArchitectureBatch> {
  const header = new DataView(batch.bytes.buffer, batch.bytes.byteOffset, batch.bytes.byteLength);
  const jsonLength = header.getUint32(12, true);
  const document = JSON.parse(new TextDecoder().decode(batch.bytes.subarray(20, 20 + jsonLength))) as Document;
  const binary = batch.bytes.subarray(28 + jsonLength);
  const groups = new Map<string, Primitive[]>();
  for (const primitive of document.meshes[0].primitives) {
    const { name: _name, ...parameters } = document.materials[primitive.material];
    const key = JSON.stringify(parameters);
    const group = groups.get(key) ?? [];
    group.push(primitive); groups.set(key, group);
  }
  if (groups.size === document.meshes[0].primitives.length) return batch;
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
  const sourceViews = document.bufferViews.map(view => {
    const compression = view.extensions?.EXT_meshopt_compression;
    if (!compression) return binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const bytes = new Uint8Array(view.byteLength);
    MeshoptDecoder.decodeGltfBuffer(bytes, compression.count, compression.byteStride,
      binary.subarray(compression.byteOffset, compression.byteOffset + compression.byteLength), compression.mode);
    return bytes;
  });
  const bufferViews: BufferView[] = [], accessors: Accessor[] = [], chunks: Chunk[] = [];
  const primitives: Primitive[] = [], materials: ArchitectureMaterial[] = [];
  let byteLength = 0, decodedBytes = 0, vertices = 0, triangles = 0;
  const store = (bytes: Uint8Array) => {
    const offset = byteLength;
    chunks.push({ offset, bytes }); byteLength += Math.ceil(bytes.length / 8) * 8;
    return offset;
  };
  const attribute = (bytes: Uint8Array, stride: number, accessor: Accessor, indices = false) => {
    const count = bytes.length / stride, mode = indices ? 'TRIANGLES' : 'ATTRIBUTES';
    const compressed = MeshoptEncoder.encodeGltfBuffer(bytes, count, stride, mode, 0);
    accessors.push({ ...accessor, bufferView: bufferViews.length, count });
    bufferViews.push({
      buffer: 1, byteOffset: decodedBytes, byteLength: bytes.length, target: indices ? 34963 : 34962,
      ...(indices ? {} : { byteStride: stride }),
      extensions: { EXT_meshopt_compression: {
        buffer: 0, byteOffset: store(compressed), byteLength: compressed.length, byteStride: stride, count, mode,
      } },
    });
    decodedBytes += bytes.length;
    return accessors.length - 1;
  };
  for (const group of groups.values()) {
    const first = group[0], names = Object.keys(first.attributes);
    const vertexCount = group.reduce((sum, p) => sum + document.accessors[p.attributes.POSITION].count, 0);
    const indexCount = group.reduce((sum, p) => sum + document.accessors[p.indices].count, 0);
    const indices = new Uint32Array(indexCount);
    let base = 0, cursor = 0;
    for (const primitive of group) {
      if (primitive.mode !== 4 || JSON.stringify(primitive.extensions) !== JSON.stringify(first.extensions)
        || JSON.stringify(Object.keys(primitive.attributes)) !== JSON.stringify(names)) {
        throw new Error('Incompatible architecture primitives.');
      }
      const index = document.accessors[primitive.indices], bytes = sourceViews[index.bufferView];
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (index.componentType !== 5125) throw new Error('Unsupported architecture index type.');
      for (let i = 0; i < index.count; i++) indices[cursor++] = base + view.getUint32(i * 4, true);
      base += document.accessors[primitive.attributes.POSITION].count;
    }
    const [remap, count] = MeshoptEncoder.reorderMesh(indices, true, true);
    const attributes: Record<string, number> = {};
    for (const name of names) {
      const source = document.accessors[first.attributes[name]], stride = document.bufferViews[source.bufferView].byteStride!;
      const data = new Uint8Array(vertexCount * stride);
      let cursor = 0;
      for (const primitive of group) {
        const accessor = document.accessors[primitive.attributes[name]];
        const view = document.bufferViews[accessor.bufferView];
        if (accessor.componentType !== source.componentType || accessor.type !== source.type
          || accessor.normalized !== source.normalized || view.byteStride !== stride) {
          throw new Error('Incompatible architecture attributes.');
        }
        const bytes = sourceViews[accessor.bufferView];
        data.set(bytes, cursor); cursor += bytes.length;
      }
      const reordered = new Uint8Array(count * stride);
      for (let old = 0; old < remap.length; old++) {
        if (remap[old] !== 0xffffffff) reordered.set(data.subarray(old * stride, (old + 1) * stride), remap[old] * stride);
      }
      const accessor = { ...source };
      if (source.min) accessor.min = source.min.map((_, axis) => Math.min(...group.map(p => document.accessors[p.attributes[name]].min![axis])));
      if (source.max) accessor.max = source.max.map((_, axis) => Math.max(...group.map(p => document.accessors[p.attributes[name]].max![axis])));
      attributes[name] = attribute(reordered, stride, accessor);
    }
    primitives.push({
      ...first, attributes,
      indices: attribute(new Uint8Array(indices.buffer), 4, document.accessors[first.indices], true),
      material: materials.length,
    });
    materials.push({
      ...document.materials[first.material],
      name: group.map(p => document.materials[p.material].name).join(' / '),
    });
    vertices += count; triangles += indexCount / 3;
  }
  for (const table of document.extensions.EXT_structural_metadata.propertyTables) {
    for (const property of Object.values(table.properties)) for (const key of ['values', 'stringOffsets'] as const) {
      const index = property[key];
      if (index === undefined) continue;
      const bytes = sourceViews[index];
      property[key] = bufferViews.length;
      bufferViews.push({ buffer: 0, byteOffset: store(bytes), byteLength: bytes.length });
    }
  }
  if (vertices !== batch.vertices || triangles !== batch.triangles) throw new Error('Architecture compaction changed geometry counts.');
  document.meshes = [{ primitives }]; document.materials = materials;
  document.accessors = accessors; document.bufferViews = bufferViews;
  document.buffers = [{ byteLength }, { byteLength: decodedBytes, extensions: { EXT_meshopt_compression: { fallback: true } } }];
  return { ...batch, bytes: encodeGlb(document, chunks, byteLength), vertices, triangles, decodedBytes };
}
