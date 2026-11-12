import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Cartesian3, Cartographic, Ellipsoid, Event, Math as CesiumMath, Model, PrimitiveCollection, Ray, Rectangle, Viewer,
} from 'cesium';
import { MobilityLayer } from '../../web/scene/MobilityLayer';
import { DetailLayer } from '../../web/scene/DetailLayer';
import { defaultSettings } from '../../web/core/settings';
import { roadSegmentId, unreplacedRoadParts, type MobilityCell, type MobilityChunk, type MobilityManifest } from '../../web/core/mobility';
import { manifest as districtManifest, publicationFixture } from '../fixtures/enhancements';
import { mobilityFixture, resource, outsideGate, twoChunkFixture } from '../fixtures/citywide-mobility';
import { stitchChunks } from '../../pipeline/mobility/stitch';
import { unproject } from '../../pipeline/enhancements/geometry';
import type { Bounds } from '../../web/core/types';
import type { MobilityWorld } from '../../web/core/mobility-world';

const rendered = vi.hoisted(() => ({ primitives: [] as {
  ready: boolean; show: boolean; broken?: boolean; destroyed: boolean; options: Record<string, unknown>;
  getGeometryInstanceAttributes(id: unknown): { show: Uint8Array };
}[], models: [] as { destroyed: boolean }[] }));
vi.mock('cesium', async original => {
  const cesium = await original<typeof import('cesium')>();
  class Model {
    ready = true; destroyed = false; readyEvent = new cesium.Event(); errorEvent = new cesium.Event();
    modelMatrix: unknown; show = true; id: unknown;
    activeAnimations = { animateWhilePaused: false, add: () => ({}) };
    constructor(options: { modelMatrix: unknown; id: unknown }) {
      this.modelMatrix = options.modelMatrix; this.id = options.id; rendered.models.push(this);
    }
    static async fromGltfAsync(options: { modelMatrix: unknown; id: unknown }) { return new Model(options); }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
    update() {}
  }
  return { ...cesium, Model, Primitive: class {
    ready = false; show = true; destroyed = false; broken = false;
    appearance: unknown;
    attributes = new Map<unknown, { show: Uint8Array }>();
    constructor(readonly options: Record<string, unknown>) {
      this.appearance = options.appearance;
      const instances = Array.isArray(options.geometryInstances) ? options.geometryInstances : [options.geometryInstances];
      for (const instance of instances) this.attributes.set(instance.id, { show: new Uint8Array([1]) });
      rendered.primitives.push(this);
    }
    getGeometryInstanceAttributes(id: unknown) { return this.attributes.get(id)!; }
    update() { if (this.broken) throw new Error('simulated surface decode failure'); }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  } };
});

const layers: MobilityLayer[] = [];
function cells(chunks: MobilityChunk[]): { manifest: MobilityManifest; files: Map<string, string | Uint8Array<ArrayBuffer>> } {
  const fixture = mobilityFixture(), manifest = structuredClone(fixture.manifest);
  const files = new Map<string, string | Uint8Array<ArrayBuffer>>(), fixtureAssets = publicationFixture();
  const assets = JSON.stringify({ ...districtManifest, assets: fixtureAssets.assets.map(asset =>
    ({ ...asset, uri: `${districtManifest.id}/${asset.uri}` })) });
  manifest.assets = resource('enhancements/manifest.json', assets);
  files.set('/enhancements/manifest.json', assets);
  for (const asset of fixtureAssets.assets) files.set(`/enhancements/${districtManifest.id}/${asset.uri}`,
    new Uint8Array(asset.animation ? fixtureAssets.personGlb : fixtureAssets.glb));
  manifest.cells = chunks.map(chunk => {
    const text = JSON.stringify(chunk), uri = `mobility/${manifest.id}/${chunk.id.replace('/', '-')}.json`;
    files.set(`/${uri}`, text);
    return { id: chunk.id, bounds: chunk.bounds, status: 'ready' as const,
      neighbours: chunks.filter(other => other !== chunk
        && other.bounds[0] <= chunk.bounds[2] && other.bounds[2] >= chunk.bounds[0]
        && other.bounds[1] <= chunk.bounds[3] && other.bounds[3] >= chunk.bounds[1]).map(other => other.id), resource: resource(uri, text),
      driveMetres: 80, walkMetres: 20, diagnosticCodes: [] };
  });
  manifest.bounds = [
    Math.min(...chunks.map(chunk => chunk.bounds[0])), Math.min(...chunks.map(chunk => chunk.bounds[1])),
    Math.max(...chunks.map(chunk => chunk.bounds[2])), Math.max(...chunks.map(chunk => chunk.bounds[3])),
  ];
  manifest.coverage = { cells: chunks.length, ready: chunks.length, empty: 0, excluded: 0, failed: 0,
    driveMetres: chunks.length * 80, walkMetres: chunks.length * 20 };
  files.set('/mobility/manifest.json', JSON.stringify(manifest));
  return { manifest, files };
}
function remoteChunk(index: number): MobilityChunk {
  const chunk = mobilityFixture().chunk;
  const shift = index * 0.02;
  chunk.id = `cell/${index}`;
  chunk.network.origin[0] += shift;
  chunk.bounds = chunk.bounds.map((n, i) => n + (i % 2 === 0 ? shift : 0)) as Bounds;
  chunk.network.bounds = [...chunk.bounds];
  const remap = (id: string) => `remote${index}/${id}`;
  for (const edge of chunk.network.edges) {
    edge.id = remap(edge.id); edge.from = remap(edge.from); edge.to = remap(edge.to);
    edge.next = edge.next.map(remap);
  }
  for (const route of chunk.network.routes) {
    route.edges = route.edges.map(remap); route.entry = remap(route.entry); route.exit = remap(route.exit);
  }
  chunk.network.zones.forEach(zone => { zone.edges = zone.edges.map(remap); });
  chunk.ownedEdges = chunk.ownedEdges.map(remap);
  chunk.ports.forEach(port => { port.edge = remap(port.edge); port.coordinate[0] += shift; });
  chunk.surfaces.forEach(surface => { surface.id = remap(surface.id); });
  chunk.zoneIds.z = `junction/remote${index}`;
  return chunk;
}
function setup(chunks = [mobilityFixture().chunk]) {
  for (const name of ['HTMLCanvasElement', 'HTMLImageElement', 'ImageBitmap', 'OffscreenCanvas']) vi.stubGlobal(name, class {});
  const data = cells(chunks), focus = { lng: 120.68, lat: 31.32, sky: false, metresPerPixel: 1, span: 0.0005 };
  const scene = {
    primitives: new PrimitiveCollection(), postRender: new Event(), preRender: new Event(),
    requestRender: vi.fn(), canvas: { clientWidth: 1000, clientHeight: 800 },
    globe: { ellipsoid: Ellipsoid.WGS84, pick: () => focus.sky ? undefined : Cartesian3.fromDegrees(focus.lng, focus.lat) },
  };
  const camera = {
    changed: new Event(), moveEnd: new Event(),
    positionCartographic: Cartographic.fromDegrees(focus.lng, focus.lat, 1000),
    computeViewRectangle: () => Rectangle.fromDegrees(focus.lng - focus.span, focus.lat - focus.span, focus.lng + focus.span, focus.lat + focus.span),
    getPickRay: () => new Ray(), getPixelSize: () => focus.metresPerPixel,
  };
  const viewer = { scene, camera, canvas: { width: 1000, height: 800 } }, errors: string[] = [], replacements: Set<string>[] = [];
  const layer = new MobilityLayer(viewer, message => errors.push(message), ids => replacements.push(new Set(ids)));
  layers.push(layer);
  const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const text = data.files.get(String(url));
    return text === undefined ? new Response('missing', { status: 404 }) : new Response(text);
  });
  vi.stubGlobal('fetch', fetcher);
  layer.update({ ...defaultSettings });
  const frame = () => {
    rendered.primitives.forEach(primitive => { primitive.ready = true; });
    scene.postRender.raiseEvent();
  };
  const settle = async () => {
    await vi.waitFor(() => expect(layer.resources().pending).toBe(0));
    frame();
  };
  const move = (index: number) => {
    focus.lng = 120.68 + index * 0.02;
    camera.positionCartographic.longitude = CesiumMath.toRadians(focus.lng);
    layer.update({ ...defaultSettings });
  };
  return { ...data, layer, errors, replacements, fetcher, focus, viewer, frame, settle, move };
}

afterEach(() => {
  layers.splice(0).forEach(layer => layer.destroy());
  rendered.primitives.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
  rendered.models.length = 0;
});

describe('bounded nearby mobility loading', () => {
  it('publishes replacement segments only after their actual surface batch is render-ready', async () => {
    const { layer, replacements, settle } = setup();
    await layer.load('0123456789abcdef');
    await vi.waitFor(() => expect(layer.resources().pending).toBe(0));
    expect(layer.ready).toBe(false);
    expect(replacements.at(-1)?.size ?? 0).toBe(0);
    await settle();
    expect(layer.ready).toBe(true);
    expect(layer.resources()).toMatchObject({ state: 'ready', cells: 1, vehicles: 0, pedestrians: 0 });
    expect(replacements.at(-1)?.size).toBe(3);
  });

  it('rejects an altered cell resource and exposes its identity without destroying base primitives', async () => {
    const fixture = setup(), path = `/${fixture.manifest.cells[0].resource!.uri}`;
    fixture.files.set(path, '{"altered":true}');
    await fixture.layer.load('0123456789abcdef');
    await fixture.settle();
    expect(fixture.layer.resources().state).toBe('error');
    expect(fixture.layer.error?.message).toMatch(/hash|bytes/i);
    expect(fixture.errors.join()).toContain('cell/0');
    expect(fixture.layer.resources().cells).toBe(0);
    expect(fixture.viewer.scene.primitives.length).toBe(1);
    fixture.files.set(path, JSON.stringify(mobilityFixture().chunk));
    await fixture.layer.retry(); await fixture.settle();
    expect(fixture.layer.resources().state).toBe('ready');
  });

  it('ignores a late response for an obsolete camera window, even if fetch ignores abort', async () => {
    const fixture = setup([mobilityFixture().chunk, remoteChunk(2)]);
    let resolve!: (response: Response) => void;
    const old = new Promise<Response>(done => { resolve = done; });
    const original = fixture.fetcher.getMockImplementation()!;
    fixture.fetcher.mockImplementation((url, init) =>
      String(url).endsWith('cell-0.json') ? old : original(url, init));
    await fixture.layer.load('0123456789abcdef');
    await vi.waitFor(() => expect(fixture.fetcher.mock.calls.some(([url]) => String(url).endsWith('cell-0.json'))).toBe(true));
    fixture.move(2);
    resolve(new Response(JSON.stringify(mobilityFixture().chunk)));
    await fixture.settle();
    expect(fixture.layer.resources().cells).toBe(1);
    expect(fixture.layer.resources().state).toBe('ready');
    expect(fixture.replacements.at(-1)?.has(roadSegmentId('way/101', [120.68, 31.32],
      unproject([40, 0], mobilityFixture().chunk.network.origin)))).toBe(false);
  });

  it('uses camera coverage and pixel scale, not altitude alone, to deactivate overview activity', async () => {
    const fixture = setup();
    await fixture.layer.load('0123456789abcdef'); await fixture.settle();
    fixture.focus.sky = true;
    fixture.layer.update({ ...defaultSettings });
    expect(fixture.layer.resources()).toMatchObject({ state: 'inactive', reason: 'overview', cells: 0 });
    fixture.focus.sky = false; fixture.focus.metresPerPixel = 20;
    fixture.layer.update({ ...defaultSettings });
    expect(fixture.layer.resources().state).toBe('inactive');
    fixture.focus.metresPerPixel = 1;
    fixture.layer.update({ ...defaultSettings }); await fixture.settle();
    expect(fixture.layer.resources().state).toBe('ready');
  });

  it('distinguishes audited no-coverage from a missing or failed network response', async () => {
    const fixture = setup();
    const cell: MobilityCell = { ...fixture.manifest.cells[0], status: 'empty', driveMetres: 0, walkMetres: 0 };
    delete cell.resource;
    const manifest = { ...fixture.manifest, cells: [cell], coverage: {
      cells: 1, ready: 0, empty: 1, excluded: 0, failed: 0, driveMetres: 0, walkMetres: 0,
    } };
    fixture.files.set('/mobility/manifest.json', JSON.stringify(manifest));
    await fixture.layer.load('0123456789abcdef'); await fixture.settle();
    expect(fixture.layer.resources().state).toBe('no-coverage');
    expect(fixture.errors).toEqual([]);
    fixture.files.delete('/mobility/manifest.json');
    await expect(fixture.layer.load('0123456789abcdef')).rejects.toThrow(/404/);
    expect(fixture.layer.resources().state).toBe('error');
  });

  it('deduplicates shared halo surfaces and restores old road visibility on unload', async () => {
    const chunks = stitchChunks(Object.values(twoChunkFixture())), fixture = setup(chunks);
    await fixture.layer.load('0123456789abcdef'); await fixture.settle();
    expect(fixture.layer.resources().cells).toBe(2);
    expect(fixture.replacements.at(-1)?.size).toBe(3);
    fixture.layer.update({ ...defaultSettings, roads: false });
    expect(fixture.layer.resources()).toMatchObject({ state: 'paused', reason: 'roads-hidden' });
    expect(fixture.replacements.at(-1)?.size).toBe(0);
  });

  it('releases activity resources and ignores a model-free cell arriving after destruction', async () => {
    const fixture = setup();
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>(done => { resolve = done; }), original = fixture.fetcher.getMockImplementation()!;
    fixture.fetcher.mockImplementation((url, init) => String(url).endsWith('cell-0.json') ? response : original(url, init));
    await fixture.layer.load('0123456789abcdef');
    fixture.layer.destroy();
    resolve(new Response(JSON.stringify(mobilityFixture().chunk)));
    await new Promise(done => setTimeout(done, 0));
    expect(fixture.layer.resources()).toMatchObject({ state: 'inactive', cells: 0, models: 0, urls: 0, pending: 0 });
    expect(fixture.replacements.at(-1)?.size ?? 0).toBe(0);
  });

  it('survives ten camera load/unload cycles without retaining old cells or surfaces', async () => {
    const fixture = setup([mobilityFixture().chunk, remoteChunk(2)]);
    await fixture.layer.load('0123456789abcdef'); await fixture.settle();
    let live = 0;
    for (let i = 0; i < 10; i++) {
      fixture.move(i % 2 ? 0 : 2); await fixture.settle();
      expect(fixture.layer.resources().cells).toBe(1);
      live = Math.max(live, rendered.primitives.filter(primitive => !primitive.destroyed).length);
    }
    expect(live).toBeLessThanOrEqual(1);
    fixture.layer.destroy();
    expect(rendered.primitives.every(primitive => primitive.destroyed)).toBe(true);
  });

  it('limits pending HTTP work to four and the active cell set to each quality budget', async () => {
    const fixture = setup([mobilityFixture().chunk, ...Array.from({ length: 35 }, (_, i) => remoteChunk(i + 1))]);
    fixture.focus.span = 1;
    const delayed: (() => void)[] = [], original = fixture.fetcher.getMockImplementation()!;
    let automatic = false, current = 0, maximum = 0;
    fixture.fetcher.mockImplementation(async (url, init) => {
      if (!String(url).includes('/cell-')) return original(url, init);
      current++; maximum = Math.max(maximum, current);
      if (!automatic) await new Promise<void>(resolve => delayed.push(resolve));
      try { return await original(url, init); } finally { current--; }
    });
    await fixture.layer.load('0123456789abcdef');
    await vi.waitFor(() => expect(delayed.length).toBe(4));
    expect(maximum).toBe(4);
    automatic = true; delayed.splice(0).forEach(release => release());
    await fixture.settle();
    expect(fixture.layer.resources().cells).toBe(16);
    fixture.layer.update({ ...defaultSettings, quality: 'low' }); await fixture.settle();
    expect(fixture.layer.resources().cells).toBe(9);
    fixture.layer.update({ ...defaultSettings, quality: 'high' }); await fixture.settle();
    expect(fixture.layer.resources().cells).toBe(25);
    expect(maximum).toBeLessThanOrEqual(4);
  });

  it('pins a live actor cell across a camera move rather than deleting it to load the new focus', async () => {
    const fixture = setup([mobilityFixture().chunk, remoteChunk(2)]);
    await fixture.layer.load('0123456789abcdef'); await fixture.settle();
    const world: MobilityWorld = Reflect.get(fixture.layer, 'world');
    world.setOptions({ seed: 7, vehicles: 1, pedestrians: 0, arrivals: true });
    world.step({ ...outsideGate, canRetire: () => false });
    const before = world.snapshot().actors[0];
    expect(before).toBeDefined();
    fixture.focus.lng += 0.0002;
    fixture.layer.update({ ...defaultSettings }); await fixture.settle();
    expect(fixture.layer.resources().cells).toBe(1);
    expect(world.snapshot().actors[0]).toEqual(before);
    expect(world.retainedCells().has(before.cell)).toBe(true);
  });
  it('releases off-window unreserved actors on a distant jump rather than pinning an abandoned window forever', async () => {
    const fixture = setup([mobilityFixture().chunk, remoteChunk(2)]);
    await fixture.layer.load('0123456789abcdef'); await fixture.settle();
    const world: MobilityWorld = Reflect.get(fixture.layer, 'world');
    world.step(outsideGate);
    expect(world.snapshot().actors.length).toBeGreaterThan(0);
    fixture.move(2); await fixture.settle();
    expect(world.snapshot().actors).toEqual([]);
    expect(fixture.layer.resources().cells).toBe(1);
  });
  it('suspends timers while the page is hidden and resumes without accumulated catch-up', async () => {
    const document = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('document', document);
    const fixture = setup();
    await fixture.layer.load('0123456789abcdef'); await fixture.settle();
    fixture.layer.update({ ...defaultSettings, mobilityPaused: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    fixture.layer.update({ ...defaultSettings });
    await vi.advanceTimersByTimeAsync(150);
    const before = fixture.layer.resources().time;
    expect(before).toBeGreaterThan(0);
    document.hidden = true; document.dispatchEvent(new globalThis.Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(fixture.layer.resources()).toMatchObject({ time: before, reason: 'page-hidden' });
    expect(vi.getTimerCount()).toBe(0);
    document.hidden = false; document.dispatchEvent(new globalThis.Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(50);
    expect(fixture.layer.resources().time).toBeCloseTo(before + 0.05);
  });

  it('uses nested idempotent export freezes without altering the saved user settings', async () => {
    const fixture = setup();
    await fixture.layer.load('0123456789abcdef'); await fixture.settle();
    const before = { ...defaultSettings }, first = fixture.layer.freeze(), second = fixture.layer.freeze();
    expect(fixture.layer.resources()).toMatchObject({ state: 'paused', reason: 'export' });
    first(); first();
    expect(fixture.layer.resources().reason).toBe('export');
    second();
    expect(fixture.layer.resources().state).toBe('ready');
    expect(defaultSettings).toEqual(before);
  });
  it('keeps manual pause independent of export leases and hides a disabled actor kind', async () => {
    const fixture = setup();
    await fixture.layer.load('0123456789abcdef'); await fixture.settle();
    const world: MobilityWorld = Reflect.get(fixture.layer, 'world');
    world.step(outsideGate); fixture.frame();
    await vi.waitFor(() => expect(fixture.layer.resources().models).toBe(2));
    fixture.layer.update({ ...defaultSettings, mobilityPaused: true, vehicles: false });
    const release = fixture.layer.freeze(); release();
    expect(fixture.layer.resources()).toMatchObject({ state: 'paused', reason: 'user', vehicles: 0, pedestrians: 1, models: 1 });
  });
  it('reports a safe density transition rather than removing visible actors on a quality downgrade', async () => {
    const chunk = mobilityFixture().chunk, edge = chunk.network.edges.find(edge => edge.id === 'w')!;
    edge.points = [[40, -100], [40, 100]]; edge.length = 200;
    edge.corridor = [[[[39, -100], [41, -100], [41, 100], [39, 100], [39, -100]]]];
    chunk.network.zones = []; chunk.zoneIds = {};
    chunk.network.edges.forEach(edge => { edge.conflicts = []; });
    const fixture = setup([chunk]);
    await fixture.layer.load('0123456789abcdef'); await fixture.settle();
    const world: MobilityWorld = Reflect.get(fixture.layer, 'world');
    world.setOptions({ seed: 7, vehicles: 0, pedestrians: 90, arrivals: true });
    for (let i = 0; i < 2400; i++) world.step({ ...outsideGate, canRetire: () => false });
    const count = world.snapshot().actors.length;
    expect(count).toBeGreaterThan(36);
    fixture.layer.update({ ...defaultSettings, quality: 'low', mobilityPaused: true });
    expect(fixture.layer.resources()).toMatchObject({ draining: true, pedestrians: count });
    expect(world.snapshot().actors.length).toBe(count);
  });

  it('destroys a late native model instead of re-registering it after the layer is destroyed', async () => {
    const fixture = setup();
    await fixture.layer.load('0123456789abcdef'); await fixture.settle();
    const native = Model.fromGltfAsync.bind(Model);
    let resolve!: (model: Model) => void;
    const pending = new Promise<Model>(done => { resolve = done; });
    const decode = vi.spyOn(Model, 'fromGltfAsync').mockReturnValueOnce(pending);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const world: MobilityWorld = Reflect.get(fixture.layer, 'world');
    world.setOptions({ seed: 7, vehicles: 1, pedestrians: 0, arrivals: true });
    world.step(outsideGate); fixture.frame();
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    fixture.layer.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    const model = await native(decode.mock.calls[0][0]); resolve(model);
    await vi.advanceTimersByTimeAsync(0);
    expect(model.isDestroyed()).toBe(true);
    expect(fixture.layer.resources()).toMatchObject({ models: 0, urls: 0, cells: 0, pending: 0 });
  });
  it('bounds unresolved native decoders across repeated roads toggles and keeps obsolete work accounted', async () => {
    const fixture = setup();
    await fixture.layer.load('0123456789abcdef'); await fixture.settle();
    const world: MobilityWorld = Reflect.get(fixture.layer, 'world');
    world.step(outsideGate);
    const native = Model.fromGltfAsync.bind(Model);
    const decoders: { resolve(model: Model): void; options: Parameters<typeof Model.fromGltfAsync>[0] }[] = [];
    vi.spyOn(Model, 'fromGltfAsync').mockImplementation(options =>
      new Promise(resolve => decoders.push({ resolve, options })));
    for (let i = 0; i < 8; i++) {
      fixture.layer.update({ ...defaultSettings }); fixture.frame();
      await new Promise<void>(done => setTimeout(done, 5));
      fixture.layer.update({ ...defaultSettings, roads: false });
    }
    expect(decoders.length).toBeGreaterThan(0);
    expect(decoders.length).toBeLessThanOrEqual(4);
    fixture.layer.destroy();
    expect(fixture.layer.resources().pending).toBe(decoders.length);
    for (const decoder of decoders) decoder.resolve(await native(decoder.options));
    await new Promise<void>(done => setTimeout(done, 0));
    expect(fixture.layer.resources().pending).toBe(0);
    expect(rendered.models.every(model => model.destroyed)).toBe(true);
  });

  it('invalidates a sibling chunk success arriving after the active window has failed', async () => {
    const fixture = setup(stitchChunks(Object.values(twoChunkFixture())));
    let late!: (response: Response) => void;
    const delayed = new Promise<Response>(resolve => { late = resolve; }), original = fixture.fetcher.getMockImplementation()!;
    fixture.fetcher.mockImplementation((url, init) => String(url).endsWith('cell-right.json') ? delayed
      : String(url).endsWith('cell-left.json') ? Promise.resolve(new Response('failed', { status: 503 })) : original(url, init));
    await fixture.layer.load('0123456789abcdef');
    await vi.waitFor(() => expect(fixture.layer.resources().state).toBe('error'));
    const before = rendered.primitives.length;
    late(await original(`/${fixture.manifest.cells.find(cell => cell.id === 'cell/right')!.resource!.uri}`));
    await new Promise<void>(done => setTimeout(done, 0));
    expect(rendered.primitives.length).toBe(before);
    expect(fixture.layer.resources().cells).toBe(0);
    expect(fixture.replacements.at(-1)?.size ?? 0).toBe(0);
  });

  it('restores static roads after a surface failure and does not re-enable failed replacements on later settings', async () => {
    const fixture = setup();
    await fixture.layer.load('0123456789abcdef'); await fixture.settle();
    rendered.primitives.find(primitive => !primitive.destroyed)!.broken = true;
    const collection: PrimitiveCollection = Reflect.get(fixture.layer, 'collection');
    expect(() => Reflect.apply(Reflect.get(collection, 'update'), collection, [undefined])).toThrow(/surface decode/);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(fixture.layer.resources().state).toBe('error');
    expect(fixture.replacements.at(-1)?.size).toBe(0);
    fixture.layer.update({ ...defaultSettings, night: !defaultSettings.night });
    expect(fixture.replacements.at(-1)?.size).toBe(0);
  });
});

describe('source-aligned road replacement', () => {
  it('gives reversed source segments the same identity without hiding neighbouring segments', () => {
    const a: [number, number] = [120.68, 31.32], b: [number, number] = [120.681, 31.32];
    expect(roadSegmentId('way/101', a, b)).toBe(roadSegmentId('way/101', b, a));
    expect(roadSegmentId('way/101', a, b)).not.toBe(roadSegmentId('way/102', a, b));
    const line: [number, number][] = [a, b, [120.682, 31.32], [120.683, 31.32]], original = structuredClone(line);
    const replaced = new Set([roadSegmentId('way/101', line[1], line[2])]);
    expect(unreplacedRoadParts('way/101', line, replaced)).toEqual([[line[0], line[1]], [line[2], line[3]]]);
    expect(line).toEqual(original);
  });

  it('splits only the replaced part of a source way and preserves the original city overview batch', () => {
    const fixture = setup(), viewer = Object.create(Viewer.prototype) as Viewer;
    Object.defineProperties(viewer, {
      scene: { value: fixture.viewer.scene }, camera: { value: fixture.viewer.camera }, canvas: { value: fixture.viewer.canvas },
    });
    const detail = new DetailLayer(viewer, message => fixture.errors.push(message));
    try {
      const line: [number, number][] = [[120.68, 31.32], [120.681, 31.32], [120.682, 31.32], [120.683, 31.32]];
      detail.setRoads({ type: 'FeatureCollection', features: [{
        type: 'Feature', id: 'way/101', properties: { layer: 'roads', kind: 'residential' },
        geometry: { type: 'LineString', coordinates: line },
      }] });
      detail.update({ ...defaultSettings });
      fixture.frame();
      const overview = rendered.primitives.find(primitive =>
        Array.isArray(primitive.options.geometryInstances)
        && primitive.options.geometryInstances.some(instance => instance.id === 'way/101:0'))!;
      expect(overview.options.geometryInstances).toHaveLength(1);
      detail.setReplacedRoads(new Set([roadSegmentId('way/101', line[1], line[2])]));
      expect(overview.getGeometryInstanceAttributes('way/101:0').show[0]).toBe(1);
      fixture.frame();
      expect(overview.getGeometryInstanceAttributes('way/101:0').show[0]).toBe(0);
      const replacement = rendered.primitives.find(primitive => primitive !== overview && !primitive.destroyed)!;
      expect(replacement.options.geometryInstances).toHaveLength(2);
      const instances = replacement.options.geometryInstances;
      expect(Array.isArray(instances)).toBe(true);
      if (!Array.isArray(instances)) throw new Error('Expected replacement geometry instances');
      const longitudes = instances.map(instance => {
        const positions = Reflect.get(instance.geometry, '_positions');
        if (!Array.isArray(positions)) throw new Error('Missing native line positions');
        return positions.map(position => Number(CesiumMath.toDegrees(Cartographic.fromCartesian(position).longitude).toFixed(3)));
      });
      expect(longitudes).toEqual([[120.68, 120.681], [120.682, 120.683]]);
      detail.setReplacedRoads(new Set());
      expect(overview.getGeometryInstanceAttributes('way/101:0').show[0]).toBe(1);
    } finally { detail.destroy(); }
  });
});
