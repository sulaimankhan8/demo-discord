// Carrier cache (docs/10 C4): packets for channels I'm not in, kept for a while so I can hand
// them to a member I meet later. This carries messages across gaps where no member is around.
// Keyed by the tag on the wire (for private channels, the hourly tag), so I never need to know
// which channel a packet is for. Budget: 1 MB and 6 hours, oldest out first.

export interface CarrierEntry {
  id: string;
  /** Hex tag as it appears on the wire. */
  tag: string;
  raw: Uint8Array;
  receivedAt: number;
}

export interface CarrierPersistence {
  save(entry: CarrierEntry): void;
  delete(ids: string[]): void;
}

export const CARRIER_MAX_BYTES = 1024 * 1024;
export const CARRIER_MAX_AGE_MS = 6 * 60 * 60_000;

export class CarrierCache {
  /** Insertion order = oldest first. */
  private entries = new Map<string, CarrierEntry>();
  private byTag = new Map<string, Set<string>>();
  private totalBytes = 0;

  constructor(
    private readonly now: () => number,
    private readonly maxBytes = CARRIER_MAX_BYTES,
    private readonly maxAgeMs = CARRIER_MAX_AGE_MS,
    private readonly persist?: CarrierPersistence,
  ) {}

  get bytes(): number {
    return this.totalBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Restores saved entries (oldest first). */
  load(rows: CarrierEntry[]): void {
    for (const r of [...rows].sort((a, b) => a.receivedAt - b.receivedAt)) this.insert(r, false);
    this.prune();
  }

  add(id: string, tag: string, raw: Uint8Array): void {
    if (this.entries.has(id) || raw.length > this.maxBytes) return;
    this.insert({ id, tag, raw, receivedAt: this.now() }, true);
    this.prune();
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Entries with this wire tag, oldest first. */
  forTag(tag: string): CarrierEntry[] {
    this.prune();
    const ids = this.byTag.get(tag);
    if (!ids) return [];
    return [...ids].map((id) => this.entries.get(id)!).filter(Boolean);
  }

  all(): CarrierEntry[] {
    this.prune();
    return [...this.entries.values()];
  }

  delete(id: string): void {
    if (this.remove(id)) this.persist?.delete([id]);
  }

  private insert(e: CarrierEntry, save: boolean): void {
    this.entries.set(e.id, e);
    let set = this.byTag.get(e.tag);
    if (!set) this.byTag.set(e.tag, (set = new Set()));
    set.add(e.id);
    this.totalBytes += e.raw.length;
    if (save) this.persist?.save(e);
  }

  private remove(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    const set = this.byTag.get(e.tag);
    set?.delete(id);
    if (set && set.size === 0) this.byTag.delete(e.tag);
    this.totalBytes -= e.raw.length;
    return true;
  }

  /** Drops expired entries, then the oldest until under budget. */
  private prune(): void {
    const cutoff = this.now() - this.maxAgeMs;
    const dropped: string[] = [];
    for (const e of this.entries.values()) {
      if (e.receivedAt >= cutoff && this.totalBytes <= this.maxBytes) break;
      this.remove(e.id);
      dropped.push(e.id);
    }
    if (dropped.length) this.persist?.delete(dropped);
  }
}
