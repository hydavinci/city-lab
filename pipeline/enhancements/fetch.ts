import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { validateOverpass } from '../normalize';
import type { Bounds } from '../../web/core/types';

// Broad investigation window, not the final published district.
const initialBounds: Bounds = [120.671, 31.308, 120.691, 31.330];

export function validateSource(value: unknown): void {
  const data = validateOverpass(value, true);
  if (!data.osm3s?.timestamp_osm_base || !Number.isFinite(Date.parse(data.osm3s.timestamp_osm_base))) {
    throw new Error('Missing/invalid OSM snapshot');
  }
  const elements = new Map<string, Record<string, unknown>>();
  for (const e of data.elements) {
    if (!e || !['node', 'way', 'relation'].includes(String(e.type)) || !Number.isSafeInteger(e.id) || Number(e.id) <= 0) {
      throw new Error('Invalid source element ID/type');
    }
    const key = `${e.type}/${e.id}`;
    if (elements.has(key)) throw new Error(`Duplicate source ${key}`);
    elements.set(key, e);
    if (e.tags !== undefined && (!e.tags || typeof e.tags !== 'object' || Array.isArray(e.tags)
      || Object.values(e.tags).some(tag => typeof tag !== 'string'))) throw new Error(`Invalid tags on ${key}`);
    if (e.type === 'node' && (typeof e.lon !== 'number' || typeof e.lat !== 'number'
      || !Number.isFinite(e.lon) || !Number.isFinite(e.lat) || Math.abs(e.lon) > 180 || Math.abs(e.lat) > 90)) {
      throw new Error(`Invalid coordinates on ${key}`);
    }
  }
  for (const [key, e] of elements) {
    if (e.type === 'way') {
      if (!Array.isArray(e.nodes) || e.nodes.length < 2
        || e.nodes.some(id => !Number.isSafeInteger(id) || !elements.has(`node/${id}`))) {
        throw new Error(`Incomplete way node references: ${key}`);
      }
    }
    if (e.type === 'relation') {
      if (!Array.isArray(e.members) || !e.members.length || e.members.some(member =>
        !member || typeof member.role !== 'string' || !Number.isSafeInteger(member.ref)
        || !elements.has(`${member.type}/${member.ref}`))) throw new Error(`Incomplete relation members: ${key}`);
    }
  }
}

export async function fetchDistrict({ bounds, cacheDir, refresh }: {
  bounds: Bounds; cacheDir: string; refresh: boolean;
}): Promise<void> {
  const [west, south, east, north] = bounds;
  if (bounds.length !== 4 || !bounds.every(Number.isFinite) || west < -180 || east > 180 || south < -90 || north > 90
    || west >= east || south >= north || east - west > 0.1 || north - south > 0.1) {
    throw new Error('Invalid bounds: ordered WGS84 bbox with each span at most 0.1 degrees required');
  }
  const endpoint = process.env.OVERPASS_ENDPOINT ?? 'https://overpass.private.coffee/api/interpreter';
  const hostname = new URL(endpoint).hostname;
  const box = `${south},${west},${north},${east}`;
  const query = `[out:json][timeout:180];(
    way["highway"](${box});
    node["highway"="crossing"](${box});
    rel["type"="restriction"](${box});
  );(._;>>;);out body;`;
  const path = join(cacheDir, 'district.json');
  await mkdir(cacheDir, { recursive: true });
  if (!refresh) {
    try {
      const cache = JSON.parse(await readFile(path, 'utf8'));
      validateSource(cache.response);
      if (JSON.stringify(cache.metadata.bounds) !== JSON.stringify(bounds) || cache.metadata.query !== query
        || cache.metadata.endpoint !== hostname || !Number.isFinite(Date.parse(cache.metadata.fetchedAt))
        || cache.metadata.osmSnapshot !== cache.response.osm3s.timestamp_osm_base) throw new Error('Cache metadata mismatch');
      console.log(`Using validated district cache: ${path}`);
      return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) console.warn('Invalid district cache; downloading replacement:', error);
    }
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      console.log(`Downloading district (${attempt}/3) from ${hostname}`);
      const response = await fetch(endpoint, {
        method: 'POST', body: new URLSearchParams({ data: query }),
        headers: { 'User-Agent': 'SuzhouCityLab/0.1 (local OSM visualization)' },
        signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
      const source: unknown = JSON.parse(await response.text());
      validateSource(source);
      const metadata = {
        query, bounds, endpoint: hostname, fetchedAt: new Date().toISOString(),
        osmSnapshot: validateOverpass(source, true).osm3s!.timestamp_osm_base,
      };
      // One atomic envelope keeps metadata and source on the same snapshot.
      await writeFile(temporary, JSON.stringify({ metadata, response: source }));
      await rename(temporary, path);
      console.log(`Saved complete district source: ${path}`);
      return;
    } catch (error) {
      await rm(temporary, { force: true });
      if (attempt === 3) throw error;
      console.warn(`Download failed; retrying after ${attempt * 15}s:`, error);
      await setTimeout(attempt * 15_000);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--refresh' && !arg.startsWith('--bounds=') && !arg.startsWith('--cache-dir='))) {
    throw new Error('Usage: data:enhancements:fetch [--refresh] [--bounds=west,south,east,north] [--cache-dir=path]');
  }
  const rawBounds = args.find(arg => arg.startsWith('--bounds='))?.slice('--bounds='.length);
  const bounds = rawBounds ? rawBounds.split(',').map(Number) as Bounds : initialBounds;
  const cacheDir = args.find(arg => arg.startsWith('--cache-dir='))?.slice('--cache-dir='.length) ?? 'data/raw/jinji-lake';
  await fetchDistrict({ bounds, cacheDir, refresh: args.includes('--refresh') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error('District preparation failed; existing cache retained.', error);
    process.exitCode = 1;
  });
}
