import type { ArchitectureAddition, LandmarkDefinition, SkylineFamily } from './landmarks';
import type { Bounds, BuildingFeature } from './types';

const west = (sourceId: string, id: string, name: string, height: number, bounds: Bounds, skyline: SkylineFamily): LandmarkDefinition => ({
  sourceId: `way/${sourceId}`, id, name, height, heightBasis: 'source', bounds, skyline,
  approximation: '总高保留冻结 OSM 标注；沿原始轮廓重建幕墙分格、楼层带和屋顶收边，细部与塔冠比例为示意，非建筑测绘。',
  sources: [{ label: 'OpenStreetMap · 原始轮廓与高度', url: `https://www.openstreetmap.org/way/${sourceId}` }],
});
const hongLeong = (sourceId: string, id: string, name: string, height: number, bounds: Bounds): LandmarkDefinition => ({
  sourceId: `way/${sourceId}`, id, name, height, heightBasis: 'verified', bounds, skyline: 'hong-leong',
  approximation: '建筑师项目资料：两座约 150 m 办公/酒店塔楼、两座约 100 m 公寓。按独立 OSM 塔楼轮廓匹配；水平带、玻璃幕墙及顶部细节为照片比例近似，原始默认高度保留。',
  sources: [
    { label: 'Aedas · 项目实景与布局', url: 'https://www.aedas.com/en/project/hong-leong-city-center/' },
    { label: 'Aedas 项目申报 · 150 m / 100 m', url: 'https://www.credaward.com/zh/project/178708/' },
  ],
});
const media = (sourceId: string, id: string, name: string, height: number, bounds: Bounds, wing = false): LandmarkDefinition => ({
  sourceId: `way/${sourceId}`, id, name, height, heightBasis: wing ? 'estimated' : 'verified', bounds,
  skyline: wing ? 'media-wing' : 'media',
  approximation: wing
    ? `${height} m 低翼高度按建筑师实景楼层比例估算；不将低翼整体拔高到主塔高度。弧形转接、错列遮阳板和幕墙分格为近似。`
    : '南主塔 214.8 m、北酒店塔 164.9 m 依据项目业主；高塔与低翼分别建模，弧形转接及错列遮阳幕墙为照片比例近似，原始默认高度保留。',
  sources: [
    { label: '苏州广电 · 双塔高度', url: 'https://www.csztv.cn/doc/2017/04/28/56127.shtml' },
    { label: '日建设计 · 建筑实景与 L 形组合', url: 'https://cn.nikken.jp/projects/mixed_use/suzhou_modern_media_plaza.html' },
  ],
});

export const suzhouEye: LandmarkDefinition = {
  sourceId: 'way/1332906658', id: 'suzhou-eye', name: '苏州之眼', height: 128, heightBasis: 'verified',
  bounds: [120.707673, 31.3160001, 120.7088632, 31.3168759],
  approximation: '新版 128 m、28 个轿厢依据官方资料；独立采集 attraction=big_wheel，不冒充原始建筑数据。双轮圈、索辐、A 形支架及椭球轿厢按实景近似，朝向和结构尺寸非测绘；静态展示。',
  source: {
    type: 'osm-attraction', timestamp: '2026-10-19T06:43:15Z',
    tags: { attraction: 'big_wheel', name: '苏州之眼' },
  },
  sources: [
    { label: '苏州市文广旅局 · 128 m / 28 轿厢', url: 'https://wglj.suzhou.gov.cn/szwhgdhlyj/hcgdkd/202510/6356e9b9300d4afd91213f9304112ff7.shtml' },
    { label: '苏州工业园区 · 新版摩天轮实景', url: 'https://www.sipac.gov.cn/szgyyq/dthg202503/202503/f4a439596a8c432dba1cb8e996939969.shtml' },
    { label: 'OpenStreetMap · 独立景点轮廓', url: 'https://www.openstreetmap.org/way/1332906658' },
  ],
};

export const jinjiLandmarks: readonly LandmarkDefinition[] = [
  west('462717395', 'global-188-b', '环球188 B座', 240, [120.6649377, 31.3156303, 120.6653945, 31.3160241], 'global'),
  west('462717396', 'global-188-a', '环球188 A座', 282, [120.6660381, 31.3157262, 120.6665237, 31.3161621], 'global'),
  west('462717408', 'fortune-b', '兆润财富中心 B座', 169, [120.6690156, 31.3174856, 120.6697335, 31.3178279], 'fortune'),
  west('462717409', 'fortune-a', '兆润财富中心 A座', 230, [120.6683103, 31.3170813, 120.6689633, 31.3174319], 'fortune'),
  west('461664710', 'phoenix-west', '凤凰文化广场西楼', 145, [120.6621878, 31.317202, 120.6626089, 31.3177462], 'phoenix'),
  west('461664711', 'phoenix-east', '凤凰文化广场东楼', 200, [120.663592, 31.3174627, 120.6641445, 31.3179685], 'phoenix'),
  west('462717390', 'suzhou-center-1', '苏州中心1号楼', 221.6, [120.6730898, 31.3160702, 120.6735686, 31.3165199], 'center'),
  west('462717391', 'suzhou-center-2', '苏州中心2号楼', 194.7, [120.6739604, 31.3158109, 120.674441, 31.3162485], 'center'),
  west('462717385', 'suzhou-center-4', '苏州中心4号楼', 160.3, [120.6724548, 31.3208655, 120.6730325, 31.3214193], 'center'),
  west('462717384', 'suzhou-center-5', '苏州中心5号楼', 132.9, [120.6734735, 31.3216043, 120.6740053, 31.322118], 'center'),
  west('462717392', 'suzhou-center-6', '苏州中心6号楼', 107.8, [120.6741041, 31.3206738, 120.6745865, 31.3211877], 'center'),
  hongLeong('522129366', 'hong-leong-southwest', '丰隆城市中心 · 西南公寓', 100, [120.7109275, 31.3186026, 120.7116234, 31.3191966]),
  hongLeong('522129367', 'hong-leong-northwest', '丰隆城市中心 · 西北公寓', 100, [120.7117426, 31.3193142, 120.7122971, 31.3197828]),
  hongLeong('482784886', 'hong-leong-northeast', '丰隆城市中心 · 东北塔楼', 150, [120.7130445, 31.319401, 120.7137415, 31.3199994]),
  hongLeong('482789311', 'hong-leong-southeast', '丰隆城市中心 · 东南塔楼', 150, [120.7132728, 31.3186938, 120.7138024, 31.3191395]),
  media('494180282', 'modern-media-south', '现代传媒广场 · 南主塔', 214.8, [120.7293729, 31.3251321, 120.7300119, 31.3255918]),
  media('494180284', 'modern-media-north', '现代传媒广场 · 北酒店塔', 164.9, [120.7307483, 31.326005, 120.7313694, 31.326387]),
  media('494180283', 'modern-media-south-wing', '现代传媒广场 · 南低翼', 44, [120.7293729, 31.3251321, 120.7314758, 31.3257448], true),
  media('494180285', 'modern-media-north-wing', '现代传媒广场 · 北低翼', 38, [120.7296213, 31.3258814, 120.7313694, 31.326387], true),
  suzhouEye,
];

// Separate snapshot: the building-only collection does not contain this attraction.
export function architectureSupplements(sourceDataset: string): { features: BuildingFeature[]; additions: ArchitectureAddition[] } {
  if (sourceDataset !== 'c8a953228b2ff6af') return { features: [], additions: [] };
  return {
    features: [{
      type: 'Feature',
      properties: { id: suzhouEye.sourceId, name: suzhouEye.name, kind: 'attraction:big_wheel', height: 128, basis: 'reference', estimated: false },
      geometry: { type: 'Polygon', coordinates: [[
        [120.7085976, 31.3168759], [120.707673, 31.316811], [120.707722, 31.3166795],
        [120.7079148, 31.3165256], [120.7081187, 31.3163636], [120.7085416, 31.3161626],
        [120.7088632, 31.3160001], [120.7088256, 31.3166857], [120.7085976, 31.3168759],
      ]] },
    }],
    additions: [{ id: suzhouEye.sourceId, kind: 'attraction',
      evidence: 'OSM way/1332906658: attraction=big_wheel; name=苏州之眼; separate snapshot 2026-10-19T06:43:15Z. Height 128 m from Suzhou culture and tourism authority, not an OSM height tag.' }],
  };
}
