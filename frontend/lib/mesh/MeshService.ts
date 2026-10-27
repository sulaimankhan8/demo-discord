// MeshService ties a link transport, framing, the router and local storage together, and
// exposes a simple state snapshot for the UI.

import { Reassembler, toFrames } from "./fragment";
import { fingerprintOf, type MeshIdentity } from "./identity";
import { decodePacket } from "./packet";
import { cleanNickname, decodeMessagePayload } from "./payloads";
import { MeshRouter, type DeliveredMessage, type RouterStats } from "./router";
import type { MeshStore, StoredMessage } from "./store";
import type { LinkInfo, LinkTransport } from "./transports/LinkTransport";

export interface MeshChatMessage {
  id: string;
  fingerprint: string;
  nickname: string;
  text: string;
  timestamp: number;
  /** 0 = sent by this device, 1 = direct, 2+ = relayed. */
  hops: number;
  mine: boolean;
}

export interface MeshPeer {
  key: string;
  fingerprint: string;
  nickname: string;
  hops: number;
  direct: boolean;
  lastSeen: number;
}

export type MeshStatus = "idle" | "starting" | "running" | "stopped" | "error";

export interface MeshSnapshot {
  status: MeshStatus;
  error?: string;
  transport: LinkTransport["kind"] | null;
  me: { nickname: string; fingerprint: string } | null;
  messages: MeshChatMessage[];
  peers: MeshPeer[];
  links: number;
  stats: RouterStats;
}

export const IDLE_SNAPSHOT: MeshSnapshot = {
  status: "idle",
  transport: null,
  me: null,
  messages: [],
  peers: [],
  links: 0,
  stats: { received: 0, relayed: 0, duplicates: 0, dropped: 0 },
};

export interface MeshServiceOptions {
  transport: LinkTransport;
  identity: MeshIdentity;
  nickname: string;
  store?: MeshStore;
  /** How often to re-announce ourselves. 0 turns it off (used in tests). */
  announceIntervalMs?: number;
  peerTimeoutMs?: number;
  now?: () => number;
  random?: () => number;
  schedule?: (fn: () => void, delayMs: number) => void;
  relayJitterMs?: [number, number];
  maxRelaysPerSecond?: number;
}

const MAX_UI_MESSAGES = 500;
const HISTORY_LIMIT = 200;
const HISTORY_MAX_AGE_MS = 12 * 60 * 60_000;

export class MeshService {
  private readonly router: MeshRouter;
  private readonly links = new Map<string, LinkInfo>();
  private readonly reassemblers = new Map<string, Reassembler>();
  private readonly peers = new Map<string, MeshPeer>();
  private messages: MeshChatMessage[] = [];
  private listeners = new Set<(s: MeshSnapshot) => void>();
  private snapshot: MeshSnapshot = IDLE_SNAPSHOT;
  private status: MeshStatus = "idle";
  private error: string | undefined;
  private nickname: string;
  private groupId = Math.floor(Math.random() * 2 ** 32);
  private timers: ReturnType<typeof setInterval>[] = [];
  private savesSincePrune = 0;
  private stopRequested = false;
  private readonly now: () => number;

  constructor(private readonly opts: MeshServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.nickname = cleanNickname(opts.nickname) || `anon-${opts.identity.fingerprint.slice(0, 4)}`;
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
      now: opts.now,
      random: opts.random,
      schedule: opts.schedule,
      relayJitterMs: opts.relayJitterMs,
      maxRelaysPerSecond: opts.maxRelaysPerSecond,
      historyLimit: HISTORY_LIMIT,
      historyMaxAgeMs: HISTORY_MAX_AGE_MS,
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
      });
      if (this.stopRequested) {
        await this.opts.transport.stop();
        return this.setStatus("stopped");
      }
      this.setStatus("running");
      this.router.announce();

      const announceMs = this.opts.announceIntervalMs ?? 15_000;
      if (announceMs > 0) {
        this.timers.push(setInterval(() => this.router.announce(), announceMs));
        this.timers.push(setInterval(() => this.expirePeers(), 5_000));
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
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
    this.setStatus("stopped");
  }

  /* ---------------- actions ---------------- */

  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.status !== "running") return;
    this.router.sendMessage(trimmed);
  }

  setNickname(nickname: string): void {
    const clean = cleanNickname(nickname);
    if (!clean || clean === this.nickname) return;
    this.nickname = clean;
    this.router.setNickname(clean);
    if (this.status === "running") this.router.announce();
    this.emit();
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

  private onMessage(m: DeliveredMessage): void {
    this.addMessage({
      id: m.id,
      fingerprint: m.fingerprint,
      nickname: m.nickname,
      text: m.text,
      timestamp: m.timestamp,
      hops: m.hops,
      mine: m.mine,
    });

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
        timestamp: m.timestamp,
        receivedAt: m.receivedAt,
        hops: m.hops,
        mine: m.mine,
      };
      void store.save(stored).catch(() => {});
      if (++this.savesSincePrune >= 20) {
        this.savesSincePrune = 0;
        void store.prune(HISTORY_LIMIT, HISTORY_MAX_AGE_MS).catch(() => {});
      }
    }
    this.emit();
  }

  private addMessage(msg: MeshChatMessage): void {
    if (this.messages.some((m) => m.id === msg.id)) return;
    const next = [...this.messages, msg];
    if (next.length > 1 && msg.timestamp < next[next.length - 2].timestamp) {
      next.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    }
    this.messages = next.slice(-MAX_UI_MESSAGES);
  }

  private async restore(store: MeshStore): Promise<void> {
    let saved: StoredMessage[] = [];
    try {
      await store.prune(HISTORY_LIMIT, HISTORY_MAX_AGE_MS);
      saved = await store.load();
    } catch {
      return; // Storage unavailable: start with empty history.
    }
    const history = [];
    for (const s of saved) {
      const packet = decodePacket(s.raw);
      const body = packet && decodeMessagePayload(packet.payload);
      if (!packet || !body) continue;
      history.push({ id: s.id, raw: s.raw, timestamp: s.timestamp });
      this.addMessage({
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

  private buildSnapshot(): MeshSnapshot {
    return {
      status: this.status,
      error: this.error,
      transport: this.opts.transport.kind,
      me: { nickname: this.nickname, fingerprint: this.opts.identity.fingerprint },
      messages: this.messages,
      peers: [...this.peers.values()].sort((a, b) => a.hops - b.hops || a.nickname.localeCompare(b.nickname)),
      links: this.links.size,
      stats: { ...this.router.stats },
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const l of this.listeners) l(this.snapshot);
  }
}

