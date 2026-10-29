// Remembers recently seen message IDs so each packet is handled and relayed only once.

export class SeenCache {
  private entries = new Map<string, number>(); // id -> expiry time, oldest first

  constructor(
    private readonly maxEntries = 10_000,
    private readonly ttlMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  has(id: string): boolean {
    const expiry = this.entries.get(id);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      this.entries.delete(id);
      return false;
    }
    return true;
  }

  add(id: string): void {
    this.entries.delete(id);
    this.entries.set(id, this.now() + this.ttlMs);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  /** Returns true if the id is new (and records it), false if it was already seen. */
  checkAndAdd(id: string): boolean {
    if (this.has(id)) return false;
    this.add(id);
    return true;
  }

  get size(): number {
    return this.entries.size;
  }
}
