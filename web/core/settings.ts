import type { SceneSettings } from './types';

export const defaultSettings: SceneSettings = {
  version: 1, night: true, glow: 0.55, quality: 'medium',
  buildings: true, roads: true, water: true, green: true, boundary: true, labels: true,
};
export const SETTINGS_KEY = 'suzhou-city-lab.settings.v1';

export function parseSettings(text: string): SceneSettings {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object') throw new Error('配置必须是 JSON 对象。');
  const data = value as Record<string, unknown>;
  if (data.version !== 1) throw new Error('不支持的配置版本，请导入本应用导出的 v1 配置。');
  const booleanKeys = ['night', 'buildings', 'roads', 'water', 'green', 'boundary', 'labels'] as const;
  for (const key of booleanKeys) {
    if (typeof data[key] !== 'boolean') throw new Error(`配置字段 ${key} 必须为布尔值。`);
  }
  if (typeof data.glow !== 'number' || !Number.isFinite(data.glow) || data.glow < 0 || data.glow > 1) {
    throw new Error('灯光强度必须在 0 到 1 之间。');
  }
  if (!['low', 'medium', 'high'].includes(String(data.quality))) throw new Error('不支持的画质档位。');
  return {
    version: 1, night: data.night as boolean, glow: data.glow,
    quality: data.quality as SceneSettings['quality'],
    buildings: data.buildings as boolean, roads: data.roads as boolean,
    water: data.water as boolean, green: data.green as boolean,
    boundary: data.boundary as boolean, labels: data.labels as boolean,
  };
}

export function encodeSettings(settings: SceneSettings): string {
  return JSON.stringify(settings, null, 2);
}
