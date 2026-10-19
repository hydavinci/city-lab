import { ArchitecturalMesh, type ArchitectureMaterial, type ArchitectureMeshWriter } from './architectural-mesh';
import { projectRings, roofPatches, roofPoint, wallEdges, type WallEdge, type XY, type XYZ } from './architectural-geometry';
import { cityStyle, type CityLod, type CityStyle } from './city-architecture';
import type { BuildingFeature, BuildingProperties } from './types';
import { emitLandmark } from './landmark-architecture';

export interface GeneratedArchitecture {
  bytes: ArrayBuffer;
  triangles: number;
  buildings: BuildingProperties[];
  origin: XY;
  style: CityStyle;
}
export interface ArchitectureRequest { id: number; feature: BuildingFeature; lod: CityLod }
export type ArchitectureReply = { id: number; result: GeneratedArchitecture } | { id: number; error: string };
export type ArchitectureLod = 'far' | CityLod;

const WALL = 0, ROOF = 1, FRAME = 2, STONE = 3, METAL = 4, WARM = 5, DARK = 6, ROOF_DETAIL = 7;
const profiles: Record<CityStyle, { bay: number; floor: number; pane: number; color: XYZ }> = {
  historic: { bay: 3.1, floor: 3.1, pane: 0.48, color: [0.79, 0.77, 0.69] },
  residential: { bay: 3.9, floor: 3.2, pane: 0.55, color: [0.64, 0.60, 0.51] },
  office: { bay: 3.4, floor: 3.8, pane: 0.84, color: [0.45, 0.52, 0.55] },
  commercial: { bay: 4.6, floor: 4.1, pane: 0.72, color: [0.69, 0.63, 0.51] },
  industrial: { bay: 6.2, floor: 5.5, pane: 0.64, color: [0.58, 0.63, 0.62] },
  neutral: { bay: 4.5, floor: 3.5, pane: 0.48, color: [0.65, 0.63, 0.58] },
};

function materials(style: CityStyle, seed: number): ArchitectureMaterial[] {
  const historic = style === 'historic', office = style === 'office';
  const tone = 0.93 + (seed % 9) / 100;
  const create = (name: string, color: XYZ, metal = 0, roughness = 0.85, emission?: XYZ): ArchitectureMaterial => ({
    name, pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: metal, roughnessFactor: roughness },
    ...(emission ? { emissiveFactor: emission } : {}),
  });
  return [
    create('Wall', profiles[style].color.map(c => c * tone) as XYZ),
    create('Roof', historic ? [0.14, 0.17, 0.18] : style === 'industrial' ? [0.24, 0.34, 0.38] : [0.36, 0.38, 0.37]),
    create('Frame', historic ? [0.14, 0.08, 0.045] : [0.27, 0.30, 0.29], historic ? 0 : 0.25),
    create('Stone', [0.43, 0.44, 0.41]),
    create('Metal', [0.27, 0.32, 0.34], 0.5, 0.5),
    create('Window - warm', office ? [0.22, 0.37, 0.40] : [0.28, 0.31, 0.25], 0.2, 0.3, [0.85, 0.55, 0.22]),
    create('Window - dark', office ? [0.12, 0.24, 0.29] : [0.095, 0.15, 0.16], 0.2, 0.3),
    create('Roof detail', historic ? [0.20, 0.23, 0.24] : [0.36, 0.43, 0.44], historic ? 0 : 0.4),
  ];
}

function windowGrid(length: number, top: number, style: CityStyle, density: number) {
  const base = Math.min(1.1, 0.5 + (top - 0.5) * 0.15);
  if (length < 1.5 || top - base < 1.4) return { base, floors: 0, bays: 0 };
  const profile = profiles[style];
  return {
    base,
    floors: Math.max(1, Math.min(24, Math.round((top - base) / profile.floor * density))),
    bays: Math.max(1, Math.min(16, Math.floor(length / profile.bay * density))),
  };
}

function wall(
  mesh: ArchitectureMeshWriter, edge: WallEdge, top: number, style: CityStyle, near: boolean, density: number, seed: number,
): void {
  const [a, b] = [edge.start, edge.end], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dx = (b[0] - a[0]) / length, dy = (b[1] - a[1]) / length;
  const point = (x: number, z: number, inset = 0): XYZ => [a[0] + dx * x - dy * inset, a[1] + dy * x + dx * inset, z];
  const face = (x0: number, x1: number, z0: number, z1: number, surface = WALL, inset = 0) => {
    if (x1 - x0 < 1e-6 || z1 - z0 < 1e-6) return;
    mesh.face([point(x0, z0, inset), point(x1, z0, inset), point(x1, z1, inset), point(x0, z1, inset)], surface);
  };
  const block = (x0: number, x1: number, z0: number, z1: number, surface: number, inset = 0.015, depth = 0.1) => {
    if (x1 - x0 < 1e-6 || z1 - z0 < 1e-6) return;
    mesh.prism([point(x0, z0, inset), point(x1, z0, inset), point(x1, z1, inset), point(x0, z1, inset)],
      [-dy * depth, dx * depth, 0], surface);
  };
  const { base, floors, bays } = windowGrid(length, top, style, density);
  face(0, length, 0.5, base, STONE);
  if (!floors) { face(0, length, base, top); return; }
  const profile = profiles[style];
  const bayWidth = length / bays, floorHeight = (top - base) / floors;
  for (let level = 0; level < floors; level++) for (let bay = 0; bay < bays; bay++) {
    const left = bay * bayWidth, right = (bay + 1) * bayWidth, bottom = base + level * floorHeight;
    const ceiling = bottom + floorHeight, centre = (left + right) / 2;
    const half = Math.min(bayWidth * profile.pane / 2, style === 'industrial' ? 2.3 : style === 'office' ? 2.8 : 1.5);
    const x0 = centre - half, x1 = centre + half;
    const low = bottom + floorHeight * (style === 'office' ? 0.10 : 0.25);
    const high = ceiling - floorHeight * (style === 'office' ? 0.10 : 0.18);
    const balcony = near && style === 'residential' && !edge.courtyard && level > 0 && (bay + seed) % 3 === 0;
    const recess = balcony ? 0.9 : 0.22;
    face(left, x0, bottom, ceiling); face(x1, right, bottom, ceiling);
    face(x0, x1, bottom, low); face(x0, x1, high, ceiling);
    const opening = [[x0, low], [x1, low], [x1, high], [x0, high]];
    for (let i = 0; i < 4; i++) {
      const p = opening[i], q = opening[(i + 1) % 4];
      mesh.face([point(p[0], p[1]), point(q[0], q[1]), point(q[0], q[1], recess + 0.08), point(p[0], p[1], recess + 0.08)], WALL);
    }
    face(x0, x1, low, high, (seed + bay * 3 + level * 5) % 5 < 3 ? WARM : DARK, recess);
    if (!near) continue;
    const frame = style === 'historic' ? 0.07 : 0.055;
    block(x0, x0 + frame, low, high, FRAME); block(x1 - frame, x1, low, high, FRAME);
    block(x0, x1, low, low + frame, FRAME); block(x0, x1, high - frame, high, FRAME);
    block(centre - frame / 2, centre + frame / 2, low, high, FRAME, 0.06, 0.07);
    if (style === 'historic') {
      for (const fraction of [1 / 3, 2 / 3]) {
        const z = low + (high - low) * fraction, x = x0 + (x1 - x0) * fraction;
        block(x0, x1, z - 0.018, z + 0.018, FRAME, 0.09, 0.035);
        block(x - 0.018, x + 0.018, low, high, FRAME, 0.09, 0.035);
      }
    }
    block(x0, x1, low - 0.09, low, STONE, 0, 0.26);
    block(left + 0.08, right - 0.08, ceiling - 0.12, ceiling, style === 'office' ? METAL : STONE, 0, 0.18);
    if (balcony) {
      block(x0, x1, low, low + 0.10, STONE, 0.01, 0.88);
      block(x0, x1, low + 0.85, low + 0.91, METAL, 0.055, 0.07);
      for (let bar = 0; bar <= 4; bar++) {
        const x = x0 + 0.03 + (x1 - x0 - 0.06) * bar / 4;
        block(x - 0.025, x + 0.025, low + 0.10, low + 0.85, METAL, 0.06, 0.05);
      }
    }
  }
}

function roof(mesh: ArchitectureMeshWriter, patch: XY[], top: number, rise: number, style: CityStyle, near: boolean, rollDensity: number): void {
  const pitched = rise > 0, segments = pitched ? near ? 8 : 4 : 1;
  const point = (u: number, v: number, relief = 0): XYZ => {
    const p = roofPoint(patch, u, v, top, rise);
    p[2] += relief;
    return p;
  };
  for (let step = 0; step < segments; step++) {
    const v0 = step / segments, v1 = (step + 1) / segments;
    mesh.face([point(0, v0), point(1, v0), point(1, v1), point(0, v1)], ROOF);
    if (pitched) for (const u of [0, 1]) {
      const a = point(u, v0), b = point(u, v1);
      const gable: XYZ[] = [[a[0], a[1], top - rise], [b[0], b[1], top - rise], b, a];
      mesh.face(u ? gable : gable.reverse(), WALL);
    }
  }
  const length = Math.max(Math.hypot(patch[1][0] - patch[0][0], patch[1][1] - patch[0][1]),
    Math.hypot(patch[2][0] - patch[3][0], patch[2][1] - patch[3][1]));
  const width = Math.max(Math.hypot(patch[3][0] - patch[0][0], patch[3][1] - patch[0][1]),
    Math.hypot(patch[2][0] - patch[1][0], patch[2][1] - patch[1][1]));
  if (length < 0.25 || width < 0.25) return;
  if (pitched) {
    const half = Math.min(0.13 / width, 0.1), count = near ? 6 : 2;
    for (let step = 0; step < count; step++) {
      const t0 = step * Math.PI / count, t1 = (step + 1) * Math.PI / count;
      const ridge = (u: number, t: number): XYZ => {
        const p = point(u, 0.5 + Math.cos(t) * half);
        p[2] = top + 0.025 + Math.sin(t) * 0.13;
        return p;
      };
      mesh.face([ridge(0, t1), ridge(1, t1), ridge(1, t0), ridge(0, t0)], ROOF_DETAIL);
    }
  } else {
    // Parapets are recessed into each roof patch, never beyond its source outline.
    const du = Math.min(0.16 / length, 0.1), dv = Math.min(0.16 / width, 0.1);
    for (const [u0, u1, v0, v1] of [[0, 1, 0, dv], [0, 1, 1 - dv, 1], [0, du, dv, 1 - dv], [1 - du, 1, dv, 1 - dv]]) {
      mesh.prism([point(u0, v0), point(u1, v0), point(u1, v1), point(u0, v1)], [0, 0, 0.16], STONE);
    }
  }
  if (!near || !pitched) return;
  const rolls = Math.min(80, Math.floor(length / (style === 'historic' ? 0.42 : 1.2) * rollDensity));
  for (let column = 1; column < rolls; column++) {
    const u = column / rolls, half = Math.min(0.045 / length, 0.2 / rolls);
    for (let step = 0; step < segments; step++) {
      const v0 = step / segments, v1 = (step + 1) / segments;
      mesh.face([point(u - half, v0, 0.012), point(u, v0, 0.055), point(u, v1, 0.055), point(u - half, v1, 0.012)], ROOF_DETAIL);
      mesh.face([point(u, v0, 0.055), point(u + half, v0, 0.012), point(u + half, v1, 0.012), point(u, v1, 0.055)], ROOF_DETAIL);
    }
  }
  for (const v of [0, 1]) {
    const inset = v === 0 ? Math.min(0.22 / width, 0.1) : 1 - Math.min(0.22 / width, 0.1);
    mesh.face([point(0, v), point(1, v), point(1, inset, -0.12), point(0, inset, -0.12)], FRAME);
  }
}

export function emitArchitecture(mesh: ArchitectureMeshWriter, feature: BuildingFeature, lod: ArchitectureLod, anchor?: XY) {
  const height = feature.properties.height;
  if (!Number.isFinite(height) || height <= 0) throw new Error(`Invalid architecture height: ${feature.properties.id}`);
  const source = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const first = source[0]?.[0]?.[0];
  if (!first || first.length < 2) throw new Error(`Empty architecture footprint: ${feature.properties.id}`);
  const origin: XY = anchor ?? [first[0], first[1]], style = cityStyle(feature), near = lod === 'near';
  const landmark = emitLandmark(mesh, feature, lod, origin);
  if (landmark) return landmark;
  const polygons = source.map(p => projectRings(p, origin));
  const edges = polygons.flatMap(wallEdges), patches = polygons.flatMap(roofPatches);
  let seed = 2166136261;
  for (const c of feature.properties.id) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  const top = height + 0.3, rise = style === 'historic' ? Math.min(3.3, height * 0.25)
    : style === 'industrial' ? Math.min(1.5, height * 0.06) : 0;
  const profile = profiles[style];
  const cells = edges.reduce((sum, e) => sum + Math.max(1, Math.hypot(e.end[0] - e.start[0], e.end[1] - e.start[1]) / profile.bay), 0)
    * Math.max(1, (top - rise - 0.5) / profile.floor);
  const cellBudget = near ? 160 : lod === 'mid' ? 48 : 8;
  let density = Math.min(1, Math.sqrt(cellBudget / cells));
  const lengths = edges.map(e => Math.hypot(e.end[0] - e.start[0], e.end[1] - e.start[1]));
  // Per-edge integer rounding can exceed the estimate on highly articulated footprints.
  for (let attempt = 0; attempt < 12; attempt++) {
    const actualCells = lengths.reduce((sum, length) => {
      const { floors, bays } = windowGrid(length, top - rise, style, density);
      return sum + floors * bays;
    }, 0);
    if (actualCells <= cellBudget) break;
    density *= 0.8;
  }
  const totalLength = patches.reduce((sum, p) => sum + Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), 0);
  for (const edge of edges) wall(mesh, edge, top - rise, style, near, density, seed);
  for (const patch of patches) {
    roof(mesh, patch, top, rise, style, near, Math.min(1, 180 / Math.max(1, totalLength)));
    mesh.face([...patch].reverse().map(([x, y]): XYZ => [x, y, 0.5]), STONE);
  }
  return { origin, style, materials: materials(style, seed), model: undefined };
}

export function buildArchitecture(feature: BuildingFeature, lod: CityLod): GeneratedArchitecture {
  const mesh = new ArchitecturalMesh();
  const { origin, style, materials, model } = emitArchitecture(mesh, feature, lod);
  const bytes = mesh.finish(materials, feature.properties, model);
  if (mesh.triangles > 45_000 || bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error(`Architecture body exceeds its geometry budget: ${feature.properties.id} (${mesh.triangles} triangles).`);
  }
  return { bytes, triangles: mesh.triangles, buildings: [{ ...feature.properties }], origin, style };
}
