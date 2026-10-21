interface Request {
  actor: number; zones: string[]; latest: number; eligibleSince?: number;
}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Conflict reservation: ${message}`);
}

export class ConflictReservations {
  private requests = new Map<number, Request>();
  private occupied = new Map<string, number>();
  private held = new Map<number, string[]>();

  request(actor: number, zones: readonly string[], time: number): void {
    check(Number.isSafeInteger(actor) && actor > 0, 'Invalid actor identity');
    check(Number.isFinite(time) && time >= 0, 'Invalid request time');
    check(zones.length && zones.every(zone => typeof zone === 'string' && zone.length && !/\s/.test(zone)), 'Invalid zones');
    const keys = [...new Set(zones)].sort(), same = (other: readonly string[]) =>
      keys.length === other.length && keys.every((zone, index) => zone === other[index]);
    const held = this.held.get(actor);
    if (held) { check(same(held), 'Release held occupied zones before changing route'); return; }
    const previous = this.requests.get(actor);
    if (previous) {
      check(time >= previous.latest, 'Request time moved backwards');
      if (same(previous.zones)) { previous.latest = time; return; }
    }
    this.requests.set(actor, { actor, zones: keys, latest: time });
  }

  grant(available: (actor: number) => boolean): readonly number[] {
    const queue = [...this.requests.values()].sort((a, b) =>
      (a.eligibleSince ?? a.latest) - (b.eligibleSince ?? b.latest) || a.actor - b.actor);
    const granted: number[] = [], blocked = new Set<string>();
    for (const request of queue) {
      if (!available(request.actor)) continue;
      request.eligibleSince ??= request.latest;
      if (request.zones.some(zone => this.occupied.has(zone) || blocked.has(zone))) {
        request.zones.forEach(zone => blocked.add(zone));
        continue;
      }
      request.zones.forEach(zone => this.occupied.set(zone, request.actor));
      this.held.set(request.actor, request.zones); this.requests.delete(request.actor); granted.push(request.actor);
    }
    return granted;
  }

  release(actor: number): void {
    for (const zone of this.held.get(actor) ?? []) this.occupied.delete(zone);
    this.held.delete(actor); this.requests.delete(actor);
  }

  owners(): Readonly<Record<string, number>> { return Object.fromEntries(this.occupied); }
  clear(): void { this.requests.clear(); this.occupied.clear(); this.held.clear(); }
}
