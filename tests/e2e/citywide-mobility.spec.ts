import { expect, test, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mobilityFixture, resource } from '../fixtures/citywide-mobility';
import { stitchChunks } from '../../pipeline/mobility/stitch';

// Synthetic network injection verifies homepage wiring only. Real geographic acceptance is blocked.
test.beforeEach(async ({ page }) => {
  const { chunk, manifest } = mobilityFixture();
  const a = chunk.network.edges[0], b = chunk.network.edges[1], w = chunk.network.edges[2];
  a.points[0] = [-300, 0]; a.length = 340; a.conflicts[0].enter = 335; a.conflicts[0].exit = 340;
  a.corridor = [[[[-300, -2], [40, -2], [40, 2], [-300, 2], [-300, -2]]]];
  b.points[1] = [300, 0]; b.length = 260;
  b.corridor = [[[[40, -2], [300, -2], [300, 2], [40, 2], [40, -2]]]];
  w.points = [[40, -300], [40, 0], [40, 300]]; w.length = 600; w.conflicts[0].enter = 298; w.conflicts[0].exit = 302;
  w.corridor = [[[[39, -300], [41, -300], [41, 300], [39, 300], [39, -300]]]];
  chunk.ports = [];
  chunk.surfaces[0].points = a.points; chunk.surfaces[1].points = b.points; chunk.surfaces[2].points = w.points;
  const audited = stitchChunks([chunk])[0], text = readFileSync('public/enhancements/manifest.json', 'utf8');
  manifest.baseDataset = JSON.parse(text).baseDataset;
  manifest.assets = resource('enhancements/manifest.json', text);
  manifest.cells[0].resource = resource(manifest.cells[0].resource!.uri, JSON.stringify(audited));
  await page.route('**/mobility/manifest.json', route => route.fulfill({ json: manifest }));
  await page.route(`**/${manifest.cells[0].resource.uri}`, route => route.fulfill({ body: JSON.stringify(audited), contentType: 'application/json' }));
  await page.goto('/');
  await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
  await page.addScriptTag({ type: 'module', url: '/tests/fixtures/citywide-mobility-review.ts' });
  await page.waitForFunction(() => Boolean(window.cityActivityReview));
  await page.evaluate(() => window.cityActivityReview.focus());
});

test('homepage runs bounded traffic, pauses, toggles kinds and freezes screenshots without clearing architecture', async ({ page }) => {
  await expect.poll(() => page.evaluate(() => window.cityActivityReview.state().models)).toBeGreaterThan(1);
  const first = await page.evaluate(() => window.cityActivityReview.snapshot());
  await expect.poll(() => page.evaluate(() => window.cityActivityReview.state().time)).toBeGreaterThan(first.time + 0.2);
  const second = await page.evaluate(() => window.cityActivityReview.snapshot());
  expect(second.actors.find(actor => actor.id === first.actors[0].id)?.position).not.toEqual(first.actors[0].position);
  await expect.poll(() => page.evaluate(() => window.cityActivityReview.architecture().visibleBuildings)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '暂停模拟', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.cityActivityReview.state().reason)).toBe('user');
  const paused = await page.evaluate(() => window.cityActivityReview.snapshot());
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 160)));
  expect(await page.evaluate(() => window.cityActivityReview.snapshot())).toEqual(paused);
  expect(await page.evaluate(() => window.cityActivityReview.capture())).toBeGreaterThan(1000);
  await expect(page.evaluate(() => window.cityActivityReview.failedCapture())).rejects.toThrow(/截图生成失败/);
  expect((await page.evaluate(() => window.cityActivityReview.state())).reason).toBe('user');
  await page.getByRole('button', { name: '继续模拟', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.cityActivityReview.state().time)).toBeGreaterThan(paused.time);
  const clock = await page.evaluate(() => window.cityActivityReview.clock());
  expect(await page.evaluate(() => window.cityActivityReview.capture())).toBeGreaterThan(1000);
  expect(await page.evaluate(() => window.cityActivityReview.state().reason)).not.toBe('export');
  expect(await page.evaluate(() => window.cityActivityReview.clock())).toBe(clock);
  await page.getByRole('switch', { name: '模拟车辆', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.cityActivityReview.state().vehicles)).toBe(0);
  expect((await page.evaluate(() => window.cityActivityReview.state())).pedestrians).toBeGreaterThan(0);
  await page.getByRole('switch', { name: '道路网络', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.cityActivityReview.state().reason)).toBe('roads-hidden');
  const time = await page.evaluate(() => window.cityActivityReview.state().time);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 160)));
  expect(await page.evaluate(() => window.cityActivityReview.state().time)).toBe(time);
});

test('activity failure has its own retry path and leaves the existing architecture loaded', async ({ page }) => {
  await expect.poll(() => page.evaluate(() => window.cityActivityReview.architecture().visibleBuildings)).toBeGreaterThan(0);
  const fail = (route: Route) => route.fulfill({ status: 503, body: 'unavailable' });
  await page.route('**/mobility/manifest.json', fail);
  const before = await page.evaluate(() => window.cityActivityReview.architecture().tilesets);
  await page.evaluate(() => window.landmarkReview.scene().retryMobility());
  await expect(page.getByTestId('mobility-error')).toContainText('503');
  expect(await page.evaluate(() => window.cityActivityReview.architecture().tilesets)).toBe(before);
  await page.unroute('**/mobility/manifest.json', fail);
  await page.getByRole('button', { name: '重试模拟活动', exact: true }).click();
  await expect(page.getByTestId('mobility-error')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.cityActivityReview.state().models)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.cityActivityReview.architecture().tilesets)).toBe(before);
});

test('a distant camera jump drops the offscreen activity window and returning admits new identities', async ({ page }) => {
  await expect.poll(() => page.evaluate(() => window.cityActivityReview.state().models)).toBeGreaterThan(0);
  const old = await page.evaluate(() => Math.max(...window.cityActivityReview.snapshot().actors.map(actor => actor.id)));
  await page.evaluate(() => window.cityActivityReview.focus(120.72, 31.32));
  await expect.poll(() => page.evaluate(() => window.cityActivityReview.state().cells)).toBe(0);
  expect((await page.evaluate(() => window.cityActivityReview.state())).models).toBe(0);
  await page.evaluate(() => window.cityActivityReview.focus());
  await expect.poll(() => page.evaluate(() => window.cityActivityReview.state().models)).toBeGreaterThan(0);
  expect(await page.evaluate(() => Math.min(...window.cityActivityReview.snapshot().actors.map(actor => actor.id)))).toBeGreaterThan(old);
});
