import { describe, expect, it } from 'vitest';
import { compileCell } from '../../pipeline/mobility/compile';
import { crossingFixture, routeFixture } from '../fixtures/enhancements';
import { parseMobilityChunk, type MobilityCell } from '../../web/core/mobility';
import type { Bounds } from '../../web/core/types';
import type { Polygon2 } from '../../web/core/enhancements';
import { spatialCandidates, unproject } from '../../pipeline/enhancements/geometry';

function input(fixture: ReturnType<typeof routeFixture> | ReturnType<typeof crossingFixture> = routeFixture()) {
  return { id: 'cell/test', bounds: fixture.selection.bounds as Bounds, source: fixture.source,
    baseDataset: fixture.selection.baseDataset, buildings: [] as Polygon2[],
    water: [] as Polygon2[], placements: [] as Polygon2[] };
}
const box = (w: number, s: number, e: number, n: number): Polygon2 =>
  [[[w, s], [e, s], [e, n], [w, n], [w, s]]];

it('spatial candidate indexing preserves exact overlap and source order, including broad obstacles', () => {
  const boxes = [
    { id: 'negative', bounds: [-130, -130, -65, -65] as Bounds },
    { id: 'broad', bounds: [-10000, -10000, 10000, 10000] as Bounds },
    { id: 'touching', bounds: [64, 64, 70, 70] as Bounds },
    { id: 'local', bounds: [0, 0, 1, 1] as Bounds },
  ];
  const nearby = spatialCandidates(boxes, item => item.bounds);
  expect(nearby([0, 0, 64, 64]).map(item => item.id)).toEqual(['broad', 'touching', 'local']);
  expect(nearby([-100, -100, -99, -99]).map(item => item.id)).toEqual(['negative', 'broad']);
  expect(nearby([20000, 20000, 20001, 20001])).toEqual([]);
  expect(nearby([-20000, -20000, 20000, 20000])).toEqual(boxes);
});

describe('automatic source-grounded mobility compilation', () => {
  it('compiles deterministically without a handwritten district selection', () => {
    const options = input(), before = structuredClone(options);
    const first = compileCell(options), second = compileCell(options);
    expect(first.status).toBe('ready');
    expect(first.chunk!.network.routes.some(r => r.mode === 'drive')).toBe(true);
    expect(first.chunk!.network.routes.some(r => r.mode === 'walk')).toBe(true);
    expect(second).toEqual(first);
    expect(options).toEqual(before);
    const cell: MobilityCell = { id: options.id, bounds: options.bounds, status: 'ready',
      neighbours: [], driveMetres: 1200, walkMetres: 600, diagnosticCodes: [] };
    expect(parseMobilityChunk(first.chunk, cell)).toEqual(first.chunk);
    expect(first.diagnostics.filter(d => d.code.startsWith('SELECTED_')).flatMap(d => d.sourceIds).sort())
      .toEqual(['way/101', 'way/102', 'way/103']);
  });

  it('keeps IDs, routes, surfaces and diagnostics stable under source reordering', () => {
    const options = input(), first = compileCell(options);
    options.source.elements.reverse();
    expect(compileCell(options)).toEqual(first);
  });

  it('emits geographic entry/exit ports and one visible surface per physical source segment', () => {
    const options = input(), { chunk } = compileCell(options);
    expect(chunk!.ports.length).toBeGreaterThan(0);
    const edges = new Map(chunk!.network.edges.map(e => [e.id, e]));
    for (const port of chunk!.ports) {
      const edge = edges.get(port.edge)!;
      expect(port.coordinate).toEqual(unproject(port.at === 'entry' ? edge.points[0] : edge.points.at(-1)!, chunk!.network.origin));
      expect(port.allowed).toEqual(edge.allowed);
    }
    expect(chunk!.surfaces).toHaveLength(5);
    expect(new Set(chunk!.surfaces.map(s => s.id)).size).toBe(5);
    expect(chunk!.surfaces.every(s => s.height === 0.3 && s.sourceIds.length && s.inferred.length)).toBe(true);
    expect(chunk!.surfaces.filter(s => s.mode === 'drive').every(s => s.width === 12)).toBe(true);
    expect(chunk!.ownedEdges.every(id => edges.has(id))).toBe(true);
  });

  it('does not invent topology at geometric intersections with different node IDs', () => {
    const options = input();
    options.source.elements.push({ ...options.source.elements[1], id: 8 });
    options.source.elements.find(e => e.id === 102)!.nodes = [4, 8, 5];
    const n = compileCell(options).chunk!.network;
    expect(n.edges.some(e => e.id.startsWith('turn/') && e.sourceIds.includes('way/101') && e.sourceIds.includes('way/102')))
      .toBe(false);
  });

  it('automatically discovers a complete source-backed crossing chain and shared reservations', () => {
    const options = input(crossingFixture()), n = compileCell(options).chunk!.network;
    expect(n.routes.some(r => r.mode === 'walk' && r.edges.some(id => id.includes('way/104')))).toBe(true);
    const shared = n.zones.filter(z => z.edges.some(id => n.edges.find(e => e.id === id)!.mode === 'walk'));
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.every(z => z.edges.some(id => n.edges.find(e => e.id === id)!.mode === 'drive'))).toBe(true);
  });

  it('excludes a crossing without connected side routes instead of guessing a nearby sidewalk', () => {
    const options = input(crossingFixture());
    options.source.elements.find(e => e.id === 105)!.nodes = [6, 7];
    const result = compileCell(options);
    expect(result.status).toBe('ready');
    expect(result.chunk!.network.edges.some(e => e.sourceIds.includes('way/104'))).toBe(false);
    expect(result.diagnostics.some(d => d.sourceIds.includes('way/104') && d.code.includes('CROSSING'))).toBe(true);
  });

  it('does not create a crossing where road and footway share no tagged crossing evidence', () => {
    const options = input();
    for (const id of [6, 7]) options.source.elements.find(e => e.id === id)!.lat = 100 / 111319.49079327358;
    const result = compileCell(options);
    expect(result.chunk!.network.routes.every(r => r.mode === 'drive')).toBe(true);
    expect(result.diagnostics.some(d => d.code === 'UNSOURCED_CROSSING')).toBe(true);
  });

  it.each([{ bridge: 'yes' }, { tunnel: 'yes' }, { layer: '1' }, { width: 'invalid' },
    { width: '1000' }, { lanes: '1000' }, { motor_vehicle: 'no' }, { access: 'destination' }])(
    'records and excludes unsupported source geometry or permission %j', tags => {
      const options = input();
      Object.assign(options.source.elements.find(e => e.id === 101)!.tags!, tags);
      const result = compileCell(options);
      expect(result.status).toBe('ready');
      expect(result.chunk!.network.edges.some(e => e.sourceIds.includes('way/101'))).toBe(false);
      expect(result.diagnostics.some(d => d.sourceIds.includes('way/101') && d.code.includes('EXCLUDED'))).toBe(true);
    });

  it('preserves reverse one-way restrictions and excludes buses from narrow turns', () => {
    const options = input();
    Object.assign(options.source.elements.find(e => e.id === 101)!.tags!, { oneway: '-1', maxspeed: '10 mph' });
    const n = compileCell(options).chunk!.network;
    const segments = n.edges.filter(e => e.id.startsWith('drive/way/101/'));
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every(e => e.points[0][0] > e.points.at(-1)![0] && e.speed <= 4.4704)).toBe(true);
    const turns = compileCell(input()).chunk!.network.edges.filter(e => e.id.startsWith('turn/')
      && e.sourceIds.includes('way/101') && e.sourceIds.includes('way/102'));
    expect(turns.some(e => e.allowed.includes('car-a'))).toBe(true);
    expect(turns.every(e => !e.allowed.includes('bus'))).toBe(true);
  });

  it('honours via-node turn restrictions without changing the source inventory by hand', () => {
    const options = input();
    options.source.elements.push({ type: 'relation', id: 201, tags: { type: 'restriction', restriction: 'no_right_turn' },
      members: [{ type: 'way', ref: 101, role: 'from' }, { type: 'node', ref: 2, role: 'via' },
        { type: 'way', ref: 102, role: 'to' }] });
    const n = compileCell(options).chunk!.network;
    expect(n.edges.some(e => e.id.startsWith('turn/') && e.from.includes('way/101') && e.sourceIds.includes('way/102')))
      .toBe(false);
  });

  it.each(['buildings', 'water', 'placements'] as const)('validates full body clearance against %s', obstacle => {
    const options = input();
    options[obstacle] = [box(-500, -20, 500, 20)];
    const result = compileCell(options);
    expect(result.chunk!.network.edges.some(e => e.sourceIds.includes('way/101'))).toBe(false);
    expect(result.diagnostics.some(d => d.code === 'UNSAFE_EDGE')).toBe(true);
  });

  it('supports independent walk-only cells without inventing cars or tagged-but-unmapped sidewalks', () => {
    const options = input();
    options.source.elements = options.source.elements.filter(e => e.type !== 'way' || e.id === 103);
    const result = compileCell(options);
    expect(result.status).toBe('ready');
    expect(result.chunk!.network.routes.every(r => r.mode === 'walk')).toBe(true);
    expect(result.chunk!.surfaces.every(s => s.mode === 'walk')).toBe(true);
  });

  it('uses boundary ports instead of excluding a short valid route close to an arbitrary showcase centre', () => {
    const options = input();
    options.source.elements = options.source.elements.filter(e => e.type !== 'way' || e.id === 103);
    const nodes = options.source.elements.filter(e => e.id === 6 || e.id === 7);
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].lon = (i ? 10 : -10) / 111319.49079327358; nodes[i].lat = 0;
    }
    const result = compileCell(options);
    expect(result.status).toBe('ready');
    expect(result.chunk!.network.routes.length).toBeGreaterThan(0);
  });

  it('distinguishes complete no-road cells from explicitly excluded roads', () => {
    const options = input();
    const empty = compileCell({ ...options, source: { ...options.source, elements: [] } });
    expect(empty.status).toBe('empty'); expect(empty.chunk).toBeUndefined();
    for (const e of options.source.elements.filter(e => e.type === 'way')) Object.assign(e.tags!, { access: 'no' });
    const excluded = compileCell(options);
    expect(excluded.status).toBe('excluded'); expect(excluded.chunk).toBeUndefined();
    expect(excluded.diagnostics.filter(d => d.code === 'EXCLUDED_WAY').length).toBe(3);
  });

  it('retains explicit diagnostics for unsupported road classes and incomplete crossing data', () => {
    const options = input();
    options.source.elements.push({ type: 'way', id: 999, nodes: [6, 7], tags: { highway: 'steps' } });
    const result = compileCell(options);
    expect(result.status).toBe('ready');
    expect(result.diagnostics.some(d => d.code === 'UNSUPPORTED_HIGHWAY' && d.sourceIds.includes('way/999'))).toBe(true);
  });

  it('propagates incomplete sources, invalid bounds and malformed obstacle geometry as errors', () => {
    const options = input();
    for (const patch of [
      { source: { ...options.source, remark: 'runtime error' } },
      { source: { ...options.source, elements: options.source.elements.slice(1) } },
      { water: [[[[0, 0], [1, 1]]]] },
      { bounds: [0, 0, NaN, 1] }, { bounds: [0, 0, 1, 1] },
    ]) expect(() => compileCell({ ...options, ...patch } as Parameters<typeof compileCell>[0])).toThrow();
  });

  it('never owns halo-only routes when the core has no usable traffic', () => {
    const options = input();
    options.bounds = [0.003, -0.001, 0.004, 0.001];
    const result = compileCell(options);
    expect(result.status).not.toBe('ready');
    expect(result.chunk).toBeUndefined();
  });
});
