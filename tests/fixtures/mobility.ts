import {
  BoundingSphere, Cartesian3, Color, HeadingPitchRange, JulianDate, Matrix3, Matrix4,
  Model, ModelAnimationLoop, Transforms, CorridorGeometry,
} from 'cesium';
import { CityScene, fetchJSON } from '../../web/scene/CityScene';
import { defaultSettings } from '../../web/core/settings';
import type { CityManifest } from '../../web/core/types';
import selection from '../../data/enhancements/jinji-lake-selection.json';
import baselineMetadata from './mobility-baseline.json';

type Kind = 'car-a' | 'person-a';
type Gltf = {
  scenes: { nodes: number[] }[]; scene?: number;
  nodes: { name: string; mesh?: number; children?: number[] }[];
  meshes: { primitives: { attributes: { POSITION: number } }[] }[];
  accessors: { bufferView: number; byteOffset?: number; count: number; componentType: number; type: string }[];
  bufferViews: { byteOffset?: number; byteStride?: number }[];
  animations?: { name: string; samplers: { input: number }[] }[];
};
type Loaded = { model: Model; gltf: Gltf; binary: DataView; position: Cartesian3 };
type Bounds = { min: number[]; max: number[]; size: number[] };

declare global {
  interface Window {
    mobility: {
      scene: CityScene; ready: Promise<void>; errors: string[];
      geometry: { Cartesian3: typeof Cartesian3; Matrix4: typeof Matrix4; Transforms: typeof Transforms;
        CorridorGeometry: typeof CorridorGeometry; HeadingPitchRange: typeof HeadingPitchRange };
      assetViews(): Promise<void>;
      capture(name: string): Promise<Blob>;
      baseline(view: 'city' | 'district', night: boolean): Promise<unknown>;
      view(kind: Kind, heading: number, side?: boolean): Promise<void>;
      phase(value: number): Promise<void>;
      measure(kind: Kind): ReturnType<typeof measure>;
      clock(): string;
    };
  }
}

const errors: string[] = [];
const loaded = new Map<Kind, Loaded>();
const origin = baselineMetadata.candidate.origin;
const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(origin[0], origin[1]));
const inverseEnu = Matrix4.inverseTransformation(enu, new Matrix4());
const manifest = await fetchJSON<CityManifest>('/data/manifest.json');
const scene = new CityScene(document.getElementById('scene')!, manifest, { ...defaultSettings }, {
  onStats: () => {}, onSelect: () => {}, onError: (message) => errors.push(message),
});
let phase = 0;
let renderFailure: Error | undefined;
scene.viewer.scene.renderError.addEventListener((_scene, error) => { renderFailure = error; });

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timed out after ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } catch (error) {
    errors.push(`${label}: ${String(error)}`);
    throw error;
  } finally { clearTimeout(timer); }
}

async function rendered(): Promise<void> {
  if (renderFailure) throw renderFailure;
  const viewer = scene.viewer;
  let remove: (() => void) | undefined;
  try {
    await bounded(new Promise<void>((resolve) => {
      remove = viewer.scene.postRender.addEventListener(() => resolve());
      viewer.scene.requestRender();
    }), 'render frame', 10_000);
    if (renderFailure) throw renderFailure;
  } finally { remove?.(); }
}

async function readGlb(url: string): Promise<{ gltf: Gltf; binary: DataView }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const view = new DataView(buffer);
  if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error(`${url}: expected GLB`);
  const length = view.getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length))) as Gltf;
  return { gltf, binary: new DataView(buffer, 28 + length) };
}

function matrix(position: Cartesian3, heading: number): Matrix4 {
  // Cesium's default Y-up/+Z-forward glTF correction produces local +X forward.
  const rotation = Matrix3.fromRotationZ(Math.PI / 2 - heading);
  return Matrix4.multiply(enu, Matrix4.fromRotationTranslation(rotation, position), new Matrix4());
}

function measure(kind: Kind) {
  const asset = loaded.get(kind);
  if (!asset?.model.ready) throw new Error(`${kind}: model is not rendered-ready`);
  // Test-only observation of the installed renderer's actual conversion, not a second renderer.
  const graph = (asset.model as unknown as { _sceneGraph: { axisCorrectionMatrix: Matrix4 } })._sceneGraph;
  if (!graph?.axisCorrectionMatrix) throw new Error('Cesium axis inspection unavailable');
  const toLocal = Matrix4.multiply(inverseEnu, asset.model.modelMatrix, new Matrix4());
  const root = Matrix4.multiply(toLocal, graph.axisCorrectionMatrix, new Matrix4());
  const points: number[][] = [];
  const nodes: Record<string, number[]> = {};
  const visit = (index: number, parent: Matrix4) => {
    const node = asset.gltf.nodes[index];
    const transform = Matrix4.multiply(parent, asset.model.getNode(node.name).matrix, new Matrix4());
    const p = Matrix4.getTranslation(transform, new Cartesian3());
    nodes[node.name] = [p.x, p.y, p.z];
    if (node.mesh !== undefined) {
      for (const primitive of asset.gltf.meshes[node.mesh].primitives) {
        const accessor = asset.gltf.accessors[primitive.attributes.POSITION];
        if (accessor.componentType !== 5126 || accessor.type !== 'VEC3') throw new Error('Expected float VEC3 positions');
        const bufferView = asset.gltf.bufferViews[accessor.bufferView];
        const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        for (let i = 0; i < accessor.count; i++) {
          const offset = start + i * (bufferView.byteStride ?? 12);
          const point = Matrix4.multiplyByPoint(transform, new Cartesian3(
            asset.binary.getFloat32(offset, true), asset.binary.getFloat32(offset + 4, true),
            asset.binary.getFloat32(offset + 8, true),
          ), new Cartesian3());
          points.push([point.x - asset.position.x, point.y - asset.position.y, point.z]);
        }
      }
    }
    node.children?.forEach((child) => visit(child, transform));
  };
  asset.gltf.scenes[asset.gltf.scene ?? 0].nodes.forEach((node) => visit(node, root));
  const min = [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis])));
  const max = [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis])));
  const front = nodes[`${kind}-front`];
  const back = nodes[`${kind}-back`];
  const direction = Cartesian3.normalize(new Cartesian3(...front.map((x, i) => x - back[i]) as [number, number, number]), new Cartesian3());
  const bounds: Bounds = { min, max, size: max.map((x, i) => x - min[i]) };
  const animationDurations = asset.gltf.animations?.map((animation) => {
    const times = animation.samplers.flatMap(({ input }) => {
      const accessor = asset.gltf.accessors[input];
      const view = asset.gltf.bufferViews[accessor.bufferView];
      const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      if (accessor.componentType !== 5126 || accessor.type !== 'SCALAR') throw new Error('Expected float animation times');
      return Array.from({ length: accessor.count }, (_, i) => asset.binary.getFloat32(start + i * (view.byteStride ?? 4), true));
    });
    return Math.max(...times) - Math.min(...times);
  }) ?? [];
  return {
    ready: asset.model.ready, bounds, nodes, animations: asset.gltf.animations?.map((a) => a.name) ?? [],
    animationDurations,
    direction: [direction.x, direction.y, direction.z],
    sphereRadius: asset.model.boundingSphere.radius,
    axisCorrection: Matrix4.toArray(graph.axisCorrectionMatrix),
    limbMatrices: kind === 'person-a' ? ['left-leg', 'right-leg', 'left-arm', 'right-arm']
      .map((name) => Matrix4.toArray(asset.model.getNode(name).matrix)) : [],
  };
}

async function assetViews(): Promise<void> {
  await window.mobility.ready;
  if (loaded.size) throw new Error('Asset views already initialized');
  // The production city camera's 100 m floor would lift this metre-scale inspection view.
  scene.viewer.scene.screenSpaceCameraController.minimumZoomDistance = 0.1;
  scene.updateSettings({
    ...defaultSettings, night: false, buildings: false, roads: false, water: false,
    green: false, boundary: false, labels: false,
  });
  for (const kind of ['car-a', 'person-a'] as const) {
    const url = `/enhancements/slice/${kind}.glb`;
    const parsed = await bounded(readGlb(url), `read ${kind}`);
    const position = new Cartesian3(kind === 'car-a' ? -3 : 3, 0, 0);
    let expired = false;
    const pending = Model.fromGltfAsync({ url, modelMatrix: matrix(position, 0), minimumPixelSize: 0, scale: 1 });
    pending.then((model) => { if (expired) model.destroy(); }, () => {});
    let model: Model;
    try { model = await bounded(pending, `load ${kind}`); }
    catch (error) { expired = true; throw error; }
    scene.viewer.scene.primitives.add(model);
    loaded.set(kind, { model, position, ...parsed });
    const started = performance.now();
    while (!model.ready) {
      if (performance.now() - started > 20_000) throw new Error(`${kind}: render readiness timed out`);
      await rendered();
    }
    if (kind === 'person-a') {
      if (!parsed.gltf.animations?.some((animation) => animation.name === 'Walk')) {
        throw new Error(`${kind}: required Walk clip missing`);
      }
      model.activeAnimations.animateWhilePaused = true;
      model.activeAnimations.add({ name: 'Walk', loop: ModelAnimationLoop.REPEAT, animationTime: () => phase });
    }
  }
  for (let i = -6; i <= 6; i++) {
    for (const vertical of [false, true]) {
      const coordinates = vertical ? [[i, -6, 0.005], [i, 6, 0.005]] : [[-6, i, 0.005], [6, i, 0.005]];
      scene.viewer.entities.add({ polyline: {
        positions: coordinates.map((p) => Matrix4.multiplyByPoint(enu, new Cartesian3(...p as [number, number, number]), new Cartesian3())),
        width: i === 0 ? 2 : 1, material: i === 0 ? Color.DARKSLATEGRAY : Color.GRAY.withAlpha(0.4),
      } });
    }
  }
  for (const [centre, width] of [
    [-3, baselineMetadata.candidate.routeWidths.drive[0]],
    [3, baselineMetadata.candidate.routeWidths.walk[0]],
  ]) {
    for (const side of [-1, 1]) scene.viewer.entities.add({ polyline: {
      positions: [-6, 6].map((north) => Matrix4.multiplyByPoint(
        enu, new Cartesian3(centre + side * width / 2, north, 0.008), new Cartesian3(),
      )),
      width: 2, material: Color.DARKSLATEGRAY,
    } });
  }
  await rendered();
}

async function view(kind: Kind, heading: number, side = false): Promise<void> {
  for (const [key, asset] of loaded) asset.model.show = key === kind;
  const asset = loaded.get(kind)!;
  asset.model.modelMatrix = matrix(asset.position, heading);
  const target = Matrix4.multiplyByPoint(enu, Cartesian3.add(asset.position, new Cartesian3(0, 0, kind === 'car-a' ? 0.65 : 0.85), new Cartesian3()), new Cartesian3());
  scene.viewer.camera.lookAt(target, new HeadingPitchRange(
    side ? Math.PI / 2 : Math.PI + 0.35, -0.16, kind === 'car-a' ? 9 : 4.5,
  ));
  scene.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  document.getElementById('caption')!.textContent = `${kind} · heading ${Math.round(heading * 180 / Math.PI)}° from N · 1 m grid · phase ${phase.toFixed(2)}`;
  await rendered();
}

window.mobility = {
  geometry: { Cartesian3, Matrix4, Transforms, CorridorGeometry, HeadingPitchRange },
  scene, errors, ready: bounded(scene.initialize(), 'base city initialization', 65_000),
  assetViews: async () => {
    try { await assetViews(); }
    catch (error) {
      for (const { model } of loaded.values()) scene.viewer.scene.primitives.remove(model);
      loaded.clear();
      errors.push(`asset views: ${String(error)}`);
      throw error;
    }
  },
  view, measure, clock: () => JulianDate.toIso8601(scene.viewer.clock.currentTime),
  phase: async (value) => { phase = value; await rendered(); await rendered(); },
  capture: async (name) => {
    document.getElementById('caption')!.textContent = name;
    await rendered();
    return bounded(scene.screenshot(), `capture ${name}`, 65_000);
  },
  baseline: async (view, night) => {
    await window.mobility.ready;
    scene.updateSettings({ ...defaultSettings, quality: 'medium', night });
    const camera = view === 'district' ? selection.showcase : baselineMetadata.city;
    scene.viewer.camera.flyToBoundingSphere(new BoundingSphere(Cartesian3.fromDegrees(camera.target[0], camera.target[1]), 0), {
      duration: 0, offset: new HeadingPitchRange(camera.heading * Math.PI / 180, camera.pitch * Math.PI / 180, camera.range),
    });
    await rendered();
    await bounded(scene.screenshot(), 'baseline geometry', 65_000);
    return {
      baseDataset: manifest.dataset, camera, origin, quality: 'medium', night,
      routeWidths: baselineMetadata.candidate.routeWidths,
      viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
      actualCamera: {
        position: Cartesian3.pack(scene.viewer.camera.positionWC, []),
        direction: Cartesian3.pack(scene.viewer.camera.directionWC, []),
        up: Cartesian3.pack(scene.viewer.camera.upWC, []),
      },
      beforeActors: { vehicles: 'absent in original base', pedestrians: 'absent in original base' },
    };
  },
};
// The test runner observes rejection through ready/errors, without an unhandled rejection.
void window.mobility.ready.catch(() => {});
