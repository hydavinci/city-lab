import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { FeatureCollection } from 'geojson';
import type { Bounds } from '../../web/core/types';
import type { Polygon2, XY } from '../../web/core/enhancements';
import { geometryBounds, validateRing } from '../../web/core/geo';
import { polygonsIntersect, project } from '../enhancements/geometry';
import { validateSource } from '../enhancements/fetch';
import { validateOverpass, type OverpassResponse } from '../normalize';

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
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
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
async function atomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

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

export async function fetchMobility({ baseDir, cacheDir, refresh }: {
  baseDir: string; cacheDir: string; refresh: boolean;
}): Promise<void> {
  const baseText = await readFile(join(baseDir, 'manifest.json'), 'utf8');
  const base = JSON.parse(baseText) as { version: number; dataset: string; osmTimestamp: string };
  check(base.version === 1 && typeof base.dataset === 'string' && /^[a-f0-9]{16,64}$/.test(base.dataset),
    'Invalid base dataset');
  check(typeof base.osmTimestamp === 'string' && Number.isFinite(Date.parse(base.osmTimestamp)), 'Invalid base snapshot');
  const snapshot = new Date(base.osmTimestamp).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const boundaryText = await readFile(join(baseDir, base.dataset, 'boundary.json'), 'utf8');
  const planned = planCells(JSON.parse(boundaryText) as FeatureCollection);
  const endpoint = process.env.OVERPASS_ENDPOINT ?? 'https://overpass.private.coffee/api/interpreter';
  check(['http:', 'https:'].includes(new URL(endpoint).protocol), 'Invalid Overpass endpoint');
  const boundaryHash = hash(boundaryText), identity = hash(JSON.stringify({
    version: 1, baseHash: hash(baseText), boundaryHash, endpoint, snapshot,
  }));
  const progress: MobilityAcquisition = {
    version: 1, identity, baseDataset: base.dataset, boundaryHash, requestedSnapshot: snapshot, endpoint,
    cells: planned.map(cell => ({
      ...cell, status: 'pending',
      halo: [Math.max(-180, cell.bounds[0] - 0.002), Math.max(-90, cell.bounds[1] - 0.002),
        Math.min(180, cell.bounds[2] + 0.002), Math.min(90, cell.bounds[3] + 0.002)],
    })),
  };
  await mkdir(cacheDir, { recursive: true });
  const progressPath = join(cacheDir, 'progress.json');
  await atomic(progressPath, progress);
  const seen = new Map<string, string>();
  const verifyConsistency = (source: OverpassResponse) => {
    for (const element of source.elements) {
      const id = `${element.type}/${element.id}`, previous = seen.get(id);
      check(previous === undefined || previous === sourceHash(element), `Conflicting source geometry/tags/membership: ${id}`);
    }
  };
  for (const [index, cell] of progress.cells.entries()) {
    const path = `cell-${cell.id.slice('cell/'.length)}.json`, fullPath = join(cacheDir, path);
    const query = queryFor(cell.halo, snapshot);
    let cache: MobilitySourceCache | undefined;
    if (!refresh) {
      try {
        const candidate = JSON.parse(await readFile(fullPath, 'utf8')) as MobilitySourceCache;
        validateSource(candidate.response, { allowEmpty: true });
        const metadata = candidate.metadata;
        check(metadata.version === 1 && metadata.identity === identity && metadata.baseDataset === base.dataset
          && metadata.query === query && JSON.stringify(metadata.bounds) === JSON.stringify(cell.bounds)
          && JSON.stringify(metadata.halo) === JSON.stringify(cell.halo)
          && Number.isFinite(Date.parse(metadata.fetchedAt))
          && metadata.osmSnapshot === candidate.response.osm3s?.timestamp_osm_base
          && metadata.sourceHash === sourceHash(candidate.response), 'Cache metadata/hash mismatch');
        verifyConsistency(candidate.response); cache = candidate;
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
          verifyConsistency(data);
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
            throw new Error(`Mobility acquisition failed at ${cell.id}: ${cell.error}`, { cause: error });
          }
          console.warn(`Mobility ${cell.id} retry after ${attempt * 15}s:`, error);
          await setTimeout(attempt * 15_000);
        }
      }
      if (index + 1 < progress.cells.length) await setTimeout(2000);
    }
    check(cache, `Missing completed source for ${cell.id}`);
    for (const element of cache.response.elements) seen.set(`${element.type}/${element.id}`, sourceHash(element));
    const text = await readFile(fullPath, 'utf8');
    cell.status = 'complete'; cell.resource = { path, bytes: Buffer.byteLength(text), sha256: hash(text) };
    await atomic(progressPath, progress);
  }
  console.log(`Complete citywide acquisition: ${progress.cells.length} cells, ${seen.size} unique source elements.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  check(args.every(arg => arg === '--refresh' || arg.startsWith('--base-dir=') || arg.startsWith('--cache-dir=')),
    'Usage: data:mobility:fetch [--refresh] [--base-dir=path] [--cache-dir=path]');
  await fetchMobility({
    baseDir: args.find(arg => arg.startsWith('--base-dir='))?.slice('--base-dir='.length) ?? 'public/data',
    cacheDir: args.find(arg => arg.startsWith('--cache-dir='))?.slice('--cache-dir='.length) ?? 'data/raw/mobility',
    refresh: args.includes('--refresh'),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error('Citywide road acquisition failed; existing valid caches retained.', error);
    process.exitCode = 1;
  });
}
