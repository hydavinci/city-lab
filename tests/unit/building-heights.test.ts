import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createHeightProvider, parseHeightReference, referenceHeightFor } from '../../web/core/building-heights';
import { buildingHeightRecords } from '../../web/core/building-height-references';
import { buildArchitecture } from '../../web/core/building-architecture';
import type { BuildingFeature } from '../../web/core/types';

const tiles = readdirSync('public/data/c8a953228b2ff6af/tiles').filter(file => file.endsWith('.json')).flatMap(file =>
  (JSON.parse(readFileSync(`public/data/c8a953228b2ff6af/tiles/${file}`, 'utf8')) as { features: BuildingFeature[] }).features);
const tower = () => structuredClone(tiles.find(feature => feature.properties.id === 'way/802754584')!);
const towerRecord = buildingHeightRecords.find(record => record.sourceId === 'way/802754584')!;

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
        provider: 'verified-building-heights-v1', name: record.name, height: record.height,
      });
      expect(source).toEqual(before);
    }
    for (const id of ['way/822365266', 'way/475616608', 'way/475616605', 'way/475616602',
      'way/482784880', 'way/533115311', 'way/533115312', 'way/533115314', 'way/533115316',
      'way/822635142', 'way/462717404', 'way/567987723', 'way/1499197731']) {
      expect(referenceHeightFor(tiles.find(feature => feature.properties.id === id)!)).toBeUndefined();
    }
  });

  it.each([
    ['way/505305793', 166.9, 39], ['way/822635143', 188, undefined], ['way/822635144', 188, undefined],
  ] as const)('restores citywide independent tower %s without inventing evidence', (id, height, floors) => {
    const source = tiles.find(feature => feature.properties.id === id)!;
    const before = structuredClone(source), reference = referenceHeightFor(source);
    expect(reference).toMatchObject({ height, checkedAt: '2026-10-20' });
    if (floors === undefined) expect(reference).not.toHaveProperty('floors');
    else expect(reference).toHaveProperty('floors', floors);
    expect(parseHeightReference(JSON.stringify(reference), source.properties)).toEqual(reference);
    expect(source).toEqual(before);
    const shifted = structuredClone(source);
    shifted.geometry.coordinates = structuredClone(tower().geometry.coordinates);
    expect(() => referenceHeightFor(shifted)).toThrow(/footprint changed/i);
  });

  it.each([
    ['way/482784883', 100, true], ['way/482784884', 100, true], ['way/482784885', 160, false],
  ] as const)('restores Hudong tower %s with source precision and no invented floor count', (id, height, approximate) => {
    const source = tiles.find(feature => feature.properties.id === id)!;
    const before = structuredClone(source), reference = referenceHeightFor(source);
    expect(source.properties).toMatchObject({ height: 12.8, basis: 'fallback', estimated: true });
    expect(reference).toMatchObject({ provider: 'verified-building-heights-v1', height });
    expect(reference).not.toHaveProperty('floors');
    if (approximate) expect(reference).toHaveProperty('approximate', true);
    else expect(reference).not.toHaveProperty('approximate');
    expect(parseHeightReference(JSON.stringify(reference), source.properties)).toEqual(reference);
    expect(source).toEqual(before);
  });

  it('preserves approximate source precision and rejects an invalid precision flag', () => {
    const source = tower(), record = { ...towerRecord, approximate: true };
    expect(createHeightProvider('approximate-reference', [record]).resolve(source)).toHaveProperty('approximate', true);
    Reflect.set(record, 'approximate', 'yes');
    expect(() => createHeightProvider('invalid', [record])).toThrow(/height record/i);
  });

  it.each([
    ['way/475616606', 232, 54], ['way/475616607', 125, 28],
    ['way/475616603', 210, 52], ['way/475616604', 210, 52],
  ] as const)('enriches verified Shishan tower %s without changing the source', (id, height, floors) => {
    const source = tiles.find(feature => feature.properties.id === id)!;
    const before = structuredClone(source);
    expect(source.properties).toMatchObject({ height: 12.8, basis: 'fallback', estimated: true });
    const reference = referenceHeightFor(source);
    expect(reference).toMatchObject({ provider: 'verified-building-heights-v1', height, floors });
    expect(parseHeightReference(JSON.stringify(reference), source.properties)).toEqual(reference);
    expect(source).toEqual(before);
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
    const record = { ...towerRecord, sourceId: 'way/123', height: 88, floors: 20 };
    const source = tower();
    source.properties.id = record.sourceId;
    const provider = createHeightProvider('another-reference', [record]);
    record.height = 999;
    expect(provider.resolve(source)).toMatchObject({ provider: 'another-reference', height: 88, floors: 20 });
  });

  it.each([
    ['4826_1252', 'way/933819302'],
    ['4829_1253', 'way/494180282'], ['4829_1253', 'way/494180284'],
    ['4828_1252', 'way/522129366'], ['4828_1252', 'way/522129367'],
  ])('keeps existing landmark %s/%s ahead of any height provider', (tile, id) => {
    const source = (JSON.parse(readFileSync(`public/data/c8a953228b2ff6af/tiles/${tile}.json`, 'utf8')) as {
      features: BuildingFeature[];
    }).features.find(feature => feature.properties.id === id)!;
    const provider = createHeightProvider('other', [{ ...towerRecord, sourceId: source.properties.id }]);
    expect(provider.resolve(source)).toBeUndefined();
    expect(buildingHeightRecords.some(record => record.sourceId === id)).toBe(false);
  });

  it('rejects duplicate, invalid or untraceable data records', () => {
    const record = towerRecord;
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
