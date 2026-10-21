import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson';
import { parseEnhancementManifest, parseNetwork, parsePlacements, validatePolygon,
  type Diagnostic, type Polygon2, type XY } from '../../web/core/enhancements';
import { parseMobilityChunk, parseMobilityManifest, type MobilityCell, type MobilityChunk, type MobilityManifest,
  type MobilityCoverage, type MobilityResource } from '../../web/core/mobility';
import type { Bounds } from '../../web/core/types';
import { boundsOverlap, distance, polygonBounds, project, spatialCandidates, unproject } from '../enhancements/geometry';
import { ACTORS, clipSegment } from '../enhancements/routes';
import { validateGLB } from '../enhancements/build';
import { compileCell, mobilityMode } from './compile';
import { readMobilitySources, type MobilitySourceCache } from './fetch';
import { stitchChunks } from './stitch';
import { atomicFile, atomicJSON, packageFile, sha256 } from './files';

type Compilation = ReturnType<typeof compileCell>;
type FileRecord = { bytes: number; sha256: string };
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Mobility publication: ${message}`); }
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const fingerprint = (bytes: Buffer): FileRecord => ({ bytes: bytes.length, sha256: sha256(bytes) });
function validateResult(result: Compilation, cell: { id: string; bounds: Bounds }): void {
  check(result && ['ready', 'empty', 'excluded'].includes(result.status) && Array.isArray(result.diagnostics), 'Invalid compiled status');
  for (const diagnostic of result.diagnostics) {
    check(diagnostic && Array.isArray(diagnostic.sourceIds) && diagnostic.sourceIds.every(id => typeof id === 'string')
      && typeof diagnostic.code === 'string' && diagnostic.code.trim()
      && typeof diagnostic.message === 'string' && diagnostic.message.trim(), 'Invalid compiled diagnostic');
  }
  if (result.status === 'ready') {
    parseMobilityChunk(result.chunk, { ...cell, status: 'ready', neighbours: [], driveMetres: 0, walkMetres: 0, diagnosticCodes: [] });
  } else check(result.chunk === undefined && (result.status !== 'excluded' || result.diagnostics.length), 'Invalid inactive compiled result');
}
function geographicPolygons(collection: FeatureCollection, layer?: string): { polygons: Polygon2[]; lines: { id: string; bounds: Bounds }[] } {
  check(collection?.type === 'FeatureCollection' && Array.isArray(collection.features), 'Invalid base feature collection');
  const polygons: Polygon2[] = [], lines: { id: string; bounds: Bounds }[] = [];
  for (const feature of collection.features) {
    check(feature?.type === 'Feature' && feature.geometry, 'Invalid base feature');
    if (layer && feature.properties?.layer !== layer) continue;
    const geometry = feature.geometry;
    if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
      check(layer === 'water', 'Unexpected line-only building');
      const points = (geometry.type === 'LineString' ? geometry.coordinates : geometry.coordinates.flat()).map(point => {
        check(point.length >= 2 && point.slice(0, 2).every(Number.isFinite)
          && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90, 'Invalid water line');
        return [point[0], point[1]] as XY;
      });
      check(points.length >= 2, 'Incomplete water line');
      lines.push({ id: String(feature.id ?? feature.properties?.id), bounds: polygonBounds([points]) });
      continue;
    }
    check(geometry.type === 'Polygon' || geometry.type === 'MultiPolygon', 'Unsupported obstacle geometry');
    const parts = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const part of parts) {
      const polygon = part.map(ring => ring.map(point => {
        check(point.length >= 2 && point.slice(0, 2).every(Number.isFinite)
          && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90, 'Invalid geographic obstacle');
        return [point[0], point[1]] as XY;
      }));
      check(polygon[0]?.[0], 'Empty base polygon');
      validatePolygon(polygon.map(ring => ring.map(point => project(point, polygon[0][0]))));
      polygons.push(polygon);
    }
  }
  return { polygons, lines };
}

export async function buildMobility(options: {
  baseDir: string; cacheDir: string; outputDir: string;
  onProgress?: (completed: number, total: number) => void;
}): Promise<MobilityManifest> {
  const source = await readMobilitySources(options), { base, baseText, report } = source;
  check(Array.isArray(base.tiles) && base.tiles.length && Array.isArray(base.bounds)
    && base.bounds.length === 4 && base.bounds.every(Number.isFinite), 'Invalid base tile inventory');
  const tileIds = new Set<string>();
  for (const tile of base.tiles) {
    check(typeof tile.id === 'string' && /^[\w-]+$/.test(tile.id) && !tileIds.has(tile.id)
      && Array.isArray(tile.bounds) && tile.bounds.length === 4 && tile.bounds.every(Number.isFinite)
      && tile.bounds[0] < tile.bounds[2] && tile.bounds[1] < tile.bounds[3], 'Invalid base tile');
    tileIds.add(tile.id);
  }
  const enhancementDir = resolve(options.baseDir, '..', 'enhancements'), assetBytes = await packageFile(enhancementDir, 'manifest.json');
  const assets = parseEnhancementManifest(JSON.parse(assetBytes.toString()), base.dataset);
  const kinds = ['car-a', 'car-b', 'bus', 'person-a', 'person-b', 'tree', 'lamp', 'entrance', 'roof-unit'];
  check(assets.assets.length === kinds.length && kinds.every(kind => assets.assets.some(asset => asset.kind === kind)),
    'Missing verified nine-kind assets');
  for (const asset of assets.assets) {
    const bytes = await packageFile(enhancementDir, asset.uri);
    check(bytes.length === asset.bytes && sha256(bytes) === asset.sha256, `Asset bytes/hash mismatch: ${asset.kind}`);
    validateGLB(bytes, asset.size, asset.animation);
    if (asset.kind in ACTORS) {
      const body = ACTORS[asset.kind as keyof typeof ACTORS];
      check(asset.size[0] <= body.length && asset.size[1] <= body.width, `Asset exceeds certified body: ${asset.kind}`);
      check(!asset.kind.startsWith('person-') || asset.animation === 'Walk', 'People require a certified Walk clip');
    }
  }
  const assetNetworkBytes = await packageFile(enhancementDir, assets.network);
  const assetNetwork = parseNetwork(JSON.parse(assetNetworkBytes.toString()));
  const placementBytes = await packageFile(enhancementDir, assets.placements);
  const placements = parsePlacements(JSON.parse(placementBytes.toString()), assets.assets);
  const staticPolygons = placements.map(placement => placement.footprint.map(ring =>
    ring.map(point => unproject(point, assetNetwork.origin))));
  const surfaceBytes = await packageFile(options.baseDir, `${base.dataset}/surface.json`);
  const water = geographicPolygons(JSON.parse(surfaceBytes.toString()) as FeatureCollection, 'water');
  const cityOrigin: XY = [(base.bounds[0] + base.bounds[2]) / 2, (base.bounds[1] + base.bounds[3]) / 2];
  const metricBounds = (bounds: Bounds): Bounds => {
    const lo = project([bounds[0], bounds[1]], cityOrigin), hi = project([bounds[2], bounds[3]], cityOrigin);
    return [lo[0], lo[1], hi[0], hi[1]];
  };
  const waterIndex = spatialCandidates(water.polygons, polygon => metricBounds(polygonBounds(polygon)));
  const lineIndex = spatialCandidates(water.lines, line => metricBounds(line.bounds));
  const placementIndex = spatialCandidates(staticPolygons, polygon => metricBounds(polygonBounds(polygon)));
  const tileIndex = spatialCandidates(base.tiles, tile => metricBounds(tile.bounds));
  const nearbyWater = (bounds: Bounds) => waterIndex(metricBounds(bounds));
  const nearbyLines = (bounds: Bounds) => lineIndex(metricBounds(bounds));
  const nearbyPlacements = (bounds: Bounds) => placementIndex(metricBounds(bounds));
  const nearbyTiles = (bounds: Bounds) => tileIndex(metricBounds(bounds));
  const generatorFiles = ['./build.ts', './compile.ts', './stitch.ts', './fetch.ts', './files.ts',
    '../enhancements/routes.ts', '../enhancements/geometry.ts', '../enhancements/build.ts',
    '../enhancements/animation-bounds.ts', '../../web/core/enhancements.ts', '../../web/core/mobility.ts',
    '../../web/core/mobility-actors.ts'];
  const generatorHash = sha256(json(await Promise.all(generatorFiles.map(async path =>
    [path, sha256(await readFile(new URL(path, import.meta.url)))]))));
  const baseHash = sha256(baseText), staticHash = sha256(json([sha256(assetBytes), sha256(assetNetworkBytes), sha256(placementBytes)]));
  const compiledDir = join(options.cacheDir, 'compiled');
  await mkdir(compiledDir, { recursive: true });
  check(!(await lstat(compiledDir)).isSymbolicLink(), 'Compiled cache directory is a symlink');
  const tiles = new Map<string, { bytes: Buffer; polygons: Polygon2[] }>();
  const chunks: MobilityChunk[] = [], records: {
    id: string; status: Compilation['status']; diagnostics: Diagnostic[]; inputs: string;
    sourceHash: string; metadata: MobilitySourceCache['metadata'];
    obstacleFiles: { path: string; sha256: string }[];
  }[] = [];
  const sourceSegments = new Map<string, {
    way: string; highway: string; length: number; intervals: [number, number][];
  }>();
  for await (const { cell, cache } of source.entries()) {
    const nodes = new Map(cache.response.elements.filter(element => element.type === 'node')
      .map(node => [Number(node.id), [node.lon, node.lat] as XY]));
    for (const way of cache.response.elements.filter(element => element.type === 'way')) {
      const ids = way.nodes as number[], highway = (way.tags as Record<string, string> | undefined)?.highway ?? 'none';
      for (let i = 1; i < ids.length; i++) {
        const a = nodes.get(ids[i - 1])!, b = nodes.get(ids[i])!, clipped = clipSegment(a, b, cell.bounds);
        if (!clipped) continue;
        const key = `${way.id}/${ids[i - 1]}-${ids[i]}`, segment = sourceSegments.get(key) ?? {
          way: String(way.id), highway, length: distance(project(a, cityOrigin), project(b, cityOrigin)), intervals: [],
        };
        segment.intervals.push([clipped[2], clipped[3]]); sourceSegments.set(key, segment);
      }
    }
    const origin: XY = [(cell.bounds[0] + cell.bounds[2]) / 2, (cell.bounds[1] + cell.bounds[3]) / 2];
    const local = (polygons: Polygon2[]) => polygons.map(polygon => polygon.map(ring => ring.map(point => project(point, origin))));
    const buildings: Polygon2[] = [], obstacleFiles = [{ path: `${base.dataset}/surface.json`, sha256: sha256(surfaceBytes) }];
    for (const tile of nearbyTiles(cell.halo)) {
      const path = `${base.dataset}/tiles/${tile.id}.json`;
      let cached = tiles.get(tile.id);
      if (!cached) {
        const bytes = await packageFile(options.baseDir, path);
        cached = { bytes, polygons: geographicPolygons(JSON.parse(bytes.toString()) as FeatureCollection<Polygon | MultiPolygon>).polygons };
        tiles.set(tile.id, cached);
      }
      obstacleFiles.push({ path, sha256: sha256(cached.bytes) });
      buildings.push(...cached.polygons.filter(polygon => boundsOverlap(polygonBounds(polygon), cell.halo)));
    }
    const inputs = sha256(json({ version: 1, id: cell.id, bounds: cell.bounds, halo: cell.halo,
      sourceHash: cache.metadata.sourceHash, baseHash, generatorHash, staticHash, obstacleFiles }));
    const path = `${cell.id.replace('/', '-')}.json`;
    let result: Compilation | undefined;
    try {
      const cached = JSON.parse((await packageFile(compiledDir, path)).toString()) as { inputs: string; result: Compilation; sha256: string };
      check(cached.inputs === inputs && cached.sha256 === sha256(json(cached.result)), 'Compiled inputs/hash mismatch');
      validateResult(cached.result, cell); result = cached.result;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) console.warn(`Recompiling mobility ${cell.id}:`, error);
    }
    if (!result) {
      const unbounded = nearbyLines(cell.halo);
      result = unbounded.length ? { status: 'excluded', diagnostics: unbounded.map(line => ({
        sourceIds: [line.id], code: 'UNBOUNDED_WATER_LINE', message: 'Source water line has no proven width; activity excluded in its intersecting cell halo',
      })) } : compileCell({ id: cell.id, bounds: cell.bounds, source: cache.response, baseDataset: base.dataset,
        buildings: local(buildings), water: local(nearbyWater(cell.halo)), placements: local(nearbyPlacements(cell.halo)) });
      validateResult(result, cell);
      await atomicJSON(join(compiledDir, path), { inputs, result, sha256: sha256(json(result)) });
    }
    if (result.chunk) chunks.push(result.chunk);
    records.push({ id: cell.id, status: result.status, diagnostics: result.diagnostics, inputs,
      sourceHash: cache.metadata.sourceHash, metadata: { ...cache.metadata }, obstacleFiles });
    options.onProgress?.(records.length, report.cells.length);
  }
  const highwayLengths = new Map<string, { metres: number; ways: Set<string> }>();
  for (const segment of sourceSegments.values()) {
    let end = 0, covered = 0;
    for (const [lo, hi] of segment.intervals.sort(([a], [b]) => a - b)) {
      covered += Math.max(0, hi - Math.max(lo, end)); end = Math.max(end, hi);
    }
    const group = highwayLengths.get(segment.highway) ?? { metres: 0, ways: new Set<string>() };
    group.metres += segment.length * covered; group.ways.add(segment.way); highwayLengths.set(segment.highway, group);
  }
  const sourceLengths = { driveMetres: 0, walkMetres: 0, otherMetres: 0,
    byHighway: Object.fromEntries([...highwayLengths].sort(([a], [b]) => a.localeCompare(b))
      .map(([highway, group]) => [highway, { metres: group.metres, ways: group.ways.size }])) };
  for (const [highway, group] of highwayLengths) {
    const mode = mobilityMode(highway);
    sourceLengths[mode === 'drive' ? 'driveMetres' : mode === 'walk' ? 'walkMetres' : 'otherMetres'] += group.metres;
  }
  const stitched = new Map(stitchChunks(chunks).map(chunk => [chunk.id, chunk]));
  chunks.length = 0;
  const neighbours = new Map(report.cells.map(cell => [cell.id, new Set<string>()]));
  for (const cell of report.cells) {
    const [x, y] = cell.id.slice('cell/'.length).split('_').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const id = `cell/${x + dx}_${y + dy}`;
      if ((dx || dy) && neighbours.has(id)) neighbours.get(cell.id)!.add(id);
    }
  }
  for (const chunk of stitched.values()) for (const port of chunk.ports) for (const link of port.links) {
    neighbours.get(chunk.id)!.add(link.cell); neighbours.get(link.cell)!.add(chunk.id);
  }
  const cells: MobilityCell[] = report.cells.map((sourceCell, i) => {
    const record = records[i], chunk = stitched.get(sourceCell.id);
    if (record.status === 'ready' && !chunk) {
      record.status = 'excluded'; record.diagnostics.push({ sourceIds: [], code: 'NO_OWNED_GEOMETRY',
        message: 'Boundary ownership resolved to another cell; no duplicate traffic published' });
    }
    const owned = new Set(chunk?.ownedEdges);
    const length = (mode: 'drive' | 'walk') => chunk?.network.edges.filter(edge => owned.has(edge.id) && edge.mode === mode)
      .reduce((sum, edge) => sum + edge.length, 0) ?? 0;
    return { id: sourceCell.id, bounds: sourceCell.bounds, status: record.status,
      neighbours: [...neighbours.get(sourceCell.id)!].sort(), driveMetres: length('drive'), walkMetres: length('walk'),
      diagnosticCodes: [...new Set(record.diagnostics.map(diagnostic => diagnostic.code))].sort() };
  });
  const coverage: MobilityCoverage = { cells: cells.length, ready: 0, empty: 0, excluded: 0, failed: 0, driveMetres: 0, walkMetres: 0 };
  for (const cell of cells) { coverage[cell.status]++; coverage.driveMetres += cell.driveMetres; coverage.walkMetres += cell.walkMetres; }
  const assetPath = `mobility-assets-${sha256(assetBytes)}.json`;
  const assetResource: MobilityResource = { uri: `enhancements/${assetPath}`, ...fingerprint(assetBytes) };
  const coverageReport = { version: 1, baseDataset: base.dataset, baseHash, generatorHash,
    acquisition: { identity: report.identity, boundaryHash: report.boundaryHash, endpoint: report.endpoint,
      requestedSnapshot: report.requestedSnapshot }, coverage, sourceLengths,
    assets: assetResource, assumptions: { lengthBasis: 'owned directed validated path metres including turns; not undirected street length',
      sourceCoverage: 'all acquisition cells classified; unsupported or unbounded geometry explicitly excluded',
      sourceLengthBasis: 'source way centrelines clipped to acquisition core rectangles; shared-cell intervals counted once; '
        + 'edge rectangles include municipality-border context; no halo or invented turns; classification is not proof of usable traffic' },
    cells: records };
  await mkdir(options.outputDir, { recursive: true });
  const lock = join(options.outputDir, '.publish-lock'), stage = join(options.outputDir, `.staging-${randomUUID()}`);
  await mkdir(lock);
  try {
    await mkdir(stage);
    const files = new Map<string, FileRecord>();
    for (const cell of cells) {
      const chunk = stitched.get(cell.id);
      if (!chunk) continue;
      parseMobilityChunk(chunk, cell);
      const bytes = json(chunk), name = `${cell.id.replace('/', '-')}.json`;
      await writeFile(join(stage, name), bytes, { flag: 'wx' }); files.set(name, fingerprint(bytes));
      stitched.delete(cell.id);
    }
    const reportBytes = json(coverageReport);
    await writeFile(join(stage, 'coverage.json'), reportBytes, { flag: 'wx' }); files.set('coverage.json', fingerprint(reportBytes));
    const id = sha256(json({ version: 1, baseDataset: base.dataset, assets: assetResource,
      files: [...files].sort(([a], [b]) => a.localeCompare(b)) })).slice(0, 32);
    for (const cell of cells) if (cell.status === 'ready') {
      const name = `${cell.id.replace('/', '-')}.json`;
      cell.resource = { uri: `mobility/${id}/${name}`, ...files.get(name)! };
    }
    const manifest = parseMobilityManifest({ version: 1, id, baseDataset: base.dataset, bounds: base.bounds,
      generatedAt: new Date().toISOString(), assets: assetResource, cells, coverage,
      report: { uri: `mobility/${id}/coverage.json`, ...files.get('coverage.json')! } }, base.dataset);
    for (const [name, expected] of files) {
      const bytes = await packageFile(stage, name);
      check(bytes.length === expected.bytes && sha256(bytes) === expected.sha256, `Staged bytes/hash mismatch: ${name}`);
    }
    try {
      check(assetBytes.equals(await packageFile(enhancementDir, assetPath)), 'Immutable asset manifest collision');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await atomicFile(join(enhancementDir, assetPath), assetBytes);
      check(assetBytes.equals(await packageFile(enhancementDir, assetPath)), 'Immutable asset manifest snapshot mismatch');
    }
    check((await packageFile(options.baseDir, 'manifest.json')).toString() === baseText
      && sha256(await packageFile(options.cacheDir, 'progress.json')) === source.inventoryHash, 'Inputs changed during publication');
    const target = join(options.outputDir, id);
    const existing = await lstat(target).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      return undefined;
    });
    if (existing) {
      check(existing.isDirectory() && !existing.isSymbolicLink(), 'Immutable package collision');
      const entries = await readdir(target);
      check(entries.length === files.size, 'Immutable package inventory collision');
      for (const [name, expected] of files) {
        const bytes = await packageFile(target, name);
        check(bytes.length === expected.bytes && sha256(bytes) === expected.sha256, `Immutable content collision: ${name}`);
      }
    } else await rename(stage, target);
    await atomicJSON(join(options.outputDir, 'manifest.json'), manifest);
    return manifest;
  } finally {
    await rm(stage, { recursive: true, force: true }); await rm(lock, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), names = ['base-dir', 'cache-dir', 'output-dir'];
  const option = (name: string, fallback: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const main = async () => {
    check(args.every(arg => names.some(name => arg.startsWith(`--${name}=`))), 'Unknown mobility build argument');
    const manifest = await buildMobility({ baseDir: option('base-dir', 'public/data'),
      cacheDir: option('cache-dir', 'data/raw/mobility'), outputDir: option('output-dir', 'public/mobility'),
      onProgress: (done, total) => console.log(`Mobility compilation: ${done}/${total}`) });
    console.log(JSON.stringify({ id: manifest.id, ...manifest.coverage }));
  };
  main().catch((error: unknown) => {
    console.error('Mobility publication failed; previous active manifest retained.', error); process.exitCode = 1;
  });
}
