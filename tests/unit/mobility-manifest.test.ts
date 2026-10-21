import { describe, expect, it } from 'vitest';
import { parseMobilityChunk, parseMobilityManifest, mobilityBudget } from '../../web/core/mobility';
import { mobilityFixture } from '../fixtures/citywide-mobility';

describe('audited citywide mobility publication', () => {
  it('accepts an internally consistent publication without changing its source', () => {
    const { manifest, chunk } = mobilityFixture();
    const before = structuredClone({ manifest, chunk });
    expect(parseMobilityManifest(manifest, manifest.baseDataset)).toEqual(manifest);
    expect(parseMobilityChunk(chunk, manifest.cells[0])).toEqual(chunk);
    expect({ manifest, chunk }).toEqual(before);
  });

  it('does not report incomplete coverage as a successful citywide publication', () => {
    const { manifest } = mobilityFixture();
    for (const patch of [
      { failed: 1 }, { cells: 2 }, { ready: 0 }, { empty: 1 }, { excluded: -1 },
      { driveMetres: 81 }, { walkMetres: 0 }, { failed: Number.NaN },
    ]) {
      expect(() => parseMobilityManifest({
        ...manifest, coverage: { ...manifest.coverage, ...patch },
      }, manifest.baseDataset)).toThrow(/coverage/i);
    }
  });

  it('distinguishes audited empty and excluded cells from failed downloads', () => {
    const { manifest } = mobilityFixture();
    const cell = { ...manifest.cells[0], status: 'empty', resource: undefined, driveMetres: 0, walkMetres: 0 };
    const empty = {
      ...manifest, cells: [cell],
      coverage: { cells: 1, ready: 0, empty: 1, excluded: 0, failed: 0, driveMetres: 0, walkMetres: 0 },
    };
    expect(parseMobilityManifest(empty, manifest.baseDataset).cells[0].status).toBe('empty');
    expect(() => parseMobilityManifest({
      ...empty, cells: [{ ...cell, status: 'failed' }],
    }, manifest.baseDataset)).toThrow();
    const excluded = {
      ...empty, cells: [{ ...cell, status: 'excluded', diagnosticCodes: ['unsupported-elevation'] }],
      coverage: { ...empty.coverage, empty: 0, excluded: 1 },
    };
    expect(parseMobilityManifest(excluded, manifest.baseDataset).cells[0].status).toBe('excluded');
    expect(() => parseMobilityManifest({
      ...excluded, cells: [{ ...excluded.cells[0], diagnosticCodes: [] }],
    }, manifest.baseDataset)).toThrow();
  });

  it('rejects wrong datasets, future formats and invalid resource identities', () => {
    const { manifest } = mobilityFixture();
    expect(() => parseMobilityManifest(manifest, 'other')).toThrow(/dataset/i);
    for (const patch of [
      { version: 2 }, { id: 'not-a-content-id' }, { generatedAt: 'yesterday' },
      { bounds: [121, 31, 120, 32] }, { cells: [] },
      { assets: { ...manifest.assets, uri: 'https://example.com/asset' } },
      { assets: { ...manifest.assets, uri: 'enhancements/../private.json' } },
      { assets: { ...manifest.assets, bytes: 0 } },
      { assets: { ...manifest.assets, sha256: 'not-a-hash' } },
    ]) {
      expect(() => parseMobilityManifest({ ...manifest, ...patch }, manifest.baseDataset)).toThrow();
    }
    for (const uri of ['mobility/%2e%2e/private', 'mobility/a.json?x=1', '/mobility/a.json',
      `mobility/${'b'.repeat(32)}/wrong-release.json`]) {
      const cell = { ...manifest.cells[0], resource: { ...manifest.cells[0].resource!, uri } };
      expect(() => parseMobilityManifest({ ...manifest, cells: [cell] }, manifest.baseDataset)).toThrow();
    }
  });

  it('rejects duplicate cells and missing or asymmetric neighbouring cells', () => {
    const { manifest } = mobilityFixture();
    const cell = manifest.cells[0];
    expect(() => parseMobilityManifest({ ...manifest, cells: [cell, cell] }, manifest.baseDataset)).toThrow();
    expect(() => parseMobilityManifest({
      ...manifest, cells: [{ ...cell, neighbours: ['missing'] }],
    }, manifest.baseDataset)).toThrow(/neighbour/i);
    expect(() => parseMobilityManifest({
      ...manifest, cells: [{ ...cell, neighbours: [cell.id] }],
    }, manifest.baseDataset)).toThrow(/neighbour/i);
  });

  it('requires ready resources and disallows geometry hidden behind empty status', () => {
    const { manifest } = mobilityFixture();
    for (const patch of [{ resource: undefined }, { status: 'empty' }, { driveMetres: -1 },
      { status: 'excluded', resource: undefined }]) {
      expect(() => parseMobilityManifest({
        ...manifest, cells: [{ ...manifest.cells[0], ...patch }],
      }, manifest.baseDataset)).toThrow();
    }
  });

  it('returns separate finite global actor limits for the supported quality levels', () => {
    expect(mobilityBudget('low')).toEqual({ vehicles: 24, pedestrians: 36 });
    expect(mobilityBudget('medium')).toEqual({ vehicles: 60, pedestrians: 90 });
    expect(mobilityBudget('high')).toEqual({ vehicles: 120, pedestrians: 180 });
    const budget = mobilityBudget('medium');
    budget.vehicles = 10000;
    expect(mobilityBudget('medium').vehicles).toBe(60);
  });
});

describe('source-aligned mobility chunks', () => {
  it('rejects mismatched cells, ownership, aliases and disconnected source networks', () => {
    const { manifest, chunk } = mobilityFixture(), cell = manifest.cells[0];
    for (const patch of [
      { version: 2 }, { id: 'cell/other' }, { bounds: [0, 0, 1, 1] },
      { ownedEdges: ['missing'] }, { ownedEdges: ['a', 'a'] }, { ownedEdges: [] },
      { zoneIds: {} }, { zoneIds: { missing: 'physical-zone' } },
      { network: { ...chunk.network, routes: [] } },
      { network: { ...chunk.network, edges: [{ ...chunk.network.edges[0], next: ['missing'] }] } },
    ]) {
      expect(() => parseMobilityChunk({ ...chunk, ...patch }, cell)).toThrow();
    }
  });

  it('validates the geographic seam against the actual local edge endpoint', () => {
    const { manifest, chunk } = mobilityFixture(), cell = manifest.cells[0];
    const port = chunk.ports[0];
    for (const patch of [
      { coordinate: [120, 31] }, { heading: Infinity }, { edge: 'missing' },
      { allowed: ['person-a'] }, { links: [{ cell: 'cell/other', port: 'seam' }] },
      { at: 'middle' }, { allowed: [] }, { coordinate: [NaN, 31] },
    ]) {
      expect(() => parseMobilityChunk({ ...chunk, ports: [{ ...port, ...patch }] }, cell)).toThrow();
    }
    expect(() => parseMobilityChunk({ ...chunk, ports: [port, port] }, cell)).toThrow();
  });

  it('does not accept invalid or duplicated visible surfaces', () => {
    const { manifest, chunk } = mobilityFixture(), cell = manifest.cells[0], surface = chunk.surfaces[0];
    for (const patch of [
      { points: [[0, 0]] }, { points: [[0, 0], [0, 0]] }, { width: 0 }, { height: -1 },
      { mode: 'fly' }, { sourceIds: [] }, { sourceIds: ['invented'] },
      { points: [[0, 0], [NaN, 0]] }, { inferred: [] },
    ]) {
      expect(() => parseMobilityChunk({ ...chunk, surfaces: [{ ...surface, ...patch }] }, cell)).toThrow();
    }
    expect(() => parseMobilityChunk({ ...chunk, surfaces: [surface, surface] }, cell)).toThrow();
  });
});
