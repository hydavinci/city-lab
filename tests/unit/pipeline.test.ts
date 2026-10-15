import { describe, expect, it } from 'vitest';
import { mergeSurfaceData, normalizeBuildings, validateOverpass } from '../../pipeline/normalize';
import type { FeatureCollection, Polygon } from 'geojson';

describe('real geometry processing', () => {
  const boundary: Polygon = { type: 'Polygon', coordinates: [
    [[120, 31], [121, 31], [121, 32], [120, 32], [120, 31]],
  ] };
  const collection: FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: 'way/10',
      properties: { building: 'house', height: '20', name: '测试建筑' },
      geometry: { type: 'Polygon', coordinates: [
        [[120.5, 31.5], [120.501, 31.5], [120.501, 31.501], [120.5, 31.5]],
      ] },
    }],
  };
  it('preserves real coordinates, source identifiers and explicit heights', () => {
    const result = normalizeBuildings(collection, boundary);
    expect(result.features[0].geometry).toEqual(collection.features[0].geometry);
    expect(result.features[0].properties).toMatchObject({
      id: 'way/10', height: 20, estimated: false, name: '测试建筑',
    });
    expect(result.skipped).toBe(0);
  });
  it('deduplicates source identifiers and rejects out-of-city buildings', () => {
    const outside = structuredClone(collection.features[0]);
    outside.id = 'way/11';
    outside.geometry = { type: 'Polygon', coordinates: [
      [[119, 30], [119.1, 30], [119.1, 30.1], [119, 30]],
    ] };
    const result = normalizeBuildings({
      type: 'FeatureCollection', features: [...collection.features, ...collection.features, outside],
    }, boundary);
    expect(result.features).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });
  it('does not turn building=no or untagged relation members into buildings', () => {
    const removed = structuredClone(collection.features[0]);
    removed.properties = { building: 'no' };
    const member = structuredClone(collection.features[0]);
    member.id = 'way/12';
    member.properties = { name: 'not a building' };
    const result = normalizeBuildings({ type: 'FeatureCollection', features: [removed, member] }, boundary);
    expect(result.features).toHaveLength(0);
    expect(result.skipped).toBe(2);
  });
  it('fails on partial Overpass responses rather than publishing an incomplete success', () => {
    expect(() => validateOverpass({ elements: [], remark: 'runtime error: Query timed out' })).toThrow('timed out');
    expect(() => validateOverpass({ error: 'busy' })).toThrow();
    expect(validateOverpass({ elements: [], osm3s: { timestamp_osm_base: '2026-10-14T00:00:00Z' } }).elements).toEqual([]);
    expect(() => validateOverpass({ elements: [] }, true)).toThrow('empty');
  });
  it('combines independently downloaded layers without duplicate source elements', () => {
    const result = mergeSurfaceData([
      { elements: [{ type: 'way', id: 1 }, { type: 'way', id: 2 }] },
      { elements: [{ type: 'way', id: 1 }, { type: 'relation', id: 1 }] },
      { elements: [{ type: 'way', id: 3 }] },
    ]);
    expect(result.elements).toHaveLength(4);
    expect(() => mergeSurfaceData([{ elements: [] }, { remark: 'timeout' }, { elements: [] }])).toThrow('timeout');
    expect(() => mergeSurfaceData([{ elements: [] }])).toThrow();
  });
});
