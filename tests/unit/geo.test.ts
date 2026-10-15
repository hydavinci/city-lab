import { describe, expect, it } from 'vitest';
import { deriveHeight, insideBoundary, tileId, tileBounds, selectTiles, validateRing } from '../../web/core/geo';

describe('OSM height interpretation', () => {
  it('uses explicit metres instead of replacing a real height with an estimate', () => {
    expect(deriveHeight({ height: '128.5 m', 'building:levels': '9' })).toEqual({
      height: 128.5, basis: 'height', estimated: false,
    });
  });
  it('converts feet and marks floor-derived heights as estimated', () => {
    expect(deriveHeight({ height: '100 ft' }).height).toBeCloseTo(30.48);
    expect(deriveHeight({ 'building:levels': '8' })).toEqual({
      height: 25.6, basis: 'levels', estimated: true,
    });
  });
  it('does not accept negative, infinite or partly numeric heights as truth', () => {
    for (const height of ['-20', 'Infinity', '60;90', '12oops']) {
      expect(deriveHeight({ height, building: 'house' })).toEqual({
        height: 9.6, basis: 'fallback', estimated: true,
      });
    }
  });
  it('uses a deterministic conservative default, never random towers', () => {
    expect(deriveHeight({ building: 'industrial' }).height).toBe(10);
    expect(deriveHeight({ building: 'yes' }).height).toBe(12.8);
  });
});

describe('geographic boundaries and tiles', () => {
  const polygon = { type: 'Polygon' as const, coordinates: [
    [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
    [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]],
  ] };
  it('excludes polygon holes and accepts island polygons', () => {
    expect(insideBoundary([3, 3], polygon)).toBe(true);
    expect(insideBoundary([1.5, 1.5], polygon)).toBe(false);
    expect(insideBoundary([5, 5], polygon)).toBe(false);
    expect(insideBoundary([3, 3], { type: 'MultiPolygon', coordinates: [polygon.coordinates] })).toBe(true);
  });
  it('rejects open and nonfinite rings rather than passing invalid geometry to WebGL', () => {
    expect(validateRing([[0, 0], [1, 0], [1, 1], [0, 0]])).toBe(true);
    expect(validateRing([[0, 0], [1, 0], [1, 1]])).toBe(false);
    expect(validateRing([[0, 0], [1, NaN], [1, 1], [0, 0]])).toBe(false);
  });
  it('assigns stable geographic cells including exact grid edges', () => {
    expect(tileId([120.625, 31.325])).toBe('4825_1253');
    expect(tileBounds('4825_1253')).toEqual([120.625, 31.325, 120.65, 31.35]);
  });
  it('loads intersecting tiles nearest the view centre within a bounded budget', () => {
    const tiles = [
      { id: 'far', bounds: [0, 0, 1, 1] as [number, number, number, number], count: 1 },
      { id: 'near', bounds: [2, 2, 3, 3] as [number, number, number, number], count: 1 },
      { id: 'outside', bounds: [8, 8, 9, 9] as [number, number, number, number], count: 1 },
    ];
    expect(selectTiles(tiles, [0, 0, 4, 4], [2.5, 2.5], 1).map((t) => t.id)).toEqual(['near']);
    expect(selectTiles(tiles, [10, 10, 11, 11], [10, 10], 4)).toEqual([]);
  });
});
