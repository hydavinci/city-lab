import { describe, expect, it } from 'vitest';
import { MobilityClock } from '../../web/core/mobility-clock';
import { MobilityWorld } from '../../web/core/mobility-world';
import { mobilityFixture, outsideGate } from '../fixtures/citywide-mobility';

describe('independent bounded activity clock', () => {
  it('limits a one-second stall to five fixed steps and discards the old backlog', () => {
    const clock = new MobilityClock();
    let time = 0;
    clock.advance(0, true, () => { time += 0.05; });
    expect(clock.advance(1000, true, () => { time += 0.05; })).toBe(5);
    expect(time).toBeCloseTo(0.25);
    expect(clock.advance(1010, true, () => { time += 0.05; })).toBe(0);
    expect(clock.advance(1050, true, () => { time += 0.05; })).toBe(1);
  });

  it('does no work while paused and resets the baseline on resume', () => {
    const clock = new MobilityClock();
    let steps = 0;
    const step = () => { steps++; };
    clock.advance(0, true, step); clock.advance(100, true, step);
    expect(steps).toBe(2);
    clock.advance(10000, false, step);
    clock.advance(20000, true, step);
    expect(steps).toBe(2);
    clock.advance(20050, true, step);
    expect(steps).toBe(3);
  });

  it('does not lose fractional elapsed time between ordinary frames', () => {
    const clock = new MobilityClock();
    let steps = 0;
    for (const time of [0, 17, 34, 51, 68, 85, 102]) clock.advance(time, true, () => steps++);
    expect(steps).toBe(2);
    expect(clock.alpha).toBeCloseTo(0.04);
    clock.reset();
    expect(clock.alpha).toBe(1);
  });

  it('advances simulation time while waiting for future arrivals without fast-forwarding actors', () => {
    const clock = new MobilityClock(), world = new MobilityWorld({ seed: 7, vehicles: 1, pedestrians: 0, arrivals: true });
    world.addChunk(mobilityFixture().chunk);
    const denied = { ...outsideGate, canSpawn: () => false };
    for (let time = 0; time <= 2000; time += 50) {
      expect(clock.advance(time, true, () => world.step(denied))).toBeLessThanOrEqual(1);
    }
    expect(world.snapshot().time).toBe(2);
    expect(world.snapshot().actors).toEqual([]);
    expect(world.nextWakeTime()).toBeGreaterThan(2);
    for (let time = 2050; time <= 4000; time += 50) clock.advance(time, true, () => world.step(outsideGate));
    expect(world.snapshot().actors).toHaveLength(1);
  });

  it('interpolates along certified segments instead of cutting a walking corner', () => {
    const world = new MobilityWorld({ seed: 7, vehicles: 0, pedestrians: 1, arrivals: true }), chunk = mobilityFixture().chunk;
    chunk.network.edges.find(edge => edge.id === 'w')!.points = [[40, -10], [40, 0], [50, 0]];
    world.addChunk(chunk);
    for (let i = 0; i < 400; i++) {
      world.step({ ...outsideGate, canRetire: () => false });
      const actor = world.interpolated(0.5).actors[0];
      if (!actor) continue;
      expect(actor.position[0] === 40 || actor.position[1] === 0).toBe(true);
    }
  });
});
