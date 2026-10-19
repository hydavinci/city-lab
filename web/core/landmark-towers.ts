import type { ArchitectureMeshWriter } from './architectural-mesh';
import type { XYZ } from './architectural-geometry';
import type { ArchitectureLod } from './building-architecture';
import { beam, joinRings, METAL, ROOF, STONE, WARM, DARK } from './landmark-mesh';

function roundedRectangle(left: number, right: number, depth: number, z: number, segments: number): XYZ[] {
  const radius = Math.min(8, (right - left) * 0.25, depth * 0.4);
  return [0, 1, 2, 3].flatMap(corner => {
    const x = corner === 0 || corner === 3 ? right - radius : left + radius;
    const y = corner < 2 ? depth - radius : -depth + radius;
    return Array.from({ length: segments + 1 }, (_, i): XYZ => {
      const theta = corner * Math.PI / 2 + i * Math.PI / (2 * segments);
      return [x + radius * Math.cos(theta), y + radius * Math.sin(theta), z];
    });
  });
}

function gateGlazing(mesh: ArchitectureMeshWriter, lower: XYZ[], upper: XYZ[], lod: ArchitectureLod, level: number): void {
  lower.forEach((a, edge) => {
    const next = (edge + 1) % lower.length, b = lower[next], c = upper[next], d = upper[edge];
    const length = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - d[0], c[1] - d[1]));
    const bays = lod === 'far' ? 1 : Math.ceil(length / (lod === 'near' ? 4.5 : 9));
    const point = (start: XYZ, end: XYZ, fraction: number, relief = 0): XYZ => {
      const dx = end[0] - start[0], dy = end[1] - start[1], distance = Math.hypot(dx, dy);
      return [start[0] + dx * fraction + dy / distance * relief,
        start[1] + dy * fraction - dx / distance * relief, start[2]];
    };
    for (let bay = 0; bay < bays; bay++) {
      const left = bay / bays, right = (bay + 1) / bays;
      mesh.face([point(a, b, left), point(a, b, right), point(d, c, right), point(d, c, left)],
        (level * 3 + edge + bay) % 5 < 3 ? WARM : DARK);
      if (lod === 'near' && bay > 0) {
        const halfWidth = 0.06 / length;
        mesh.face([point(a, b, left - halfWidth, 0.12), point(a, b, left + halfWidth, 0.12),
          point(d, c, left + halfWidth, 0.12), point(d, c, left - halfWidth, 0.12)], METAL);
      }
    }
  });
}

export function gateTower(mesh: ArchitectureMeshWriter, lod: ArchitectureLod): void {
  const height = 301.8, levels = lod === 'near' ? 100 : lod === 'mid' ? 50 : 26, corners = lod === 'far' ? 2 : 4;
  const gap = (z: number) => 42 * (1 - Math.min(1, Math.max(0, (z - 150) / 98)) ** 2);
  for (const side of [-1, 1, 0]) {
    const start = side === 0 ? 248 : 0, end = side === 0 ? height : 248;
    const count = Math.ceil(levels * (end - start) / height);
    const ring = (z: number, band = 0) => {
      const inner = gap(z), outer = 83 - 3 * (z / height) ** 2, depth = 29 - 9 * (z / height);
      return roundedRectangle(side <= 0 ? -outer - band : inner, side < 0 ? -inner : outer + band,
        depth + band, z + 0.5, corners);
    };
    const base = ring(start);
    mesh.face([...base].reverse(), STONE);
    for (let level = 0; level < count; level++) {
      const bottom = start + (end - start) * level / count, top = start + (end - start) * (level + 1) / count;
      const lower = ring(bottom), upper = ring(top);
      gateGlazing(mesh, lower, upper, lod, level);
      if (lod !== 'far' && level) {
        joinRings(mesh, ring(bottom - 0.16, 0.18), ring(bottom + 0.16, 0.18), METAL);
      }
    }
    if (side === 0) mesh.face(ring(height), ROOF);
  }
}

export function ifsTower(mesh: ArchitectureMeshWriter, lod: ArchitectureLod): void {
  const sides = lod === 'near' ? 48 : lod === 'mid' ? 32 : 24;
  const levels = lod === 'near' ? 96 : lod === 'mid' ? 48 : 24;
  const point = (theta: number, z: number, relief = 0): XYZ => {
    const t = z / 452, taper = 1 - 0.34 * t ** 1.5, rotation = 0.16 * t;
    const x = Math.sign(Math.cos(theta)) * Math.sqrt(Math.abs(Math.cos(theta))) * (32 * taper + relief);
    const y = Math.sign(Math.sin(theta)) * Math.sqrt(Math.abs(Math.sin(theta))) * (24 * taper + relief);
    return [x * Math.cos(rotation) - y * Math.sin(rotation) + 6 * Math.sin(t * Math.PI * 0.8),
      x * Math.sin(rotation) + y * Math.cos(rotation), z + 0.5];
  };
  const ring = (z: number, relief = 0) => Array.from({ length: sides }, (_, i) => point(i * 2 * Math.PI / sides, z, relief));
  mesh.face([...ring(0)].reverse(), STONE);
  for (let level = 0; level < levels; level++) {
    const bottom = level * 410 / levels, top = (level + 1) * 410 / levels;
    joinRings(mesh, ring(bottom), ring(top), i => (i + level * 3) % 5 < 3 ? WARM : DARK);
    if (lod !== 'far') joinRings(mesh, ring(top - 0.1, 0.12), ring(top, 0.12), METAL);
    if (lod === 'near') for (let i = 0; i < sides; i += 3) {
      const theta = i * 2 * Math.PI / sides;
      beam(mesh, point(theta, bottom, 0.1), point(theta, top, 0.1), 0.09, METAL);
    }
  }
  const crown = Array.from({ length: sides }, (_, i) => {
    const theta = i * 2 * Math.PI / sides, z = 420 + 32 * ((1 + Math.sin(theta)) / 2) ** 1.4;
    return point(theta, z);
  });
  const inner = crown.map(([x, y, z]): XYZ => [x * 0.86, y * 0.86, z - 1.1]);
  joinRings(mesh, ring(410), crown, i => i % 5 ? DARK : METAL);
  joinRings(mesh, crown, inner, METAL);
  joinRings(mesh, inner, ring(409, -3), DARK);
  mesh.face(ring(409, -3), ROOF);
  // The curved, outward fin continues the shaft seam into the asymmetric crown.
  for (let level = 0; level < levels; level++) {
    const z0 = level * 452 / levels, z1 = (level + 1) * 452 / levels;
    const a = point(Math.PI / 2, z0, 0.2), b = point(Math.PI / 2, z1, 0.2);
    const c = point(Math.PI / 2 + 0.075, z1, 1.1), d = point(Math.PI / 2 + 0.075, z0, 1.1);
    mesh.face([a, b, c, d], METAL);
  }
}
