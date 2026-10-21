import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildingFeature, CityManifest } from '../../web/core/types';
import { landmarkFor } from '../../web/core/landmarks';
import { referenceHeightFor } from '../../web/core/building-heights';
import { highriseCandidates, highriseRegions, type HighriseGap } from '../../web/core/suzhou-highrises';

const gapReasons: readonly HighriseGap[] = [
  'missing-footprint', 'merged-podium', 'height-conflict', 'unverified-identity',
  'completion-unverified', 'height-unverified', 'not-completed',
];

export function buildHighriseCoverage(features: readonly BuildingFeature[], candidates = highriseCandidates) {
  const indexed = new Map(features.map(feature => [feature.properties.id, feature]));
  if (indexed.size !== features.length) throw new Error('Duplicate source building identity.');
  const ids = new Set<string>(), sources = new Set<string>();
  const entries = candidates.map(candidate => {
    if (ids.has(candidate.id) || candidate.sourceId && sources.has(candidate.sourceId)) {
      throw new Error(`Duplicate high-rise candidate identity: ${candidate.id}`);
    }
    ids.add(candidate.id);
    if (candidate.sourceId) sources.add(candidate.sourceId);
    if (!candidate.id.trim() || !candidate.name.trim() || !candidate.note.trim()
      || !highriseRegions.includes(candidate.region) || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.checkedAt)
      || !Number.isFinite(Date.parse(candidate.checkedAt))
      || !candidate.sources.length || candidate.sources.some(source =>
        !source.label.trim() || !/^https:\/\/[^/\s]+\/\S*$/.test(source.url))) {
      throw new Error(`Invalid high-rise candidate evidence: ${candidate.id}`);
    }
    if (candidate.height !== undefined && (!Number.isFinite(candidate.height) || candidate.height <= 0 || candidate.height > 1000)) {
      throw new Error(`Invalid candidate height: ${candidate.id}`);
    }
    const feature = candidate.sourceId ? indexed.get(candidate.sourceId) : undefined;
    if (candidate.sourceId && !feature) throw new Error(`Missing high-rise source: ${candidate.sourceId}`);
    let coverage: 'reference' | 'landmark' | 'source' | 'gap' = 'gap';
    if (candidate.match) {
      if (candidate.status !== 'completed') throw new Error(`Coverage requires completed evidence: ${candidate.id}`);
      if (!feature || candidate.gap || candidate.height === undefined || candidate.height < 100
        || candidate.heightKind === 'ceiling' || candidate.heightKind === 'unknown') {
        throw new Error(`Invalid covered height or footprint: ${candidate.id}`);
      }
      const landmark = landmarkFor(feature), reference = referenceHeightFor(feature);
      const height = candidate.match === 'landmark' ? landmark?.height : candidate.match === 'reference'
        ? !landmark && reference?.height : !landmark && !reference && feature.properties.basis === 'height'
          ? feature.properties.height : undefined;
      if (height !== candidate.height) throw new Error(`Covered height does not match rendered evidence: ${candidate.id}`);
      if (reference && Boolean(candidate.approximate) !== Boolean(reference.approximate)) {
        throw new Error(`Covered height precision mismatch: ${candidate.id}`);
      }
      coverage = candidate.match;
    } else if (!candidate.gap) throw new Error(`Missing high-rise gap evidence: ${candidate.id}`);
    return {
      ...structuredClone(candidate), coverage,
      ...(feature ? { originalHeight: feature.properties.height, originalBasis: feature.properties.basis,
        renderedHeight: landmarkFor(feature)?.height ?? referenceHeightFor(feature)?.height ?? feature.properties.height } : {}),
    };
  });
  const counts = (rows: typeof entries) => ({
    candidates: rows.length,
    reference: rows.filter(row => row.coverage === 'reference').length,
    landmark: rows.filter(row => row.coverage === 'landmark').length,
    source: rows.filter(row => row.coverage === 'source').length,
    gaps: rows.filter(row => row.coverage === 'gap').length,
    gapsByReason: Object.fromEntries(gapReasons.map(reason =>
      [reason, rows.filter(row => row.coverage === 'gap' && row.gap === reason).length])),
  });
  const regions = Object.fromEntries(highriseRegions.map(region => [region, {
    ...counts(entries.filter(row => row.region === region)), exhaustive: false,
    limitation: '公开候选清单非权威完整基线；未列出的建筑、住宅及缺少独立轮廓的塔楼仍可能遗漏。0 条核实不代表该区域无高楼。',
  }]));
  const sourceOnly = features.filter(feature => feature.properties.height >= 100 && !sources.has(feature.properties.id)
    && !landmarkFor(feature)).map(feature => ({
    ...feature.properties, completionVerified: false,
    note: '仅冻结 OSM 高度或楼层推算达到阈值；未外部核实身份、建成状态或实际总高，不计为已核实覆盖。',
  })).sort((a, b) => a.id.localeCompare(b.id));
  const existingLandmarks = features.flatMap(feature => {
    const landmark = landmarkFor(feature);
    return landmark && landmark.height >= 100 ? [{
      sourceId: landmark.sourceId, name: landmark.name, height: landmark.height, heightBasis: landmark.heightBasis,
      sources: landmark.sources, note: '沿用已有地标，不冒充本轮独立核实的全市存量；原模型来源与近似说明保持不变。',
    }] : [];
  });
  return {
    version: 1, scope: { municipality: 'Suzhou prefecture', minimumHeight: 100, uses: 'all, residential included',
      completedOnly: true, industrialTestTowers: 'separately classified; not ordinary occupied buildings' },
    baselineComplete: false, checkedAt: '2026-10-20',
    limitations: [
      '没有可复核的全市逐栋权威完整基线，不发布覆盖率或宣称所有高楼已补齐。',
      '候选数包含待核实的项目线索，不能等同于实际塔楼数；高度上限不等于实际高度。',
      'CTBUH 公开地图坐标按 Esri/OSM 底图解释为 WGS84 兼容，出版方未明确声明基准；不据最近距离自动匹配。',
      '未知与旧在建报道不代表当前仍在建；未核实完工的候选不新增为建成模型。',
      '原始 OSM 中可能已有未建成项目的设计高度，原值保留但不计为已核实建成覆盖。',
    ],
    regions, totals: counts(entries), entries, existingLandmarks, sourceOnly,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = resolve('public/data'), output = resolve('public/highrises');
  const manifestText = await readFile(join(input, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as CityManifest;
  if (manifest.version !== 1 || !/^[\w-]+$/.test(manifest.dataset)) throw new Error('Invalid coverage source manifest.');
  const hash = createHash('sha256').update(manifestText), features: BuildingFeature[] = [];
  for (const tile of [...manifest.tiles].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!/^[\w-]+$/.test(tile.id)) throw new Error('Invalid coverage source tile.');
    const text = await readFile(join(input, manifest.dataset, 'tiles', `${tile.id}.json`), 'utf8');
    hash.update(text);
    const collection = JSON.parse(text) as { features: BuildingFeature[] };
    if (collection.features.length !== tile.count) throw new Error(`Coverage source count mismatch: ${tile.id}`);
    features.push(...collection.features);
  }
  if (features.length !== manifest.counts.buildings) throw new Error('Coverage source total mismatch.');
  const report = { ...buildHighriseCoverage(features), source: {
    dataset: manifest.dataset, buildings: features.length, tiles: manifest.tiles.length, sha256: hash.digest('hex'),
  } };
  await mkdir(output, { recursive: true });
  const temporary = join(output, `coverage.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, join(output, 'coverage.json'));
  console.log(JSON.stringify({ ...report.totals, sourceOnly: report.sourceOnly.length, baselineComplete: false }));
}
