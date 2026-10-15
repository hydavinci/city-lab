import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import osmtogeojson from 'osmtogeojson';
import type { Feature, FeatureCollection } from 'geojson';
import { geometryBounds, tileId, tileBounds } from '../web/core/geo';
import type { BuildingFeature, CityManifest, TileInfo } from '../web/core/types';
import { normalizeBuildings, validateOverpass } from './normalize';

async function atomicJSON(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}

export async function buildDataset({ rawDir, outputDir }: { rawDir: string; outputDir: string }): Promise<CityManifest> {
  const raw = await Promise.all(['boundary', 'surface', 'buildings'].map(async (name) =>
    readFile(join(rawDir, `${name}.json`), 'utf8')));
  const [boundaryInput, surfaceInput, buildingsInput] = raw.map((text) => validateOverpass(JSON.parse(text)));
  const boundaryCollection = osmtogeojson(boundaryInput, { flatProperties: true });
  const boundary = boundaryCollection.features.find((feature) => feature.id === 'relation/4430941');
  if (!boundary || (boundary.geometry.type !== 'Polygon' && boundary.geometry.type !== 'MultiPolygon')
    || boundary.properties?.tainted) {
    throw new Error('Missing or incomplete Suzhou boundary relation/4430941');
  }
  const normalized = normalizeBuildings(osmtogeojson(buildingsInput, { flatProperties: true }), boundary.geometry);
  if (!normalized.features.length) throw new Error('No valid buildings: refusing to replace the current dataset.');
  const surfaces = osmtogeojson(surfaceInput, { flatProperties: true });
  const surfaceFeatures: Feature[] = [];
  const counts: CityManifest['counts'] = {
    buildings: normalized.features.length, measured: 0, levels: 0, fallback: 0,
    skipped: normalized.skipped, roads: 0, water: 0, green: 0,
  };
  for (const feature of surfaces.features) {
    const tags = feature.properties ?? {};
    if (tags.tainted || !feature.geometry || feature.geometry.type === 'Point') continue;
    const layer = tags.highway ? 'roads'
      : tags.natural === 'water' || tags.waterway ? 'water'
        : tags.landuse || tags.leisure === 'park' ? 'green' : undefined;
    if (!layer) continue;
    const type = feature.geometry.type;
    const isPolygon = type === 'Polygon' || type === 'MultiPolygon';
    const isLine = type === 'LineString' || type === 'MultiLineString';
    if (layer === 'roads' && !isLine || layer === 'green' && !isPolygon
      || layer === 'water' && !isPolygon && !isLine) continue;
    counts[layer]++;
    surfaceFeatures.push({
      type: 'Feature', id: feature.id, geometry: feature.geometry,
      properties: { layer, name: tags.name ?? '', kind: tags.highway ?? tags.waterway ?? tags.natural ?? tags.landuse ?? tags.leisure },
    });
  }
  for (const layer of ['roads', 'water', 'green'] as const) {
    if (!counts[layer]) throw new Error(`Required surface layer ${layer} has no usable geometry; current dataset retained.`);
  }
  const groups = new Map<string, BuildingFeature[]>();
  for (const feature of normalized.features) {
    counts[feature.properties.basis === 'height' ? 'measured' : feature.properties.basis]++;
    const bounds = geometryBounds(feature.geometry);
    const id = tileId([(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]);
    const group = groups.get(id) ?? [];
    group.push(feature);
    groups.set(id, group);
  }
  const hash = createHash('sha256').update('schema-v1-height-v1-buildings-v2-surface-v1');
  for (const text of raw) hash.update(text);
  const dataset = hash.digest('hex').slice(0, 16);
  const directory = join(outputDir, dataset);
  await mkdir(join(directory, 'tiles'), { recursive: true });
  const tiles: TileInfo[] = [];
  for (const [id, features] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    // Index actual geometry extents so buildings crossing grid edges remain discoverable.
    const bounds = tileBounds(id);
    for (const feature of features) {
      const box = geometryBounds(feature.geometry);
      bounds[0] = Math.min(bounds[0], box[0]);
      bounds[1] = Math.min(bounds[1], box[1]);
      bounds[2] = Math.max(bounds[2], box[2]);
      bounds[3] = Math.max(bounds[3], box[3]);
    }
    await atomicJSON(join(directory, 'tiles', `${id}.json`), { type: 'FeatureCollection', features });
    tiles.push({ id, bounds, count: features.length });
  }
  await atomicJSON(join(directory, 'boundary.json'), {
    type: 'FeatureCollection', features: [boundary],
  } satisfies FeatureCollection);
  await atomicJSON(join(directory, 'surface.json'), {
    type: 'FeatureCollection', features: surfaceFeatures,
  } satisfies FeatureCollection);
  const manifest: CityManifest = {
    version: 1, dataset, generatedAt: new Date().toISOString(),
    osmTimestamp: buildingsInput.osm3s?.timestamp_osm_base ?? 'unknown',
    boundaryId: 4430941, bounds: geometryBounds(boundary.geometry),
    attribution: '© OpenStreetMap contributors · ODbL 1.0',
    source: 'https://www.openstreetmap.org/relation/4430941',
    counts, tiles,
  };
  await atomicJSON(join(outputDir, 'manifest.json'), manifest);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildDataset({ rawDir: resolve('data/raw'), outputDir: resolve('public/data') })
    .then((manifest) => console.log(JSON.stringify({ dataset: manifest.dataset, tiles: manifest.tiles.length, ...manifest.counts }, null, 2)))
    .catch((error: unknown) => {
      console.error('Data build failed; no new manifest published:', error);
      process.exitCode = 1;
    });
}
