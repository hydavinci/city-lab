import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildingHeightRecords } from '../../web/core/building-height-references';
import { referenceHeightFor } from '../../web/core/building-heights';
import type { BuildingFeature, CityManifest } from '../../web/core/types';
import type {} from '../fixtures/landmark-review';

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
test.setTimeout(180_000);

for (const record of buildingHeightRecords) {
  test(`${record.sourceId} renders a generic high-rise with separate verified and original heights`, async ({ page }) => {
    const errors: string[] = [], directory = `artifacts/highrise/${record.sourceId.replace('/', '-')}`;
    page.on('pageerror', error => errors.push(error.message));
    await mkdir(directory, { recursive: true });
    const manifest = JSON.parse(await readFile('public/data/manifest.json', 'utf8')) as CityManifest;
    const tile = manifest.tiles.find(tile => tile.bounds[0] <= record.bounds[0] && tile.bounds[1] <= record.bounds[1]
      && tile.bounds[2] >= record.bounds[2] && tile.bounds[3] >= record.bounds[3])!;
    const collection = JSON.parse(await readFile(`public/data/${manifest.dataset}/tiles/${tile.id}.json`, 'utf8')) as {
      features: BuildingFeature[];
    };
    const feature = collection.features.find(feature => feature.properties.id === record.sourceId)!;
    expect(feature).toBeDefined();
    await page.goto('/');
    await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
    await page.addScriptTag({ type: 'module', url: '/tests/fixtures/landmark-review.ts' });
    await page.waitForFunction(() => Boolean(window.landmarkReview));
    await page.getByRole('button', { name: '日景', exact: true }).click();
    await page.getByRole('button', { name: '收起控制面板', exact: true }).click();
    const captures = [];
    for (const [name, factor] of [['skyline', 6], ['near', 1.8]] as const) {
      const range = record.height * factor;
      expect(await page.evaluate(({ id, range }) => window.landmarkReview.view(id, range, 30, -30),
        { id: record.sourceId, range })).toBeGreaterThan(0);
      const state = await page.evaluate(id => ({
        resources: window.landmarkReview.state(), lods: window.landmarkReview.lods(id),
      }), record.sourceId);
      expect(state.resources.failure).toBeUndefined();
      expect(state.resources.loading).toBe(false);
      expect(state.lods).toHaveLength(1);
      captures.push({ name, range, ...state });
      await page.screenshot({ path: `${directory}/${name}.png` });
    }
    const point = await page.evaluate(id => window.landmarkReview.pickPoint(id), record.sourceId);
    expect(point.picked).toEqual({ ...feature.properties, heightReference: referenceHeightFor(feature) });
    await page.mouse.click(point.x, point.y);
    const card = page.locator('.selection-card');
    await expect(card.locator('h3')).toHaveText(record.name);
    await expect(card).toContainText(`${record.height} m`);
    await expect(card).toContainText(`${record.floors} 层`);
    await expect(card).toContainText(record.checkedAt);
    await expect(card).toContainText('通用高度插件');
    await expect(card).toContainText('立面、塔冠与窗格并非实测还原');
    await expect(card).toContainText('原始 OSM 高度');
    await expect(card).toContainText(`${feature.properties.height.toFixed(1)} m`);
    await expect(card).toContainText('类型默认值 · 估算');
    for (const source of record.sources) {
      await expect(card.getByRole('link', { name: source.label })).toHaveAttribute('href', source.url);
    }
    await page.screenshot({ path: `${directory}/picked.png` });
    await page.getByRole('button', { name: '关闭建筑信息', exact: true }).click();
    await page.getByRole('button', { name: '展开控制面板', exact: true }).click();
    await page.getByRole('button', { name: '夜景', exact: true }).click();
    await page.getByRole('button', { name: '收起控制面板', exact: true }).click();
    expect(await page.evaluate(() => window.landmarkReview.ready())).toBeGreaterThan(0);
    await page.screenshot({ path: `${directory}/night.png` });
    expect(errors).toEqual([]);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await writeFile(`${directory}/evidence.json`, JSON.stringify({
      original: feature.properties, picked: point.picked, captures,
    }, null, 2));
  });
}
