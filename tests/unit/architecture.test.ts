import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { architectureLod, parseArchitectureManifest } from '../../web/core/architecture';

const fixture = async () => JSON.parse(await readFile('public/architecture/manifest.json', 'utf8'));

describe('architectural package validation', () => {
  it('accepts the published source-linked package without losing metadata', async () => {
    const source = await fixture();
    expect(parseArchitectureManifest(source, source.baseDataset)).toEqual(source);
  });
  it.each([
    'dataset', 'origin', 'bounds', 'empty', 'duplicate', 'height', 'basis', 'estimated',
    'inferred', 'path', 'absolute', 'package', 'hash', 'bytes', 'budget', 'triangles', 'version',
  ])('rejects invalid %s before any base-building replacement', async kind => {
    const value = await fixture();
    if (kind === 'dataset') value.baseDataset = 'wrong-source';
    if (kind === 'origin') value.origin = [181, 0];
    if (kind === 'bounds') value.bounds = [120, 32, 120, 31];
    if (kind === 'empty') value.buildings = [];
    if (kind === 'duplicate') value.buildings.push(value.buildings[0]);
    if (kind === 'height') value.buildings[0].height = -1;
    if (kind === 'basis') value.buildings[0].basis = 'inferred-survey';
    if (kind === 'estimated') value.buildings[0].estimated = false;
    if (kind === 'inferred') value.inferred = [];
    if (kind === 'path') value.lods.near.uri = '../near.glb';
    if (kind === 'absolute') value.lods.near.uri = 'https://example.com/near.glb';
    if (kind === 'package') value.lods.far.uri = `${'a'.repeat(32)}/far.glb`;
    if (kind === 'hash') value.lods.near.sha256 = 'invalid';
    if (kind === 'bytes') value.lods.near.bytes = 0;
    if (kind === 'budget') value.lods.near.bytes = 16 * 1024 * 1024;
    if (kind === 'triangles') value.lods.near.triangles = 300000;
    if (kind === 'version') value.version = 2;
    expect(() => parseArchitectureManifest(value, 'c8a953228b2ff6af')).toThrow(/architecture/i);
  });
  it.each([null, [], 4, 'manifest', {}])('rejects malformed root %s', value => {
    expect(() => parseArchitectureManifest(value, 'source')).toThrow(/architecture/i);
  });
});

describe('architectural LOD thresholds', () => {
  it('uses near, far and unload distances with transition hysteresis', () => {
    expect(architectureLod(350)).toBe('near');
    expect(architectureLod(351)).toBe('far');
    expect(architectureLod(6000)).toBe('far');
    expect(architectureLod(6001)).toBeUndefined();
    expect(architectureLod(400, 'near')).toBe('near');
    expect(architectureLod(401, 'near')).toBe('far');
    expect(architectureLod(320, 'far')).toBe('far');
    expect(architectureLod(300, 'far')).toBe('near');
    expect(architectureLod(6500, 'far')).toBe('far');
    expect(architectureLod(6501, 'far')).toBeUndefined();
  });
  it('keeps low quality on the silhouette LOD and rejects invalid distances', () => {
    expect(architectureLod(50, 'near', 'low')).toBe('far');
    expect(architectureLod(7000, 'far', 'low')).toBeUndefined();
    for (const distance of [NaN, Infinity, -1]) expect(() => architectureLod(distance)).toThrow();
  });
});
