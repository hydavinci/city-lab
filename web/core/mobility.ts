import type { Bounds, SceneSettings } from './types';
import {
  parseNetwork, type Actor, type ActorKind, type MobilitySnapshot, type Network, type XY,
} from './enhancements';
import { project } from '../../pipeline/enhancements/geometry';

export interface MobilityResource { uri: string; bytes: number; sha256: string }
export type CellStatus = 'ready' | 'empty' | 'excluded';
export interface MobilityCell {
  id: string; bounds: Bounds; status: CellStatus;
  neighbours: string[]; resource?: MobilityResource;
  driveMetres: number; walkMetres: number; diagnosticCodes: string[];
}
export interface MobilityCoverage {
  cells: number; ready: number; empty: number; excluded: number; failed: number;
  driveMetres: number; walkMetres: number;
}
export interface MobilityManifest {
  version: 1; id: string; baseDataset: string; generatedAt: string; bounds: Bounds;
  assets: MobilityResource; cells: MobilityCell[]; coverage: MobilityCoverage; report?: MobilityResource;
}
export interface MobilitySurface {
  id: string; sourceIds: string[]; mode: 'drive' | 'walk';
  points: XY[]; width: number; height: number; inferred: string[];
}
export interface MobilityPort {
  id: string; edge: string; at: 'entry' | 'exit';
  coordinate: XY; heading: number; allowed: ActorKind[];
  links: { cell: string; port: string }[];
}
export interface MobilityChunk {
  version: 1; id: string; bounds: Bounds; network: Network;
  ownedEdges: string[]; ports: MobilityPort[];
  zoneIds: Record<string, string>; surfaces: MobilitySurface[];
}
export interface MobileActor extends Actor { cell: string }
export interface WorldSnapshot extends MobilitySnapshot { actors: readonly MobileActor[] }
export interface SpawnGate {
  canSpawn(cell: string, position: XY, kind: ActorKind): boolean;
  canRetire(cell: string, position: XY, kind: ActorKind): boolean;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid mobility: ${message}`);
}
function object(value: unknown): void {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
}
function text(value: unknown): asserts value is string {
  check(typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f]/.test(value), 'invalid string');
}
function identifier(value: unknown): void {
  text(value); check(!/\s/.test(value), 'invalid identifier');
}
function list(value: unknown, nonempty = false): asserts value is unknown[] {
  check(Array.isArray(value) && (!nonempty || value.length > 0), 'expected array');
}
function strings(value: unknown, nonempty = false): asserts value is string[] {
  list(value, nonempty);
  value.forEach(text);
  check(new Set(value).size === value.length, 'duplicate identifier');
}
function tuple(value: unknown, size: number): void {
  list(value);
  check(value.length === size && value.every(n => typeof n === 'number' && Number.isFinite(n)), 'invalid coordinate');
}
function geographic(value: XY): void {
  tuple(value, 2);
  check(Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90, 'coordinate out of range');
}
function bounds(value: Bounds): void {
  tuple(value, 4);
  geographic([value[0], value[1]]); geographic([value[2], value[3]]);
  check(value[0] < value[2] && value[1] < value[3], 'unordered bounds');
}
function contains(outer: Bounds, inner: Bounds): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}
function nonnegative(value: unknown): asserts value is number {
  check(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'invalid nonnegative quantity');
}
function resource(value: MobilityResource, prefix: string): void {
  object(value);
  check(typeof value.uri === 'string' && value.uri.startsWith(prefix)
    && value.uri.endsWith('.json') && value.uri.split('/').every(part =>
      /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'), 'unsafe resource path');
  check(Number.isSafeInteger(value.bytes) && value.bytes > 0, 'invalid resource bytes');
  check(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), 'invalid resource hash');
}
function unique<T extends { id: string }>(items: T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    object(item); identifier(item.id);
    check(!result.has(item.id), `duplicate ID ${item.id}`);
    result.set(item.id, item);
  }
  return result;
}

export function mobilityBudget(quality: SceneSettings['quality']): { vehicles: number; pedestrians: number } {
  switch (quality) {
    case 'low': return { vehicles: 24, pedestrians: 36 };
    case 'medium': return { vehicles: 60, pedestrians: 90 };
    case 'high': return { vehicles: 120, pedestrians: 180 };
    default: throw new Error(`Invalid mobility quality: ${String(quality)}`);
  }
}

export function parseMobilityManifest(value: unknown, baseDataset: string): MobilityManifest {
  object(value);
  const m = value as MobilityManifest;
  check(m.version === 1, 'unsupported manifest version');
  check(typeof m.id === 'string' && /^[a-f0-9]{16,64}$/.test(m.id), 'invalid content ID');
  check(typeof m.baseDataset === 'string' && m.baseDataset === baseDataset, 'base dataset mismatch');
  check(typeof m.generatedAt === 'string' && Number.isFinite(Date.parse(m.generatedAt)), 'invalid generated time');
  bounds(m.bounds); resource(m.assets, 'enhancements/');
  if (m.report !== undefined) resource(m.report, `mobility/${m.id}/`);
  list(m.cells, true);
  const cells = unique(m.cells);
  let ready = 0, empty = 0, excluded = 0, driveMetres = 0, walkMetres = 0;
  for (const cell of m.cells) {
    bounds(cell.bounds);
    check(contains(m.bounds, cell.bounds), 'cell outside manifest bounds');
    strings(cell.neighbours); strings(cell.diagnosticCodes);
    nonnegative(cell.driveMetres); nonnegative(cell.walkMetres);
    check(['ready', 'empty', 'excluded'].includes(cell.status), 'invalid cell status');
    for (const id of cell.neighbours) {
      const neighbour = cells.get(id);
      check(neighbour && neighbour !== cell && Array.isArray(neighbour.neighbours)
        && neighbour.neighbours.includes(cell.id), 'missing, self or asymmetric neighbour');
    }
    if (cell.status === 'ready') {
      check(cell.resource !== undefined, 'ready cell has no resource');
      resource(cell.resource, `mobility/${m.id}/`);
      check(cell.driveMetres + cell.walkMetres > 0, 'ready cell has no usable length');
      ready++;
    } else {
      check(cell.resource === undefined && cell.driveMetres === 0 && cell.walkMetres === 0,
        'inactive cell cannot hide resources or usable geometry');
      if (cell.status === 'empty') empty++;
      else {
        check(cell.diagnosticCodes.length > 0, 'excluded cell has no diagnostic');
        excluded++;
      }
    }
    driveMetres += cell.driveMetres; walkMetres += cell.walkMetres;
  }
  object(m.coverage);
  const coverage = m.coverage;
  for (const key of ['cells', 'ready', 'empty', 'excluded', 'failed'] as const) {
    check(Number.isSafeInteger(coverage[key]) && coverage[key] >= 0, 'invalid coverage count');
  }
  check(coverage.cells === cells.size && coverage.ready === ready && coverage.empty === empty
    && coverage.excluded === excluded && coverage.failed === 0, 'coverage inventory mismatch');
  check(Number.isFinite(coverage.driveMetres) && Number.isFinite(coverage.walkMetres)
    && Math.abs(coverage.driveMetres - driveMetres) <= 1e-6
    && Math.abs(coverage.walkMetres - walkMetres) <= 1e-6, 'coverage length mismatch');
  return m;
}

export function parseMobilityChunk(value: unknown, cell: MobilityCell): MobilityChunk {
  object(value);
  const chunk = value as MobilityChunk;
  check(chunk.version === 1 && chunk.id === cell.id && cell.status === 'ready', 'chunk identity/status mismatch');
  bounds(chunk.bounds);
  check(chunk.bounds.every((n, i) => n === cell.bounds[i]), 'chunk bounds mismatch');
  const network = parseNetwork(chunk.network), edges = new Map(network.edges.map(edge => [edge.id, edge]));
  check(contains(network.bounds, chunk.bounds), 'network does not cover owned cell');
  strings(chunk.ownedEdges, true);
  check(chunk.ownedEdges.every(id => edges.has(id)), 'missing owned edge');
  check(network.routes.some(route => route.edges.some(id => chunk.ownedEdges.includes(id))), 'no owned route');
  object(chunk.zoneIds);
  const zones = new Set(network.zones.map(zone => zone.id));
  check(Object.keys(chunk.zoneIds).length === zones.size, 'zone alias count mismatch');
  for (const [id, alias] of Object.entries(chunk.zoneIds)) {
    check(zones.has(id), 'dangling zone alias'); identifier(alias);
  }
  list(chunk.ports);
  unique(chunk.ports);
  for (const port of chunk.ports) {
    identifier(port.edge); geographic(port.coordinate);
    check(Number.isFinite(port.heading) && (port.at === 'entry' || port.at === 'exit'), 'invalid port heading/endpoint');
    const edge = edges.get(port.edge);
    check(edge, 'missing port edge');
    strings(port.allowed, true);
    check(port.allowed.every(kind => edge.allowed.includes(kind)), 'port actor mismatch');
    const position = project(port.coordinate, network.origin);
    const endpoint = port.at === 'entry' ? edge.points[0] : edge.points.at(-1)!;
    check(Math.hypot(position[0] - endpoint[0], position[1] - endpoint[1]) <= 0.05, 'port endpoint mismatch');
    list(port.links);
    const links = new Set<string>();
    for (const link of port.links) {
      object(link); identifier(link.cell); identifier(link.port);
      check(cell.neighbours.includes(link.cell), 'port links to a non-neighbour');
      const id = JSON.stringify([link.cell, link.port]);
      check(!links.has(id), 'duplicate port link'); links.add(id);
    }
  }
  list(chunk.surfaces, true);
  unique(chunk.surfaces);
  for (const surface of chunk.surfaces) {
    strings(surface.sourceIds, true);
    check(surface.sourceIds.every(id => /^(node|way|relation)\/[1-9]\d*$/.test(id)), 'surface source missing');
    strings(surface.inferred, true);
    check(surface.mode === 'drive' || surface.mode === 'walk', 'invalid surface mode');
    check(Number.isFinite(surface.width) && surface.width > 0 && surface.width <= 80, 'invalid surface width');
    nonnegative(surface.height);
    list(surface.points);
    check(surface.points.length >= 2, 'short surface');
    surface.points.forEach(point => tuple(point, 2));
    for (let i = 1; i < surface.points.length; i++) {
      const a = surface.points[i - 1], b = surface.points[i];
      check(Math.hypot(a[0] - b[0], a[1] - b[1]) > 0, 'zero surface segment');
    }
  }
  return chunk;
}
