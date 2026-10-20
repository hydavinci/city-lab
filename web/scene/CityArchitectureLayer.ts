import {
  Cesium3DTileFeature, Cesium3DTileset, CustomShader, Matrix4, PrimitiveCollection, RequestScheduler, UniformType,
  type Cesium3DTile, type Viewer,
} from 'cesium';
import { parseCityArchitectureManifest } from '../core/architecture-manifest';
import type { BuildingProperties, SceneSettings } from '../core/types';
import { parseLandmarkModel, type SelectedBuilding } from '../core/landmarks';
import { parseHeightReference } from '../core/building-heights';

const budgets = {
  low: { maximumScreenSpaceError: 32, cacheBytes: 64 * 1024 * 1024, maximumCacheOverflowBytes: 16 * 1024 * 1024 },
  medium: { maximumScreenSpaceError: 16, cacheBytes: 192 * 1024 * 1024, maximumCacheOverflowBytes: 32 * 1024 * 1024 },
  high: { maximumScreenSpaceError: 8, cacheBytes: 384 * 1024 * 1024, maximumCacheOverflowBytes: 64 * 1024 * 1024 },
};
const requestLeases = new Map<string, { count: number; restore(): void }>();
let restoreRequestQueue: (() => void) | undefined;

function acquireRequestQueue(): () => void {
  // Cesium's private priority heap also caps requests per rendered frame; server limits alone do not.
  const heap: unknown = Reflect.get(RequestScheduler, 'priorityHeapLength');
  if (typeof heap !== 'number' || !Number.isFinite(heap) || heap < 1) {
    throw new Error('Unsupported Cesium request priority queue.');
  }
  const url = new URL('/architecture-city/', globalThis.location.href);
  const key = `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  if (!requestLeases.size) {
    const previousMaximum = RequestScheduler.maximumRequests;
    const maximum = Math.max(previousMaximum, 128), capacity = Math.max(heap, 128);
    RequestScheduler.maximumRequests = maximum;
    Reflect.set(RequestScheduler, 'priorityHeapLength', capacity);
    restoreRequestQueue = () => {
      if (RequestScheduler.maximumRequests === maximum) RequestScheduler.maximumRequests = previousMaximum;
      if (Reflect.get(RequestScheduler, 'priorityHeapLength') === capacity) {
        Reflect.set(RequestScheduler, 'priorityHeapLength', heap);
      }
    };
  }
  let lease = requestLeases.get(key);
  if (!lease) {
    const servers: Record<string, number | undefined> = RequestScheduler.requestsByServer;
    const previous = servers[key], maximum = Math.max(previous ?? RequestScheduler.maximumRequestsPerServer, 128);
    servers[key] = maximum;
    lease = { count: 0, restore: () => {
      if (RequestScheduler.requestsByServer !== servers || servers[key] !== maximum) return;
      if (previous === undefined) delete servers[key];
      else servers[key] = previous;
    } };
    requestLeases.set(key, lease);
  }
  lease.count++;
  return () => {
    if (--lease.count === 0) { lease.restore(); requestLeases.delete(key); }
    if (!requestLeases.size) { restoreRequestQueue?.(); restoreRequestQueue = undefined; }
  };
}

type ArchitectureViewer = {
  scene: Pick<Viewer['scene'], 'primitives' | 'preRender' | 'postRender' | 'requestRender'
    | 'drawingBufferWidth' | 'drawingBufferHeight'>;
  camera: Pick<Viewer['camera'], 'changed' | 'viewMatrix'> & {
    frustum: Pick<Viewer['camera']['frustum'], 'projectionMatrix'>;
  };
};

export class CityArchitectureLayer {
  private collection: PrimitiveCollection;
  private tileset?: Cesium3DTileset;
  private settings?: SceneSettings;
  private source?: { dataset: string; buildings?: number };
  private failure?: Error;
  private controller?: AbortController;
  private generation = 0;
  private loading = false;
  private disposed = false;
  private framePending = true;
  private renderedView = new Matrix4();
  private renderedProjection = new Matrix4();
  private renderedWidth = 0;
  private renderedHeight = 0;
  private completed = 0;
  private farWorkingSetBytes = 0;
  private cached = new Set<Cesium3DTile>();
  private visible = new Set<Cesium3DTile>();
  private removeEvents: (() => void)[] = [];
  private removeRender: (() => void)[];
  private releaseRequests?: () => void;
  private shader = new CustomShader({
    uniforms: { u_night: { type: UniformType.FLOAT, value: 0 }, u_glow: { type: UniformType.FLOAT, value: 1 } },
    fragmentShaderText: `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        material.diffuse *= mix(1.0, 0.5, u_night);
        material.emissive *= u_night * u_glow;
      }`,
  });

  constructor(private viewer: ArchitectureViewer, private onError: (message: string) => void) {
    const scene = viewer.scene;
    this.collection = scene.primitives.add(new PrimitiveCollection());
    const collection = this.collection as PrimitiveCollection & { update(frameState: unknown): void };
    const update = collection.update.bind(collection);
    collection.update = frameState => {
      try { update(frameState); }
      catch (error) { this.fail(error, true); throw error; }
    };
    this.removeRender = [
      scene.preRender.addEventListener(() => this.visible.clear()),
      scene.postRender.addEventListener(() => {
        Matrix4.clone(viewer.camera.viewMatrix, this.renderedView);
        Matrix4.clone(viewer.camera.frustum.projectionMatrix, this.renderedProjection);
        this.renderedWidth = scene.drawingBufferWidth;
        this.renderedHeight = scene.drawingBufferHeight;
        this.framePending = false;
      }),
      viewer.camera.changed.addEventListener(() => { this.framePending = true; scene.requestRender(); }),
    ];
  }

  get error(): Error | undefined { return this.failure; }
  get progress(): number { return this.completed; }
  get ready(): boolean {
    if (this.disposed) return false;
    if (this.settings?.buildings === false) return true;
    return !this.failure && !this.loading && !this.framePending && Boolean(this.tileset?.tilesLoaded)
      && Matrix4.equals(this.viewer.camera.viewMatrix, this.renderedView)
      && Matrix4.equals(this.viewer.camera.frustum.projectionMatrix, this.renderedProjection)
      && this.viewer.scene.drawingBufferWidth === this.renderedWidth
      && this.viewer.scene.drawingBufferHeight === this.renderedHeight;
  }

  async load(dataset: string, buildings?: number): Promise<void> {
    if (this.disposed) return;
    this.clear();
    this.source = { dataset, buildings };
    this.failure = undefined;
    this.loading = true;
    const generation = this.generation, controller = new AbortController();
    this.controller = controller;
    let timer: ReturnType<typeof setTimeout> | undefined, removeAbort: (() => void) | undefined;
    let expired = false;
    try {
      const response = await fetch('/architecture-city/manifest.json', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error(`Architecture manifest HTTP ${response.status}`);
      const manifest = parseCityArchitectureManifest(await response.json(), dataset, buildings);
      if (this.disposed || generation !== this.generation) return;
      // Empty spatial parents cannot substitute for far content when native traversal lowers detail.
      this.farWorkingSetBytes = manifest.lods.far.decodedBytes + manifest.lods.far.bytes;
      this.releaseRequests = acquireRequestQueue();
      const pending = Cesium3DTileset.fromUrl(`/architecture-city/${manifest.tileset}`, {
        ...this.budget(), featureIdLabel: 'building',
        skipLevelOfDetail: false, dynamicScreenSpaceError: false, foveatedScreenSpaceError: false,
        preloadWhenHidden: false, preloadFlightDestinations: false,
      }).then(tileset => {
        if (expired || this.disposed || generation !== this.generation) tileset.destroy();
        return tileset;
      });
      const tileset = await Promise.race([pending, new Promise<never>((_, reject) => {
        const cancel = () => reject(new Error('Architecture load cancelled.'));
        controller.signal.addEventListener('abort', cancel, { once: true });
        removeAbort = () => controller.signal.removeEventListener('abort', cancel);
        timer = setTimeout(() => reject(new Error('Architecture tileset load timed out.')), 15_000);
      })]);
      if (this.disposed || generation !== this.generation) return;
      tileset.customShader = this.shader;
      this.tileset = tileset;
      this.removeEvents = [
        tileset.tileLoad.addEventListener((tile: Cesium3DTile) => { this.cached.add(tile); this.completed++; }),
        tileset.tileUnload.addEventListener((tile: Cesium3DTile) => this.cached.delete(tile)),
        tileset.tileVisible.addEventListener((tile: Cesium3DTile) => this.visible.add(tile)),
        tileset.tileFailed.addEventListener((error: { url: string; message: string }) =>
          this.fail(new Error(`${error.message} (${error.url})`))),
        tileset.loadProgress.addEventListener(() => this.viewer.scene.requestRender()),
      ];
      this.collection.add(tileset);
      this.loading = false;
      if (this.settings) this.applySettings(this.settings);
      else this.viewer.scene.requestRender();
    } catch (error) {
      expired = true;
      if (!this.disposed && generation === this.generation) {
        this.loading = false;
        this.releaseRequests?.(); this.releaseRequests = undefined;
        this.fail(error);
      }
    } finally {
      clearTimeout(timer);
      removeAbort?.();
    }
  }

  update(settings: SceneSettings): void {
    if (this.disposed) return;
    const previous = this.settings;
    this.settings = settings;
    if (previous && previous.buildings === settings.buildings && previous.night === settings.night
      && previous.glow === settings.glow && previous.quality === settings.quality) return;
    this.applySettings(settings);
  }

  private applySettings(settings: SceneSettings): void {
    this.shader.setUniform('u_night', Number(settings.night));
    this.shader.setUniform('u_glow', settings.glow);
    if (this.tileset) {
      Object.assign(this.tileset, this.budget());
      this.tileset.show = settings.buildings;
    }
    this.framePending = true;
    this.viewer.scene.requestRender();
  }

  private budget() {
    const budget = budgets[this.settings?.quality ?? 'medium'];
    return { ...budget, cacheBytes: this.farWorkingSetBytes + budget.cacheBytes };
  }

  selected(picked: unknown): SelectedBuilding | undefined {
    if (this.disposed || !this.settings?.buildings || !(picked instanceof Cesium3DTileFeature)
      || picked.tileset !== this.tileset) return undefined;
    const id: unknown = picked.getProperty('id'), name: unknown = picked.getProperty('name');
    const kind: unknown = picked.getProperty('kind'), height: unknown = picked.getProperty('height');
    const basis: unknown = picked.getProperty('basis'), estimated: unknown = picked.getProperty('estimated');
    if (typeof id !== 'string' || typeof name !== 'string' || typeof kind !== 'string'
      || typeof height !== 'number' || !Number.isFinite(height)
      || !['height', 'levels', 'fallback', 'reference'].includes(String(basis)) || typeof estimated !== 'boolean') {
      this.fail(new Error('Invalid architecture feature metadata.'));
      return undefined;
    }
    try {
      const model = parseLandmarkModel(picked.getProperty('model'), id);
      if (basis === 'reference'
        ? model?.source?.type !== 'osm-attraction' || kind !== 'attraction:big_wheel' || height !== model.height || estimated
        : model?.source?.type === 'osm-attraction') {
        throw new Error('Invalid supplemental attraction metadata.');
      }
      const source = { id, name, kind, height, basis: basis as BuildingProperties['basis'], estimated };
      const heightReference = parseHeightReference(picked.getProperty('heightReference'), source);
      if (model && heightReference) throw new Error('Conflicting architecture height metadata.');
      return { ...source, ...(model ? { model } : {}), ...(heightReference ? { heightReference } : {}) };
    } catch (error) {
      this.fail(error);
      return undefined;
    }
  }

  async retry(): Promise<void> {
    if (this.failure && this.source && !this.loading && !this.disposed) {
      await this.load(this.source.dataset, this.source.buildings);
    }
  }

  private fail(error: unknown, renderFailure = false): void {
    if (this.disposed || this.failure && !renderFailure) return;
    const notified = Boolean(this.failure);
    this.failure = error instanceof Error ? error : new Error(String(error));
    if (!notified) this.onError(`全城建筑加载失败：${this.failure.message}。已保留可用分块，可点击“重试加载”。`);
  }

  resources() {
    const visible = this.settings?.buildings && !this.disposed ? [...this.visible] : [];
    const buildings = (tiles: Cesium3DTile[]) => tiles.reduce((sum, tile) => sum + tile.content.featuresLength, 0);
    return {
      tilesets: Number(Boolean(this.tileset)), cachedTiles: this.cached.size, visibleTiles: visible.length,
      visibleBuildings: buildings(visible), far: buildings(visible.filter(tile => tile.extras?.lod === 'far')),
      mid: buildings(visible.filter(tile => tile.extras?.lod === 'mid')), near: buildings(visible.filter(tile => tile.extras?.lod === 'near')),
      triangles: visible.reduce((sum, tile) => sum + tile.content.trianglesLength, 0),
      bytes: this.tileset?.totalMemoryUsageInBytes ?? 0,
      farWorkingSetBytes: this.farWorkingSetBytes,
      cacheBytes: this.tileset?.cacheBytes ?? 0, maximumCacheOverflowBytes: this.tileset?.maximumCacheOverflowBytes ?? 0,
      loading: !this.ready, failure: this.failure?.message, disposed: this.disposed,
    };
  }

  private clear(): void {
    this.generation++;
    this.controller?.abort();
    this.removeEvents.splice(0).forEach(remove => remove());
    if (this.tileset) this.collection.remove(this.tileset);
    this.releaseRequests?.(); this.releaseRequests = undefined;
    this.tileset = undefined;
    this.farWorkingSetBytes = 0;
    this.cached.clear(); this.visible.clear();
    this.framePending = true;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.removeRender.forEach(remove => remove());
    this.viewer.scene.primitives.remove(this.collection);
    this.shader.destroy();
  }
}
