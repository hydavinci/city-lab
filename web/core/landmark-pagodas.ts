import type { ArchitectureMeshWriter } from './architectural-mesh';
import type { XY, XYZ } from './architectural-geometry';
import type { ArchitectureLod } from './building-architecture';
import { beam, column, joinRings, polygonRing, recessedBay, WALL, ROOF, FRAME, STONE, METAL, DETAIL } from './landmark-mesh';

function eave(mesh: ArchitectureMeshWriter, radius: number, inner: number, bottom: number, rise: number, lod: ArchitectureLod): void {
  const radial = lod === 'near' ? 6 : 3, across = lod === 'near' ? 8 : lod === 'mid' ? 4 : 2;
  const point = (side: number, u: number, t: number, relief = 0): XYZ => {
    const a = Math.PI / 8 + side * Math.PI / 4, b = a + Math.PI / 4;
    const r = inner + (radius - inner) * t;
    const corner = Math.abs(2 * u - 1) ** 4;
    return [r * ((1 - u) * Math.cos(a) + u * Math.cos(b)), r * ((1 - u) * Math.sin(a) + u * Math.sin(b)),
      bottom + rise * (1 - t) ** 1.8 + rise * 0.26 * t ** 5 * (0.35 + corner * 0.65) + relief];
  };
  for (let side = 0; side < 8; side++) {
    for (let row = 0; row < radial; row++) for (let col = 0; col < across; col++) {
      const u0 = col / across, u1 = (col + 1) / across, t0 = row / radial, t1 = (row + 1) / radial;
      mesh.face([point(side, u0, t1), point(side, u1, t1), point(side, u1, t0), point(side, u0, t0)], ROOF);
    }
    for (let col = 0; col < across; col++) {
      const a = point(side, col / across, 1), b = point(side, (col + 1) / across, 1);
      mesh.face([a, [a[0], a[1], a[2] - 0.18], [b[0], b[1], b[2] - 0.18], b], FRAME);
    }
    if (lod === 'near') for (let col = 0; col <= across; col++) for (let row = 0; row < radial; row++) {
      const width = col === 0 ? 0.012 : 0.004, u = col / across;
      mesh.face([point(side, Math.max(0, u - width), row / radial, 0.035),
        point(side, Math.min(1, u + width), row / radial, 0.035),
        point(side, Math.min(1, u + width), (row + 1) / radial, 0.035),
        point(side, Math.max(0, u - width), (row + 1) / radial, 0.035)].reverse(), DETAIL);
    }
  }
}

function veranda(mesh: ArchitectureMeshWriter, radius: number, bottom: number, top: number, near: boolean): void {
  const ring = polygonRing(radius, bottom);
  mesh.prism(ring, [0, 0, 0.2], STONE);
  for (let side = 0; side < 8; side++) {
    const a = ring[side], b = ring[(side + 1) % 8];
    column(mesh, a[0], a[1], 0.17, bottom, top, FRAME);
    beam(mesh, [a[0], a[1], bottom + 1], [b[0], b[1], bottom + 1], 0.12, FRAME);
    beam(mesh, [a[0], a[1], top - 0.3], [b[0], b[1], top - 0.3], 0.2, FRAME);
    if (near) for (let post = 1; post <= 5; post++) {
      const u = post / 6, x = a[0] * (1 - u) + b[0] * u, y = a[1] * (1 - u) + b[1] * u;
      column(mesh, x, y, 0.055, bottom + 0.2, bottom + 1, FRAME, 4);
    }
    if (near) for (const offset of [-0.4, 0.4]) {
      const x = a[0] * 0.94, y = a[1] * 0.94;
      beam(mesh, [x + offset, y, top - 0.55], [x + offset, y + 0.5, top - 0.25], 0.14, FRAME);
    }
  }
}

export function pagoda(mesh: ArchitectureMeshWriter, id: string, radius: number, lod: ArchitectureLod): void {
  const tiger = id === 'tiger-hill-pagoda', beisi = id === 'beisi-pagoda';
  const levels = beisi ? 9 : 7, total = beisi ? 76 : tiger ? 48 : 53.57;
  const finial = beisi ? 6.2 : tiger ? 1.8 : 9.14, body = total - finial;
  const step = (body - 2) / levels;
  for (let stair = 0; stair < 3; stair++) {
    mesh.prism(polygonRing(radius * (1 - stair * 0.04), 0.5 + stair * 0.4), [0, 0, 0.4], STONE);
  }
  for (let level = 0; level < levels; level++) {
    const taper = 1 - 0.40 * level / levels;
    const eaveRadius = radius * taper * (tiger ? 0.95 : 1), wallRadius = eaveRadius * (tiger ? 0.87 : 0.65);
    const bottom = 2.5 + level * step, top = 2.5 + (level + 1) * step;
    const ring = polygonRing(wallRadius, bottom), roofRise = tiger ? 0.65 : step * 0.29;
    for (let side = 0; side < 8; side++) {
      const a = ring[side], b = ring[(side + 1) % 8];
      recessedBay(mesh, a.slice(0, 2) as XY, b.slice(0, 2) as XY, bottom, top - roofRise, tiger, lod === 'near');
      if (tiger && lod !== 'far') {
        column(mesh, a[0], a[1], 0.22, bottom, top - roofRise, WALL);
        for (let course = 1; course < 5; course++) {
          const z = bottom + (top - roofRise - bottom) * course / 5;
          beam(mesh, [a[0], a[1], z], [b[0], b[1], z], 0.035, STONE);
        }
      }
    }
    if (tiger) {
      const profiles = [[wallRadius, top - 0.8], [eaveRadius, top - 0.45], [eaveRadius, top - 0.2], [wallRadius, top]] as const;
      for (let i = 1; i < profiles.length; i++) joinRings(mesh,
        polygonRing(profiles[i - 1][0], profiles[i - 1][1]), polygonRing(profiles[i][0], profiles[i][1]), ROOF);
    } else {
      veranda(mesh, eaveRadius * 0.82, bottom, top - roofRise, lod === 'near');
      eave(mesh, eaveRadius, wallRadius * 0.88, top - roofRise, roofRise, lod);
    }
    mesh.face(polygonRing(wallRadius, top - (tiger ? 0 : roofRise)), STONE);
  }
  const base = body + 0.5;
  if (tiger) {
    joinRings(mesh, polygonRing(radius * 0.48, base), polygonRing(radius * 0.16, total + 0.5), STONE);
    mesh.face(polygonRing(radius * 0.16, total + 0.5), STONE);
    return;
  }
  const rings = [[0, 0.1], [0.10, 0.17], [0.20, 0.08], [0.27, 0.14], [0.35, 0.07], [0.43, 0.11],
    [0.50, 0.055], [0.57, 0.09], [0.64, 0.045], [0.72, 0.065], [0.80, 0.035], [0.88, 0.04], [1, 0]] as const;
  for (let i = 1; i < rings.length; i++) joinRings(mesh,
    polygonRing(radius * rings[i - 1][1], base + finial * rings[i - 1][0], 16),
    polygonRing(radius * rings[i][1], base + finial * rings[i][0], 16), METAL);
  if (lod === 'near') for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2;
    beam(mesh, [radius * 0.45 * Math.cos(angle), radius * 0.45 * Math.sin(angle), base - 1],
      [0, 0, base + finial * 0.7], 0.035, METAL);
  }
}
