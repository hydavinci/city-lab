import {
  Viewer, Cartesian2, Cartesian3, Color, Rectangle, PolygonGeometry, PolygonHierarchy,
  GeometryInstance, MaterialAppearance, Primitive, PrimitiveCollection, PolylineGeometry,
  PolylineMaterialAppearance, Material, Math as CesiumMath, ScreenSpaceEventHandler,
  ScreenSpaceEventType, LabelCollection, LabelStyle, VerticalOrigin, DistanceDisplayCondition,
  HeadingPitchRange, BoundingSphere, JulianDate, EllipsoidTerrainProvider, SceneMode,
} from 'cesium';
import type { FeatureCollection, Geometry, Position } from 'geojson';
import type { Bounds, BuildingProperties, CityManifest, SceneSettings, SceneStats } from '../core/types';
import { selectTiles } from '../core/geo';
import { buildingMaterial, colorMaterial, facadeVertexShader } from './materials';
import { OrbitControls } from './OrbitControls';

export const PLACES = [
  { name: '金鸡湖', sub: '湖畔新城', lng: 120.695, lat: 31.317, range: 6500 },
  { name: '姑苏古城', sub: '水巷人家', lng: 120.625, lat: 31.315, range: 4500 },
  { name: '太湖', sub: '山水之间', lng: 120.365, lat: 31.16, range: 32000 },
  { name: '吴江', sub: '江南水乡', lng: 120.637, lat: 31.138, range: 8500 },
  { name: '昆山', sub: '城东门户', lng: 120.977, lat: 31.385, range: 8500 },
  { name: '常熟', sub: '虞山城郭', lng: 120.749, lat: 31.655, range: 8500 },
  { name: '张家港', sub: '江畔港城', lng: 120.554, lat: 31.877, range: 10000 },
  { name: '太仓', sub: '江海交汇', lng: 121.124, lat: 31.459, range: 8500 },
  { name: '相城', sub: '城北新貌', lng: 120.642, lat: 31.371, range: 8500 },
  { name: '虎丘', sub: '山塘寻迹', lng: 120.566, lat: 31.33, range: 6500 },
];

interface Callbacks {
  onStats: (stats: SceneStats) => void;
  onSelect: (building: BuildingProperties | null) => void;
  onError: (message: string) => void;
}
interface TileEntry { primitive: Primitive; count: number }
type Layer = 'water' | 'roads' | 'green' | 'boundary';

function ringsOf(geometry: Geometry): Position[][][] {
  return geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
}

function hierarchy(rings: Position[][]): PolygonHierarchy {
  return new PolygonHierarchy(
    Cartesian3.fromDegreesArray(rings[0].slice(0, -1).flatMap(([x, y]) => [x, y])),
    rings.slice(1).map((ring) => new PolygonHierarchy(
      Cartesian3.fromDegreesArray(ring.slice(0, -1).flatMap(([x, y]) => [x, y])),
    )),
  );
}

export async function fetchJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`本地数据读取失败 (${response.status}): ${url}`);
  return response.json() as Promise<T>;
}

export class CityScene {
  readonly viewer: Viewer;
  private settings: SceneSettings;
  private manifest: CityManifest;
  private callbacks: Callbacks;
  private layers: Record<Layer, PrimitiveCollection>;
  private labels: LabelCollection;
  private tiles = new Map<string, TileEntry>();
  private pending = new Map<string, AbortController>();
  private failed = new Set<string>();
  private wanted = new Set<string>();
  private buildingAppearance: MaterialAppearance;
  private handler: ScreenSpaceEventHandler;
  private orbit: OrbitControls;
  private disposed = false;
  private removeMoveListener: () => void;
  private removeErrorListener: () => void;
  private resizeListener = () => this.updateSettings(this.settings);
  private surfaceAbort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readyTimer: ReturnType<typeof setInterval>;
  private overview = true;
  private renderFailure: Error | null = null;
  private lastReport = '';

  constructor(container: HTMLElement, manifest: CityManifest, settings: SceneSettings, callbacks: Callbacks) {
    this.manifest = manifest;
    this.settings = settings;
    this.callbacks = callbacks;
    this.viewer = new Viewer(container, {
      baseLayer: false, baseLayerPicker: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, animation: false, timeline: false,
      fullscreenButton: false, infoBox: false, selectionIndicator: false,
      skyBox: false, skyAtmosphere: false,
      requestRenderMode: true, maximumRenderTimeChange: Infinity,
      sceneMode: SceneMode.SCENE3D,
      contextOptions: { webgl: { alpha: false, preserveDrawingBuffer: true } },
      useBrowserRecommendedResolution: false,
      msaaSamples: 4,
    });
    const scene = this.viewer.scene;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.fog.enabled = false;
    scene.globe.showGroundAtmosphere = false;
    scene.globe.enableLighting = false;
    scene.globe.depthTestAgainstTerrain = false;
    scene.screenSpaceCameraController.minimumZoomDistance = 100;
    scene.screenSpaceCameraController.maximumZoomDistance = 450_000;
    this.viewer.clock.currentTime = JulianDate.fromIso8601('2026-06-21T04:00:00Z');
    this.viewer.clock.shouldAnimate = false;
    this.viewer.cesiumWidget.creditContainer.setAttribute('aria-label', '地图引擎署名');
    this.layers = {
      water: scene.primitives.add(new PrimitiveCollection()),
      roads: scene.primitives.add(new PrimitiveCollection()),
      green: scene.primitives.add(new PrimitiveCollection()),
      boundary: scene.primitives.add(new PrimitiveCollection()),
    };
    this.labels = scene.primitives.add(new LabelCollection());
    for (const place of PLACES) {
      this.labels.add({
        position: Cartesian3.fromDegrees(place.lng, place.lat, 30), text: place.name,
        font: '13px sans-serif', fillColor: Color.fromCssColorString('#c8e4df'),
        outlineColor: Color.fromCssColorString('#0b1820'), outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -12),
        distanceDisplayCondition: new DistanceDisplayCondition(2500, 400_000),
      });
    }
    this.buildingAppearance = new MaterialAppearance({
      material: buildingMaterial(settings.night, settings.glow),
      vertexShaderSource: facadeVertexShader,
      translucent: false, closed: true, faceForward: true,
    });
    this.handler = new ScreenSpaceEventHandler(scene.canvas);
    this.handler.setInputAction((event: { position: Cartesian2 }) => {
      const picked: unknown = scene.pick(event.position);
      if (picked && typeof picked === 'object' && 'id' in picked) {
        const id = picked.id;
        if (id && typeof id === 'object' && 'height' in id && 'basis' in id) {
          const building = id as BuildingProperties;
          callbacks.onSelect(building);
          return;
        }
      }
      callbacks.onSelect(null);
    }, ScreenSpaceEventType.LEFT_CLICK);
    this.removeMoveListener = this.viewer.camera.moveEnd.addEventListener(() => this.scheduleTiles());
    this.removeErrorListener = scene.renderError.addEventListener((_scene: unknown, error: Error) => {
      this.renderFailure = error;
      callbacks.onError(`三维渲染失败：${error.message}。请降低画质或刷新页面。`);
    });
    this.readyTimer = setInterval(() => {
      if (this.pending.size || !this.surfacesReady()
        || [...this.tiles.values()].some((tile) => !tile.primitive.ready)) scene.requestRender();
      this.report();
    }, 200);
    this.orbit = new OrbitControls(this.viewer);
    window.addEventListener('resize', this.resizeListener);
    this.updateSettings(settings);
    this.home(0);
  }

  async initialize() {
    const path = `/data/${this.manifest.dataset}`;
    const [boundary, surface] = await Promise.all([
      fetchJSON<FeatureCollection>(`${path}/boundary.json`, this.surfaceAbort.signal),
      fetchJSON<FeatureCollection>(`${path}/surface.json`, this.surfaceAbort.signal),
    ]);
    if (this.disposed) return;
    this.addBoundary(boundary);
    this.addSurface(surface);
    this.viewer.scene.requestRender();
    await this.waitForGeometry(false);
    this.scheduleTiles();
  }

  private surfacesReady(): boolean {
    return Object.values(this.layers).every((layer) => {
      if (!layer.show) return true;
      for (let i = 0; i < layer.length; i++) {
        if (!(layer.get(i) as Primitive).ready) return false;
      }
      return true;
    });
  }

  private waitForGeometry(includeBuildings: boolean): Promise<void> {
    const signal = this.surfaceAbort.signal;
    const start = performance.now();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => finish(new Error('场景已关闭。'));
      const check = () => {
        if (this.disposed) return cancel();
        if (this.renderFailure) return finish(this.renderFailure);
        if (performance.now() - start > 60_000) return finish(new Error('几何资源准备超时，请降低画质或刷新重试。'));
        const ids = includeBuildings ? [...this.wanted] : [];
        if (ids.some((id) => this.failed.has(id))) return finish(new Error('部分建筑分块加载失败，请先重试加载再导出。'));
        if (this.surfacesReady() && ids.every((id) => this.tiles.get(id)?.primitive.ready)) return finish();
        this.viewer.scene.requestRender();
        timer = setTimeout(check, 100);
      };
      signal.addEventListener('abort', cancel, { once: true });
      check();
    });
  }

  private addBoundary(collection: FeatureCollection) {
    const lines: GeometryInstance[] = [];
    for (const feature of collection.features) {
      for (const rings of ringsOf(feature.geometry)) {
        for (const ring of rings) {
          lines.push(new GeometryInstance({
            geometry: new PolylineGeometry({
              positions: Cartesian3.fromDegreesArrayHeights(ring.flatMap(([x, y]) => [x, y, 12])),
              width: 2, vertexFormat: PolylineMaterialAppearance.VERTEX_FORMAT,
            }),
          }));
        }
      }
    }
    this.layers.boundary.add(new Primitive({
      geometryInstances: lines,
      appearance: new PolylineMaterialAppearance({
        material: Material.fromType('PolylineGlow', { color: Color.fromCssColorString('#71cbb5'), glowPower: 0.15 }),
      }),
    }));
  }

  private addSurface(collection: FeatureCollection) {
    const polygons: Record<'water' | 'green', GeometryInstance[]> = { water: [], green: [] };
    const roadLines: GeometryInstance[] = [], waterLines: GeometryInstance[] = [];
    for (const feature of collection.features) {
      const layer: unknown = feature.properties?.layer;
      if (layer === 'water' || layer === 'green') {
        for (const rings of ringsOf(feature.geometry)) {
          if (rings[0].length < 4) continue;
          polygons[layer].push(new GeometryInstance({
            geometry: new PolygonGeometry({
              polygonHierarchy: hierarchy(rings), height: layer === 'water' ? 2 : 1,
              vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
            }),
          }));
        }
      }
      const geometry = feature.geometry;
      const lines = geometry.type === 'LineString' ? [geometry.coordinates]
        : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
      if (layer === 'roads' || layer === 'water') {
        for (const line of lines) {
          if (line.length < 2) continue;
          const target = layer === 'roads' ? roadLines : waterLines;
          target.push(new GeometryInstance({
            geometry: new PolylineGeometry({
              positions: Cartesian3.fromDegreesArrayHeights(line.flatMap(([x, y]) => [x, y, layer === 'roads' ? 5 : 3])),
              width: layer === 'water' ? 2 : /motorway|trunk/.test(feature.properties?.kind) ? 2 : 1,
              vertexFormat: PolylineMaterialAppearance.VERTEX_FORMAT,
            }),
          }));
        }
      }
    }
    for (const layer of ['water', 'green'] as const) {
      if (polygons[layer].length) this.layers[layer].add(new Primitive({
        geometryInstances: polygons[layer],
        appearance: new MaterialAppearance({
          material: colorMaterial(layer === 'water' ? '#163e49' : '#173a31'),
          translucent: false, flat: true,
        }),
      }));
    }
    if (roadLines.length) this.layers.roads.add(new Primitive({
      geometryInstances: roadLines,
      appearance: new PolylineMaterialAppearance({
        material: Material.fromType('Color', { color: Color.fromCssColorString('#ac9464') }),
      }),
    }));
    if (waterLines.length) this.layers.water.add(new Primitive({
      geometryInstances: waterLines,
      appearance: new PolylineMaterialAppearance({
        material: Material.fromType('Color', { color: Color.fromCssColorString('#286273') }),
      }),
    }));
    this.updateSettings(this.settings);
  }

  updateSettings(settings: SceneSettings) {
    this.settings = settings;
    const scene = this.viewer.scene;
    scene.backgroundColor = Color.fromCssColorString(settings.night ? '#080e17' : '#c4d6df');
    scene.globe.baseColor = Color.fromCssColorString(settings.night ? '#101e23' : '#c1cbbc');
    const material = this.buildingAppearance.material;
    material.uniforms.nightMode = settings.night ? 1 : 0;
    material.uniforms.glow = settings.glow;
    const bloom = scene.postProcessStages.bloom;
    bloom.enabled = settings.night && settings.quality !== 'low' && settings.glow > 0;
    bloom.uniforms.glowOnly = false;
    bloom.uniforms.contrast = 64;
    bloom.uniforms.brightness = -0.35;
    bloom.uniforms.delta = 1;
    bloom.uniforms.sigma = 2.5;
    bloom.uniforms.stepSize = 1;
    const dpr = window.devicePixelRatio || 1;
    const pixelRatio = settings.quality === 'low' ? Math.min(dpr, 1)
      : settings.quality === 'high' ? Math.min(3, Math.max(1.5, dpr * 1.25)) : Math.min(dpr, 2);
    this.viewer.resolutionScale = pixelRatio / dpr;
    scene.msaaSamples = settings.quality === 'low' ? 1 : 4;
    scene.postProcessStages.fxaa.enabled = settings.quality === 'low' || !scene.msaaSupported;
    for (const layer of ['water', 'green', 'roads', 'boundary'] as const) {
      this.layers[layer].show = settings[layer];
    }
    for (let i = 0; i < this.layers.water.length; i++) {
      const appearance = (this.layers.water.get(i) as Primitive).appearance;
      if (appearance?.material?.type === 'Color') {
        appearance.material.uniforms.color = Color.fromCssColorString(settings.night ? '#163e49' : '#60999d');
      }
    }
    for (let i = 0; i < this.layers.green.length; i++) {
      const appearance = (this.layers.green.get(i) as Primitive).appearance;
      if (appearance?.material) appearance.material.uniforms.color = Color.fromCssColorString(settings.night ? '#173a31' : '#8caa82');
    }
    for (let i = 0; i < this.layers.roads.length; i++) {
      const appearance = (this.layers.roads.get(i) as Primitive).appearance;
      if (appearance?.material) appearance.material.uniforms.color = Color.fromCssColorString(settings.night ? '#817963' : '#8f907c');
    }
    this.labels.show = settings.labels;
    for (const tile of this.tiles.values()) tile.primitive.show = settings.buildings;
    this.scheduleTiles();
    scene.requestRender();
  }

  private scheduleTiles() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.updateTiles(), 180);
  }

  private updateTiles() {
    if (this.disposed) return;
    const viewer = this.viewer;
    const altitude = viewer.camera.positionCartographic.height;
    this.overview = altitude > 24000;
    const view = viewer.camera.computeViewRectangle();
    const ray = viewer.camera.getPickRay(new Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2));
    const hit = ray && viewer.scene.globe.pick(ray, viewer.scene);
    const focus = hit ? viewer.scene.globe.ellipsoid.cartesianToCartographic(hit) : viewer.camera.positionCartographic;
    const centre = [CesiumMath.toDegrees(focus.longitude), CesiumMath.toDegrees(focus.latitude)];
    const bounds: Bounds = view
      ? [CesiumMath.toDegrees(view.west), CesiumMath.toDegrees(view.south), CesiumMath.toDegrees(view.east), CesiumMath.toDegrees(view.north)]
      : [centre[0] - 0.03, centre[1] - 0.03, centre[0] + 0.03, centre[1] + 0.03];
    const limit = { low: 4, medium: 8, high: 14 }[this.settings.quality];
    const candidates = this.overview || !this.settings.buildings ? [] : selectTiles(this.manifest.tiles, bounds, centre, limit);
    this.wanted = new Set(candidates.map((tile) => tile.id));
    for (const [id, controller] of this.pending) {
      if (!this.wanted.has(id)) controller.abort();
    }
    for (const [id, entry] of this.tiles) {
      if (!this.wanted.has(id)) {
        viewer.scene.primitives.remove(entry.primitive);
        this.tiles.delete(id);
      }
    }
    const queue = candidates.filter((tile) => !this.tiles.has(tile.id) && !this.pending.has(tile.id) && !this.failed.has(tile.id));
    for (const tile of queue.slice(0, Math.max(0, 2 - this.pending.size))) void this.loadTile(tile.id);
    this.report();
    viewer.scene.requestRender();
  }

  private async loadTile(id: string) {
    const controller = new AbortController();
    this.pending.set(id, controller);
    try {
      const collection = await fetchJSON<FeatureCollection>(
        `/data/${this.manifest.dataset}/tiles/${id}.json`, controller.signal,
      );
      if (this.disposed || controller.signal.aborted || !this.wanted.has(id)) return;
      const instances: GeometryInstance[] = [];
      for (const feature of collection.features) {
        const properties = feature.properties as BuildingProperties;
        for (const rings of ringsOf(feature.geometry)) {
          instances.push(new GeometryInstance({
            id: properties,
            geometry: new PolygonGeometry({
              polygonHierarchy: hierarchy(rings), height: properties.height + 0.5, extrudedHeight: 0.5,
              vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
            }),
          }));
        }
      }
      const primitive = this.viewer.scene.primitives.add(new Primitive({
        geometryInstances: instances, appearance: this.buildingAppearance, asynchronous: true,
        releaseGeometryInstances: true,
      }));
      this.tiles.set(id, { primitive, count: collection.features.length });
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) {
        this.failed.add(id);
        this.callbacks.onError(`建筑分块 ${id} 加载失败：${error instanceof Error ? error.message : String(error)}。可点击“重试加载”。`);
      }
    } finally {
      this.pending.delete(id);
      if (!this.disposed) this.scheduleTiles();
    }
  }

  private report() {
    const position = this.viewer.camera.positionCartographic;
    const visible = [...this.tiles.values()].filter((entry) => entry.primitive.ready && entry.primitive.show);
    const stats: SceneStats = {
      loadedTiles: visible.length,
      loadedBuildings: visible.reduce((n, entry) => n + entry.count, 0),
      loading: this.pending.size > 0 || visible.length < this.tiles.size, overview: this.overview,
      height: position.height,
      longitude: CesiumMath.toDegrees(position.longitude), latitude: CesiumMath.toDegrees(position.latitude),
    };
    const key = JSON.stringify(stats);
    if (key !== this.lastReport) {
      this.lastReport = key;
      this.callbacks.onStats(stats);
    }
  }

  retry() {
    this.failed.clear();
    this.scheduleTiles();
  }

  home(duration = 1.5) {
    this.orbit.cancel();
    this.viewer.camera.flyTo({
      destination: Rectangle.fromDegrees(...this.manifest.bounds),
      duration, complete: () => this.scheduleTiles(),
    });
  }

  flyTo(name: string) {
    const place = PLACES.find((item) => item.name === name);
    if (!place) throw new Error(`未知定位点：${name}`);
    this.orbit.cancel();
    this.viewer.camera.flyToBoundingSphere(
      new BoundingSphere(Cartesian3.fromDegrees(place.lng, place.lat), 50),
      { duration: 1.8, offset: new HeadingPitchRange(CesiumMath.toRadians(15), CesiumMath.toRadians(-42), place.range) },
    );
  }

  zoom(inward: boolean) {
    this.orbit.cancel();
    const distance = this.viewer.camera.positionCartographic.height * 0.35;
    if (inward) this.viewer.camera.zoomIn(distance);
    else this.viewer.camera.zoomOut(distance);
    this.scheduleTiles();
    this.viewer.scene.requestRender();
  }

  north() {
    this.orbit.cancel();
    this.viewer.camera.setView({
      orientation: { heading: 0, pitch: this.viewer.camera.pitch, roll: 0 },
    });
    this.viewer.scene.requestRender();
    this.scheduleTiles();
  }

  async screenshot(): Promise<Blob> {
    this.updateTiles();
    await this.waitForGeometry(true);
    this.viewer.render();
    return new Promise((resolve, reject) => {
      this.viewer.canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('截图生成失败。')), 'image/png');
    });
  }

  destroy() {
    this.disposed = true;
    clearTimeout(this.timer);
    clearInterval(this.readyTimer);
    this.surfaceAbort.abort();
    for (const controller of this.pending.values()) controller.abort();
    this.removeMoveListener();
    this.removeErrorListener();
    window.removeEventListener('resize', this.resizeListener);
    this.handler.destroy();
    this.orbit.destroy();
    this.viewer.destroy();
  }
}
