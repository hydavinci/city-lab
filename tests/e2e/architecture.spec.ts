import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Cesium3DTileset } from 'cesium';

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
test.setTimeout(120_000);

async function open(page: Page) {
  await page.goto('/tests/fixtures/mobility.html');
  await page.waitForFunction(() => Boolean(window.mobility));
  await page.evaluate(() => window.mobility.ready);
}

async function move(page: Page, longitude: number, range: number) {
  await page.evaluate(({ longitude, range }) => {
    const { scene, geometry: { Cartesian3, HeadingPitchRange, Matrix4 } } = window.mobility;
    scene.viewer.camera.lookAt(Cartesian3.fromDegrees(longitude, 31.31660),
      new HeadingPitchRange(15 * Math.PI / 180, -42 * Math.PI / 180, range));
    scene.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    scene.viewer.scene.requestRender();
  }, { longitude, range });
}

test('former sample and its neighbours share one complete architectural tileset at every view distance', async ({ page }, info) => {
  await open(page);
  for (const [name, longitude, range] of [
    ['former-sample', 120.628075, 235], ['boundary-west', 120.6275, 235],
    ['boundary-east', 120.6287, 235], ['aerial', 120.628075, 1400], ['distant', 120.628075, 15000],
  ] as const) {
    await move(page, longitude, range);
    for (const night of [false, true]) {
      const result = await page.evaluate(async night => {
        const { scene, architecture, settings } = window.mobility;
        scene.updateSettings({ ...settings(), night });
        const blob = await scene.screenshot();
        return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), state: architecture.resources(),
          sample: Reflect.has(scene, 'architecture'), legacy: Reflect.has(scene, 'tiles') };
      }, night);
      expect(result.sample).toBe(false);
      expect(result.legacy).toBe(false);
      expect(result.state).toMatchObject({ tilesets: 1, loading: false });
      expect(result.state.visibleBuildings).toBeGreaterThan(0);
      expect(result.state.failure).toBeUndefined();
      if (range < 300) expect(result.state.near).toBeGreaterThan(0);
      await mkdir('artifacts/unified-city', { recursive: true });
      const path = `artifacts/unified-city/${name}-${night ? 'night' : 'day'}.png`;
      await writeFile(path, Buffer.from(result.bytes));
      await info.attach(`${name}-${night ? 'night' : 'day'}`, { path, contentType: 'image/png' });
    }
  }
  expect(await page.evaluate(() => window.mobility.errors)).toEqual([]);
});

test('night emission and water settings change the rendered image without rebuilding architecture', async ({ page }, info) => {
  await open(page);
  await move(page, 120.628075, 150);
  const measurements = new Map<string, number>();
  for (const [label, night, glow, water] of [
    ['day', false, 0.8, true], ['night-lit', true, 0.8, true],
    ['night-unlit', true, 0, true], ['night-no-water', true, 0, false],
  ] as const) {
    const result = await page.evaluate(async ({ night, glow, water }) => {
      const { scene, architecture, settings } = window.mobility;
      const native = Reflect.get(architecture, 'tileset') as Cesium3DTileset;
      scene.updateSettings({ ...settings(), night, glow, water });
      const blob = await scene.screenshot();
      const image = await createImageBitmap(blob), canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      image.close();
      const pixels = context.getImageData(canvas.width / 4, canvas.height / 4, canvas.width / 2, canvas.height / 2).data;
      let warm = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const [r, g, b] = pixels.subarray(i, i + 3);
        if (r > 100 && g > 45 && r > g * 1.15 && g > b * 1.4) warm++;
      }
      return {
        bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), warm,
        same: native === Reflect.get(architecture, 'tileset'),
        night: native.customShader!.uniforms.u_night.value, glow: native.customShader!.uniforms.u_glow.value,
        water: Reflect.get(scene, 'layers').water.show,
      };
    }, { night, glow, water });
    expect(result).toMatchObject({ same: true, night: Number(night), glow, water });
    measurements.set(label, result.warm);
    const path = info.outputPath(`${label}.png`);
    await writeFile(path, Buffer.from(result.bytes));
    await info.attach(label, { path, contentType: 'image/png' });
  }
  expect(measurements.get('night-lit')! - measurements.get('night-unlit')!).toBeGreaterThan(500);
  expect(await page.evaluate(() => window.mobility.errors)).toEqual([]);
});
