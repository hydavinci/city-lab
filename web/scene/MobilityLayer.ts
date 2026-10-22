import {
  BoundingSphere, Cartesian2, Cartesian3, Color, CorridorGeometry, CornerType, GeometryInstance,
  MaterialAppearance, Math as CesiumMath, Primitive, PrimitiveCollection,
  Matrix3, Matrix4, Model, ModelAnimationLoop, Transforms,
  type Camera, type Ellipsoid, type Event, type Ray,
} from 'cesium';
import type { Bounds, SceneSettings } from '../core/types';
import { parseEnhancementManifest, type ActorKind, type EnhancementManifest, type XY } from '../core/enhancements';
import {
  mobilityBudget, parseMobilityChunk, parseMobilityManifest, roadSegmentId,
  type MobileActor, type MobilityCell, type MobilityChunk, type MobilityManifest, type MobilityResource, type MobilityResources, type WorldSnapshot,
} from '../core/mobility';
import { MobilityWorld } from '../core/mobility-world';
import { MobilityClock } from '../core/mobility-clock';
import { intersects } from '../core/geo';
import { distance, project, unproject } from '../../pipeline/enhancements/geometry';
import { colorMaterial } from './materials';

type MobilityViewer = {
  canvas: { width: number; height: number };
  camera: Pick<Camera, 'changed' | 'positionCartographic' | 'computeViewRectangle' | 'getPixelSize' | 'getPickRay'>;
  scene: {
    primitives: PrimitiveCollection; postRender: Event; requestRender(): void;
    canvas: { clientWidth: number; clientHeight: number };
    globe: { ellipsoid: Ellipsoid; pick(ray: Ray, scene: unknown): Cartesian3 | undefined };
  };
};
interface CellRecord { chunk: MobilityChunk; registered: boolean }
interface Batch { primitive: Primitive; keys: Set<string> }
const limits = { low: 9, medium: 16, high: 25 };

export class MobilityLayer {
  private collection: PrimitiveCollection;
  private world = new MobilityWorld({ seed: 7, vehicles: 60, pedestrians: 90, arrivals: true });
  private settings?: SceneSettings;
  private manifest?: MobilityManifest;
  private assets?: EnhancementManifest;
  private baseDataset?: string;
  private cells = new Map<string, CellRecord>();
  private pending = new Map<string, AbortController>();
  private inFlight = new Set<Promise<void>>();
  private controller = new AbortController();
  private generation = 0;
  private wanted = new Set<string>();
  private pins = '';
  private batch?: Batch;
  private preparing?: Batch;
  private dirty = false;
  private loading = false;
  private active = false;
  private coverage = false;
  private failure?: Error;
  private completed = 0;
  private disposed = false;
  private replaced = new Set<string>();
  private removeEvents: (() => void)[];
  private clock = new MobilityClock();
  private clockActive = false;
  private raf?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private freezes = 0;
  private frozen?: WorldSnapshot;
  private models = new Map<number, { model: Model; animated: boolean; deadline: number }>();
  private modelPending = new Map<number, number>();
  private modelEpoch = 0;
  private poses = new Map<number, MobileActor>();
  private urls = new Map<ActorKind, Promise<string>>();
  private blobs = new Set<string>();
  private assetAbort = new AbortController();
  private appearance = new MaterialAppearance({ material: colorMaterial('#70756e'), translucent: false, flat: true });

  constructor(private viewer: MobilityViewer, private onError: (message: string) => void,
    private onReplacedRoads: (ids: ReadonlySet<string>) => void) {
    this.collection = viewer.scene.primitives.add(new PrimitiveCollection());
    const collection = this.collection as PrimitiveCollection & { update(frame: unknown): void };
    const update = collection.update.bind(collection);
    collection.update = frame => {
      try { update(frame); } catch (error) {
        this.fail(error); queueMicrotask(() => { if (!this.disposed) this.hide(); });
        throw error;
      }
    };
    this.removeEvents = [
      viewer.camera.changed.addEventListener(() => { if (this.settings) this.update(this.settings); }),
      viewer.scene.postRender.addEventListener(() => this.frame()),
    ];
    if (typeof document !== 'undefined') {
      const visibility = () => { this.stopClock(); this.wake(); };
      document.addEventListener('visibilitychange', visibility);
      this.removeEvents.push(() => document.removeEventListener('visibilitychange', visibility));
    }
  }
  get error(): Error | undefined { return this.failure; }
  get progress(): number { return this.completed; }
  get ready(): boolean {
    const state = this.resources().state;
    if (this.active && (this.loading || this.pending.size || this.preparing || this.dirty
      || this.modelPending.size || [...this.models.values()].some(record => !record.model.ready)
      || [...this.wanted].some(id => !this.cells.get(id)?.registered))) return false;
    return ['ready', 'inactive', 'paused', 'no-coverage'].includes(state);
  }

  freeze(): () => void {
    if (!this.freezes++) this.frozen = this.world.interpolated(this.clock.alpha);
    this.stopClock();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!--this.freezes) { this.frozen = undefined; this.world.finishInterpolation(); this.wake(); }
    };
  }

  async load(baseDataset: string): Promise<void> {
    if (this.disposed) return;
    this.reset(); this.baseDataset = baseDataset; this.loading = true;
    const generation = this.generation, signal = this.controller.signal;
    try {
      const manifest = parseMobilityManifest(await this.read('/mobility/manifest.json', signal), baseDataset);
      const assets = parseEnhancementManifest(await this.read(`/${manifest.assets.uri}`, signal, manifest.assets), baseDataset);
      if (generation !== this.generation || this.disposed) return;
      this.manifest = manifest; this.assets = assets; this.loading = false; this.completed += 2;
      if (this.settings) this.update(this.settings);
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      this.loading = false; this.fail(error); throw error;
    }
  }

  update(settings: SceneSettings): void {
    if (this.disposed) return;
    const recolor = this.settings?.night !== settings.night;
    this.settings = { ...settings };
    this.appearance.material.uniforms.color = Color.fromCssColorString(settings.night ? '#454d4e' : '#70756e');
    const view = this.view();
    this.active = Boolean(settings.roads && view);
    const retained = this.world.retainedCells(), wanted = new Set(retained);
    this.pins = [...retained].sort().join(';');
    this.coverage = false;
    if (this.active && this.manifest && view) {
      const visible = this.manifest.cells.filter(cell => intersects(cell.bounds, view.bounds));
      this.coverage = visible.some(cell => cell.status === 'ready');
      const byId = new Map(this.manifest.cells.map(cell => [cell.id, cell]));
      const candidates = new Set(visible.flatMap(cell => [cell.id, ...cell.neighbours]));
      const ordered = [...candidates].map(id => byId.get(id)!).filter(cell => cell.status === 'ready')
        .sort((a, b) => this.cellDistance(a, view.centre) - this.cellDistance(b, view.centre) || a.id.localeCompare(b.id));
      for (const cell of ordered) {
        if (wanted.size >= limits[settings.quality]) break;
        wanted.add(cell.id);
      }
    }
    this.wanted = wanted;
    for (const [id, controller] of this.pending) if (!wanted.has(id)) controller.abort();
    for (const [id, record] of this.cells) if (!wanted.has(id) && !retained.has(id)) {
      if (record.registered) this.world.removeChunk(id);
      this.cells.delete(id); this.markDirty();
    }
    const budget = mobilityBudget(settings.quality);
    this.world.setOptions({ seed: 7, ...budget, arrivals: this.active && retained.size < limits[settings.quality] });
    if (!this.active || this.failure) this.hide();
    else {
      if (this.batch) this.batch.primitive.show = true;
      if (this.preparing) this.preparing.primitive.show = true;
      if (this.batch) this.publish(this.batch.keys);
    }
    if (recolor) this.viewer.scene.requestRender();
    this.pump(); this.syncModels(); this.wake();
  }

  retry(): Promise<void> {
    if (!this.baseDataset) return Promise.reject(new Error('Activity has no base dataset'));
    return this.load(this.baseDataset);
  }

  resources(): MobilityResources {
    const snapshot = this.world.snapshot();
    let state: MobilityResources['state'] = 'ready', reason: MobilityResources['reason'];
    if (this.disposed) state = 'inactive';
    else if (this.failure) state = 'error';
    else if (this.loading || !this.manifest) state = this.loading ? 'loading' : 'inactive';
    else if (this.settings?.roads === false) { state = 'paused'; reason = 'roads-hidden'; }
    else if (!this.active) { state = 'inactive'; reason = 'overview'; }
    else if (!this.coverage) state = 'no-coverage';
    else if (this.pending.size || this.preparing || this.dirty || [...this.wanted].some(id =>
      !this.cells.get(id)?.registered) || this.modelPending.size || [...this.models.values()].some(record => !record.model.ready)) state = 'loading';
    else if (this.freezes) { state = 'paused'; reason = 'export'; }
    else if (typeof document !== 'undefined' && document.hidden) { state = 'paused'; reason = 'page-hidden'; }
    const actors = snapshot.actors;
    return { state, ...(reason ? { reason } : {}), cells: this.disposed ? 0 : this.cells.size,
      vehicles: actors.filter(actor => !actor.kind.startsWith('person-')).length,
      pedestrians: actors.filter(actor => actor.kind.startsWith('person-')).length,
      models: this.models.size, urls: this.blobs.size, pending: this.disposed ? 0 : this.inFlight.size + this.modelPending.size, time: snapshot.time,
      ...(this.failure ? { failure: this.failure.message } : {}) };
  }

  destroy(): void {
    if (this.disposed) return;
    this.reset(); this.disposed = true; this.removeEvents.forEach(remove => remove());
    this.viewer.scene.primitives.remove(this.collection);
  }

  private view(): { bounds: Bounds; centre: XY } | undefined {
    const { camera, scene, canvas } = this.viewer;
    if (camera.positionCartographic.height > 10000) return;
    const ray = camera.getPickRay(new Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2));
    const hit = ray && scene.globe.pick(ray, scene);
    if (!hit || camera.getPixelSize(new BoundingSphere(hit, 1), canvas.width, canvas.height) > 2) return;
    const focus = scene.globe.ellipsoid.cartesianToCartographic(hit), rectangle = camera.computeViewRectangle();
    const centre: XY = [CesiumMath.toDegrees(focus.longitude), CesiumMath.toDegrees(focus.latitude)];
    const bounds = rectangle ? [rectangle.west, rectangle.south, rectangle.east, rectangle.north].map(CesiumMath.toDegrees) as Bounds
      : [centre[0] - 0.002, centre[1] - 0.002, centre[0] + 0.002, centre[1] + 0.002] as Bounds;
    if (!bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) return;
    return { bounds, centre };
  }
  private cellDistance(cell: MobilityCell, centre: XY): number {
    return distance(project([(cell.bounds[0] + cell.bounds[2]) / 2, (cell.bounds[1] + cell.bounds[3]) / 2], centre), [0, 0]);
  }
  private async read(url: string, signal: AbortSignal, expected?: MobilityResource): Promise<unknown> {
    return JSON.parse(new TextDecoder().decode(await this.readBytes(url, signal, expected)));
  }
  private async readBytes(url: string, signal: AbortSignal, expected?: Pick<MobilityResource, 'bytes' | 'sha256'>): Promise<ArrayBuffer> {
    signal.throwIfAborted();
    while (this.inFlight.size >= 4) { await Promise.race(this.inFlight); signal.throwIfAborted(); }
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; }); this.inFlight.add(done);
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) throw new Error(`Activity HTTP ${response.status}: ${url}`);
      const bytes = await response.arrayBuffer();
      signal.throwIfAborted();
      if (expected) {
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map(n => n.toString(16).padStart(2, '0')).join('');
        if (bytes.byteLength !== expected.bytes || hash !== expected.sha256) throw new Error(`Activity bytes/hash mismatch: ${url}`);
      }
      return bytes;
    } finally { this.inFlight.delete(done); release(); }
  }
  private pump(): void {
    if (this.disposed || this.failure || !this.active || !this.manifest || !this.settings) return;
    for (const id of this.wanted) {
      if (this.cells.has(id) || this.pending.has(id)) continue;
      if (this.pending.size >= 4 || this.cells.size + this.pending.size >= limits[this.settings.quality]) break;
      const cell = this.manifest.cells.find(cell => cell.id === id)!;
      if (!cell || cell.status !== 'ready') continue;
      const controller = new AbortController(), generation = this.generation;
      this.pending.set(id, controller);
      void this.read(`/${cell.resource!.uri}`, AbortSignal.any([controller.signal, this.controller.signal]), cell.resource)
        .then(value => {
          if (this.disposed || generation !== this.generation || controller.signal.aborted || !this.wanted.has(id)) return;
          this.cells.set(id, { chunk: parseMobilityChunk(value, cell), registered: false }); this.markDirty();
        }).catch(error => {
          if (this.disposed || generation !== this.generation || controller.signal.aborted || !this.wanted.has(id)) return;
          this.fail(new Error(`Activity cell ${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
        }).finally(() => {
          if (this.pending.get(id) === controller) this.pending.delete(id);
          this.pump();
        });
    }
  }
  private markDirty(): void {
    if (this.dirty) return;
    this.dirty = true;
    queueMicrotask(() => {
      if (this.disposed || !this.dirty) return;
      this.dirty = false;
      try { this.rebuild(); } catch (error) { this.fail(error); }
    });
  }
  private rebuild(): void {
    if (this.preparing) this.collection.remove(this.preparing.primitive);
    this.preparing = undefined;
    if (!this.cells.size) {
      if (this.batch) this.collection.remove(this.batch.primitive);
      this.batch = undefined; this.publish(new Set()); return;
    }
    const unique = new Map<string, { points: XY[]; width: number; height: number; sourceIds: string[] }>();
    for (const record of [...this.cells.values()].sort((a, b) => a.chunk.id.localeCompare(b.chunk.id))) {
      for (const surface of record.chunk.surfaces) {
        const points = surface.points.map(point => unproject(point, record.chunk.network.origin)), previous = unique.get(surface.id);
        if (previous) {
          if (previous.width !== surface.width || previous.height !== surface.height || previous.points.length !== points.length
            || previous.sourceIds.join() !== surface.sourceIds.join()
            || points.some((point, i) => distance(project(point, points[0]), project(previous.points[i], points[0])) > 0.05)) {
            throw new Error(`Contradictory activity surface ${surface.id}`);
          }
        } else unique.set(surface.id, { points, width: surface.width, height: surface.height, sourceIds: surface.sourceIds });
      }
    }
    const keys = new Set<string>(), instances: GeometryInstance[] = [];
    for (const [id, surface] of unique) {
      instances.push(new GeometryInstance({ id, geometry: new CorridorGeometry({
        positions: Cartesian3.fromDegreesArray(surface.points.flat()), width: surface.width, height: surface.height,
        cornerType: CornerType.BEVELED, vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
      }) }));
      for (const source of surface.sourceIds.filter(id => id.startsWith('way/'))) for (let i = 1; i < surface.points.length; i++) {
        keys.add(roadSegmentId(source, surface.points[i - 1], surface.points[i]));
      }
    }
    const primitive = this.collection.add(new Primitive({ geometryInstances: instances,
      appearance: this.appearance, releaseGeometryInstances: false }));
    primitive.show = this.active;
    this.preparing = { primitive, keys }; this.viewer.scene.requestRender();
  }
  private frame(): void {
    if (this.disposed || this.failure) return;
    try {
      if (this.preparing?.primitive.ready) {
        if (this.batch) this.collection.remove(this.batch.primitive);
        this.batch = this.preparing; this.preparing = undefined;
        for (const record of this.cells.values()) if (!record.registered) {
          this.world.addChunk(record.chunk); record.registered = true; this.completed++;
        }
        if (this.active) this.publish(this.batch.keys);
        this.viewer.scene.requestRender();
      }
      this.syncModels(); this.wake();
    } catch (error) { this.fail(error); }
  }
  private hide(): void {
    if (this.batch) this.batch.primitive.show = false;
    if (this.preparing) this.preparing.primitive.show = false;
    this.publish(new Set());
  }
  private publish(keys: ReadonlySet<string>): void {
    if (keys.size === this.replaced.size && [...keys].every(key => this.replaced.has(key))) return;
    this.replaced = new Set(keys); this.onReplacedRoads(new Set(keys));
  }
  private fail(value: unknown): void {
    if (this.failure || this.disposed) return;
    this.failure = value instanceof Error ? value : new Error(String(value));
    this.stopClock();
    queueMicrotask(() => { if (!this.disposed) { this.hide(); this.clearModels(); } });
    this.onError(`模拟活动加载失败：${this.failure.message}。基础城市仍可浏览，可重试。`);
    this.viewer.scene.requestRender();
  }
  private reset(): void {
    this.stopClock(); this.clearModels();
    this.generation++; this.controller.abort(); this.controller = new AbortController();
    this.pending.forEach(controller => controller.abort());
    this.cells.clear(); this.world.clear(); this.manifest = undefined; this.assets = undefined;
    this.wanted.clear(); this.failure = undefined; this.loading = false; this.active = false; this.coverage = false; this.dirty = false;
    if (this.preparing) this.collection.remove(this.preparing.primitive);
    if (this.batch) this.collection.remove(this.batch.primitive);
    this.preparing = undefined; this.batch = undefined; this.publish(new Set());
  }

  private paused(): boolean {
    return this.disposed || !this.active || Boolean(this.failure) || !this.batch || this.freezes > 0
      || typeof document !== 'undefined' && document.hidden;
  }
  private gate() {
    const view = this.view();
    const outside = (cell: string, position: XY, kind: ActorKind) => {
      const chunk = this.cells.get(cell)?.chunk;
      if (!view || !chunk) return false;
      const point = unproject(position, chunk.network.origin);
      const radius = kind === 'bus' ? 5.2 : kind.startsWith('person-') ? 0.7 : 2.6;
      const lo = unproject([position[0] - radius, position[1] - radius], chunk.network.origin);
      const hi = unproject([position[0] + radius, position[1] + radius], chunk.network.origin);
      return !intersects([lo[0], lo[1], hi[0], hi[1]], view.bounds) && point.every(Number.isFinite);
    };
    return { canRetire: outside, canSpawn: (cell: string, position: XY, kind: ActorKind) => {
      const chunk = this.cells.get(cell)?.chunk;
      return Boolean(view && chunk && this.wanted.has(cell) && outside(cell, position, kind)
        && distance(project(unproject(position, chunk.network.origin), view.centre), [0, 0]) < 1500);
    } };
  }
  private wake(): void {
    if (typeof requestAnimationFrame !== 'function') return;
    if (this.paused()) { this.stopClock(); return; }
    const moving = this.models.size > 0 && this.world.snapshot().actors.some(actor => actor.speed > 0)
      || this.modelPending.size > 0 || [...this.models.values()].some(record => !record.model.ready);
    if (!moving && this.world.nextWakeTime() === undefined) { this.stopClock(); return; }
    if (!this.clockActive) { this.clock.advance(performance.now(), true, () => {}); this.clockActive = true; }
    if (this.raf !== undefined || this.timer !== undefined) return;
    const tick = () => {
      this.raf = undefined; this.timer = undefined;
      if (this.paused()) { this.stopClock(); return; }
      try {
        const steps = this.clock.advance(performance.now(), true, () => this.world.step(this.gate()));
        this.syncModels();
        if (moving || steps && this.models.size) this.viewer.scene.requestRender();
        if (steps && this.settings && [...this.world.retainedCells()].sort().join(';') !== this.pins) this.update(this.settings);
        if (steps) this.pump();
        this.wake();
      } catch (error) { this.fail(error); }
    };
    if (moving) this.raf = requestAnimationFrame(tick);
    else this.timer = setTimeout(tick, 50);
  }
  private stopClock(): void {
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.raf = undefined; this.timer = undefined;
    if (this.clockActive) {
      this.clockActive = false; this.clock.reset(); this.world.finishInterpolation();
      this.viewer.scene.requestRender();
    }
  }
  private syncModels(): void {
    if (this.disposed || !this.active || this.failure) {
      if (this.models.size || this.modelPending.size || this.urls.size) this.clearModels();
      return;
    }
    const snapshot = this.frozen ?? this.world.interpolated(this.clock.alpha);
    const view = this.view();
    const nearby = snapshot.actors.filter(actor => {
      const chunk = this.cells.get(actor.cell)?.chunk;
      return view && chunk && distance(project(unproject(actor.position, chunk.network.origin), view.centre), [0, 0]) <= 1500;
    });
    this.poses = new Map(nearby.map(actor => [actor.id, actor]));
    for (const [id, record] of this.models) if (!this.poses.has(id)) {
      this.collection.remove(record.model); this.models.delete(id);
    }
    for (const actor of nearby) {
      const record = this.models.get(actor.id);
      if (!record) {
        if (!this.modelPending.has(actor.id)) void this.loadModel(actor);
        continue;
      }
      record.model.modelMatrix = this.matrix(actor);
      if (!record.model.ready) {
        if (performance.now() > record.deadline) throw new Error(`Activity model readiness timed out: ${actor.kind}`);
        this.viewer.scene.requestRender();
      } else if (actor.kind.startsWith('person-') && !record.animated) {
        record.model.activeAnimations.animateWhilePaused = true;
        record.model.activeAnimations.add({ name: 'Walk', loop: ModelAnimationLoop.REPEAT,
          animationTime: () => {
            const pose = this.poses.get(actor.id);
            return pose && pose.speed > 1e-3 ? pose.walkPhase : 0;
          } });
        record.animated = true;
      }
    }
  }
  private matrix(actor: MobileActor): Matrix4 {
    const chunk = this.cells.get(actor.cell)?.chunk;
    if (!chunk) throw new Error(`Missing actor cell: ${actor.cell}`);
    const edge = chunk.network.edges.find(edge => edge.id === actor.edge)!;
    const surface = chunk.surfaces.find(surface => surface.sourceIds.some(id => edge.sourceIds.includes(id)));
    if (!surface) throw new Error(`Missing displayed actor surface: ${actor.edge}`);
    const coordinate = unproject(actor.position, chunk.network.origin);
    const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(...coordinate, surface.height));
    return Matrix4.multiply(enu, Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(Math.PI / 2 - actor.heading)), new Matrix4());
  }
  private assetURL(kind: ActorKind): Promise<string> {
    const existing = this.urls.get(kind);
    if (existing) return existing;
    const asset = this.assets?.assets.find(asset => asset.kind === kind);
    if (!asset) return Promise.reject(new Error(`Missing activity asset: ${kind}`));
    const epoch = this.modelEpoch, signal = AbortSignal.any([this.assetAbort.signal, this.controller.signal]);
    const promise = this.readBytes(`/enhancements/${asset.uri}`, signal, asset).then(bytes => {
      if (this.disposed || epoch !== this.modelEpoch) throw new Error('Obsolete activity asset');
      const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
      this.blobs.add(url); return url;
    });
    this.urls.set(kind, promise); return promise;
  }
  private async loadModel(actor: MobileActor): Promise<void> {
    const epoch = this.modelEpoch;
    const signal = this.assetAbort.signal;
    this.modelPending.set(actor.id, epoch);
    let timer: ReturnType<typeof setTimeout> | undefined, expired = false;
    let removeAbort: (() => void) | undefined;
    try {
      const url = await this.assetURL(actor.kind);
      if (this.disposed || epoch !== this.modelEpoch || !this.poses.has(actor.id)) return;
      const pending = Model.fromGltfAsync({ url, modelMatrix: this.matrix(this.poses.get(actor.id)!), scale: 1,
        minimumPixelSize: 0, id: { activity: actor.id, kind: actor.kind } }).then(model => {
        if (expired || this.disposed || epoch !== this.modelEpoch || !this.poses.has(actor.id)) {
          model.destroy(); throw new Error('Obsolete activity model');
        }
        return model;
      });
      const model = await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error(`Activity model decode timed out: ${actor.kind}`)); }, 15000);
        const abort = () => { expired = true; reject(new DOMException('Obsolete activity model', 'AbortError')); };
        signal.addEventListener('abort', abort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
      })]);
      if (this.disposed || epoch !== this.modelEpoch || !this.poses.has(actor.id)) { model.destroy(); return; }
      model.errorEvent.addEventListener(error => queueMicrotask(() => {
        if (!this.disposed && epoch === this.modelEpoch) this.fail(error);
      }));
      this.collection.add(model); this.models.set(actor.id, { model, animated: false, deadline: performance.now() + 15000 });
      this.completed++; this.viewer.scene.requestRender();
    } catch (error) {
      if (this.disposed || epoch !== this.modelEpoch || !this.poses.has(actor.id)) return;
      this.fail(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbort?.();
      if (this.modelPending.get(actor.id) === epoch) this.modelPending.delete(actor.id);
      this.wake();
    }
  }
  private clearModels(): void {
    this.modelEpoch++; this.assetAbort.abort(); this.assetAbort = new AbortController();
    this.models.forEach(record => this.collection.remove(record.model)); this.models.clear();
    this.modelPending.clear(); this.poses.clear(); this.urls.clear();
    this.blobs.forEach(url => URL.revokeObjectURL(url)); this.blobs.clear();
  }
}
