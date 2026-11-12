import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FeatureCollection, Polygon } from 'geojson';
import { fetchMobility, planCells } from '../../pipeline/mobility/fetch';
import { validateSource } from '../../pipeline/enhancements/fetch';
import { overpass } from '../fixtures/enhancements';

vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }));

function boundary(ring: number[][], holes: number[][][] = []): FeatureCollection<Polygon> {
  return { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring, ...holes] } },
  ] };
}
const rectangle = (w: number, s: number, e: number, n: number) =>
  [[w, s], [e, s], [e, n], [w, n], [w, s]];

describe('municipality acquisition grid', () => {
  it('covers actual polygon intersections, not the entire bounding rectangle', () => {
    const shape = boundary([[0.001, 0.001], [0.059, 0.001], [0.059, 0.009],
      [0.009, 0.009], [0.009, 0.059], [0.001, 0.059], [0.001, 0.001]]);
    const cells = planCells(shape);
    expect(cells.map(c => c.id).sort()).toEqual(['cell/0_0', 'cell/0_1', 'cell/0_2', 'cell/1_0', 'cell/2_0']);
    expect(cells).toEqual(planCells(structuredClone(shape)));
    expect(cells.find(c => c.id === 'cell/2_0')!.bounds).toEqual([0.04, 0.001, 0.059, 0.02]);
  });

  it('excludes cells wholly inside holes and includes separate islands', () => {
    const shape = boundary(rectangle(0.001, 0.001, 0.059, 0.059), [rectangle(0.019, 0.019, 0.041, 0.041)]);
    expect(planCells(shape).map(c => c.id)).not.toContain('cell/1_1');
    shape.features.push(...boundary(rectangle(0.081, 0.081, 0.089, 0.089)).features);
    expect(planCells(shape).map(c => c.id)).toContain('cell/4_4');
  });

  it('rejects malformed boundaries and unbounded acquisition before requests', () => {
    for (const shape of [
      { type: 'FeatureCollection', features: [] },
      boundary([[0, 0], [1, 0], [1, 1]]),
      boundary(rectangle(-180, -90, 180, 90)),
    ]) expect(() => planCells(shape as FeatureCollection)).toThrow();
    for (const span of [0, NaN, Infinity, 1e-10, 360]) {
      expect(() => planCells(boundary(rectangle(0, 0, 0.01, 0.01)), span)).toThrow();
    }
  });
});

describe('resumable citywide road acquisition', () => {
  let root: string, baseDir: string, cacheDir: string;
  let base: { version: number; dataset: string; osmTimestamp: string };
  let shape: FeatureCollection<Polygon>;
  const response = () => new Response(JSON.stringify(overpass));
  const run = (refresh = false) => fetchMobility({ baseDir, cacheDir, refresh });
  const progress = async () => JSON.parse(await readFile(join(cacheDir, 'progress.json'), 'utf8'));
  const cached = async () => (await readdir(cacheDir)).filter(path => path.startsWith('cell-')).sort();
  beforeEach(async () => {
    root = await mkdtemp(join(process.cwd(), '.mobility-fetch-test-'));
    baseDir = join(root, 'base'); cacheDir = join(root, 'cache');
    base = { version: 1, dataset: '0123456789abcdef', osmTimestamp: overpass.osm3s.timestamp_osm_base };
    shape = boundary(rectangle(0.001, 0.001, 0.019, 0.019));
    await mkdir(join(baseDir, base.dataset), { recursive: true });
    await writeFile(join(baseDir, 'manifest.json'), JSON.stringify(base));
    await writeFile(join(baseDir, base.dataset, 'boundary.json'), JSON.stringify(shape));
  });
  afterEach(async () => {
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('retries a partial response, saves only complete data and reuses a verified cache', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...overpass, remark: 'runtime error: Query timed out' })))
      .mockImplementation(response);
    vi.stubGlobal('fetch', fetch);
    await run();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await progress()).cells[0].status).toBe('complete');
    const files = await cached();
    expect(files).toHaveLength(1);
    const cache = JSON.parse(await readFile(join(cacheDir, files[0]), 'utf8'));
    expect(cache.response).toEqual(overpass);
    expect(cache.metadata.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(cache.metadata.query).toContain('way["highway"]');
    expect(cache.metadata.query).toContain('>>;');
    expect(cache.metadata.query).toContain('[date:"2026-10-14T00:00:00Z"]');
    expect(cache.metadata.halo[0]).toBeLessThan(cache.metadata.bounds[0]);
    expect(cache.metadata.halo[2]).toBeGreaterThan(cache.metadata.bounds[2]);
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    await run();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('records the failed cell without overwriting a good source during refresh', async () => {
    vi.stubGlobal('fetch', response); await run();
    const file = join(cacheDir, (await cached())[0]), before = await readFile(file);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ...overpass, remark: 'timeout at cell source' })));
    vi.stubGlobal('fetch', fetch);
    await expect(run(true)).rejects.toThrow(/timeout at cell source/);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await readFile(file)).toEqual(before);
    expect((await progress()).cells[0]).toMatchObject({ id: 'cell/0_0', status: 'failed', error: expect.stringContaining('timeout') });
    expect((await readdir(cacheDir)).some(file => file.endsWith('.tmp'))).toBe(false);
  });

  it('records the actual cache bytes even when an otherwise valid cache was reformatted', async () => {
    vi.stubGlobal('fetch', response); await run();
    const file = join(cacheDir, (await cached())[0]);
    const text = JSON.stringify(JSON.parse(await readFile(file, 'utf8')), null, 2);
    await writeFile(file, text);
    const fetch = vi.fn(response); vi.stubGlobal('fetch', fetch);
    await run();
    expect(fetch).not.toHaveBeenCalled();
    expect((await progress()).cells[0].resource.bytes).toBe(Buffer.byteLength(text));
  });

  it('resumes completed cells after a later cell fails', async () => {
    shape = boundary(rectangle(0.001, 0.001, 0.039, 0.019));
    await writeFile(join(baseDir, base.dataset, 'boundary.json'), JSON.stringify(shape));
    const fetch = vi.fn().mockResolvedValueOnce(response())
      .mockImplementation(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(run()).rejects.toThrow(/503/);
    expect((await progress()).cells.map((c: { status: string }) => c.status)).toEqual(['complete', 'failed']);
    const retry = vi.fn(response); vi.stubGlobal('fetch', retry);
    await run();
    expect(retry).toHaveBeenCalledTimes(1);
    expect((await progress()).cells.every((c: { status: string }) => c.status === 'complete')).toBe(true);
  });

  it('collects later cells after an exhausted failure but still rejects the incomplete acquisition', async () => {
    shape = boundary(rectangle(0.001, 0.001, 0.059, 0.019));
    await writeFile(join(baseDir, base.dataset, 'boundary.json'), JSON.stringify(shape));
    const unavailable = () => new Response('unavailable', { status: 503 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response())
      .mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable()).mockImplementation(response));
    await expect(fetchMobility({ baseDir, cacheDir, refresh: false, continueOnError: true }))
      .rejects.toThrow(/incomplete.*1.*3/i);
    const cells = (await progress()).cells;
    expect(cells.map((cell: { status: string }) => cell.status)).toEqual(['complete', 'failed', 'complete']);
    expect(cells[1]).toMatchObject({ error: expect.stringContaining('503') });
    expect(cells[1].resource).toBeUndefined();
    expect(await cached()).toEqual(['cell-0_0.json', 'cell-2_0.json']);
  });

  it('resumes only missing cells after an error-isolated pass without rewriting verified successes', async () => {
    shape = boundary(rectangle(0.001, 0.001, 0.059, 0.019));
    await writeFile(join(baseDir, base.dataset, 'boundary.json'), JSON.stringify(shape));
    const unavailable = () => new Response('unavailable', { status: 503 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response())
      .mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable()).mockImplementation(response));
    await expect(fetchMobility({ baseDir, cacheDir, refresh: false, continueOnError: true })).rejects.toThrow();
    const files = await cached(), before = await Promise.all(files.map(file => readFile(join(cacheDir, file))));
    const fetch = vi.fn(response); vi.stubGlobal('fetch', fetch);
    await fetchMobility({ baseDir, cacheDir, refresh: false, continueOnError: true });
    expect((await progress()).cells.map((cell: { status: string }) => cell.status)).toEqual(['complete', 'complete', 'complete']);
    expect(await cached()).toEqual(['cell-0_0.json', 'cell-1_0.json', 'cell-2_0.json']);
    expect(await Promise.all(files.map(file => readFile(join(cacheDir, file))))).toEqual(before);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['base', 'boundary', 'endpoint', 'query', 'hash', 'source'])(
    'does not reuse a cache with changed %s identity', async change => {
      vi.stubGlobal('fetch', response); await run();
      if (change === 'base') {
        await writeFile(join(baseDir, 'manifest.json'), JSON.stringify({ ...base, generatedAt: 'changed' }));
      } else if (change === 'boundary') {
        await writeFile(join(baseDir, base.dataset, 'boundary.json'), JSON.stringify(boundary(rectangle(0.002, 0.001, 0.019, 0.019))));
      } else if (change === 'endpoint') {
        vi.stubEnv('OVERPASS_ENDPOINT', 'https://example.invalid/api/interpreter');
      } else {
        const file = join(cacheDir, (await cached())[0]);
        const cache = JSON.parse(await readFile(file, 'utf8'));
        if (change === 'query') cache.metadata.query = 'different query';
        if (change === 'hash') cache.metadata.sourceHash = '0'.repeat(64);
        if (change === 'source') cache.response.elements.pop();
        await writeFile(file, JSON.stringify(cache));
      }
      const fetch = vi.fn(response); vi.stubGlobal('fetch', fetch);
      await run();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

  it('accepts a complete empty reply, but never a missing snapshot or an error remark', async () => {
    const empty = { ...overpass, elements: [] };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(empty)));
    await run();
    expect((await progress()).cells[0].status).toBe('complete');
    expect(() => validateSource(empty)).toThrow();
    for (const invalid of [{ elements: [] }, { ...empty, remark: 'runtime error' }]) {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify(invalid)));
      await expect(run(true)).rejects.toThrow();
      expect((await progress()).cells[0].status).toBe('failed');
    }
  });

  it.each(['coordinate', 'tags', 'membership'])('rejects conflicting duplicate source %s across cells', async change => {
    shape = boundary(rectangle(0.001, 0.001, 0.039, 0.019));
    await writeFile(join(baseDir, base.dataset, 'boundary.json'), JSON.stringify(shape));
    const changed = structuredClone(overpass);
    if (change === 'coordinate') changed.elements[0].lon = 120.69;
    if (change === 'tags') changed.elements[2].tags!.access = 'no';
    if (change === 'membership') changed.elements[2].nodes = [2, 1];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response())
      .mockImplementation(async () => new Response(JSON.stringify(changed))));
    await expect(run()).rejects.toThrow(/conflicting.*(node\/1|way\/101)/i);
    expect((await progress()).cells[1].status).toBe('failed');
  });

  it('does not reuse an incomplete highway reply as a valid source', () => {
    expect(() => validateSource({ ...overpass, remark: 'runtime error: Query timed out' })).toThrow();
    expect(() => validateSource({ ...overpass, elements: overpass.elements.slice(1) })).toThrow();
  });
});
