import { describe, expect, it } from 'vitest';
import { defaultSettings, parseSettings, encodeSettings } from '../../web/core/settings';

describe('scene configuration', () => {
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
