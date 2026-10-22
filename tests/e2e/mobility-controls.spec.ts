import { expect, test } from '@playwright/test';

test('saved v1 settings migrate and activity choices persist without claiming unavailable traffic', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('suzhou-city-lab.settings.v1')) localStorage.setItem('suzhou-city-lab.settings.v1',
      JSON.stringify({ version: 1, night: false, glow: 0, quality: 'low', buildings: true, roads: true,
        water: true, green: false, boundary: false, labels: true }));
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '日景', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('switch', { name: '模拟车辆', exact: true })).toBeChecked();
  await expect(page.getByRole('switch', { name: '模拟行人', exact: true })).toBeChecked();
  await expect(page.getByText('模拟活动，非实时交通', { exact: true })).toBeVisible();
  await page.getByRole('switch', { name: '模拟车辆', exact: true }).click();
  await page.getByRole('button', { name: '暂停模拟', exact: true }).click();
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('suzhou-city-lab.settings.v1')!)))
    .toMatchObject({ version: 2, vehicles: false, pedestrians: true, mobilityPaused: true, green: false, glow: 0 });
  await page.reload();
  await expect(page.getByRole('switch', { name: '模拟车辆', exact: true })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: '模拟行人', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '继续模拟', exact: true })).toBeVisible();
});
