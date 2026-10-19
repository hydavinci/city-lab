import type { EnhancementManifest, Network, XY } from '../../web/core/enhancements';
import { createHash } from 'node:crypto';

// Synthetic, hand-authored test-local metres. NEVER geographic evidence or OSM downloads.
export const syntheticSource = {
  nodes: [
    { id: 1, xy: [0, 0], tags: {} },
    { id: 2, xy: [40, 0], tags: { highway: 'crossing' } },
    { id: 3, xy: [80, 0], tags: {} },
    { id: 4, xy: [40, -10], tags: {} },
    { id: 5, xy: [40, 10], tags: {} },
  ],
  ways: [
    { id: 101, nodes: [1, 2], tags: { highway: 'residential' } },
    { id: 102, nodes: [2, 3], tags: { highway: 'residential', oneway: 'yes' } },
    { id: 103, nodes: [4, 2, 5], tags: { highway: 'footway', footway: 'crossing' } },
  ],
};

export const network: Network = {
  origin: [120.68, 31.32], bounds: [120.675, 31.315, 120.685, 31.325],
  edges: [
    { id: 'a', sourceIds: ['way/101'], from: '1', to: '2', mode: 'drive',
      points: [[0, 0], [40, 0]], length: 40, width: 4, speed: 5, allowed: ['car-a'],
      next: ['b'], corridor: [[[[0, -2], [40, -2], [40, 2], [0, 2], [0, -2]]]],
      conflicts: [{ zone: 'z', enter: 35, exit: 40 }], inferred: ['width', 'speed'] },
    { id: 'b', sourceIds: ['way/102'], from: '2', to: '3', mode: 'drive',
      points: [[40, 0], [80, 0]], length: 40, width: 4, speed: 5, allowed: ['car-a'],
      next: [], corridor: [[[[40, -2], [80, -2], [80, 2], [40, 2], [40, -2]]]],
      conflicts: [], inferred: ['width', 'speed'] },
    { id: 'w', sourceIds: ['way/103', 'node/2'], from: '4', to: '5', mode: 'walk',
      points: [[40, -10], [40, 0], [40, 10]], length: 20, width: 2, speed: 1,
      allowed: ['person-a'], next: [],
      corridor: [[[[39, -10], [41, -10], [41, 10], [39, 10], [39, -10]]]],
      conflicts: [{ zone: 'z', enter: 8, exit: 12 }], inferred: ['width', 'speed'] },
  ],
  routes: [
    { id: 'drive', mode: 'drive', edges: ['a', 'b'], allowed: ['car-a'], entry: 'a', exit: 'b' },
    { id: 'walk', mode: 'walk', edges: ['w'], allowed: ['person-a'], entry: 'w', exit: 'w' },
  ],
  zones: [{ id: 'z', polygon: [[[35, -2], [42, -2], [42, 2], [35, 2], [35, -2]]], edges: ['a', 'w'] }],
  buildings: [[[[0, 20], [20, 20], [20, 40], [0, 40], [0, 20]],
    [[5, 25], [5, 30], [10, 30], [10, 25], [5, 25]]]],
  water: [[[[60, 20], [80, 20], [80, 40], [60, 40], [60, 20]]]],
};

export const manifest: EnhancementManifest = {
  version: 1, id: 'fedcba9876543210', baseDataset: '0123456789abcdef',
  generatedAt: '2026-10-15T00:00:00.000Z', bounds: network.bounds,
  network: 'fedcba9876543210/network.json', roads: 'fedcba9876543210/roads.json',
  provenance: 'fedcba9876543210/provenance.json', placements: 'fedcba9876543210/placements.json',
  assets: [{ kind: 'car-a', uri: 'fedcba9876543210/car-a.glb', sha256: 'a'.repeat(64),
    bytes: 1024, size: [4, 2, 1.5], animation: null }],
  showcase: { target: [120.68, 31.32], heading: 0, pitch: -45, range: 500 },
};

// Separate synthetic WGS84 envelope for fetch/cache validation, not selection evidence.
export const overpass = {
  version: 0.6, generator: 'synthetic-test',
  osm3s: { timestamp_osm_base: '2026-10-14T00:00:00Z', copyright: 'synthetic fixture' },
  elements: [
    { type: 'node', id: 1, lon: 120.68, lat: 31.32, tags: { highway: 'crossing' } },
    { type: 'node', id: 2, lon: 120.681, lat: 31.32 },
    { type: 'way', id: 101, nodes: [1, 2], tags: { highway: 'residential', access: 'yes' } },
    { type: 'relation', id: 201, tags: { type: 'restriction', restriction: 'no_u_turn' },
      members: [{ type: 'way', ref: 101, role: 'from' }, { type: 'node', ref: 2, role: 'via' },
        { type: 'way', ref: 101, role: 'to' }] },
  ],
};

// Independent local-metre-to-degree literals; compiler fixtures are never geographic evidence.
export function routeFixture() {
  const coordinates: XY[] = [[-300, 0], [0, 0], [300, 0], [0, -300], [0, 300],
    [-300, 350], [300, 350]];
  const source = {
    version: 0.6, osm3s: { timestamp_osm_base: '2026-10-14T00:00:00Z' },
    elements: [
      ...coordinates.map(([x, y], i) => ({
        type: 'node', id: i + 1, lon: x / 111319.49079327358, lat: y / 111319.49079327358,
      })),
      { type: 'way', id: 101, nodes: [1, 2, 3], tags: { highway: 'residential', oneway: 'yes', lanes: '4' } },
      { type: 'way', id: 102, nodes: [4, 2, 5], tags: { highway: 'residential', oneway: 'yes', lanes: '4' } },
      { type: 'way', id: 103, nodes: [6, 7], tags: { highway: 'footway', width: '2' } },
    ] as any[],
  };
  const selection = {
    version: 1, baseDataset: '0123456789abcdef', bounds: [-0.004, -0.004, 0.004, 0.004],
    showcase: { target: [0, 0], heading: 0, pitch: -45, range: 300 },
    driveWays: source.elements.filter(e => e.type === 'way' && e.id !== 103)
      .map(e => ({ id: `way/${e.id}`, nodeIds: [...e.nodes], tags: { ...e.tags } })),
    walkWays: [{ id: 'way/103', nodeIds: [6, 7], tags: { highway: 'footway', width: '2' } }],
    crossings: [], excludedWays: {}, restrictions: [], diagnostics: [],
  };
  return { source, selection };
}

export function publicationFixture() {
  const { source, selection } = routeFixture();
  const ring = (x: number, y: number, width = 1): XY[] =>
    [[x,y],[x+width,y],[x+width,y+width],[x,y+width],[x,y]];
  const feature = (id: string, x: number, y: number, layer: string) => ({
    type: 'Feature', id, properties: { layer, id }, geometry: { type: 'Polygon',
      coordinates: [ring(x,y,20).map(([x,y]) => [x/111319.49079327358,y/111319.49079327358])] },
  });
  const base = { version: 1, dataset: selection.baseDataset, bounds: selection.bounds,
    osmTimestamp: source.osm3s.timestamp_osm_base, generatedAt: '2026-10-15T00:00:00.000Z',
    tiles: [{ id: 'fixture', bounds: selection.bounds, count: 1 }] };
  const document = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3',
      min: [-0.25,0,-0.25], max: [0.25,0.5,0.25] }] };
  const text = JSON.stringify(document), chunk = Buffer.from(text.padEnd(Math.ceil(text.length/4)*4,' '));
  const glb = Buffer.alloc(12+8+chunk.length+8+36);
  glb.writeUInt32LE(0x46546c67,0); glb.writeUInt32LE(2,4); glb.writeUInt32LE(glb.length,8);
  glb.writeUInt32LE(chunk.length,12); glb.writeUInt32LE(0x4e4f534a,16); chunk.copy(glb,20);
  const at=20+chunk.length; glb.writeUInt32LE(36,at); glb.writeUInt32LE(0x004e4942,at+4);
  [-0.25,0,-0.25, 0.25,0,-0.25, -0.25,0.5,0.25].forEach((v,i)=>glb.writeFloatLE(v,at+8+i*4));
  const animated = structuredClone(document) as any;
  animated.animations=[{name:'Walk',channels:[{sampler:0,target:{node:0,path:'translation'}}],
    samplers:[{input:1,output:2,interpolation:'LINEAR'}]}];
  animated.buffers[0].byteLength=84;
  animated.bufferViews.push({buffer:0,byteOffset:36,byteLength:12},{buffer:0,byteOffset:48,byteLength:36});
  animated.accessors.push({bufferView:1,componentType:5126,count:3,type:'SCALAR'},
    {bufferView:2,componentType:5126,count:3,type:'VEC3'});
  const animatedText=JSON.stringify(animated), animatedChunk=Buffer.from(animatedText.padEnd(Math.ceil(animatedText.length/4)*4,' '));
  const personGlb=Buffer.alloc(28+animatedChunk.length+84);
  glb.copy(personGlb,0,0,12);personGlb.writeUInt32LE(personGlb.length,8);
  personGlb.writeUInt32LE(animatedChunk.length,12);personGlb.writeUInt32LE(0x4e4f534a,16);animatedChunk.copy(personGlb,20);
  const bat=20+animatedChunk.length;
  personGlb.writeUInt32LE(84,bat);personGlb.writeUInt32LE(0x004e4942,bat+4);
  glb.copy(personGlb,bat+8,at+8);
  [0,0.5,1, 0,0,0, 0,0,0.01, 0,0,0].forEach((v,i)=>personGlb.writeFloatLE(v,bat+44+i*4));
  // The synthetic triangle's forward extent leaves room for this tiny looping translation.
  personGlb.writeFloatLE(0.24,bat+8+32);
  const assets = ['car-a','car-b','bus','person-a','person-b','tree','lamp','entrance','roof-unit'].map(kind=>({
    kind, uri: `${kind}.glb`, bytes: kind.startsWith('person-')?personGlb.length:glb.length,
    sha256: createHash('sha256').update(kind.startsWith('person-')?personGlb:glb).digest('hex'),
    size: [0.5,0.5,0.5], animation: kind.startsWith('person-')?'Walk':null,
  }));
  const placements = [
    {asset:'tree',sourceIds:['way/103'],position:[-100,350.7],footprint:[ring(-100.26,350.44,0.52)]},
    {asset:'lamp',sourceIds:['way/103'],position:[-120,350.7],footprint:[ring(-120.26,350.44,0.52)]},
    {asset:'entrance',sourceIds:['way/900'],position:[205,205],footprint:[ring(204.5,204.5)]},
    {asset:'roof-unit',sourceIds:['way/900'],position:[210,210],footprint:[ring(209.5,209.5)]},
  ].map(p=>({...p,heading:0,inferred:['synthetic fixture only']}));
  return { source, selection, base, glb, personGlb, assets, placements,
    buildings: { type: 'FeatureCollection', features: [feature('way/900',200,200,'buildings')] },
    surface: { type: 'FeatureCollection', features: [feature('way/901',250,250,'water')] },
    cache: { response: source, metadata: { bounds: selection.bounds, query: 'synthetic highway fixture',
      endpoint: 'fixture.invalid', fetchedAt: '2026-10-15T00:00:00.000Z', osmSnapshot: source.osm3s.timestamp_osm_base } } };
}

export function crossingFixture() {
  const { source, selection } = routeFixture();
  const m = 111319.49079327358;
  for (const id of [6, 7]) source.elements.find(e => e.id === id).lat = 100 / m;
  source.elements.push(
    { type: 'node', id: 8, lon: -10 / m, lat: 100 / m },
    { type: 'node', id: 9, lon: 10 / m, lat: 100 / m },
    { type: 'node', id: 10, lon: 0, lat: 100 / m, tags: { highway: 'crossing' } },
    { type: 'way', id: 104, nodes: [8, 10, 9], tags: { highway: 'footway', footway: 'crossing', width: '2' } },
    { type: 'way', id: 105, nodes: [9, 7], tags: { highway: 'footway', width: '2' } },
  );
  source.elements.find(e => e.id === 103).nodes = [6, 8];
  source.elements.find(e => e.id === 102).nodes = [4, 2, 10, 5];
  selection.driveWays[1].nodeIds = [4, 2, 10, 5];
  selection.walkWays = [103, 104, 105].map(id => {
    const way = source.elements.find(e => e.id === id);
    return { id: `way/${id}`, nodeIds: [...way.nodes], tags: { ...way.tags } };
  });
  return { source, selection: { ...selection, crossings: [{
    ways: ['way/104'], from: { node: 'node/8', sideRoute: 'way/103' },
    to: { node: 'node/9', sideRoute: 'way/105' }, crossedRoads: [{ way: 'way/102', node: 'node/10' }],
  }] } };
}
