import { createHash } from 'node:crypto';
import { parseMobilityChunk, type MobilityChunk, type MobilityPort } from '../../web/core/mobility';
import type { Edge, Polygon2, XY } from '../../web/core/enhancements';
import type { Bounds } from '../../web/core/types';
import { assignConflictZones } from '../enhancements/routes';
import { distance, hull, polygonBounds, polygonsIntersect, project, spatialCandidates, unproject } from '../enhancements/geometry';

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Mobility seam: ${message}`); }
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const angle = (a: XY, b: XY) => Math.atan2(b[0] - a[0], b[1] - a[1]);
function pointDistance(point: XY, points: XY[]): number {
  let closest = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    closest = Math.min(closest, distance(point, [a[0] + t * dx, a[1] + t * dy]));
  }
  return closest;
}
function equivalent(a: XY[], b: XY[]): boolean {
  if (a.length === b.length) return a.every((point, i) => distance(point, b[i]) <= 0.05);
  return distance(a[0], b[0]) <= 0.05 && distance(a.at(-1)!, b.at(-1)!) <= 0.05
    && a.every(point => pointDistance(point, b) <= 0.05) && b.every(point => pointDistance(point, a) <= 0.05);
}
function anchor(chunk: MobilityChunk, edge: Edge): XY {
  const junction = edge.id.startsWith('turn/') ? edge.sourceIds.find(id => /^node\/\d+$/.test(id)) : undefined;
  if (junction) {
    const node = Number(junction.slice(5));
    for (const surface of chunk.surfaces) {
      const match = /\/(\d+)-(\d+)$/.exec(surface.id);
      if (match && Number(match[1]) === node) return unproject(surface.points[0], chunk.network.origin);
      if (match && Number(match[2]) === node) return unproject(surface.points.at(-1)!, chunk.network.origin);
    }
  }
  const match = /^(drive|walk)\/(way\/\d+)\/(\d+)-(\d+)/.exec(edge.id);
  const segment = match ? `surface/${match[2]}/${Math.min(Number(match[3]), Number(match[4]))}-${Math.max(Number(match[3]), Number(match[4]))}` : undefined;
  const midpoint: XY = [(edge.points[0][0] + edge.points.at(-1)![0]) / 2, (edge.points[0][1] + edge.points.at(-1)![1]) / 2];
  const surface = chunk.surfaces.find(surface => surface.id === segment)
    ?? chunk.surfaces.filter(surface => surface.sourceIds.some(id => edge.sourceIds.includes(id)))
      .sort((a, b) => pointDistance(midpoint, a.points) - pointDistance(midpoint, b.points))[0];
  const points = surface?.points ?? edge.points;
  return unproject([(points[0][0] + points.at(-1)![0]) / 2, (points[0][1] + points.at(-1)![1]) / 2], chunk.network.origin);
}
function contains(chunk: MobilityChunk, coordinate: XY): boolean {
  const p = project(coordinate, chunk.network.origin), lo = project([chunk.bounds[0], chunk.bounds[1]], chunk.network.origin);
  const hi = project([chunk.bounds[2], chunk.bounds[3]], chunk.network.origin);
  return p[0] >= lo[0] - 0.05 && p[0] <= hi[0] + 0.05 && p[1] >= lo[1] - 0.05 && p[1] <= hi[1] + 0.05;
}

export function stitchChunks(input: MobilityChunk[]): MobilityChunk[] {
  if (!input.length) return [];
  const chunks = structuredClone(input).sort((a, b) => a.id.localeCompare(b.id)), byId = new Map(chunks.map(chunk => [chunk.id, chunk]));
  check(byId.size === chunks.length, 'duplicate cell');
  for (const chunk of chunks) parseMobilityChunk(chunk, { id: chunk.id, bounds: chunk.bounds, status: 'ready',
    neighbours: chunks.filter(other => other !== chunk).map(other => other.id),
    driveMetres: 0, walkMetres: 0, diagnosticCodes: [] });
  const origin = chunks[0].network.origin;
  const convert = (chunk: MobilityChunk, point: XY) => project(unproject(point, chunk.network.origin), origin);
  const boxes = new Map(chunks.map(chunk => {
    const lo = project([chunk.bounds[0], chunk.bounds[1]], origin), hi = project([chunk.bounds[2], chunk.bounds[3]], origin);
    return [chunk.id, [lo[0], lo[1], hi[0], hi[1]] as Bounds];
  }));
  const nearbyCells = spatialCandidates(chunks, chunk => boxes.get(chunk.id)!);
  for (const chunk of chunks) for (const other of nearbyCells(boxes.get(chunk.id)!)) {
    if (chunk.id >= other.id) continue;
    const a = boxes.get(chunk.id)!, b = boxes.get(other.id)!;
    check(Math.min(a[2], b[2]) - Math.max(a[0], b[0]) <= 0.05
      || Math.min(a[3], b[3]) - Math.max(a[1], b[1]) <= 0.05, 'overlapping cell interiors');
  }
  const references = new Map<string, { chunk: MobilityChunk; edge: Edge }>();
  for (const chunk of chunks) for (const edge of chunk.network.edges) {
    const previous = references.get(edge.id);
    if (previous) {
      check(edge.mode === previous.edge.mode && edge.from === previous.edge.from && edge.to === previous.edge.to
        && same(edge.sourceIds, previous.edge.sourceIds) && edge.allowed.some(kind => previous.edge.allowed.includes(kind))
        && Math.abs(edge.width - previous.edge.width) < 1e-8 && Math.abs(edge.speed - previous.edge.speed) < 1e-8
        && equivalent(edge.points.map(p => convert(chunk, p)), previous.edge.points.map(p => convert(previous.chunk, p))),
      `contradictory source edge ${edge.id}`);
    } else references.set(edge.id, { chunk, edge });
  }
  const surfaces = new Map<string, { chunk: MobilityChunk; surface: MobilityChunk['surfaces'][number] }>();
  for (const chunk of chunks) for (const surface of chunk.surfaces) {
    const previous = surfaces.get(surface.id);
    if (previous) {
      check(surface.mode === previous.surface.mode && same(surface.sourceIds, previous.surface.sourceIds)
        && Math.abs(surface.width - previous.surface.width) < 1e-8 && surface.height === previous.surface.height
        && equivalent(surface.points.map(p => convert(chunk, p)), previous.surface.points.map(p => convert(previous.chunk, p))),
      `contradictory source surface ${surface.id}`);
    } else surfaces.set(surface.id, { chunk, surface });
  }
  for (const chunk of chunks) for (const port of chunk.ports) for (const link of port.links) {
    const other = byId.get(link.cell), target = other?.ports.find(p => p.id === link.port);
    check(other && target && target.at !== port.at
      && target.links.some(back => back.cell === chunk.id && back.port === port.id), 'dangling/asymmetric port link');
    check(distance(project(port.coordinate, origin), project(target.coordinate, origin)) <= 0.05, 'mismatched linked seam');
    const fromChunk = port.at === 'exit' ? chunk : other, toChunk = port.at === 'exit' ? other : chunk;
    const from = fromChunk.network.edges.find(edge => edge.id === (port.at === 'exit' ? port.edge : target.edge))!;
    const to = toChunk.network.edges.find(edge => edge.id === (port.at === 'exit' ? target.edge : port.edge))!;
    check(from.mode === to.mode && from.allowed.some(kind => to.allowed.includes(kind))
      && from.next.some(id => {
        const next = fromChunk.network.edges.find(edge => edge.id === id)!;
        return next.from === to.from && same(next.sourceIds, to.sourceIds);
      }), 'unsourced or incompatible linked topology');
  }
  const owners = new Map<string, MobilityChunk>();
  for (const chunk of chunks) {
    const edges = new Map(chunk.network.edges.map(edge => [edge.id, edge]));
    for (const id of chunk.ownedEdges) {
      check(contains(chunk, anchor(chunk, edges.get(id)!)), `edge ${id} claimed outside its owning cell`);
      if (chunk.network.routes.some(route => route.edges.includes(id)) && !owners.has(id)) owners.set(id, chunk);
    }
  }
  for (const chunk of chunks) {
    chunk.ownedEdges = chunk.ownedEdges.filter(id => owners.get(id) === chunk).sort();
    const prior = new Map<string, MobilityPort>();
    for (const port of chunk.ports) {
      const key = `${port.at}/${port.edge}`;
      check(!prior.has(key), 'ambiguous edge endpoint ports'); prior.set(key, port);
    }
    chunk.ports = chunk.network.edges.filter(edge => chunk.ownedEdges.includes(edge.id)).flatMap(edge =>
      (['entry', 'exit'] as const).map(at => {
        const a = at === 'entry' ? edge.points[0] : edge.points.at(-2)!, b = at === 'entry' ? edge.points[1] : edge.points.at(-1)!;
        return { ...(prior.get(`${at}/${edge.id}`) ?? { id: `${at}/${edge.id}` }), edge: edge.id, at,
          coordinate: unproject(at === 'entry' ? a : b, chunk.network.origin),
          heading: angle(a, b), allowed: [...edge.allowed], links: [] };
      }));
  }
  const active = chunks.filter(chunk => chunk.ownedEdges.length);
  const entries = new Map<string, { chunk: MobilityChunk; port: MobilityPort; edge: Edge }[]>();
  for (const chunk of active) for (const port of chunk.ports.filter(port => port.at === 'entry')) {
    const edge = chunk.network.edges.find(edge => edge.id === port.edge)!, key = `${edge.mode}/${edge.from}`;
    const group = entries.get(key) ?? []; group.push({ chunk, port, edge }); entries.set(key, group);
  }
  for (const chunk of active) {
    const edges = new Map(chunk.network.edges.map(edge => [edge.id, edge]));
    for (const port of chunk.ports.filter(port => port.at === 'exit')) {
      const edge = edges.get(port.edge)!;
      for (const next of edge.next.map(id => edges.get(id)!)) for (const target of entries.get(`${next.mode}/${next.from}`) ?? []) {
        if (target.chunk === chunk) continue;
        check(same(next.sourceIds, target.edge.sourceIds), 'contradictory continuation source');
        check(distance(project(port.coordinate, origin), project(target.port.coordinate, origin)) <= 0.05, 'mismatched seam endpoints');
        check(port.allowed.some(kind => target.port.allowed.includes(kind)), 'incompatible seam permissions');
        const link = { cell: target.chunk.id, port: target.port.id };
        if (!port.links.some(existing => existing.cell === link.cell && existing.port === link.port)) {
          port.links.push(link); target.port.links.push({ cell: chunk.id, port: port.id });
        }
      }
    }
  }

  let groups = active.flatMap(chunk => chunk.network.zones.map(zone => ({
    polygon: zone.polygon.map(ring => ring.map(point => convert(chunk, point))), sources: new Set<string>(),
  })));
  let changed = true;
  while (changed) {
    changed = false;
    const nearby = spatialCandidates(groups, group => polygonBounds(group.polygon)), removed = new Set<typeof groups[number]>();
    for (const group of groups) {
      if (removed.has(group)) continue;
      for (const other of nearby(polygonBounds(group.polygon))) {
        if (other === group || removed.has(other) || !polygonsIntersect(group.polygon, other.polygon)) continue;
        group.polygon = hull([...group.polygon[0], ...other.polygon[0]]);
        removed.add(other); changed = true;
      }
    }
    groups = groups.filter(group => !removed.has(group));
  }
  const nearbyZones = spatialCandidates(groups, group => polygonBounds(group.polygon));
  const indices = new Map(groups.map((group, index) => [group, index]));
  for (const chunk of active) {
    const lo = project([chunk.network.bounds[0], chunk.network.bounds[1]], origin);
    const hi = project([chunk.network.bounds[2], chunk.network.bounds[3]], origin);
    const padded: Bounds = [lo[0] - 12, lo[1] - 12, hi[0] + 12, hi[1] + 12];
    assignConflictZones(chunk.network, nearbyZones(padded).map(group => ({
      id: `pending/${indices.get(group)}`, edges: [],
      polygon: group.polygon.map(ring => ring.map(point => project(unproject(point, origin), chunk.network.origin))),
    })));
    const edges = new Map(chunk.network.edges.map(edge => [edge.id, edge]));
    for (const zone of chunk.network.zones) {
      const group = groups[Number(zone.id.slice('pending/'.length))];
      for (const id of zone.edges) {
        group.sources.add(id); edges.get(id)!.sourceIds.forEach(source => group.sources.add(source));
      }
    }
  }
  const canonical = groups.map(group => {
    check(group.sources.size, 'conflict geometry has no participating body');
    const box = polygonBounds(group.polygon);
    const location = [...unproject([box[0], box[1]], origin), ...unproject([box[2], box[3]], origin)]
      .map(n => n.toFixed(7));
    return `junction/${createHash('sha256').update(JSON.stringify({ sources: [...group.sources].sort(), location })).digest('hex').slice(0, 32)}`;
  });
  for (const chunk of active) {
    const names = new Map(chunk.network.zones.map(zone => [zone.id, canonical[Number(zone.id.slice('pending/'.length))]]));
    for (const edge of chunk.network.edges) for (const conflict of edge.conflicts) conflict.zone = names.get(conflict.zone)!;
    chunk.network.zones.forEach(zone => { zone.id = names.get(zone.id)!; });
    chunk.zoneIds = Object.fromEntries(chunk.network.zones.map(zone => [zone.id, zone.id]));
    chunk.ports.forEach(port => port.links.sort((a, b) => a.cell.localeCompare(b.cell) || a.port.localeCompare(b.port)));
    parseMobilityChunk(chunk, { id: chunk.id, bounds: chunk.bounds, status: 'ready',
      neighbours: active.filter(other => other !== chunk).map(other => other.id),
      driveMetres: 0, walkMetres: 0, diagnosticCodes: [] });
  }
  return active;
}
