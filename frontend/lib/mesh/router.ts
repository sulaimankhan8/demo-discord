// Mesh routing: flooding with a hop limit, dedup, signature checks, relay pacing and
// store-and-forward sync. Pure logic with no I/O, so it can be tested without devices.
// See docs/08_OFFLINE_BLE_MESH_IMPLEMENTATION_PLAN.md §7 and doc 10 §2 (protocol v2).
//
// Channels: every phone relays every packet. A channel is a tag on packets; a phone only
// delivers and keeps history for the Lobby and the channels it has joined.

import { BloomFilter } from "./bloom";
import { CarrierCache, type CarrierEntry } from "./carrier";
import { equalBytes, fromHex, randomBytes, toHex } from "./bytes";
import { decodeManifest, isDiscoverable, manifestId, verifyManifest, type ChannelManifest } from "./channels/manifest";
import { signPacket, verifyPacket } from "./crypto";
import { decryptMessage, encryptMessage } from "./crypto/channelCrypto";
import { fingerprintOf, type MeshIdentity } from "./identity";
import {
  CHANNEL_TAG_BYTES,
  decodePacket,
  encodePacket,
  LOBBY_TAG,
  MAX_PAYLOAD_BYTES,
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
  type MessagePayload,
  encodeAnnouncePayload,
  encodeMessagePayload,
  encodeSyncPayload,
  cleanNickname,
  LOBBY_WANT_TAG,
  MAX_SYNC_WANTS,
} from "./payloads";
import { SeenCache } from "./seenCache";

export interface HistoryEntry {
  id: string;
  /** The encoded MESSAGE packet, with the ttl it would be forwarded with. */
  raw: Uint8Array;
  timestamp: number;
  /** Hex channel tag; LOBBY_TAG for the Lobby. */
  channelTag: string;
}

export interface DeliveredMessage {
  id: string;
  senderKey: string;
  fingerprint: string;
  nickname: string;
  text: string;
  /** The sender's per-identity message counter. */
  senderSeq: number;
  /** Hex channel tag; LOBBY_TAG for the Lobby. */
  channelTag: string;
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

export interface ChannelSighting {
  id: string;
  manifest: ChannelManifest;
  hops: number;
  /** False for the link-local list a neighbour sends when a link comes up. */
  flooded: boolean;
}

export interface RouterStats {
  received: number;
  relayed: number;
  duplicates: number;
  dropped: number;
  /** Sends to neighbours skipped because they had clearly got the packet already. */
  suppressed?: number;
}

export interface ChannelLimits {
  maxMessages: number;
  maxAgeMs: number;
  /** Hop limit messages in this channel start with (default 7). */
  ttl?: number;
}

/** A tag to ask for in SYNC, and the channel (history bucket) it belongs to, if any. */
export interface SyncWant {
  tag: Uint8Array;
  bucket?: string;
}

/** Relay priority: lower goes first when the relay budget is tight (docs/10 C4). */
export const RelayPriority = {
  Control: 0,
  Mine: 1,
  Direct: 2,
  Carrier: 3,
  Announce: 4,
} as const;
type RelayPriority = (typeof RelayPriority)[keyof typeof RelayPriority];

/** A locked-channel message kept (and shared in SYNC) while I wait for its key. */
export interface LockedMessage {
  id: string;
  raw: Uint8Array;
  channelTag: string;
  timestamp: number;
  receivedAt: number;
  hops: number;
}

export interface AnnounceableChannel {
  id: string;
  manifestBytes: Uint8Array;
}

export interface MeshRouterOptions {
  identity: MeshIdentity;
  nickname: string;
  links: () => string[];
  send: (linkId: string, packet: Uint8Array) => void;
  onMessage?: (message: DeliveredMessage) => void;
  onAnnounce?: (peer: PeerSighting) => void;
  onLeave?: (senderKey: string) => void;
  onChannelAnnounce?: (channel: ChannelSighting) => void;
  /** A message passed through in a channel with a plain tag (joined or not). */
  onChannelTraffic?: (channelTag: string, timestamp: number) => void;
  /**
   * Limits for a channel tag I deliver, or null if I'm not in it (then I only relay).
   * Defaults to: the Lobby with historyLimit / historyMaxAgeMs, nothing else.
   */
  channelLimits?: (channelTag: string) => ChannelLimits | null;
  /**
   * Keys for a joined channel's messages: undefined if the channel isn't encrypted (Public).
   * `send` is null while I don't have the current key; `all` are tried when reading.
   */
  channelKeys?: (channelTag: string) => { send: Uint8Array | null; all: Uint8Array[] } | undefined;
  onLockedMessage?: (message: LockedMessage) => void;
  /**
   * A MEMBERS / EPOCH_CHANGE / KEY_GRANT packet (signature already checked). Return true if it
   * belongs to a channel I'm in; otherwise it's only passed on. `raw` has the forwarding ttl.
   */
  onControl?: (channelTag: string, packet: MeshPacket, raw: Uint8Array) => boolean;
  /** Stored control packets for a channel tag, sent before messages in SYNC replies. */
  controlFor?: (channelTag: string) => Uint8Array[];
  /**
   * Maps a tag from the wire to the channel it belongs to (its history bucket). Private channels
   * use hourly tags (docs/10 §2.4), so this needs the packet's timestamp. Unknown tags return
   * undefined and stay as they are. Plain tags map to themselves.
   */
  resolveTag?: (wireTag: string, timestamp: number) => string | undefined;
  /** A DM or ACK addressed to me (signature already checked). Not relayed further. */
  onDirect?: (packet: MeshPacket) => void;
  /** The same DM to me arrived again (the sender is re-sending it): confirm delivery again. */
  onDirectDuplicate?: (packet: MeshPacket) => void;
  /** JOIN_REQUEST (signature already checked). */
  onJoinRequest?: (packet: MeshPacket) => void;
  /** LEAVE with a channel ID: the sender left that channel. */
  onChannelLeave?: (senderKey: string, channelId: string) => void;
  /** What to ask for in SYNC on every new link, besides the Lobby (my channels, and hourly tags). */
  joinedTags?: () => SyncWant[];
  /** Joined channels to announce to a new neighbour straight away. */
  announceableChannels?: () => AnnounceableChannel[];
  /** Returns the next senderSeq for a message in a channel (bucket). Defaults to in-memory counters. */
  nextSeq?: (channelTag: string) => number;
  /** Keeps carrier entries across restarts. */
  carrierPersistence?: { save(e: CarrierEntry): void; delete(ids: string[]): void };
  carrierMaxBytes?: number;
  carrierMaxAgeMs?: number;
  /**
   * While a relay waits out its jitter, note which neighbours send me the same packet: they
   * have it, so skip them, and skip the relay entirely if they all do. Default on.
   */
  suppressDuplicates?: boolean;
  /** Relay again when a duplicate arrives with more hops left than the copy I relayed. Default on. */
  relayFresherCopies?: boolean;
  now?: () => number;
  random?: () => number;
  schedule?: (fn: () => void, delayMs: number) => void;
  /** Random delay before relaying, so nearby phones don't all transmit at once. */
  relayJitterMs?: [number, number];
  maxRelaysPerSecond?: number;
  /** Lobby history size (when channelLimits isn't given). */
  historyLimit?: number;
  historyMaxAgeMs?: number;
  /** Messages in channels I'm not in are relayed only if newer than this. */
  maxMessageAgeMs?: number;
}

const HOUR = 60 * 60_000;
/** Don't flood a channel announce if someone else flooded the same channel this recently. */
export const CHANNEL_ANNOUNCE_SUPPRESS_MS = 45_000;
/** Most packets sent back for one SYNC. The rest come on the next link or SYNC. */
const MAX_SYNC_REPLIES = 500;
const SYNC_REPLY_SPACING_MS = 5;
/** 2 KB holds ~1,700 IDs at 1 % false positives; more history just raises that rate a little. */
const MAX_SYNC_BLOOM_BYTES = 2048;
const MAX_RELAY_QUEUE = 500;
const MAX_RELAYED_TTL = 5000;

export class MeshRouter {
  readonly stats: RouterStats = { received: 0, relayed: 0, duplicates: 0, dropped: 0 };
  /** Channel announces this router started (for tests and the status bar). */
  channelAnnouncesSent = 0;

  private nickname: string;
  private readonly seen: SeenCache;
  /**
   * Messages I relayed without keeping (channels I wasn't in). If I join that channel and one
   * comes back in a SYNC reply, it gets one more look instead of being dropped as a duplicate.
   */
  private readonly passedOn: SeenCache;
  /**
   * The last few messages I passed on without reading, so they can be read after all if I get
   * the key later (e.g. a private channel's hourly tags only become recognisable then).
   */
  readonly carrier: CarrierCache;
  /** Relays waiting out their jitter: who already has the packet, and the best ttl seen. */
  private pendingRelays = new Map<
    string,
    { have: Set<string>; ttl: number; raw: Uint8Array; priority: RelayPriority }
  >();
  /** Highest ttl I've relayed each packet with, to relay again if a "fresher" copy turns up. */
  private relayedTtl = new Map<string, { ttl: number; priority: RelayPriority }>();
  private relayQueue: { priority: number; seq: number; out: Uint8Array; targets: string[] }[] = [];
  private queueSeq = 0;
  private pumpScheduled = false;
  private seqs = new Map<string, number>();
  private history = new Map<string, HistoryEntry[]>();
  private fingerprints = new Map<string, string>();
  private lastChannelAnnounce = new Map<string, number>();
  private tokens: number;
  private lastRefill: number;
  private lastPumpAt = -1;
  private lowPower = false;

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly schedule: (fn: () => void, delayMs: number) => void;
  private readonly jitter: [number, number];
  private readonly maxRelaysPerSecond: number;
  private readonly lobbyLimits: ChannelLimits;
  private readonly maxMessageAgeMs: number;

  constructor(private readonly opts: MeshRouterOptions) {
    this.nickname = cleanNickname(opts.nickname);
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.jitter = opts.relayJitterMs ?? [10, 80];
    this.maxRelaysPerSecond = opts.maxRelaysPerSecond ?? 20;
    this.lobbyLimits = { maxMessages: opts.historyLimit ?? 200, maxAgeMs: opts.historyMaxAgeMs ?? 12 * HOUR };
    this.maxMessageAgeMs = opts.maxMessageAgeMs ?? 24 * HOUR;
    this.seen = new SeenCache(10_000, 15 * 60_000, this.now);
    this.passedOn = new SeenCache(5_000, 15 * 60_000, this.now);
    this.tokens = this.maxRelaysPerSecond;
    this.lastRefill = this.now();
    this.carrier = new CarrierCache(
      this.now,
      opts.carrierMaxBytes,
      opts.carrierMaxAgeMs,
      opts.carrierPersistence,
    );
  }

  /**
   * Low battery (docs/10 C7): stop carrying and relaying other people's channels and DMs. My own
   * channels, control packets and announces still go through.
   */
  setLowPower(on: boolean): void {
    this.lowPower = on;
  }

  setNickname(nickname: string): void {
    this.nickname = cleanNickname(nickname);
  }

  /** Restores saved history (e.g. from IndexedDB) so it can be shared with phones that join later. */
  loadHistory(entries: HistoryEntry[]): void {
    const touched = new Set<string>();
    for (const e of entries) {
      const list = this.listFor(e.channelTag);
      if (list.some((h) => h.id === e.id)) continue;
      list.push(e);
      this.seen.add(e.id);
      touched.add(e.channelTag);
    }
    for (const tag of touched) {
      this.listFor(tag).sort((a, b) => a.timestamp - b.timestamp);
      this.pruneHistory(tag);
    }
  }

  /** History for one channel, or for every channel when no tag is given. */
  getHistory(channelTag?: string): readonly HistoryEntry[] {
    if (channelTag !== undefined) return this.history.get(channelTag) ?? [];
    return [...this.history.values()].flat().sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Forgets a channel's history (after leaving it). */
  dropChannel(channelTag: string): void {
    this.history.delete(channelTag);
  }

  /* ---------------- sending ---------------- */

  /**
   * Sends a message to the Lobby, or to a channel when `channelTag` (16 bytes, the channel's
   * history bucket) is given. `wireTagFor` gives the tag to put on the packet when it differs
   * (private channels' hourly tags), from the packet's timestamp.
   */
  sendMessage(
    text: string,
    channelTag?: Uint8Array,
    wireTagFor?: (timestamp: number) => Uint8Array,
    ttl: number = MAX_TTL,
  ): DeliveredMessage {
    const tagHex = channelTag ? toHex(channelTag) : LOBBY_TAG;
    const keys = channelTag ? this.opts.channelKeys?.(tagHex) : undefined;
    if (keys && !keys.send) throw new Error("no key for this channel yet");
    const key = keys?.send ?? undefined;
    const senderSeq = this.opts.nextSeq
      ? this.opts.nextSeq(tagHex)
      : (this.seqs.set(tagHex, (this.seqs.get(tagHex) ?? 0) + 1), this.seqs.get(tagHex)!);
    let payload = encodeMessagePayload({ senderSeq, nickname: this.nickname, text });
    const messageId = randomBytes(MESSAGE_ID_BYTES);
    const timestamp = this.now();
    const wireTag = channelTag && wireTagFor ? wireTagFor(timestamp) : channelTag;
    if (key) {
      const header = { channelTag: wireTag!, messageId, senderKey: this.opts.identity.publicKey, timestamp };
      payload = encryptMessage(key, header, payload);
    }
    const packet = this.build(PacketType.Message, Math.min(MAX_TTL, Math.max(1, ttl)), payload, {
      channelTag: wireTag,
      messageId,
      timestamp,
      encrypted: !!key,
    });
    const raw = encodePacket(packet);
    const id = toHex(packet.messageId);
    this.seen.add(id);
    this.remember({ id, raw, timestamp: packet.timestamp, channelTag: tagHex });
    this.broadcast(raw);
    const msg: DeliveredMessage = {
      id,
      senderKey: toHex(packet.senderKey),
      fingerprint: this.opts.identity.fingerprint,
      nickname: this.nickname,
      text,
      senderSeq,
      channelTag: tagHex,
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
   * Floods a channel announce, unless someone else flooded one for the same channel in the
   * last 45 s (so a busy channel sends about one a minute, not one per member).
   * Returns true if it was sent.
   */
  announceChannel(channel: AnnounceableChannel, force = false): boolean {
    const last = this.lastChannelAnnounce.get(channel.id);
    if (!force && last !== undefined && this.now() - last < CHANNEL_ANNOUNCE_SUPPRESS_MS) return false;
    this.lastChannelAnnounce.set(channel.id, this.now());
    this.originate(PacketType.ChannelAnnounce, MAX_TTL, channel.manifestBytes);
    this.channelAnnouncesSent++;
    return true;
  }

  /**
   * Floods a request to join a private or hidden channel. Tagged with the channel ID so it can
   * also cross the internet bridge. Returns the bytes, to re-send on new links.
   */
  sendJoinRequest(payload: Uint8Array, channelTag?: Uint8Array): Uint8Array {
    const packet = this.build(PacketType.JoinRequest, MAX_TTL, payload, { channelTag });
    this.seen.add(toHex(packet.messageId));
    const raw = encodePacket(packet);
    this.broadcast(raw);
    return raw;
  }

  /** Tells the mesh I left a channel, so an admin can take me off the member list. */
  leaveChannel(channelId: Uint8Array): void {
    this.originate(PacketType.Leave, MAX_TTL, channelId);
  }

  /** Sends stored bytes (e.g. an outbox packet) to one link as they are. */
  resend(linkId: string, raw: Uint8Array): void {
    this.opts.send(linkId, raw);
  }

  /** Floods a control packet for a channel. Returns its ID and bytes (to store and share in SYNC). */
  sendControl(
    type: PacketType,
    payload: Uint8Array,
    channelTag: Uint8Array,
    recipientId?: Uint8Array,
  ): { id: string; raw: Uint8Array } {
    const packet = signPacket(
      {
        version: PROTOCOL_VERSION,
        type,
        ttl: MAX_TTL,
        timestamp: this.now(),
        messageId: randomBytes(MESSAGE_ID_BYTES),
        senderKey: this.opts.identity.publicKey,
        channelTag,
        recipientId,
        payload,
      },
      this.opts.identity.secretKey,
    );
    const raw = encodePacket(packet);
    const id = toHex(packet.messageId);
    this.seen.add(id);
    this.broadcast(raw);
    return { id, raw };
  }

  /**
   * Call when a new direct link comes up: say hello, list my channels and offer catch-up sync.
   * All of it stays on that link, so a new link doesn't cause traffic across the whole mesh.
   */
  linkUp(linkId: string): void {
    this.sendLinkLocal(linkId, PacketType.Announce, encodeAnnouncePayload(this.nickname));
    for (const c of this.opts.announceableChannels?.() ?? []) {
      this.sendLinkLocal(linkId, PacketType.ChannelAnnounce, c.manifestBytes);
    }
    this.requestSync([{ tag: LOBBY_WANT_TAG, bucket: LOBBY_TAG }, ...(this.opts.joinedTags?.() ?? [])], [linkId]);
  }

  /**
   * Asks neighbours for stored messages with these tags that I don't have yet. Used on every new
   * link, and when I join a channel. Goes to every link unless `links` is given.
   */
  requestSync(wanted: (Uint8Array | SyncWant)[], links = this.opts.links()): void {
    const all = wanted.map((w) => (w instanceof Uint8Array ? { tag: w } : w));
    for (let i = 0; i < all.length; i += MAX_SYNC_WANTS) {
      const chunk = all.slice(i, i + MAX_SYNC_WANTS);
      const wants = chunk.map((w) => w.tag);
      // Everything I already have for these tags, so nobody sends it again.
      const ids = new Map<string, Uint8Array>();
      const add = (raw: Uint8Array) => {
        const mid = messageIdOf(raw);
        ids.set(toHex(mid), mid);
      };
      const buckets = new Set<string>();
      for (const w of chunk) {
        const hex = toHex(w.tag);
        buckets.add(w.bucket ?? (isLobbyWant(w.tag) ? LOBBY_TAG : hex));
        for (const e of this.carrier.forTag(hex)) add(e.raw);
      }
      for (const bucket of buckets) {
        for (const raw of this.opts.controlFor?.(bucket) ?? []) add(raw);
        for (const h of this.history.get(bucket) ?? []) add(h.raw);
      }
      const headerRoom = 1 + wants.length * CHANNEL_TAG_BYTES + 5;
      const maxBloomBytes = Math.min(MAX_SYNC_BLOOM_BYTES, MAX_PAYLOAD_BYTES - headerRoom);
      const bloom = BloomFilter.forCount(ids.size, (this.random() * 2 ** 32) >>> 0, maxBloomBytes);
      for (const id of ids.values()) bloom.add(id);
      const payload = encodeSyncPayload({ wants, bloom });
      for (const link of links) this.sendLinkLocal(link, PacketType.Sync, payload);
    }
  }

  private sendLinkLocal(linkId: string, type: PacketType, payload: Uint8Array): void {
    const packet = this.build(type, 1, payload, { linkLocal: true });
    this.seen.add(toHex(packet.messageId));
    this.opts.send(linkId, encodePacket(packet));
  }

  private originate(type: PacketType, ttl: number, payload: Uint8Array): void {
    const packet = this.build(type, ttl, payload);
    this.seen.add(toHex(packet.messageId));
    this.broadcast(encodePacket(packet));
  }

  private build(
    type: PacketType,
    ttl: number,
    payload: Uint8Array,
    extra: {
      linkLocal?: boolean;
      channelTag?: Uint8Array;
      encrypted?: boolean;
      messageId?: Uint8Array;
      timestamp?: number;
    } = {},
  ): MeshPacket {
    return signPacket(
      {
        version: PROTOCOL_VERSION,
        type,
        ttl,
        linkLocal: extra.linkLocal ?? false,
        channelTag: extra.channelTag,
        encrypted: extra.encrypted ?? false,
        timestamp: extra.timestamp ?? this.now(),
        messageId: extra.messageId ?? randomBytes(MESSAGE_ID_BYTES),
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
    const secondLook = this.seen.has(id) && this.isNowKept(id, packet);
    if (!secondLook && !this.seen.checkAndAdd(id)) {
      this.stats.duplicates++;
      this.onDuplicate(id, linkId, packet, raw);
      return;
    }
    if (equalBytes(packet.senderKey, this.opts.identity.publicKey)) return; // our own, echoed back
    if (!verifyPacket(packet)) {
      this.stats.dropped++;
      return;
    }
    if (secondLook) {
      // Already relayed once; now just read and keep it.
      this.passedOn.delete(id);
      if (isControl(packet.type)) return void this.handleControl(linkId, raw, packet, id, false);
      return this.handleMessage(linkId, raw, packet, id, toHex(packet.senderKey), MAX_TTL - packet.ttl + 1, false);
    }

    this.stats.received++;
    const senderKey = toHex(packet.senderKey);
    const hops = packet.linkLocal ? 1 : MAX_TTL - packet.ttl + 1;

    // From a newer phone: we can't read it, but we still pass it on so the mesh keeps working
    // while phones are updated at different times.
    if (!packet.known) {
      if (!packet.linkLocal) this.relay(raw, packet.ttl, linkId, RelayPriority.Carrier);
      return;
    }

    if (packet.type === PacketType.Sync && !packet.linkLocal) {
      this.stats.dropped++;
      return;
    }

    switch (packet.type) {
      case PacketType.Message:
        return this.handleMessage(linkId, raw, packet, id, senderKey, hops);

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
        if (!packet.linkLocal) this.relay(raw, packet.ttl, linkId, RelayPriority.Announce);
        return;
      }

      case PacketType.Leave:
        if (packet.payload.length === CHANNEL_TAG_BYTES) this.opts.onChannelLeave?.(senderKey, toHex(packet.payload));
        else this.opts.onLeave?.(senderKey);
        this.relay(raw, packet.ttl, linkId, RelayPriority.Announce);
        return;

      case PacketType.JoinRequest:
        if (packet.linkLocal) {
          this.stats.dropped++;
          return;
        }
        this.opts.onJoinRequest?.(packet);
        this.relay(raw, packet.ttl, linkId, RelayPriority.Control);
        return;

      case PacketType.ChannelAnnounce: {
        const manifest = decodeManifest(packet.payload);
        // Hidden channels are never announced; a member who does so leaks it, so don't spread it.
        if (!manifest || !verifyManifest(manifest) || !isDiscoverable(manifest.kind)) {
          this.stats.dropped++;
          return;
        }
        const channelId = manifestId(manifest);
        if (!packet.linkLocal) this.lastChannelAnnounce.set(channelId, this.now());
        this.opts.onChannelAnnounce?.({ id: channelId, manifest, hops, flooded: !packet.linkLocal });
        if (!packet.linkLocal) this.relay(raw, packet.ttl, linkId, RelayPriority.Announce);
        return;
      }

      case PacketType.Sync:
        return this.answerSync(linkId, packet.payload);

      case PacketType.Members:
      case PacketType.EpochChange:
      case PacketType.KeyGrant:
        return this.handleControl(linkId, raw, packet, id, true);

      case PacketType.Direct:
      case PacketType.Ack: {
        if (packet.linkLocal || !packet.recipientId || !packet.channelTag) {
          this.stats.dropped++;
          return;
        }
        if (this.isForMe(packet)) return this.opts.onDirect?.(packet);
        // For someone else: pass it on, and carry it by the recipient's mailbox tag.
        const forwarded = packet.ttl > 1 ? withTtl(raw, packet.ttl - 1) : raw;
        if (!this.lowPower) this.carrier.add(id, toHex(packet.channelTag), forwarded);
        this.relay(raw, packet.ttl, linkId, RelayPriority.Direct);
        return;
      }
    }
  }

  private isForMe(packet: MeshPacket): boolean {
    return !!packet.recipientId && toHex(packet.recipientId) === this.opts.identity.fingerprint;
  }

  /**
   * Floods a DM or ACK: `recipientId` = the recipient's fingerprint, `channelTag` = their mailbox
   * tag. Returns its ID and bytes, to keep in the outbox and re-send on new links.
   */
  sendDirect(
    type: PacketType,
    recipientId: Uint8Array,
    channelTag: Uint8Array,
    payload: (messageId: Uint8Array) => Uint8Array,
  ): { id: string; raw: Uint8Array } {
    const messageId = randomBytes(MESSAGE_ID_BYTES);
    const packet = signPacket(
      {
        version: PROTOCOL_VERSION,
        type,
        ttl: MAX_TTL,
        timestamp: this.now(),
        messageId,
        senderKey: this.opts.identity.publicKey,
        channelTag,
        recipientId,
        encrypted: type === PacketType.Direct,
        payload: payload(messageId),
      },
      this.opts.identity.secretKey,
    );
    const raw = encodePacket(packet);
    const id = toHex(messageId);
    this.seen.add(id);
    this.broadcast(raw);
    return { id, raw };
  }

  private handleControl(linkId: string, raw: Uint8Array, packet: MeshPacket, id: string, relay: boolean): void {
    if (packet.linkLocal || !packet.channelTag) {
      this.stats.dropped++;
      return;
    }
    const forwarded = packet.ttl > 1 ? withTtl(raw, packet.ttl - 1) : raw;
    const wire = toHex(packet.channelTag);
    const kept = this.opts.onControl?.(wire, packet, forwarded) ?? false;
    if (!kept) {
      this.passedOn.add(id);
      this.carrier.add(id, wire, forwarded);
    }
    if (relay) this.relay(raw, packet.ttl, linkId, RelayPriority.Control);
  }

  private handleMessage(
    linkId: string,
    raw: Uint8Array,
    packet: MeshPacket,
    id: string,
    senderKey: string,
    hops: number,
    relay = true,
  ): void {
    const wire = packet.channelTag ? toHex(packet.channelTag) : LOBBY_TAG;
    const tag = this.bucketOf(packet);
    const limits = this.limitsFor(tag);
    const priority = limits ? RelayPriority.Mine : RelayPriority.Carrier;
    const pass = () => relay && this.relay(raw, packet.ttl, linkId, priority);
    if (limits?.ttl) hops = Math.max(1, limits.ttl - packet.ttl + 1);
    const maxAge = limits?.maxAgeMs ?? this.maxMessageAgeMs;
    if (this.now() - packet.timestamp > maxAge) {
      this.stats.dropped++;
      return;
    }
    if (wire !== LOBBY_TAG) this.opts.onChannelTraffic?.(wire, packet.timestamp);

    const forwarded = packet.ttl > 1 ? withTtl(raw, packet.ttl - 1) : raw;
    // Not my channel: pass it on without reading it, and carry a copy for members I meet later.
    if (!limits) {
      this.passedOn.add(id);
      if (wire !== LOBBY_TAG && !this.lowPower) this.carrier.add(id, wire, forwarded);
      pass();
      return;
    }

    const keys = this.opts.channelKeys?.(tag);
    // Encrypted in a plaintext channel, or plaintext in an encrypted one: not from a member.
    if ((keys === undefined) === packet.encrypted) {
      this.stats.dropped++;
      pass();
      return;
    }
    const body = keys ? openWithAny(packet, keys.all) : openMessage(packet);
    if (!body && keys) {
      // My channel, but none of my keys open it (yet): keep it so it can be read, and shared,
      // once the key arrives.
      const entry = { id, raw: forwarded, timestamp: packet.timestamp, channelTag: tag };
      this.remember(entry);
      this.opts.onLockedMessage?.({ ...entry, receivedAt: this.now(), hops });
      pass();
      return;
    }
    if (!body) {
      this.stats.dropped++;
      pass();
      return;
    }
    this.remember({ id, raw: forwarded, timestamp: packet.timestamp, channelTag: tag });
    this.opts.onMessage?.({
      id,
      senderKey,
      fingerprint: this.fingerprint(senderKey, packet.senderKey),
      nickname: body.nickname,
      text: body.text,
      senderSeq: body.senderSeq,
      channelTag: tag,
      timestamp: packet.timestamp,
      receivedAt: this.now(),
      hops,
      mine: false,
      raw: forwarded,
    });
    pass();
  }

  /**
   * Looks again at recent messages I only passed on, after joining a channel or getting new keys.
   * Ones that are now mine are read and kept (not relayed again).
   */
  recheckPassedOn(): void {
    for (const e of this.carrier.all()) {
      const packet = decodePacket(e.raw);
      if (!packet) continue;
      this.passedOn.add(e.id); // carried entries restored after a restart count as passed on
      if (!this.isNowKept(e.id, packet)) continue;
      this.carrier.delete(e.id);
      this.passedOn.delete(e.id);
      const hops = MAX_TTL - packet.ttl;
      if (isControl(packet.type)) this.handleControl("", e.raw, packet, e.id, false);
      else this.handleMessage("", e.raw, packet, e.id, toHex(packet.senderKey), hops, false);
    }
  }

  /** True if this is a message I only passed on before, in a channel I've joined since. */
  private isNowKept(id: string, packet: MeshPacket): boolean {
    if (packet.type !== PacketType.Message && !isControl(packet.type)) return false;
    if (!packet.known || !this.passedOn.has(id)) return false;
    return this.limitsFor(this.bucketOf(packet)) !== null;
  }

  /** The history bucket a packet belongs to: its channel (via resolveTag) or its raw tag. */
  private bucketOf(packet: MeshPacket): string {
    if (!packet.channelTag) return LOBBY_TAG;
    const wire = toHex(packet.channelTag);
    return this.opts.resolveTag?.(wire, packet.timestamp) ?? wire;
  }

  /** Link-local: send back what the other phone is missing for the tags it asked for. */
  private answerSync(linkId: string, payload: Uint8Array): void {
    const sync = decodeSyncPayload(payload);
    if (!sync) {
      this.stats.dropped++;
      return;
    }
    let sent = 0;
    const done = new Set<string>();
    const offer = (raw: Uint8Array): boolean => {
      if (sent >= MAX_SYNC_REPLIES) return false;
      const mid = messageIdOf(raw);
      const key = toHex(mid);
      if (done.has(key) || sync.bloom.has(mid)) return true;
      done.add(key);
      this.schedule(() => this.opts.send(linkId, raw), sent * SYNC_REPLY_SPACING_MS);
      sent++;
      return true;
    };
    const control: Uint8Array[] = [];
    const messages: Uint8Array[] = [];
    const carried: Uint8Array[] = [];
    const buckets = new Set<string>();
    for (const want of sync.wants) {
      const wantHex = toHex(want);
      buckets.add(isLobbyWant(want) ? LOBBY_TAG : (this.opts.resolveTag?.(wantHex, this.now()) ?? wantHex));
      for (const e of this.carrier.forTag(wantHex)) carried.push(e.raw);
    }
    for (const b of buckets) {
      control.push(...(this.opts.controlFor?.(b) ?? []));
      messages.push(...(this.history.get(b) ?? []).map((h) => h.raw));
    }
    // Member lists and keys first, so nobody ends up with messages but no key; carried last.
    for (const raw of [...control, ...messages, ...carried]) if (!offer(raw)) return;
  }

  /**
   * Relays after a short random wait. Neighbours that send me the same packet while I wait
   * clearly have it, so they're skipped (and if all of them do, the relay is skipped). This never
   * costs delivery. What's left goes into a priority queue that the relay budget drains from the
   * front. (The plan's "skip after 2 copies" rule cut traffic more but lost 6–9 % of deliveries
   * in the benchmark, so it isn't used.)
   */
  private relay(raw: Uint8Array, ttl: number, fromLink: string, priority: RelayPriority = RelayPriority.Mine): void {
    if (ttl <= 1) return;
    if (this.lowPower && (priority === RelayPriority.Carrier || priority === RelayPriority.Direct)) return;
    if (!this.opts.links().some((l) => l !== fromLink)) return;
    const id = toHex(messageIdOf(raw));
    this.noteRelayed(id, ttl, priority);
    const pending = { have: new Set([fromLink]), ttl, raw, priority };
    this.pendingRelays.set(id, pending);
    const [min, max] = this.jitter;
    this.schedule(() => {
      if (this.pendingRelays.get(id) === pending) this.pendingRelays.delete(id);
      const suppress = this.opts.suppressDuplicates !== false;
      const others = this.opts.links().filter((l) => l !== fromLink);
      const targets = suppress ? others.filter((l) => !pending.have.has(l)) : others;
      this.stats.suppressed = (this.stats.suppressed ?? 0) + (others.length - targets.length);
      if (targets.length === 0) return;
      const out = withTtl(pending.raw, pending.ttl - 1);
      this.enqueue({ priority: pending.priority, seq: this.queueSeq++, out, targets });
    }, min + this.random() * (max - min));
  }

  /**
   * A copy of something I've already handled. Note that the sender has it. If it has more hops
   * left than the copy I relayed (it came a shorter way), relay it again so it can still reach
   * as far as it should; otherwise far phones would miss messages that took a long first route.
   */
  private onDuplicate(id: string, linkId: string, packet: MeshPacket, raw: Uint8Array): void {
    if (packet.type === PacketType.Direct && this.isForMe(packet)) {
      if (verifyPacket(packet)) this.opts.onDirectDuplicate?.(packet);
      return;
    }
    const pending = this.pendingRelays.get(id);
    if (pending) {
      pending.have.add(linkId);
      if (packet.ttl > pending.ttl && !packet.linkLocal) {
        pending.ttl = packet.ttl;
        pending.raw = raw;
      }
      return;
    }
    const done = this.relayedTtl.get(id);
    if (this.opts.relayFresherCopies === false) return;
    if (!done || packet.ttl <= done.ttl || packet.linkLocal) return;
    // ttl isn't signed, but the rest is: check it before spending a relay on it.
    if (!verifyPacket(packet)) return;
    this.relay(raw, packet.ttl, linkId, done.priority);
  }

  private noteRelayed(id: string, ttl: number, priority: RelayPriority): void {
    const prev = this.relayedTtl.get(id);
    if (prev && prev.ttl >= ttl) return;
    this.relayedTtl.delete(id);
    this.relayedTtl.set(id, { ttl, priority });
    if (this.relayedTtl.size > MAX_RELAYED_TTL) this.relayedTtl.delete(this.relayedTtl.keys().next().value!);
  }

  private enqueue(item: { priority: number; seq: number; out: Uint8Array; targets: string[] }): void {
    const q = this.relayQueue;
    let i = q.length;
    while (i > 0 && q[i - 1].priority > item.priority) i--;
    q.splice(i, 0, item);
    if (q.length > MAX_RELAY_QUEUE) {
      q.pop(); // the newest of the least important
      this.stats.dropped++;
    }
    this.pump();
  }

  private pump(fromTimer = false): void {
    let sent = 0;
    while (this.relayQueue.length && this.takeToken()) {
      const item = this.relayQueue.shift()!;
      const live = new Set(this.opts.links());
      for (const link of item.targets) if (live.has(link)) this.opts.send(link, item.out);
      this.stats.relayed++;
      sent++;
    }
    if (!this.relayQueue.length || this.pumpScheduled) return;
    // Out of budget: try again once a token has refilled. A timer re-try that sent nothing with the
    // clock standing still (a frozen test clock) stops here; the next relay call pumps again.
    if (fromTimer && sent === 0 && this.now() === this.lastPumpAt) return;
    this.lastPumpAt = this.now();
    this.pumpScheduled = true;
    this.schedule(() => {
      this.pumpScheduled = false;
      this.pump(true);
    }, Math.ceil(1000 / this.maxRelaysPerSecond));
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

  private limitsFor(tag: string): ChannelLimits | null {
    if (this.opts.channelLimits) return this.opts.channelLimits(tag);
    return tag === LOBBY_TAG ? this.lobbyLimits : null;
  }

  private listFor(tag: string): HistoryEntry[] {
    let list = this.history.get(tag);
    if (!list) {
      list = [];
      this.history.set(tag, list);
    }
    return list;
  }

  private remember(entry: HistoryEntry): void {
    const list = this.listFor(entry.channelTag);
    list.push(entry);
    if (list.length > 1 && entry.timestamp < list[list.length - 2].timestamp) {
      list.sort((a, b) => a.timestamp - b.timestamp);
    }
    this.pruneHistory(entry.channelTag);
  }

  private pruneHistory(tag: string): void {
    const limits = this.limitsFor(tag);
    if (!limits) {
      this.history.delete(tag);
      return;
    }
    const cutoff = this.now() - limits.maxAgeMs;
    let list = (this.history.get(tag) ?? []).filter((h) => h.timestamp >= cutoff);
    if (list.length > limits.maxMessages) list = list.slice(-limits.maxMessages);
    this.history.set(tag, list);
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

/**
 * Reads a MESSAGE packet's payload: decrypts it with `key` when given, otherwise reads it
 * as plaintext. Returns null if it can't be read.
 */
export function openMessage(packet: MeshPacket, key?: Uint8Array): MessagePayload | null {
  if (!key) return packet.encrypted ? null : decodeMessagePayload(packet.payload);
  if (!packet.encrypted || !packet.channelTag) return null;
  const plain = decryptMessage(
    key,
    {
      channelTag: packet.channelTag,
      messageId: packet.messageId,
      senderKey: packet.senderKey,
      timestamp: packet.timestamp,
    },
    packet.payload,
  );
  return plain && decodeMessagePayload(plain);
}

/** Tries each key, newest first. */
export function openWithAny(packet: MeshPacket, keys: Uint8Array[]): MessagePayload | null {
  for (const k of keys) {
    const body = openMessage(packet, k);
    if (body) return body;
  }
  return null;
}

function isControl(type: number): boolean {
  return type === PacketType.Members || type === PacketType.EpochChange || type === PacketType.KeyGrant;
}

function isLobbyWant(tag: Uint8Array): boolean {
  return equalBytes(tag, LOBBY_WANT_TAG);
}

/** The 16-byte tag for a hex channel tag (LOBBY_TAG → undefined). */
export function tagBytes(channelTag: string): Uint8Array | undefined {
  if (channelTag === LOBBY_TAG) return undefined;
  const bytes = fromHex(channelTag);
  if (!bytes || bytes.length !== CHANNEL_TAG_BYTES) throw new Error("bad channel tag");
  return bytes;
}
