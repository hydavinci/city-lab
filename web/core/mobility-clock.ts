import { MOBILITY_STEP } from './mobility-world';

export class MobilityClock {
  private baseline?: number;
  private remainder = 0;
  private stepped = false;
  get alpha(): number { return this.stepped ? this.remainder / MOBILITY_STEP : 1; }
  reset(): void { this.baseline = undefined; this.remainder = 0; this.stepped = false; }
  advance(now: number, running: boolean, step: () => void): number {
    if (!Number.isFinite(now)) throw new Error('Invalid activity clock time');
    if (!running) { this.reset(); return 0; }
    if (this.baseline === undefined) { this.baseline = now; return 0; }
    if (now < this.baseline) throw new Error('Activity clock moved backwards');
    this.remainder = Math.min(5 * MOBILITY_STEP, this.remainder + (now - this.baseline) / 1000);
    this.baseline = now;
    let count = 0;
    while (this.remainder + 1e-10 >= MOBILITY_STEP && count < 5) {
      step(); this.remainder = Math.max(0, this.remainder - MOBILITY_STEP); count++; this.stepped = true;
    }
    return count;
  }
}
