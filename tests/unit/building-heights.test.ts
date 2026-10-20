import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createHeightProvider, parseHeightReference, referenceHeightFor } from '../../web/core/building-heights';
import { buildingHeightRecords } from '../../web/core/building-height-references';
import { buildArchitecture } from '../../web/core/building-architecture';
import type { BuildingFeature } from '../../web/core/types';

const tiles = ['4828_1253', '4823_1252'].flatMap(tile =>
  (JSON.parse(readFileSync(`public/data/c8a953228b2ff6af/tiles/${tile}.json`, 'utf8')) as { features: BuildingFeature[] }).features);
const tower = () => structuredClone(tiles.find(feature => feature.properties.id === 'way/802754584')!);

describe('data-driven building height provider', () => {
  it.each(['mid', 'near'] as const)('retains separate source and height reference in standalone %s GLB metadata', lod => {
    const source = tower(), result = buildArchitecture(source, lod);
    const jsonLength = new DataView(result.bytes).getUint32(12, true);
    const document = JSON.parse(new TextDecoder().decode(new Uint8Array(result.bytes, 20, jsonLength)));
    expect(document.nodes[0].extras.source).toEqual(source.properties);
    expect(document.nodes[0].extras.heightReference).toEqual(referenceHeightFor(source));
    expect(document.nodes[0].extras.model).toBeUndefined();
  });

  it('matches verified tower records without mutating the source or raising neighboring podiums', () => {
    for (const record of buildingHeightRecords) {
      const source = tiles.find(feature => feature.properties.id === record.sourceId)!;
      const before = structuredClone(source);
      expect(referenceHeightFor(source)).toMatchObject({
        provider: 'verified-building-heights-v1', name: record.name, height: record.height, floors: record.floors,
      });
      expect(source).toEqual(before);
    }
    expect(referenceHeightFor(tiles.find(feature => feature.properties.id === 'way/822365266')!)).toBeUndefined();
  });

  it.each(['height', 'levels', 'reference'] as const)('never replaces existing %s source evidence', basis => {
    const source = tower();
    source.properties.basis = basis;
    expect(referenceHeightFor(source)).toBeUndefined();
  });

  it('rejects changed footprint identities instead of assigning a height by proximity', () => {
    const source = tower();
    source.geometry = { type: 'Polygon', coordinates: [[[120, 31], [121, 31], [121, 32], [120, 31]]] };
    expect(() => referenceHeightFor(source)).toThrow(/footprint changed/i);
    source.properties.id = 'way/unknown';
    expect(referenceHeightFor(source)).toBeUndefined();
  });

  it('accepts another data provider without building-specific modeling code', () => {
    const record = { ...buildingHeightRecords[0], sourceId: 'way/123', height: 88, floors: 20 };
    const source = tower();
    source.properties.id = record.sourceId;
    const provider = createHeightProvider('another-reference', [record]);
    record.height = 999;
    expect(provider.resolve(source)).toMatchObject({ provider: 'another-reference', height: 88, floors: 20 });
  });

  it('keeps existing landmark models ahead of any height provider', () => {
    const source = (JSON.parse(readFileSync('public/data/c8a953228b2ff6af/tiles/4826_1252.json', 'utf8')) as {
      features: BuildingFeature[];
    }).features.find(feature => feature.properties.id === 'way/933819302')!;
    const provider = createHeightProvider('other', [{ ...buildingHeightRecords[0], sourceId: source.properties.id }]);
    expect(provider.resolve(source)).toBeUndefined();
  });

  it('rejects duplicate, invalid or untraceable data records', () => {
    const record = buildingHeightRecords[0];
    expect(() => createHeightProvider('duplicate', [record, record])).toThrow(/duplicate/i);
    for (const patch of [
      { height: NaN }, { height: 0 }, { height: 1001 }, { floors: 0 }, { floors: 2.5 },
      { sources: [] }, { sources: [{ label: 'unsafe', url: 'javascript:alert(1)' }] },
      { checkedAt: 'not-a-date' }, { identity: '' }, { bounds: [121, 31, 120, 32] as [number, number, number, number] },
    ]) expect(() => createHeightProvider('invalid', [{ ...record, ...patch }])).toThrow(/height record/i);
  });

  it('parses only current reference metadata with fallback source semantics', () => {
    const source = tower(), reference = referenceHeightFor(source)!;
    expect(parseHeightReference(JSON.stringify(reference), source.properties)).toEqual(reference);
    expect(parseHeightReference('', source.properties)).toBeUndefined();
    expect(() => parseHeightReference(JSON.stringify({ ...reference, height: 999 }), source.properties)).toThrow(/height metadata/i);
    expect(() => parseHeightReference(JSON.stringify(reference), { ...source.properties, basis: 'height' })).toThrow(/height metadata/i);
    expect(() => parseHeightReference(JSON.stringify(reference), { ...source.properties, estimated: false })).toThrow(/height metadata/i);
  });
});
