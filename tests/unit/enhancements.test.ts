import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnhancementManifest, parseNetwork } from '../../web/core/enhancements';
import { fetchDistrict } from '../../pipeline/enhancements/fetch';
import { manifest, network, overpass } from '../fixtures/enhancements';

vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }));

it('rejects malformed data rather than producing an empty successful layer', () => {
  expect(() => parseNetwork({ edges: [] })).toThrow();
  expect(() => parseEnhancementManifest({ version: 99, baseDataset: manifest.baseDataset }, manifest.baseDataset)).toThrow();
});

it('round-trips valid manifest and metre network including polygon holes', () => {
  expect(parseEnhancementManifest(JSON.parse(JSON.stringify(manifest)), manifest.baseDataset)).toEqual(manifest);
  expect(parseNetwork(JSON.parse(JSON.stringify(network)))).toEqual(network);
});

const manifestMutations: [string, (m: any) => void][] = [
  ['version', m => { m.version = 2; }],
  ['dataset mismatch', m => { m.baseDataset = 'ffffffffffffffff'; }],
  ['missing dataset', m => { delete m.baseDataset; }],
  ['empty ID', m => { m.id = ''; }],
  ['whitespace ID', m => { m.id = ' bad id '; }],
  ['invalid timestamp', m => { m.generatedAt = 'yesterday'; }],
  ['impossible timestamp date', m => { m.generatedAt = '2026-02-31T00:00:00Z'; }],
  ['reversed bounds', m => { m.bounds = [121, 32, 120, 31]; }],
  ['longitude', m => { m.bounds[0] = -181; }],
  ['latitude', m => { m.bounds[3] = 91; }],
  ['bounds arity', m => { m.bounds.push(0); }],
  ['NaN coordinate', m => { m.showcase.target[0] = NaN; }],
  ['showcase latitude', m => { m.showcase.target[1] = 91; }],
  ['showcase heading', m => { m.showcase.heading = Infinity; }],
  ['showcase pitch', m => { m.showcase.pitch = '0'; }],
  ['showcase range', m => { m.showcase.range = 0; }],
  ['asset kind', m => { m.assets[0].kind = 'truck'; }],
  ['duplicate asset kind', m => { m.assets.push(m.assets[0]); }],
  ['hash', m => { m.assets[0].sha256 = 'not-a-hash'; }],
  ['byte count', m => { m.assets[0].bytes = 1.5; }],
  ['zero bytes', m => { m.assets[0].bytes = 0; }],
  ['negative size', m => { m.assets[0].size[0] = -1; }],
  ['zero size', m => { m.assets[0].size[1] = 0; }],
  ['size arity', m => { m.assets[0].size = [1, 2]; }],
  ['nonfinite size', m => { m.assets[0].size[2] = Infinity; }],
  ['animation type', m => { m.assets[0].animation = 4; }],
];
it.each(manifestMutations)('rejects manifest %s', (_, mutate) => {
  const value = structuredClone(manifest); mutate(value);
  expect(() => parseEnhancementManifest(value, manifest.baseDataset)).toThrow();
});

it.each(['https://example.com/a', '//example.com/a', '/a', '../a', 'a/../b', 'a/%2e%2e/b',
  'a/%252e%252e/b', 'a\\b', 'a?x=1', 'a#x', 'data:x', '', './a', 'a//b', 'a/%2f/b'])(
  'rejects unsafe package path %s in every resource field', path => {
    for (const field of ['network', 'roads', 'provenance', 'placements']) {
      expect(() => parseEnhancementManifest({ ...manifest, [field]: path }, manifest.baseDataset)).toThrow();
    }
    const value = structuredClone(manifest); value.assets[0].uri = path;
    expect(() => parseEnhancementManifest(value, manifest.baseDataset)).toThrow();
  });

const networkMutations: [string, (n: any) => void][] = [
  ['missing field', n => { delete n.water; }],
  ['invalid origin', n => { n.origin = [181, 0]; }],
  ['nonfinite bounds', n => { n.bounds[0] = Infinity; }],
  ['empty edges', n => { n.edges = []; }],
  ['empty routes', n => { n.routes = []; }],
  ['duplicate edge ID', n => { n.edges[1].id = 'a'; }],
  ['whitespace edge ID', n => { n.edges[0].id = ' bad id '; }],
  ['empty source IDs', n => { n.edges[0].sourceIds = []; }],
  ['invalid source ID', n => { n.edges[0].sourceIds = ['']; }],
  ['whitespace source ID', n => { n.edges[0].sourceIds = ['way/ 101']; }],
  ['empty endpoint', n => { n.edges[0].from = ''; }],
  ['whitespace endpoint', n => { n.edges[0].from = 'bad node'; }],
  ['mode', n => { n.edges[0].mode = 'fly'; }],
  ['zero length', n => { n.edges[0].length = 0; }],
  ['negative width', n => { n.edges[0].width = -1; }],
  ['zero speed', n => { n.edges[0].speed = 0; }],
  ['nonfinite speed', n => { n.edges[0].speed = Infinity; }],
  ['nonfinite point', n => { n.edges[0].points[0][0] = NaN; }],
  ['point arity', n => { n.edges[0].points[0] = [0, 0, 0]; }],
  ['short line', n => { n.edges[0].points = [[0, 0]]; }],
  ['zero segment', n => { n.edges[0].points = [[0, 0], [0, 0]]; }],
  ['length mismatch', n => { n.edges[0].length = 1; }],
  ['empty allowed actors', n => { n.edges[0].allowed = []; }],
  ['wrong actor mode', n => { n.edges[0].allowed = ['person-a']; }],
  ['unknown actor', n => { n.edges[0].allowed = ['truck']; }],
  ['dangling successor', n => { n.edges[0].next = ['missing']; }],
  ['mode transition', n => { n.edges[0].next = ['w']; }],
  ['disconnected successor', n => { n.edges[1].from = 'other'; }],
  ['inconsistent shared node geometry', n => { n.edges[1].points = [[41, 0], [81, 0]]; }],
  ['empty corridor', n => { n.edges[0].corridor = []; }],
  ['invalid inferred labels', n => { n.edges[0].inferred = [1]; }],
  ['dangling conflict zone', n => { n.edges[0].conflicts[0].zone = 'missing'; }],
  ['negative conflict interval', n => { n.edges[0].conflicts[0].enter = -1; }],
  ['reversed conflict interval', n => { n.edges[0].conflicts[0].exit = 34; }],
  ['conflict beyond edge', n => { n.edges[0].conflicts[0].exit = 41; }],
  ['duplicate zone ID', n => { n.zones.push(n.zones[0]); }],
  ['dangling zone edge', n => { n.zones[0].edges.push('missing'); }],
  ['inconsistent zone membership', n => { n.zones[0].edges = ['w']; }],
  ['missing conflict membership', n => { n.edges[0].conflicts = []; }],
  ['duplicate route ID', n => { n.routes[1].id = 'drive'; }],
  ['empty route', n => { n.routes[0].edges = []; }],
  ['dangling route edge', n => { n.routes[0].edges = ['missing']; }],
  ['mixed route modes', n => { n.routes[0].edges.push('w'); }],
  ['route lacking next link', n => { n.edges[0].next = []; }],
  ['route entry mismatch', n => { n.routes[0].entry = 'b'; }],
  ['route exit mismatch', n => { n.routes[0].exit = 'a'; }],
  ['route actor unsupported by edge', n => { n.routes[0].allowed = ['bus']; }],
];
it.each(networkMutations)('rejects network %s', (_, mutate) => {
  const value = structuredClone(network); mutate(value);
  expect(() => parseNetwork(value)).toThrow();
});

it.each([
  [], [[]], [[[0, 0], [1, 0], [0, 0]]],
  [[[0, 0], [1, 0], [1, 1], [0, 1]]],
  [[[0, 0], [1, 0], [2, 0], [0, 0]]],
  [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]],
  [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]], [[4, 4], [5, 4], [5, 5], [4, 4]]],
  [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]], [[0, 1], [1, 1], [1, 2], [0, 1]]],
  [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
    [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]], [[2, 2], [2.5, 2], [2.5, 2.5], [2, 2]]],
].map(polygon => ({ polygon })))('rejects invalid polygons in all polygon-bearing fields (%j)', ({ polygon }) => {
  for (const field of ['buildings', 'water', 'corridor', 'zone']) {
    const value: any = structuredClone(network);
    if (field === 'corridor') value.edges[0].corridor = [polygon];
    else if (field === 'zone') value.zones[0].polygon = polygon;
    else value[field as 'buildings' | 'water'] = [polygon];
    expect(() => parseNetwork(value)).toThrow();
  }
});

describe('explicit district preparation cache', () => {
  let cacheDir: string;
  const bounds: [number, number, number, number] = [120.671, 31.308, 120.691, 31.330];
  const response = () => new Response(JSON.stringify(overpass));
  beforeEach(async () => { cacheDir = await mkdtemp(join(tmpdir(), 'district-test-')); });
  afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(cacheDir, { recursive: true, force: true }); });
  const prepare = (refresh = false) => fetchDistrict({ bounds, cacheDir, refresh });

  it('writes complete source and metadata, reuses valid cache without network, and refreshes explicitly', async () => {
    vi.stubEnv('OVERPASS_ENDPOINT', 'https://example.org/api/interpreter');
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      expect(String(init.body)).toContain('highway');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return response();
    }));
    await prepare();
    const cached = JSON.parse(await readFile(join(cacheDir, 'district.json'), 'utf8'));
    expect(cached.response).toEqual(overpass);
    expect(cached.metadata).toMatchObject({
      bounds, endpoint: 'example.org', osmSnapshot: '2026-10-14T00:00:00Z',
    });
    expect(cached.metadata.query).toContain('(._;>>;);out body;');
    expect(Number.isFinite(Date.parse(cached.metadata.fetchedAt))).toBe(true);
    vi.stubGlobal('fetch', () => { throw new Error('unexpected network'); });
    await prepare();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ...overpass, generator: 'refreshed' })));
    await prepare(true);
    expect(JSON.parse(await readFile(join(cacheDir, 'district.json'), 'utf8')).response.generator).toBe('refreshed');
  });

  it.each([
    ['HTTP 503', () => new Response('unavailable', { status: 503 })],
    ['remark', () => new Response(JSON.stringify({ ...overpass, remark: 'runtime error: timeout' }))],
    ['truncated way', () => new Response(JSON.stringify({ ...overpass, elements: overpass.elements.slice(1) }))],
    ['truncated relation', () => new Response(JSON.stringify({ ...overpass,
      elements: [...overpass.elements, { type: 'relation', id: 202, members: [{ type: 'way', ref: 999, role: 'via' }] }] }))],
    ['empty response', () => new Response('{"elements":[]}')],
    ['malformed JSON', () => new Response('{')],
    ['no snapshot', () => new Response(JSON.stringify({ elements: overpass.elements }))],
    ['invalid coordinate', () => new Response(JSON.stringify({ ...overpass,
      elements: [{ type: 'node', id: 99, lat: 91, lon: 120 }, ...overpass.elements] }))],
    ['timeout', () => { throw new DOMException('Timed out', 'TimeoutError'); }],
  ])('retains valid cache bytes after failed %s refresh and stops after bounded retries', async (_, failure) => {
    vi.stubGlobal('fetch', response); await prepare();
    const before = await readFile(join(cacheDir, 'district.json'));
    const fetch = vi.fn(failure); vi.stubGlobal('fetch', fetch);
    await expect(prepare(true)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await readFile(join(cacheDir, 'district.json'))).toEqual(before);
    expect(await readdir(cacheDir)).toEqual(['district.json']);
  });

  it('does not reuse a cache for a different bbox', async () => {
    vi.stubGlobal('fetch', response); await prepare();
    vi.stubGlobal('fetch', async () => new Response('unavailable', { status: 503 }));
    await expect(fetchDistrict({ bounds: [120.67, 31.31, 120.68, 31.32], cacheDir, refresh: false })).rejects.toThrow();
  });

  it('replaces corrupt cache only with a complete valid response', async () => {
    await writeFile(join(cacheDir, 'district.json'), '{"broken":true}');
    vi.stubGlobal('fetch', response); await prepare();
    expect(JSON.parse(await readFile(join(cacheDir, 'district.json'), 'utf8')).response).toEqual(overpass);
  });

  it('rejects unbounded or invalid bbox before network', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('network must not run'); });
    for (const box of [[-180, -90, 180, 90], [121, 32, 120, 31], [NaN, 31, 121, 32]]) {
      await expect(fetchDistrict({ bounds: box as typeof bounds, cacheDir, refresh: false })).rejects.toThrow(/bounds/i);
    }
  });
});
