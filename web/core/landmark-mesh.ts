import type { ArchitectureMeshWriter } from './architectural-mesh';
import type { XY, XYZ } from './architectural-geometry';

export const WALL = 0, ROOF = 1, FRAME = 2, STONE = 3, METAL = 4, WARM = 5, DARK = 6, DETAIL = 7;

export function localMesh(mesh: ArchitectureMeshWriter, center: XY, angle = 0, lean: XY = [0, 0]): ArchitectureMeshWriter {
  const transform = ([x, y, z]: XYZ): XYZ => [
    center[0] + x * Math.cos(angle) - y * Math.sin(angle) + lean[0] * (z - 0.5),
    center[1] + x * Math.sin(angle) + y * Math.cos(angle) + lean[1] * (z - 0.5), z,
  ];
  return {
    face: (points, material) => mesh.face(points.map(transform), material),
    prism: (points, vector, material) => {
      const zero = transform([0, 0, 0]), end = transform(vector);
      mesh.prism(points.map(transform), end.map((v, i) => v - zero[i]) as XYZ, material);
    },
  };
}

export function polygonRing(radius: number, z: number, sides = 8, phase = Math.PI / 8): XYZ[] {
  return Array.from({ length: sides }, (_, i) => {
    const angle = phase + i * 2 * Math.PI / sides;
    return [radius * Math.cos(angle), radius * Math.sin(angle), z];
  });
}

export function joinRings(mesh: ArchitectureMeshWriter, lower: XYZ[], upper: XYZ[], material: number | ((side: number) => number)): void {
  lower.forEach((point, i) => {
    const next = (i + 1) % lower.length;
    mesh.face([point, lower[next], upper[next], upper[i]], typeof material === 'number' ? material : material(i));
  });
}

export function column(mesh: ArchitectureMeshWriter, x: number, y: number, radius: number, bottom: number, top: number, material: number, sides = 8): void {
  mesh.prism(polygonRing(radius, bottom, sides).map(([u, v, z]): XYZ => [x + u, y + v, z]), [0, 0, top - bottom], material);
}

export function beam(mesh: ArchitectureMeshWriter, a: XYZ, b: XYZ, width: number, material: number): void {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 1e-7) return column(mesh, a[0], a[1], width / 2, a[2], b[2], material, 4);
  const dx = -(b[1] - a[1]) / length * width / 2, dy = (b[0] - a[0]) / length * width / 2;
  mesh.prism([[a[0] + dx, a[1] + dy, a[2]], [a[0] - dx, a[1] - dy, a[2]],
    [b[0] - dx, b[1] - dy, b[2]], [b[0] + dx, b[1] + dy, b[2]]], [0, 0, width], material);
}

export function recessedBay(mesh: ArchitectureMeshWriter, a: XY, b: XY, bottom: number, top: number, arched: boolean, near: boolean): void {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]), dx = (b[0] - a[0]) / length, dy = (b[1] - a[1]) / length;
  const point = (x: number, z: number, inset = 0): XYZ => [a[0] + dx * x - dy * inset, a[1] + dy * x + dx * inset, z];
  const face = (x0: number, x1: number, z0: number, z1: number) =>
    mesh.face([point(x0, z0), point(x1, z0), point(x1, z1), point(x0, z1)], WALL);
  const left = length * 0.3, right = length * 0.7, low = bottom + (top - bottom) * 0.12;
  const spring = bottom + (top - bottom) * (arched ? 0.62 : 0.83), radius = (right - left) / 2;
  const arch = Array.from({ length: arched ? 9 : 2 }, (_, i): XY => {
    const theta = arched ? Math.PI - i * Math.PI / 8 : Math.PI - i * Math.PI;
    return [(left + right) / 2 + radius * Math.cos(theta), spring + (arched ? radius * Math.sin(theta) : 0)];
  });
  face(0, left, bottom, top); face(right, length, bottom, top); face(left, right, bottom, low);
  for (let i = 0; i + 1 < arch.length; i++) mesh.face([
    point(...arch[i]), point(...arch[i + 1]), point(arch[i + 1][0], top), point(arch[i][0], top),
  ], WALL);
  const contour: XY[] = [[left, low], [right, low], ...[...arch].reverse()];
  const depth = arched ? 0.5 : 0.25;
  mesh.face(contour.map(([x, z]) => point(x, z, depth)), DARK);
  contour.forEach((p, i) => {
    const q = contour[(i + 1) % contour.length];
    mesh.face([point(...p), point(...q), point(q[0], q[1], depth), point(p[0], p[1], depth)], arched ? STONE : FRAME);
  });
  if (near && !arched) for (const fraction of [0.25, 0.5, 0.75]) {
    const x = left + (right - left) * fraction;
    beam(mesh, point(x, low, depth - 0.03), point(x, spring, depth - 0.03), 0.08, FRAME);
  }
  if (near && arched) for (let brick = 0; brick < 12; brick++) {
    const a = brick * Math.PI / 12 + 0.018, b = (brick + 1) * Math.PI / 12 - 0.018;
    const archPoint = (theta: number, r: number) => point(
      (left + right) / 2 + r * Math.cos(theta), spring + r * Math.sin(theta), -0.025);
    mesh.face([archPoint(a, radius), archPoint(a, radius + 0.18),
      archPoint(b, radius + 0.18), archPoint(b, radius)], STONE);
  }
}
