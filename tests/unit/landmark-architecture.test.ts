import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchitecturalMesh } from '../../web/core/architectural-mesh';
import { projectRings, type XY, type XYZ } from '../../web/core/architectural-geometry';
import { buildArchitecture, emitArchitecture, type ArchitectureLod } from '../../web/core/building-architecture';
import type { BuildingFeature } from '../../web/core/types';

const records = [
  ['way/933819302', '4826_1252', 'gate-to-the-east', 301.8, 'verified'],
  ['way/480395603', '4826_1252', 'suzhou-center', 42, 'estimated'],
  ['way/477238586', '4828_1252', 'suzhou-ifs', 452, 'verified'],
  ['way/206076447', '4824_1252', 'beisi-pagoda', 76, 'verified'],
  ['way/206069300', '4823_1253', 'tiger-hill-pagoda', 48, 'source'],
  ['way/608471429', '4824_1251', 'ruiguang-pagoda', 53.57, 'verified'],
] as const;

function source(id: string): BuildingFeature {
  const record = records.find(record => record[0] === id)!;
  const tile = JSON.parse(readFileSync(`public/data/c8a953228b2ff6af/tiles/${record[1]}.json`, 'utf8')) as {
    features: BuildingFeature[];
  };
  return tile.features.find(feature => feature.properties.id === id)!;
}

function geometry(id: string, lod: ArchitectureLod = 'near') {
  const feature = source(id), mesh = new ArchitecturalMesh();
  const { origin } = emitArchitecture(mesh, feature, lod);
  const ring = projectRings(feature.geometry.coordinates as number[][][], origin)[0];
  const center: XY = [0, 1].map(axis =>
    (Math.min(...ring.map(p => p[axis])) + Math.max(...ring.map(p => p[axis]))) / 2) as XY;
  const triangles = [...mesh.getSurfaces()].flatMap(([material, surface]) =>
    Array.from({ length: surface.indices.length / 3 }, (_, index) => ({
      material,
      points: surface.indices.slice(index * 3, index * 3 + 3).map(vertex =>
        surface.positions.slice(vertex * 3, vertex * 3 + 3) as XYZ),
    })));
  return { mesh, center, triangles };
}

function hitTriangle(origin: XYZ, direction: XYZ, points: XYZ[]): boolean {
  const sub = (a: XYZ, b: XYZ): XYZ => a.map((v, i) => v - b[i]) as XYZ;
  const cross = (a: XYZ, b: XYZ): XYZ => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: XYZ, b: XYZ) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const [a, b, c] = points, e1 = sub(b, a), e2 = sub(c, a), p = cross(direction, e2), det = dot(e1, p);
  if (Math.abs(det) < 1e-9) return false;
  const t = sub(origin, a), u = dot(t, p) / det, q = cross(t, e1), v = dot(direction, q) / det;
  return u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7 && dot(e2, q) / det >= 0;
}

function roofBands(triangles: ReturnType<typeof geometry>['triangles']): number[][] {
  const intervals = triangles.filter(t => t.material === 1).map(t => [
    Math.min(...t.points.map(p => p[2])), Math.max(...t.points.map(p => p[2])),
  ]).sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1] + 0.01) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

describe('six source-grounded landmark bodies', () => {
  it.each(records)('preserves %s source metadata while publishing its modeled identity and height', (id, _tile, modelId, height, heightBasis) => {
    const feature = source(id), before = structuredClone(feature);
    const result = buildArchitecture(feature, 'near');
    const view = new DataView(result.bytes);
    const document = JSON.parse(new TextDecoder().decode(new Uint8Array(result.bytes, 20, view.getUint32(12, true))));
    expect(document.nodes[0].extras.source).toEqual(before.properties);
    expect(document.nodes[0].extras.model).toMatchObject({ id: modelId, height, heightBasis });
    expect(document.nodes[0].extras.model.approximation.length).toBeGreaterThan(20);
    expect(document.nodes[0].extras.model.sources.length).toBeGreaterThan(0);
    expect(result.buildings).toEqual([before.properties]);
    expect(feature).toEqual(before);
    expect(result.bytes).toEqual(buildArchitecture(feature, 'near').bytes);
  });

  it.each(['far', 'mid', 'near'] as const)('keeps the Gate arch genuinely open in %s, with two legs and a connected crown', lod => {
    const { triangles, center } = geometry('way/933819302', lod);
    const angle = 11 * Math.PI / 180;
    const along: XY = [-Math.sin(angle), Math.cos(angle)], across: XY = [Math.cos(angle), Math.sin(angle)];
    const hit = (u: number, z: number) => triangles.some(t => hitTriangle(
      [center[0] + along[0] * u - across[0] * 200, center[1] + along[1] * u - across[1] * 200, z],
      [...across, 0], t.points));
    for (const height of [20, 120, 210]) expect(hit(0, height), `blocked central arch at ${height}m`).toBe(false);
    expect(hit(-65, 120)).toBe(true);
    expect(hit(65, 120)).toBe(true);
    expect(hit(0, 290)).toBe(true);
    expect(triangles.some(t => hitTriangle(
      [center[0] + across[0] * 18, center[1] + across[1] * 18, 270], [0, 0, 1], t.points)),
    'the crown must bridge the arch across its depth, not merely touch two rounded legs').toBe(true);
  });

  it.each(['far', 'mid', 'near'] as const)('gives IFS a curved tapered shaft and non-flat crown in %s', lod => {
    const { triangles } = geometry('way/477238586', lod);
    const points = triangles.flatMap(t => t.points);
    const width = (low: number, high: number) => {
      const band = points.filter(p => p[2] >= low && p[2] <= high);
      expect(band.length).toBeGreaterThan(0);
      return Math.max(...band.map(p => p[0])) - Math.min(...band.map(p => p[0]));
    };
    expect(width(390, 425)).toBeLessThan(width(10, 90) * 0.9);
    const crown = points.filter(p => p[2] > 420);
    expect(new Set(crown.map(p => Math.round(p[2] * 10))).size).toBeGreaterThan(4);
    expect(Math.max(...points.map(p => p[2]))).toBeCloseTo(452.5, 1);
  });

  it.each([['mid', 9], ['near', 4.5]] as const)('divides Gate curtain walls into individual glazing bays in %s', (lod, maximumWidth) => {
    const { triangles } = geometry('way/933819302', lod);
    const glazing = triangles.filter(triangle => triangle.material === 5 || triangle.material === 6);
    expect(glazing.length).toBeGreaterThan(0);
    for (const { points } of glazing) for (const a of points) for (const b of points) {
      if (Math.abs(a[2] - b[2]) > 0.01) continue;
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(maximumWidth + 0.01);
    }
    if (lod === 'near') {
      const uprightFrames = triangles.filter(triangle => triangle.material === 4
        && Math.max(...triangle.points.map(p => p[2])) - Math.min(...triangle.points.map(p => p[2])) > 2);
      expect(uprightFrames.length).toBeGreaterThan(8_000);
    }
  });

  it.each(['far', 'mid', 'near'] as const)('separates the Center north canopy from its lower south terraces in %s', lod => {
    const { triangles, center } = geometry('way/480395603', lod);
    const points = triangles.flatMap(t => t.points);
    const north = points.filter(p => p[1] > center[1] + 80), south = points.filter(p => p[1] < center[1] - 80);
    expect(Math.max(...north.map(p => p[2]))).toBeGreaterThan(36);
    expect(Math.max(...south.map(p => p[2]))).toBeLessThan(33);
    expect(new Set(north.filter(p => p[2] > 30).map(p => Math.round(p[2]))).size).toBeGreaterThan(5);
  });

  it.each([
    ['way/206076447', 9, 76], ['way/206069300', 7, 48], ['way/608471429', 7, 53.57],
  ] as const)('models the distinct stacked silhouette of %s at every LOD', (id, levels, height) => {
    for (const lod of ['far', 'mid', 'near'] as const) {
      const { triangles, center } = geometry(id, lod), bands = roofBands(triangles);
      expect(bands, `${id}/${lod} eaves or brick cornices`).toHaveLength(levels);
      const points = triangles.flatMap(t => t.points);
      expect(Math.max(...points.map(p => p[2]))).toBeCloseTo(height + 0.5, 1);
      const widths = bands.map(([bottom, top]) => {
        const band = triangles.filter(t => t.material === 1
          && t.points.every(p => p[2] >= bottom - 0.01 && p[2] <= top + 0.01)).flatMap(t => t.points);
        return Math.max(...band.map(p => p[0])) - Math.min(...band.map(p => p[0]));
      });
      expect(widths[0]).toBeGreaterThan(widths.at(-1)! * 1.25);
      if (id === 'way/206069300') {
        const cap = points.filter(p => p[2] > 48.49);
        const tipCenter = [0, 1].map(axis => (Math.max(...cap.map(p => p[axis])) + Math.min(...cap.map(p => p[axis]))) / 2);
        expect(Math.hypot(tipCenter[0] - center[0], tipCenter[1] - center[1])).toBeCloseTo(2.3, 1);
      }
    }
  });

  it.each(records)('keeps %s finite, bounded and progressively detailed without changing its source', id => {
    const near = geometry(id, 'near'), mid = geometry(id, 'mid'), far = geometry(id, 'far');
    expect(near.mesh.triangles).toBeGreaterThan(mid.mesh.triangles);
    expect(mid.mesh.triangles).toBeGreaterThan(far.mesh.triangles);
    expect(near.mesh.triangles).toBeLessThanOrEqual(45_000);
    for (const { mesh } of [near, mid, far]) for (const surface of mesh.getSurfaces().values()) {
      expect(surface.positions.every(Number.isFinite)).toBe(true);
      for (let i = 0; i < surface.normals.length; i += 3) {
        expect(Math.hypot(...surface.normals.slice(i, i + 3))).toBeCloseTo(1, 5);
      }
    }
  });

  it('refuses to apply a landmark model to an ID with a changed footprint', () => {
    const feature = source('way/933819302');
    for (const ring of feature.geometry.coordinates as number[][][]) for (const point of ring) point[0] += 0.01;
    expect(() => buildArchitecture(feature, 'near')).toThrow(/footprint changed/i);
  });
});
