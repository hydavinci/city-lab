import {
  BoundingSphere, Cartesian3, HeadingPitchRange, JulianDate, Matrix4, Transforms, Viewer, type Model,
} from 'cesium';
import { MobilityLayer } from '../../web/scene/MobilityLayer';
import { defaultSettings } from '../../web/core/settings';
import type { MobilityWorld } from '../../web/core/mobility-world';
import type { ActorKind, EnhancementManifest } from '../../web/core/enhancements';
import type { WorldSnapshot } from '../../web/core/mobility';
import { unproject } from '../../pipeline/enhancements/geometry';

// Synthetic motion fixtures exercise the real production renderer and authored GLBs, not geographic coverage.
const viewer = new Viewer('scene', {
  baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
  navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
  infoBox: false, selectionIndicator: false, skyBox: false, skyAtmosphere: false,
  requestRenderMode: true, maximumRenderTimeChange: Infinity,
  contextOptions: { webgl: { preserveDrawingBuffer: true } },
});
viewer.clock.currentTime = JulianDate.fromIso8601('2026-06-21T04:00:00Z');
viewer.clock.shouldAnimate = false;
viewer.scene.screenSpaceCameraController.minimumZoomDistance = 0.1;
const errors: string[] = [];
viewer.scene.renderError.addEventListener((_scene, error) => errors.push(String(error)));
const layer = new MobilityLayer(viewer, message => errors.push(message), () => {});
const world: MobilityWorld = Reflect.get(layer, 'world');
const gate = { canSpawn: () => true, canRetire: () => false };
const origin: [number, number] = [120.68, 31.32];
const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(...origin));
const target = Matrix4.multiplyByPoint(enu, new Cartesian3(20, 0, 0), new Cartesian3());
viewer.camera.lookAt(target, new HeadingPitchRange(0.25, -0.65, 120));
viewer.camera.lookAtTransform(Matrix4.IDENTITY);
let release = () => {};
let assets: EnhancementManifest;
type Gltf = {
  scene?: number; scenes: { nodes: number[] }[]; nodes: { name: string; children?: number[]; mesh?: number }[];
  meshes: { primitives: { attributes: { POSITION: number } }[] }[];
  accessors: { componentType: number; type: string; count: number; bufferView: number; byteOffset?: number }[];
  bufferViews: { byteOffset?: number; byteStride?: number }[];
};
const documents = new Map<ActorKind, { gltf: Gltf; binary: DataView }>();
async function frame(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { remove(); reject(new Error('Model inspection render timeout')); }, 15000);
    const remove = viewer.scene.postRender.addEventListener(() => { clearTimeout(timeout); remove(); resolve(); });
    viewer.scene.requestRender();
  });
}
async function ready(): Promise<void> {
  const start = performance.now();
  while (!layer.ready || layer.resources().models < 2) {
    if (layer.error) throw layer.error;
    if (performance.now() - start > 30000) throw new Error('Activity model readiness timeout');
    await frame();
  }
  await frame(); await frame();
}
const boot = (async () => {
  assets = await (await fetch('/enhancements/manifest.json')).json();
  layer.update({ ...defaultSettings }); await layer.load(assets.baseDataset);
  const start = performance.now();
  while (!layer.resources().cells || !layer.ready) {
    if (layer.error) throw layer.error;
    if (performance.now() - start > 30000) throw new Error('Activity cell readiness timeout');
    layer.update({ ...defaultSettings }); await frame();
  }
  world.setOptions({ seed: 7, vehicles: 1, pedestrians: 1, arrivals: true }); world.step(gate);
  release = layer.freeze();
  await ready();
})();
function models(): Map<number, { model: Model }> { return Reflect.get(layer, 'models'); }
function snapshot(): WorldSnapshot { return Reflect.get(layer, 'frozen') ?? world.snapshot(); }
async function measure(kind: ActorKind) {
  const actor = snapshot().actors.find(actor => actor.kind === kind);
  if (!actor) throw new Error(`No rendered actor ${kind}`);
  const model = models().get(actor.id)!.model;
  let document = documents.get(kind);
  if (!document) {
    const asset = assets.assets.find(asset => asset.kind === kind)!;
    const bytes = await (await fetch(`/enhancements/${asset.uri}`)).arrayBuffer(), data = new DataView(bytes);
    const length = data.getUint32(12, true);
    document = { gltf: JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length))), binary: new DataView(bytes, 28 + length) };
    documents.set(kind, document);
  }
  const { gltf, binary } = document, point = unproject(actor.position, origin);
  const inverse = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(...point)), new Matrix4());
  const graph = Reflect.get(model, '_sceneGraph');
  const correction = Reflect.get(graph, 'axisCorrectionMatrix') as Matrix4;
  const root = Matrix4.multiply(Matrix4.multiply(inverse, model.modelMatrix, new Matrix4()), correction, new Matrix4());
  const vertices: Cartesian3[] = [], markers = new Map<string, Cartesian3>();
  const visit = (index: number, parent: Matrix4) => {
    const node = gltf.nodes[index], transform = Matrix4.multiply(parent, model.getNode(node.name).matrix, new Matrix4());
    markers.set(node.name, Matrix4.getTranslation(transform, new Cartesian3()));
    if (node.mesh !== undefined) for (const primitive of gltf.meshes[node.mesh].primitives) {
      const accessor = gltf.accessors[primitive.attributes.POSITION], view = gltf.bufferViews[accessor.bufferView];
      if (accessor.type !== 'VEC3' || accessor.componentType !== 5126) throw new Error('Unsupported inspection POSITION');
      for (let i = 0; i < accessor.count; i++) {
        const at = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + i * (view.byteStride ?? 12);
        vertices.push(Matrix4.multiplyByPoint(transform, new Cartesian3(
          binary.getFloat32(at, true), binary.getFloat32(at + 4, true), binary.getFloat32(at + 8, true)), new Cartesian3()));
      }
    }
    node.children?.forEach(child => visit(child, transform));
  };
  gltf.scenes[gltf.scene ?? 0].nodes.forEach(index => visit(index, root));
  const front = markers.get(`${kind}-front`)!, back = markers.get(`${kind}-back`)!;
  const direction = Cartesian3.normalize(Cartesian3.subtract(front, back, new Cartesian3()), new Cartesian3());
  const min = [Math.min(...vertices.map(p => p.x)), Math.min(...vertices.map(p => p.y)), Math.min(...vertices.map(p => p.z))];
  const max = [Math.max(...vertices.map(p => p.x)), Math.max(...vertices.map(p => p.y)), Math.max(...vertices.map(p => p.z))];
  const leg = gltf.nodes.find(node => /^left-leg(?:\.\d+)?$/.test(node.name));
  return { min, size: max.map((n, i) => n - min[i]), direction: [direction.x, direction.y, direction.z],
    scale: model.scale, minimumPixelSize: model.minimumPixelSize,
    leg: leg ? Matrix4.toArray(model.getNode(leg.name).matrix) : [] };
}
const inspection = {
  ready: boot, errors, snapshot, measure, clock: () => JulianDate.toIso8601(viewer.clock.currentTime),
  async advance(steps: number) {
    release(); world.setOptions({ seed: 7, vehicles: 1, pedestrians: 1, arrivals: false });
    for (let i = 0; i < steps; i++) world.step(gate);
    release = layer.freeze(); await ready();
  },
  async heading(heading: number) {
    snapshot().actors.forEach(actor => { actor.heading = heading; }); await frame(); await frame();
  },
  async moving() { release(); await frame(); },
  resources: () => layer.resources(),
  modelPositions: () => [...models().values()].map(record => {
    const p = Matrix4.getTranslation(record.model.modelMatrix, new Cartesian3());
    return [p.x, p.y, p.z];
  }),
};
declare global { interface Window { activityModels: typeof inspection } }
window.activityModels = inspection;
