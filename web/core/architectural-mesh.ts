import type { XYZ } from './architectural-geometry';
import type { BuildingProperties } from './types';
import type { LandmarkModel } from './landmarks';
import type { HeightReference } from './building-heights';

export interface ArchitectureMaterial {
  name: string;
  pbrMetallicRoughness: { baseColorFactor: [number, number, number, number]; metallicFactor: number; roughnessFactor: number };
  emissiveFactor?: XYZ;
  doubleSided?: boolean;
}

interface Surface { positions: number[]; normals: number[]; indices: number[] }

export interface ArchitectureMeshWriter {
  face(points: XYZ[], material: number): void;
  prism(points: XYZ[], vector: XYZ, material: number): void;
}

export class ArchitecturalMesh implements ArchitectureMeshWriter {
  private surfaces = new Map<number, Surface>();
  triangles = 0;

  getSurfaces(): ReadonlyMap<number, Surface> { return this.surfaces; }

  face(points: XYZ[], material: number): void {
    for (let i = 1; i + 1 < points.length; i++) {
      const [a, b, c] = [points[0], points[i], points[i + 1]];
      const u = b.map((value, axis) => value - a[axis]), v = c.map((value, axis) => value - a[axis]);
      const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const length = Math.hypot(...cross);
      if (!Number.isFinite(length)) throw new Error('Non-finite architectural mesh.');
      if (length < 1e-10) continue;
      let surface = this.surfaces.get(material);
      if (!surface) { surface = { positions: [], normals: [], indices: [] }; this.surfaces.set(material, surface); }
      const start = surface.positions.length / 3;
      surface.positions.push(...a, ...b, ...c);
      const normal = cross.map(value => value / length);
      surface.normals.push(...normal, ...normal, ...normal);
      surface.indices.push(start, start + 1, start + 2);
      this.triangles++;
    }
  }

  prism(points: XYZ[], vector: XYZ, material: number): void {
    const a = points[1].map((v, i) => v - points[0][i]), b = points[2].map((v, i) => v - points[0][i]);
    const dot = (a[1] * b[2] - a[2] * b[1]) * vector[0] + (a[2] * b[0] - a[0] * b[2]) * vector[1]
      + (a[0] * b[1] - a[1] * b[0]) * vector[2];
    const base = dot < 0 ? [...points].reverse() : points;
    const top = base.map(p => p.map((v, i) => v + vector[i]) as XYZ);
    this.face([...base].reverse(), material);
    this.face(top, material);
    base.forEach((p, i) => {
      const next = (i + 1) % base.length;
      this.face([p, base[next], top[next], top[i]], material);
    });
  }

  finish(materials: ArchitectureMaterial[], source: BuildingProperties, model?: LandmarkModel, heightReference?: HeightReference): ArrayBuffer {
    const chunks: (Float32Array | Uint32Array)[] = [];
    const bufferViews: { buffer: number; byteOffset: number; byteLength: number; target: number }[] = [];
    const accessors: { bufferView: number; componentType: number; count: number; type: string; min?: number[]; max?: number[] }[] = [];
    let byteLength = 0;
    const add = (data: Float32Array | Uint32Array, type: 'VEC3' | 'SCALAR', bounds = false) => {
      const bufferView = bufferViews.length;
      bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.byteLength, target: type === 'SCALAR' ? 34963 : 34962 });
      chunks.push(data);
      byteLength += data.byteLength;
      const accessor: (typeof accessors)[number] = {
        bufferView, componentType: type === 'SCALAR' ? 5125 : 5126, count: data.length / (type === 'SCALAR' ? 1 : 3), type,
      };
      if (bounds) {
        accessor.min = [Infinity, Infinity, Infinity]; accessor.max = [-Infinity, -Infinity, -Infinity];
        data.forEach((value, i) => {
          const axis = i % 3;
          accessor.min![axis] = Math.min(accessor.min![axis], value);
          accessor.max![axis] = Math.max(accessor.max![axis], value);
        });
      }
      accessors.push(accessor);
      return accessors.length - 1;
    };
    const primitives = [...this.surfaces].map(([material, surface]) => ({
      attributes: { POSITION: add(new Float32Array(surface.positions), 'VEC3', true), NORMAL: add(new Float32Array(surface.normals), 'VEC3') },
      indices: add(new Uint32Array(surface.indices), 'SCALAR'), material, mode: 4,
    }));
    if (!primitives.length) throw new Error('Empty architectural mesh.');
    const document = {
      asset: { version: '2.0', generator: 'City Lab source-aligned architecture' },
      scene: 0, scenes: [{ nodes: [0] }],
      nodes: [{ name: source.id, mesh: 0, extras: { source, inferred: 'Parametric architecture; no architectural survey.',
        ...(model ? { model } : {}), ...(heightReference ? { heightReference } : {}) } }],
      meshes: [{ primitives }], materials, accessors, bufferViews, buffers: [{ byteLength }],
    };
    const text = new TextEncoder().encode(JSON.stringify(document));
    const jsonLength = Math.ceil(text.byteLength / 4) * 4;
    const bytes = new ArrayBuffer(28 + jsonLength + byteLength), view = new DataView(bytes), output = new Uint8Array(bytes);
    view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.byteLength, true);
    view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
    output.fill(0x20, 20, 20 + jsonLength); output.set(text, 20);
    view.setUint32(20 + jsonLength, byteLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
    let offset = 28 + jsonLength;
    for (const chunk of chunks) { output.set(new Uint8Array(chunk.buffer), offset); offset += chunk.byteLength; }
    return bytes;
  }
}
