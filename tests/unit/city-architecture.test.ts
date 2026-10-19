import { Cartesian3, Matrix4, Transforms } from 'cesium';
import { describe, expect, it } from 'vitest';
import { polygonArea, projectRings, roofPatches, wallEdges, type XY } from '../../web/core/architectural-geometry';
import { cityBudget, cityLod, cityStyle } from '../../web/core/city-architecture';
import type { BuildingFeature } from '../../web/core/types';

const outer: XY[] = [[0, 0], [20, 0], [20, 12], [0, 12], [0, 0]];
const hole: XY[] = [[4, 3], [12, 3], [12, 9], [4, 9], [4, 3]];
const rotate = (ring: XY[]): XY[] => ring.map(([x, y]) => [x * 0.8 - y * 0.6, x * 0.6 + y * 0.8]);

function building(kind: string, height = 10, location: XY = [120.62, 31.32]): BuildingFeature {
  const [x, y] = location;
  return {
    type: 'Feature',
    properties: { id: 'way/1', name: '', kind, height, basis: 'height', estimated: false },
    geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 0.0001, y],
      [x + 0.0001, y + 0.0001], [x, y + 0.0001], [x, y]]] },
  };
}

describe('source-aligned architectural geometry', () => {
  it('matches Cesium ENU coordinates, without modifying the source rings', () => {
    const origin: XY = [120.62, 31.32];
    const source = building('yes').geometry.coordinates as number[][][];
    const before = structuredClone(source);
    const frame = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(
      Cartesian3.fromDegrees(...origin)), new Matrix4());
    const actual = projectRings(source, origin);
    for (const [i, point] of source[0].entries()) {
      const expected = Matrix4.multiplyByPoint(frame, Cartesian3.fromDegrees(point[0], point[1]), new Cartesian3());
      expect(actual[0][i][0]).toBeCloseTo(expected.x, 7);
      expect(actual[0][i][1]).toBeCloseTo(expected.y, 7);
    }
    expect(source).toEqual(before);
  });

  it.each([
    { rings: [outer], area: 240 },
    { rings: [rotate(outer)], area: 240 },
    { rings: [outer, hole], area: 192 },
    { rings: [rotate(outer), rotate(hole)], area: 192 },
    { rings: [[[0, 0], [20, 0], [20, 4], [4, 4], [4, 12], [0, 12], [0, 0]]] as XY[][], area: 112 },
  ])('partitions roof area $area without covering holes or concavities', ({ rings, area }) => {
    const before = structuredClone(rings);
    const patches = roofPatches(rings);
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.reduce((sum, patch) => sum + Math.abs(polygonArea(patch)), 0)).toBeCloseTo(area, 6);
    for (const patch of patches) expect(patch).toHaveLength(4);
    expect(rings).toEqual(before);
    if (rings.length > 1) {
      const inverse = (p: XY): XY => rings[0] === outer ? p : [p[0] * 0.8 + p[1] * 0.6, -p[0] * 0.6 + p[1] * 0.8];
      for (const patch of patches) {
        const centre = inverse([patch.reduce((sum, p) => sum + p[0], 0) / 4,
          patch.reduce((sum, p) => sum + p[1], 0) / 4]);
        expect(centre[0] > 4 + 1e-7 && centre[0] < 12 - 1e-7 && centre[1] > 3 + 1e-7 && centre[1] < 9 - 1e-7).toBe(false);
      }
    }
  });

  it('normalizes outward-facing outer and courtyard edges without moving vertices', () => {
    const edges = wallEdges([[...outer].reverse(), hole]);
    expect(edges).toHaveLength(8);
    expect(polygonArea(edges.filter(e => !e.courtyard).map(e => e.start))).toBe(240);
    expect(polygonArea(edges.filter(e => e.courtyard).map(e => e.start))).toBe(-48);
    expect(edges.filter(e => e.courtyard).map(e => e.start)).toEqual(expect.arrayContaining(hole.slice(0, -1)));
  });

  it.each([[], [[]], [[[0, 0], [1, 0], [2, 0]]], [[[0, 0], [NaN, 2], [2, 3]]]].map(rings => ({ rings })))(
    'rejects malformed local geometry explicitly', ({ rings }) => {
      expect(() => roofPatches(rings as XY[][])).toThrow(/footprint/i);
    });
});

describe('city-wide architectural policy', () => {
  it.each([
    ['apartments', 'residential'], ['house', 'residential'], ['office', 'office'],
    ['civic', 'office'], ['retail', 'commercial'], ['hotel', 'commercial'],
    ['warehouse', 'industrial'], ['industrial', 'industrial'], ['temple', 'historic'],
  ])('uses the source kind %s ahead of regional inference', (kind, expected) => {
    expect(cityStyle(building(kind))).toBe(expected);
  });

  it('limits inferred historic style to small low-rise buildings in the old city', () => {
    expect(cityStyle(building('yes'))).toBe('historic');
    expect(cityStyle(building('yes', 70))).toBe('neutral');
    expect(cityStyle(building('yes', 10, [120.72, 31.32]))).toBe('neutral');
    for (let id = 0; id < 10; id++) {
      const feature = building('unknown', 30);
      feature.properties.id = `way/${id}`;
      expect(cityStyle(feature)).toBe('neutral');
    }
  });

  it('keeps near and mid bodies stable around distance transitions', () => {
    expect(cityLod(240)).toBe('near');
    expect(cityLod(241)).toBe('mid');
    expect(cityLod(275, 'near')).toBe('near');
    expect(cityLod(281, 'near')).toBe('mid');
    expect(cityLod(220, 'mid')).toBe('mid');
    expect(cityLod(210, 'mid')).toBe('near');
    expect(cityLod(950)).toBe('mid');
    expect(cityLod(951)).toBeUndefined();
    expect(cityLod(1050, 'mid')).toBe('mid');
    expect(cityLod(1051, 'mid')).toBeUndefined();
    expect(cityLod(10, undefined, 'low')).toBe('mid');
    for (const distance of [-1, NaN, Infinity]) expect(() => cityLod(distance)).toThrow();
  });

  it('bounds resident geometry on each quality tier', () => {
    for (const quality of ['low', 'medium', 'high'] as const) {
      const budget = cityBudget(quality);
      expect(budget.near + budget.mid).toBeLessThanOrEqual(252);
      expect(budget.bytes).toBeLessThanOrEqual(128 * 1024 * 1024);
      expect(budget.triangles).toBeLessThanOrEqual(1_300_000);
    }
    expect(cityBudget('low').near).toBe(0);
    expect(cityBudget('high').near).toBeGreaterThan(cityBudget('medium').near);
  });
});
