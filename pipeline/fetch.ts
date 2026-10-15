import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { mergeSurfaceData, validateOverpass } from './normalize';

const endpoint = process.env.OVERPASS_ENDPOINT ?? 'https://overpass.private.coffee/api/interpreter';
const queries: Record<string, string> = {
  boundary: '[out:json][timeout:180];rel(4430941);out geom;',
  roads: `[out:json][timeout:180];area(3604430941)->.city;
    way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](area.city);out geom;`,
  water: `[out:json][timeout:180];area(3604430941)->.city;(
    way["waterway"~"^(river|canal)$"](area.city);
    way["natural"="water"](area.city);rel["natural"="water"](area.city);
  );out geom;`,
  green: `[out:json][timeout:120];area(3604430941)->.city;(
    way["landuse"~"^(forest|grass)$"](area.city);way["leisure"="park"](area.city);
  );out geom;`,
  buildings: `[out:json][timeout:240];area(3604430941)->.city;(
    way["building"](area.city);rel["building"](area.city);
  );out geom;`,
};

async function main() {
  await mkdir('data/raw', { recursive: true });
  for (const [name, query] of Object.entries(queries)) {
    const path = `data/raw/${name}.json`;
    if (!process.argv.includes('--refresh')) {
      try {
        validateOverpass(JSON.parse(await readFile(path, 'utf8')), true);
        console.log(`Using validated cache: ${path}`);
        continue;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          console.log(`Fetching missing dataset: ${name}`);
        } else {
          console.warn(`Cached ${name} is invalid; downloading again:`, error);
        }
      }
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Downloading ${name} (${attempt}/3) from ${new URL(endpoint).host}`);
        const response = await fetch(endpoint, {
          method: 'POST', body: new URLSearchParams({ data: query }),
          headers: { 'User-Agent': 'SuzhouCityLab/0.1 (local OSM visualization)' },
          signal: AbortSignal.timeout(300_000),
        });
        if (!response.ok) throw new Error(`Overpass HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`);
        const text = await response.text();
        const data = validateOverpass(JSON.parse(text), true);
        await writeFile(`${path}.tmp`, text);
        await rename(`${path}.tmp`, path);
        console.log(`Saved ${name}: ${data.elements.length} source elements`);
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        console.warn(`Download failed; retrying after ${attempt * 15}s:`, error);
        await setTimeout(attempt * 15_000);
      }
    }
    await setTimeout(2000);
  }
  const surface = mergeSurfaceData(await Promise.all(['roads', 'water', 'green'].map(async (name) =>
    JSON.parse(await readFile(`data/raw/${name}.json`, 'utf8')))));
  await writeFile('data/raw/surface.json.tmp', JSON.stringify(surface));
  await rename('data/raw/surface.json.tmp', 'data/raw/surface.json');
  console.log(`Merged ${surface.elements.length} surface elements. Run npm run data:build next.`);
}

main().catch((error: unknown) => {
  console.error('Download failed. Existing valid data is retained. Retry npm run data:fetch.', error);
  process.exitCode = 1;
});
