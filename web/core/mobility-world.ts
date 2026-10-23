import type { ActorKind, Edge, MobilityOptions, Route, XY } from './enhancements';
import { ACTORS } from './mobility-actors';
import { ConflictReservations } from './mobility-conflicts';
import {
  mobilityBudget, parseMobilityChunk, type MobileActor, type MobilityChunk, type SpawnGate, type WorldSnapshot,
} from './mobility';
import { distance, lerp, project } from '../../pipeline/enhancements/geometry';

export const MOBILITY_STEP = 0.05;
const GAP = 0.5, END_MARGIN = 0.05;
interface LoadedChunk { value: MobilityChunk; edges: Map<string, Edge>; owned: Set<string> }
interface Hop { cell: LoadedChunk; edge: Edge; route: Route; index: number; start: number }
interface Moving {
  actor: MobileActor; path: Hop[]; index: number; progress: number; previousProgress: number; entry: string; occupied: Set<string>;
}
interface Occupant { centre: number; back: number }
interface Entry { cell: LoadedChunk; route: Route; index: number; kind: ActorKind }
interface ConflictGroup { zones: string[]; enter: number; exit: number }
const walking = (kind: ActorKind) => kind.startsWith('person-');
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Mobility world: ${message}`);
}
function validateOptions(options: MobilityOptions): void {
  const maximum = mobilityBudget('high');
  check(Number.isSafeInteger(options.seed) && options.seed >= 0 && options.seed <= 0xffffffff, 'Invalid seed');
  for (const key of ['vehicles', 'pedestrians'] as const) {
    check(Number.isInteger(options[key]) && options[key] >= 0 && options[key] <= maximum[key], `Invalid ${key} budget`);
  }
  check(typeof options.arrivals === 'boolean', 'Invalid arrivals option');
}
function pose(edge: Edge, at: number): { position: XY; heading: number } {
  let remaining = at;
  for (let i = 1; i < edge.points.length; i++) {
    const a = edge.points[i - 1], b = edge.points[i], length = distance(a, b);
    if (remaining <= length || i === edge.points.length - 1) return {
      position: lerp(a, b, Math.max(0, Math.min(1, remaining / length))),
      heading: Math.atan2(b[0] - a[0], b[1] - a[1]),
    };
    remaining -= length;
  }
  throw new Error(`Mobility world: Missing path segments on ${edge.id}`);
}
const travelled = (): Record<ActorKind, number> => ({ 'car-a': 0, 'car-b': 0, bus: 0, 'person-a': 0, 'person-b': 0 });

export class MobilityWorld {
  private options: MobilityOptions;
  private chunks = new Map<string, LoadedChunk>();
  private owned = new Map<string, string>();
  private actors = new Map<number, Moving>();
  private occupancy = new Map<string, Map<number, Occupant>>();
  private exitStorage = new Map<string, Map<number, Occupant>>();
  private reservations = new ConflictReservations();
  private groups = new Map<number, ConflictGroup>();
  private entries: Entry[] = [];
  private ticks = 0;
  private identity = 0;
  private randomState: number;
  private arrival = { drive: 0, walk: 0 };
  private passed: Record<string, number> = {};
  private travelled = travelled();
  private advanced = false;
  private dirty = false;

  constructor(options: MobilityOptions) {
    validateOptions(options);
    this.options = { ...options }; this.randomState = options.seed;
  }

  addChunk(value: MobilityChunk): void {
    check(!this.chunks.has(value.id), `Duplicate chunk ${value.id}`);
    const chunk = structuredClone(value);
    parseMobilityChunk(chunk, { id: chunk.id, bounds: chunk.bounds, status: 'ready',
      neighbours: [...new Set(chunk.ports.flatMap(port => port.links.map(link => link.cell)))],
      driveMetres: 0, walkMetres: 0, diagnosticCodes: [] });
    for (const edge of chunk.ownedEdges) check(!this.owned.has(edge), `Duplicate edge ownership: ${edge}`);
    for (const other of this.chunks.values()) this.validateLinks(chunk, other.value);
    const loaded = { value: chunk, edges: new Map(chunk.network.edges.map(edge => [edge.id, edge])), owned: new Set(chunk.ownedEdges) };
    this.chunks.set(chunk.id, loaded);
    chunk.ownedEdges.forEach(id => this.owned.set(id, chunk.id));
    this.rebuildEntries(); this.dirty = true;
  }

  removeChunk(id: string): void {
    check(![...this.actors.values()].some(state => state.path.some(hop =>
      hop.cell.value.id === id && hop.start <= state.progress + state.actor.length / 2
      && hop.start + hop.edge.length >= state.progress - state.actor.length / 2)),
    `Cannot remove cell ${id} while it owns a live actor body`);
    const owners = this.reservations.owners();
    for (const state of this.actors.values()) {
      const group = this.groups.get(state.actor.id);
      if (!group?.zones.every(zone => owners[zone] === state.actor.id)) continue;
      check(!state.path.some(hop => hop.cell.value.id === id
        && hop.start <= group.exit + GAP + state.actor.length / 2
        && hop.start + hop.edge.length >= group.enter - state.actor.length / 2),
      `Cannot remove cell ${id} while its junction or exit storage is reserved`);
    }
    const chunk = this.chunks.get(id);
    if (!chunk) return;
    chunk.value.ownedEdges.forEach(edge => this.owned.delete(edge)); this.chunks.delete(id);
    for (const state of this.actors.values()) {
      const unavailable = state.path.findIndex((hop, index) => index > state.index && hop.cell.value.id === id);
      if (unavailable >= 0) state.path.splice(unavailable);
    }
    this.rebuildEntries(); this.dirty = true;
  }

  retainedCells(): ReadonlySet<string> {
    const retained = new Set<string>(), owners = this.reservations.owners();
    for (const state of this.actors.values()) for (const hop of state.path) {
      const body = hop.start <= state.progress + state.actor.length / 2
        && hop.start + hop.edge.length >= state.progress - state.actor.length / 2;
      const group = this.groups.get(state.actor.id);
      const reserved = group?.zones.every(zone => owners[zone] === state.actor.id)
        && hop.start <= group.exit + GAP + state.actor.length / 2
        && hop.start + hop.edge.length >= group.enter - state.actor.length / 2;
      if (body || reserved) retained.add(hop.cell.value.id);
    }
    return retained;
  }

  retireOutside(gate: SpawnGate): void {
    const owners = new Set(Object.values(this.reservations.owners()));
    for (const [id, state] of this.actors) {
      if (owners.has(id) || !gate.canRetire(state.actor.cell, state.actor.position, state.actor.kind)) continue;
      this.reservations.release(id); this.groups.delete(id);
      for (const edge of state.occupied) this.occupancy.get(edge)?.delete(id);
      this.actors.delete(id); this.dirty = true;
    }
    this.refreshExitStorage();
  }

  setOptions(options: MobilityOptions): void {
    validateOptions(options);
    if (options.seed !== this.options.seed) this.randomState = options.seed;
    this.options = { ...options }; this.dirty = true;
  }

  step(gate: SpawnGate): void {
    this.advanced = false; this.dirty = false;
    for (const state of this.actors.values()) { state.previousProgress = state.progress; this.extend(state); }
    this.occupancy.clear();
    for (const state of this.actors.values()) { state.occupied.clear(); this.occupy(state); }
    this.refreshExitStorage();
    if (this.options.arrivals) for (const mode of ['drive', 'walk'] as const) this.spawn(mode, gate);
    this.prepareReservations();
    this.reservations.grant(id => {
      this.refreshExitStorage();
      const state = this.actors.get(id)!, group = this.groups.get(id)!;
      return this.room(state) >= group.exit - state.progress + GAP;
    });
    this.refreshExitStorage();
    for (const state of this.actors.values()) this.move(state, gate);
    this.ticks++;
  }

  snapshot(): WorldSnapshot {
    return { time: this.time, actors: [...this.actors.values()].map(state => ({
      ...state.actor, position: [...state.actor.position],
    })), owners: this.reservations.owners(), passedByEntry: { ...this.passed }, travelledByKind: { ...this.travelled } };
  }

  interpolated(alpha: number): WorldSnapshot {
    check(Number.isFinite(alpha) && alpha >= 0 && alpha <= 1, 'Invalid interpolation fraction');
    const snapshot = this.snapshot();
    return { ...snapshot, actors: snapshot.actors.map(actor => {
      const state = this.actors.get(actor.id)!, progress = state.previousProgress + (state.progress - state.previousProgress) * alpha;
      let index = state.path.length - 1;
      while (index > 0 && state.path[index].start > progress) index--;
      const hop = state.path[index], along = progress - hop.start;
      const remaining = state.progress - progress;
      return { ...actor, cell: hop.cell.value.id, edge: hop.edge.id, distance: along, ...pose(hop.edge, along),
        walkPhase: walking(actor.kind) ? ((actor.walkPhase - remaining / 1.2) % 1 + 1) % 1 : actor.walkPhase };
    }) };
  }
  finishInterpolation(): void {
    for (const state of this.actors.values()) state.previousProgress = state.progress;
  }

  nextWakeTime(): number | undefined {
    if (this.actors.size && (this.dirty || this.advanced || [...this.actors.values()].some(state => state.actor.speed > 0))) {
      return this.time + MOBILITY_STEP;
    }
    const times: number[] = [];
    if (this.options.arrivals) for (const mode of ['drive', 'walk'] as const) {
      if (this.count(mode) < this.limit(mode) && this.entries.some(entry => entry.route.mode === mode)) {
        times.push(Math.max(this.time + MOBILITY_STEP, this.arrival[mode]));
      }
    }
    return times.length ? Math.min(...times) : undefined;
  }

  clear(): void {
    this.chunks.clear(); this.owned.clear(); this.actors.clear(); this.occupancy.clear(); this.entries = [];
    this.exitStorage.clear(); this.reservations.clear(); this.groups.clear();
    this.ticks = 0; this.identity = 0; this.randomState = this.options.seed; this.arrival = { drive: 0, walk: 0 };
    this.passed = {}; this.travelled = travelled(); this.advanced = false; this.dirty = false;
  }

  private get time(): number { return this.ticks * MOBILITY_STEP; }
  private limit(mode: Edge['mode']): number { return mode === 'drive' ? this.options.vehicles : this.options.pedestrians; }
  private count(mode: Edge['mode']): number {
    return [...this.actors.values()].filter(state => walking(state.actor.kind) === (mode === 'walk')).length;
  }
  private random(): number {
    let value = this.randomState += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    this.randomState >>>= 0;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }
  private validateLinks(a: MobilityChunk, b: MobilityChunk): void {
    for (const [from, to] of [[a, b], [b, a]]) for (const port of from.ports) for (const link of port.links) {
      if (link.cell !== to.id) continue;
      const target = to.ports.find(candidate => candidate.id === link.port);
      check(target && target.at !== port.at && target.links.some(back => back.cell === from.id && back.port === port.id),
        'Asymmetric or dangling seam');
      check(distance(project(target.coordinate, from.network.origin), project(port.coordinate, from.network.origin)) <= 0.05,
        'Mismatched seam coordinates');
    }
  }
  private rebuildEntries(): void {
    this.entries = [];
    for (const cell of [...this.chunks.values()].sort((a, b) => a.value.id.localeCompare(b.value.id))) {
      for (const route of [...cell.value.network.routes].sort((a, b) => a.id.localeCompare(b.id))) {
        const index = route.edges.findIndex(id => cell.owned.has(id));
        if (index < 0) continue;
        const edge = cell.edges.get(route.edges[index])!;
        if (edge.id.startsWith('turn/')) continue;
        for (const kind of [...route.allowed].sort()) {
          const body = ACTORS[kind], start = body.length / 2 + END_MARGIN;
          if (edge.length < body.length + END_MARGIN * 2
            || edge.conflicts.some(conflict => start >= conflict.enter && start <= conflict.exit)) continue;
          this.entries.push({ cell, route, index, kind });
        }
      }
    }
  }
  private spawn(mode: Edge['mode'], gate: SpawnGate): void {
    if (this.time + 1e-9 < this.arrival[mode] || this.count(mode) >= this.limit(mode)) return;
    const entries = this.entries.filter(entry => entry.route.mode === mode);
    this.arrival[mode] = this.time + 0.5 + this.random();
    if (!entries.length) return;
    const offset = Math.floor(this.random() * entries.length);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[(i + offset) % entries.length], edge = entry.cell.edges.get(entry.route.edges[entry.index])!;
      const body = ACTORS[entry.kind], progress = body.length / 2 + END_MARGIN, position = pose(edge, progress);
      if (!gate.canSpawn(entry.cell.value.id, position.position, entry.kind)) continue;
      const actor: MobileActor = { id: this.identity + 1, kind: entry.kind,
        route: `${entry.cell.value.id}/${entry.route.id}`, cell: entry.cell.value.id, edge: edge.id,
        distance: progress, speed: 0, length: body.length, width: body.width,
        ...position, walkPhase: 0 };
      const state: Moving = { actor, progress, previousProgress: progress, index: 0, entry: actor.route, occupied: new Set(),
        path: [{ cell: entry.cell, route: entry.route, index: entry.index, edge, start: 0 }] };
      this.extend(state);
      const overlaps = [...(this.occupancy.get(edge.id)?.values() ?? []), ...(this.exitStorage.get(edge.id)?.values() ?? [])].some(occupant =>
        occupant.back < progress + body.length / 2 + GAP
        && 2 * occupant.centre - occupant.back > progress - body.length / 2 - GAP);
      if (overlaps || this.room(state) < 0) continue;
      this.identity++; this.actors.set(actor.id, state); this.occupy(state);
      return;
    }
  }
  private next(hop: Hop, kind: ActorKind): Hop | undefined {
    const { cell, edge, route, index } = hop, expected = route.edges[index + 1];
    const candidates = expected ? [expected] : edge.next;
    for (const id of candidates) {
      const next = cell.edges.get(id)!;
      if (!next.allowed.includes(kind)) continue;
      if (cell.owned.has(id)) {
        const continuation = expected ? route : cell.value.network.routes.find(candidate =>
          candidate.allowed.includes(kind) && candidate.edges.includes(id));
        if (continuation) return { cell, edge: next, route: continuation,
          index: continuation.edges.indexOf(id), start: hop.start + edge.length };
      }
      for (const port of cell.value.ports.filter(port => port.edge === edge.id && port.at === 'exit')) {
        for (const link of port.links) {
          const target = this.chunks.get(link.cell), targetPort = target?.value.ports.find(candidate => candidate.id === link.port);
          if (!target || !targetPort || !targetPort.allowed.includes(kind)) continue;
          const targetEdge = target.edges.get(targetPort.edge)!;
          if (!target.owned.has(targetEdge.id) || next.from !== targetEdge.from || next.mode !== targetEdge.mode
            || next.sourceIds.length !== targetEdge.sourceIds.length
            || next.sourceIds.some(id => !targetEdge.sourceIds.includes(id))) continue;
          const targetRoute = target.value.network.routes.find(candidate => candidate.allowed.includes(kind) && candidate.edges.includes(targetEdge.id));
          if (targetRoute) return { cell: target, edge: targetEdge, route: targetRoute,
            index: targetRoute.edges.indexOf(targetEdge.id), start: hop.start + edge.length };
        }
      }
    }
    return undefined;
  }
  private extend(state: Moving, minimum = 0): void {
    const braking = walking(state.actor.kind) ? 2 : 4;
    const lookahead = Math.max(30, minimum, state.actor.speed ** 2 / (2 * braking) + state.actor.speed * 2 + state.actor.length);
    for (let i = 0; i < 512; i++) {
      const tail = state.path.at(-1)!;
      if (tail.start + tail.edge.length > state.progress + lookahead) break;
      const next = this.next(tail, state.actor.kind);
      if (!next) break;
      state.path.push(next);
    }
  }
  private conflictGroup(state: Moving): ConflictGroup | undefined {
    for (let attempt = 0; attempt < 512; attempt++) {
      const intervals = state.path.flatMap(hop => hop.edge.conflicts.map(conflict => ({
        zone: hop.cell.value.zoneIds[conflict.zone], enter: hop.start + conflict.enter, exit: hop.start + conflict.exit,
      }))).filter(interval => interval.exit + END_MARGIN >= state.progress)
        .sort((a, b) => a.enter - b.enter || a.zone.localeCompare(b.zone));
      const first = intervals[0];
      if (!first) return undefined;
      const group: ConflictGroup = { zones: [first.zone], enter: first.enter, exit: first.exit };
      for (const interval of intervals.slice(1)) {
        if (interval.enter > group.exit + END_MARGIN * 2) break;
        group.zones.push(interval.zone); group.exit = Math.max(group.exit, interval.exit);
      }
      group.zones = [...new Set(group.zones)].sort();
      const before = state.path.at(-1)!;
      this.extend(state, group.exit - state.progress + state.actor.length + GAP + 1);
      if (before === state.path.at(-1)) return group;
    }
    throw new Error('Mobility world: Conflict lookahead exceeded the bounded route budget');
  }
  private prepareReservations(): void {
    const owners = this.reservations.owners();
    for (const state of this.actors.values()) {
      const previous = this.groups.get(state.actor.id);
      if (previous?.zones.every(zone => owners[zone] === state.actor.id)) continue;
      const group = this.conflictGroup(state);
      if (!group) {
        this.reservations.release(state.actor.id); this.groups.delete(state.actor.id);
        continue;
      }
      this.groups.set(state.actor.id, group);
      const braking = walking(state.actor.kind) ? 2 : 4;
      const approach = state.actor.speed ** 2 / (2 * braking) + state.actor.speed * MOBILITY_STEP + 2;
      if (group.enter - state.progress <= approach) this.reservations.request(state.actor.id, group.zones, this.time);
    }
  }
  private refreshExitStorage(): void {
    this.exitStorage.clear();
    const owners = this.reservations.owners();
    for (const id of new Set(Object.values(owners))) {
      const state = this.actors.get(id)!, group = this.groups.get(id)!;
      for (const hop of state.path) {
        const centre = group.exit + GAP - hop.start, half = state.actor.length / 2;
        if (centre + half < 0 || centre - half > hop.edge.length) continue;
        const entries = this.exitStorage.get(hop.edge.id) ?? new Map<number, Occupant>();
        entries.set(id, { centre, back: centre - half }); this.exitStorage.set(hop.edge.id, entries);
      }
    }
  }
  private occupy(state: Moving): void {
    for (const key of state.occupied) this.occupancy.get(key)?.delete(state.actor.id);
    state.occupied.clear();
    for (const hop of state.path) {
      const centre = state.progress - hop.start, half = state.actor.length / 2;
      if (centre + half < 0 || centre - half > hop.edge.length) continue;
      const entries = this.occupancy.get(hop.edge.id) ?? new Map<number, Occupant>();
      entries.set(state.actor.id, { centre, back: centre - half }); this.occupancy.set(hop.edge.id, entries);
      state.occupied.add(hop.edge.id);
    }
  }
  private room(state: Moving): number {
    const tail = state.path.at(-1)!;
    let room = tail.start + tail.edge.length - state.progress - state.actor.length / 2 - END_MARGIN;
    for (let i = state.index; i < state.path.length; i++) {
      const hop = state.path[i];
      const occupants = [...(this.occupancy.get(hop.edge.id) ?? []), ...(this.exitStorage.get(hop.edge.id) ?? [])];
      for (const [id, occupant] of occupants) {
        if (id === state.actor.id || hop.start + occupant.centre <= state.progress) continue;
        room = Math.min(room, hop.start + occupant.back - state.progress - state.actor.length / 2 - GAP);
      }
    }
    return room;
  }
  private move(state: Moving, gate: SpawnGate): void {
    const actor = state.actor, braking = walking(actor.kind) ? 2 : 4, acceleration = walking(actor.kind) ? 1 : 2;
    let room = this.room(state);
    const group = this.groups.get(actor.id), owners = this.reservations.owners();
    if (group && !group.zones.every(zone => owners[zone] === actor.id)) {
      room = Math.min(room, group.enter - state.progress - END_MARGIN);
    }
    room = Math.max(0, room);
    let target = Math.sqrt(2 * braking * Math.max(0, room - actor.speed * MOBILITY_STEP));
    for (let i = state.index; i < state.path.length; i++) {
      const hop = state.path[i], ahead = Math.max(0, hop.start - state.progress - actor.length / 2);
      target = Math.min(target, Math.sqrt(hop.edge.speed ** 2 + 2 * braking * ahead));
    }
    let speed = Math.max(0, actor.speed + Math.max(-braking * MOBILITY_STEP,
      Math.min(acceleration * MOBILITY_STEP, target - actor.speed)));
    let moved = (actor.speed + speed) * MOBILITY_STEP / 2;
    if (moved >= room) { moved = room; speed = 0; }
    if (room < 1e-5 && speed < 1e-3) { moved = room; speed = 0; }
    state.progress += moved;
    while (state.index + 1 < state.path.length && state.progress >= state.path[state.index + 1].start) state.index++;
    const hop = state.path[state.index];
    actor.cell = hop.cell.value.id; actor.edge = hop.edge.id; actor.distance = state.progress - hop.start;
    Object.assign(actor, pose(hop.edge, actor.distance)); actor.speed = speed;
    if (walking(actor.kind)) actor.walkPhase = (actor.walkPhase + moved / 1.2) % 1;
    this.travelled[actor.kind] += moved; this.advanced ||= moved > 1e-8;
    this.occupy(state);
    if (group && state.progress > group.exit + END_MARGIN) {
      this.reservations.release(actor.id); this.groups.delete(actor.id);
    }
    const tail = state.path.at(-1)!;
    const exit = !tail.edge.next.length && !tail.cell.value.ports.some(port =>
      port.edge === tail.edge.id && port.at === 'exit' && port.links.length);
    const toExit = tail.start + tail.edge.length - state.progress - actor.length / 2 - END_MARGIN;
    if (exit && state.index === state.path.length - 1 && toExit < 1e-5 && speed === 0
      && gate.canRetire(actor.cell, actor.position, actor.kind)) {
      for (const key of state.occupied) this.occupancy.get(key)?.delete(actor.id);
      this.actors.delete(actor.id); this.passed[state.entry] = (this.passed[state.entry] ?? 0) + 1;
      this.reservations.release(actor.id); this.groups.delete(actor.id);
    }
    while (state.index > 0 && state.path[0].start + state.path[0].edge.length
      < Math.min(state.previousProgress, state.progress - actor.length / 2 - GAP)) {
      state.path.shift(); state.index--;
    }
  }
}
