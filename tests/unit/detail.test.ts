import { describe, expect, it } from 'vitest';
import { accessoryFootprints, detailVisible, facadeKind } from '../../web/core/detail';
import { project, unproject, validateEnvelope, polygonsIntersect } from '../../pipeline/enhancements/geometry';
import type { BuildingFeature } from '../../web/core/types';
import type { Polygon2, XY } from '../../web/core/enhancements';

const ring = (x: number, y: number, w: number, h: number): XY[] =>
  [[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]];
const shapes: Record<string, Polygon2[]> = {
  rectangle: [[ring(0,0,24,20)]],
  concave: [[[[0,0],[30,0],[30,8],[8,8],[8,30],[0,30],[0,0]]]],
  courtyard: [[ring(0,0,30,30),ring(7,7,16,16)]],
  multipolygon: [[ring(0,0,18,18)],[ring(30,0,16,16)]],
  tiny: [[ring(0,0,0.3,0.3)]],
};
function feature(polygons: Polygon2[]): BuildingFeature {
  return {
    type: 'Feature', properties: { id: 'way/42', name: '', kind: 'yes', height: 32, basis: 'height', estimated: false },
    geometry: { type: 'MultiPolygon', coordinates: polygons.map(p=>p.map(r=>r.map(p=>unproject(p,[120.67,31.31])))) },
  };
}

describe('legal inferred building details', () => {
  it('keeps detail stable through the hysteresis band', () => {
    expect(detailVisible(false,0.7)).toBe(false);
    expect(detailVisible(true,0.7)).toBe(true);
    expect(detailVisible(false,0.8)).toBe(true);
    expect(detailVisible(true,0.5)).toBe(true);
    expect(detailVisible(true,0.4)).toBe(false);
    expect(detailVisible(true,NaN)).toBe(false);
  });
  it.each(Object.entries(shapes))('contains every accessory, preserves holes and provenance: %s', (name, polygons) => {
    const input = feature(polygons), original = structuredClone(input);
    const result = accessoryFootprints(input);
    expect(result).toEqual(accessoryFootprints(input));
    expect(input).toEqual(original);
    const local = input.geometry.coordinates as number[][][][];
    const source = local.map(p=>p.map(r=>r.map(p=>project(p as XY,result.origin))));
    const accessories = [...result.roofs,...result.entrances];
    if (name === 'tiny') {
      expect(accessories).toHaveLength(0);
      expect(result.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ sourceIds: ['way/42'] })]));
    } else {
      expect(accessories.length).toBeGreaterThan(0);
      for (const p of accessories) expect(()=>validateEnvelope([p],source,[],[])).not.toThrow();
      accessories.forEach((p,i)=>accessories.slice(i+1).forEach(q=>expect(polygonsIntersect(p,q)).toBe(false)));
      if (name === 'multipolygon') {
        expect(accessories.some(p=>p[0][0][0] > 29)).toBe(true);
        expect(accessories.some(p=>p[0][0][0] < 19)).toBe(true);
      }
    }
  });
  it('reports unsupported invalid rings rather than generating unvalidated equipment', () => {
    const f = feature([[[[0,0],[20,20],[20,0],[0,20],[0,0]]]]);
    expect(accessoryFootprints(f)).toMatchObject({ roofs: [], entrances: [], skipped: [expect.objectContaining({ sourceIds: ['way/42'] })] });
  });
  it('uses known kind first and deterministic ID/height/area fallback profiles', () => {
    const b = feature(shapes.rectangle).properties;
    for (const [kind,want] of [['apartments','residential'],['office','office'],['retail','commercial'],['warehouse','industrial']] as const) {
      expect(facadeKind({...b,kind})).toBe(want);
    }
    const results = Array.from({length:100},(_,i)=>facadeKind({...b,id:`way/${i}`},480));
    expect(new Set(results)).toEqual(new Set(['residential','office','commercial','industrial']));
    expect(results).toEqual(Array.from({length:100},(_,i)=>facadeKind({...b,id:`way/${i}`},480)));
  });
});
