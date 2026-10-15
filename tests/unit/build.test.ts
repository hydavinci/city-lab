import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDataset } from '../../pipeline/build';

describe('atomic offline dataset generation', () => {
  it('publishes actual building counts and never replaces a working manifest with a failed import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'suzhou-build-test-'));
    try {
      const rawDir = join(root, 'raw'), outputDir = join(root, 'out');
      await mkdir(rawDir);
      const geom = [
        { lon: 120, lat: 31 }, { lon: 121, lat: 31 }, { lon: 121, lat: 32 },
        { lon: 120, lat: 32 }, { lon: 120, lat: 31 },
      ];
      const response = (elements: unknown[]) => JSON.stringify({
        version: 0.6, osm3s: { timestamp_osm_base: '2026-10-14T00:00:00Z' }, elements,
      });
      await writeFile(join(rawDir, 'boundary.json'), response([{
        type: 'relation', id: 4430941,
        tags: { type: 'multipolygon', boundary: 'administrative', name: '苏州市' },
        members: [{ type: 'way', ref: 1, role: 'outer', geometry: geom }],
      }]));
      await writeFile(join(rawDir, 'buildings.json'), response([{
        type: 'way', id: 2, tags: { building: 'yes', height: '30' },
        nodes: [10, 11, 12, 10],
        geometry: [
          { lon: 120.5, lat: 31.5 }, { lon: 120.501, lat: 31.5 },
          { lon: 120.501, lat: 31.501 }, { lon: 120.5, lat: 31.5 },
        ],
      }]));
      const surface = response([
        { type: 'way', id: 3, tags: { highway: 'primary' }, nodes: [30, 31], geometry: geom.slice(0, 2) },
        { type: 'way', id: 4, tags: { natural: 'water' }, nodes: [40, 41, 42, 43, 40], geometry: geom },
        { type: 'way', id: 5, tags: { landuse: 'forest' }, nodes: [50, 51, 52, 53, 50], geometry: geom },
      ]);
      await writeFile(join(rawDir, 'surface.json'), surface);
      const manifest = await buildDataset({ rawDir, outputDir });
      expect(manifest.counts.buildings).toBe(1);
      expect(manifest.counts.measured).toBe(1);
      expect(manifest.tiles.reduce((n, tile) => n + tile.count, 0)).toBe(1);
      const tile = JSON.parse(await readFile(join(outputDir, manifest.dataset, 'tiles', `${manifest.tiles[0].id}.json`), 'utf8'));
      expect(tile.features[0].properties.id).toBe('way/2');
      const goodManifest = await readFile(join(outputDir, 'manifest.json'), 'utf8');
      await writeFile(join(rawDir, 'surface.json'), response([]));
      await expect(buildDataset({ rawDir, outputDir })).rejects.toThrow('surface');
      expect(await readFile(join(outputDir, 'manifest.json'), 'utf8')).toBe(goodManifest);
      await writeFile(join(rawDir, 'surface.json'), surface);
      await writeFile(join(rawDir, 'buildings.json'), '{"elements":[],"remark":"timeout"}');
      await expect(buildDataset({ rawDir, outputDir })).rejects.toThrow('timeout');
      expect(await readFile(join(outputDir, 'manifest.json'), 'utf8')).toBe(goodManifest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
