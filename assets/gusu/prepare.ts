import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson';
import type { BuildingFeature, CityManifest } from '../../web/core/types';

const base = JSON.parse(await readFile('public/data/manifest.json', 'utf8')) as CityManifest;
const bounds = [120.62773, 31.31611, 120.62842, 31.31709];
const origin = [120.628075, 31.31660];
const tile = JSON.parse(await readFile(`public/data/${base.dataset}/tiles/4825_1252.json`, 'utf8')) as FeatureCollection<Polygon | MultiPolygon, BuildingFeature['properties']>;
const buildings = tile.features.filter(feature => {
  const ring = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates[0][0];
  const vertices = ring.slice(0, -1);
  const center = [0, 1].map(axis => vertices.reduce((sum, point) => sum + point[axis], 0) / vertices.length);
  return center[0] >= bounds[0] && center[0] <= bounds[2] && center[1] >= bounds[1] && center[1] <= bounds[3];
});
if (buildings.length !== 45 || !buildings.some(feature => feature.properties.id === 'relation/8507458')) {
  throw new Error('Gusu sample no longer matches the approved 45 source footprints');
}
const water = JSON.parse(await readFile(`public/data/${base.dataset}/surface.json`, 'utf8')) as FeatureCollection;
const selectedWater = water.features.filter(feature => feature.id === 'way/525823909');
if (selectedWater.length !== 1) throw new Error('Missing mapped water boundary for the sample');
await mkdir('assets/gusu', { recursive: true });
await writeFile('assets/gusu/source.json', `${JSON.stringify({
  version: 1, baseDataset: base.dataset, origin, bounds, buildings, water: selectedWater,
}, null, 2)}\n`);
console.log(`Prepared ${buildings.length} unchanged source buildings from ${base.dataset}`);
