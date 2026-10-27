// Mesh routing: flooding with a hop limit, dedup, signature checks, relay pacing and
// store-and-forward sync. Pure logic with no I/O, so it can be tested without devices.
// See docs/08_OFFLINE_BLE_MESH_IMPLEMENTATION_PLAN.md §7.

import { equalBytes, randomBytes, toHex } from "./bytes";
import { signPacket, verifyPacket } from "./crypto";
import { fingerprintOf, type MeshIdentity } from "./identity";
import {
  decodePacket,
  encodePacket,
  MAX_TTL,
  MESSAGE_ID_BYTES,
  PacketType,
  messageIdOf,
  PROTOCOL_VERSION,
  withTtl,
  type MeshPacket,
} from "./packet";
import {
  decodeAnnouncePayload,
  decodeMessagePayload,
  decodeSyncPayload,
  encodeAnnouncePayload,
  encodeMessagePayload,
  encodeSyncPayload,
  cleanNickname,
} from "./payloads";
import { SeenCache } from "./seenCache";

export interface HistoryEntry {
  id: string;
  /** The encoded MESSAGE packet, with the ttl it would be forwarded with. */
  raw: Uint8Array;
  timestamp: number;
}

export interface DeliveredMessage {
  id: string;
  senderKey: string;
  fingerprint: string;
  nickname: string;
  text: string;
  timestamp: number;
  receivedAt: number;
  /** 1 = straight from the sender's phone. */
  hops: number;
  mine: boolean;
  raw: Uint8Array;
}

export interface PeerSighting {
  senderKey: string;
  fingerprint: string;
  nickname: string;
  hops: number;
  linkId: string;
}

export interface RouterStats {
  received: number;
  relayed: number;
  duplicates: number;
  dropped: number;
}

export interface MeshRouterOptions {
  identity: MeshIdentity;
  nickname: string;
  links: () => string[];
  send: (linkId: string, packet: Uint8Array) => void;
  onMessage?: (message: DeliveredMessage) => void;
  onAnnounce?: (peer: PeerSighting) => void;
  onLeave?: (senderKey: string) => void;
  now?: () => number;
  random?: () => number;
  schedule?: (fn: () => void, delayMs: number) => void;
  /** Random delay before relaying, so nearby phones don't all transmit at once. */
  relayJitterMs?: [number, number];
  maxRelaysPerSecond?: number;
  historyLimit?: number;
  historyMaxAgeMs?: number;
  /** Messages older than this are ignored. */
  maxMessageAgeMs?: number;
}

const HOUR = 60 * 60_000;

export class MeshRouter {
  readonly stats: RouterStats = { received: 0, relayed: 0, duplicates: 0, dropped: 0 };

  private nickname: string;
  private readonly seen: SeenCache;
  private history: HistoryEntry[] = [];
  private fingerprints = new Map<string, string>();
  private tokens: number;
  private lastRefill: number;

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly schedule: (fn: () => void, delayMs: number) => void;
  private readonly jitter: [number, number];
  private readonly maxRelaysPerSecond: number;
  private readonly historyLimit: number;
  private readonly historyMaxAgeMs: number;
  private readonly maxMessageAgeMs: number;

  constructor(private readonly opts: MeshRouterOptions) {
    this.nickname = cleanNickname(opts.nickname);
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.jitter = opts.relayJitterMs ?? [10, 80];
    this.maxRelaysPerSecond = opts.maxRelaysPerSecond ?? 20;
    this.historyLimit = opts.historyLimit ?? 200;
    this.historyMaxAgeMs = opts.historyMaxAgeMs ?? 12 * HOUR;
    this.maxMessageAgeMs = opts.maxMessageAgeMs ?? 24 * HOUR;
    this.seen = new SeenCache(10_000, 15 * 60_000, this.now);
    this.tokens = this.maxRelaysPerSecond;
    this.lastRefill = this.now();
  }

  setNickname(nickname: string): void {
    this.nickname = cleanNickname(nickname);
  }

  /** Restores saved history (e.g. from IndexedDB) so it can be shared with phones that join later. */
  loadHistory(entries: HistoryEntry[]): void {
    for (const e of entries) {
      if (this.history.some((h) => h.id === e.id)) continue;
      this.history.push(e);
      this.seen.add(e.id);
    }
    this.history.sort((a, b) => a.timestamp - b.timestamp);
    this.pruneHistory();
  }

  getHistory(): readonly HistoryEntry[] {
    return this.history;
  }

  /* ---------------- sending ---------------- */

  sendMessage(text: string): DeliveredMessage {
    const payload = encodeMessagePayload({ nickname: this.nickname, text });
    const packet = this.build(PacketType.Message, MAX_TTL, payload);
    const raw = encodePacket(packet);
    const id = toHex(packet.messageId);
    this.seen.add(id);
    this.remember({ id, raw, timestamp: packet.timestamp });
    this.broadcast(raw);
    const msg: DeliveredMessage = {
      id,
      senderKey: toHex(packet.senderKey),
      fingerprint: this.opts.identity.fingerprint,
      nickname: this.nickname,
      text,
      timestamp: packet.timestamp,
      receivedAt: packet.timestamp,
      hops: 0,
      mine: true,
      raw,
    };
    this.opts.onMessage?.(msg);
    return msg;
  }

  announce(): void {
    this.originate(PacketType.Announce, MAX_TTL, encodeAnnouncePayload(this.nickname));
  }

  leave(): void {
    this.originate(PacketType.Leave, MAX_TTL, new Uint8Array(0));
  }

  /**
   * Call when a new direct link comes up: say hello and offer catch-up sync. Both stay on
   * that link, so a new link doesn't cause traffic across the whole mesh; the rest of the
   * mesh hears about us from the periodic announce().
   */
  linkUp(linkId: string): void {
    this.sendLinkLocal(linkId, PacketType.Announce, encodeAnnouncePayload(this.nickname));
    const ids = this.history.map((h) => messageIdOf(h.raw));
    this.sendLinkLocal(linkId, PacketType.Sync, encodeSyncPayload(ids));
  }

  private sendLinkLocal(linkId: string, type: PacketType, payload: Uint8Array): void {
    const packet = this.build(type, 1, payload, true);
    this.seen.add(toHex(packet.messageId));
    this.opts.send(linkId, encodePacket(packet));
  }

  private originate(type: PacketType, ttl: number, payload: Uint8Array): void {
    const packet = this.build(type, ttl, payload);
    this.seen.add(toHex(packet.messageId));
    this.broadcast(encodePacket(packet));
  }

  private build(type: PacketType, ttl: number, payload: Uint8Array, linkLocal = false): MeshPacket {
    return signPacket(
      {
        version: PROTOCOL_VERSION,
        type,
        ttl,
        linkLocal,
        timestamp: this.now(),
        messageId: randomBytes(MESSAGE_ID_BYTES),
        senderKey: this.opts.identity.publicKey,
        payload,
      },
      this.opts.identity.secretKey,
    );
  }

  private broadcast(raw: Uint8Array, exceptLink?: string): void {
    for (const link of this.opts.links()) if (link !== exceptLink) this.opts.send(link, raw);
  }

  /* ---------------- receiving ---------------- */

  handleIncoming(linkId: string, raw: Uint8Array): void {
    const packet = decodePacket(raw);
    if (!packet) {
      this.stats.dropped++;
      return;
    }

    const id = toHex(packet.messageId);
    if (!this.seen.checkAndAdd(id)) {
      this.stats.duplicates++;
      return;
    }
    if (equalBytes(packet.senderKey, this.opts.identity.publicKey)) return; // our own, echoed back
    if (!verifyPacket(packet)) {
      this.stats.dropped++;
      return;
    }

    this.stats.received++;
    const senderKey = toHex(packet.senderKey);
    const hops = packet.linkLocal ? 1 : MAX_TTL - packet.ttl + 1;
    if (packet.type === PacketType.Sync && !packet.linkLocal) {
      this.stats.dropped++;
      return;
    }

    switch (packet.type) {
      case PacketType.Message: {
        if (this.now() - packet.timestamp > this.maxMessageAgeMs) {
          this.stats.dropped++;
          return;
        }
        const body = decodeMessagePayload(packet.payload);
        if (!body) {
          this.stats.dropped++;
          return;
        }
        const forwarded = packet.ttl > 1 ? withTtl(raw, packet.ttl - 1) : raw;
        this.remember({ id, raw: forwarded, timestamp: packet.timestamp });
        this.opts.onMessage?.({
          id,
          senderKey,
          fingerprint: this.fingerprint(senderKey, packet.senderKey),
          nickname: body.nickname,
          text: body.text,
          timestamp: packet.timestamp,
          receivedAt: this.now(),
          hops,
          mine: false,
          raw: forwarded,
        });
        this.relay(raw, packet.ttl, linkId);
        return;
      }

      case PacketType.Announce: {
        const nickname = decodeAnnouncePayload(packet.payload);
        if (nickname === null) {
          this.stats.dropped++;
          return;
        }
        this.opts.onAnnounce?.({
          senderKey,
          fingerprint: this.fingerprint(senderKey, packet.senderKey),
          nickname,
          hops,
          linkId,
        });
        if (!packet.linkLocal) this.relay(raw, packet.ttl, linkId);
        return;
      }

      case PacketType.Leave:
        this.opts.onLeave?.(senderKey);
        this.relay(raw, packet.ttl, linkId);
        return;

      case PacketType.Sync: {
        // Link-local: answer with what the other phone is missing, never relay.
        const theirIds = decodeSyncPayload(packet.payload);
        if (!theirIds) {
          this.stats.dropped++;
          return;
        }
        const have = new Set(theirIds.map(toHex));
        let delay = 0;
        for (const entry of this.history) {
          if (have.has(entry.id)) continue;
          const bytes = entry.raw;
          this.schedule(() => this.opts.send(linkId, bytes), delay);
          delay += 5;
        }
        return;
      }
    }
  }

  private relay(raw: Uint8Array, ttl: number, fromLink: string): void {
    if (ttl <= 1) return;
    const targets = this.opts.links().filter((l) => l !== fromLink);
    if (targets.length === 0) return;
    if (!this.takeToken()) {
      this.stats.dropped++;
      return;
    }
    const out = withTtl(raw, ttl - 1);
    const [min, max] = this.jitter;
    const delay = min + this.random() * (max - min);
    this.stats.relayed++;
    this.schedule(() => {
      const live = new Set(this.opts.links());
      for (const link of targets) if (live.has(link)) this.opts.send(link, out);
    }, delay);
  }

  private takeToken(): boolean {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    this.lastRefill = t;
    this.tokens = Math.min(this.maxRelaysPerSecond, this.tokens + (elapsed * this.maxRelaysPerSecond) / 1000);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /* ---------------- history ---------------- */

  private remember(entry: HistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > 1 && entry.timestamp < this.history[this.history.length - 2].timestamp) {
      this.history.sort((a, b) => a.timestamp - b.timestamp);
    }
    this.pruneHistory();
  }

  private pruneHistory(): void {
    const cutoff = this.now() - this.historyMaxAgeMs;
    this.history = this.history.filter((h) => h.timestamp >= cutoff);
    if (this.history.length > this.historyLimit) this.history = this.history.slice(-this.historyLimit);
  }

  private fingerprint(hexKey: string, key: Uint8Array): string {
    let fp = this.fingerprints.get(hexKey);
    if (!fp) {
      fp = fingerprintOf(key);
      this.fingerprints.set(hexKey, fp);
    }
    return fp;
  }
}

