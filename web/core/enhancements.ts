import type { Bounds } from './types';

export type XY = [number, number];
export type Polygon2 = XY[][];
export type ActorKind = 'car-a' | 'car-b' | 'bus' | 'person-a' | 'person-b';
export interface Diagnostic { sourceIds: string[]; code: string; message: string }
export interface Edge {
  id: string;
  sourceIds: string[];
  from: string;
  to: string;
  mode: 'drive' | 'walk';
  points: XY[];
  length: number;
  width: number;
  speed: number;
  allowed: ActorKind[];
  next: string[];
  corridor: Polygon2[];
  conflicts: { zone: string; enter: number; exit: number }[];
  inferred: string[];
}
export interface Route {
  id: string;
  mode: Edge['mode'];
  edges: string[];
  allowed: ActorKind[];
  entry: string;
  exit: string;
}
export interface Network {
  origin: XY;
  bounds: Bounds;
  edges: Edge[];
  routes: Route[];
  zones: { id: string; polygon: Polygon2; edges: string[] }[];
  buildings: Polygon2[];
  water: Polygon2[];
}
export interface Asset {
  kind: ActorKind | 'tree' | 'lamp' | 'entrance' | 'roof-unit';
  uri: string;
  sha256: string;
  bytes: number;
  size: [number, number, number];
  animation: string | null;
}
export interface Placement {
  asset: 'tree' | 'lamp' | 'entrance' | 'roof-unit';
  sourceIds: string[];
  position: XY;
  heading: number;
  height?: number;
  footprint: Polygon2;
  inferred: string[];
}
export interface EnhancementManifest {
  version: 1;
  id: string;
  baseDataset: string;
  generatedAt: string;
  bounds: Bounds;
  network: string;
  roads: string;
  provenance: string;
  placements: string;
  assets: Asset[];
  showcase: { target: XY; heading: number; pitch: number; range: number };
}
export interface Actor {
  id: number;
  kind: ActorKind;
  route: string;
  edge: string;
  distance: number;
  speed: number;
  length: number;
  width: number;
  position: XY;
  heading: number;
  walkPhase: number;
}
export interface MobilitySnapshot {
  time: number;
  actors: readonly Actor[];
  owners: Readonly<Record<string, number>>;
  passedByEntry: Readonly<Record<string, number>>;
  travelledByKind: Readonly<Record<ActorKind, number>>;
}
export interface MobilityOptions { seed: number; vehicles: number; pedestrians: number; arrivals: boolean }

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid enhancement: ${message}`);
}
function object(value: unknown): void {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
}
function text(value: unknown): void {
  check(typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f]/.test(value), 'expected nonempty string');
}
function identifier(value: string): void {
  text(value); check(!/\s/.test(value), 'whitespace in ID');
}
function finite(value: unknown): asserts value is number {
  check(typeof value === 'number' && Number.isFinite(value), 'expected finite number');
}
function positive(value: unknown): void { finite(value); check(value > 0, 'expected positive dimension/speed'); }
function array(value: unknown, nonempty = false): asserts value is unknown[] {
  check(Array.isArray(value) && (!nonempty || value.length > 0), 'expected array');
}
function strings(value: unknown, nonempty = false): void {
  array(value, nonempty); value.forEach(text);
  check(new Set(value).size === value.length, 'duplicate string/ID');
}
function tuple(value: unknown, size: number): void {
  array(value); check(value.length === size, 'coordinate/dimension arity'); value.forEach(finite);
}
function geographic(value: XY): void {
  tuple(value, 2);
  check(Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90, 'longitude/latitude out of range');
}
function bounds(value: Bounds): void {
  tuple(value, 4);
  geographic([value[0], value[1]]); geographic([value[2], value[3]]);
  check(value[0] < value[2] && value[1] < value[3], 'unordered bounds');
}
function path(value: string): void {
  text(value);
  check(value.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'),
    'expected same-origin relative package path');
}
function unique<T extends { id: string }>(items: T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    object(item); identifier(item.id); check(!result.has(item.id), `duplicate ID ${item.id}`); result.set(item.id, item);
  }
  return result;
}
const actors: ActorKind[] = ['car-a', 'car-b', 'bus', 'person-a', 'person-b'];
function allowed(value: ActorKind[], mode: Edge['mode']): void {
  check(mode === 'drive' || mode === 'walk', 'unknown mode');
  strings(value, true);
  check(value.every(kind => actors.includes(kind) && kind.startsWith('person-') === (mode === 'walk')), 'actor/mode mismatch');
}
const same = (a: XY, b: XY) => a[0] === b[0] && a[1] === b[1];
const cross = (a: XY, b: XY, c: XY) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function onSegment(a: XY, b: XY, p: XY): boolean {
  return Math.abs(cross(a, b, p)) <= 1e-9 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
    && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}
function intersects(a: XY, b: XY, c: XY, d: XY): boolean {
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)
    || (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0);
}
function inside(point: XY, ring: XY[]): boolean {
  let result = false;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
function polygon(value: Polygon2): void {
  array(value, true);
  for (const ring of value) {
    array(ring); check(ring.length >= 4, 'short polygon ring'); ring.forEach(p => tuple(p, 2));
    check(same(ring[0], ring[ring.length - 1]), 'unclosed polygon');
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      check(!same(ring[i], ring[i + 1]), 'zero polygon segment');
      area += cross(ring[0], ring[i], ring[i + 1]);
      for (let j = i + 1; j < ring.length - 1; j++) {
        if (j === i + 1 || (i === 0 && j === ring.length - 2)) continue;
        check(!intersects(ring[i], ring[i + 1], ring[j], ring[j + 1]), 'self-intersecting polygon');
      }
      const next = ring[(i + 2) % (ring.length - 1)];
      check(!onSegment(ring[i], ring[i + 1], next) && !onSegment(ring[i + 1], next, ring[i]), 'overlapping adjacent polygon segments');
    }
    check(Number.isFinite(area) && Math.abs(area) > 1e-9, 'zero/nonfinite polygon area');
  }
  for (let i = 1; i < value.length; i++) {
    check(inside(value[i][0], value[0]), 'hole outside outer ring');
    for (let j = 0; j < i; j++) {
      for (let a = 0; a < value[i].length - 1; a++) {
        for (let b = 0; b < value[j].length - 1; b++) {
          check(!intersects(value[i][a], value[i][a + 1], value[j][b], value[j][b + 1]), 'intersecting polygon rings');
        }
      }
      if (j > 0) check(!inside(value[i][0], value[j]) && !inside(value[j][0], value[i]), 'overlapping/nested holes');
    }
  }
}

export { polygon as validatePolygon };

export function parsePlacements(value: unknown, assets: Asset[]): Placement[] {
  array(value, true);
  for (const item of value) {
    object(item);
    const p = item as Placement;
    check(['tree', 'lamp', 'entrance', 'roof-unit'].includes(p.asset), 'unknown static placement asset');
    const asset = assets.find(a => a.kind === p.asset);
    check(asset, 'missing placement asset');
    strings(p.sourceIds, true);
    check(p.sourceIds.every(id => /^(node|way|relation)\/[1-9]\d*$/.test(id)), 'invalid placement source');
    tuple(p.position, 2); finite(p.heading);
    if (p.height !== undefined) { finite(p.height); check(p.height >= 0, 'invalid placement elevation'); }
    strings(p.inferred, true); polygon(p.footprint);
    const s = Math.sin(p.heading), c = Math.cos(p.heading);
    const corners: XY[] = [];
    for (const [along, across] of [[-1,-1],[-1,1],[1,1],[1,-1]]) {
      corners.push([p.position[0] + s*along*asset.size[0]/2 + c*across*asset.size[1]/2,
        p.position[1] + c*along*asset.size[0]/2 - s*across*asset.size[1]/2]);
    }
    for (let i=0;i<4;i++) {
      const a=corners[i], b=corners[(i+1)%4];
      check(inside(a,p.footprint[0]) && !p.footprint.slice(1).some(r=>inside(a,r)), 'placement body outside footprint');
      for (const ring of p.footprint) for(let j=0;j<ring.length-1;j++)
        check(!intersects(a,b,ring[j],ring[j+1]), 'placement body crosses footprint boundary');
    }
    check(!p.footprint.slice(1).some(r=>inside(r[0],[...corners,corners[0]])), 'placement body encloses footprint hole');
  }
  return value as Placement[];
}

export function parseEnhancementManifest(value: unknown, baseDataset: string): EnhancementManifest {
  object(value);
  const m = value as EnhancementManifest;
  check(m.version === 1, 'unsupported manifest version'); identifier(m.id); identifier(m.baseDataset);
  check(m.baseDataset === baseDataset, 'base dataset mismatch');
  text(m.generatedAt);
  check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(m.generatedAt)
    && Number.isFinite(Date.parse(m.generatedAt))
    && new Date(m.generatedAt).toISOString().replace('.000Z', 'Z') === m.generatedAt.replace('.000Z', 'Z'), 'invalid timestamp');
  bounds(m.bounds);
  [m.network, m.roads, m.provenance, m.placements].forEach(path);
  array(m.assets);
  const kinds = new Set<string>();
  for (const asset of m.assets) {
    object(asset);
    check([...actors, 'tree', 'lamp', 'entrance', 'roof-unit'].includes(asset.kind), 'unknown asset kind');
    check(!kinds.has(asset.kind), 'duplicate asset kind'); kinds.add(asset.kind);
    path(asset.uri);
    check(typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/.test(asset.sha256), 'invalid SHA-256');
    positive(asset.bytes); check(Number.isSafeInteger(asset.bytes), 'invalid byte count');
    tuple(asset.size, 3); asset.size.forEach(positive);
    check(asset.animation === null || (asset.kind.startsWith('person-') && asset.animation === 'Walk'),
      'unsupported animation declaration');
  }
  object(m.showcase); geographic(m.showcase.target);
  finite(m.showcase.heading); finite(m.showcase.pitch); positive(m.showcase.range);
  return m;
}

export function parseNetwork(value: unknown): Network {
  object(value);
  const n = value as Network;
  geographic(n.origin); bounds(n.bounds);
  array(n.edges, true); array(n.routes, true); array(n.zones); array(n.buildings); array(n.water);
  const edges = unique(n.edges), zones = unique(n.zones);
  unique(n.routes);
  n.buildings.forEach(polygon); n.water.forEach(polygon);
  const endpoints = new Map<string, XY>();
  for (const e of n.edges) {
    strings(e.sourceIds, true); e.sourceIds.forEach(identifier);
    identifier(e.from); identifier(e.to); allowed(e.allowed, e.mode);
    positive(e.length); positive(e.width); positive(e.speed);
    array(e.points); check(e.points.length >= 2, 'short edge'); e.points.forEach(p => tuple(p, 2));
    let length = 0;
    for (let i = 1; i < e.points.length; i++) {
      const distance = Math.hypot(e.points[i][0] - e.points[i - 1][0], e.points[i][1] - e.points[i - 1][1]);
      positive(distance); length += distance;
    }
    check(Math.abs(length - e.length) <= Math.max(0.01, length * 1e-6), 'edge length mismatch');
    for (const [id, point] of [[e.from, e.points[0]], [e.to, e.points[e.points.length - 1]]] as [string, XY][]) {
      check(!endpoints.has(id) || same(endpoints.get(id)!, point), 'inconsistent endpoint coordinates');
      endpoints.set(id, point);
    }
    strings(e.next); strings(e.inferred);
    array(e.corridor, true); e.corridor.forEach(polygon);
    array(e.conflicts);
    strings(e.conflicts.map(c => { object(c); return c.zone; }));
    for (const c of e.conflicts) {
      finite(c.enter); finite(c.exit);
      check(c.enter >= 0 && c.enter < c.exit && c.exit <= e.length, 'invalid conflict interval');
      const zone = zones.get(c.zone);
      check(zone && Array.isArray(zone.edges) && zone.edges.includes(e.id), 'dangling/inconsistent conflict zone');
    }
  }
  for (const e of n.edges) {
    for (const id of e.next) {
      const next = edges.get(id);
      check(next && next.mode === e.mode && next.from === e.to, 'dangling/disconnected/mixed-mode successor');
    }
  }
  for (const zone of n.zones) {
    polygon(zone.polygon); strings(zone.edges, true);
    for (const id of zone.edges) {
      check(edges.get(id)?.conflicts.some(c => c.zone === zone.id), 'dangling/inconsistent zone edge');
    }
  }
  for (const route of n.routes) {
    strings(route.edges, true); allowed(route.allowed, route.mode); text(route.entry); text(route.exit);
    check(route.entry === route.edges[0] && route.exit === route.edges[route.edges.length - 1], 'route entry/exit mismatch');
    route.edges.forEach((id, i) => {
      const edge = edges.get(id);
      check(edge && edge.mode === route.mode && route.allowed.every(kind => edge.allowed.includes(kind)), 'invalid route edge/mode/actors');
      if (i > 0) check(edges.get(route.edges[i - 1])!.next.includes(id), 'disconnected route');
    });
  }
  return n;
}
