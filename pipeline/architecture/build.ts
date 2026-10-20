import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildingFeature, CityManifest } from '../../web/core/types';
import type { ArchitectureManifest } from '../../web/core/architecture-manifest';
import { buildBatch, type ArchitectureBatch } from './mesh';
import { createTileset, partitionArchitecture } from './tiles';
import { architectureExclusionFor } from '../../web/core/landmarks';
import { architectureSupplements } from '../../web/core/jinji-landmarks';
import { referenceHeightFor, verifiedHeightProvider } from '../../web/core/building-heights';

interface StoredBatch extends Omit<ArchitectureBatch, 'bytes'> { uri: string; bytes: number; sha256: string }
interface BuildOptions { inputDir: string; outputDir: string; onProgress?: (completed: number, total: number) => void }
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

async function atomicWrite(path: string, data: Uint8Array | string) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

async function optionalRead(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function buildCityArchitecture({ inputDir, outputDir, onProgress }: BuildOptions): Promise<ArchitectureManifest> {
  const manifestText = await readFile(join(inputDir, 'manifest.json'), 'utf8');
  const source = JSON.parse(manifestText) as CityManifest;
  if (source.version !== 1 || !/^[\w-]+$/.test(source.dataset)) throw new Error('Invalid architecture source manifest.');
  const hash = createHash('sha256').update(manifestText);
  for (const path of ['./mesh.ts', './tiles.ts', './build.ts', './compact.ts', '../../web/core/building-architecture.ts',
    '../../web/core/architectural-mesh.ts', '../../web/core/architectural-geometry.ts', '../../web/core/city-architecture.ts',
    '../../web/core/landmarks.ts', '../../web/core/landmark-architecture.ts', '../../web/core/landmark-mesh.ts',
    '../../web/core/landmark-towers.ts', '../../web/core/landmark-pagodas.ts', '../../web/core/landmark-mall.ts',
    '../../web/core/jinji-landmarks.ts', '../../web/core/landmark-skyline.ts', '../../web/core/landmark-wheel.ts',
    '../../web/core/building-heights.ts', '../../web/core/building-height-references.ts', '../../web/core/geo.ts']) {
    hash.update(await readFile(new URL(path, import.meta.url)));
  }
  const features: BuildingFeature[] = [];
  for (const tile of [...source.tiles].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!/^[\w-]+$/.test(tile.id)) throw new Error('Invalid architecture source tile ID.');
    const text = await readFile(join(inputDir, source.dataset, 'tiles', `${tile.id}.json`), 'utf8');
    hash.update(text);
    const collection = JSON.parse(text) as { type: string; features: BuildingFeature[] };
    if (collection.type !== 'FeatureCollection' || collection.features.length !== tile.count) throw new Error(`Source tile count mismatch: ${tile.id}`);
    features.push(...collection.features);
  }
  if (features.length !== source.counts.buildings) throw new Error('Source building count mismatch.');
  const supplements = architectureSupplements(source.dataset);
  const tree = partitionArchitecture([...features, ...supplements.features]), dataset = hash.digest('hex').slice(0, 16);
  const buildings = tree.features.length;
  const referencedBuildings = tree.features.filter(feature => referenceHeightFor(feature)).length;
  const exclusions = features.flatMap(feature => {
    const exclusion = architectureExclusionFor(feature);
    return exclusion ? [exclusion] : [];
  });
  const directory = join(outputDir, dataset);
  await mkdir(join(directory, '.build'), { recursive: true });
  const publishedBytes = await optionalRead(join(outputDir, 'manifest.json'));
  const inventoryBytes = await optionalRead(join(directory, '.build', 'inventory.json'));
  if (publishedBytes && inventoryBytes) {
    const published = JSON.parse(publishedBytes.toString()) as ArchitectureManifest;
    const inventory = JSON.parse(inventoryBytes.toString()) as StoredBatch[];
    const expected = new Set<string>(), pending = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.lod) expected.add(`${node.id}-${node.lod}.glb`);
      pending.push(...node.children);
    }
    const records = new Map(inventory.map(file => [file.uri, file]));
    if (published.dataset === dataset && published.tileset === `${dataset}/tileset.json`
      && inventory.length === expected.size && records.size === expected.size
      && [...expected].every(uri => records.has(uri))) {
      const valid = await Promise.all(inventory.map(async file => {
        const bytes = await optionalRead(join(directory, file.uri));
        return bytes !== undefined && bytes.length === file.bytes && digest(bytes) === file.sha256;
      }));
      if (valid.every(Boolean)) {
        const tileset = await createTileset(tree, async node => records.get(`${node.id}-${node.lod}.glb`)!);
        const storedTileset = await optionalRead(join(directory, 'tileset.json'));
        if (storedTileset?.toString() === JSON.stringify(tileset)) return published;
      }
    }
  }
  const emptyLod = () => ({ buildings: 0, tiles: 0, triangles: 0, bytes: 0, decodedBytes: 0 });
  const lods: ArchitectureManifest['lods'] = { far: emptyLod(), mid: emptyLod(), near: emptyLod() };
  const inventory: StoredBatch[] = [];
  let completed = 0;
  const total = buildings * 3;
  const tileset = await createTileset(tree, async node => {
    const uri = `${node.id}-${node.lod}.glb`, recordPath = join(directory, '.build', `${node.id}-${node.lod}.json`);
    const existing = await optionalRead(recordPath);
    let record: StoredBatch | undefined;
    if (existing) {
      const cached = JSON.parse(existing.toString()) as StoredBatch;
      const bytes = await optionalRead(join(directory, uri));
      if (bytes && cached.uri === uri && cached.bytes === bytes.length && cached.sha256 === digest(bytes)) record = cached;
    }
    if (!record) {
      const { bytes, ...batch } = await buildBatch(node.features, node.lod!);
      record = { ...batch, uri, bytes: bytes.byteLength, sha256: digest(bytes) };
      await atomicWrite(join(directory, uri), bytes);
      await atomicWrite(recordPath, JSON.stringify(record));
    }
    const stats = lods[node.lod!];
    stats.buildings += node.features.length; stats.tiles++; stats.triangles += record.triangles;
    stats.bytes += record.bytes; stats.decodedBytes += record.decodedBytes;
    inventory.push(record);
    completed += node.features.length;
    onProgress?.(completed, total);
    return record;
  });
  if (Object.values(lods).some(lod => lod.buildings !== buildings)) throw new Error('Incomplete architecture LOD coverage.');
  const result: ArchitectureManifest = {
    version: 1, dataset, sourceDataset: source.dataset, generatedAt: new Date().toISOString(),
    tileset: `${dataset}/tileset.json`, buildings, bounds: tree.bounds, lods,
    ...(referencedBuildings ? { heightReferences: { provider: verifiedHeightProvider.id, buildings: referencedBuildings } } : {}),
    ...(exclusions.length || supplements.additions.length ? {
      sourceBuildings: features.length, exclusions, ...(supplements.additions.length ? { additions: supplements.additions } : {}),
    } : {}),
    inference: 'Source-aligned parametric architecture; style and facade details are inferred, not an architectural survey.',
  };
  await atomicWrite(join(directory, 'tileset.json'), JSON.stringify(tileset));
  await atomicWrite(join(directory, '.build', 'inventory.json'), JSON.stringify(inventory));
  await atomicWrite(join(outputDir, 'manifest.json'), JSON.stringify(result));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let previous = 0;
  buildCityArchitecture({
    inputDir: resolve('public/data'), outputDir: resolve('public/architecture-city'),
    onProgress: (completed, total) => {
      const now = Date.now();
      if (now - previous < 10000 && completed !== total) return;
      previous = now;
      console.log(`${completed}/${total} building LODs (${(completed / total * 100).toFixed(1)}%)`);
    },
  }).then(result => console.log(JSON.stringify(result, null, 2))).catch((error: unknown) => {
    console.error('Architecture build failed; no new manifest published:', error);
    process.exitCode = 1;
  });
}
