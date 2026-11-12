import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { FeatureCollection } from 'geojson';
import type { Bounds, CityManifest } from '../../web/core/types';
import type { Polygon2, XY } from '../../web/core/enhancements';
import { geometryBounds, validateRing } from '../../web/core/geo';
import { polygonsIntersect, project } from '../enhancements/geometry';
import { validateSource } from '../enhancements/fetch';
import { validateOverpass, type OverpassResponse } from '../normalize';
import { atomicJSON as atomic, packageFile, sha256 as hash } from './files';

interface PlannedCell { id: string; bounds: Bounds }
export interface MobilitySourceCache {
  metadata: {
    version: 1; identity: string; baseDataset: string; query: string; bounds: Bounds; halo: Bounds;
    fetchedAt: string; osmSnapshot: string; sourceHash: string;
  };
  response: OverpassResponse;
}
export interface MobilityAcquisition {
  version: 1; identity: string; baseDataset: string; boundaryHash: string;
  requestedSnapshot: string; endpoint: string;
  cells: (PlannedCell & {
    halo: Bounds; status: 'pending' | 'complete' | 'failed';
    resource?: { path: string; bytes: number; sha256: string }; error?: string;
  })[];
}
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}
const sourceHash = (source: unknown) => hash(JSON.stringify(canonical(source)));

export function planCells(boundary: FeatureCollection, span = 0.02): PlannedCell[] {
  check(Number.isFinite(span) && span >= 0.001 && span <= 0.1, 'Invalid acquisition span');
  check(boundary?.type === 'FeatureCollection' && Array.isArray(boundary.features) && boundary.features.length,
    'Missing municipality boundary');
  const polygons: Polygon2[] = [], box: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of boundary.features) {
    const geometry = feature?.geometry;
    check(geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
      && !feature.properties?.tainted, 'Incomplete municipality boundary');
    const parts = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    check(parts.length && parts.every(rings => rings.length && rings.every(validateRing)), 'Invalid boundary rings');
    const bounds = geometryBounds(geometry);
    box[0] = Math.min(box[0], bounds[0]); box[1] = Math.min(box[1], bounds[1]);
    box[2] = Math.max(box[2], bounds[2]); box[3] = Math.max(box[3], bounds[3]);
    polygons.push(...parts.map(rings => rings.map(ring => ring.map(point => [point[0], point[1]] as XY))));
  }
  const [west, south, east, north] = box;
  check(west < east && south < north && south > -90 && north < 90, 'Invalid boundary bounds');
  const x0 = Math.floor(west / span), x1 = Math.ceil(east / span);
  const y0 = Math.floor(south / span), y1 = Math.ceil(north / span);
  check((x1 - x0) * (y1 - y0) <= 100_000, 'Unbounded acquisition grid');
  const origin: XY = [(west + east) / 2, (south + north) / 2];
  const local = polygons.map(polygon => polygon.map(ring => ring.map(point => project(point, origin))));
  const result: PlannedCell[] = [], rounded = (n: number) => Number(n.toFixed(8));
  for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) {
    const bounds: Bounds = [Math.max(west, rounded(x * span)), Math.max(south, rounded(y * span)),
      Math.min(east, rounded((x + 1) * span)), Math.min(north, rounded((y + 1) * span))];
    const [w, s, e, n] = bounds;
    const rectangle: Polygon2 = [[
      project([w, s], origin), project([e, s], origin), project([e, n], origin),
      project([w, n], origin), project([w, s], origin),
    ]];
    if (local.some(polygon => polygonsIntersect(polygon, rectangle))) result.push({ id: `cell/${x}_${y}`, bounds });
  }
  check(result.length, 'Municipality has no acquisition cells');
  return result;
}

function queryFor(halo: Bounds, snapshot: string): string {
  const [w, s, e, n] = halo, box = `${s},${w},${n},${e}`;
  return `[out:json][timeout:240][date:"${snapshot}"];
    (way["highway"](${box});node["highway"="crossing"](${box});)->.roads;
    (rel(bw.roads)["type"="restriction"];rel(bn.roads)["type"="restriction"];
      rel["type"="restriction"](${box});)->.restrictions;
    (.roads;.restrictions;);(._;>>;);out body;`;
}

function haloFor(bounds: Bounds): Bounds {
  return [Math.max(-180, bounds[0] - 0.002), Math.max(-90, bounds[1] - 0.002),
    Math.min(180, bounds[2] + 0.002), Math.min(90, bounds[3] + 0.002)];
}
async function baseInputs(baseDir: string) {
  const baseText = (await packageFile(baseDir, 'manifest.json')).toString();
  const base = JSON.parse(baseText) as CityManifest;
  check(base.version === 1 && typeof base.dataset === 'string' && /^[a-f0-9]{16,64}$/.test(base.dataset),
    'Invalid base dataset');
  check(typeof base.osmTimestamp === 'string' && Number.isFinite(Date.parse(base.osmTimestamp)), 'Invalid base snapshot');
  const snapshot = new Date(base.osmTimestamp).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const boundaryText = (await packageFile(baseDir, `${base.dataset}/boundary.json`)).toString();
  const planned = planCells(JSON.parse(boundaryText) as FeatureCollection);
  return { base, baseText, boundaryText, planned, snapshot };
}
function identityFor(baseText: string, boundaryText: string, endpoint: string, snapshot: string): string {
  return hash(JSON.stringify({ version: 1, baseHash: hash(baseText), boundaryHash: hash(boundaryText), endpoint, snapshot }));
}
function parseCache(value: unknown, expected: Pick<MobilitySourceCache['metadata'], 'identity' | 'baseDataset' | 'query' | 'bounds' | 'halo'>): MobilitySourceCache {
  check(value && typeof value === 'object', 'Missing source cache');
  const candidate = value as MobilitySourceCache;
  validateSource(candidate.response, { allowEmpty: true });
  const metadata = candidate.metadata;
  check(metadata?.version === 1 && metadata.identity === expected.identity && metadata.baseDataset === expected.baseDataset
    && metadata.query === expected.query && JSON.stringify(metadata.bounds) === JSON.stringify(expected.bounds)
    && JSON.stringify(metadata.halo) === JSON.stringify(expected.halo)
    && typeof metadata.fetchedAt === 'string' && Number.isFinite(Date.parse(metadata.fetchedAt))
    && metadata.osmSnapshot === candidate.response.osm3s?.timestamp_osm_base
    && metadata.sourceHash === sourceHash(candidate.response), 'Cache metadata/hash mismatch');
  return candidate;
}
function consistent(source: OverpassResponse, seen: ReadonlyMap<string, string>): void {
  for (const element of source.elements) {
    const id = `${element.type}/${element.id}`, previous = seen.get(id);
    check(previous === undefined || previous === sourceHash(element), `Conflicting source geometry/tags/membership: ${id}`);
  }
}

export async function readMobilitySources({ baseDir, cacheDir }: { baseDir: string; cacheDir: string }) {
  const inputs = await baseInputs(baseDir), { base, baseText, boundaryText, planned, snapshot } = inputs;
  const inventory = await packageFile(cacheDir, 'progress.json');
  const report = JSON.parse(inventory.toString()) as MobilityAcquisition;
  check(report?.version === 1 && report.baseDataset === base.dataset && report.boundaryHash === hash(boundaryText)
    && typeof report.endpoint === 'string' && report.requestedSnapshot === snapshot
    && report.identity === identityFor(baseText, boundaryText, report.endpoint, snapshot)
    && Array.isArray(report.cells) && report.cells.length === planned.length, 'Incomplete or stale acquisition inventory');
  async function* entries() {
    const seen = new Map<string, string>();
    for (const [i, cell] of report.cells.entries()) {
      const expected = planned[i], halo = haloFor(expected.bounds), path = `cell-${expected.id.slice('cell/'.length)}.json`;
      check(cell.id === expected.id && JSON.stringify(cell.bounds) === JSON.stringify(expected.bounds)
        && JSON.stringify(cell.halo) === JSON.stringify(halo) && cell.status === 'complete',
      `Incomplete source cell ${expected.id}: ${cell.error ?? cell.status}`);
      const resource = cell.resource;
      check(resource?.path === path && Number.isSafeInteger(resource.bytes) && resource.bytes > 0
        && typeof resource.sha256 === 'string' && /^[a-f0-9]{64}$/.test(resource.sha256), 'Invalid acquisition resource');
      const bytes = await packageFile(cacheDir, path);
      check(bytes.length === resource.bytes && hash(bytes) === resource.sha256, `Acquisition source bytes/hash mismatch: ${cell.id}`);
      const cache = parseCache(JSON.parse(bytes.toString()), {
        identity: report.identity, baseDataset: base.dataset, query: queryFor(halo, snapshot), bounds: expected.bounds, halo,
      });
      consistent(cache.response, seen);
      for (const element of cache.response.elements) seen.set(`${element.type}/${element.id}`, sourceHash(element));
      yield { cell: { ...expected, halo }, cache };
    }
  }
  return { ...inputs, report, entries, inventoryHash: hash(inventory) };
}

export async function fetchMobility({ baseDir, cacheDir, refresh, continueOnError = false }: {
  baseDir: string; cacheDir: string; refresh: boolean; continueOnError?: boolean;
}): Promise<void> {
  const { base, baseText, boundaryText, planned, snapshot } = await baseInputs(baseDir);
  const endpoint = process.env.OVERPASS_ENDPOINT ?? 'https://overpass.private.coffee/api/interpreter';
  check(['http:', 'https:'].includes(new URL(endpoint).protocol), 'Invalid Overpass endpoint');
  const boundaryHash = hash(boundaryText), identity = identityFor(baseText, boundaryText, endpoint, snapshot);
  const progress: MobilityAcquisition = {
    version: 1, identity, baseDataset: base.dataset, boundaryHash, requestedSnapshot: snapshot, endpoint,
    cells: planned.map(cell => ({
      ...cell, status: 'pending',
      halo: haloFor(cell.bounds),
    })),
  };
  await mkdir(cacheDir, { recursive: true });
  const progressPath = join(cacheDir, 'progress.json');
  await atomic(progressPath, progress);
  const seen = new Map<string, string>();
  for (const [index, cell] of progress.cells.entries()) {
    const path = `cell-${cell.id.slice('cell/'.length)}.json`, fullPath = join(cacheDir, path);
    const query = queryFor(cell.halo, snapshot);
    let cache: MobilitySourceCache | undefined;
    if (!refresh) {
      try {
        const candidate = parseCache(JSON.parse((await packageFile(cacheDir, path)).toString()), {
          identity, baseDataset: base.dataset, query, bounds: cell.bounds, halo: cell.halo,
        });
        consistent(candidate.response, seen); cache = candidate;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          console.warn(`Invalid mobility cache ${cell.id}; downloading replacement:`, error);
        }
      }
    }
    if (!cache) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`Mobility ${index + 1}/${progress.cells.length}: ${cell.id} (${attempt}/3)`);
          const response = await fetch(endpoint, {
            method: 'POST', body: new URLSearchParams({ data: query }),
            headers: { 'User-Agent': 'SuzhouCityLab/0.1 (local OSM visualization)' },
            signal: AbortSignal.timeout(300_000),
          });
          check(response.ok, `Overpass HTTP ${response.status}`);
          const source: unknown = JSON.parse(await response.text());
          validateSource(source, { allowEmpty: true });
          const data = validateOverpass(source);
          consistent(data, seen);
          cache = { metadata: {
            version: 1, identity, baseDataset: base.dataset, query, bounds: cell.bounds, halo: cell.halo,
            fetchedAt: new Date().toISOString(), osmSnapshot: data.osm3s!.timestamp_osm_base!,
            sourceHash: sourceHash(source),
          }, response: source as OverpassResponse };
          await atomic(fullPath, cache);
          break;
        } catch (error) {
          cache = undefined;
          if (attempt === 3) {
            cell.status = 'failed'; cell.error = error instanceof Error ? error.message : String(error);
            await atomic(progressPath, progress);
            const failure = new Error(`Mobility acquisition failed at ${cell.id}: ${cell.error}`, { cause: error });
            if (!continueOnError) throw failure;
            console.error(failure.message);
            break;
          }
          console.warn(`Mobility ${cell.id} retry after ${attempt * 15}s:`, error);
          await setTimeout(attempt * 15_000);
        }
      }
      if (index + 1 < progress.cells.length) await setTimeout(2000);
    }
    if (!cache && continueOnError && cell.status === 'failed') continue;
    check(cache, `Missing completed source for ${cell.id}`);
    for (const element of cache.response.elements) seen.set(`${element.type}/${element.id}`, sourceHash(element));
    const text = await readFile(fullPath, 'utf8');
    cell.status = 'complete'; cell.resource = { path, bytes: Buffer.byteLength(text), sha256: hash(text) };
    await atomic(progressPath, progress);
  }
  const failed = progress.cells.filter(cell => cell.status === 'failed').length;
  check(!failed, `Incomplete citywide acquisition: ${failed}/${progress.cells.length} cells failed; see ${progressPath}`);
  console.log(`Complete citywide acquisition: ${progress.cells.length} cells, ${seen.size} unique source elements.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  check(args.every(arg => arg === '--refresh' || arg === '--continue-on-error'
    || arg.startsWith('--base-dir=') || arg.startsWith('--cache-dir=')),
    'Usage: data:mobility:fetch [--refresh] [--continue-on-error] [--base-dir=path] [--cache-dir=path]');
  await fetchMobility({
    baseDir: args.find(arg => arg.startsWith('--base-dir='))?.slice('--base-dir='.length) ?? 'public/data',
    cacheDir: args.find(arg => arg.startsWith('--cache-dir='))?.slice('--cache-dir='.length) ?? 'data/raw/mobility',
    refresh: args.includes('--refresh'),
    continueOnError: args.includes('--continue-on-error'),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error('Citywide road acquisition failed; existing valid caches retained.', error);
    process.exitCode = 1;
  });
}
