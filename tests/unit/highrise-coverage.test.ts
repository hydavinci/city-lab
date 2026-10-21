import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildHighriseCoverage } from '../../pipeline/architecture/highrise-coverage';
import { highriseCandidates, highriseRegions, type HighriseCandidate } from '../../web/core/suzhou-highrises';
import type { BuildingFeature } from '../../web/core/types';

const features: BuildingFeature[] = readdirSync('public/data/c8a953228b2ff6af/tiles').flatMap(file =>
  JSON.parse(readFileSync(`public/data/c8a953228b2ff6af/tiles/${file}`, 'utf8')).features);
const report = () => buildHighriseCoverage(features);
const candidate = (): HighriseCandidate => structuredClone(highriseCandidates.find(row => row.id === 'ctbuh-43634')!);

describe('citywide public high-rise coverage', () => {
  it('publishes every reporting region without implying an exhaustive baseline or a coverage percentage', () => {
    const result = report();
    expect(result.baselineComplete).toBe(false);
    expect(result.scope.minimumHeight).toBe(100);
    expect(Object.keys(result.regions).sort()).toEqual([...highriseRegions].sort());
    expect(result).not.toHaveProperty('coveragePercent');
    expect(result.totals.candidates).toBe(result.entries.length);
    expect(Object.values(result.regions).reduce((sum, region) => sum + region.candidates, 0)).toBe(result.entries.length);
    expect(Object.values(result.regions).every(region => region.exhaustive === false)).toBe(true);
    expect(result.regions.changshu.gapsByReason['missing-footprint']).toBe(1);
    expect(result.regions.xiangcheng.gapsByReason['merged-podium']).toBe(1);
    expect(result.regions.wujiang.gapsByReason['height-conflict']).toBe(1);
    for (const region of Object.values(result.regions)) {
      expect(Object.values(region.gapsByReason).reduce((sum, count) => sum + count, 0)).toBe(region.gaps);
    }
  });

  it('counts actual reference towers, preserving source heights and treating residential approximation honestly', () => {
    const result = report();
    for (const id of ['ctbuh-18927', 'ctbuh-43634', 'ctbuh-43597']) {
      expect(result.entries.find(row => row.id === id)).toMatchObject({ coverage: 'reference', originalHeight: 12.8 });
    }
    expect(result.totals.reference).toBe(12);
    expect(result.entries.find(row => row.id === 'reference-way-482784883')).toMatchObject({
      coverage: 'reference', use: 'residential', height: 100, approximate: true,
    });
    expect(result.sourceOnly.some(row => row.basis === 'levels')).toBe(true);
    expect(result.sourceOnly.every(row => row.height >= 100 && row.completionVerified === false)).toBe(true);
    expect(result.entries.find(row => row.id === 'ctbuh-30255')).toMatchObject({
      coverage: 'gap', gap: 'height-conflict', height: 209, originalHeight: 121.6,
    });
  });

  it('does not promote merged podiums, missing outlines, unfinished proposals or whole residential projects', () => {
    const result = report();
    for (const id of ['ctbuh-41266', 'ctbuh-19852', 'ctbuh-43600', 'ctbuh-51041',
      'ctbuh-16063', 'ctbuh-12402', 'ctbuh-12403', 'kunshan-butterfly-bay', 'kunshan-gcl']) {
      expect(result.entries.find(row => row.id === id)?.coverage).toBe('gap');
    }
    expect(result.entries.find(row => row.id === 'ctbuh-12402')?.status).toBe('planned');
    expect(result.entries.find(row => row.id === 'kunshan-gcl')?.heightKind).toBe('ceiling');
    expect(result.entries.filter(row => row.id.startsWith('kunshan-butterfly-bay'))).toHaveLength(1);
  });

  it('rejects duplicate tower identities, unknown sources, unsupported coverage and invalid evidence', () => {
    const row = candidate();
    expect(() => buildHighriseCoverage(features, [row, row])).toThrow(/duplicate/i);
    expect(() => buildHighriseCoverage(features, [row, { ...row, id: 'another' }])).toThrow(/duplicate/i);
    expect(() => buildHighriseCoverage(features, [{ ...row, sourceId: 'way/99999999999' }])).toThrow(/missing/i);
    expect(() => buildHighriseCoverage(features, [{ ...row, status: 'planned' }])).toThrow(/completed/i);
    expect(() => buildHighriseCoverage(features, [{ ...row, height: 99.9 }])).toThrow(/height/i);
    expect(() => buildHighriseCoverage(features, [{ ...row, height: 189 }])).toThrow(/height/i);
    expect(() => buildHighriseCoverage(features, [{ ...row, sources: [] }])).toThrow(/evidence/i);
    expect(() => buildHighriseCoverage(features, [{ ...row, sources: [{ label: 'unsafe', url: 'http://example.com' }] }]))
      .toThrow(/evidence/i);
  });

  it('keeps unknown completion and height-only ceilings out of covered stock', () => {
    const row = candidate();
    for (const patch of [{ status: 'unknown' as const }, { status: 'under-construction' as const },
      { heightKind: 'ceiling' as const }, { height: undefined }]) {
      const gap: HighriseCandidate = { ...row, ...patch, match: undefined, gap: 'unverified-identity' };
      expect(buildHighriseCoverage(features, [gap]).entries[0].coverage).toBe('gap');
    }
  });
});
