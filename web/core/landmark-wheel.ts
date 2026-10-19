import type { ArchitectureMeshWriter } from './architectural-mesh';
import type { XYZ } from './architectural-geometry';
import type { ArchitectureLod } from './building-architecture';
import { DARK, FRAME, METAL, ROOF, STONE, WARM, joinRings } from './landmark-mesh';

function strut(mesh: ArchitectureMeshWriter, a: XYZ, b: XYZ, radius: number, material: number, sides = 6): void {
  const delta = b.map((v, i) => v - a[i]), length = Math.hypot(...delta);
  const axis = delta.map(v => v / length);
  const across: XYZ = Math.abs(axis[2]) < 0.9 ? [-axis[1], axis[0], 0] : [0, -axis[2], axis[1]];
  const width = Math.hypot(...across), u = across.map(v => v / width);
  const v = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
  const ring = (center: XYZ): XYZ[] => Array.from({ length: sides }, (_, i) => {
    const theta = i * Math.PI * 2 / sides;
    return center.map((n, j) => {
      const value = n + radius * (u[j] * Math.cos(theta) + v[j] * Math.sin(theta));
      return j === 2 ? Math.max(0.5, value) : value;
    }) as XYZ;
  });
  const lower = ring(a), upper = ring(b);
  joinRings(mesh, lower, upper, material);
}

export function observationWheel(mesh: ArchitectureMeshWriter, lod: ArchitectureLod): void {
  const near = lod === 'near', far = lod === 'far', segments = near ? 224 : far ? 56 : 112;
  const hub = 64.5, radius = 58.6, cabinRadius = 60.8;
  const onWheel = (theta: number, r: number, y: number): XYZ => [Math.sin(theta) * r, y, hub + Math.cos(theta) * r];
  for (const y of [-1.8, 1.8]) {
    for (let i = 0; i < segments; i++) {
      const a = i * Math.PI * 2 / segments, b = (i + 1) * Math.PI * 2 / segments;
      strut(mesh, onWheel(a, radius, y), onWheel(b, radius, y), 0.42, FRAME, near ? 6 : 4);
      if (!far) strut(mesh, onWheel(a, radius + 0.46, y), onWheel(b, radius + 0.46, y), 0.065, WARM, 4);
    }
  }
  for (let i = 0; i < 56; i++) {
    const theta = i * Math.PI * 2 / 56;
    for (const y of [-1.8, 1.8]) strut(mesh, onWheel(theta + 0.12, 1.5, y * 1.6),
      onWheel(theta, radius, y), far ? 0.11 : 0.055, METAL, 4);
    if (i % 2 === 0 || !far) strut(mesh, onWheel(theta, radius, -1.8), onWheel(theta, radius, 1.8), 0.16, FRAME, 4);
  }
  for (const y of [-10, 10]) for (const x of [-27, 27]) {
    strut(mesh, [x, y * 1.2, 0.5], [Math.sign(x) * 1.1, y * 0.48, hub], 1.9, FRAME, near ? 12 : 6);
    if (near) strut(mesh, [x, y * 1.2 - Math.sign(y) * 1.5, 0.5],
      [Math.sign(x) * 1.1, y * 0.48 - Math.sign(y) * 1.5, hub - 1.5], 0.08, WARM, 4);
  }
  strut(mesh, [0, -6.8, hub], [0, 6.8, hub], 2.5, FRAME, near ? 20 : 12);
  for (let i = 0; i < 28; i++) {
    const theta = i * Math.PI * 2 / 28, center = onWheel(theta, cabinRadius, 0);
    strut(mesh, onWheel(theta, radius, 0), center, 0.22, METAL, 6);
    const sides = near ? 16 : far ? 8 : 12, levels = near ? 10 : far ? 4 : 6;
    const sphere = (j: number): XYZ[] => {
      const phi = -Math.PI / 2 + j * Math.PI / levels;
      return Array.from({ length: sides }, (_, k): XYZ => {
        const angle = k * 2 * Math.PI / sides;
        return [center[0] + 2.7 * Math.cos(phi) * Math.cos(angle),
          center[1] + 3.1 * Math.cos(phi) * Math.sin(angle), center[2] + 3.2 * Math.sin(phi)];
      });
    };
    for (let j = 0; j < levels; j++) joinRings(mesh, sphere(j), sphere(j + 1), DARK);
    for (const j of [1, Math.floor(levels / 2), levels - 1]) {
      const ring = sphere(j);
      ring.forEach((p, k) => strut(mesh, p, ring[(k + 1) % sides], j === 1 ? 0.11 : 0.065, j === 1 ? WARM : FRAME, 4));
    }
    if (!far) for (let k = 0; k < sides; k += sides / 4) {
      for (let j = 1; j + 1 < levels; j++) strut(mesh, sphere(j)[k], sphere(j + 1)[k], 0.055, FRAME, 4);
    }
  }
  // Small separate boarding modules keep the base open, not a disk across the wheel.
  for (let x = -18; x < 18; x += 9) {
    mesh.prism([[x, -6, 0.5], [x + 9, -6, 0.5], [x + 9, 6, 0.5], [x, 6, 0.5]], [0, 0, 0.6], STONE);
    if (!far) mesh.prism([[x, -7, 2.2], [x + 9, -7, 2.2], [x + 9, -4, 2.2], [x, -4, 2.2]], [0, 0, 0.25], ROOF);
  }
}
