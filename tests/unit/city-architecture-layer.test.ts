import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cartesian4, Cesium3DTileFeature, Cesium3DTileset, Event, Matrix4, PrimitiveCollection, RequestScheduler } from 'cesium';
import { CityArchitectureLayer } from '../../web/scene/CityArchitectureLayer';
import { defaultSettings } from '../../web/core/settings';
import { landmarks, landmarkModel } from '../../web/core/landmarks';
import { architectureSupplements, suzhouEye } from '../../web/core/jinji-landmarks';
import { readFileSync } from 'node:fs';
import { referenceHeightFor } from '../../web/core/building-heights';
import type { BuildingFeature } from '../../web/core/types';

const manifest = {
  version: 1, dataset: '0123456789abcdef', sourceDataset: 'source', generatedAt: '2026-10-17T00:00:00Z',
  tileset: '0123456789abcdef/tileset.json', buildings: 2, bounds: [120, 31, 121, 32],
  inference: 'Source-aligned inferred architecture',
  lods: Object.fromEntries(['far', 'mid', 'near'].map(lod => [lod,
    { buildings: 2, tiles: 1, triangles: 100, bytes: 1000, decodedBytes: 4000 }])),
};
const layers: CityArchitectureLayer[] = [];

function tileset() {
  const value = {
    show: true, tilesLoaded: false, totalMemoryUsageInBytes: 4000,
    tileLoad: new Event(), tileUnload: new Event(), tileVisible: new Event(), tileFailed: new Event(),
    loadProgress: new Event(), allTilesLoaded: new Event(),
    destroy: vi.fn(), isDestroyed: vi.fn(() => false),
  };
  return value as typeof value & Cesium3DTileset;
}

function fixture() {
  const scene = {
    primitives: new PrimitiveCollection(), preRender: new Event(), postRender: new Event(),
    requestRender: vi.fn(), drawingBufferWidth: 1440, drawingBufferHeight: 1000,
  };
  const camera = {
    changed: new Event(), viewMatrix: Matrix4.clone(Matrix4.IDENTITY),
    frustum: { projectionMatrix: Matrix4.clone(Matrix4.IDENTITY) },
  };
  const onError = vi.fn(), layer = new CityArchitectureLayer({ scene, camera }, onError);
  layers.push(layer);
  vi.stubGlobal('location', new URL('http://127.0.0.1:5173'));
  const native = tileset();
  const load = vi.spyOn(Cesium3DTileset, 'fromUrl').mockResolvedValue(native);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(manifest))));
  layer.update({ ...defaultSettings });
  const frame = () => { scene.preRender.raiseEvent(); scene.postRender.raiseEvent(); };
  return { layer, native, scene, camera, frame, onError, load };
}

afterEach(() => {
  layers.splice(0).forEach(layer => layer.destroy());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('native cached city architecture', () => {
  it('picks generic verified heights separately from original OSM fields and rejects altered provenance', async () => {
    const { layer, native, onError } = fixture();
    await layer.load('source', 2);
    const tile = JSON.parse(readFileSync('public/data/c8a953228b2ff6af/tiles/4828_1253.json', 'utf8')) as {
      features: BuildingFeature[];
    };
    const source = tile.features.find(feature => feature.properties.id === 'way/802754584')!;
    const reference = referenceHeightFor(source)!;
    const properties = { ...source.properties, heightReference: JSON.stringify(reference) };
    const feature = Object.create(Cesium3DTileFeature.prototype) as Cesium3DTileFeature;
    Object.defineProperties(feature, {
      tileset: { value: native }, getProperty: { value: (name: keyof typeof properties) => properties[name] },
    });
    expect(layer.selected(feature)).toEqual({ ...source.properties, heightReference: reference });
    properties.heightReference = JSON.stringify({ ...reference, height: 999 });
    expect(layer.selected(feature)).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(layer.error?.message).toMatch(/height metadata/i);
  });

  it('picks a supplemental attraction with reference provenance rather than an invented OSM height', async () => {
    const { layer, native, onError } = fixture();
    await layer.load('source', 2);
    const original = architectureSupplements('c8a953228b2ff6af').features[0].properties;
    const model = landmarkModel(suzhouEye);
    const properties = { ...original, model: JSON.stringify(model) };
    const feature = Object.create(Cesium3DTileFeature.prototype) as Cesium3DTileFeature;
    Object.defineProperties(feature, {
      tileset: { value: native }, getProperty: { value: (name: keyof typeof properties) => properties[name] },
    });
    expect(layer.selected(feature)).toEqual({ ...original, model });
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    { basis: 'height' }, { estimated: true }, { height: 120 }, { kind: 'yes' },
    { model: '' }, { id: 'way/unknown' },
  ])('rejects altered attraction source semantics: %j', async patch => {
    const { layer, native, onError } = fixture();
    await layer.load('source', 2);
    const properties: Record<string, unknown> = {
      ...architectureSupplements('c8a953228b2ff6af').features[0].properties,
      model: JSON.stringify(landmarkModel(suzhouEye)), ...patch,
    };
    const feature = Object.create(Cesium3DTileFeature.prototype) as Cesium3DTileFeature;
    Object.defineProperties(feature, {
      tileset: { value: native }, getProperty: { value: (name: string) => properties[name] },
    });
    expect(layer.selected(feature)).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(layer.error?.message).toMatch(/metadata/i);
  });

  it('returns trusted model provenance alongside original source fields and rejects altered model metadata', async () => {
    const { layer, native, onError } = fixture();
    await layer.load('source', 2);
    const model = landmarkModel(landmarks[0]);
    const properties = { id: landmarks[0].sourceId, name: '', kind: 'yes',
      height: 12.8, basis: 'fallback', estimated: true, model: JSON.stringify(model) };
    const feature = Object.create(Cesium3DTileFeature.prototype) as Cesium3DTileFeature;
    Object.defineProperties(feature, {
      tileset: { value: native }, getProperty: { value: (name: keyof typeof properties) => properties[name] },
    });
    expect(layer.selected(feature)).toEqual({ ...properties, model });
    properties.model = JSON.stringify({ ...model, sources: [{ label: 'bad', url: 'javascript:alert(1)' }] });
    expect(layer.selected(feature)).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(layer.error?.message).toMatch(/model metadata/i);
  });

  it.each(['view', 'projection', 'viewport'] as const)(
    'waits for a render after a %s change without a camera.changed event', async change => {
    const { layer, native, camera, scene, frame } = fixture();
    await layer.load('source', 2);
    native.tilesLoaded = true;
    frame();
    expect(layer.ready).toBe(true);
    if (change === 'view') Matrix4.setColumn(camera.viewMatrix, 3, new Cartesian4(0.001, 0, 0, 1), camera.viewMatrix);
    else if (change === 'projection') Matrix4.setColumn(camera.frustum.projectionMatrix, 0, new Cartesian4(1.001, 0, 0, 0), camera.frustum.projectionMatrix);
    else scene.drawingBufferWidth++;
    expect(layer.ready).toBe(false);
    frame();
    expect(layer.ready).toBe(true);
  });

  it('does not invalidate a rendered view when its architectural settings are unchanged', async () => {
    const { layer, native, scene, frame } = fixture();
    await layer.load('source', 2);
    native.tilesLoaded = true;
    frame();
    scene.requestRender.mockClear();
    layer.update({ ...defaultSettings });
    layer.update({ ...defaultSettings, labels: !defaultSettings.labels });
    expect(layer.ready).toBe(true);
    expect(scene.requestRender).not.toHaveBeenCalled();
    layer.update({ ...defaultSettings, night: !defaultSettings.night });
    expect(layer.ready).toBe(false);
    expect(scene.requestRender).toHaveBeenCalledOnce();
  });

  it('applies the latest settings to newly attached content even when they have not changed', async () => {
    const { layer, native, load } = fixture();
    let release!: (value: Cesium3DTileset) => void;
    load.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const pending = layer.load('source', 2);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    layer.update({ ...defaultSettings, buildings: false, night: false, quality: 'low', glow: 0.3 });
    release(native);
    await pending;
    expect(native.show).toBe(false);
    expect(native.maximumScreenSpaceError).toBe(32);
    expect(native.customShader?.uniforms.u_night.value).toBe(0);
    expect(native.customShader?.uniforms.u_glow.value).toBe(0.3);
  });

  it('leases a bounded local request queue and restores it only after the last city is destroyed', async () => {
    const key = '127.0.0.1:5173';
    const original = {
      maximum: RequestScheduler.maximumRequests, perServer: RequestScheduler.maximumRequestsPerServer,
      heap: Reflect.get(RequestScheduler, 'priorityHeapLength'),
      server: RequestScheduler.requestsByServer[key],
    };
    const first = fixture();
    await first.layer.load('source', 2);
    expect(RequestScheduler.maximumRequests).toBe(Math.max(original.maximum, 128));
    expect(RequestScheduler.maximumRequestsPerServer).toBe(original.perServer);
    expect(RequestScheduler.requestsByServer[key]).toBe(Math.max(original.server ?? original.perServer, 128));
    expect(Reflect.get(RequestScheduler, 'priorityHeapLength')).toBe(Math.max(original.heap, 128));
    const second = fixture();
    await second.layer.load('source', 2);
    first.layer.destroy();
    expect(RequestScheduler.requestsByServer[key]).toBe(128);
    second.layer.destroy();
    expect(RequestScheduler.maximumRequests).toBe(original.maximum);
    expect(RequestScheduler.requestsByServer[key]).toBe(original.server);
    expect(Reflect.get(RequestScheduler, 'priorityHeapLength')).toBe(original.heap);
  });

  it('restores a pre-existing server limit when native tileset creation fails', async () => {
    const key = '127.0.0.1:5173', previous = RequestScheduler.requestsByServer[key];
    RequestScheduler.requestsByServer[key] = 32;
    try {
      const { layer, load } = fixture();
      load.mockRejectedValue(new Error('Root HTTP 503'));
      await layer.load('source', 2);
      expect(layer.error?.message).toBe('Root HTTP 503');
      expect(RequestScheduler.requestsByServer[key]).toBe(32);
    } finally {
      if (previous === undefined) delete RequestScheduler.requestsByServer[key];
      else RequestScheduler.requestsByServer[key] = previous;
    }
  });

  it.each([
    ['low', 64, 16, 32], ['medium', 192, 32, 16], ['high', 384, 64, 8],
  ] as const)('reserves the complete far working set plus bounded %s refinement capacity', async (quality, cache, overflow, error) => {
    const { layer, native, load } = fixture();
    const far = { ...manifest.lods.far, decodedBytes: 692_399_524, bytes: 159_277_348 };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...manifest, lods: { ...manifest.lods, far } })));
    layer.update({ ...defaultSettings, quality });
    await layer.load('source', 2);
    const expected = {
      cacheBytes: far.decodedBytes + far.bytes + cache * 1024 * 1024,
      maximumCacheOverflowBytes: overflow * 1024 * 1024, maximumScreenSpaceError: error,
    };
    expect(load).toHaveBeenCalledWith(expect.any(String), expect.objectContaining(expected));
    expect(native).toMatchObject(expected);
    layer.update({ ...defaultSettings, quality: 'high' });
    layer.update({ ...defaultSettings, quality });
    expect(native).toMatchObject(expected);
    expect(layer.resources()).toMatchObject({ farWorkingSetBytes: far.decodedBytes + far.bytes });
    layer.destroy();
    expect(layer.resources()).toMatchObject({ farWorkingSetBytes: 0 });
  });

  it('loads one source-bound native tileset, waits for the rendered view and retains it across settings and camera changes', async () => {
    const { layer, native, scene, camera, frame, load } = fixture();
    await layer.load('source', 2);
    expect(load).toHaveBeenCalledWith('/architecture-city/0123456789abcdef/tileset.json',
      expect.objectContaining({ featureIdLabel: 'building', skipLevelOfDetail: false }));
    expect(layer.ready).toBe(false);
    native.tilesLoaded = true;
    frame();
    expect(layer.ready).toBe(true);
    camera.changed.raiseEvent();
    expect(layer.ready).toBe(false);
    frame();
    const bytes = native.cacheBytes;
    layer.update({ ...defaultSettings, night: true, glow: 0.8, quality: 'low' });
    expect(native.cacheBytes).toBeLessThan(bytes);
    expect(native.maximumCacheOverflowBytes).toBeGreaterThanOrEqual(0);
    const shader = native.customShader!;
    expect(shader.uniforms.u_night.value).toBe(1);
    expect(shader.uniforms.u_glow.value).toBe(0.8);
    layer.update({ ...defaultSettings, buildings: false });
    expect(native.show).toBe(false);
    expect(layer.ready).toBe(true);
    expect(layer.resources().visibleBuildings).toBe(0);
    layer.update({ ...defaultSettings });
    frame();
    expect(native.show).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(native.destroy).not.toHaveBeenCalled();
    layer.destroy();
    expect(native.destroy).toHaveBeenCalledOnce();
    expect(layer.resources()).toMatchObject({ tilesets: 0, bytes: 0, cachedTiles: 0, disposed: true });
    expect(scene.preRender.numberOfListeners + scene.postRender.numberOfListeners + camera.changed.numberOfListeners).toBe(0);
  });

  it.each([
    { ...manifest, sourceDataset: 'other' },
    { ...manifest, tileset: '../outside.json' },
    { ...manifest, buildings: 1 },
    { ...manifest, lods: { ...manifest.lods, near: { ...manifest.lods.near, buildings: 1 } } },
  ])('reports invalid/incomplete manifests without a legacy fallback', async value => {
    const { layer, onError, load } = fixture();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(value)));
    await layer.load('source', 2);
    expect(layer.error).toBeInstanceOf(Error);
    expect(layer.ready).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    layer.destroy();
  });

  it('reports failed content, retains available native tiles, and rebuilds only on explicit retry', async () => {
    const { layer, native, onError, load } = fixture();
    await layer.load('source', 2);
    native.tileLoad.raiseEvent({ content: { featuresLength: 2 } });
    expect(layer.progress).toBe(1);
    native.tileFailed.raiseEvent({ url: 'tile.glb', message: 'HTTP 503' });
    native.tileFailed.raiseEvent({ url: 'other.glb', message: 'HTTP 503' });
    expect(layer.error?.message).toContain('HTTP 503');
    expect(layer.ready).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    expect(native.destroy).not.toHaveBeenCalled();
    const replacement = tileset();
    load.mockResolvedValue(replacement);
    await layer.retry();
    expect(native.destroy).toHaveBeenCalledOnce();
    expect(layer.error).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
    await layer.retry();
    expect(load).toHaveBeenCalledTimes(2);
    layer.destroy();
  });

  it('attributes a later render failure even after a content error without repeating notifications', async () => {
    const { layer, native, scene, onError } = fixture();
    await layer.load('source', 2);
    native.tileFailed.raiseEvent({ url: 'tile.glb', message: 'HTTP 503' });
    const renderError = new Error('Architecture render failure');
    Reflect.set(native, 'update', () => { throw renderError; });
    expect(() => Reflect.apply(Reflect.get(scene.primitives, 'update'), scene.primitives, [{}])).toThrow(renderError);
    expect(layer.error).toBe(renderError);
    expect(onError).toHaveBeenCalledOnce();
    await layer.retry();
    expect(layer.error).toBeUndefined();
  });

  it('destroys late native results and does not attach listeners after disposal', async () => {
    const { layer, native, load } = fixture();
    let release!: (value: Cesium3DTileset) => void;
    load.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const pending = layer.load('source', 2);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    layer.destroy();
    release(native);
    await pending;
    expect(native.destroy).toHaveBeenCalledOnce();
    expect(native.tileLoad.numberOfListeners).toBe(0);
    expect(layer.resources()).toMatchObject({ tilesets: 0, disposed: true });
  });

  it('bounds tileset loading and discards a native result arriving after timeout', async () => {
    const { layer, native, load } = fixture();
    vi.useFakeTimers();
    let release!: (value: Cesium3DTileset) => void;
    load.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const pending = layer.load('source', 2);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15_001);
    await pending;
    expect(layer.error?.message).toMatch(/timed out/i);
    release(native);
    await Promise.resolve();
    expect(native.destroy).toHaveBeenCalledOnce();
    layer.destroy();
  });

  it('returns complete original properties only for native features belonging to this city', async () => {
    const { layer, native } = fixture();
    await layer.load('source', 2);
    const properties = { id: 'way/1', name: '庭院', kind: 'house', height: 12.8, basis: 'fallback', estimated: true };
    const feature = Object.create(Cesium3DTileFeature.prototype) as Cesium3DTileFeature;
    Object.defineProperties(feature, {
      tileset: { value: native }, getProperty: { value: (name: keyof typeof properties) => properties[name] },
    });
    expect(layer.selected(feature)).toEqual(properties);
    expect(layer.selected({ id: properties })).toBeUndefined();
    layer.destroy();
    expect(layer.selected(feature)).toBeUndefined();
  });
});
