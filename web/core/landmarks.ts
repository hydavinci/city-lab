import type { Bounds, BuildingFeature, BuildingProperties } from './types';
import { jinjiLandmarks } from './jinji-landmarks';

export type SkylineFamily = 'global' | 'fortune' | 'phoenix' | 'center' | 'hong-leong' | 'media' | 'media-wing';

export interface LandmarkModel {
  id: string;
  name: string;
  height: number;
  heightBasis: 'verified' | 'source' | 'estimated';
  approximation: string;
  sources: { label: string; url: string }[];
  source?: { type: 'osm-attraction'; timestamp: string; tags: { attraction: 'big_wheel'; name: string } };
}

export interface LandmarkDefinition extends LandmarkModel {
  sourceId: string;
  bounds: Bounds;
  skyline?: SkylineFamily;
}

export interface SelectedBuilding extends BuildingProperties {
  model?: LandmarkModel;
}

export interface ArchitectureExclusion {
  id: string;
  reason: 'underground';
  evidence: string;
}

export interface ArchitectureAddition {
  id: string;
  kind: 'attraction';
  evidence: string;
}

// These are identity checks against the frozen OSM outlines, not replacement footprints.
export const landmarks: readonly LandmarkDefinition[] = [
  {
    sourceId: 'way/933819302', id: 'gate-to-the-east', name: '东方之门', height: 301.8, heightBasis: 'verified',
    bounds: [120.6740306, 31.3181098, 120.6754362, 31.3197738],
    approximation: '总高依据 CTBUH；双塔曲线、门洞比例、进深和幕墙分格按建筑师资料近似重建，非测绘模型。',
    sources: [
      { label: 'CTBUH · 301.8 m', url: 'https://www.skyscrapercenter.com/building/gate-to-the-east/499' },
      { label: 'RMJM · 建筑设计', url: 'https://rmjm.com/portfolio/gate-to-the-east-china/' },
    ],
  },
  {
    sourceId: 'way/480395603', id: 'suzhou-center', name: '苏州中心商场', height: 42, heightBasis: 'estimated',
    bounds: [120.6723878, 31.3165711, 120.6755712, 31.3212553],
    approximation: '42 m 屋盖总高、北部曲面屋盖、采光庭院与南部退台均为按楼层和实景比例的估算；周边塔楼保持独立。',
    sources: [
      { label: 'Benoy · 屋盖与商场', url: 'https://www.benoy.com/projects/suzhou-centre/' },
      { label: 'Nikken Sekkei · 实景与总体布局', url: 'https://www.nikken.co.jp/en/projects/urban_design_and_planning/suzhou_center.html' },
    ],
  },
  {
    sourceId: 'way/477238586', id: 'suzhou-ifs', name: '苏州国金中心', height: 452, heightBasis: 'verified',
    bounds: [120.7122441, 31.3239156, 120.7129938, 31.3244553],
    approximation: '452 m 采用 KPF 建筑师数据，保留 OSM 的 450 m；曲面收分、微扭转和鱼尾塔冠为照片比例近似。',
    sources: [{ label: 'KPF · 452 m 与鱼尾形态', url: 'https://www.kpf.com/project/suzhou-international-finance-square' }],
  },
  {
    sourceId: 'way/206076447', id: 'beisi-pagoda', name: '北寺塔', height: 76, heightBasis: 'verified',
    bounds: [120.6152156, 31.3243837, 120.6155881, 31.3247019],
    approximation: '八角九层、76 m 依据官方介绍；木构外廊、出檐、斗拱与塔刹细部按实景近似，不代表修缮测绘。',
    sources: [{ label: '苏州市委统战部 · 八角九层 76 m', url: 'https://tzb.suzhou.gov.cn/tzb/mzzj/201803/caf87145236e492d83e626997e0ba8a4.shtml' }],
  },
  {
    sourceId: 'way/206069300', id: 'tiger-hill-pagoda', name: '虎丘塔', height: 48, heightBasis: 'source',
    bounds: [120.5762701, 31.3379168, 120.5764387, 31.3380612],
    approximation: '总高保留 OSM 的 48 m；七层砖构、短叠涩檐与拱龛按官方资料近似。东北向 2.3 m 偏移是历史记录的示意，不是现状倾斜测量。',
    sources: [
      { label: '苏州园林局 · 七层砖塔构造', url: 'https://ylj.suzhou.gov.cn/szsylj/ylwh/201604/f3f52d3ee502486b8a4873c36b0d24e0.shtml' },
      { label: '工程资料 · 历史倾斜记录', url: 'https://www.geoseu.cn/yanjiuyuan/guta_taji_shuiniguanjiang_jiagu_.html' },
    ],
  },
  {
    sourceId: 'way/608471429', id: 'ruiguang-pagoda', name: '瑞光塔', height: 53.57, heightBasis: 'verified',
    bounds: [120.6143047, 31.2912223, 120.6145614, 31.291441],
    approximation: '53.57 m 总高含 9.14 m 塔刹，依据盘门景区；七层木檐、首层外廊和檐角比例按实景近似，非测绘模型。',
    sources: [{ label: '盘门景区 · 总高与塔刹', url: 'https://www.panmen.com.cn/About/1.html' }],
  },
  ...jinjiLandmarks,
];

export function landmarkFor(feature: BuildingFeature): LandmarkDefinition | undefined {
  const landmark = landmarks.find(record => record.sourceId === feature.properties.id);
  if (!landmark) return undefined;
  assertSourceBounds(feature, landmark.bounds);
  return landmark;
}

function assertSourceBounds(feature: BuildingFeature, expected: Bounds): void {
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const points = polygons.flat(2);
  const bounds = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
    Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
  if (bounds.some((value, axis) => !Number.isFinite(value) || Math.abs(value - expected[axis]) > 0.00002)) {
    throw new Error(`Landmark source footprint changed; review its identity and proportions: ${feature.properties.id}`);
  }
}

export function landmarkModel(landmark: LandmarkDefinition): LandmarkModel {
  const { id, name, height, heightBasis, approximation, sources, source } = landmark;
  return { id, name, height, heightBasis, approximation, sources, ...(source ? { source } : {}) };
}

export function parseLandmarkModel(input: unknown, sourceId: string): LandmarkModel | undefined {
  if (input === undefined || input === '') return undefined;
  const definition = landmarks.find(record => record.sourceId === sourceId);
  const model = definition && landmarkModel(definition);
  if (!model || input !== JSON.stringify(model)) throw new Error('Invalid or outdated architecture model metadata.');
  return model;
}

export function architectureExclusionFor(feature: BuildingFeature): ArchitectureExclusion | undefined {
  if (feature.properties.id !== 'relation/16109091') return undefined;
  assertSourceBounds(feature, [120.6723354, 31.3180554, 120.6764728, 31.3207277]);
  return { id: feature.properties.id, reason: 'underground',
    evidence: 'Frozen OSM relation/16109091: layer=-1; location=underground. No above-ground station mass.' };
}
