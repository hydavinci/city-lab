import { expect, test, type Page } from '@playwright/test';
import type { LabelCollection } from 'cesium';
import type {} from '../fixtures/landmark-review';

const districts = ['姑苏区', '虎丘区', '吴中区', '相城区', '吴江区', '苏州工业园区', '昆山市', '常熟市', '张家港市', '太仓市'];
const attractions = ['金鸡湖', '拙政园', '虎丘山', '同里古镇', '周庄古镇', '太湖'];

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
  await page.addScriptTag({ type: 'module', url: '/tests/fixtures/landmark-review.ts' });
  await page.waitForFunction(() => Boolean(window.landmarkReview));
}

async function labels(page: Page) {
  return page.evaluate(() => {
    const scene = window.landmarkReview.scene();
    const collection = Reflect.get(scene, 'labels') as LabelCollection;
    const camera = scene.viewer.camera.positionWC;
    return Array.from({ length: collection.length }, (_, i) => {
      const label = collection.get(i), position = label.position;
      const distance = Math.hypot(camera.x - position.x, camera.y - position.y, camera.z - position.z);
      const range = label.distanceDisplayCondition;
      return { name: label.text, displayed: collection.show && label.show && distance >= range.near && distance <= range.far };
    });
  });
}

test('roaming groups geographical destinations and flies to each selected place', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await open(page);
  await expect(page.getByRole('button', { name: '行政区域', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.place-card strong')).toHaveText(districts);
  for (const [group, names] of [['行政区域', districts], ['重点景点', attractions]] as const) {
    await page.getByRole('button', { name: group, exact: true }).click();
    await expect(page.locator('.place-card strong')).toHaveText(names);
    for (const name of names) {
      const button = page.getByRole('button', { name, exact: true });
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => page.evaluate(name => {
        const scene = window.landmarkReview.scene(), viewer = scene.viewer;
        if (Reflect.get(viewer.camera, '_currentFlight')) return false;
        const collection = Reflect.get(scene, 'labels') as LabelCollection;
        const label = Array.from({ length: collection.length }, (_, i) => collection.get(i)).find(label => label.text === name);
        if (!label) throw new Error(`Missing destination label: ${name}`);
        const screen = label.computeScreenSpacePosition(viewer.scene);
        return Math.hypot(screen.x - viewer.canvas.clientWidth / 2, screen.y - viewer.canvas.clientHeight / 2) < 35;
      }, name)).toBe(true);
    }
    await page.getByRole('button', { name: '苏州市全域', exact: true }).click();
    await expect(page.locator('.city-wide')).toHaveClass(/selected/);
    await expect(page.locator('.place-card[aria-pressed="true"]')).toHaveCount(0);
    await page.evaluate(() => window.landmarkReview.ready());
    await page.screenshot({ path: info.outputPath(`${group === '行政区域' ? 'districts' : 'attractions'}.png`) });
  }
  expect((await labels(page)).map(label => label.name).sort()).toEqual([...districts, ...attractions].sort());
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('map labels show regions at overview and tourist places nearby, respecting the layer switch', async ({ page }, info) => {
  await open(page);
  await page.evaluate(() => window.landmarkReview.ready());
  expect((await labels(page)).filter(label => label.displayed).map(label => label.name).sort()).toEqual([...districts].sort());
  await page.getByRole('button', { name: '重点景点', exact: true }).click();
  await page.getByRole('button', { name: '虎丘山', exact: true }).click();
  await expect.poll(async () => (await labels(page)).find(label => label.name === '虎丘山')?.displayed).toBe(true);
  await expect.poll(async () => (await labels(page)).find(label => label.name === '虎丘区')?.displayed).toBe(false);
  await page.evaluate(() => window.landmarkReview.ready());
  await page.screenshot({ path: info.outputPath('tiger-hill-label.png') });
  await page.getByRole('switch', { name: '地名标注' }).click();
  expect((await labels(page)).some(label => label.displayed)).toBe(false);
  await page.getByRole('switch', { name: '地名标注' }).click();
  expect((await labels(page)).find(label => label.name === '虎丘山')?.displayed).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
