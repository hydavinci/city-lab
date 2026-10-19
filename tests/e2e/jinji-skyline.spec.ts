import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { jinjiLandmarks, architectureSupplements } from '../../web/core/jinji-landmarks';
import { landmarkModel } from '../../web/core/landmarks';
import type { BuildingFeature } from '../../web/core/types';
import type {} from '../fixtures/landmark-review';

const groups: {
  name: string; focus: string; ids: string[]; tile?: string; target: [number, number];
  far: number; middle: number; near: number; heading: number; pitch: number;
}[] = [
  { name: 'west-shore', focus: 'global-188-a',
    ids: jinjiLandmarks.filter(record => ['global', 'fortune', 'phoenix', 'center'].includes(record.skyline ?? '')).map(record => record.id),
    tile: '4826_1252', target: [120.6688, 31.3186], far: 2700, middle: 900, near: 190, heading: 95, pitch: -28 },
  { name: 'hong-leong', focus: 'hong-leong-northeast',
    ids: jinjiLandmarks.filter(record => record.skyline === 'hong-leong').map(record => record.id),
    tile: '4828_1252', target: [120.7123, 31.31925], far: 1400, middle: 650, near: 170, heading: 30, pitch: -30 },
  { name: 'modern-media', focus: 'modern-media-south',
    ids: jinjiLandmarks.filter(record => record.skyline?.startsWith('media')).map(record => record.id),
    tile: '4829_1253', target: [120.7304, 31.3258], far: 1600, middle: 800, near: 180, heading: 60, pitch: -30 },
  { name: 'suzhou-eye', focus: 'suzhou-eye', ids: ['suzhou-eye'],
    target: [120.7082681, 31.316438], far: 1100, middle: 420, near: 190, heading: 40, pitch: -25 },
];

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
test.setTimeout(180_000);

for (const group of groups) test(`${group.name} has native skyline detail, truthful picking and day/night views`, async ({ page }) => {
  const errors: string[] = [], directory = `artifacts/jinji-skyline/${group.name}`;
  const definition = jinjiLandmarks.find(record => record.id === group.focus)!;
  await mkdir(directory, { recursive: true });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
  await page.addScriptTag({ type: 'module', url: '/tests/fixtures/landmark-review.ts' });
  await page.waitForFunction(() => Boolean(window.landmarkReview));
  await page.getByRole('button', { name: '日景', exact: true }).click();
  await page.getByRole('button', { name: '收起控制面板', exact: true }).click();
  const captures: {
    name: string; range: number; heading: number;
    state: ReturnType<Window['landmarkReview']['state']>; lods: Record<string, string[]>;
  }[] = [];
  for (const view of [
    { name: 'group-day', range: group.far, heading: group.heading, target: group.target, ids: group.ids },
    { name: 'group-reverse-day', range: group.far, heading: group.heading + 150, target: group.target, ids: group.ids },
    { name: 'middle-day', range: group.middle, heading: group.heading, target: undefined, ids: [group.focus] },
    { name: 'detail-day', range: group.near, heading: group.heading, target: undefined, ids: [group.focus] },
  ]) {
    expect(await page.evaluate(({ id, range, heading, pitch, target }) =>
      window.landmarkReview.view(id, range, heading, pitch, 0.55, target),
    { id: group.focus, range: view.range, heading: view.heading, pitch: group.pitch, target: view.target })).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.landmarkReview.state().loading)).toBe(false);
    const evidence = await page.evaluate(ids => ({
      state: window.landmarkReview.state(),
      lods: Object.fromEntries(ids.map(id => [id, window.landmarkReview.lods(id)])),
    }), view.ids);
    expect(evidence.state.failure).toBeUndefined();
    expect(evidence.state.loading).toBe(false);
    expect(evidence.state.visibleBuildings).toBeGreaterThan(0);
    for (const lods of Object.values(evidence.lods)) expect(lods).toHaveLength(1);
    if (view.name === 'detail-day') expect(evidence.lods[group.focus]).toEqual(['near']);
    captures.push({ name: view.name, range: view.range, heading: view.heading, ...evidence });
    await page.screenshot({ path: `${directory}/${view.name}.png` });
  }
  const point = await page.evaluate(id => window.landmarkReview.pickPoint(id), group.focus);
  const features: BuildingFeature[] = group.tile
    ? (JSON.parse(await readFile(`public/data/c8a953228b2ff6af/tiles/${group.tile}.json`, 'utf8')) as {
      features: BuildingFeature[];
    }).features : architectureSupplements('c8a953228b2ff6af').features;
  const original = features.find(feature => feature.properties.id === definition.sourceId)!.properties;
  expect(point.picked).toEqual({ ...original, model: landmarkModel(definition) });
  await page.mouse.click(point.x, point.y);
  const card = page.locator('.selection-card');
  await expect(card.locator('h3')).toHaveText(definition.name);
  await expect(card).toContainText(`${definition.height} m`);
  await expect(card).toContainText(definition.approximation);
  const originalHeight = card.locator('dl div').filter({ has: page.getByText('原始 OSM 高度', { exact: true }) });
  await expect(originalHeight).toContainText(original.basis === 'reference' ? '未标注' : `${original.height.toFixed(1)} m`);
  if (original.basis === 'reference') {
    await expect(card).toContainText('资料核实 · 补充景点');
    await expect(card).toContainText('2026-10-19');
  }
  for (const source of definition.sources) await expect(card.getByRole('link', { name: source.label })).toHaveAttribute('href', source.url);
  await page.screenshot({ path: `${directory}/picked.png` });
  await page.getByRole('button', { name: '关闭建筑信息', exact: true }).click();
  await page.getByRole('button', { name: '展开控制面板', exact: true }).click();
  await page.getByRole('button', { name: '夜景', exact: true }).click();
  await expect(page.locator('#glow')).toHaveValue('0.8');
  await page.getByRole('button', { name: '收起控制面板', exact: true }).click();
  expect(await page.evaluate(() => window.landmarkReview.ready())).toBeGreaterThan(0);
  expect(await page.evaluate(id => window.landmarkReview.lods(id), group.focus)).toEqual(['near']);
  await page.screenshot({ path: `${directory}/detail-night.png` });
  expect(await page.evaluate(({ id, range, heading, pitch, target }) =>
    window.landmarkReview.view(id, range, heading, pitch, 0.55, target),
  { id: group.focus, range: group.far, heading: group.heading, pitch: group.pitch, target: group.target })).toBeGreaterThan(0);
  await page.screenshot({ path: `${directory}/group-night.png` });
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
  await writeFile(`${directory}/evidence.json`, JSON.stringify({ group: group.name, original, picked: point.picked, captures }, null, 2));
});
