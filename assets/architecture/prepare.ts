import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildArchitecture } from '../../web/core/building-architecture';
import { cityStyle, type CityStyle } from '../../web/core/city-architecture';
import type { BuildingFeature, CityManifest } from '../../web/core/types';

const manifest = JSON.parse(await readFile('public/data/manifest.json', 'utf8')) as CityManifest;
const counts: Record<CityStyle, number> = { historic: 0, residential: 0, office: 0, commercial: 0, industrial: 0, neutral: 0 };
const representatives = new Map<CityStyle, { feature: BuildingFeature; score: number }>();
const ids = new Set<string>(), failures: string[] = [];
const maximum = { near: { triangles: 0, bytes: 0 }, mid: { triangles: 0, bytes: 0 } };
for (const [index, tile] of manifest.tiles.entries()) {
  const data = JSON.parse(await readFile(`public/data/${manifest.dataset}/tiles/${tile.id}.json`, 'utf8')) as { features: BuildingFeature[] };
  for (const feature of data.features) {
    if (ids.has(feature.properties.id)) throw new Error(`Duplicate building: ${feature.properties.id}`);
    ids.add(feature.properties.id);
    const style = cityStyle(feature);
    counts[style]++;
    try {
      for (const lod of ['near', 'mid'] as const) {
        const body = buildArchitecture(feature, lod);
        maximum[lod].triangles = Math.max(maximum[lod].triangles, body.triangles);
        maximum[lod].bytes = Math.max(maximum[lod].bytes, body.bytes.byteLength);
      }
    } catch (error) {
      const message = `${tile.id}/${feature.properties.id}: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(message);
      console.error(message);
    }
    const ring = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates[0][0];
    const [x, y] = ring[0], { height } = feature.properties;
    const score = Math.hypot((x - 120.65) * 0.85, y - 31.31) + Math.abs(ring.length - 5) * 0.005
      + (height < 7 || height > 130 ? 5 : 0);
    if (score < (representatives.get(style)?.score ?? Infinity)) representatives.set(style, { feature, score });
  }
  if ((index + 1) % 50 === 0) console.log(`Built ${ids.size} buildings / ${index + 1} tiles`);
}
if (failures.length) throw new Error(`${failures.length} architectural bodies failed; no representative library was published.`);
if (ids.size !== manifest.counts.buildings || representatives.size !== 6) throw new Error('Incomplete city architecture coverage.');
await mkdir('assets/architecture', { recursive: true });
const buildings = [];
for (const style of Object.keys(counts) as CityStyle[]) {
  const feature = representatives.get(style)!.feature;
  const near = buildArchitecture(feature, 'near'), mid = buildArchitecture(feature, 'mid');
  await writeFile(`assets/architecture/${style}-near.glb`, new Uint8Array(near.bytes));
  await writeFile(`assets/architecture/${style}-mid.glb`, new Uint8Array(mid.bytes));
  buildings.push({ style, feature, origin: near.origin, nearTriangles: near.triangles, midTriangles: mid.triangles });
}
await writeFile('assets/architecture/source.json', `${JSON.stringify({
  version: 1, dataset: manifest.dataset, attribution: manifest.attribution,
  inferred: 'Source footprints, heights and properties retained; architectural detail is parametric, not surveyed.',
  coverage: { tiles: manifest.tiles.length, buildings: ids.size, counts,
    maxMidTriangles: maximum.mid.triangles, maxMidBytes: maximum.mid.bytes,
    maxNearTriangles: maximum.near.triangles, maxNearBytes: maximum.near.bytes },
  buildings,
}, null, 2)}\n`);
console.log(JSON.stringify({ buildings: ids.size, tiles: manifest.tiles.length, counts, maximum }));
