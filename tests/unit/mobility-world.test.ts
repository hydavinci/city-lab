import { describe, expect, it } from 'vitest';
import type { MobilityOptions } from '../../web/core/enhancements';
import type { MobileActor, MobilityChunk, SpawnGate } from '../../web/core/mobility';
import { MobilityWorld } from '../../web/core/mobility-world';
import { mobilityFixture, outsideGate, twoChunkFixture } from '../fixtures/citywide-mobility';
import { stitchChunks } from '../../pipeline/mobility/stitch';
import { project, unproject } from '../../pipeline/enhancements/geometry';

const options: MobilityOptions = { seed: 7, vehicles: 2, pedestrians: 2, arrivals: true };
const visibleGate: SpawnGate = { ...outsideGate, canRetire: () => false };
function run(world: MobilityWorld, steps: number, gate = outsideGate): void {
  for (let i = 0; i < steps; i++) world.step(gate);
}
function drivingChunk(): MobilityChunk {
  const { chunk } = mobilityFixture();
  chunk.network.routes = chunk.network.routes.filter(route => route.mode === 'drive');
  return chunk;
}
function person(actor: MobileActor): boolean { return actor.kind.startsWith('person-'); }

describe('deterministic nearby mobility world', () => {
  it('replays nonempty moving traffic from identical seeds and fixed steps', () => {
    const replay = () => {
      const world = new MobilityWorld(options);
      world.addChunk(mobilityFixture().chunk);
      run(world, 200);
      return world.snapshot();
    };
    const first = replay();
    expect(first).toEqual(replay());
    expect(first.time).toBe(10);
    expect(first.actors.length).toBeGreaterThan(0);
    expect(first.travelledByKind['car-a']).toBeGreaterThan(5);
    expect(first.travelledByKind['person-a']).toBeGreaterThan(1);
  });

  it('makes every step exactly 0.05 simulated seconds without wall-clock catch-up', () => {
    const world = new MobilityWorld({ ...options, arrivals: false });
    run(world, 17);
    expect(world.snapshot().time).toBeCloseTo(0.85, 12);
    expect(world.snapshot().actors).toEqual([]);
    expect(world.nextWakeTime()).toBeUndefined();
  });

  it('never spawns through the visibility gate and retains a future arrival wake-up', () => {
    const world = new MobilityWorld(options);
    world.addChunk(mobilityFixture().chunk);
    run(world, 200, { ...outsideGate, canSpawn: () => false });
    expect(world.snapshot().actors).toEqual([]);
    expect(world.nextWakeTime()).toBeGreaterThan(world.snapshot().time);
    run(world, 50);
    expect(world.snapshot().actors.length).toBeGreaterThan(0);
  });

  it('applies one vehicle and pedestrian budget across all loaded chunks', () => {
    const { chunk } = mobilityFixture(), other = mobilityFixture().chunk;
    other.id = 'cell/elsewhere';
    other.network.origin[0] += 0.1;
    for (const edge of other.network.edges) {
      const old = edge.id;
      edge.id = `other/${old}`; edge.next = edge.next.map(id => `other/${id}`);
    }
    other.network.routes.forEach(route => {
      route.edges = route.edges.map(id => `other/${id}`);
      route.entry = `other/${route.entry}`; route.exit = `other/${route.exit}`;
    });
    other.network.zones.forEach(zone => { zone.edges = zone.edges.map(id => `other/${id}`); });
    other.zoneIds = { z: 'junction/elsewhere' };
    other.ownedEdges = other.ownedEdges.map(id => `other/${id}`);
    other.ports.forEach(port => { port.edge = `other/${port.edge}`; port.coordinate[0] += 0.1; });
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 1 });
    world.addChunk(chunk); world.addChunk(other);
    for (let i = 0; i < 1000; i++) {
      world.step(visibleGate);
      const actors = world.snapshot().actors;
      expect(actors.filter(actor => !person(actor)).length).toBeLessThanOrEqual(1);
      expect(actors.filter(person).length).toBeLessThanOrEqual(1);
    }
    expect(world.snapshot().actors.length).toBe(2);
  });

  it('keeps centre positions on validated paths with bounded speed and acceleration', () => {
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 });
    const chunk = drivingChunk();
    world.addChunk(chunk);
    let previous: MobileActor | undefined, travelled = 0;
    for (let i = 0; i < 700; i++) {
      world.step(visibleGate);
      const actor = world.snapshot().actors[0];
      if (!actor) continue;
      expect(actor.kind).toBe('car-a');
      expect(actor.position[1]).toBe(0);
      expect(actor.position[0]).toBeGreaterThan(0);
      expect(actor.position[0]).toBeLessThanOrEqual(77.8);
      expect(actor.heading).toBeCloseTo(Math.PI / 2, 12);
      expect(actor.speed).toBeGreaterThanOrEqual(0);
      expect(actor.speed).toBeLessThanOrEqual(5);
      if (previous) {
        expect(actor.position[0]).toBeGreaterThanOrEqual(previous.position[0]);
        expect(actor.speed - previous.speed).toBeLessThanOrEqual(0.100001);
        travelled += actor.position[0] - previous.position[0];
      }
      previous = actor;
    }
    expect(travelled).toBeGreaterThan(60);
    expect(previous?.edge).toBe('b');
    expect(previous?.speed).toBe(0);
  });

  it('preserves full body spacing while queuing through an edge transition', () => {
    const world = new MobilityWorld({ ...options, vehicles: 12, pedestrians: 0 });
    world.addChunk(drivingChunk());
    let maxActors = 0;
    for (let i = 0; i < 2400; i++) {
      world.step(visibleGate);
      const actors = [...world.snapshot().actors].sort((a, b) => a.position[0] - b.position[0]);
      maxActors = Math.max(maxActors, actors.length);
      for (let j = 1; j < actors.length; j++) {
        expect(actors[j].position[0] - actors[j - 1].position[0]).toBeGreaterThanOrEqual(
          (actors[j].length + actors[j - 1].length) / 2 + 0.49);
      }
    }
    expect(maxActors).toBeGreaterThan(4);
  });

  it('keeps full-body spacing on a shared exit fed by two different approaches', () => {
    const chunk = drivingChunk(), approach = structuredClone(chunk.network.edges[0]);
    approach.id = 'merge'; approach.from = 'merge-in'; approach.sourceIds = ['way/104'];
    approach.points = [[0, 20], [40, 0]]; approach.length = Math.sqrt(2000);
    approach.corridor = [[[[-1, 16], [1, 24], [43, 3], [37, -3], [-1, 16]]]];
    approach.conflicts = [{ zone: 'z', enter: 36, exit: approach.length }];
    chunk.network.edges.push(approach); chunk.ownedEdges.push(approach.id);
    chunk.network.zones[0].edges.push(approach.id);
    chunk.network.routes.push({ id: 'merge-route', mode: 'drive', edges: ['merge', 'b'],
      allowed: ['car-a'], entry: 'merge', exit: 'b' });
    const world = new MobilityWorld({ ...options, vehicles: 6, pedestrians: 0 });
    world.addChunk(chunk);
    let common = 0;
    for (let i = 0; i < 2000; i++) {
      world.step(visibleGate);
      const actors = world.snapshot().actors.filter(actor => actor.edge === 'b').sort((a, b) => a.distance - b.distance);
      common = Math.max(common, actors.length);
      for (let j = 1; j < actors.length; j++) expect(actors[j].distance - actors[j - 1].distance).toBeGreaterThan(4.89);
    }
    expect(common).toBeGreaterThan(2);
  });

  it('holds visible actors at real exits instead of teleporting or retiring them', () => {
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 });
    world.addChunk(drivingChunk());
    run(world, 800, visibleGate);
    const actor = world.snapshot().actors[0];
    expect(actor?.position[0]).toBeGreaterThan(75);
    expect(actor?.speed).toBe(0);
    run(world, 400, visibleGate);
    expect(world.snapshot().actors[0]).toEqual(actor);
    expect(world.snapshot().passedByEntry).toEqual({});
    run(world, 1);
    expect(world.snapshot().actors).toEqual([]);
    expect(Object.values(world.snapshot().passedByEntry)).toEqual([1]);
  });

  it('retires and replaces offscreen traffic with new identities and real travelled distance', () => {
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 });
    world.addChunk(drivingChunk());
    run(world, 2400);
    expect(Object.values(world.snapshot().passedByEntry).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(3);
    expect(world.snapshot().travelledByKind['car-a']).toBeGreaterThan(300);
    expect(world.snapshot().actors[0]?.id).toBeGreaterThan(1);
  });

  it('does not mistake a following stop on the final edge for reaching its actual exit', () => {
    const world = new MobilityWorld({ ...options, vehicles: 4, pedestrians: 0 });
    world.addChunk(drivingChunk());
    run(world, 1600, { ...outsideGate, canRetire: (_cell, position) => position[0] < 75 });
    expect(world.snapshot().actors).toHaveLength(4);
    expect(world.snapshot().passedByEntry).toEqual({});
  });

  it('brakes for the speed limit on an upcoming edge before crossing into it', () => {
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 }), chunk = drivingChunk();
    chunk.network.edges.find(edge => edge.id === 'b')!.speed = 1;
    world.addChunk(chunk);
    let reached = false, previousSpeed = 0;
    for (let i = 0; i < 1000; i++) {
      world.step(visibleGate);
      const actor = world.snapshot().actors[0];
      if (!actor) continue;
      expect(previousSpeed - actor.speed).toBeLessThanOrEqual(0.200001);
      if (actor.edge === 'b') {
        reached = true;
        expect(actor.speed).toBeLessThanOrEqual(1.000001);
      }
      previousSpeed = actor.speed;
    }
    expect(reached).toBe(true);
  });

  it('advances gait by displacement and leaves stopped people in a stable phase', () => {
    const world = new MobilityWorld({ ...options, vehicles: 0, pedestrians: 1 });
    world.addChunk(mobilityFixture().chunk);
    run(world, 1, visibleGate);
    const before = world.snapshot().actors[0];
    expect(before?.kind).toBe('person-a');
    run(world, 20, visibleGate);
    const moving = world.snapshot().actors[0];
    expect(moving.position[1]).toBeGreaterThan(before.position[1]);
    expect(moving.walkPhase).not.toBe(before.walkPhase);
    expect(moving.walkPhase).toBeCloseTo((before.walkPhase + (moving.position[1] - before.position[1]) / 1.2) % 1, 8);
    run(world, 1000, visibleGate);
    const stopped = world.snapshot().actors[0];
    expect(stopped.speed).toBe(0);
    run(world, 100, visibleGate);
    expect(world.snapshot().actors[0].walkPhase).toBe(stopped.walkPhase);
  });

  it('converts different local origins at linked ports without cloning the actor', () => {
    const chunks = stitchChunks(Object.values(twoChunkFixture()));
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 });
    chunks.forEach(chunk => world.addChunk(chunk));
    const origin = chunks[0].network.origin;
    let first: MobileActor | undefined, previous = 0, crossed = false;
    for (let i = 0; i < 750; i++) {
      world.step(visibleGate);
      const actors = world.snapshot().actors;
      if (!actors.length) continue;
      expect(actors.length).toBe(1);
      const actor = actors[0], chunk = chunks.find(chunk => chunk.id === actor.cell)!;
      const xy = project(unproject(actor.position, chunk.network.origin), origin);
      first ??= actor;
      expect(actor.id).toBe(first.id);
      expect(actor.route).toBe(first.route);
      expect(xy[0]).toBeGreaterThanOrEqual(previous - 1e-6);
      expect(xy[0] - previous).toBeLessThan(3);
      previous = xy[0];
      crossed ||= actor.cell === 'cell/right';
    }
    expect(crossed).toBe(true);
    expect(previous).toBeGreaterThan(75);
  });

  it('brakes before an unavailable neighbour and resumes the same actor after loading it', () => {
    const [left, right] = stitchChunks(Object.values(twoChunkFixture()));
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 });
    world.addChunk(left);
    run(world, 600, visibleGate);
    const waiting = world.snapshot().actors[0];
    expect(waiting.cell).toBe(left.id);
    expect(waiting.edge).toBe('a');
    expect(waiting.position[0] + waiting.length / 2).toBeLessThan(40);
    expect(waiting.speed).toBe(0);
    world.addChunk(right);
    run(world, 600, visibleGate);
    const resumed = world.snapshot().actors[0];
    expect(resumed.id).toBe(waiting.id);
    expect(resumed.cell).toBe(right.id);
    expect(resumed.position[0]).toBeGreaterThan(-25);
  });

  it('rejects removing live ownership but allows unused chunks and fully drained chunks to unload', () => {
    const [left, right] = stitchChunks(Object.values(twoChunkFixture()));
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 });
    world.addChunk(left); world.addChunk(right);
    run(world, 1, visibleGate);
    expect(() => world.removeChunk(left.id)).toThrow(/live|actor|occup/i);
    expect(() => world.removeChunk(right.id)).not.toThrow();
    run(world, 100, visibleGate);
    expect(world.snapshot().actors[0].cell).toBe(left.id);
  });

  it('does not spawn on halo-only geometry or invent a terminal loop', () => {
    const pair = Object.values(twoChunkFixture());
    for (const chunk of pair) {
      chunk.network.zones = []; chunk.zoneIds = {};
      chunk.network.edges.forEach(edge => { edge.conflicts = []; });
    }
    const [left, right] = stitchChunks(pair);
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 });
    world.addChunk(right);
    run(world, 500, visibleGate);
    const actor = world.snapshot().actors[0];
    expect(actor.cell).toBe(right.id);
    expect(actor.edge).toBe('b');
    expect(actor.position[0]).toBeGreaterThan(-25);
    expect(actor.speed).toBe(0);
    run(world, 100, visibleGate);
    expect(world.snapshot().actors[0]).toEqual(actor);
    expect(left.ownedEdges).not.toContain(actor.edge);
  });

  it('never inserts a new actor into the body of an arrival just behind a seam entry', () => {
    const pair = Object.values(twoChunkFixture());
    for (const chunk of pair) {
      chunk.network.zones = []; chunk.zoneIds = {};
      chunk.network.edges.forEach(edge => { edge.conflicts = []; });
    }
    const chunks = stitchChunks(pair), world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 });
    chunks.forEach(chunk => world.addChunk(chunk));
    const leftOnly: SpawnGate = { ...visibleGate, canSpawn: cell => cell === 'cell/left' };
    for (let i = 0; i < 300 && world.snapshot().actors[0]?.cell !== 'cell/right'; i++) world.step(leftOnly);
    expect(world.snapshot().actors[0]?.cell).toBe('cell/right');
    world.setOptions({ ...options, vehicles: 2, pedestrians: 0 });
    world.step({ ...visibleGate, canSpawn: cell => cell === 'cell/right' });
    const actors = world.snapshot().actors;
    expect(actors).toHaveLength(1);
  });

  it('retains the previous chunk until the complete trailing body has crossed a seam', () => {
    const chunks = stitchChunks(Object.values(twoChunkFixture()));
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 });
    chunks.forEach(chunk => world.addChunk(chunk));
    for (let i = 0; i < 300 && world.snapshot().actors[0]?.cell !== 'cell/right'; i++) world.step(visibleGate);
    expect(world.snapshot().actors[0]?.cell).toBe('cell/right');
    expect(() => world.removeChunk('cell/left')).toThrow(/live|actor|body/i);
    run(world, 100, visibleGate);
    expect(() => world.removeChunk('cell/left')).not.toThrow();
  });

  it('interpolates only the actual walking segments and changes heading at their shared node', () => {
    const world = new MobilityWorld({ ...options, vehicles: 0, pedestrians: 1 }), chunk = mobilityFixture().chunk;
    const edge = chunk.network.edges.find(edge => edge.id === 'w')!;
    edge.points = [[40, -10], [40, 0], [50, 0]];
    edge.corridor = [[[[39, -10], [41, -10], [41, -1], [50, -1], [50, 1], [39, 1], [39, -10]]]];
    world.addChunk(chunk);
    let horizontal = false, vertical = false;
    for (let i = 0; i < 600; i++) {
      world.step(visibleGate);
      const actor = world.snapshot().actors[0];
      if (!actor) continue;
      if (actor.distance <= 10) {
        vertical = true;
        expect(actor.position[0]).toBe(40);
        expect(actor.position[1]).toBeCloseTo(actor.distance - 10, 10);
        expect(actor.heading).toBe(0);
      } else {
        horizontal = true;
        expect(actor.position[0]).toBeCloseTo(actor.distance + 30, 10);
        expect(actor.position[1]).toBe(0);
        expect(actor.heading).toBeCloseTo(Math.PI / 2, 12);
      }
    }
    expect(vertical && horizontal).toBe(true);
  });

  it('keeps full-body following safe across a seam with different local origins', () => {
    const chunks = stitchChunks(Object.values(twoChunkFixture()));
    const world = new MobilityWorld({ ...options, vehicles: 8, pedestrians: 0 });
    chunks.forEach(chunk => world.addChunk(chunk));
    let seen = 0;
    for (let i = 0; i < 1600; i++) {
      world.step(visibleGate);
      const positions = world.snapshot().actors.map(actor => ({ actor,
        x: project(unproject(actor.position, chunks.find(chunk => chunk.id === actor.cell)!.network.origin), chunks[0].network.origin)[0] }))
        .sort((a, b) => a.x - b.x);
      seen = Math.max(seen, positions.length);
      for (let j = 1; j < positions.length; j++) expect(positions[j].x - positions[j - 1].x).toBeGreaterThan(4.89);
    }
    expect(seen).toBeGreaterThan(3);
  });

  it('preserves live actors when arrivals are disabled and safely drains a reduced budget', () => {
    const world = new MobilityWorld({ ...options, vehicles: 3, pedestrians: 0 });
    world.addChunk(drivingChunk());
    run(world, 200, visibleGate);
    expect(world.snapshot().actors.length).toBeGreaterThan(1);
    world.setOptions({ ...options, vehicles: 0, pedestrians: 0, arrivals: false });
    run(world, 10, visibleGate);
    expect(world.snapshot().actors.length).toBeGreaterThan(1);
    run(world, 1000);
    expect(world.snapshot().actors).toEqual([]);
    expect(world.nextWakeTime()).toBeUndefined();
  });

  it('isolates snapshots and owned chunk data from caller mutation', () => {
    const world = new MobilityWorld(options), chunk = mobilityFixture().chunk;
    world.addChunk(chunk);
    chunk.network.edges[0].points[0][0] = 12345;
    run(world, 1);
    const snapshot = world.snapshot(), x = snapshot.actors[0].position[0];
    snapshot.actors[0].position[0] = -999;
    expect(world.snapshot().actors[0].position[0]).toBe(x);
    expect(x).toBeLessThan(20);
  });

  it('deterministically mixes only the actor kinds allowed on each route', () => {
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 1 }), chunk = mobilityFixture().chunk;
    for (const edge of chunk.network.edges) edge.allowed = edge.mode === 'drive'
      ? ['car-a', 'car-b', 'bus'] : ['person-a', 'person-b'];
    for (const route of chunk.network.routes) route.allowed = route.mode === 'drive'
      ? ['car-a', 'car-b', 'bus'] : ['person-a', 'person-b'];
    for (const port of chunk.ports) port.allowed = ['car-a', 'car-b', 'bus'];
    world.addChunk(chunk);
    const kinds = new Set<string>();
    for (let i = 0; i < 6000; i++) {
      world.step(outsideGate);
      for (const actor of world.snapshot().actors) {
        kinds.add(actor.kind);
        expect(person(actor)).toBe(actor.edge === 'w');
        if (actor.kind === 'bus') expect([actor.length, actor.width]).toEqual([10, 2.5]);
      }
    }
    expect([...kinds].sort()).toEqual(['bus', 'car-a', 'car-b', 'person-a', 'person-b']);
  });

  it('rejects a late chunk with a dangling reciprocal seam without disturbing live actors', () => {
    const [left, right] = stitchChunks(Object.values(twoChunkFixture()));
    const world = new MobilityWorld({ ...options, vehicles: 1, pedestrians: 0 });
    world.addChunk(left); run(world, 50, visibleGate);
    const before = world.snapshot();
    right.ports.find(port => port.links.length)!.links = [];
    expect(() => world.addChunk(right)).toThrow(/seam|symmetric/i);
    expect(world.snapshot()).toEqual(before);
  });

  it('clears actors, chunks, counters and scheduled arrivals for a deterministic restart', () => {
    const world = new MobilityWorld(options);
    world.addChunk(mobilityFixture().chunk);
    run(world, 200);
    world.clear();
    expect(world.snapshot().actors).toEqual([]);
    expect(world.snapshot().owners).toEqual({});
    expect(world.snapshot().passedByEntry).toEqual({});
    expect(Object.values(world.snapshot().travelledByKind)).toEqual([0, 0, 0, 0, 0]);
    expect(world.nextWakeTime()).toBeUndefined();
    world.addChunk(mobilityFixture().chunk);
    run(world, 200);
    const fresh = new MobilityWorld(options);
    fresh.addChunk(mobilityFixture().chunk); run(fresh, 200);
    expect(world.snapshot()).toEqual(fresh.snapshot());
  });

  it('rejects duplicate ownership rather than producing two copies of traffic', () => {
    const world = new MobilityWorld(options), first = mobilityFixture().chunk, duplicate = mobilityFixture().chunk;
    duplicate.id = 'cell/duplicate';
    world.addChunk(first);
    expect(() => world.addChunk(duplicate)).toThrow(/own|duplicate/i);
    run(world, 200);
    expect(world.snapshot().actors.every(actor => actor.cell === first.id)).toBe(true);
  });

  it.each([
    { seed: NaN }, { vehicles: -1 }, { pedestrians: 1.5 }, { vehicles: 121 }, { pedestrians: 181 }, { arrivals: 'yes' },
  ])('rejects invalid options %j', invalid => {
    expect(() => new MobilityWorld({ ...options, ...invalid } as MobilityOptions)).toThrow();
  });
});
