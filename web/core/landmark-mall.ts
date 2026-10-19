import type { ArchitectureMeshWriter } from './architectural-mesh';
import { polygonArea, roofPatches, wallEdges, type XY, type XYZ } from './architectural-geometry';
import type { ArchitectureLod } from './building-architecture';
import { beam, column, joinRings, ROOF, FRAME, STONE, WARM, DARK, DETAIL } from './landmark-mesh';

// Coordinates are relative to the source site anchor (120.674 E, 31.319 N).
export function suzhouCenter(mesh: ArchitectureMeshWriter, sourceRings: XY[][], lod: ArchitectureLod): void {
  const near = lod === 'near', spacing = near ? 12 : lod === 'mid' ? 20 : 30;
  const height = (x: number, y: number) => {
    if (y < -180) return 20.5;
    if (y < -120) return 24.5;
    const wave = 33.5 + 9 * Math.sin((x + 150) * Math.PI / 240) * Math.sin((y + 25) * Math.PI / 310);
    const blend = Math.min(1, Math.max(0, (y + 30) / 70));
    return 28.5 * (1 - blend) + wave * blend;
  };
  const aperture = Array.from({ length: 32 }, (_, i): XY => {
    const angle = i * Math.PI / 16;
    return [-95 + 30 * Math.cos(angle), 65 + 48 * Math.sin(angle)];
  });
  const rings = [...sourceRings, aperture];
  for (const patch of roofPatches(rings)) {
    const uSteps = Math.max(1, Math.ceil(Math.max(
      Math.hypot(patch[1][0] - patch[0][0], patch[1][1] - patch[0][1]),
      Math.hypot(patch[2][0] - patch[3][0], patch[2][1] - patch[3][1])) / spacing));
    const vSteps = Math.max(1, Math.ceil(Math.max(
      Math.hypot(patch[3][0] - patch[0][0], patch[3][1] - patch[0][1]),
      Math.hypot(patch[2][0] - patch[1][0], patch[2][1] - patch[1][1])) / spacing));
    const point = (u: number, v: number): XYZ => {
      const x = (1 - v) * (patch[0][0] * (1 - u) + patch[1][0] * u) + v * (patch[3][0] * (1 - u) + patch[2][0] * u);
      const y = (1 - v) * (patch[0][1] * (1 - u) + patch[1][1] * u) + v * (patch[3][1] * (1 - u) + patch[2][1] * u);
      return [x, y, height(x, y)];
    };
    for (let u = 0; u < uSteps; u++) for (let v = 0; v < vSteps; v++) {
      const points = [point(u / uSteps, v / vSteps), point((u + 1) / uSteps, v / vSteps),
        point((u + 1) / uSteps, (v + 1) / vSteps), point(u / uSteps, (v + 1) / vSteps)];
      mesh.face(points, points.reduce((sum, p) => sum + p[1], 0) / 4 > 0 ? ROOF : DETAIL);
      if (near && points[0][1] > 0) {
        const a = points[0].map((n, axis) => n + (axis === 2 ? 0.12 : 0)) as XYZ;
        const b = points[1].map((n, axis) => n + (axis === 2 ? 0.12 : 0)) as XYZ;
        beam(mesh, a, b, 0.1, FRAME);
      }
    }
  }
  for (const edge of wallEdges(sourceRings)) {
    const length = Math.hypot(edge.end[0] - edge.start[0], edge.end[1] - edge.start[1]);
    const bays = Math.max(1, Math.ceil(length / (near ? 8 : 18)));
    for (let bay = 0; bay < bays; bay++) {
      const a = edge.start.map((v, i) => v + (edge.end[i] - v) * bay / bays) as XY;
      const b = edge.start.map((v, i) => v + (edge.end[i] - v) * (bay + 1) / bays) as XY;
      const h0 = height(...a), h1 = height(...b), floors = 6;
      for (let level = 0; level < floors; level++) {
        const low = level / floors, high = (level + 1) / floors;
        mesh.face([[...a, 0.5 + (h0 - 0.5) * low], [...b, 0.5 + (h1 - 0.5) * low],
          [...b, 0.5 + (h1 - 0.5) * high - 0.3], [...a, 0.5 + (h0 - 0.5) * high - 0.3]],
        (level + bay) % 5 < 3 ? WARM : DARK);
        mesh.face([[...a, 0.5 + (h0 - 0.5) * high - 0.3], [...b, 0.5 + (h1 - 0.5) * high - 0.3],
          [...b, 0.5 + (h1 - 0.5) * high], [...a, 0.5 + (h0 - 0.5) * high]], STONE);
      }
      if (near) beam(mesh, [...a, 0.5], [...a, h0], 0.15, FRAME);
    }
  }
  const rim = aperture.map(([x, y]): XYZ => [x, y, height(x, y)]);
  const glazing = aperture.map(([x, y]): XYZ => [-95 + (x + 95) * 0.95, 65 + (y - 65) * 0.95, 29.5]);
  joinRings(mesh, glazing, rim, STONE);
  for (let i = 0; i < glazing.length; i++) {
    mesh.face([[-95, 65, 31.5], glazing[i], glazing[(i + 1) % glazing.length]], DARK);
    if (lod !== 'far') {
      beam(mesh, glazing[i], glazing[(i + 1) % glazing.length], 0.17, FRAME);
      if (i % 2 === 0) beam(mesh, [-95, 65, 31.6], glazing[i], 0.12, FRAME);
    }
  }
  if (lod !== 'far') for (const [x, y] of [[-130, 35], [-124, 100], [-65, 145], [-18, 180], [46, 153]]) {
    column(mesh, x, y, 0.65, 0.5, height(x, y) - 0.4, STONE);
  }
  // The original C-shaped perimeter also retains the narrow connecting decks.
  for (const patch of roofPatches(sourceRings)) {
    const floor = patch.map(([x, y]): XYZ => [x, y, 0.5]);
    mesh.face(polygonArea(patch) > 0 ? floor.reverse() : floor, STONE);
  }
}
