import type { EnhancementManifest, Network } from '../../web/core/enhancements';

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
