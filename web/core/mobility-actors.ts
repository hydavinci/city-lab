import type { ActorKind } from './enhancements';

export const ACTORS: Record<ActorKind, { length: number; width: number; radius: number }> = {
  'car-a': { length: 4.4, width: 1.8, radius: 5 },
  'car-b': { length: 4.7, width: 1.9, radius: 5.5 },
  bus: { length: 10, width: 2.5, radius: 10 },
  'person-a': { length: 1.12, width: 0.601, radius: 0 },
  'person-b': { length: 1.12, width: 0.601, radius: 0 },
};
