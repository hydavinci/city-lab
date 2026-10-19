import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FeatureCollection } from 'geojson';
import { parseEnhancementManifest, parseNetwork, parsePlacements } from '../../web/core/enhancements';
import type { Asset, Diagnostic, EnhancementManifest, Network, Polygon2, XY } from '../../web/core/enhancements';
import type { CityManifest } from '../../web/core/types';
import { ACTORS, activeMotorConflict, capacity, compileNetwork, parseSelection } from './routes';
import { boundsOverlap, polygonBounds, polygonsIntersect, project, rectangle, sweptEnvelope, validateEnvelope } from './geometry';
import { continuousBounds } from './animation-bounds';
import { makePlacements } from './placements';

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
async function readJSON(path: string): Promise<any> { return JSON.parse(await readFile(path, 'utf8')); }
async function atomic(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function ordinaryFile(root: string, path: string): Promise<Buffer> {
  check(path.split('/').every(p => /^[A-Za-z0-9_.-]+$/.test(p) && p !== '.' && p !== '..'), 'Unsafe package path');
  let at = root;
  for (const part of path.split('/')) {
    at = join(at, part);
    check(!(await lstat(at)).isSymbolicLink(), 'Package symlinks are not supported');
  }
  check((await lstat(at)).isFile(), 'Expected regular package file');
  return readFile(at);
}
export function validateGLB(bytes: Buffer, size: Asset['size'], animation: string | null = null) {
  check(bytes.length >= 24 && bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(4) === 2
    && bytes.readUInt32LE(8) === bytes.length, 'Invalid GLB header/length');
  let at = 12, document: any, binary: Buffer | undefined;
  while (at < bytes.length) {
    check(at + 8 <= bytes.length, 'Truncated GLB chunk');
    const length = bytes.readUInt32LE(at), type = bytes.readUInt32LE(at + 4);
    check(length % 4 === 0 && at + 8 + length <= bytes.length, 'Invalid GLB chunk length');
    const chunk = bytes.subarray(at + 8, at + 8 + length);
    if (at === 12) {
      check(type === 0x4e4f534a, 'GLB JSON must be first');
      document = JSON.parse(chunk.toString('utf8'));
    } else {
      check(type === 0x004e4942 && !binary, 'Unsupported GLB chunk');
      binary = chunk;
    }
    at += 8 + length;
  }
  check(document?.asset?.version === '2.0' && Array.isArray(document.meshes) && document.meshes.length
    && Array.isArray(document.nodes) && document.nodes.length && Array.isArray(document.scenes)
    && document.scenes.length, 'Incomplete GLB scene');
  check(Array.isArray(document.buffers) && document.buffers.length === 1 && !document.buffers[0].uri
    && binary && Number.isSafeInteger(document.buffers[0].byteLength)
    && document.buffers[0].byteLength > 0 && document.buffers[0].byteLength <= binary.length, 'Invalid embedded GLB buffer');
  check(!document.images?.some((image: any) => image.uri), 'External GLB images forbidden');
  check(!document.extensionsUsed?.length && !document.skins?.length,
    'Skinned/extended GLB is not supported by the bounds adapter');
  const meshes: number[][][] = [];
  for (const mesh of document.meshes) {
    const positions: number[][] = [];
    meshes.push(positions);
    check(Array.isArray(mesh.primitives) && mesh.primitives.length, 'Empty GLB mesh');
    for (const primitive of mesh.primitives) {
      check(!primitive.targets?.length, 'Morph bounds unsupported');
      const accessor = document.accessors?.[primitive.attributes?.POSITION];
      const view = document.bufferViews?.[accessor?.bufferView];
      check(accessor && accessor.type === 'VEC3' && accessor.componentType === 5126 && !accessor.sparse
        && Number.isSafeInteger(accessor.count) && accessor.count > 0 && view && view.buffer === 0, 'Invalid GLB positions');
      const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0), stride = view.byteStride ?? 12;
      check([start, stride, view.byteLength].every(Number.isSafeInteger) && start >= 0 && stride >= 12
        && (accessor.byteOffset ?? 0) + (accessor.count - 1) * stride + 12 <= view.byteLength
        && start + (accessor.count - 1) * stride + 12 <= document.buffers[0].byteLength, 'Truncated GLB positions');
      for (let i = 0; i < accessor.count; i++) {
        const point = [0, 1, 2].map(j => binary!.readFloatLE(start + i * stride + j * 4));
        check(point.every(Number.isFinite), 'Nonfinite GLB position');
        positions.push(point);
      }
    }
  }
  const tuple = (v: unknown, length: number): v is number[] =>
    Array.isArray(v) && v.length === length && v.every(Number.isFinite);
  const seen = new Set<number>();
  let vertices = 0;
  const visit = (id: number, parent: (p: number[]) => number[]) => {
    check(Number.isSafeInteger(id) && document.nodes[id] && !seen.has(id), 'Invalid/cyclic GLB hierarchy');
    seen.add(id);
    const node = document.nodes[id];
    const translation = node.translation ?? [0, 0, 0], scale = node.scale ?? [1, 1, 1], q = node.rotation ?? [0, 0, 0, 1];
    check(tuple(translation, 3) && tuple(scale, 3) && tuple(q, 4)
      && Math.abs(Math.hypot(...q) - 1) < 1e-6, 'Invalid GLB TRS');
    if (node.matrix) check(tuple(node.matrix, 16) && !node.translation && !node.scale && !node.rotation
      && [3, 7, 11].every(i => node.matrix[i] === 0) && node.matrix[15] === 1, 'Invalid GLB matrix');
    const transform = (point: number[]): number[] => {
      if (node.matrix) return parent([0, 1, 2].map(i =>
        node.matrix[i] * point[0] + node.matrix[4 + i] * point[1] + node.matrix[8 + i] * point[2] + node.matrix[12 + i]));
      const [x, y, z] = point.map((v, i) => v * scale[i]), [qx, qy, qz, qw] = q;
      const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
      return parent([x + qw * tx + qy * tz - qz * ty + translation[0],
        y + qw * ty + qz * tx - qx * tz + translation[1], z + qw * tz + qx * ty - qy * tx + translation[2]]);
    };
    if (node.mesh !== undefined) {
      check(Number.isSafeInteger(node.mesh) && meshes[node.mesh], 'Dangling GLB mesh');
      for (const point of meshes[node.mesh]) {
        const [x, y, z] = transform(point);
        // glTF Y-up, footprint-centred origin: length along Z, width along X.
        check([x, y, z].every(Number.isFinite) && Math.abs(x) <= size[1] / 2 + 1e-6
          && Math.abs(z) <= size[0] / 2 + 1e-6 && y >= -1e-6 && y <= size[2] + 1e-6,
        'GLB geometry exceeds declared centred dimensions');
        vertices++;
      }
    }
    check(node.children === undefined || Array.isArray(node.children), 'Invalid GLB children');
    for (const child of node.children ?? []) visit(child, transform);
  };
  const scene = document.scenes[document.scene ?? 0];
  check(scene && Array.isArray(scene.nodes) && scene.nodes.length, 'Missing GLB default scene');
  for (const id of scene.nodes) visit(id, p => p);
  check(vertices > 0, 'GLB default scene has no geometry');
  const proof=continuousBounds(document,binary!,meshes,animation);
  check(proof.min[0]>=-size[1]/2-1e-6 && proof.max[0]<=size[1]/2+1e-6
    && proof.min[2]>=-size[0]/2-1e-6 && proof.max[2]<=size[0]/2+1e-6
    && proof.min[1]>=-1e-6 && proof.max[1]<=size[2]+1e-6,`Continuous GLB bounds exceed dimensions: ${JSON.stringify(proof)}`);
  return proof;
}

export async function buildEnhancements(options: {
  rawDir: string; selectionPath: string; baseDir: string;
  assetDir: string; outputDir: string; publish: boolean;
}): Promise<EnhancementManifest | { candidate: Network; diagnostics: Diagnostic[] }> {
  const { rawDir, selectionPath, baseDir, assetDir, outputDir, publish } = options;
  const [cache, selected, baseBytes] = await Promise.all([
    readJSON(join(rawDir, 'district.json')), readJSON(selectionPath), readFile(join(baseDir, 'manifest.json')),
  ]);
  const base = JSON.parse(baseBytes.toString());
  const selection = parseSelection(selected, cache.response);
  check(cache.metadata && JSON.stringify(cache.metadata.bounds) === JSON.stringify(selection.bounds)
    && typeof cache.metadata.query === 'string' && cache.metadata.query.includes('highway')
    && typeof cache.metadata.endpoint === 'string' && cache.metadata.endpoint.length
    && Number.isFinite(Date.parse(cache.metadata.fetchedAt))
    && cache.metadata.osmSnapshot === cache.response.osm3s.timestamp_osm_base, 'Invalid source cache provenance');
  check(base.version === 1 && /^[a-f0-9]{16}$/.test(base.dataset) && base.dataset === selection.baseDataset
    && Array.isArray(base.tiles) && Array.isArray(base.bounds) && base.bounds.length === 4
    && base.bounds.every(Number.isFinite) && Number.isFinite(Date.parse(base.osmTimestamp)), 'Invalid/mismatched base manifest');
  const origin: XY = [(selection.bounds[0] + selection.bounds[2]) / 2, (selection.bounds[1] + selection.bounds[3]) / 2];
  const evidence: { path: string; sha256: string; bytes: number }[] = [];
  const load = async (path: string): Promise<FeatureCollection> => {
    const bytes = await ordinaryFile(baseDir, path), value = JSON.parse(bytes.toString());
    check(value.type === 'FeatureCollection' && Array.isArray(value.features), 'Invalid base feature collection');
    evidence.push({ path, sha256: hash(bytes), bytes: bytes.length });
    return value;
  };
  const tileIds = new Set<string>();
  const buildings: Polygon2[] = [], water: Polygon2[] = [];
  const footprints = new Map<string, Polygon2[]>();
  const hosts = new Map<string, {polygons: Polygon2[]; height: number}>();
  const polygons = (collection: FeatureCollection, target: Polygon2[], layer?: string) => {
    for (const f of collection.features) {
      check(f.type === 'Feature' && f.geometry && typeof f.geometry.type === 'string', 'Invalid base feature');
      if (layer && f.properties?.layer !== layer) continue;
      const g = f.geometry;
      if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') {
        // A line-only water source cannot supply a safe width; never ignore it.
        if (layer === 'water' && (g.type === 'LineString' || g.type === 'MultiLineString')) {
          const points = (g.type === 'LineString' ? g.coordinates : g.coordinates.flat()) as XY[];
          const box = polygonBounds([points]);
          check(!boundsOverlap(box, selection.bounds), `Unbounded waterway ${f.id}`);
        }
        continue;
      }
      const geometry = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      for (const p of geometry) {
        check(p.length && p.every(r => r.length >= 4 && r.every(q => q.length >= 2 && q.slice(0, 2).every(Number.isFinite))), 'Invalid base polygon');
        if (!boundsOverlap(polygonBounds(p as XY[][]), selection.bounds)) continue;
        const local = p.map(r => r.map(q => project(q.slice(0, 2) as XY, origin)));
        target.push(local);
        if (target === buildings) {
          const id = String(f.id ?? f.properties?.id);
          check(/^(way|relation)\/[1-9]\d*$/.test(id), 'Building source ID missing');
          footprints.set(id, [...(footprints.get(id) ?? []), local]);
          hosts.set(id,{polygons:footprints.get(id)!,height:Number(f.properties?.height) || 12});
        }
      }
    }
  };
  for (const tile of (base as CityManifest).tiles) {
    check(typeof tile.id === 'string' && /^[\w-]+$/.test(tile.id) && !tileIds.has(tile.id)
      && Array.isArray(tile.bounds) && tile.bounds.length === 4 && tile.bounds.every(Number.isFinite)
      && tile.bounds[0] < tile.bounds[2] && tile.bounds[1] < tile.bounds[3], 'Invalid base tile');
    tileIds.add(tile.id);
    if (boundsOverlap(tile.bounds, selection.bounds)) polygons(await load(`${base.dataset}/tiles/${tile.id}.json`), buildings);
  }
  polygons(await load(`${base.dataset}/surface.json`), water, 'water');
  const { network, diagnostics } = compileNetwork(cache.response, selection, buildings, water);
  const storage = capacity(network);
  diagnostics.push({ sourceIds: [], code: 'STATIC_CAPACITY', message: JSON.stringify(storage) });
  const motorConflict = activeMotorConflict(network);
  diagnostics.push({ sourceIds: motorConflict ? [motorConflict.node] : [], code: 'ACTIVE_MOTOR_CONFLICT',
    message: JSON.stringify(motorConflict ?? null) });
  const roads = { version: 1, origin: network.origin, bounds: network.bounds,
    features: network.edges.map(e => ({ id: e.id, sourceIds: e.sourceIds, mode: e.mode, corridor: e.corridor })) };
  const provenance = { version: 1, baseDataset: base.dataset, source: cache, selection,
    baseSnapshot: base.osmTimestamp, baseManifestSha256: hash(baseBytes), obstacleFiles: evidence,
    assumptions: ACTORS, diagnostics, capacity: storage, routes: network.routes, zones: network.zones };
  if (!publish) {
    await mkdir(outputDir, { recursive: true });
    await atomic(join(outputDir, 'candidate.json'), json({ candidate: network, diagnostics, roads, provenance }));
    return { candidate: network, diagnostics };
  }
  check(storage.vehicles >= 20 && storage.pedestrians >= 30, 'Insufficient validated capacity: requires 20 vehicles and 30 pedestrians');
  check(motorConflict, 'Missing active motor intersection conflict through a shared source node and physical zone');
  const assets: Asset[] = await readJSON(join(assetDir, 'assets.json'));
  const probe = parseEnhancementManifest({ version: 1, id: 'candidate', baseDataset: base.dataset,
    generatedAt: new Date().toISOString(), bounds: selection.bounds, showcase: selection.showcase,
    network: 'network.json', roads: 'roads.json', provenance: 'provenance.json', placements: 'placements.json', assets }, base.dataset);
  const kinds: Asset['kind'][] = ['car-a', 'car-b', 'bus', 'person-a', 'person-b', 'tree', 'lamp', 'entrance', 'roof-unit'];
  check(kinds.every(kind => assets.some(a => a.kind === kind)) && assets.length === kinds.length, 'Incomplete nine-kind asset inventory');
  const files = new Map<string, Buffer>([
    ['network.json', json(parseNetwork(network))], ['roads.json', json(roads)], ['provenance.json', json(provenance)],
  ]);
  const assetBounds: Record<string, ReturnType<typeof validateGLB>> = {};
  for (const asset of assets) {
    check(asset.uri.endsWith('.glb') && !files.has(asset.uri), 'Duplicate/non-GLB asset path');
    const bytes = await ordinaryFile(assetDir, asset.uri);
    check(bytes.length === asset.bytes && hash(bytes) === asset.sha256, `Asset hash/byte mismatch: ${asset.kind}`);
    check(!asset.kind.startsWith('person-') || asset.animation === 'Walk', 'People require Walk');
    assetBounds[asset.kind] = validateGLB(bytes, asset.size, asset.animation);
    if (asset.kind in ACTORS) {
      const body = ACTORS[asset.kind as keyof typeof ACTORS];
      check(asset.size[0] <= body.length && asset.size[1] <= body.width, 'Asset exceeds validated actor envelope');
    }
    files.set(asset.uri, bytes);
  }
  const placed = new Set<string>(), sourceIds = new Set(cache.response.elements.map((e: any) => `${e.type}/${e.id}`));
  const boundary: Polygon2 = [[
    project([selection.bounds[0], selection.bounds[1]], origin), project([selection.bounds[2], selection.bounds[1]], origin),
    project([selection.bounds[2], selection.bounds[3]], origin), project([selection.bounds[0], selection.bounds[3]], origin),
    project([selection.bounds[0], selection.bounds[1]], origin),
  ]];
  const authored = await readJSON(join(assetDir, 'placements.json')).catch(error=>{
    if(error.code!=='ENOENT') throw error;
    return makePlacements(network,assets,hosts,boundary);
  });
  const placements = parsePlacements(authored, assets);
  const activeSweeps = network.routes.flatMap(route => {
    const points = route.edges.flatMap((id, i) => {
      const edge = network.edges.find(e => e.id === id)!;
      return i ? edge.points.slice(1) : edge.points;
    });
    return sweptEnvelope(points, Math.max(...route.allowed.map(k => ACTORS[k].length)),
      Math.max(...route.allowed.map(k => ACTORS[k].width)));
  });
  const placedFootprints: Polygon2[] = [];
  for (const p of placements) {
    check(p && ['tree', 'lamp', 'entrance', 'roof-unit'].includes(p.asset) && Array.isArray(p.sourceIds) && p.sourceIds.length
      && p.sourceIds.every((id: string) => sourceIds.has(id) || footprints.has(id))
      && Array.isArray(p.position) && p.position.length === 2 && p.position.every(Number.isFinite)
      && Number.isFinite(p.heading) && Array.isArray(p.inferred) && p.inferred.every((v: unknown) => typeof v === 'string'), 'Invalid placement');
    parseNetwork({ ...network, buildings: [p.footprint], water: [] });
    const asset = assets.find(a => a.kind === p.asset)!;
    const forward: XY = [Math.sin(p.heading), Math.cos(p.heading)];
    const body = rectangle([p.position[0] - forward[0] * 1e-6, p.position[1] - forward[1] * 1e-6],
      [p.position[0] + forward[0] * 1e-6, p.position[1] + forward[1] * 1e-6], asset.size[0] / 2 + 0.001, asset.size[1] / 2 + 0.001);
    validateEnvelope([body], [p.footprint], [], []);
    check(![...activeSweeps, ...placedFootprints].some(body => polygonsIntersect(body, p.footprint)),
      'Static placement obstructs an active route or another placement');
    validateEnvelope([p.footprint], [boundary], [], water);
    if (p.asset === 'entrance' || p.asset === 'roof-unit') {
      const sources = p.sourceIds.flatMap((id: string) => footprints.get(id) ?? []);
      validateEnvelope([p.footprint], sources, [], []);
      validateEnvelope([p.footprint], [boundary], buildings.filter(b=>!sources.includes(b)), water);
    } else {
      const corridors = network.edges.filter(e => e.sourceIds.some(id => p.sourceIds.includes(id))).flatMap(e => e.corridor);
      validateEnvelope([p.footprint], corridors, buildings, water);
    }
    placed.add(p.asset);
    placedFootprints.push(p.footprint);
  }
  check(['tree', 'lamp', 'entrance', 'roof-unit'].every(kind => placed.has(kind)), 'Incomplete static placement kinds');
  files.set('placements.json', json(placements));
  files.set('assets.json', json(assets));
  files.set('provenance.json', json({...provenance, assetBounds,
    budget: {limit:30_000_000, newBaseMetadataBytes:8_796_241}}));
  const digest = createHash('sha256').update('district-mobility-v1');
  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) digest.update(path).update('\0').update(bytes);
  const id = digest.digest('hex').slice(0, 32);
  const manifest = parseEnhancementManifest({ ...probe, id, network: `${id}/network.json`, roads: `${id}/roads.json`,
    provenance: `${id}/provenance.json`, placements: `${id}/placements.json`,
    assets: assets.map(a => ({ ...a, uri: `${id}/${a.uri}` })) }, base.dataset);
  check(8_796_241 + json(manifest).length + [...files.values()].reduce((n,b)=>n+b.length,0) <= 30_000_000,
    'New runtime resources exceed 30 MB budget');
  await mkdir(outputDir, { recursive: true });
  const stage = join(outputDir, `.package-${randomUUID()}`), target = join(outputDir, id);
  const lock = join(outputDir, '.publish-lock');
  await mkdir(lock);
  try {
    await mkdir(stage);
    for (const [path, bytes] of files) {
      await mkdir(dirname(join(stage, path)), { recursive: true });
      await writeFile(join(stage, path), bytes, { flag: 'wx' });
    }
    const existingTarget = await lstat(target).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (existingTarget) {
      check(existingTarget.isDirectory() && !existingTarget.isSymbolicLink(), 'Immutable package target collision');
      const existing = await readdir(target, { recursive: true, withFileTypes: true });
      check(existing.filter(e => e.isFile()).length === files.size && existing.every(e => !e.isSymbolicLink()), 'Immutable package inventory collision');
      for (const [path, bytes] of files) check(bytes.equals(await ordinaryFile(target, path)), 'Immutable content collision');
    } else await rename(stage, target);
    await atomic(join(outputDir, 'manifest.json'), json(manifest));
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), names = ['raw-dir', 'selection', 'base-dir', 'asset-dir', 'output-dir'];
  const option = (name: string, fallback: string) => resolve(args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback);
  const run = async () => {
    check(args.every(a => a === '--publish' || names.some(n => a.startsWith(`--${n}=`))), 'Unknown build argument');
    const publish = args.includes('--publish');
    const result = await buildEnhancements({
      rawDir: option('raw-dir', 'data/raw/jinji-lake/selected'), selectionPath: option('selection', 'data/enhancements/jinji-lake-selection.json'),
      baseDir: option('base-dir', 'public/data'), assetDir: option('asset-dir', 'data/enhancements/staging/assets'),
      outputDir: option('output-dir', publish ? 'public/enhancements' : 'data/enhancements/staging'), publish,
    });
    console.log(JSON.stringify('candidate' in result
      ? { mode: 'candidate', edges: result.candidate.edges.length, routes: result.candidate.routes, capacity: capacity(result.candidate) }
      : { mode: 'published', id: result.id }, null, 2));
  };
  run().catch(error => { console.error('Enhancement build failed; previous manifest retained:', error); process.exitCode = 1; });
}
