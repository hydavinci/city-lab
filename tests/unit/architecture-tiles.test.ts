import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Cartesian3, Matrix4 } from 'cesium';
import { partitionArchitecture, createTileset, type ArchitectureTile } from '../../pipeline/architecture/tiles';
import { buildCityArchitecture } from '../../pipeline/architecture/build';
import { buildBatch } from '../../pipeline/architecture/mesh';
import type { BuildingFeature, CityManifest } from '../../web/core/types';
import { parseCityArchitectureManifest } from '../../web/core/architecture-manifest';
import { emitArchitecture } from '../../web/core/building-architecture';
import { ArchitecturalMesh } from '../../web/core/architectural-mesh';
import { architectureSupplements } from '../../web/core/jinji-landmarks';

function building(index: number): BuildingFeature {
  const x = 120.62 + index % 25 * 0.0004, y = 31.32 + Math.floor(index / 25) * 0.0003;
  return { type: 'Feature', properties: { id: `way/${index}`, name: '', kind: 'yes', height: 8, basis: 'fallback', estimated: true },
    geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 0.0002, y], [x + 0.0002, y + 0.0001], [x, y + 0.0001], [x, y]]] } };
}

function contentNodes(node: ArchitectureTile): ArchitectureTile[] {
  return [...(node.lod ? [node] : []), ...node.children.flatMap(contentNodes)];
}

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('persistent architecture tiles', () => {
  it('bounds generic reference towers at every level and publishes their count without altering OSM', async () => {
    const tile = JSON.parse(await readFile('public/data/c8a953228b2ff6af/tiles/4828_1253.json', 'utf8')) as {
      features: BuildingFeature[];
    };
    const features = [tile.features.find(feature => feature.properties.id === 'way/802754584')!];
    const text = JSON.stringify({ type: 'FeatureCollection', features });
    const root = await mkdtemp(join(tmpdir(), 'reference-height-'));
    temporary.push(root);
    const inputDir = join(root, 'input'), outputDir = join(root, 'output');
    await mkdir(join(inputDir, 'source', 'tiles'), { recursive: true });
    await writeFile(join(inputDir, 'manifest.json'), JSON.stringify({
      version: 1, dataset: 'source', counts: { buildings: 1 }, tiles: [{ id: 'tower', count: 1 }],
    }));
    const sourcePath = join(inputDir, 'source', 'tiles', 'tower.json');
    await writeFile(sourcePath, text);
    const result = await buildCityArchitecture({ inputDir, outputDir });
    expect(result.heightReferences).toEqual({ provider: 'verified-building-heights-v1', buildings: 1 });
    expect(parseCityArchitectureManifest(result, 'source', 1)).toEqual(result);
    for (const value of [0, 2, 1.5]) {
      expect(() => parseCityArchitectureManifest({
        ...result, heightReferences: { ...result.heightReferences, buildings: value },
      }, 'source', 1)).toThrow(/height reference/i);
    }
    const tileset = JSON.parse(await readFile(join(outputDir, result.tileset), 'utf8')) as {
      root: { boundingVolume: { region: number[] }; children?: typeof tileset.root[] };
    };
    const visit = (node: typeof tileset.root) => {
      expect(node.boundingVolume.region[5]).toBeGreaterThan(303.66);
      node.children?.forEach(visit);
    };
    visit(tileset.root);
    expect(await readFile(sourcePath, 'utf8')).toBe(text);
  });

  it('publishes a separate attraction with source accounting and refuses duplicate source identities', async () => {
    const sourceDataset = 'c8a953228b2ff6af';
    const tile = JSON.parse(await readFile(`public/data/${sourceDataset}/tiles/4826_1252.json`, 'utf8')) as {
      features: BuildingFeature[];
    };
    const features = [building(0), tile.features.find(feature => feature.properties.id === 'relation/16109091')!];
    const sourceText = JSON.stringify({ type: 'FeatureCollection', features });
    const root = await mkdtemp(join(tmpdir(), 'jinji-publication-'));
    temporary.push(root);
    const inputDir = join(root, 'input'), outputDir = join(root, 'output');
    await mkdir(join(inputDir, sourceDataset, 'tiles'), { recursive: true });
    const manifest = { version: 1, dataset: sourceDataset, counts: { buildings: 2 }, tiles: [{ id: 'a', count: 2 }] };
    const sourcePath = join(inputDir, sourceDataset, 'tiles', 'a.json');
    await writeFile(join(inputDir, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(sourcePath, sourceText);
    const result = await buildCityArchitecture({ inputDir, outputDir });
    expect(result).toMatchObject({
      sourceBuildings: 2, buildings: 2,
      additions: [{ id: 'way/1332906658', kind: 'attraction', evidence: expect.stringContaining('not an OSM height tag') }],
      exclusions: [{ id: 'relation/16109091', reason: 'underground' }],
    });
    expect(parseCityArchitectureManifest(result, sourceDataset, 2)).toEqual(result);
    Object.values(result.lods).forEach(lod => expect(lod.buildings).toBe(2));
    expect(await readFile(sourcePath, 'utf8')).toBe(sourceText);
    const published = await readFile(join(outputDir, 'manifest.json'), 'utf8');
    const duplicate = [...features, ...architectureSupplements(sourceDataset).features];
    await writeFile(sourcePath, JSON.stringify({ type: 'FeatureCollection', features: duplicate }));
    await writeFile(join(inputDir, 'manifest.json'), JSON.stringify({
      ...manifest, counts: { buildings: 3 }, tiles: [{ id: 'a', count: 3 }],
    }));
    await expect(buildCityArchitecture({ inputDir, outputDir })).rejects.toThrow(/Duplicate building ID/);
    expect(await readFile(join(outputDir, 'manifest.json'), 'utf8')).toBe(published);
  });

  it('accounts for the underground station without repartitioning unrelated batches and bounds all modeled geometry', async () => {
    const features: BuildingFeature[] = [];
    const ids = new Set(['way/933819302', 'way/480395603', 'way/477238586',
      'way/206076447', 'way/206069300', 'way/608471429', 'relation/16109091']);
    for (const id of ['4826_1252', '4828_1252', '4824_1252', '4823_1253', '4824_1251']) {
      const tile = JSON.parse(await readFile(`public/data/c8a953228b2ff6af/tiles/${id}.json`, 'utf8')) as { features: BuildingFeature[] };
      features.push(...tile.features.filter(feature => ids.has(feature.properties.id)));
    }
    expect(features).toHaveLength(7);
    const before = structuredClone(features);
    const sourceTree = partitionArchitecture(features.map(feature => feature.properties.id === 'relation/16109091'
      ? { ...feature, properties: { ...feature.properties, id: 'relation/16109090' } } : feature));
    const tree = partitionArchitecture(features), nodes = contentNodes(tree);
    for (const original of contentNodes(sourceTree).filter(node => node.features.every(f => f.properties.id !== 'relation/16109090'))) {
      expect(nodes.find(node => node.id === original.id)?.features).toEqual(original.features);
    }
    for (const lod of ['far', 'mid', 'near']) {
      expect(nodes.filter(node => node.lod === lod).flatMap(node => node.features)).toHaveLength(6);
    }
    const tileset = await createTileset(tree, async node => ({ ...(await buildBatch(node.features, node.lod!)), uri: node.id }));
    const visit = (document: typeof tileset.root) => {
      if (document.content) {
        const node = nodes.find(node => node.id === document.content!.uri)!;
        const [west, south, east, north, low, high] = document.boundingVolume.region;
        for (const feature of node.features) {
          const mesh = new ArchitecturalMesh(), { origin } = emitArchitecture(mesh, feature, node.lod!);
          const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
          for (const surface of mesh.getSurfaces().values()) for (let i = 0; i < surface.positions.length; i += 3) {
            const [x, y, z] = surface.positions.slice(i, i + 3);
            const lng = origin[0] * Math.PI / 180 + x / (6378137 * Math.cos(origin[1] * Math.PI / 180));
            const lat = origin[1] * Math.PI / 180 + y / 6378137;
            [lng, lat, z].forEach((value, axis) => {
              min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
            });
          }
          expect(min[0]).toBeGreaterThanOrEqual(west); expect(max[0]).toBeLessThanOrEqual(east);
          expect(min[1]).toBeGreaterThanOrEqual(south); expect(max[1]).toBeLessThanOrEqual(north);
          expect(min[2]).toBeGreaterThanOrEqual(low); expect(max[2]).toBeLessThanOrEqual(high);
        }
      }
      document.children?.forEach(visit);
    };
    visit(tileset.root);
    const root = await mkdtemp(join(tmpdir(), 'landmark-publication-'));
    temporary.push(root);
    const inputDir = join(root, 'input'), outputDir = join(root, 'output');
    await mkdir(join(inputDir, 'landmark-source', 'tiles'), { recursive: true });
    await writeFile(join(inputDir, 'manifest.json'), JSON.stringify({
      version: 1, dataset: 'landmark-source', counts: { buildings: 7 }, tiles: [{ id: 'landmarks', count: 7 }],
    }));
    await writeFile(join(inputDir, 'landmark-source', 'tiles', 'landmarks.json'), JSON.stringify({ type: 'FeatureCollection', features }));
    const result = await buildCityArchitecture({ inputDir, outputDir });
    expect(result).toMatchObject({
      buildings: 6, sourceBuildings: 7,
      exclusions: [{ id: 'relation/16109091', reason: 'underground', evidence: expect.stringContaining('layer=-1') }],
    });
    expect(parseCityArchitectureManifest(result, 'landmark-source', 7)).toEqual(result);
    for (const lod of Object.values(result.lods)) expect(lod.buildings).toBe(6);
    for (const invalid of [
      { ...result, sourceBuildings: 8 }, { ...result, exclusions: [] },
      { ...result, exclusions: [result.exclusions![0], result.exclusions![0]], sourceBuildings: 8 },
      { ...result, exclusions: [{ ...result.exclusions![0], reason: 'unknown' }] },
    ]) expect(() => parseCityArchitectureManifest(invalid, 'landmark-source', 7)).toThrow();
    expect(features).toEqual(before);
  });

  it('partitions deterministically with complete, non-overlapping coverage at every LOD', () => {
    const features = Array.from({ length: 601 }, (_, i) => building(i));
    const before = structuredClone(features), tree = partitionArchitecture(features);
    expect(partitionArchitecture([...features].reverse())).toEqual(tree);
    expect(features).toEqual(before);
    const nodes = contentNodes(tree);
    for (const lod of ['far', 'mid', 'near']) {
      const ids = nodes.filter(node => node.lod === lod).flatMap(node => node.features.map(f => f.properties.id));
      expect(new Set(ids).size).toBe(features.length);
      expect(ids.sort()).toEqual(features.map(f => f.properties.id).sort());
    }
    for (const node of nodes) {
      expect(node.features.length).toBeLessThanOrEqual(node.lod === 'far' ? 256 : node.lod === 'mid' ? 64 : 16);
      if (node.children.length) expect(node.children.flatMap(child => child.features.map(f => f.properties.id)).sort())
        .toEqual(node.features.map(f => f.properties.id).sort());
      for (const feature of node.features) for (const [x, y] of (feature.geometry.coordinates as number[][][])[0]) {
        expect(x).toBeGreaterThanOrEqual(node.bounds[0]); expect(x).toBeLessThanOrEqual(node.bounds[2]);
        expect(y).toBeGreaterThanOrEqual(node.bounds[1]); expect(y).toBeLessThanOrEqual(node.bounds[3]);
      }
    }
  });

  it('uses REPLACE with correct nested geographic transforms and source heights', async () => {
    const tree = partitionArchitecture([building(1), building(2)]);
    const tileset = await createTileset(tree, async node => {
      const batch = await buildBatch(node.features, node.lod!);
      return { ...batch, uri: `${node.id}.glb` };
    });
    expect(tileset.asset.version).toBe('1.1');
    let count = 0;
    const visit = (node: typeof tileset.root, parent: Matrix4) => {
      expect(node.refine).toBe('REPLACE');
      const transform = node.transform ? Matrix4.multiply(parent, Matrix4.fromArray(node.transform), new Matrix4()) : parent;
      if (node.content) {
        count++;
        const anchor = Matrix4.getTranslation(transform, new Cartesian3());
        const expected = Cartesian3.fromDegrees(120.6207, 31.32005);
        expect(Cartesian3.distance(anchor, expected)).toBeLessThan(0.01);
        expect(node.boundingVolume.region[5]).toBeGreaterThan(8.5);
      }
      node.children?.forEach(child => visit(child, transform));
    };
    visit(tileset.root, Matrix4.IDENTITY);
    expect(count).toBe(3);
    expect(tileset.root.geometricError).toBeGreaterThan(0);
  });

  it('publishes only complete, source-bound assets and reuses unchanged generated files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'city-architecture-'));
    temporary.push(root);
    const inputDir = join(root, 'input'), outputDir = join(root, 'output');
    await mkdir(join(inputDir, 'source-v1', 'tiles'), { recursive: true });
    const features = [building(0), building(1)];
    const manifest: CityManifest = {
      version: 1, dataset: 'source-v1', generatedAt: '', osmTimestamp: '', boundaryId: 1,
      bounds: [120.62, 31.32, 120.63, 31.33], attribution: 'OSM', source: '', counts: {
        buildings: 2, measured: 0, levels: 0, fallback: 2, skipped: 0, roads: 1, water: 1, green: 1,
      }, tiles: [{ id: 'a', count: 2, bounds: [120.62, 31.32, 120.63, 31.33] }],
    };
    await writeFile(join(inputDir, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(inputDir, 'source-v1', 'tiles', 'a.json'), JSON.stringify({ type: 'FeatureCollection', features }));
    const result = await buildCityArchitecture({ inputDir, outputDir });
    expect(result.sourceDataset).toBe('source-v1');
    expect(result.buildings).toBe(2);
    expect(result.lods.far.buildings).toBe(2);
    expect(result.lods.mid.buildings).toBe(2);
    expect(result.lods.near.buildings).toBe(2);
    const published = await readFile(join(outputDir, 'manifest.json'), 'utf8');
    expect(JSON.parse(published)).toEqual(result);
    const tilesetPath = join(outputDir, result.tileset), before = await stat(tilesetPath);
    expect((await buildCityArchitecture({ inputDir, outputDir })).version).toBe(result.version);
    expect((await stat(tilesetPath)).mtimeMs).toBe(before.mtimeMs);
    const tileset = await readFile(tilesetPath, 'utf8');
    await writeFile(tilesetPath, '{}');
    await buildCityArchitecture({ inputDir, outputDir });
    expect(await readFile(tilesetPath, 'utf8')).toBe(tileset);
    const inventoryPath = join(outputDir, result.dataset, '.build', 'inventory.json');
    const inventoryText = await readFile(inventoryPath, 'utf8');
    const inventory = JSON.parse(inventoryText) as { uri: string }[];
    const omittedPath = join(outputDir, result.dataset, inventory[0].uri);
    const omitted = await readFile(omittedPath);
    await writeFile(inventoryPath, JSON.stringify(inventory.slice(1)));
    await rm(omittedPath);
    await buildCityArchitecture({ inputDir, outputDir });
    expect(await readFile(inventoryPath, 'utf8')).toBe(inventoryText);
    expect(await readFile(omittedPath)).toEqual(omitted);
    const repaired = await readFile(join(outputDir, 'manifest.json'), 'utf8');
    manifest.counts.buildings = 3;
    await writeFile(join(inputDir, 'manifest.json'), JSON.stringify(manifest));
    await expect(buildCityArchitecture({ inputDir, outputDir })).rejects.toThrow(/count/i);
    expect(await readFile(join(outputDir, 'manifest.json'), 'utf8')).toBe(repaired);
  });
});
