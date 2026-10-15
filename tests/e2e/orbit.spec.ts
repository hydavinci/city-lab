import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 900, height: 600 } });

async function openCity(page: Page) {
  await page.goto('/tests/fixtures/clarity.html');
  await page.waitForFunction(() => Boolean(window.clarity));
  await page.evaluate(() => window.clarity.ready);
  await page.evaluate(() => window.clarity.near());
}

async function pose(page: Page) {
  return page.evaluate(() => {
    const camera = window.clarity.scene.viewer.camera;
    return {
      position: [camera.positionWC.x, camera.positionWC.y, camera.positionWC.z],
      pitch: camera.pitch * 180 / Math.PI,
      heading: camera.heading * 180 / Math.PI,
      height: camera.positionCartographic.height,
      inputs: window.clarity.scene.viewer.scene.screenSpaceCameraController.enableInputs,
    };
  });
}

async function drag(page: Page, from: [number, number], to: [number, number], button: 'left' | 'middle' = 'middle') {
  await page.mouse.move(...from);
  await page.mouse.down({ button });
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(from[0] + (to[0] - from[0]) * step / 12, from[1] + (to[1] - from[1]) * step / 12);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  await page.mouse.up({ button });
}

function distance(a: number[], b: number[]) {
  return Math.hypot(...a.map((n, index) => n - b[index]));
}

test('a horizontal view still orbits around the city instead of only changing look direction', async ({ page }) => {
  await openCity(page);
  await page.evaluate(() => {
    const viewer = window.clarity.scene.viewer;
    viewer.camera.setView({ orientation: { heading: viewer.camera.heading, pitch: 0, roll: 0 } });
    viewer.scene.requestRender();
  });
  const before = await pose(page);
  await drag(page, [450, 240], [630, 240]);
  const after = await pose(page);
  expect(distance(before.position, after.position)).toBeGreaterThan(10);
  expect(after.pitch).toBeLessThan(-2);
  await drag(page, [450, 350], [450, 180]);
  expect((await pose(page)).pitch).toBeLessThan(-40);
});

test('repeated horizon tilts remain above ground and can be reversed without resetting', async ({ page }) => {
  await openCity(page);
  for (let i = 0; i < 3; i++) await drag(page, [450, 170], [450, 540]);
  const horizontal = await pose(page);
  expect(horizontal.pitch).toBeLessThanOrEqual(-4.9);
  expect(horizontal.height).toBeGreaterThanOrEqual(99.9);
  await drag(page, [450, 180], [650, 180]);
  expect(distance(horizontal.position, (await pose(page)).position)).toBeGreaterThan(10);
  await drag(page, [450, 400], [450, 100]);
  const restored = await pose(page);
  expect(restored.pitch).toBeLessThan(-40);
  expect(restored.inputs).toBe(true);
  expect(await page.evaluate(() => window.clarity.errors)).toEqual([]);
});

test('releasing an orbit drag restores panning, zooming and preset navigation', async ({ page }) => {
  await openCity(page);
  await drag(page, [450, 300], [580, 310]);
  const beforePan = await pose(page);
  await drag(page, [450, 400], [550, 400], 'left');
  const afterPan = await pose(page);
  expect(distance(beforePan.position, afterPan.position)).toBeGreaterThan(10);
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => distance(afterPan.position, (await pose(page)).position)).toBeGreaterThan(10);
  await page.evaluate(() => window.clarity.scene.home(0));
  await expect.poll(async () => (await pose(page)).height).toBeGreaterThan(24000);
  expect((await pose(page)).inputs).toBe(true);
});

test('tilting from the full-city overhead view does not introduce a sideways heading jump', async ({ page }) => {
  await openCity(page);
  await page.evaluate(() => window.clarity.scene.home(0));
  const before = await pose(page);
  await drag(page, [450, 250], [450, 280]);
  const after = await pose(page);
  const headingChange = Math.abs(((after.heading - before.heading + 540) % 360) - 180);
  expect(headingChange).toBeLessThan(1);
  expect(after.pitch).toBeGreaterThan(-89);
});

test('modifier changes and focus loss cannot leave navigation locked', async ({ page }) => {
  await openCity(page);
  await page.mouse.move(450, 300);
  await page.mouse.down({ button: 'middle' });
  await page.keyboard.down('Control');
  await page.mouse.move(500, 310);
  await page.mouse.up({ button: 'middle' });
  await page.keyboard.up('Control');
  expect((await pose(page)).inputs).toBe(true);
  const before = await pose(page);
  await page.keyboard.down('Control');
  await drag(page, [450, 300], [560, 300], 'left');
  await page.keyboard.up('Control');
  expect(distance(before.position, (await pose(page)).position)).toBeGreaterThan(10);
  await page.mouse.down({ button: 'middle' });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect((await pose(page)).inputs).toBe(true);
  await page.mouse.up({ button: 'middle' });
});
