// Internet bridge as one more mesh link (docs/10 C5). When the phone is online it connects to
// the backend's /mesh-bridge WebSocket and shows up to the router as a single link, "bridge".
// Flooding, dedup and keys work unchanged; the bridge server only forwards signed packets
// between gateways subscribed to the same tags. It never sees channel keys.
//
// Only packets of bridge-allowed channels go up (the tags set with setTags). Link-local packets
// (hello, SYNC) and the Lobby never leave the local mesh. Packets coming down get a fresh hop
// count, since for the receiving mesh they start here.

import { decodePacket, MAX_TTL, withTtl } from "../packet";
import { toHex } from "../bytes";
import { FRAME_WHOLE } from "../fragment";
import type { LinkTransport, LinkTransportEvents } from "./LinkTransport";

export const BRIDGE_LINK_ID = "bridge";
/** The bridge carries whole packets, so frames never need splitting. */
const BRIDGE_FRAME_BYTES = 8192;

export type BridgeStatus = "offline" | "connecting" | "up";

/** The bits of a WebSocket this uses (so tests can pass a fake). */
export interface BridgeSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface BridgeOptions {
  url: string;
  createSocket?: (url: string) => BridgeSocket;
  /** Whether the device thinks it's online, and a way to hear when that changes. */
  isOnline?: () => boolean;
  watchOnline?: (cb: (online: boolean) => void) => () => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  onStatus?: (status: BridgeStatus) => void;
}

const OPEN = 1;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export class BridgeLinkTransport implements LinkTransport {
  readonly kind = "bridge" as const;
  private events: LinkTransportEvents | null = null;
  private socket: BridgeSocket | null = null;
  private tags = new Set<string>();
  private uploadOnly = new Set<string>();
  private status: BridgeStatus = "offline";
  private retryMs = RETRY_MIN_MS;
  private retryHandle: unknown = null;
  private unwatch: (() => void) | null = null;
  private stopped = true;

  constructor(private readonly opts: BridgeOptions) {}

  getStatus(): BridgeStatus {
    return this.status;
  }

  /**
   * Tags of bridge-allowed channels (and my DM mailbox): subscribed to and uploaded.
   * `alsoUpload`: tags I may upload but don't want to receive (contacts' mailboxes, for DMs and
   * receipts I send them).
   */
  setTags(tags: string[], alsoUpload: string[] = []): void {
    this.uploadOnly = new Set(alsoUpload);
    const next = new Set(tags);
    if (next.size === this.tags.size && [...next].every((t) => this.tags.has(t))) return;
    this.tags = next;
    this.sendSubscribe();
  }

  async start(events: LinkTransportEvents): Promise<void> {
    this.events = events;
    this.stopped = false;
    this.unwatch = (this.opts.watchOnline ?? watchNavigatorOnline)((online) => {
      if (online) this.connect();
      else this.disconnect();
    });
    if ((this.opts.isOnline ?? navigatorOnline)()) this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
    this.disconnect();
    this.events = null;
  }

  send(_linkId: string, frame: Uint8Array): void {
    if (!this.socket || this.socket.readyState !== OPEN || frame[0] !== FRAME_WHOLE) return;
    const packet = frame.subarray(1);
    const p = decodePacket(packet);
    if (!p || p.linkLocal || !p.channelTag) return;
    const tag = toHex(p.channelTag);
    if (!this.tags.has(tag) && !this.uploadOnly.has(tag)) return;
    this.socket.send(packet.slice());
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    this.clearRetry();
    this.setStatus("connecting");
    let socket: BridgeSocket;
    try {
      socket = (this.opts.createSocket ?? ((u) => new WebSocket(u) as unknown as BridgeSocket))(this.opts.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      this.retryMs = RETRY_MIN_MS;
      this.setStatus("up");
      this.sendSubscribe();
      this.events?.linkUp({ linkId: BRIDGE_LINK_ID, maxFrameBytes: BRIDGE_FRAME_BYTES });
    };
    socket.onmessage = (ev) => {
      const bytes = toBytes(ev.data);
      if (!bytes) return;
      const frame = new Uint8Array(bytes.length + 1);
      frame[0] = FRAME_WHOLE;
      frame.set(withTtl(bytes, MAX_TTL), 1);
      this.events?.data(BRIDGE_LINK_ID, frame);
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      const wasUp = this.status === "up";
      this.socket = null;
      this.setStatus("offline");
      if (wasUp) this.events?.linkDown(BRIDGE_LINK_ID);
      if (!this.stopped && (this.opts.isOnline ?? navigatorOnline)()) this.scheduleRetry();
    };
  }

  private disconnect(): void {
    this.clearRetry();
    const s = this.socket;
    if (!s) return;
    this.socket = null;
    s.onclose = null;
    s.close();
    const wasUp = this.status === "up";
    this.setStatus("offline");
    if (wasUp) this.events?.linkDown(BRIDGE_LINK_ID);
  }

  private sendSubscribe(): void {
    if (this.socket?.readyState === OPEN) {
      this.socket.send(JSON.stringify({ type: "subscribe", tags: [...this.tags] }));
    }
  }

  private scheduleRetry(): void {
    this.clearRetry();
    const wait = this.retryMs;
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    this.retryHandle = (this.opts.schedule ?? ((fn, ms) => setTimeout(fn, ms)))(() => this.connect(), wait);
  }

  private clearRetry(): void {
    if (this.retryHandle !== null) (this.opts.cancel ?? ((h) => clearTimeout(h as number)))(this.retryHandle);
    this.retryHandle = null;
  }

  private setStatus(status: BridgeStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

function navigatorOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

function watchNavigatorOnline(cb: (online: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const on = () => cb(true);
  const off = () => cb(false);
  window.addEventListener("online", on);
  window.addEventListener("offline", off);
  return () => {
    window.removeEventListener("online", on);
    window.removeEventListener("offline", off);
  };
}

/** ws(s)://host/mesh-bridge from an http(s) backend URL. */
export function bridgeUrlFrom(backendUrl: string): string | null {
  try {
    const u = new URL(backendUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/mesh-bridge";
    u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}
