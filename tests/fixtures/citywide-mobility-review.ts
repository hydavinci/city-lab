import './landmark-review';
import { Cartesian3, HeadingPitchRange, Matrix4 } from 'cesium';
import { MobilityLayer } from '../../web/scene/MobilityLayer';
import type { MobilityWorld } from '../../web/core/mobility-world';

function activity(): MobilityLayer {
  const layer: unknown = Reflect.get(window.landmarkReview.scene(), 'mobility');
  if (!(layer instanceof MobilityLayer)) throw new Error('The real homepage mobility layer is not installed');
  return layer;
}
const review = {
  state: () => activity().resources(),
  snapshot: () => (Reflect.get(activity(), 'world') as MobilityWorld).snapshot(),
  architecture: () => window.landmarkReview.state(),
  async focus(lng = 120.68042, lat = 31.32, range = 220) {
    const scene = window.landmarkReview.scene();
    scene.viewer.camera.lookAt(Cartesian3.fromDegrees(lng, lat), new HeadingPitchRange(0.25, -0.8, range));
    scene.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    scene.viewer.scene.requestRender();
    scene.updateSettings(Reflect.get(scene, 'settings'));
  },
  capture: () => window.landmarkReview.scene().screenshot().then(blob => blob.size),
  async failedCapture() {
    const canvas = window.landmarkReview.scene().viewer.canvas, original = canvas.toBlob;
    canvas.toBlob = callback => callback(null);
    try { await window.landmarkReview.scene().screenshot(); }
    finally { canvas.toBlob = original; }
  },
  clock: () => window.landmarkReview.scene().viewer.clock.currentTime.toString(),
};
declare global { interface Window { cityActivityReview: typeof review } }
window.cityActivityReview = review;
