import { describe, expect, it } from 'vitest';
import { stitchChunks } from '../../pipeline/mobility/stitch';
import { compileCell } from '../../pipeline/mobility/compile';
import { twoChunkFixture } from '../fixtures/citywide-mobility';
import { routeFixture } from '../fixtures/enhancements';
import { parseMobilityChunk } from '../../web/core/mobility';
import type { Bounds } from '../../web/core/types';
import { distance, project, unproject } from '../../pipeline/enhancements/geometry';
import type { XY } from '../../web/core/enhancements';

describe('stable physical mobility seams and reservations', () => {
  it('connects different origins without duplicating edges or changing source inputs', () => {
    const { left, right } = twoChunkFixture(), before = structuredClone({ left, right });
    expect(left.network.origin).not.toEqual(right.network.origin);
    const stitched = stitchChunks([left, right]);
    expect({ left, right }).toEqual(before);
    expect(stitched).toHaveLength(2);
    const a = stitched.find(c => c.id === left.id)!, b = stitched.find(c => c.id === right.id)!;
    const out = a.ports.find(port => port.edge === 'a' && port.at === 'exit')!;
    const entry = b.ports.find(port => port.edge === 'b' && port.at === 'entry')!;
    expect(out.links).toEqual([{ cell: b.id, port: entry.id }]);
    expect(entry.links).toEqual([{ cell: a.id, port: out.id }]);
    expect(distance(project(out.coordinate, a.network.origin), project(entry.coordinate, a.network.origin))).toBeLessThanOrEqual(0.05);
    const owned = stitched.flatMap(c => c.ownedEdges);
    expect(new Set(owned).size).toBe(owned.length);
    for (const chunk of stitched) {
      expect(parseMobilityChunk(chunk, { id: chunk.id, bounds: chunk.bounds, status: 'ready',
        neighbours: stitched.filter(c => c !== chunk).map(c => c.id),
        driveMetres: 80, walkMetres: 20, diagnosticCodes: [] })).toEqual(chunk);
    }
  });

  it('uses one canonical zone and propagates complete conflict geometry into both halo networks', () => {
    const { left, right } = twoChunkFixture(), stitched = stitchChunks([left, right]);
    const aliases = stitched.flatMap(c => Object.values(c.zoneIds));
    expect(new Set(aliases).size).toBe(1);
    for (const chunk of stitched) {
      const edge = chunk.network.edges.find(e => e.id === 'b')!;
      expect(edge.conflicts.length).toBeGreaterThan(0);
      expect(edge.conflicts[0].enter).toBe(0);
      expect(Object.values(chunk.zoneIds)).toContain(chunk.zoneIds[edge.conflicts[0].zone]);
    }
  });

  it('produces byte-stable IDs and links under input reordering', () => {
    const { left, right } = twoChunkFixture();
    expect(JSON.stringify(stitchChunks([left, right]))).toBe(JSON.stringify(stitchChunks([right, left])));
    const once = stitchChunks([left, right]), twice = stitchChunks(once);
    expect(twice.flatMap(c => Object.values(c.zoneIds))).toEqual(once.flatMap(c => Object.values(c.zoneIds)));
  });

  it('gives boundary-owned source geometry one deterministic owner and prunes duplicate ports', () => {
    const { left, right } = twoChunkFixture();
    right.ownedEdges.push('w');
    const stitched = stitchChunks([right, left]);
    expect(stitched.flatMap(c => c.ownedEdges).filter(id => id === 'w')).toHaveLength(1);
    expect(stitched.find(c => c.id === 'cell/left')!.ownedEdges).toContain('w');
    expect(stitched.find(c => c.id === 'cell/right')!.ports.some(p => p.edge === 'w')).toBe(false);
  });

  it('preserves a stricter halo body certificate without widening it to match its owning neighbour', () => {
    const { left, right } = twoChunkFixture();
    left.network.edges.find(edge => edge.id === 'a')!.allowed.push('car-b');
    const stitched = stitchChunks([left, right]);
    expect(stitched.find(chunk => chunk.id === left.id)!.network.edges.find(edge => edge.id === 'a')!.allowed)
      .toEqual(['car-a', 'car-b']);
    expect(stitched.find(chunk => chunk.id === right.id)!.network.edges.find(edge => edge.id === 'a')!.allowed)
      .toEqual(['car-a']);
  });

  it('does not link unrelated lines merely because their coordinates are close', () => {
    const { left, right } = twoChunkFixture();
    for (const chunk of [left, right]) {
      chunk.network.edges.find(e => e.id === 'a')!.next = [];
      chunk.network.routes[0] = { ...chunk.network.routes[0], edges: ['a'], entry: 'a', exit: 'a' };
      chunk.network.routes.push({ ...chunk.network.routes[0], id: 'drive-b', edges: ['b'], entry: 'b', exit: 'b' });
    }
    const stitched = stitchChunks([left, right]);
    expect(stitched.find(c => c.id === left.id)!.ports.find(p => p.id === 'left-out')!.links).toEqual([]);
  });

  it.each(['coordinate', 'mode', 'permission', 'geometry', 'surface', 'ownership', 'duplicate-cell'])(
    'rejects contradictory %s instead of connecting a convenient nearest route', failure => {
      const { left, right } = twoChunkFixture();
      if (failure === 'coordinate') right.ports[0].coordinate[0] += 0.00001;
      if (failure === 'mode') {
        const edge = right.network.edges.find(e => e.id === 'b')!;
        edge.mode = 'walk'; edge.allowed = ['person-a'];
      }
      if (failure === 'permission') right.network.edges.find(e => e.id === 'b')!.allowed = ['bus'];
      if (failure === 'geometry') right.network.edges.find(e => e.id === 'b')!.points[0][1] += 1;
      if (failure === 'surface') right.surfaces[0].height = 0.6;
      if (failure === 'ownership') right.ownedEdges.push('a');
      if (failure === 'duplicate-cell') right.id = left.id;
      expect(() => stitchChunks([left, right])).toThrow();
    });

  it('rejects dangling and asymmetric pre-existing links', () => {
    for (const target of ['missing', 'cell/right']) {
      const { left, right } = twoChunkFixture();
      left.ports.find(p => p.id === 'left-out')!.links = [{ cell: target, port: 'right-in' }];
      expect(() => stitchChunks([left, right])).toThrow();
    }
  });

  it('rejects reciprocal but unsourced links instead of silently rewriting them as success', () => {
    const { left, right } = twoChunkFixture();
    for (const chunk of [left, right]) {
      chunk.network.edges.find(e => e.id === 'a')!.next = [];
      chunk.network.routes[0] = { ...chunk.network.routes[0], edges: ['a'], entry: 'a', exit: 'a' };
      chunk.network.routes.push({ ...chunk.network.routes[0], id: 'drive-b', edges: ['b'], entry: 'b', exit: 'b' });
    }
    left.ports[1].links = [{ cell: right.id, port: 'right-in' }];
    right.ports[0].links = [{ cell: left.id, port: 'left-out' }];
    expect(() => stitchChunks([left, right])).toThrow();
  });

  it('can stitch a straight walk-only component without requiring a two-dimensional traffic hull', () => {
    const { source, selection } = routeFixture();
    source.elements = source.elements.filter(e => e.type !== 'way' || e.id === 103);
    const chunk = compileCell({ source, id: 'cell/walk', bounds: selection.bounds as Bounds,
      baseDataset: selection.baseDataset, buildings: [], water: [], placements: [] }).chunk!;
    const stitched = stitchChunks([chunk]);
    expect(stitched).toHaveLength(1);
    expect(stitched[0].network.routes.every(route => route.mode === 'walk')).toBe(true);
    expect(stitched[0].network.zones).toEqual([]);
  });

  it('does not give separate physical zones the same ID merely because they touch the same source edge', () => {
    const { left, right } = twoChunkFixture();
    for (const chunk of [left, right]) {
      chunk.network.edges.forEach(edge => { edge.conflicts = []; });
      chunk.network.zones = [10, 30].map((x, i) => ({
        id: `z${i}`, edges: ['a'], polygon: [[
          [x - 0.1, -0.1], [x + 0.1, -0.1], [x + 0.1, 0.1], [x - 0.1, 0.1], [x - 0.1, -0.1],
        ].map(point => project(unproject(point as XY, left.network.origin), chunk.network.origin))],
      }));
      chunk.network.edges.find(edge => edge.id === 'a')!.conflicts =
        [10, 30].map((x, i) => ({ zone: `z${i}`, enter: x - 1, exit: x + 1 }));
      chunk.zoneIds = { z0: 'unstitched/0', z1: 'unstitched/1' };
    }
    expect(new Set(stitchChunks([left, right]).flatMap(chunk => Object.values(chunk.zoneIds))).size).toBe(2);
  });

  it('reconciles automatically compiled halos without equating clipped and complete source geometry', () => {
    const { source, selection } = routeFixture();
    const options = { source, baseDataset: selection.baseDataset, buildings: [], water: [], placements: [] };
    const left = compileCell({ ...options, id: 'cell/left', bounds: [-0.004, -0.004, 0, 0.004] as Bounds }).chunk!;
    const right = compileCell({ ...options, id: 'cell/right', bounds: [0, -0.004, 0.004, 0.004] as Bounds }).chunk!;
    expect(left).toBeDefined(); expect(right).toBeDefined();
    const stitched = stitchChunks([left, right]), owned = stitched.flatMap(chunk => chunk.ownedEdges);
    expect(new Set(owned).size).toBe(owned.length);
    expect(owned.every(id => !id.includes('/clip/'))).toBe(true);
    expect(stitched.flatMap(chunk => chunk.ports).some(port => port.links.length > 0)).toBe(true);
    expect(stitched.flatMap(chunk => Object.values(chunk.zoneIds)).every(id => id.startsWith('junction/'))).toBe(true);
  });
});
