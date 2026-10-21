import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EnhancementManifest, XY } from '../../web/core/enhancements';
import { parseMobilityChunk, parseMobilityManifest } from '../../web/core/mobility';
import { buildMobility } from '../../pipeline/mobility/build';
import { fetchMobility } from '../../pipeline/mobility/fetch';
import { compileCell } from '../../pipeline/mobility/compile';
import { publicationFixture } from '../fixtures/enhancements';
import type { Bounds } from '../../web/core/types';

vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename) };
});
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('atomic audited mobility publication', () => {
  let root: string, options: Parameters<typeof buildMobility>[0];
  let data: ReturnType<typeof publicationFixture>, assets: EnhancementManifest, outputManifest: string;
  const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
  const load = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
  const acquire = () => fetchMobility({ ...options, refresh: true });
  beforeEach(async () => {
    root = await mkdtemp(join(process.cwd(), '.mobility-release-test-'));
    options = { baseDir: join(root, 'data'), cacheDir: join(root, 'raw'), outputDir: join(root, 'mobility') };
    outputManifest = join(options.outputDir, 'manifest.json');
    data = publicationFixture();
    // Shift this synthetic fixture wholly inside one acquisition cell; not real-world coverage.
    const shift = (p: number[]): XY => [p[0] + 0.01, p[1] + 0.01];
    for (const e of data.source.elements.filter(e => e.type === 'node')) { e.lon += 0.01; e.lat += 0.01; }
    data.base.bounds = [0.006, 0.006, 0.014, 0.014];
    data.base.tiles[0].bounds = [...data.base.bounds];
    for (const layer of [data.buildings, data.surface]) for (const feature of layer.features) {
      feature.geometry.coordinates = feature.geometry.coordinates.map(ring => ring.map(shift));
    }
    const id = '1'.repeat(32), assetDir = join(root, 'enhancements', id);
    await Promise.all([
      mkdir(join(options.baseDir, data.base.dataset, 'tiles'), { recursive: true }),
      mkdir(assetDir, { recursive: true }),
    ]);
    const network = compileCell({ id: 'synthetic-assets', bounds: data.base.bounds as Bounds, source: data.source,
      baseDataset: data.base.dataset, buildings: [], water: [], placements: [] }).chunk!.network;
    assets = { version: 1, id, baseDataset: data.base.dataset, bounds: data.base.bounds as Bounds,
      generatedAt: '2026-10-15T00:00:00Z',
      network: `${id}/network.json`, roads: `${id}/roads.json`, provenance: `${id}/provenance.json`,
      placements: `${id}/placements.json`, showcase: { target: [0.01, 0.01], heading: 0, pitch: -45, range: 300 },
      assets: data.assets.map(asset => ({ ...asset, uri: `${id}/${asset.uri}` })) as EnhancementManifest['assets'] };
    await Promise.all([
      json(join(options.baseDir, 'manifest.json'), data.base),
      json(join(options.baseDir, data.base.dataset, 'boundary.json'), { type: 'FeatureCollection', features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[
          [0.006, 0.006], [0.014, 0.006], [0.014, 0.014], [0.006, 0.014], [0.006, 0.006],
        ]] } },
      ] }),
      json(join(options.baseDir, data.base.dataset, 'tiles', 'fixture.json'), data.buildings),
      json(join(options.baseDir, data.base.dataset, 'surface.json'), data.surface),
      json(join(root, 'enhancements', 'manifest.json'), assets),
      json(join(root, 'enhancements', assets.network), network),
      json(join(root, 'enhancements', assets.placements), data.placements),
      ...assets.assets.map(asset => writeFile(join(root, 'enhancements', asset.uri), asset.animation ? data.personGlb : data.glb)),
    ]);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(data.source)));
    await acquire();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.mocked(rename).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename);
    await rm(root, { recursive: true, force: true });
  });

  it('publishes real compiler output and verifies every immutable resource and source cell', async () => {
    const progress: number[][] = [];
    const manifest = await buildMobility({ ...options, onProgress: (done, total) => progress.push([done, total]) });
    expect(parseMobilityManifest(manifest, data.base.dataset)).toEqual(manifest);
    expect(manifest.coverage).toMatchObject({ cells: 1, ready: 1, failed: 0 });
    expect(manifest.coverage.driveMetres).toBeGreaterThan(0);
    expect(manifest.coverage.walkMetres).toBeGreaterThan(0);
    expect(progress.at(-1)).toEqual([1, 1]);
    const assetBytes = await readFile(join(root, manifest.assets.uri));
    expect(assetBytes.length).toBe(manifest.assets.bytes);
    expect(hash(assetBytes)).toBe(manifest.assets.sha256);
    for (const cell of manifest.cells.filter(cell => cell.status === 'ready')) {
      const bytes = await readFile(join(root, cell.resource!.uri));
      expect(bytes.length).toBe(cell.resource!.bytes);
      expect(hash(bytes)).toBe(cell.resource!.sha256);
      const chunk = parseMobilityChunk(JSON.parse(bytes.toString()), cell);
      expect(chunk.ownedEdges.length).toBeGreaterThan(0);
      expect(chunk.surfaces.length).toBeGreaterThan(0);
    }
    const report = await load(join(options.outputDir, manifest.id, 'coverage.json'));
    expect(report.coverage).toEqual(manifest.coverage);
    expect(report.cells[0]).toMatchObject({ id: manifest.cells[0].id, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(report.cells[0].diagnostics.length).toBeGreaterThan(0);
    expect(report.assumptions.lengthBasis).toContain('directed');
    expect(report.generatorHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.sourceLengths.driveMetres).toBeCloseTo(1200, 1);
    expect(report.sourceLengths.walkMetres).toBeCloseTo(600, 1);
    expect(report.sourceLengths.byHighway.residential.ways).toBe(2);
  });

  it('reuses valid compiled cells and immutable bytes without including generation time in the content ID', async () => {
    const first = await buildMobility(options);
    const file = join(options.cacheDir, 'compiled', (await readdir(join(options.cacheDir, 'compiled')))[0]);
    const before = await stat(file), bytes = await readFile(join(root, first.cells[0].resource!.uri));
    const second = await buildMobility(options);
    expect(second.id).toBe(first.id);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(join(root, first.cells[0].resource!.uri))).toEqual(bytes);
    expect((await readdir(options.outputDir)).sort()).toEqual([first.id, 'manifest.json'].sort());
  });

  it.each(['missing-cell', 'failed-cell', 'tampered-source', 'stale-base'])(
    'keeps the previous manifest and resources after %s failure', async failure => {
      const first = await buildMobility(options), before = await readFile(outputManifest);
      const resource = await readFile(join(root, first.cells[0].resource!.uri));
      const inventoryPath = join(options.cacheDir, 'progress.json'), inventory = await load(inventoryPath);
      if (failure === 'missing-cell') await rm(join(options.cacheDir, inventory.cells[0].resource.path));
      if (failure === 'failed-cell') {
        inventory.cells[0].status = 'failed'; inventory.cells[0].error = 'test source outage';
        await json(inventoryPath, inventory);
      }
      if (failure === 'tampered-source') {
        const path = join(options.cacheDir, inventory.cells[0].resource.path), source = await load(path);
        source.response.elements.pop(); await json(path, source);
      }
      if (failure === 'stale-base') await json(join(options.baseDir, 'manifest.json'), { ...data.base, generatedAt: 'changed' });
      await expect(buildMobility(options)).rejects.toThrow();
      expect(await readFile(outputManifest)).toEqual(before);
      expect(await readFile(join(root, first.cells[0].resource!.uri))).toEqual(resource);
    });

  it('rebuilds a corrupt intermediate cell record instead of publishing its unvalidated network', async () => {
    const first = await buildMobility(options);
    const path = join(options.cacheDir, 'compiled', (await readdir(join(options.cacheDir, 'compiled')))[0]);
    await writeFile(path, '{"corrupted":true}');
    expect((await buildMobility(options)).id).toBe(first.id);
    expect((await load(path)).result.status).toBe('ready');
  });

  it('invalidates the affected compiled record when source inputs change and retains old immutable bytes', async () => {
    const first = await buildMobility(options), before = await readFile(join(root, first.cells[0].resource!.uri));
    for (const way of data.source.elements.filter(e => e.type === 'way')) way.tags.maxspeed = '5';
    await acquire();
    const second = await buildMobility(options);
    expect(second.id).not.toBe(first.id);
    expect(await readFile(join(root, first.cells[0].resource!.uri))).toEqual(before);
  });

  it('publishes explicit empty and excluded inventory entries, never successful failed downloads', async () => {
    const original = structuredClone(data.source);
    data.source.elements = []; await acquire();
    const empty = await buildMobility(options);
    expect(empty.cells[0].status).toBe('empty');
    expect(empty.cells[0].resource).toBeUndefined();
    expect(empty.coverage).toMatchObject({ cells: 1, ready: 0, empty: 1, failed: 0, driveMetres: 0, walkMetres: 0 });
    data.source = original;
    for (const way of data.source.elements.filter(e => e.type === 'way')) way.tags.access = 'no';
    await acquire();
    const excluded = await buildMobility(options);
    expect(excluded.coverage).toMatchObject({ ready: 0, excluded: 1, failed: 0 });
    expect(excluded.cells[0].diagnosticCodes).toContain('EXCLUDED_WAY');
  });

  it('does not silently ignore a line-only water source of unknown width', async () => {
    const surface = { ...data.surface, features: [...data.surface.features, {
      type: 'Feature', id: 'way/999', properties: { id: 'way/999', layer: 'water' },
      geometry: { type: 'LineString', coordinates: [[0.009, 0.009], [0.011, 0.011]] },
    }] };
    await json(join(options.baseDir, data.base.dataset, 'surface.json'), surface);
    const result = await buildMobility(options);
    expect(result.cells[0].status).toBe('excluded');
    expect(result.cells[0].diagnosticCodes).toContain('UNBOUNDED_WATER_LINE');
  });

  it('does not double-count a source centreline shared by two acquisition-cell boundaries', async () => {
    for (const node of data.source.elements.filter(e => e.type === 'node')) node.lat += 0.01;
    data.base.bounds = [0.006, 0.016, 0.014, 0.024];
    data.base.tiles[0].bounds = [...data.base.bounds];
    await json(join(options.baseDir, 'manifest.json'), data.base);
    await json(join(options.baseDir, data.base.dataset, 'boundary.json'), { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[
        [0.006, 0.016], [0.014, 0.016], [0.014, 0.024], [0.006, 0.024], [0.006, 0.016],
      ]] } },
    ] });
    await acquire();
    const manifest = await buildMobility(options), report = await load(join(options.outputDir, manifest.id, 'coverage.json'));
    expect(manifest.coverage.cells).toBe(2);
    expect(report.sourceLengths.driveMetres).toBeCloseTo(1200, 1);
    expect(report.sourceLengths.walkMetres).toBeCloseTo(600, 1);
  });

  it('validates small geographic water polygons in metres rather than applying metre tolerances to degrees', async () => {
    const features = [...data.surface.features, {
      type: 'Feature', id: 'way/777', properties: { id: 'way/777', layer: 'water' },
      geometry: { type: 'Polygon', coordinates: [[
        [0.013, 0.013], [0.013002, 0.013], [0.013002, 0.013002], [0.013, 0.013002], [0.013, 0.013],
      ]] },
    }];
    await json(join(options.baseDir, data.base.dataset, 'surface.json'), { type: 'FeatureCollection', features });
    expect((await buildMobility(options)).cells[0].status).toBe('ready');
  });

  it('snapshots the exact enhancement manifest bytes without changing the existing immutable asset package', async () => {
    const manifestPath = join(root, 'enhancements', 'manifest.json'), bytes = Buffer.from(JSON.stringify(assets, null, 2));
    await writeFile(manifestPath, bytes);
    const before = await readdir(join(root, 'enhancements', assets.id));
    const manifest = await buildMobility(options);
    expect(await readFile(join(root, manifest.assets.uri))).toEqual(bytes);
    expect(await readdir(join(root, 'enhancements', assets.id))).toEqual(before);
    expect(manifest.report).toMatchObject({ uri: `mobility/${manifest.id}/coverage.json`, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('does not publish altered assets or overwrite an existing immutable collision', async () => {
    const first = await buildMobility(options), before = await readFile(outputManifest);
    const assetPath = join(root, 'enhancements', assets.assets[0].uri), asset = await readFile(assetPath);
    await writeFile(assetPath, 'invalid GLB');
    await expect(buildMobility(options)).rejects.toThrow();
    expect(await readFile(outputManifest)).toEqual(before);
    await writeFile(assetPath, asset);
    await writeFile(join(root, first.cells[0].resource!.uri), '{"different":"immutable bytes"}');
    await expect(buildMobility(options)).rejects.toThrow(/immutable|collision/i);
    expect(await readFile(outputManifest)).toEqual(before);
  });

  it('retains the active manifest after an interrupted atomic pointer replacement and cleans only its staging files', async () => {
    await buildMobility(options);
    const before = await readFile(outputManifest);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to) === outputManifest) throw new Error('simulated pointer write interruption');
      return actual.rename(from, to);
    });
    await expect(buildMobility(options)).rejects.toThrow(/interruption/);
    expect(await readFile(outputManifest)).toEqual(before);
    expect((await readdir(options.outputDir)).some(path => path.endsWith('.tmp') || path.startsWith('.staging-'))).toBe(false);
  });
});
