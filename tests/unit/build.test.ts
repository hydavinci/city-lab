import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDataset } from '../../pipeline/build';

describe('atomic offline dataset generation', () => {
  it('publishes actual building counts and never replaces a working manifest with a failed import', async () => {
    const root = join('artifacts', `build-test-${randomUUID()}`);
    await mkdir(root, { recursive: true });
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
        { type: 'way', id: 3, tags: { highway: 'primary', width: '8.5 m', lanes: '2', access: 'private', layer: '1', bridge: 'yes', tunnel: 'no', oneway: 'yes' }, nodes: [30, 31], geometry: geom.slice(0, 2) },
        { type: 'way', id: 6, tags: { highway: 'secondary', width: 'unknown', lanes: '2' }, nodes: [60, 61], geometry: geom.slice(0, 2) },
        { type: 'way', id: 7, tags: { highway: 'service', width: '-1', lanes: '0' }, nodes: [70, 71], geometry: geom.slice(0, 2) },
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
      const output = JSON.parse(await readFile(join(outputDir, manifest.dataset, 'surface.json'), 'utf8'));
      const roads = output.features.filter((f: {properties:{layer:string}})=>f.properties.layer==='roads');
      expect(roads.find((f: {id:string})=>f.id==='way/3').properties).toMatchObject({
        layer: 'roads', kind: 'primary', name: '', widthMetres: 8.5, widthBasis: 'source:width',
        sourceTags: { width: '8.5 m', lanes: '2', access: 'private', layer: '1', bridge: 'yes', tunnel: 'no', oneway: 'yes' },
      });
      expect(roads.find((f: {id:string})=>f.id==='way/6').properties).toMatchObject({widthMetres:6.4,widthBasis:'inferred:lanes*3.2m'});
      expect(roads.find((f: {id:string})=>f.id==='way/7').properties).toMatchObject({widthMetres:4,widthBasis:'inferred:highway:service'});
      const oldHash = createHash('sha256').update('schema-v1-height-v1-buildings-v2-surface-v1');
      for (const name of ['boundary','surface','buildings']) oldHash.update(await readFile(join(rawDir,`${name}.json`)));
      expect(manifest.dataset).not.toBe(oldHash.digest('hex').slice(0,16));
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
