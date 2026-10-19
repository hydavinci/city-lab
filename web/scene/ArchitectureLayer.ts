import {
  Axis, Cartesian3, CustomShader, Math as CesiumMath, Model, PrimitiveCollection,
  Transforms, UniformType, type Viewer,
} from 'cesium';
import {
  architectureLod, parseArchitectureManifest, type ArchitectureLod, type ArchitectureManifest,
} from '../core/architecture';
import { intersects } from '../core/geo';
import type { BuildingProperties, SceneSettings } from '../core/types';

interface Resource {
  lod: ArchitectureLod;
  url: string;
  model: Model;
  removeError: () => void;
}

export class ArchitectureLayer {
  private collection: PrimitiveCollection;
  private manifest?: ArchitectureManifest;
  private dataset?: string;
  private settings?: SceneSettings;
  private active?: Resource;
  private incoming?: Resource;
  private pendingLod?: ArchitectureLod;
  private pendingSince = 0;
  private loading = false;
  private failure?: Error;
  private generation = 0;
  private manifestGeneration = 0;
  private abort?: AbortController;
  private manifestAbort?: AbortController;
  private urls = new Set<string>();
  private disposed = false;
  private removeRender: () => void;
  private shader = new CustomShader({
    uniforms: { u_night: { type: UniformType.FLOAT, value: 0 }, u_glow: { type: UniformType.FLOAT, value: 1 } },
    fragmentShaderText: `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        material.diffuse *= mix(1.0, 0.5, u_night);
        material.emissive *= u_night * u_glow;
      }`,
  });

  constructor(
    private viewer: Viewer,
    private onReplace: (ids: ReadonlySet<string>) => void,
    private onError: (message: string) => void,
    private onReserve: (ids: ReadonlySet<string>) => void = () => {},
  ) {
    this.collection = viewer.scene.primitives.add(new PrimitiveCollection());
    const collection = this.collection as PrimitiveCollection & { update(frameState: unknown): void };
    const update = collection.update.bind(collection);
    collection.update = frameState => {
      try { update(frameState); }
      catch (error) { this.deferFailure(error); }
    };
    this.removeRender = viewer.scene.preRender.addEventListener(() => this.sync());
  }

  get ready(): boolean { return !this.loading && !this.pendingLod; }

  async load(dataset: string): Promise<void> {
    if (this.disposed) return;
    this.dataset = dataset;
    this.manifestAbort?.abort();
    this.clearModels();
    this.manifest = undefined;
    this.onReserve(new Set());
    this.failure = undefined;
    const generation = ++this.manifestGeneration, controller = new AbortController();
    this.manifestAbort = controller;
    this.loading = true;
    try {
      const response = await fetch('/architecture/manifest.json', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error(`Architecture manifest HTTP ${response.status}`);
      const raw: unknown = await response.json();
      if (this.disposed || generation !== this.manifestGeneration) return;
      this.manifest = parseArchitectureManifest(raw, dataset);
      this.onReserve(new Set(this.manifest.buildings.map(building => building.id)));
      this.loading = false;
      if (this.settings) this.update(this.settings);
    } catch (error) {
      if (this.disposed || generation !== this.manifestGeneration) return;
      this.loading = false;
      this.fail(error);
    } finally {
      if (!this.disposed) this.viewer.scene.requestRender();
    }
  }

  update(settings: SceneSettings): void {
    if (this.disposed) return;
    this.settings = settings;
    this.shader.setUniform('u_night', settings.night ? 1 : 0);
    this.shader.setUniform('u_glow', settings.glow);
    const manifest = this.manifest;
    if (!manifest || this.failure) return;
    const camera = this.viewer.camera, view = camera.computeViewRectangle();
    const visible = settings.buildings && (!view || intersects(manifest.bounds, [
      CesiumMath.toDegrees(view.west), CesiumMath.toDegrees(view.south),
      CesiumMath.toDegrees(view.east), CesiumMath.toDegrees(view.north),
    ]));
    const distance = Cartesian3.distance(camera.positionWC, Cartesian3.fromDegrees(...manifest.origin));
    const lod = visible ? architectureLod(distance, this.active?.lod, settings.quality) : undefined;
    if (!lod) this.clearModels();
    else if (lod === this.active?.lod) {
      if (this.pendingLod) this.cancelIncoming();
    } else if (lod !== this.pendingLod) {
      this.cancelIncoming();
      void this.loadModel(lod);
    }
    this.viewer.scene.requestRender();
  }

  private async loadModel(lod: ArchitectureLod): Promise<void> {
    const manifest = this.manifest!;
    const generation = this.generation, controller = new AbortController();
    this.abort = controller;
    this.pendingLod = lod;
    this.pendingSince = performance.now();
    let url: string | undefined;
    try {
      const asset = manifest.lods[lod];
      const response = await fetch(`/architecture/${asset.uri}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error(`Architecture asset HTTP ${response.status}: ${lod}`);
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (this.disposed || generation !== this.generation) return;
      if (bytes.byteLength !== asset.bytes || hash !== asset.sha256) throw new Error(`Architecture hash/bytes mismatch: ${lod}`);
      url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
      this.urls.add(url);
      const model = await Model.fromGltfAsync({
        url, show: false, modelMatrix: Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(...manifest.origin)),
        upAxis: Axis.Z, forwardAxis: Axis.Y, incrementallyLoadTextures: false,
        customShader: this.shader, enableShowOutline: false,
      });
      if (this.disposed || generation !== this.generation) {
        model.destroy();
        this.releaseURL(url);
        return;
      }
      const removeError = model.errorEvent.addEventListener(error => this.deferFailure(error));
      this.incoming = { lod, url, model, removeError };
      this.collection.add(model);
      this.viewer.scene.requestRender();
    } catch (error) {
      if (url) this.releaseURL(url);
      if (!this.disposed && generation === this.generation) this.fail(error);
    }
  }

  private sync(): void {
    if (this.disposed) return;
    if (this.pendingLod && performance.now() - this.pendingSince > 30_000) {
      this.fail(new Error(`Architecture GPU preparation timed out: ${this.pendingLod}`));
      return;
    }
    if (!this.incoming?.model.ready) return;
    const previous = this.active;
    this.active = this.incoming;
    this.incoming = undefined;
    this.pendingLod = undefined;
    this.active.model.show = true;
    this.onReplace(new Set(this.manifest!.buildings.map(building => building.id)));
    if (previous) this.removeResource(previous);
    this.viewer.scene.requestRender();
  }

  private deferFailure(error: unknown): void {
    const generation = this.generation;
    // Model.errorEvent is raised inside Model.update; destroying there corrupts its frame.
    queueMicrotask(() => {
      if (!this.disposed && generation === this.generation) this.fail(error);
    });
  }

  private fail(error: unknown): void {
    if (this.disposed || this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.clearModels();
    this.onError(`姑苏精细街区加载失败：${this.failure.message}。已保留基础建筑，可点击“重试加载”。`);
  }

  private releaseURL(url: string): void {
    if (this.urls.delete(url)) URL.revokeObjectURL(url);
  }

  private removeResource(resource: Resource): void {
    resource.removeError();
    this.collection.remove(resource.model);
    this.releaseURL(resource.url);
  }

  private cancelIncoming(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = undefined;
    if (this.incoming) this.removeResource(this.incoming);
    this.incoming = undefined;
    this.pendingLod = undefined;
    for (const url of this.urls) if (url !== this.active?.url) this.releaseURL(url);
  }

  private clearModels(): void {
    this.cancelIncoming();
    if (this.active) {
      this.removeResource(this.active);
      this.active = undefined;
      this.onReplace(new Set());
    }
  }

  selected(picked: unknown): BuildingProperties | undefined {
    if (!this.active || !picked || typeof picked !== 'object' || !('primitive' in picked)
      || picked.primitive !== this.active.model || !('detail' in picked)) return undefined;
    const detail = picked.detail;
    if (!detail || typeof detail !== 'object' || !('node' in detail)) return undefined;
    const runtimeNode = detail.node;
    if (!runtimeNode || typeof runtimeNode !== 'object' || !('node' in runtimeNode)) return undefined;
    const node = runtimeNode.node;
    if (!node || typeof node !== 'object' || !('name' in node)) return undefined;
    return this.manifest?.buildings.find(building => building.id === node.name);
  }

  retry(): void {
    if (this.failure && this.dataset) void this.load(this.dataset);
  }

  resources() {
    return { models: this.collection.length, urls: this.urls.size, lod: this.active?.lod,
      pending: this.pendingLod, replacing: this.active ? this.manifest!.buildings.length : 0,
      loading: !this.ready, failure: this.failure?.message, disposed: this.disposed };
  }

  destroy(): void {
    this.manifestGeneration++;
    this.manifestAbort?.abort();
    this.removeRender();
    this.clearModels();
    this.disposed = true;
    this.viewer.scene.primitives.remove(this.collection);
    this.shader.destroy();
  }
}
