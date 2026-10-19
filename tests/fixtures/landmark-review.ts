import { Cartesian2, Cartesian3, Cesium3DTile, HeadingPitchRange, Matrix4 } from 'cesium';
import { CityScene } from '../../web/scene/CityScene';
import { CityArchitectureLayer } from '../../web/scene/CityArchitectureLayer';
import { landmarks } from '../../web/core/landmarks';

function mainScene(): CityScene {
  const container = document.querySelector('.cesium-container');
  if (!container) throw new Error('The real application scene is not mounted.');
  const key = Object.keys(container).find(key => key.startsWith('__reactFiber$'));
  let fiber: unknown = key && Reflect.get(container, key);
  while (fiber && typeof fiber === 'object') {
    let hook: unknown = Reflect.get(fiber, 'memoizedState');
    while (hook && typeof hook === 'object') {
      const state: unknown = Reflect.get(hook, 'memoizedState');
      if (state && typeof state === 'object') {
        const current: unknown = Reflect.get(state, 'current');
        if (current instanceof CityScene) return current;
      }
      hook = Reflect.get(hook, 'next');
    }
    fiber = Reflect.get(fiber, 'return');
  }
  throw new Error('Could not inspect the mounted application CityScene ref.');
}

function architecture(): CityArchitectureLayer {
  const layer: unknown = Reflect.get(mainScene(), 'cityArchitecture');
  if (!(layer instanceof CityArchitectureLayer)) throw new Error('The native architecture layer is unavailable.');
  return layer;
}

function definition(id: string) {
  const record = landmarks.find(record => record.id === id);
  if (!record) throw new Error(`Unknown review landmark: ${id}`);
  return record;
}

const review = {
  state: () => architecture().resources(),
  lods(id: string): string[] {
    const record = definition(id), visible: unknown = Reflect.get(architecture(), 'visible');
    if (!(visible instanceof Set)) throw new Error('The native visible tile set is unavailable.');
    const lods: string[] = [];
    for (const tile of visible) {
      if (!(tile instanceof Cesium3DTile)) throw new Error('Invalid native visible tile.');
      for (let index = 0; index < tile.content.featuresLength; index++) {
        if (tile.content.getFeature(index).getProperty('id') !== record.sourceId) continue;
        const lod: unknown = tile.extras?.lod;
        if (typeof lod !== 'string') throw new Error('Missing native landmark LOD.');
        lods.push(lod);
      }
    }
    return lods;
  },
  async view(id: string, range: number, heading: number, pitch: number, heightFraction = 0.45, target?: [number, number]) {
    const record = definition(id), [west, south, east, north] = record.bounds;
    const scene = mainScene();
    scene.viewer.camera.lookAt(Cartesian3.fromDegrees(target?.[0] ?? (west + east) / 2,
      target?.[1] ?? (south + north) / 2, record.height * heightFraction),
      new HeadingPitchRange(heading * Math.PI / 180, pitch * Math.PI / 180, range));
    scene.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    scene.viewer.scene.requestRender();
    return (await scene.screenshot()).size;
  },
  async ready() {
    return (await mainScene().screenshot()).size;
  },
  pickPoint(id: string) {
    const record = definition(id), [west, south, east, north] = record.bounds;
    const scene = mainScene(), native = architecture();
    for (const height of [0.8, 0.5, 0.2]) {
      for (const [x, y] of [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]]) {
        const position = scene.viewer.scene.cartesianToCanvasCoordinates(Cartesian3.fromDegrees(
          (west + east) / 2 + (east - west) * x, (south + north) / 2 + (north - south) * y, record.height * height,
        ));
        if (!position) continue;
        const picked = native.selected(scene.viewer.scene.pick(new Cartesian2(position.x, position.y)));
        if (picked?.id !== record.sourceId) continue;
        const rect = scene.viewer.canvas.getBoundingClientRect();
        return { x: rect.left + position.x, y: rect.top + position.y, picked };
      }
    }
    throw new Error(`No visible native feature could be picked for ${id}.`);
  },
};

declare global {
  interface Window { landmarkReview: typeof review }
}

// Inspect the real App's ref only in browser tests; never create a parallel fixture scene.
window.landmarkReview = review;
