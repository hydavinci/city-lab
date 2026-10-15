import { BoundingSphere, Cartesian3, HeadingPitchRange } from 'cesium';
import { CityScene, fetchJSON } from '../../web/scene/CityScene';
import { defaultSettings } from '../../web/core/settings';
import type { CityManifest } from '../../web/core/types';

declare global {
  interface Window {
    clarity: { scene: CityScene; ready: Promise<void>; near: () => Promise<void>; errors: string[] };
  }
}

const errors: string[] = [];
const manifest = await fetchJSON<CityManifest>('/data/manifest.json');
const scene = new CityScene(document.getElementById('scene')!, manifest, { ...defaultSettings }, {
  onStats: () => {}, onSelect: () => {}, onError: (message) => errors.push(message),
});
window.clarity = {
  scene, errors, ready: scene.initialize(),
  near: async () => {
    scene.viewer.camera.flyToBoundingSphere(
      new BoundingSphere(Cartesian3.fromDegrees(120.667, 31.316), 30),
      { duration: 0, offset: new HeadingPitchRange(0.4, -0.45, 1700) },
    );
    await scene.screenshot();
  },
};
