import { describe, expect, it } from 'vitest';
import { ConflictReservations } from '../../web/core/mobility-conflicts';
import { MobilityWorld } from '../../web/core/mobility-world';
import type { Actor, MobilityOptions } from '../../web/core/enhancements';
import { mobilityFixture, outsideGate, twoChunkFixture } from '../fixtures/citywide-mobility';
import { stitchChunks } from '../../pipeline/mobility/stitch';
import { compileCell } from '../../pipeline/mobility/compile';
import { routeFixture } from '../fixtures/enhancements';

function overlap(a: Actor, b: Actor): boolean {
  const axes = (actor: Actor) => [[Math.sin(actor.heading), Math.cos(actor.heading)],
    [Math.cos(actor.heading), -Math.sin(actor.heading)]];
  const aa = axes(a), bb = axes(b), dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1];
  return [...aa, ...bb].every(axis => {
    const centres = Math.abs(dot([a.position[0] - b.position[0], a.position[1] - b.position[1]], axis));
    const radius = (actor: Actor, axes: number[][]) =>
      actor.length / 2 * Math.abs(dot(axes[0], axis)) + actor.width / 2 * Math.abs(dot(axes[1], axis));
    return centres < radius(a, aa) + radius(b, bb) - 1e-6;
  });
}

describe('atomic fair conflict reservations', () => {
  it('does not split multi-zone ownership into circular wait', () => {
    const reservations = new ConflictReservations();
    reservations.request(1, ['a', 'b'], 0);
    reservations.request(2, ['b', 'a'], 0);
    expect(reservations.grant(() => true)).toEqual([1]);
    expect(reservations.owners()).toEqual({ a: 1, b: 1 });
    reservations.release(1);
    expect(reservations.grant(() => true)).toEqual([2]);
  });

  it('uses first eligible time and then actor identity, not request insertion order', () => {
    const reservations = new ConflictReservations();
    reservations.request(3, ['a'], 2);
    reservations.request(2, ['a'], 1);
    reservations.request(1, ['a'], 1);
    expect(reservations.grant(() => true)).toEqual([1]);
    reservations.release(1);
    expect(reservations.grant(() => true)).toEqual([2]);
    reservations.release(2);
    expect(reservations.grant(() => true)).toEqual([3]);
  });

  it('protects an older eligible multi-zone request while allowing independent traffic', () => {
    const reservations = new ConflictReservations();
    reservations.request(1, ['a'], 0);
    reservations.grant(() => true);
    reservations.request(2, ['a', 'b'], 1);
    reservations.request(3, ['b'], 2);
    reservations.request(4, ['c'], 2);
    expect(reservations.grant(() => true)).toEqual([4]);
    reservations.release(1);
    expect(reservations.grant(() => true)).toEqual([2]);
    reservations.release(2);
    expect(reservations.grant(() => true)).toEqual([3]);
  });

  it('does not grant when exit storage is blocked and does not waste independent capacity', () => {
    const reservations = new ConflictReservations();
    reservations.request(1, ['a'], 0);
    reservations.request(2, ['a'], 1);
    expect(reservations.grant(actor => actor !== 1)).toEqual([2]);
    expect(reservations.owners()).toEqual({ a: 2 });
  });

  it('does not let a previously ineligible request jump an already eligible older queue', () => {
    const reservations = new ConflictReservations();
    reservations.request(9, ['a'], 0); reservations.grant(() => true);
    reservations.request(1, ['a'], 1);
    reservations.request(2, ['a'], 2);
    reservations.grant(actor => actor !== 1);
    reservations.request(1, ['a'], 3);
    reservations.release(9);
    expect(reservations.grant(() => true)).toEqual([2]);
  });

  it('keeps queue age across identical retries and resets it for a changed ungranted route', () => {
    const reservations = new ConflictReservations();
    reservations.request(9, ['a'], 0); reservations.grant(() => true);
    reservations.request(1, ['a'], 1); reservations.grant(() => true);
    reservations.request(2, ['a'], 2); reservations.grant(() => true);
    reservations.request(1, ['a'], 3); reservations.release(9);
    expect(reservations.grant(() => true)).toEqual([1]);
    reservations.release(1); reservations.release(2);
    reservations.request(1, ['b'], 4);
    reservations.request(2, ['c'], 5);
    reservations.request(1, ['c'], 6);
    expect(reservations.grant(() => true)).toEqual([2]);
  });

  it('cancels queues and ownership without leaking aliases or mutating returned snapshots', () => {
    const reservations = new ConflictReservations();
    reservations.request(1, ['a'], 0); reservations.grant(() => true);
    reservations.request(2, ['a'], 1); reservations.release(2);
    const owners = reservations.owners() as Record<string, number>;
    owners.a = 999;
    expect(reservations.owners()).toEqual({ a: 1 });
    reservations.clear();
    expect(reservations.owners()).toEqual({});
    expect(reservations.grant(() => true)).toEqual([]);
  });

  it('refuses to silently exchange an occupied zone for a different route', () => {
    const reservations = new ConflictReservations();
    reservations.request(1, ['a'], 0); reservations.grant(() => true);
    expect(() => reservations.request(1, ['b'], 1)).toThrow(/release|occupied|held/i);
    expect(reservations.owners()).toEqual({ a: 1 });
  });
});

describe('world junction and crossing coordination', () => {
  const options: MobilityOptions = { seed: 7, vehicles: 4, pedestrians: 4, arrivals: true };
  const chunk = () => stitchChunks([mobilityFixture().chunk])[0];
  const step = (world: MobilityWorld, count: number) => { for (let i = 0; i < count; i++) world.step(outsideGate); };

  it('keeps cars and walking people physically disjoint for ten simulated minutes while both modes pass', () => {
    const world = new MobilityWorld(options), cell = chunk(), zone = cell.zoneIds[cell.network.zones[0].id];
    world.addChunk(cell);
    for (let i = 0; i < 12000; i++) {
      world.step(outsideGate);
      const snapshot = world.snapshot();
      for (const [index, actor] of snapshot.actors.entries()) {
        const walk = actor.kind.startsWith('person-'), hx = (walk ? actor.width : actor.length) / 2;
        const hy = (walk ? actor.length : actor.width) / 2;
        if (actor.position[0] + hx > 35 && actor.position[0] - hx < 42
          && actor.position[1] + hy > -2 && actor.position[1] - hy < 2) {
          expect(snapshot.owners[zone]).toBe(actor.id);
        }
        for (const other of snapshot.actors.slice(index + 1)) {
          const otherWalk = other.kind.startsWith('person-'), ox = (otherWalk ? other.width : other.length) / 2;
          const oy = (otherWalk ? other.length : other.width) / 2;
          expect(Math.abs(actor.position[0] - other.position[0]) >= hx + ox - 1e-6
            || Math.abs(actor.position[1] - other.position[1]) >= hy + oy - 1e-6).toBe(true);
        }
      }
    }
    expect(world.snapshot().time).toBe(600);
    expect(world.snapshot().passedByEntry['cell/0/drive']).toBeGreaterThan(5);
    expect(world.snapshot().passedByEntry['cell/0/walk']).toBeGreaterThan(5);
  });

  it('eventually serves every admitted actor in finite contention when exits are available', () => {
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 1 });
    world.addChunk(chunk()); step(world, 60);
    expect(world.snapshot().actors).toHaveLength(2);
    world.setOptions({ ...options, vehicles: 1, pedestrians: 1, arrivals: false });
    step(world, 2000);
    expect(world.snapshot().actors).toEqual([]);
    expect(world.snapshot().passedByEntry).toEqual({ 'cell/0/drive': 1, 'cell/0/walk': 1 });
    expect(world.snapshot().owners).toEqual({});
  });

  it('serves vehicles admitted from opposite approaches without overlapping their turning bodies', () => {
    const { source, selection } = routeFixture();
    source.elements.find(element => element.type === 'way' && element.id === 101).tags = {
      highway: 'residential', oneway: 'no', lanes: '2',
    };
    const result = compileCell({ id: 'opposing', bounds: [-0.004, -0.004, 0.004, 0.004], source,
      baseDataset: selection.baseDataset, buildings: [], water: [], placements: [] });
    const cell = stitchChunks([result.chunk!])[0];
    cell.network.routes.filter(route => route.mode === 'drive').forEach(route => { route.allowed = ['car-a']; });
    const world = new MobilityWorld({ ...options, vehicles: 2, pedestrians: 0 });
    world.addChunk(cell);
    for (let i = 0; i < 100 && world.snapshot().actors.length < 2; i++) {
      world.step({ ...outsideGate, canSpawn: (_cell, position) =>
        world.snapshot().actors.length === 0 ? position[0] < -200 : position[0] > 200 });
    }
    expect(world.snapshot().actors).toHaveLength(2);
    expect(world.snapshot().actors.some(actor => actor.position[0] < -200)).toBe(true);
    expect(world.snapshot().actors.some(actor => actor.position[0] > 200)).toBe(true);
    world.setOptions({ ...options, vehicles: 2, pedestrians: 0, arrivals: false });
    for (let i = 0; i < 5000; i++) {
      world.step(outsideGate);
      const actors = world.snapshot().actors;
      if (actors.length === 2) expect(overlap(actors[0], actors[1])).toBe(false);
    }
    expect(world.snapshot().actors).toEqual([]);
    expect(Object.values(world.snapshot().passedByEntry).reduce((sum, n) => sum + n, 0)).toBe(2);
  });

  it('waits before a shared junction when its neighbour and exit storage are unknown', () => {
    const [left, right] = stitchChunks(Object.values(twoChunkFixture()));
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 });
    world.addChunk(left); step(world, 700);
    const waiting = world.snapshot().actors[0], edge = left.network.edges.find(edge => edge.id === waiting.edge)!;
    expect(waiting.distance).toBeLessThan(edge.conflicts[0].enter);
    expect(world.snapshot().owners).toEqual({});
    world.addChunk(right); step(world, 700);
    expect(world.snapshot().passedByEntry['cell/left/drive']).toBeGreaterThan(0);
  });

  it('retains one canonical reservation until the complete body clears a seam-spanning zone', () => {
    const chunks = stitchChunks(Object.values(twoChunkFixture()));
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0, arrivals: true });
    chunks.forEach(chunk => world.addChunk(chunk));
    const zone = chunks[0].zoneIds[chunks[0].network.zones[0].id];
    let heldAcrossSeam = false, cleared = false;
    for (let i = 0; i < 500; i++) {
      world.step({ ...outsideGate, canRetire: () => false });
      const snapshot = world.snapshot(), actor = snapshot.actors[0];
      if (actor?.cell === 'cell/right') {
        if (actor.distance < 4.2) {
          expect(snapshot.owners[zone]).toBe(actor.id); heldAcrossSeam = true;
        } else if (actor.distance > 7) {
          expect(snapshot.owners[zone]).toBeUndefined(); cleared = true;
        }
      }
    }
    expect(heldAcrossSeam && cleared).toBe(true);
  });

  it('retains a neighbour whose exit storage is reserved before the actor reaches its seam', () => {
    const chunks = stitchChunks(Object.values(twoChunkFixture()));
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 });
    chunks.forEach(chunk => world.addChunk(chunk));
    for (let i = 0; i < 300 && !Object.keys(world.snapshot().owners).length; i++) world.step(outsideGate);
    const actor = world.snapshot().actors[0];
    expect(actor.cell).toBe('cell/left');
    expect(actor.position[0] + actor.length / 2).toBeLessThan(40);
    expect(Object.keys(world.snapshot().owners)).toHaveLength(1);
    expect(() => world.removeChunk('cell/right')).toThrow(/reserv|exit/i);
  });

  it('protects an already granted exit slot from new offscreen arrivals', () => {
    const raw = mobilityFixture().chunk, b = raw.network.edges.find(edge => edge.id === 'b')!;
    const exit = structuredClone(b);
    exit.id = 'exit'; exit.from = 'exit-start'; exit.points = [[48, 0], [80, 0]]; exit.length = 32;
    b.to = exit.from; b.points = [[40, 0], [48, 0]]; b.length = 8; b.next = ['exit'];
    raw.network.edges.push(exit); raw.ownedEdges.push(exit.id);
    raw.ports.find(port => port.id === 'drive-out')!.edge = exit.id;
    raw.network.routes[0].edges.push(exit.id); raw.network.routes[0].exit = exit.id;
    raw.network.routes.push({ id: 'exit-entry', mode: 'drive', edges: ['exit'], entry: 'exit',
      exit: 'exit', allowed: ['car-a'] });
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 });
    world.addChunk(stitchChunks([raw])[0]);
    for (let i = 0; i < 300 && !Object.keys(world.snapshot().owners).length; i++) {
      world.step({ ...outsideGate, canSpawn: (_cell, position) => position[0] < 5 });
    }
    expect(Object.keys(world.snapshot().owners)).toHaveLength(1);
    world.setOptions({ ...options, vehicles: 2, pedestrians: 0 });
    world.step({ ...outsideGate, canSpawn: (_cell, position) => position[0] > 48 });
    expect(world.snapshot().actors).toHaveLength(1);
  });

  it('waits outside an occupied junction exit and drains when downstream traffic can leave', () => {
    const world = new MobilityWorld({ ...options, vehicles: 12, pedestrians: 0 });
    world.addChunk(chunk());
    for (let i = 0; i < 4000; i++) world.step({ ...outsideGate, canRetire: () => false });
    expect(world.snapshot().actors.length).toBeGreaterThan(8);
    expect(world.snapshot().owners).toEqual({});
    expect(world.snapshot().actors.every(actor => actor.speed === 0
      && (actor.position[0] < 32 || actor.position[0] > 46))).toBe(true);
    const admitted = world.snapshot().actors.length;
    world.setOptions({ ...options, vehicles: 12, pedestrians: 0, arrivals: false });
    step(world, 5000);
    expect(world.snapshot().actors).toEqual([]);
    expect(world.snapshot().passedByEntry['cell/0/drive']).toBe(admitted);
  });

  it('serializes physical intersections of independent walking routes without inventing topology', () => {
    const { source } = routeFixture();
    source.elements = source.elements.filter(element => element.type !== 'way' || element.id === 103);
    source.elements.push(
      { type: 'node', id: 8, lon: 0, lat: 100 / 111319.49079327358 },
      { type: 'node', id: 9, lon: 0, lat: 600 / 111319.49079327358 },
      { type: 'way', id: 104, nodes: [8, 9], tags: { highway: 'footway', width: '2' } },
    );
    const result = compileCell({ id: 'walking-cross', bounds: [-0.004, -0.004, 0.004, 0.006], source,
      baseDataset: '0123456789abcdef', buildings: [], water: [], placements: [] });
    expect(result.status).toBe('ready');
    const network = result.chunk!.network;
    const used = new Set(network.routes.flatMap(route => route.edges));
    expect(network.routes).toHaveLength(2);
    expect(network.zones.some(zone => {
      const ways = new Set(zone.edges.filter(id => used.has(id)).flatMap(id =>
        network.edges.find(edge => edge.id === id)!.sourceIds));
      return ways.has('way/103') && ways.has('way/104');
    })).toBe(true);
    for (const route of network.routes) expect(new Set(route.edges.flatMap(id =>
      network.edges.find(edge => edge.id === id)!.sourceIds))).toHaveLength(1);
  });
});
