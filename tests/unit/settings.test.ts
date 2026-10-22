import { describe, expect, it } from 'vitest';
import { defaultSettings, parseSettings, encodeSettings } from '../../web/core/settings';

describe('scene configuration', () => {
  it('preserves saved v1 choices while adding documented mobility defaults', () => {
    const old = { version: 1, night: false, glow: 0, quality: 'low',
      buildings: false, roads: true, water: true, green: false, boundary: false, labels: true };
    expect(parseSettings(JSON.stringify(old))).toEqual({
      ...old, version: 2, vehicles: true, pedestrians: true, mobilityPaused: false,
    });
  });
  it.each(['vehicles', 'pedestrians', 'mobilityPaused'])('rejects missing or malformed v2 %s', key => {
    const missing: Record<string, unknown> = { ...defaultSettings, version: 2 };
    delete missing[key];
    expect(() => parseSettings(JSON.stringify(missing))).toThrow();
    expect(() => parseSettings(JSON.stringify({ ...defaultSettings, version: 2, [key]: 'yes' }))).toThrow();
  });
  it('round-trips independent vehicle, pedestrian and pause choices as v2', () => {
    const saved = { ...defaultSettings, vehicles: false, pedestrians: true, mobilityPaused: true };
    expect(JSON.parse(encodeSettings(saved)).version).toBe(2);
    expect(parseSettings(encodeSettings(saved))).toEqual(saved);
  });
  it('does not interpret an incomplete v1 configuration as valid migration input', () => {
    expect(() => parseSettings(JSON.stringify({ version: 1, night: false }))).toThrow();
  });
  it('starts and resets at 80% without overwriting an explicit saved brightness', () => {
    expect(parseSettings(encodeSettings(defaultSettings)).glow).toBe(0.8);
    for (const glow of [0, 0.35, 0.55, 1]) {
      expect(parseSettings(encodeSettings({ ...defaultSettings, glow })).glow).toBe(glow);
    }
  });
  it('round-trips user controls without altering real geographic data', () => {
    const settings = { ...defaultSettings, night: false, glow: 0.75, buildings: false };
    expect(parseSettings(encodeSettings(settings))).toEqual(settings);
  });
  it('rejects corrupt JSON and invalid persisted values with an actionable error', () => {
    expect(() => parseSettings('{')).toThrow();
    expect(() => parseSettings(JSON.stringify({ ...defaultSettings, glow: -1 }))).toThrow();
    expect(() => parseSettings(JSON.stringify({ ...defaultSettings, night: 'yes' }))).toThrow();
    expect(() => parseSettings(JSON.stringify({ ...defaultSettings, quality: 'ultra' }))).toThrow();
  });
  it('refuses future configuration versions instead of silently misreading them', () => {
    expect(() => parseSettings(JSON.stringify({ ...defaultSettings, version: 99 }))).toThrow();
  });
});
