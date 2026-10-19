import type { ArchitectureMeshWriter } from './architectural-mesh';
import { roofPatches, wallEdges, type XY, type XYZ } from './architectural-geometry';
import type { ArchitectureLod } from './building-architecture';
import type { LandmarkDefinition } from './landmarks';
import { DARK, DETAIL, FRAME, METAL, ROOF, STONE, WARM } from './landmark-mesh';

export function skylineTower(mesh: ArchitectureMeshWriter, rings: XY[][], definition: LandmarkDefinition, lod: ArchitectureLod): void {
  const family = definition.skyline!, near = lod === 'near', far = lod === 'far';
  const media = family === 'media' || family === 'media-wing', horizontal = family === 'hong-leong';
  const points = rings.flat(), minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
  const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
  const center: XY = [(minX + maxX) / 2, (minY + maxY) / 2], height = definition.height;
  const crown = family === 'global' ? 9 : family === 'fortune' ? 7 : family === 'center' ? 4 : 2;
  const bodyTop = height + 0.5 - crown;
  const floors = far ? Math.max(4, Math.ceil(bodyTop / 22)) : Math.ceil(bodyTop / (family === 'media-wing' ? 4.2 : 3.8));
  const step = (bodyTop - 0.5) / floors;
  const southMedia = definition.id === 'modern-media-south';
  const at = ([x, y]: XY, z: number): XYZ => {
    // The Media shafts bend into their separate low wings, without raising either entire wing.
    if (family === 'media') {
      const direction = southMedia ? 1 : -1, wingTop = southMedia ? 44.5 : 38.5;
      const edge = southMedia ? maxX : minX;
      const amount = Math.max(0, 1 - Math.max(0, z - wingTop) / (height * 0.44 - wingTop));
      const weight = Math.max(0, 1 - Math.abs(x - edge) / (maxX - minX));
      x += direction * 16 * amount ** 3 * weight;
    }
    return [x, y, z];
  };
  const edges = wallEdges(rings);
  edges.forEach(({ start, end }, edgeIndex) => {
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const bays = Math.max(1, Math.ceil(length / (far ? 14 : near ? 3.2 : 7.5)));
    const normal: XY = [(end[1] - start[1]) / length, -(end[0] - start[0]) / length];
    const point = (u: number, z: number, relief = 0): XYZ => {
      const p = at([start[0] + (end[0] - start[0]) * u, start[1] + (end[1] - start[1]) * u], z);
      return [p[0] + normal[0] * relief, p[1] + normal[1] * relief, p[2]];
    };
    const panel = (u0: number, u1: number, z0: number, z1: number, relief: number, material: number) =>
      mesh.face([point(u0, z0, relief), point(u1, z0, relief), point(u1, z1, relief), point(u0, z1, relief)], material);
    for (let floor = 0; floor < floors; floor++) {
      const bottom = 0.5 + floor * step, top = bottom + step;
      panel(0, 1, bottom, top, 0, FRAME);
      const band = far ? step * (horizontal ? 0.16 : 0.05) : horizontal ? 0.75 : media ? 0.45 : 0.23;
      for (let bay = 0; bay < bays; bay++) {
        const margin = far ? 0.005 : Math.min(0.12 / length, 0.12 / bays);
        const u0 = bay / bays + margin, u1 = (bay + 1) / bays - margin;
        const lit = (floor * 13 + bay * 7 + edgeIndex * 3) % 19 < (media ? 3 : 5);
        panel(u0, u1, bottom + band, top - 0.12, 0.035, lit ? WARM : DARK);
        if (media && !far && (bay + floor) % 2 === 0) {
          const finEnd = u0 + (u1 - u0) * (near ? 0.23 : 0.18), depth = near ? 0.42 : 0.08;
          panel(u0, finEnd, bottom + band, top - 0.12, depth, METAL);
          if (near) for (const u of [u0, finEnd]) mesh.face([
            point(u, bottom + band), point(u, bottom + band, depth),
            point(u, top - 0.12, depth), point(u, top - 0.12),
          ], FRAME);
        } else if (near && !horizontal) {
          const u = (bay + 1) / bays;
          mesh.face([point(u, bottom), point(u, bottom, 0.18), point(u, top, 0.18), point(u, top)], METAL);
        }
      }
      if (horizontal && !far) {
        panel(0, 1, bottom, bottom + band, 0.28, FRAME);
        mesh.face([point(0, bottom + band), point(0, bottom + band, 0.28),
          point(1, bottom + band, 0.28), point(1, bottom + band)], FRAME);
        if (near) panel(0, 1, top - 0.16, top - 0.09, 0.075, METAL);
      }
    }
    if (near) {
      panel(0, 1, 0.5, Math.min(1.7, step), 0.07, STONE);
      if (length > 8) {
        const width = Math.min(1.5 / length, 0.2);
        panel(0.5 - width, 0.5 + width, 0.6, 3.4, 0.1, DARK);
        mesh.prism([point(0.5 - width * 1.4, 3.5), point(0.5 + width * 1.4, 3.5),
          point(0.5 + width * 1.4, 3.5, 1.5), point(0.5 - width * 1.4, 3.5, 1.5)], [0, 0, 0.15], METAL);
      }
    }
  });
  const cap = ([x, y]: XY): XYZ => {
    const scale = family === 'global' ? 0.91 : family === 'center' ? 0.96 : 1;
    const z = family === 'fortune' ? bodyTop + crown * (0.4 + 0.6 * (x - minX) / (maxX - minX)) : height + 0.5;
    return [center[0] + (x - center[0]) * scale, center[1] + (y - center[1]) * scale, z];
  };
  for (const { start, end } of edges) {
    const a = at(start, bodyTop), b = at(end, bodyTop), c = cap(end), d = cap(start);
    mesh.face([a, b, c, d], family === 'fortune' || family === 'global' ? METAL : FRAME);
    if (!far) {
      const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (near ? 1.5 : 4)));
      for (let i = 0; i < count; i++) {
        const mix = (p: XYZ, q: XYZ, u: number): XYZ => p.map((v, axis) => v + (q[axis] - v) * u) as XYZ;
        mesh.face([mix(a, b, i / count), mix(a, b, (i + 0.13) / count),
          mix(d, c, (i + 0.13) / count), mix(d, c, i / count)], DETAIL);
      }
    }
  }
  for (const patch of roofPatches(rings)) mesh.face(patch.map(cap), ROOF);
}
