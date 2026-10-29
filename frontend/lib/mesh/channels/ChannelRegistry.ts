// Which channels this phone is in, and which ones it has heard about nearby.
// Pure state; MeshService loads it from and saves it to the `channels` store.

import { fromHex } from "../bytes";
import type { ChannelRole, StoredChannel } from "../store";
import { decodeManifest, encodeManifest, isDiscoverable, manifestId, verifyManifest, type ChannelManifest } from "./manifest";

/** A channel counts as nearby if someone announced it this recently. */
export const NEARBY_TTL_MS = 5 * 60_000;

export interface JoinedChannel {
  id: string;
  manifest: ChannelManifest;
  manifestBytes: Uint8Array;
  role: ChannelRole;
  joinedAt: number;
  lastRead: number;
  muted: boolean;
}

export interface NearbyChannel {
  id: string;
  manifest: ChannelManifest;
  manifestBytes: Uint8Array;
  /** Fewest hops we've heard it from recently. */
  hops: number;
  lastHeard: number;
  /** Last time we saw a message in it (only visible for channels with plain tags). */
  lastActivity?: number;
}

export class ChannelRegistry {
  private joinedById = new Map<string, JoinedChannel>();
  private leftById = new Map<string, StoredChannel>();
  private heardById = new Map<string, NearbyChannel>();

  constructor(
    private readonly persist: (c: StoredChannel) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Restores saved channels. Rows with a bad manifest are ignored. */
  load(rows: StoredChannel[]): void {
    for (const row of rows) {
      const manifest = decodeManifest(row.manifest);
      const id = fromHex(row.channelId);
      if (!manifest || !id || !verifyManifest(manifest, id)) continue;
      if (row.left) {
        this.leftById.set(row.channelId, row);
        continue;
      }
      this.joinedById.set(row.channelId, {
        id: row.channelId,
        manifest,
        manifestBytes: row.manifest,
        role: row.role,
        joinedAt: row.joinedAt,
        lastRead: row.lastRead,
        muted: row.muted,
      });
    }
  }

  joined(): JoinedChannel[] {
    return [...this.joinedById.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  }

  get(id: string): JoinedChannel | undefined {
    return this.joinedById.get(id);
  }

  isJoined(id: string): boolean {
    return this.joinedById.has(id);
  }

  /** Channels heard recently that I'm not in, closest first. */
  nearby(): NearbyChannel[] {
    const cutoff = this.now() - NEARBY_TTL_MS;
    return [...this.heardById.values()]
      .filter((c) => c.lastHeard >= cutoff && !this.joinedById.has(c.id))
      .sort((a, b) => a.hops - b.hops || b.lastHeard - a.lastHeard || a.manifest.name.localeCompare(b.manifest.name));
  }

  /** Joined channels that should be announced (not Hidden). */
  announceable(): JoinedChannel[] {
    return this.joined().filter((c) => isDiscoverable(c.manifest.kind));
  }

  /** Records a verified manifest heard over the mesh. Returns true if the nearby list changed. */
  heard(manifest: ChannelManifest, hops: number): boolean {
    const id = manifestId(manifest);
    const t = this.now();
    const prev = this.heardById.get(id);
    const fresh = prev && prev.lastHeard >= t - NEARBY_TTL_MS;
    const bestHops = fresh ? Math.min(prev.hops, hops) : hops;
    // Keep the newest manifest the owner signed (it may have edited the description).
    const keep = prev && prev.manifest.createdAt > manifest.createdAt ? prev.manifest : manifest;
    this.heardById.set(id, {
      id,
      manifest: keep,
      manifestBytes: keep === manifest ? encodeManifest(manifest) : prev!.manifestBytes,
      hops: bestHops,
      lastHeard: t,
      lastActivity: prev?.lastActivity,
    });
    return !fresh || bestHops !== prev.hops;
  }

  /** Notes traffic in a channel (by plain tag) so Nearby can show "active 2 min ago". */
  activity(id: string, timestamp: number): void {
    const c = this.heardById.get(id);
    if (c && (c.lastActivity ?? 0) < timestamp) c.lastActivity = timestamp;
  }

  /** A manifest I've heard or used to be in, for joining by ID. */
  knownManifest(id: string): ChannelManifest | undefined {
    const heard = this.heardById.get(id);
    if (heard) return heard.manifest;
    const left = this.leftById.get(id);
    return (left && decodeManifest(left.manifest)) || undefined;
  }

  /** Adds a channel I created or joined. Returns the joined entry. */
  join(manifest: ChannelManifest, role: ChannelRole): JoinedChannel {
    const id = manifestId(manifest);
    const existing = this.joinedById.get(id);
    if (existing) return existing;
    const left = this.leftById.get(id);
    const entry: JoinedChannel = {
      id,
      manifest,
      manifestBytes: encodeManifest(manifest),
      role,
      joinedAt: this.now(),
      lastRead: left?.lastRead ?? 0,
      muted: left?.muted ?? false,
    };
    this.leftById.delete(id);
    this.joinedById.set(id, entry);
    this.save(entry);
    return entry;
  }

  leave(id: string): boolean {
    const c = this.joinedById.get(id);
    if (!c) return false;
    this.joinedById.delete(id);
    const row = { ...this.toRow(c), left: true };
    this.leftById.set(id, row);
    this.persist(row);
    // Show it under Nearby again right away, if it's still around.
    if (!this.heardById.has(id)) {
      this.heardById.set(id, { id, manifest: c.manifest, manifestBytes: c.manifestBytes, hops: 1, lastHeard: this.now() });
    }
    return true;
  }

  markRead(id: string, timestamp: number): boolean {
    const c = this.joinedById.get(id);
    if (!c || c.lastRead >= timestamp) return false;
    c.lastRead = timestamp;
    this.save(c);
    return true;
  }

  private save(c: JoinedChannel): void {
    this.persist(this.toRow(c));
  }

  private toRow(c: JoinedChannel): StoredChannel {
    return {
      channelId: c.id,
      manifest: c.manifestBytes,
      role: c.role,
      joinedAt: c.joinedAt,
      lastRead: c.lastRead,
      muted: c.muted,
    };
  }
}
