import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { landmarks, landmarkModel } from '../../web/core/landmarks';
import type { BuildingFeature } from '../../web/core/types';
import type {} from '../fixtures/landmark-review';

const views: Record<string, {
  tile: string; far: number; middle: number; near: number; detail: number; heading: number; pitch: number;
  detailTarget?: [number, number];
}> = {
  'gate-to-the-east': { tile: '4826_1252', far: 2800, middle: 850, near: 470, detail: 190, heading: 80, pitch: -25 },
  'suzhou-center': { tile: '4826_1252', far: 2200, middle: 950, near: 540, detail: 200, heading: 100, pitch: -55,
    detailTarget: [120.673, 31.31958] },
  'suzhou-ifs': { tile: '4828_1252', far: 3200, middle: 1150, near: 700, detail: 190, heading: 30, pitch: -22 },
  'beisi-pagoda': { tile: '4824_1252', far: 750, middle: 240, near: 150, detail: 100, heading: 25, pitch: -35 },
  'tiger-hill-pagoda': { tile: '4823_1253', far: 600, middle: 190, near: 120, detail: 100, heading: 50, pitch: -45 },
  'ruiguang-pagoda': { tile: '4824_1251', far: 650, middle: 200, near: 130, detail: 100, heading: 25, pitch: -45 },
};

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
test.setTimeout(180_000);

for (const landmark of landmarks.filter(landmark => landmark.id in views)) {
  test(`${landmark.id} renders in the main page across distances, angles and day/night with truthful picking`, async ({ page }) => {
    const errors: string[] = [], view = views[landmark.id], directory = `artifacts/landmarks/${landmark.id}`;
    page.on('pageerror', error => errors.push(error.message));
    await mkdir(directory, { recursive: true });
    await page.goto('/');
    await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
    await page.addScriptTag({ type: 'module', url: '/tests/fixtures/landmark-review.ts' });
    await page.waitForFunction(() => Boolean(window.landmarkReview));
    await page.getByRole('button', { name: '日景', exact: true }).click();
    await page.getByRole('button', { name: '收起控制面板', exact: true }).click();
    const captures: {
      name: string; range: number; heading: number; target?: [number, number];
      state: ReturnType<Window['landmarkReview']['state']>; lods: string[];
    }[] = [];
    for (const [name, range, heading] of [
      ['far-day', view.far, view.heading], ['middle-day', view.middle, view.heading],
      ['reverse-day', view.middle, view.heading + 145], ['near-day', view.near, view.heading],
    ] as const) {
      expect(await page.evaluate(({ id, range, heading, pitch }) =>
        window.landmarkReview.view(id, range, heading, pitch),
      { id: landmark.id, range, heading, pitch: view.pitch })).toBeGreaterThan(0);
      await expect(async () => {
        const { state, lods } = await page.evaluate(id => ({
          state: window.landmarkReview.state(), lods: window.landmarkReview.lods(id),
        }), landmark.id);
        expect(state.failure).toBeUndefined();
        expect(state.loading).toBe(false);
        expect(state.visibleBuildings).toBeGreaterThan(0);
        expect(lods).toHaveLength(1);
        captures.push({ name, range, heading, state, lods });
      }).toPass({ timeout: 30_000 });
      await page.screenshot({ path: `${directory}/${name}.png` });
    }
    const point = await page.evaluate(id => window.landmarkReview.pickPoint(id), landmark.id);
    const source = JSON.parse(await readFile(`public/data/c8a953228b2ff6af/tiles/${view.tile}.json`, 'utf8')) as {
      features: BuildingFeature[];
    };
    const original = source.features.find(feature => feature.properties.id === landmark.sourceId)!.properties;
    expect(point.picked).toEqual({ ...original, model: landmarkModel(landmark) });
    await page.mouse.click(point.x, point.y);
    const card = page.locator('.selection-card');
    await expect(card.locator('h3')).toHaveText(landmark.name);
    await expect(card).toContainText(`${landmark.height} m`);
    await expect(card).toContainText('原始 OSM 高度');
    await expect(card).toContainText(`${original.height.toFixed(1)} m`);
    await expect(card).toContainText(landmark.approximation);
    for (const source of landmark.sources) await expect(card.getByRole('link', { name: source.label })).toHaveAttribute('href', source.url);
    await page.screenshot({ path: `${directory}/picked.png` });
    await page.getByRole('button', { name: '关闭建筑信息', exact: true }).click();
    await page.getByRole('button', { name: '展开控制面板', exact: true }).click();
    await page.getByRole('button', { name: '夜景', exact: true }).click();
    await expect(page.locator('#glow')).toHaveValue('0.8');
    await page.getByRole('button', { name: '收起控制面板', exact: true }).click();
    expect(await page.evaluate(() => window.landmarkReview.ready())).toBeGreaterThan(0);
    await page.screenshot({ path: `${directory}/near-night.png` });
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出截图', exact: true }).click();
    await (await download).saveAs(`${directory}/export-night.png`);
    expect(await page.evaluate(({ id, range, heading, pitch, target }) =>
      window.landmarkReview.view(id, range, heading, pitch, 0.65, target),
    { id: landmark.id, range: view.detail, heading: view.heading, pitch: view.pitch, target: view.detailTarget })).toBeGreaterThan(0);
    for (const mode of ['night', 'day'] as const) {
      if (mode === 'day') {
        await page.getByRole('button', { name: '展开控制面板', exact: true }).click();
        await page.getByRole('button', { name: '日景', exact: true }).click();
        await page.getByRole('button', { name: '收起控制面板', exact: true }).click();
        expect(await page.evaluate(() => window.landmarkReview.ready())).toBeGreaterThan(0);
      }
      await expect(async () => {
        const { state, lods } = await page.evaluate(id => ({
          state: window.landmarkReview.state(), lods: window.landmarkReview.lods(id),
        }), landmark.id);
        expect(state.failure).toBeUndefined();
        expect(state.loading).toBe(false);
        expect(state.visibleBuildings).toBeGreaterThan(0);
        expect(lods).toEqual(['near']);
        captures.push({ name: `detail-${mode}`, range: view.detail, heading: view.heading, target: view.detailTarget, state, lods });
      }).toPass({ timeout: 30_000 });
      await page.screenshot({ path: `${directory}/detail-${mode}.png` });
    }
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(errors).toEqual([]);
    await writeFile(`${directory}/evidence.json`, JSON.stringify({ landmark: landmark.id, original, picked: point.picked, captures }, null, 2));
  });
}
