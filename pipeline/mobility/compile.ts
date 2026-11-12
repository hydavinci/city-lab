import { parseNetwork, validatePolygon, type Diagnostic, type Polygon2, type XY } from '../../web/core/enhancements';
import type { Bounds } from '../../web/core/types';
import type { CellStatus, MobilityChunk, MobilitySurface } from '../../web/core/mobility';
import { compileNetwork, NoSafeRoutesError, type Selection } from '../enhancements/routes';
import { project, unproject } from '../enhancements/geometry';
import { validateSource } from '../enhancements/fetch';
import { validateOverpass } from '../normalize';

type Way = Selection['driveWays'][number];
const drive = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service',
  'living_street', 'primary_link', 'secondary_link', 'tertiary_link']);
const walk = new Set(['footway', 'path', 'pedestrian']);
export function mobilityMode(highway: string): 'drive' | 'walk' | undefined {
  return drive.has(highway) ? 'drive' : walk.has(highway) ? 'walk' : undefined;
}
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const contains = (bounds: Bounds, point: XY) =>
  point[0] >= bounds[0] && point[0] <= bounds[2] && point[1] >= bounds[1] && point[1] <= bounds[3];

function selectCrossings(
  ways: Way[], roads: Way[], crossingNodes: Set<number>, diagnostics: Diagnostic[],
): { crossings: Selection['crossings']; excluded: Set<string> } {
  const candidates = ways.filter(w => w.tags.footway === 'crossing'), remaining = new Set(candidates.map(w => w.id));
  const ends = new Map<number, Way[]>(), crossings: Selection['crossings'] = [], excluded = new Set<string>();
  for (const way of candidates) for (const node of [way.nodeIds[0], way.nodeIds.at(-1)!]) {
    const entries = ends.get(node) ?? []; entries.push(way); ends.set(node, entries);
  }
  const sides = new Map<number, Way[]>();
  for (const way of ways.filter(w => w.tags.footway !== 'crossing')) for (const node of way.nodeIds) {
    const entries = sides.get(node) ?? []; entries.push(way); sides.set(node, entries);
  }
  const roadNodes = new Map<number, Way[]>();
  for (const road of roads) for (const node of road.nodeIds) {
    const entries = roadNodes.get(node) ?? []; entries.push(road); roadNodes.set(node, entries);
  }
  for (const seed of candidates) {
    if (!remaining.has(seed.id)) continue;
    const component: Way[] = [], queue = [seed], seen = new Set<string>();
    while (queue.length) {
      const way = queue.shift()!;
      if (seen.has(way.id)) continue;
      seen.add(way.id); remaining.delete(way.id); component.push(way);
      for (const node of [way.nodeIds[0], way.nodeIds.at(-1)!]) queue.push(...(ends.get(node) ?? []).filter(w => !seen.has(w.id)));
    }
    const degrees = new Map<number, number>();
    for (const way of component) for (const node of [way.nodeIds[0], way.nodeIds.at(-1)!]) {
      degrees.set(node, (degrees.get(node) ?? 0) + 1);
    }
    const terminals = [...degrees].filter(([, degree]) => degree === 1).map(([node]) => node).sort((a, b) => a - b);
    const crossedRoads = [...new Set(component.flatMap(w => w.nodeIds))].filter(node => crossingNodes.has(node))
      .sort((a, b) => a - b).flatMap(node => (roadNodes.get(node) ?? []).map(road => ({ way: road.id, node: `node/${node}` })));
    const from = sides.get(terminals[0])?.[0], to = sides.get(terminals[1])?.[0];
    if (terminals.length !== 2 || [...degrees.values()].some(degree => degree > 2) || !from || !to || !crossedRoads.length) {
      component.forEach(w => excluded.add(w.id));
      diagnostics.push({ sourceIds: component.map(w => w.id).sort(), code: 'EXCLUDED_CROSSING',
        message: 'Crossing needs an unbranched source chain, two connected independent side routes and a shared tagged road node' });
      continue;
    }
    let at = terminals[0];
    const ordered: string[] = [], unused = new Set(component);
    while (unused.size) {
      const way = component.find(w => unused.has(w) && (w.nodeIds[0] === at || w.nodeIds.at(-1) === at));
      check(way, 'Disconnected source crossing component');
      ordered.push(way.id); unused.delete(way);
      at = way.nodeIds[0] === at ? way.nodeIds.at(-1)! : way.nodeIds[0];
    }
    crossings.push({ ways: ordered, from: { node: `node/${terminals[0]}`, sideRoute: from.id },
      to: { node: `node/${terminals[1]}`, sideRoute: to.id }, crossedRoads });
  }
  return { crossings, excluded };
}

export function compileCell(input: {
  id: string; bounds: Bounds; source: unknown; baseDataset: string;
  buildings: Polygon2[]; water: Polygon2[]; placements: Polygon2[];
}): { chunk?: MobilityChunk; status: CellStatus; diagnostics: Diagnostic[] } {
  check(typeof input.id === 'string' && input.id.length && !/\s/.test(input.id), 'Invalid cell ID');
  check(typeof input.baseDataset === 'string' && /^[a-f0-9]{16,64}$/.test(input.baseDataset), 'Invalid base dataset');
  const bounds = input.bounds;
  check(Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)
    && bounds[0] >= -180 && bounds[2] <= 180 && bounds[1] > -90 && bounds[3] < 90
    && bounds[0] < bounds[2] && bounds[1] < bounds[3]
    && bounds[2] - bounds[0] <= 0.05 && bounds[3] - bounds[1] <= 0.05, 'Invalid bounded cell');
  for (const obstacles of [input.buildings, input.water, input.placements]) {
    check(Array.isArray(obstacles), 'Invalid cell obstacles');
    obstacles.forEach(validatePolygon);
  }
  validateSource(input.source, { allowEmpty: true });
  const source = validateOverpass(input.source);
  source.elements = [...source.elements].sort((a, b) => `${a.type}/${a.id}`.localeCompare(`${b.type}/${b.id}`));
  const diagnostics: Diagnostic[] = [], excludedWays: Record<string, string[]> = {};
  const nodes = new Map(source.elements.filter(e => e.type === 'node').map(e =>
    [Number(e.id), { coordinate: [e.lon, e.lat] as XY, crossing: (e.tags as Record<string, string> | undefined)?.highway === 'crossing' }]));
  const ways: Way[] = source.elements.filter(e => e.type === 'way').map(e => ({
    id: `way/${e.id}`, nodeIds: [...e.nodes as number[]], tags: { ...e.tags as Record<string, string> | undefined },
  }));
  if (!ways.length) return { status: 'empty', diagnostics: [
    { sourceIds: [], code: 'NO_SOURCE_WAYS', message: 'Complete response contains no source ways' },
  ] };
  const driveWays: Way[] = [], walkWays: Way[] = [];
  for (const way of ways) {
    const segments = way.nodeIds.slice(1).map((node, i) => [node, way.nodeIds[i]].sort((a, b) => a - b).join('-'));
    if (new Set(segments).size !== segments.length) {
      (excludedWays['repeated-segment'] ??= []).push(way.id);
      diagnostics.push({ sourceIds: [way.id], code: 'EXCLUDED_REPEATED_SEGMENT', message: 'Repeated undirected source segment' });
    } else if (mobilityMode(way.tags.highway) === 'drive') driveWays.push(way);
    else if (mobilityMode(way.tags.highway) === 'walk') walkWays.push(way);
    else {
      (excludedWays['unsupported-highway'] ??= []).push(way.id);
      diagnostics.push({ sourceIds: [way.id], code: 'UNSUPPORTED_HIGHWAY',
        message: `Unsupported or absent independent surface highway class: ${way.tags.highway ?? 'none'}` });
    }
  }
  const discovered = selectCrossings(walkWays, driveWays,
    new Set([...nodes].filter(([, node]) => node.crossing).map(([id]) => id)), diagnostics);
  if (discovered.excluded.size) excludedWays['unsupported-crossing'] = [...discovered.excluded].sort();
  const independent = walkWays.filter(way => !discovered.excluded.has(way.id));
  for (const [mode, selected] of [['DRIVE', driveWays], ['WALK', independent]] as const) for (const way of selected) {
    diagnostics.push({ sourceIds: [way.id], code: `SELECTED_${mode}`,
      message: 'Source selected automatically; final route and full-body eligibility checked by the shared compiler' });
  }
  const halo: Bounds = [Math.max(-180, bounds[0] - 0.002), Math.max(-89.999, bounds[1] - 0.002),
    Math.min(180, bounds[2] + 0.002), Math.min(89.999, bounds[3] + 0.002)];
  const selection: Selection = { version: 1, baseDataset: input.baseDataset, bounds: halo,
    showcase: { target: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2], heading: 0, pitch: -45, range: 1 },
    driveWays, walkWays: independent, crossings: discovered.crossings, excludedWays, diagnostics };
  const origin: XY = [(halo[0] + halo[2]) / 2, (halo[1] + halo[3]) / 2];
  const coreOrigin: XY = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const obstacles = (polygons: Polygon2[]) => polygons.map(polygon => polygon.map(ring =>
    ring.map(point => project(unproject(point, coreOrigin), origin))));
  let compiled: ReturnType<typeof compileNetwork>;
  try {
    compiled = compileNetwork(source, selection, obstacles([...input.buildings, ...input.placements]),
      obstacles(input.water), { routePolicy: 'ports' });
  } catch (error) {
    if (!(error instanceof NoSafeRoutesError)) throw error;
    return { status: 'excluded', diagnostics: error.diagnostics };
  }
  const network = compiled.network, sourceSegments = new Map<string, { way: string; nodes: [number, number] }>();
  for (const edge of network.edges) {
    const match = /^(drive|walk)\/(way\/\d+)\/(\d+)-(\d+)(?:\/clip\/.+)?$/.exec(edge.id);
    if (match) sourceSegments.set(edge.id, { way: match[2], nodes: [Number(match[3]), Number(match[4])] });
  }
  const ownedEdges = network.edges.filter(edge => {
    const segment = sourceSegments.get(edge.id), junction = edge.sourceIds.find(id => /^node\/\d+$/.test(id));
    if (segment && edge.id.includes('/clip/')) {
      compiled.diagnostics.push({ sourceIds: edge.sourceIds, code: 'CLIPPED_HALO_LOOKAHEAD',
        message: `${edge.id}: clipped halo fragment is validation/lookahead data, not a second owned source segment` });
      return false;
    }
    let anchor: XY;
    if (segment) {
      const [a, b] = segment.nodes.map(id => nodes.get(id)!.coordinate);
      anchor = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    } else if (junction) anchor = nodes.get(Number(junction.slice('node/'.length)))!.coordinate;
    else anchor = unproject(edge.points[Math.floor(edge.points.length / 2)], network.origin);
    return contains(bounds, anchor);
  }).map(edge => edge.id);
  if (!network.routes.some(route => route.edges.some(id => ownedEdges.includes(id)))) {
    return { status: 'excluded', diagnostics: [...compiled.diagnostics,
      { sourceIds: [], code: 'NO_OWNED_ROUTE', message: 'Halo geometry is not usable owned traffic in this cell' }] };
  }
  const surfaces = new Map<string, MobilitySurface>(), sourceWays = new Map(ways.map(w => [w.id, w]));
  for (const edge of network.edges) {
    const segment = sourceSegments.get(edge.id);
    if (!segment) continue;
    const [a, b] = [...segment.nodes].sort((a, b) => a - b), id = `surface/${segment.way}/${a}-${b}`;
    if (surfaces.has(id)) continue;
    const way = sourceWays.get(segment.way)!;
    surfaces.set(id, { id, sourceIds: [segment.way], mode: edge.mode,
      points: [project(nodes.get(a)!.coordinate, network.origin), project(nodes.get(b)!.coordinate, network.origin)],
      width: edge.width * (edge.mode === 'drive' ? Number(way.tags.lanes ?? 2) : 1), height: 0.3,
      inferred: [...edge.inferred, 'surface height=0.3m above ellipsoid; no vertical reconstruction'] });
  }
  const owned = new Set(ownedEdges);
  const ports = network.edges.filter(edge => owned.has(edge.id)).flatMap(edge => (['entry', 'exit'] as const).map(at => {
    const a = at === 'entry' ? edge.points[0] : edge.points.at(-2)!;
    const b = at === 'entry' ? edge.points[1] : edge.points.at(-1)!;
    return { id: `${at}/${edge.id}`, edge: edge.id, at,
      coordinate: unproject(at === 'entry' ? a : b, network.origin),
      heading: Math.atan2(b[0] - a[0], b[1] - a[1]), allowed: [...edge.allowed], links: [] };
  }));
  return { status: 'ready', chunk: { version: 1, id: input.id, bounds: [...bounds],
    network: parseNetwork(network), ownedEdges, ports,
    zoneIds: Object.fromEntries(network.zones.map(zone => [zone.id, `${input.id}/${zone.id}`])),
    surfaces: [...surfaces.values()] }, diagnostics: compiled.diagnostics };
}
