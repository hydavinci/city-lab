import { afterEach, describe, expect, it, vi } from 'vitest';
import { CityScene } from '../../web/scene/CityScene';
import { DetailLayer } from '../../web/scene/DetailLayer';
import { defaultSettings } from '../../web/core/settings';

function fixture() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const scene = {
    surfaceAbort: new AbortController(), disposed: false, renderFailure: undefined,
    detail: { error: undefined }, cityArchitecture: { progress: 0, error: undefined as Error | undefined },
    surfacesReady: vi.fn(() => false), viewer: { scene: { requestRender: vi.fn() } },
  };
  const wait = () => Reflect.apply(Reflect.get(CityScene.prototype, 'waitForGeometry'), scene, [true]) as Promise<void>;
  return { scene, wait };
}

afterEach(() => vi.useRealTimers());

describe('scene geometry readiness', () => {
  it('consumes a scheduled camera update when an export updates tiles immediately', async () => {
    vi.useFakeTimers();
    const update = vi.fn(), nativeUpdate = vi.fn(), requestRender = vi.fn();
    const scene = {
      disposed: false, settings: {}, timer: undefined, report: vi.fn(),
      detail: { update }, cityArchitecture: { update: nativeUpdate },
      viewer: { camera: { positionCartographic: { height: 1000 } }, scene: { requestRender } },
      updateTiles() { Reflect.apply(Reflect.get(CityScene.prototype, 'updateTiles'), this, []); },
    };
    Reflect.apply(Reflect.get(CityScene.prototype, 'scheduleTiles'), scene, []);
    scene.updateTiles();
    expect(update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(nativeUpdate).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not redraw unchanged detail selections after a camera frame', () => {
    const requestRender = vi.fn();
    const detail = {
      settings: undefined, roadRegions: new Map(), tiles: new Map(), districtWanted: new Set(),
      updateDistrict: vi.fn(), syncOverview: vi.fn(),
      roadAppearance: { material: { uniforms: {} } },
      viewer: {
        camera: {
          computeViewRectangle: () => undefined, getPickRay: () => undefined,
          positionCartographic: { height: 1000, longitude: 0, latitude: 0 },
        },
        scene: { canvas: { clientWidth: 900, clientHeight: 600 }, requestRender },
      },
    };
    const update = (settings: typeof defaultSettings) => Reflect.apply(DetailLayer.prototype.update, detail, [settings]);
    update({ ...defaultSettings });
    expect(requestRender).toHaveBeenCalledOnce();
    requestRender.mockClear();
    update({ ...defaultSettings });
    update({ ...defaultSettings, labels: !defaultSettings.labels });
    expect(requestRender).not.toHaveBeenCalled();
    update({ ...defaultSettings, night: !defaultSettings.night });
    expect(requestRender).toHaveBeenCalledOnce();
    update({ ...defaultSettings });
    requestRender.mockClear();
    detail.updateDistrict.mockImplementation(() => { detail.districtWanted = new Set([1]); });
    update({ ...defaultSettings });
    expect(requestRender).toHaveBeenCalledOnce();
    requestRender.mockClear();
    update({ ...defaultSettings });
    expect(requestRender).not.toHaveBeenCalled();
    detail.updateDistrict.mockImplementation(() => { detail.districtWanted = new Set(); });
    update({ ...defaultSettings });
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it('rejects exports immediately when native building content fails', async () => {
    const { scene, wait } = fixture();
    scene.cityArchitecture.error = new Error('Architecture tile HTTP 503');
    await expect(wait()).rejects.toThrow('Architecture tile HTTP 503');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps waiting beyond one minute while architectural bodies finish', async () => {
    const { scene, wait } = fixture();
    let status = 'pending';
    const result = wait().then(() => { status = 'ready'; }, (error: Error) => { status = error.message; });
    await vi.advanceTimersByTimeAsync(40_000);
    scene.cityArchitecture.progress++;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(status).toBe('pending');
    scene.surfacesReady.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(status).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still rejects a stalled queue one minute after its last completed body', async () => {
    const { scene, wait } = fixture();
    const result = wait().then(() => 'ready', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(40_000);
    scene.cityArchitecture.progress++;
    await vi.advanceTimersByTimeAsync(60_200);
    expect(await result).toContain('几何资源准备超时');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds total waiting even if camera movement keeps completing new bodies', async () => {
    const { scene, wait } = fixture();
    let status = 'pending';
    const result = wait().then(() => { status = 'ready'; }, (error: Error) => { status = error.message; });
    for (let step = 0; step < 19; step++) {
      await vi.advanceTimersByTimeAsync(30_000);
      scene.cityArchitecture.progress++;
    }
    expect(status).toBe('pending');
    await vi.advanceTimersByTimeAsync(30_100);
    await result;
    expect(status).toContain('几何资源准备超时');
  });

  it('cancels outstanding waits when the scene is destroyed', async () => {
    const { scene, wait } = fixture();
    const result = wait().then(() => 'ready', (error: Error) => error.message);
    scene.disposed = true;
    scene.surfaceAbort.abort();
    expect(await result).toBe('场景已关闭。');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an export while other scene details are still preparing', async () => {
    const { scene, wait } = fixture();
    let closeDetails!: (error: Error) => void;
    const details = new Promise<void>((_resolve, reject) => { closeDetails = reject; });
    void details.catch(() => {});
    Object.assign(scene, {
      updateTiles: vi.fn(), waitForGeometry: wait,
      detail: { error: undefined, waitUntilReady: () => details },
    });
    const capture = Reflect.apply(CityScene.prototype.screenshot, scene, []) as Promise<Blob>;
    const result = capture.then(() => 'unexpected png', (error: Error) => error.message);
    scene.disposed = true;
    scene.surfaceAbort.abort();
    closeDetails(new Error('细节图层已关闭。'));
    expect(await result).toBe('场景已关闭。');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not touch scene resources when exporting after disposal', async () => {
    const updateTiles = vi.fn(() => { throw new Error('Destroyed resource accessed'); });
    const capture = Reflect.apply(CityScene.prototype.screenshot, { disposed: true, updateTiles }, []);
    await expect(capture).rejects.toThrow('场景已关闭。');
    expect(updateTiles).not.toHaveBeenCalled();
  });

  it('does not publish an encoded image after disposal', async () => {
    let encoded!: BlobCallback;
    const scene = {
      disposed: false, updateTiles: vi.fn(), waitForGeometry: vi.fn().mockResolvedValue(undefined),
      detail: { waitUntilReady: vi.fn().mockResolvedValue(undefined) },
      viewer: { render: vi.fn(), canvas: { toBlob: (callback: BlobCallback) => { encoded = callback; } } },
    };
    const capture = Reflect.apply(CityScene.prototype.screenshot, scene, []) as Promise<Blob>;
    const result = capture.then(() => 'unexpected png', (error: Error) => error.message);
    await vi.waitFor(() => expect(encoded).toBeTypeOf('function'));
    scene.disposed = true;
    encoded(new Blob(['png']));
    expect(await result).toBe('场景已关闭。');
  });
});
