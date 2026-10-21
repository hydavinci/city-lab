import { createHash } from 'node:crypto';
import type { MobilityChunk, MobilityManifest, MobilityResource, SpawnGate } from '../../web/core/mobility';
import { network } from './enhancements';
import { unproject } from '../../pipeline/enhancements/geometry';

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
