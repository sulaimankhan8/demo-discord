// MeshService ties a link transport, framing, the router, channels and local storage together,
// and exposes a simple state snapshot for the UI.

import { fromHex, randomBytes, toHex } from "./bytes";
import { ChannelRegistry, type JoinedChannel, type NearbyChannel } from "./channels/ChannelRegistry";
import { ChannelSecurity, isPrivateKind } from "./channels/ChannelSecurity";
import {
  checkInviteProof,
  createInvite,
  decodeInvite,
  decodeJoinRequest,
  encodeInvite,
  encodeJoinRequest,
  INVITE_TTL_MS,
  proveInvite,
  type InviteProof,
} from "./channels/invites";
import { EpochReason, Role } from "./channels/membership";
import { privateTag } from "./crypto/channelTags";
import {
  ChannelKind,
  channelIdOf,
  createManifest,
  HistoryPolicy,
  channelAllowsBridge,
  isLocked,
  manifestId,
  NONCE_BYTES,
  usesPlainTag,
  type ChannelManifest,
  type NewChannel,
} from "./channels/manifest";
import {
  checkPasswordKey,
  DEFAULT_PASSWORD_KDF,
  isKnownKdf,
  passwordCheck,
  passwordKey,
} from "./crypto/channelCrypto";
import { DirectMessages, DM_PREFIX, DM_RETENTION, isDmId, type MeshDirectInfo } from "./dm/DirectMessages";
import { Reassembler, toFrames } from "./fragment";
import { fingerprintOf, type MeshIdentity } from "./identity";
import { decodePacket, LOBBY_TAG, messageIdOf, type MeshPacket } from "./packet";
import { cleanNickname, LOBBY_WANT_TAG } from "./payloads";
import {
  MeshRouter,
  openMessage,
  openWithAny,
  tagBytes,
  type ChannelLimits,
  type DeliveredMessage,
  type LockedMessage,
  type RouterStats,
  type SyncWant,
} from "./router";
import type { MeshStore, StoredMessage } from "./store";
import type { PowerMode } from "./power";
import type { BridgeStatus } from "./transports/BridgeLinkTransport";
import { TransportError, type LinkInfo, type LinkTransport, type TransportNotice } from "./transports/LinkTransport";

export { LOBBY_TAG };
export type { MeshDirectInfo };

export interface MeshChatMessage {
  id: string;
  fingerprint: string;
  nickname: string;
  text: string;
  timestamp: number;
  /** 0 = sent by this device, 1 = direct, 2+ = relayed. */
  hops: number;
  mine: boolean;
  /** DMs I sent: whether the recipient confirmed it. */
  status?: "sending" | "delivered" | "failed";
}

export interface MeshPeer {
  key: string;
  fingerprint: string;
  nickname: string;
  hops: number;
  direct: boolean;
  lastSeen: number;
}

export interface MeshChannelMember {
  key: string;
  fingerprint: string;
  role: Role;
}

export interface MeshJoinRequest {
  key: string;
  fingerprint: string;
  note: string;
  at: number;
}

export interface MeshChannelInfo {
  id: string;
  /** The owner allows this channel on the internet bridge. */
  bridgeAllowed: boolean;
  /** Messages I have but can't read yet (no key). */
  waitingForKey: number;
  /** False in a locked channel while I don't have the current key (or I've been removed). */
  canSend: boolean;
  /** Private channels: my role, or undefined while I'm not on the member list. */
  myRole?: Role;
  /** Private channels: the member list. */
  members?: MeshChannelMember[];
  /** Private channels: I asked to join and no admin has let me in yet. */
  waitingForApproval: boolean;
  /** Private channels I admin: people asking to join. */
  joinRequests?: MeshJoinRequest[];
  /** Private channels: current key epoch. */
  epoch?: number;
  name: string;
  description: string;
  kind: ChannelKind;
  historyPolicy: HistoryPolicy;
  retentionHours: number;
  ownerFingerprint: string;
  role: "owner" | "member";
  unread: number;
}

export interface MeshNearbyChannel {
  id: string;
  name: string;
  description: string;
  kind: ChannelKind;
  ownerFingerprint: string;
  hops: number;
  lastHeard: number;
  lastActivity?: number;
}

export type MeshStatus = "idle" | "starting" | "running" | "stopped" | "error";

export interface MeshSnapshot {
  status: MeshStatus;
  error?: string;
  /** Why start failed, so the UI can offer a fix (e.g. "bluetooth_off"). */
  errorCode?: TransportError["code"];
  /** Something the user may need to fix while running (e.g. Bluetooth turned off). */
  notice: TransportNotice | null;
  transport: LinkTransport["kind"] | null;
  me: { nickname: string; fingerprint: string } | null;
  /** Messages in the active channel. */
  messages: MeshChatMessage[];
  peers: MeshPeer[];
  links: number;
  stats: RouterStats;
  /** Channels I'm in (not the Lobby). */
  channels: MeshChannelInfo[];
  /** Channels announced nearby that I'm not in. */
  nearbyChannels: MeshNearbyChannel[];
  /** LOBBY_TAG ("") for the Lobby, otherwise a channel ID. */
  activeChannelId: string;
  /** The active channel, or null for the Lobby. */
  activeChannel: MeshChannelInfo | null;
  lobbyUnread: number;
  /** Internet bridge: null when this build/session has none (or it's turned off). */
  bridge: BridgeStatus | null;
  /** Direct-message conversations, most recent first. */
  directs: MeshDirectInfo[];
  /** The open conversation when activeChannelId is a "dm:" ID. */
  activeDirect: MeshDirectInfo | null;
  /** Power mode (C7), or null when nothing manages it (e.g. tests). */
  power: PowerMode | null;
  /** Secrets on this device are sealed with a Keystore/Keychain key (C7). */
  keysProtected: boolean;
}

export const IDLE_SNAPSHOT: MeshSnapshot = {
  status: "idle",
  notice: null,
  transport: null,
  me: null,
  messages: [],
  peers: [],
  links: 0,
  stats: { received: 0, relayed: 0, duplicates: 0, dropped: 0 },
  channels: [],
  nearbyChannels: [],
  activeChannelId: LOBBY_TAG,
  activeChannel: null,
  lobbyUnread: 0,
  bridge: null,
  directs: [],
  activeDirect: null,
  power: null,
  keysProtected: false,
};

/** Per-channel message counters (key = channel ID, "" = Lobby). A plain number is read as the Lobby's. */
export interface SeqStorage {
  load(): Record<string, number> | number;
  save(seqs: Record<string, number>): void;
}

export interface CreateChannelOptions {
  name: string;
  description?: string;
  /** Public or Password so far (Private and Hidden come in C3). */
  kind?: ChannelKind;
  /** Required for Password channels. */
  password?: string;
  historyPolicy?: HistoryPolicy;
  retentionHours?: number;
  maxMessages?: number;
  /** Hops the channel's messages travel (1–7, default 7). */
  ttl?: number;
  /** Allow gateways to carry it over the internet bridge. */
  bridge?: boolean;
}

export type JoinResult =
  | "joined"
  /** Private channel: joined, but an admin has to add me before I get the key. */
  | "waiting_for_key"
  | "needs_password"
  | "wrong_password"
  | "unknown"
  | "unsupported"
  | "invalid_invite"
  | "expired_invite";

export const MIN_PASSWORD_LENGTH = 4;

/** The bit of the internet bridge transport the service talks to. */
export interface MeshBridge {
  /** `tags`: subscribe to and upload; `alsoUpload`: upload only (e.g. DM receipts). */
  setTags(tags: string[], alsoUpload?: string[]): void;
  getStatus(): BridgeStatus;
}

export interface MeshServiceOptions {
  transport: LinkTransport;
  identity: MeshIdentity;
  nickname: string;
  store?: MeshStore;
  /** Where the per-identity message counter (senderSeq) is kept, e.g. localStorage "mesh:seq". */
  seqStorage?: SeqStorage;
  /** Internet bridge (also passed inside `transport`, usually via CompositeTransport). */
  bridge?: MeshBridge;
  /** Set when the store and identity are sealed with a device key (for the status shown). */
  keysProtected?: boolean;
  /** How often to re-announce ourselves. 0 turns off all timers (used in tests). */
  announceIntervalMs?: number;
  /** Base interval for channel announces; each one adds 0–15 s of jitter. */
  channelAnnounceIntervalMs?: number;
  peerTimeoutMs?: number;
  now?: () => number;
  random?: () => number;
  schedule?: (fn: () => void, delayMs: number) => void;
  relayJitterMs?: [number, number];
  maxRelaysPerSecond?: number;
}

const MAX_UI_MESSAGES = 500;
/** The Lobby is meant for "who's around right now", so it keeps little. */
export const LOBBY_LIMITS: ChannelLimits = { maxMessages: 50, maxAgeMs: 60 * 60_000 };
const HOUR = 60 * 60_000;
const CHANNEL_ANNOUNCE_JITTER_MS = 15_000;
const CHANNEL_TICK_MS = 1_000;
/** Carriers keep packets this long, so SYNC asks for hourly tags this far back. */
const CARRIER_HOURS = 6;
const GAP_SYNC_COOLDOWN_MS = 30_000;
/** Join requests are re-sent on every new link for this long. */
export const JOIN_REQUEST_TTL_MS = 12 * HOUR;
/** Admins move private channels to a new key this often (plus up to 30 min, so they don't all do it at once). */
export const ROTATE_AFTER_MS = 24 * HOUR;
export const ROTATE_AFTER_MESSAGES = 500;
const ROTATE_JITTER_MS = 30 * 60_000;

export class MeshService {
  private readonly router: MeshRouter;
  private readonly registry: ChannelRegistry;
  private readonly links = new Map<string, LinkInfo>();
  private readonly reassemblers = new Map<string, Reassembler>();
  private readonly peers = new Map<string, MeshPeer>();
  /** Messages by channel tag. */
  private messages = new Map<string, MeshChatMessage[]>();
  private activeChannelId: string = LOBBY_TAG;
  private lobbyLastRead = 0;
  private nextChannelAnnounce = new Map<string, number>();
  private readonly security: ChannelSecurity;
  private readonly dms: DirectMessages;
  private power: PowerMode | null = null;
  /** Wire tag → channel ID for private channels' hourly tags (null = not one of mine). */
  private tagCache = new Map<string, string | null>();
  private keyCounts = new Map<string, number>();
  /** Join requests I sent, re-sent on new links until I'm let in. */
  private outbox = new Map<string, { channelId: string; raw: Uint8Array; expires: number }>();
  /** Private channels I admin: who's asking to join (by channel, then key). */
  private joinRequests = new Map<string, Map<string, MeshJoinRequest>>();
  private declined = new Set<string>();
  /** Invite ID → the key that used it, so each invite lets in one person. */
  private usedInvites = new Map<string, string>();
  private epochMessages = new Map<string, { epoch: number; count: number }>();
  private rotationJitter = new Map<string, { epoch: number; ms: number }>();
  /** Locked-channel messages I can't read yet, by channel tag, then message ID. */
  private waiting = new Map<string, Map<string, { raw: Uint8Array; hops: number; receivedAt: number }>>();
  private listeners = new Set<(s: MeshSnapshot) => void>();
  private snapshot: MeshSnapshot = IDLE_SNAPSHOT;
  private status: MeshStatus = "idle";
  private error: string | undefined;
  private errorCode: TransportError["code"] | undefined;
  private notice: TransportNotice | null = null;
  private nickname: string;
  private groupId = Math.floor(Math.random() * 2 ** 32);
  private timers: ReturnType<typeof setInterval>[] = [];
  private savesSincePrune = 0;
  private stopRequested = false;
  private seqs: Record<string, number>;
  /** Last senderSeq seen per channel and sender, to notice gaps. */
  private lastSeqs = new Map<string, number>();
  private lastGapSync = new Map<string, number>();
  /** How many times a gap made me ask neighbours again (for tests and the status bar). */
  gapSyncs = 0;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly opts: MeshServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    const loaded = opts.seqStorage?.load() ?? {};
    this.seqs = typeof loaded === "number" ? { [LOBBY_TAG]: loaded } : { ...loaded };
    this.nickname = cleanNickname(opts.nickname) || `anon-${opts.identity.fingerprint.slice(0, 4)}`;
    this.registry = new ChannelRegistry((row) => void opts.store?.saveChannel(row).catch(() => {}), this.now);
    this.security = new ChannelSecurity({
      identity: opts.identity,
      now: this.now,
      store: opts.store,
      sendControl: (type, payload, channelId, recipientId) =>
        this.router.sendControl(type, payload, channelId, recipientId),
      onKeysChanged: (id) => this.onKeysChanged(id),
      onMembersChanged: (id) => this.onMembersChanged(id),
    });
    this.router = new MeshRouter({
      identity: opts.identity,
      nickname: this.nickname,
      links: () => [...this.links.keys()],
      send: (linkId, packet) => this.sendPacket(linkId, packet),
      onMessage: (m) => this.onMessage(m),
      onAnnounce: (p) => {
        this.peers.set(p.senderKey, {
          key: p.senderKey,
          fingerprint: p.fingerprint,
          nickname: p.nickname,
          hops: p.hops,
          direct: p.hops === 1,
          lastSeen: this.now(),
        });
        this.emit();
      },
      onLeave: (key) => {
        if (this.peers.delete(key)) this.emit();
      },
      onChannelAnnounce: (c) => {
        // Someone else announced my channel: wait a full round before I do, so only the
        // member whose timer comes up first each minute sends one.
        if (c.flooded && this.registry.isJoined(c.id)) this.scheduleNextAnnounce(c.id);
        if (this.registry.heard(c.manifest, c.hops)) this.emit();
      },
      onChannelTraffic: (tag, ts) => this.registry.activity(tag, ts),
      channelLimits: (tag) => this.limitsFor(tag),
      channelKeys: (tag) => this.keysFor(tag),
      onLockedMessage: (m) => this.onLockedMessage(m),
      onControl: (tag, packet, raw) => this.security.receive(this.channelForTag(tag), packet, raw),
      controlFor: (tag) => {
        const c = this.channelForTag(tag);
        // Not a channel of mine: maybe a mailbox I have waiting DMs for.
        return c ? this.security.controlFor(c.id) : this.dms.outboxForTag(tag);
      },
      resolveTag: (wire, ts) => this.resolveTag(wire, ts),
      onJoinRequest: (p) => this.onJoinRequest(p),
      onChannelLeave: (sender, id) => this.onChannelLeave(sender, id),
      joinedTags: () => [...this.registry.joined().flatMap((c) => this.wantsFor(c)), this.dms.syncWant()],
      onDirect: (p) => this.dms.onDirect(p),
      onDirectDuplicate: (p) => this.dms.onDirectDuplicate(p),
      announceableChannels: () => this.registry.announceable().map((c) => ({ id: c.id, manifestBytes: c.manifestBytes })),
      nextSeq: (tag) => this.nextSeq(tag),
      carrierPersistence: opts.store
        ? {
            save: (e) =>
              void opts.store
                ?.saveCarrier({ id: e.id, channelTag: e.tag, raw: e.raw, receivedAt: e.receivedAt })
                .catch(() => {}),
            delete: (ids) => void opts.store?.deleteCarrier(ids).catch(() => {}),
          }
        : undefined,
      now: opts.now,
      random: opts.random,
      schedule: opts.schedule,
      relayJitterMs: opts.relayJitterMs,
      maxRelaysPerSecond: opts.maxRelaysPerSecond,
    });
    this.dms = new DirectMessages({
      identity: opts.identity,
      router: this.router,
      store: opts.store,
      now: this.now,
      nickname: () => this.nickname,
      nextSeq: (bucket) => this.nextSeq(bucket),
      peerName: (key) => this.peers.get(key)?.nickname,
      emit: () => this.emit(),
      tagsChanged: () => this.updateBridgeTags(),
    });
    this.snapshot = this.buildSnapshot();
  }

  /* ---------------- lifecycle ---------------- */

  async start(): Promise<void> {
    if (this.status === "running" || this.status === "starting") return;
    this.stopRequested = false;
    this.setStatus("starting");
    try {
      if (this.opts.store) await this.restore(this.opts.store);
      if (this.stopRequested) return this.setStatus("stopped");
      await this.opts.transport.start({
        linkUp: (info) => {
          this.links.set(info.linkId, info);
          this.reassemblers.set(info.linkId, new Reassembler());
          this.router.linkUp(info.linkId);
          this.flushOutbox(info.linkId);
          this.emit();
        },
        linkDown: (linkId) => {
          this.links.delete(linkId);
          this.reassemblers.delete(linkId);
          this.emit();
        },
        data: (linkId, frame) => {
          const packet = this.reassemblers.get(linkId)?.push(frame);
          if (packet) this.router.handleIncoming(linkId, packet);
          this.emit();
        },
        notice: (notice) => {
          this.notice = notice;
          this.emit();
        },
      });
      if (this.stopRequested) {
        await this.opts.transport.stop();
        return this.setStatus("stopped");
      }
      this.setStatus("running");
      this.updateBridgeTags();
      this.router.announce();
      // Spread the first channel announces out, so phones that start together don't all send at once.
      for (const c of this.registry.announceable()) {
        this.nextChannelAnnounce.set(c.id, this.now() + this.random() * this.channelInterval());
      }

      const announceMs = this.opts.announceIntervalMs ?? 15_000;
      if (announceMs > 0) {
        this.timers.push(setInterval(() => this.router.announce(), announceMs));
        this.timers.push(setInterval(() => this.expirePeers(), 5_000));
        this.timers.push(
          setInterval(() => {
            this.tickChannelAnnounces();
            this.tickRotations();
            this.updateBridgeTags(); // hourly tags roll over
          }, CHANNEL_TICK_MS),
        );
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.errorCode = err instanceof TransportError ? err.code : "unknown";
      this.setStatus("error");
    }
  }

  async stop(): Promise<void> {
    if (this.status === "starting") {
      // start() checks this flag and shuts down once it gets past its current step.
      this.stopRequested = true;
      return;
    }
    if (this.status !== "running") return;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.router.leave();
    await this.opts.transport.stop();
    this.links.clear();
    this.reassemblers.clear();
    this.peers.clear();
    this.notice = null;
    this.setStatus("stopped");
  }

  /* ---------------- actions ---------------- */

  /** Sends to the active channel (or the Lobby). */
  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.status !== "running") return;
    if (isDmId(this.activeChannelId)) return this.dms.send(this.activeChannelId.slice(DM_PREFIX.length), trimmed);
    const channel = this.activeChannelId === LOBBY_TAG ? undefined : this.registry.get(this.activeChannelId);
    if (this.activeChannelId !== LOBBY_TAG && !channel) return;
    if (channel && isLocked(channel.manifest.kind) && !this.security.keysFor(channel).send) return;
    let wireTagFor: ((ts: number) => Uint8Array) | undefined;
    if (channel && isPrivateKind(channel.manifest.kind)) {
      const key = this.security.keysFor(channel).send!;
      const id = fromHex(channel.id)!;
      wireTagFor = (ts) => privateTag(key, id, ts);
    }
    this.router.sendMessage(trimmed, channel ? tagBytes(this.tagOf(channel)) : undefined, wireTagFor, channel?.manifest.ttl);
  }

  setNickname(nickname: string): void {
    const clean = cleanNickname(nickname);
    if (!clean || clean === this.nickname) return;
    this.nickname = clean;
    this.router.setNickname(clean);
    if (this.status === "running") this.router.announce();
    this.emit();
  }

  /** Creates a channel I own, announces it and switches to it. Returns its ID. */
  async createChannel(opts: CreateChannelOptions): Promise<string> {
    const kind = opts.kind ?? ChannelKind.Public;
    const spec: NewChannel = {
      name: opts.name,
      description: opts.description,
      kind,
      historyPolicy: opts.historyPolicy ?? HistoryPolicy.Recent,
      retentionHours: opts.retentionHours,
      maxMessages: opts.maxMessages,
      ttl: opts.ttl,
      bridge: opts.bridge,
    };
    let key: Uint8Array | undefined;
    if (kind === ChannelKind.Password) {
      const password = opts.password ?? "";
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      }
      // The key is salted with the channel ID, so pick the nonce (and so the ID) first.
      spec.nonce = randomBytes(NONCE_BYTES);
      spec.passwordKdf = DEFAULT_PASSWORD_KDF;
      key = await passwordKey(password, channelIdOf(this.opts.identity.publicKey, spec.nonce), DEFAULT_PASSWORD_KDF);
      spec.passwordCheck = passwordCheck(key);
    }
    const manifest = createManifest(this.opts.identity, spec, this.now());
    const channel = this.registry.join(manifest, "owner");
    if (key) this.security.setPasswordKey(channel.id, key);
    if (isPrivateKind(kind)) this.security.initPrivate(channel);
    this.updateBridgeTags();
    this.scheduleNextAnnounce(channel.id);
    if (this.status === "running") this.router.announceChannel(channel, true);
    this.setActiveChannel(channel.id);
    return channel.id;
  }

  /**
   * Joins a channel heard nearby (or one I left), asks neighbours for its history and opens it.
   * Password channels need the password; a wrong one is caught by the manifest's check value.
   */
  async joinChannel(id: string, password?: string, note = ""): Promise<JoinResult> {
    if (this.registry.isJoined(id)) {
      this.setActiveChannel(id);
      return "joined";
    }
    const manifest = this.registry.knownManifest(id);
    if (!manifest) return "unknown";
    let key: Uint8Array | undefined;
    if (manifest.kind === ChannelKind.Password) {
      if (!password) return "needs_password";
      if (!manifest.passwordCheck || manifest.passwordKdf === undefined || !isKnownKdf(manifest.passwordKdf)) {
        return "unsupported";
      }
      key = await passwordKey(password, fromHex(id)!, manifest.passwordKdf);
      if (!checkPasswordKey(key, manifest.passwordCheck)) return "wrong_password";
      if (this.registry.isJoined(id)) return "joined"; // joined from another call while deriving
    }
    return this.finishJoin(manifest, key, note);
  }

  /** Joins a private or hidden channel from invite text. Any admin lets me in automatically. */
  async joinWithInvite(text: string, note = ""): Promise<JoinResult> {
    const invite = decodeInvite(text);
    if (!invite || !isPrivateKind(invite.manifest.kind)) return "invalid_invite";
    if (this.now() - invite.createdAt > INVITE_TTL_MS) return "expired_invite";
    const id = manifestId(invite.manifest);
    if (this.registry.isJoined(id) && this.security.isMember(id)) {
      this.setActiveChannel(id);
      return "joined";
    }
    return this.finishJoin(invite.manifest, undefined, note, proveInvite(invite, this.opts.identity.publicKey));
  }

  private finishJoin(manifest: ChannelManifest, key: Uint8Array | undefined, note: string, invite?: InviteProof): JoinResult {
    const channel = this.registry.join(manifest, "member");
    if (key) this.security.setPasswordKey(channel.id, key);
    this.security.track(channel);
    this.updateBridgeTags();
    this.tagCache.clear();
    this.keyCounts.set(channel.id, this.security.keyCount(channel.id));
    this.router.recheckPassedOn();
    this.scheduleNextAnnounce(channel.id);
    const priv = isPrivateKind(manifest.kind);
    if (priv && !this.security.isMember(channel.id)) this.sendJoinRequest(channel.id, note, invite);
    if (this.status === "running") this.router.requestSync(this.wantsFor(channel));
    this.setActiveChannel(channel.id);
    return priv && !this.security.keysFor(channel).send ? "waiting_for_key" : "joined";
  }

  private sendJoinRequest(channelId: string, note: string, invite?: InviteProof): void {
    for (const [oid, o] of this.outbox) if (o.channelId === channelId) this.dropOutbox(oid);
    this.updateBridgeTags();
    const raw = this.router.sendJoinRequest(
      encodeJoinRequest({ channelId: fromHex(channelId)!, invite, note }),
      fromHex(channelId)!,
    );
    const id = toHex(messageIdOf(raw));
    const entry = { channelId, raw, expires: this.now() + JOIN_REQUEST_TTL_MS };
    this.outbox.set(id, entry);
    void this.opts.store?.saveOutbox({ id, ...entry }).catch(() => {});
  }

  /* ---------------- private channel admin ---------------- */

  /** Lets someone in who asked to join. */
  approveJoin(channelId: string, memberKey: string): void {
    this.security.addMember(channelId, memberKey);
    this.joinRequests.get(channelId)?.delete(memberKey);
    this.emit();
  }

  /** Ignores someone's request (and their re-sends) until the app restarts. */
  declineJoin(channelId: string, memberKey: string): void {
    this.declined.add(`${channelId}/${memberKey}`);
    this.joinRequests.get(channelId)?.delete(memberKey);
    this.emit();
  }

  /** One-time invite text for a private or hidden channel I admin. Valid for 7 days. */
  createInvite(channelId: string): string {
    const c = this.registry.get(channelId);
    if (!c || !isPrivateKind(c.manifest.kind)) throw new Error("not a private channel");
    if (!this.security.canAdmin(channelId)) throw new Error("only admins can invite");
    return encodeInvite(createInvite(this.opts.identity, c.manifest, c.manifestBytes, this.now()));
  }

  /** Opens a direct conversation with someone (hex public key, e.g. from the Nearby list). */
  openDirect(peerKey: string): string {
    const id = this.dms.open(peerKey, this.peers.get(peerKey)?.nickname);
    this.setActiveChannel(id);
    return id;
  }

  /** Marks someone verified after comparing fingerprints in person (or clears it). */
  setContactVerified(peerKey: string, verified: boolean): void {
    this.dms.setVerified(peerKey, verified);
  }

  /** Adds someone to a private channel I admin, and sends them the keys. `memberKey` is hex. */
  addMember(channelId: string, memberKey: string, role: Role = Role.Member): void {
    this.security.addMember(channelId, memberKey, role);
    this.emit();
  }

  /** Removes a member and moves everyone else to a new key. */
  removeMember(channelId: string, memberKey: string): void {
    this.security.removeMember(channelId, memberKey);
    this.emit();
  }

  setMemberRole(channelId: string, memberKey: string, role: Role): void {
    this.security.setRole(channelId, memberKey, role);
    this.emit();
  }

  /** Starts a new key epoch for a private channel I admin. */
  rotateChannelKey(channelId: string): void {
    this.security.rotate(channelId);
    this.emit();
  }

  /** Current key epoch of a private channel (for tests and the settings screen). */
  channelEpoch(channelId: string): number {
    return this.security.epoch(channelId);
  }

  leaveChannel(id: string): void {
    const channel = this.registry.get(id);
    if (!channel) return;
    const tag = this.tagOf(channel);
    // Tell the admins, so one of them takes me off the list and changes the key.
    if (isPrivateKind(channel.manifest.kind) && this.security.isMember(id) && this.security.myRole(id) !== Role.Owner) {
      if (this.status === "running") this.router.leaveChannel(fromHex(id)!);
    }
    for (const [oid, o] of this.outbox) if (o.channelId === id) this.dropOutbox(oid);
    this.joinRequests.delete(id);
    this.registry.leave(id);
    this.router.dropChannel(tag);
    this.messages.delete(tag);
    this.nextChannelAnnounce.delete(id);
    this.waiting.delete(tag);
    this.security.forget(id);
    void this.opts.store?.prune((t) => this.retentionFor(t)).catch(() => {});
    if (this.activeChannelId === id) this.activeChannelId = LOBBY_TAG;
    this.updateBridgeTags();
    this.emit();
  }

  /** Applies a power mode (C7): on low battery, stop carrying for others. */
  setPowerMode(mode: PowerMode): void {
    this.power = mode;
    this.router.setLowPower(mode === "low");
    this.emit();
  }

  /** Re-reads things that change outside the service (e.g. the bridge connecting). */
  refresh(): void {
    this.updateBridgeTags();
    this.emit();
  }

  /** Opens a channel (or the Lobby with LOBBY_TAG) and marks it read. */
  setActiveChannel(id: string): void {
    if (id !== LOBBY_TAG && !this.registry.isJoined(id) && !this.dms.has(id)) return;
    this.activeChannelId = id;
    this.markActiveRead();
    this.emit();
  }

  /**
   * Admins move private channels to a new key every 24 h or 500 messages (whichever is first),
   * while they're online. Runs on a timer; tests call it directly.
   * @internal
   */
  tickRotations(): void {
    if (this.status !== "running") return;
    for (const c of this.registry.joined()) {
      if (!isPrivateKind(c.manifest.kind) || !this.security.canAdmin(c.id)) continue;
      const epoch = this.security.epoch(c.id);
      let jitter = this.rotationJitter.get(c.id);
      if (!jitter || jitter.epoch !== epoch) {
        jitter = { epoch, ms: this.random() * ROTATE_JITTER_MS };
        this.rotationJitter.set(c.id, jitter);
      }
      const count = this.epochMessages.get(c.id);
      const messages = count && count.epoch === epoch ? count.count : 0;
      const age = this.now() - this.security.epochStartedAt(c.id);
      const extra = Math.floor((jitter.ms / ROTATE_JITTER_MS) * 50); // spread the message trigger too
      if (age >= ROTATE_AFTER_MS + jitter.ms || messages >= ROTATE_AFTER_MESSAGES + extra) {
        try {
          this.security.rotate(c.id, EpochReason.Periodic);
        } catch {
          // Lost admin rights in the meantime.
        }
      }
    }
  }

  /**
   * Sends channel announces that are due. Runs on a timer; tests call it directly.
   * @internal
   */
  tickChannelAnnounces(): void {
    if (this.status !== "running") return;
    const t = this.now();
    for (const c of this.registry.announceable()) {
      const due = this.nextChannelAnnounce.get(c.id) ?? 0;
      if (t < due) continue;
      this.router.announceChannel(c);
      this.scheduleNextAnnounce(c.id);
    }
  }

  /** How many channel announces this phone has flooded. */
  get channelAnnouncesSent(): number {
    return this.router.channelAnnouncesSent;
  }

  /* ---------------- state ---------------- */

  subscribe(listener: (s: MeshSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): MeshSnapshot {
    return this.snapshot;
  }

  /* ---------------- internals ---------------- */

  private channelInterval(): number {
    return this.opts.channelAnnounceIntervalMs ?? 60_000;
  }

  private scheduleNextAnnounce(id: string): void {
    this.nextChannelAnnounce.set(id, this.now() + this.channelInterval() + this.random() * CHANNEL_ANNOUNCE_JITTER_MS);
  }

  /**
   * The tag on this channel's packets. Public/Password use the channel ID. Private/Hidden also
   * use it for now; hourly rotating tags (doc 10 §2.4) are switched on in C3b.
   */
  private tagOf(c: JoinedChannel | NearbyChannel): string {
    if (!usesPlainTag(c.manifest.kind) && !isPrivateKind(c.manifest.kind)) throw new Error("unknown channel kind");
    return c.id;
  }

  /** The joined channel a tag belongs to. With plain tags, tag = channel ID. */
  private channelForTag(tag: string): JoinedChannel | undefined {
    return this.registry.get(tag);
  }

  private limitsFor(tag: string): ChannelLimits | null {
    if (tag === LOBBY_TAG) return LOBBY_LIMITS;
    const c = this.channelForTag(tag);
    if (!c) return null;
    return { maxMessages: c.manifest.maxMessages, maxAgeMs: c.manifest.retentionHours * HOUR, ttl: c.manifest.ttl };
  }

  /**
   * The channel a wire tag belongs to. Plain tags are channel IDs; private channels' hourly tags
   * are checked against each key I hold, for the packet's own hour.
   */
  private resolveTag(wire: string, timestamp: number): string | undefined {
    if (this.registry.isJoined(wire)) return wire;
    const cached = this.tagCache.get(wire);
    if (cached !== undefined) return cached ?? undefined;
    let found: string | null = null;
    for (const c of this.registry.joined()) {
      if (!isPrivateKind(c.manifest.kind)) continue;
      const id = fromHex(c.id)!;
      if (this.security.keysFor(c).all.some((k) => toHex(privateTag(k, id, timestamp)) === wire)) {
        found = c.id;
        break;
      }
    }
    if (this.tagCache.size > 4000) this.tagCache.clear();
    this.tagCache.set(wire, found);
    return found ?? undefined;
  }

  /**
   * Tells the bridge which tags to subscribe to (and upload): bridge-allowed channels I'm in, by
   * channel ID (public/password messages, and every channel's member lists, keys and join
   * requests), plus private channels' hourly tags for this hour and the last, under my two
   * newest keys.
   */
  private updateBridgeTags(): void {
    const bridge = this.opts.bridge;
    if (!bridge) return;
    const tags: string[] = [];
    for (const c of this.registry.joined()) {
      if (!channelAllowsBridge(c.manifest)) continue;
      tags.push(c.id);
      if (!isPrivateKind(c.manifest.kind)) continue;
      const id = fromHex(c.id)!;
      for (const key of this.security.keysFor(c).all.slice(0, 2)) {
        for (const t of [this.now() - HOUR, this.now()]) tags.push(toHex(privateTag(key, id, t)));
      }
    }
    const dm = this.dms.bridgeTags();
    bridge.setTags([...tags, ...dm.subscribe], dm.upload);
  }

  private onKeysChanged(id: string): void {
    this.updateBridgeTags();
    this.tagCache.clear();
    const n = this.security.keyCount(id);
    // New keys: ask neighbours again, since messages under them had tags I couldn't recognise.
    if (n > (this.keyCounts.get(id) ?? 0)) {
      this.router.recheckPassedOn();
      const c = this.registry.get(id);
      if (c && this.status === "running") this.router.requestSync(this.wantsFor(c));
    }
    this.keyCounts.set(id, n);
    this.readWaiting(id);
    this.emit();
  }

  private onMembersChanged(id: string): void {
    if (this.security.isMember(id)) {
      for (const [oid, o] of this.outbox) if (o.channelId === id) this.dropOutbox(oid);
    }
    const requests = this.joinRequests.get(id);
    if (requests) for (const key of [...requests.keys()]) if (this.security.isMember(id, key)) requests.delete(key);
    this.emit();
  }

  private flushOutbox(linkId: string): void {
    this.dms.flush(linkId);
    const t = this.now();
    for (const [id, o] of this.outbox) {
      if (o.expires < t) this.dropOutbox(id);
      else this.router.resend(linkId, o.raw);
    }
  }

  private dropOutbox(id: string): void {
    this.outbox.delete(id);
    void this.opts.store?.deleteOutbox([id]).catch(() => {});
  }

  private onJoinRequest(packet: MeshPacket): void {
    const req = decodeJoinRequest(packet.payload);
    if (!req) return;
    const id = toHex(req.channelId);
    const c = this.registry.get(id);
    if (!c || !isPrivateKind(c.manifest.kind) || !this.security.canAdmin(id)) return;
    const who = toHex(packet.senderKey);
    if (this.security.isMember(id, who)) return;
    if (req.invite) {
      const inviteId = checkInviteProof(req.channelId, req.invite, packet.senderKey, this.now());
      if (inviteId && this.security.canAdmin(id, toHex(req.invite.adminKey))) {
        const usedBy = this.usedInvites.get(inviteId);
        if (!usedBy || usedBy === who) {
          this.usedInvites.set(inviteId, who);
          try {
            this.security.addMember(id, who);
            this.joinRequests.get(id)?.delete(who);
            this.emit();
            return;
          } catch {
            // Fall through to a manual request.
          }
        }
      }
    }
    if (this.declined.has(`${id}/${who}`)) return;
    const list = this.joinRequests.get(id) ?? new Map<string, MeshJoinRequest>();
    list.set(who, { key: who, fingerprint: fingerprintOf(packet.senderKey), note: req.note, at: packet.timestamp });
    this.joinRequests.set(id, list);
    this.emit();
  }

  /** A member says they left: an admin who may remove them does, which also changes the key. */
  private onChannelLeave(sender: string, id: string): void {
    const c = this.registry.get(id);
    if (!c || !isPrivateKind(c.manifest.kind)) return;
    if (!this.security.canAdmin(id) || !this.security.isMember(id, sender)) return;
    try {
      this.security.removeMember(id, sender);
      this.emit();
    } catch {
      // Not allowed to remove them (e.g. an admin leaving, and I'm only an admin).
    }
  }

  /** undefined = channel isn't encrypted (or I'm not in it). */
  private keysFor(tag: string) {
    if (tag === LOBBY_TAG) return undefined;
    const c = this.channelForTag(tag);
    if (!c || !isLocked(c.manifest.kind)) return undefined;
    return this.security.keysFor(c);
  }

  /** Tries the messages that were waiting for a key, after my keys for a channel changed. */
  private readWaiting(channelId: string): void {
    const c = this.registry.get(channelId);
    if (!c) return;
    const tag = this.tagOf(c);
    const list = this.waiting.get(tag);
    const keys = this.keysFor(tag);
    if (!list || !keys) return;
    for (const [id, w] of list) {
      const packet = decodePacket(w.raw);
      const body = packet && openWithAny(packet, keys.all);
      if (!packet || !body) continue;
      list.delete(id);
      const mine = toHex(packet.senderKey) === toHex(this.opts.identity.publicKey);
      if (!this.hiddenByPolicy(tag, packet.timestamp, mine)) {
        this.addMessage(tag, {
          id,
          fingerprint: fingerprintOf(packet.senderKey),
          nickname: body.nickname,
          text: body.text,
          timestamp: packet.timestamp,
          hops: w.hops,
          mine,
        });
      }
      void this.opts.store
        ?.save({
          id,
          raw: w.raw,
          channelTag: tag,
          timestamp: packet.timestamp,
          receivedAt: w.receivedAt,
          hops: w.hops,
          mine,
        })
        .catch(() => {});
    }
    if (tag === this.activeChannelId) this.markActiveRead();
  }

  private onLockedMessage(m: LockedMessage): void {
    const list = this.waiting.get(m.channelTag) ?? new Map();
    list.set(m.id, { raw: m.raw, hops: m.hops, receivedAt: m.receivedAt });
    this.waiting.set(m.channelTag, list);
    this.emit();
    void this.opts.store
      ?.save({
        id: m.id,
        raw: m.raw,
        channelTag: m.channelTag,
        timestamp: m.timestamp,
        receivedAt: m.receivedAt,
        hops: m.hops,
        mine: false,
        decrypted: false,
      })
      .catch(() => {});
  }

  private retentionFor(tag: string) {
    if (isDmId(tag)) return DM_RETENTION;
    const l = this.limitsFor(tag);
    return l ? { maxCount: l.maxMessages, maxAgeMs: l.maxAgeMs } : { maxCount: 0, maxAgeMs: 0 };
  }

  private sendPacket(linkId: string, packet: Uint8Array): void {
    const link = this.links.get(linkId);
    if (!link) return;
    try {
      this.groupId = (this.groupId + 1) >>> 0;
      for (const frame of toFrames(packet, link.maxFrameBytes, this.groupId)) {
        this.opts.transport.send(linkId, frame);
      }
    } catch {
      this.router.stats.dropped++;
    }
  }

  /** Counters are per channel, so members can spot gaps in what they've received. */
  private nextSeq(tag: string): number {
    const next = ((this.seqs[tag] ?? 0) + 1) >>> 0; // wraps after 4 billion messages
    this.seqs[tag] = next;
    this.opts.seqStorage?.save({ ...this.seqs });
    return next;
  }

  /**
   * What to ask for in SYNC for a channel: its ID (members answer that, with member lists and
   * keys first) and, for private channels, the hourly tags of the last 6 hours under my two
   * newest keys, which carriers can answer without knowing the channel.
   */
  private wantsFor(c: JoinedChannel): SyncWant[] {
    const wants: SyncWant[] = [{ tag: fromHex(c.id)!, bucket: c.id }];
    if (!isPrivateKind(c.manifest.kind)) return wants;
    const id = fromHex(c.id)!;
    const hours = Math.min(c.manifest.retentionHours, CARRIER_HOURS);
    for (const key of this.security.keysFor(c).all.slice(0, 2)) {
      for (let h = 0; h <= hours; h++) wants.push({ tag: privateTag(key, id, this.now() - h * HOUR), bucket: c.id });
    }
    return wants;
  }

  /** A sender's counter jumped (e.g. 40 → 44): ask neighbours for that channel again. */
  private noticeGap(m: DeliveredMessage): void {
    const key = `${m.channelTag}/${m.senderKey}`;
    const last = this.lastSeqs.get(key);
    if (this.lastSeqs.size > 5000) this.lastSeqs.clear();
    this.lastSeqs.set(key, Math.max(last ?? 0, m.senderSeq));
    if (last === undefined || m.senderSeq <= last + 1 || this.status !== "running") return;
    const prev = this.lastGapSync.get(m.channelTag) ?? -Infinity;
    if (this.now() - prev < GAP_SYNC_COOLDOWN_MS) return;
    this.lastGapSync.set(m.channelTag, this.now());
    this.gapSyncs++;
    if (m.channelTag === LOBBY_TAG) {
      this.router.requestSync([{ tag: LOBBY_WANT_TAG, bucket: LOBBY_TAG }]);
      return;
    }
    const c = this.channelForTag(m.channelTag);
    if (c) this.router.requestSync(this.wantsFor(c));
  }

  /** "Since join" channels don't show messages from before I joined. */
  private hiddenByPolicy(tag: string, timestamp: number, mine: boolean): boolean {
    const c = tag === LOBBY_TAG ? undefined : this.channelForTag(tag);
    return !!c && !mine && c.manifest.historyPolicy === HistoryPolicy.SinceJoin && timestamp < c.joinedAt;
  }

  private onMessage(m: DeliveredMessage): void {
    if (!m.mine) this.noticeGap(m);
    const ch = m.channelTag === LOBBY_TAG ? undefined : this.channelForTag(m.channelTag);
    if (ch && isPrivateKind(ch.manifest.kind)) {
      const epoch = this.security.epoch(ch.id);
      const e = this.epochMessages.get(ch.id);
      this.epochMessages.set(ch.id, { epoch, count: e && e.epoch === epoch ? e.count + 1 : 1 });
    }
    if (!this.hiddenByPolicy(m.channelTag, m.timestamp, m.mine)) {
      this.addMessage(m.channelTag, {
        id: m.id,
        fingerprint: m.fingerprint,
        nickname: m.nickname,
        text: m.text,
        timestamp: m.timestamp,
        hops: m.hops,
        mine: m.mine,
      });
      if (m.channelTag === this.activeChannelId) this.markActiveRead();
    }

    if (!m.mine) {
      const peer = this.peers.get(m.senderKey);
      if (peer) {
        peer.nickname = m.nickname;
        peer.lastSeen = this.now();
      }
    }

    const store = this.opts.store;
    if (store) {
      const stored: StoredMessage = {
        id: m.id,
        raw: m.raw,
        channelTag: m.channelTag,
        timestamp: m.timestamp,
        receivedAt: m.receivedAt,
        hops: m.hops,
        mine: m.mine,
      };
      void store.save(stored).catch(() => {});
      if (++this.savesSincePrune >= 20) {
        this.savesSincePrune = 0;
        void store.prune((t) => this.retentionFor(t)).catch(() => {});
      }
    }
    this.emit();
  }

  private addMessage(tag: string, msg: MeshChatMessage): void {
    const list = this.messages.get(tag) ?? [];
    if (list.some((m) => m.id === msg.id)) return;
    const next = [...list, msg];
    if (next.length > 1 && msg.timestamp < next[next.length - 2].timestamp) {
      next.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    }
    this.messages.set(tag, next.slice(-MAX_UI_MESSAGES));
  }

  private latestTimestamp(tag: string): number {
    const list = this.messages.get(tag);
    return list?.length ? list[list.length - 1].timestamp : 0;
  }

  private markActiveRead(): void {
    if (isDmId(this.activeChannelId)) return this.dms.markRead(this.activeChannelId);
    if (this.activeChannelId === LOBBY_TAG) {
      this.lobbyLastRead = Math.max(this.lobbyLastRead, this.latestTimestamp(LOBBY_TAG));
      return;
    }
    const c = this.registry.get(this.activeChannelId);
    if (c) this.registry.markRead(c.id, this.latestTimestamp(this.tagOf(c)));
  }

  private unread(tag: string, lastRead: number): number {
    let n = 0;
    for (const m of this.messages.get(tag) ?? []) if (!m.mine && m.timestamp > lastRead) n++;
    return n;
  }

  private async restore(store: MeshStore): Promise<void> {
    let saved: StoredMessage[] = [];
    try {
      this.registry.load(await store.loadChannels());
      this.security.load(this.registry.joined(), await store.loadEpochKeys(), await store.loadControl());
      for (const c of this.registry.joined()) this.keyCounts.set(c.id, this.security.keyCount(c.id));
      this.router.carrier.load((await store.loadCarrier()).map((r) => ({ ...r, tag: r.channelTag })));
      for (const o of await store.loadOutbox()) {
        if (o.expires >= this.now() && this.registry.isJoined(o.channelId)) {
          this.outbox.set(o.id, { channelId: o.channelId, raw: o.raw, expires: o.expires });
        }
      }
      await store.prune((t) => this.retentionFor(t));
      saved = await store.load();
      this.dms.load(saved, await store.loadContacts(), await store.loadOutbox());
    } catch {
      return; // Storage unavailable: start with empty history.
    }
    const history = [];
    for (const s of saved) {
      if (!this.limitsFor(s.channelTag)) continue;
      const packet = decodePacket(s.raw);
      // Skips v1 packets left over from before the protocol v2 upgrade.
      if (!packet?.known) continue;
      const wire = packet.channelTag ? toHex(packet.channelTag) : LOBBY_TAG;
      if ((wire === LOBBY_TAG ? LOBBY_TAG : this.resolveTag(wire, packet.timestamp)) !== s.channelTag) continue;
      const keys = this.keysFor(s.channelTag);
      const body = keys ? openWithAny(packet, keys.all) : openMessage(packet);
      if (!body && keys) {
        // Still waiting for its key: keep sharing it, show it once the key comes.
        history.push({ id: s.id, raw: s.raw, timestamp: s.timestamp, channelTag: s.channelTag });
        const list = this.waiting.get(s.channelTag) ?? new Map();
        list.set(s.id, { raw: s.raw, hops: s.hops, receivedAt: s.receivedAt });
        this.waiting.set(s.channelTag, list);
        continue;
      }
      if (!body) continue;
      history.push({ id: s.id, raw: s.raw, timestamp: s.timestamp, channelTag: s.channelTag });
      if (this.hiddenByPolicy(s.channelTag, s.timestamp, s.mine)) continue;
      this.addMessage(s.channelTag, {
        id: s.id,
        fingerprint: fingerprintOf(packet.senderKey),
        nickname: body.nickname,
        text: body.text,
        timestamp: s.timestamp,
        hops: s.hops,
        mine: s.mine,
      });
    }
    this.router.loadHistory(history);
    // What was saved before counts as read in the Lobby (it has no saved read marker).
    this.lobbyLastRead = this.latestTimestamp(LOBBY_TAG);
    this.emit();
  }

  private expirePeers(): void {
    const cutoff = this.now() - (this.opts.peerTimeoutMs ?? 60_000);
    let changed = false;
    for (const [key, p] of this.peers) {
      if (p.lastSeen < cutoff) {
        this.peers.delete(key);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private setStatus(status: MeshStatus): void {
    this.status = status;
    this.emit();
  }

  private channelInfo(c: JoinedChannel): MeshChannelInfo {
    const tag = this.tagOf(c);
    const locked = isLocked(c.manifest.kind);
    const priv = isPrivateKind(c.manifest.kind);
    return {
      ...manifestInfo(c.manifest),
      id: c.id,
      bridgeAllowed: channelAllowsBridge(c.manifest),
      role: c.role,
      unread: this.unread(tag, c.lastRead),
      waitingForKey: this.waiting.get(tag)?.size ?? 0,
      canSend: !locked || !!this.security.keysFor(c).send,
      myRole: priv ? this.security.myRole(c.id) : undefined,
      waitingForApproval: priv && !this.security.isMember(c.id),
      joinRequests:
        priv && this.security.canAdmin(c.id)
          ? [...(this.joinRequests.get(c.id)?.values() ?? [])].sort((a, b) => a.at - b.at)
          : undefined,
      epoch: priv ? this.security.epoch(c.id) : undefined,
      members: priv
        ? this.security.members(c.id).map((m) => ({
            key: m.key,
            fingerprint: fingerprintOf(fromHex(m.key)!),
            role: m.role,
          }))
        : undefined,
    };
  }

  private buildSnapshot(): MeshSnapshot {
    const channels = this.registry.joined().map((c) => this.channelInfo(c));
    const nearbyChannels = this.registry.nearby().map((c) => ({
      ...manifestInfo(c.manifest),
      id: c.id,
      hops: c.hops,
      lastHeard: c.lastHeard,
      lastActivity: c.lastActivity,
    }));
    const activeChannel = channels.find((c) => c.id === this.activeChannelId) ?? null;
    const activeTag = activeChannel ? this.tagOf(this.registry.get(activeChannel.id)!) : LOBBY_TAG;
    const directs = this.dms.list();
    const activeDirect = directs.find((d) => d.id === this.activeChannelId) ?? null;
    return {
      status: this.status,
      error: this.error,
      errorCode: this.errorCode,
      notice: this.notice,
      transport: this.opts.transport.kind,
      me: { nickname: this.nickname, fingerprint: this.opts.identity.fingerprint },
      messages: activeDirect ? this.dms.messages(activeDirect.id) : (this.messages.get(activeTag) ?? []),
      peers: [...this.peers.values()].sort((a, b) => a.hops - b.hops || a.nickname.localeCompare(b.nickname)),
      links: this.links.size,
      stats: { ...this.router.stats },
      channels,
      nearbyChannels,
      activeChannelId: activeChannel ? activeChannel.id : activeDirect ? activeDirect.id : LOBBY_TAG,
      activeChannel,
      lobbyUnread: this.unread(LOBBY_TAG, this.lobbyLastRead),
      bridge: this.opts.bridge ? this.opts.bridge.getStatus() : null,
      directs,
      activeDirect,
      power: this.power,
      keysProtected: !!this.opts.keysProtected,
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const l of this.listeners) l(this.snapshot);
  }
}

function manifestInfo(m: ChannelManifest) {
  return {
    name: m.name,
    description: m.description,
    kind: m.kind,
    historyPolicy: m.historyPolicy,
    retentionHours: m.retentionHours,
    ttl: m.ttl,
    ownerFingerprint: fingerprintOf(m.ownerKey),
  };
}
