import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mobilityFixture, resource } from '../fixtures/citywide-mobility';

test.beforeEach(async ({ page }) => {
  const fixture = mobilityFixture(), text = readFileSync('public/enhancements/manifest.json', 'utf8');
  fixture.manifest.baseDataset = JSON.parse(text).baseDataset;
  fixture.manifest.assets = resource('enhancements/manifest.json', text);
  await page.route('**/mobility/manifest.json', route => route.fulfill({ json: fixture.manifest }));
  await page.route(`**/${fixture.manifest.cells[0].resource!.uri}`, route => route.fulfill({ json: fixture.chunk }));
  await page.goto('/tests/fixtures/mobility-models.html');
  await page.evaluate(() => window.activityModels.ready);
});

test('actual moving models keep their true scale, cardinal orientation and road contact', async ({ page }, info) => {
  const clock = await page.evaluate(() => window.activityModels.clock());
  for (const [heading, x, y] of [[0, 0, 1], [Math.PI / 2, 1, 0], [Math.PI, 0, -1], [Math.PI * 1.5, -1, 0]]) {
    await page.evaluate(h => window.activityModels.heading(h), heading);
    const car = await page.evaluate(() => window.activityModels.measure('car-a'));
    expect(car.scale).toBe(1); expect(car.minimumPixelSize).toBe(0);
    expect(car.direction[0]).toBeCloseTo(x, 3); expect(car.direction[1]).toBeCloseTo(y, 3);
    expect(car.min[2]).toBeGreaterThanOrEqual(0.299);
    expect(car.min[2]).toBeLessThan(0.31);
    expect(Math.max(car.size[0], car.size[1])).toBeCloseTo(4.4, 1);
  }
  await page.evaluate(() => window.activityModels.heading(0));
  const before = await page.evaluate(() => window.activityModels.snapshot());
  const a = await page.evaluate(() => window.activityModels.measure('person-a'));
  await page.evaluate(() => window.activityModels.advance(17));
  const after = await page.evaluate(() => window.activityModels.snapshot());
  const b = await page.evaluate(() => window.activityModels.measure('person-a'));
  expect(after.actors.find(actor => actor.kind === 'person-a')!.position)
    .not.toEqual(before.actors.find(actor => actor.kind === 'person-a')!.position);
  expect(b.leg).not.toEqual(a.leg);
  expect(b.min[2]).toBeGreaterThanOrEqual(0.299);
  expect(await page.evaluate(() => window.activityModels.clock())).toBe(clock);
  expect(await page.evaluate(() => window.activityModels.errors)).toEqual([]);
  await page.screenshot({ path: info.outputPath('actual-activity-models.png') });
});

test('stopped people have a stable neutral gait', async ({ page }) => {
  await page.evaluate(() => window.activityModels.advance(1000));
  const a = await page.evaluate(() => window.activityModels.measure('person-a'));
  await page.evaluate(() => window.activityModels.advance(20));
  const b = await page.evaluate(() => window.activityModels.measure('person-a'));
  expect(a.leg).toEqual(b.leg);
  expect((await page.evaluate(() => window.activityModels.snapshot())).actors.every(actor => actor.speed === 0)).toBe(true);
  expect(await page.evaluate(() => window.activityModels.errors)).toEqual([]);
});

test('the real render scheduler moves models across frames without advancing the solar clock', async ({ page }) => {
  const before = await page.evaluate(() => ({ positions: window.activityModels.modelPositions(),
    clock: window.activityModels.clock(), time: window.activityModels.resources().time }));
  await page.evaluate(() => window.activityModels.moving());
  await expect.poll(() => page.evaluate(() => window.activityModels.resources().time)).toBeGreaterThan(before.time + 0.3);
  const after = await page.evaluate(() => ({ positions: window.activityModels.modelPositions(), clock: window.activityModels.clock() }));
  expect(after.positions).not.toEqual(before.positions);
  expect(after.clock).toBe(before.clock);
  expect(await page.evaluate(() => window.activityModels.errors)).toEqual([]);
});
