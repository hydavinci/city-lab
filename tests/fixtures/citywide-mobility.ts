import { createHash } from 'node:crypto';
import type { MobilityChunk, MobilityManifest, MobilityResource, SpawnGate } from '../../web/core/mobility';
import { network } from './enhancements';
import { project, unproject } from '../../pipeline/enhancements/geometry';
import type { Polygon2, XY } from '../../web/core/enhancements';

// Synthetic local geometry only; never evidence of geographic coverage.
export function mobilityFixture(): { manifest: MobilityManifest; chunk: MobilityChunk } {
  const id = 'a'.repeat(32);
  const chunk: MobilityChunk = {
    version: 1, id: 'cell/0', bounds: [...network.bounds], network: structuredClone(network),
    ownedEdges: ['a', 'b', 'w'],
    ports: [
      { id: 'drive-in', edge: 'a', at: 'entry', coordinate: unproject([0, 0], network.origin),
        heading: Math.PI / 2, allowed: ['car-a'], links: [] },
      { id: 'drive-out', edge: 'b', at: 'exit', coordinate: unproject([80, 0], network.origin),
        heading: Math.PI / 2, allowed: ['car-a'], links: [] },
    ],
    zoneIds: { z: 'junction/synthetic' },
    surfaces: [
      { id: 'way/101:0', sourceIds: ['way/101'], mode: 'drive', points: [[0, 0], [40, 0]],
        width: 4, height: 0.3, inferred: ['synthetic road surface'] },
      { id: 'way/102:0', sourceIds: ['way/102'], mode: 'drive', points: [[40, 0], [80, 0]],
        width: 4, height: 0.3, inferred: ['synthetic road surface'] },
      { id: 'way/103:0', sourceIds: ['way/103'], mode: 'walk', points: [[40, -10], [40, 10]],
        width: 2, height: 0.3, inferred: ['synthetic walking surface'] },
    ],
  };
  const manifest: MobilityManifest = {
    version: 1, id, baseDataset: '0123456789abcdef', generatedAt: '2026-10-21T00:00:00Z',
    bounds: [...network.bounds], assets: resource('enhancements/manifest.json', '{"synthetic":true}'),
    cells: [
      { id: chunk.id, bounds: [...chunk.bounds], status: 'ready', neighbours: [],
        resource: resource(`mobility/${id}/cell-0.json`, JSON.stringify(chunk)),
        driveMetres: 80, walkMetres: 20, diagnosticCodes: [] },
    ],
    coverage: { cells: 1, ready: 1, empty: 0, excluded: 0, failed: 0, driveMetres: 80, walkMetres: 20 },
  };
  return { manifest, chunk };
}

export function resource(uri: string, text: string): MobilityResource {
  return { uri, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
}

export const outsideGate: SpawnGate = { canSpawn: () => true, canRetire: () => true };

export function twoChunkFixture(): { left: MobilityChunk; right: MobilityChunk } {
  const { chunk } = mobilityFixture(), seam = unproject([40, 0], chunk.network.origin);
  const left = structuredClone(chunk), right = structuredClone(chunk);
  left.id = 'cell/left'; right.id = 'cell/right';
  left.bounds[2] = seam[0]; right.bounds[0] = seam[0];
  left.ownedEdges = ['a', 'w']; right.ownedEdges = ['b'];
  left.ports = [
    { ...chunk.ports[0], id: 'left-in' },
    { ...chunk.ports[1], id: 'left-out', edge: 'a', coordinate: seam },
  ];
  right.ports = [
    { ...chunk.ports[0], id: 'right-in', edge: 'b', coordinate: seam },
    { ...chunk.ports[1], id: 'right-out' },
  ];
  const old = [...right.network.origin] as XY, origin = unproject([100, 0], old);
  const convert = (point: XY): XY => project(unproject(point, old), origin);
  const polygon = (value: Polygon2): Polygon2 => value.map(ring => ring.map(convert));
  right.network.origin = origin;
  right.network.buildings = right.network.buildings.map(polygon);
  right.network.water = right.network.water.map(polygon);
  for (const edge of right.network.edges) {
    edge.points = edge.points.map(convert); edge.corridor = edge.corridor.map(polygon);
    edge.conflicts.forEach(conflict => { conflict.zone = 'different-local-zone'; });
  }
  right.network.zones.forEach(zone => { zone.id = 'different-local-zone'; zone.polygon = polygon(zone.polygon); });
  right.zoneIds = { 'different-local-zone': 'junction/right-unstitched' };
  right.surfaces.forEach(surface => { surface.points = surface.points.map(convert); });
  return { left, right };
}
