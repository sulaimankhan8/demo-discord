// Fake of the backend's /mesh-bridge for tests (same routing rules as backend/src/mesh/bridge.js).

import { toHex } from "../bytes";
import { decodePacket } from "../packet";
import { BridgeLinkTransport, type BridgeSocket } from "../transports/BridgeLinkTransport";
import { CompositeTransport } from "../transports/CompositeTransport";
import type { SimNetwork, SimTransportWrap } from "./sim";

/** In-memory bridge server: subscribe by tag, forward to other subscribers, keep for late ones. */
export class FakeBridgeHub {
  online = true;
  uploads: Uint8Array[] = [];
  private sockets = new Set<FakeSocket>();
  private stored = new Map<string, Uint8Array[]>();
  private seen = new Set<string>();
  private onlineWatchers = new Set<(online: boolean) => void>();

  constructor(private readonly net: SimNetwork) {}

  connect(): BridgeSocket {
    const s = new FakeSocket(this, this.net);
    this.sockets.add(s);
    this.net.enqueue(() => {
      if (!this.online) return s.fail();
      s.readyState = 1;
      s.onopen?.();
    });
    return s;
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (!online) for (const s of [...this.sockets]) s.fail();
    for (const cb of this.onlineWatchers) cb(online);
  }

  watch = (cb: (online: boolean) => void) => {
    this.onlineWatchers.add(cb);
    return () => this.onlineWatchers.delete(cb);
  };

  subscribe(s: FakeSocket, tags: string[]): void {
    const added = tags.filter((t) => !s.tags.has(t));
    s.tags = new Set(tags);
    for (const t of added) for (const raw of this.stored.get(t) ?? []) s.deliver(raw);
  }

  upload(from: FakeSocket, raw: Uint8Array): void {
    const p = decodePacket(raw);
    if (!p?.channelTag || p.linkLocal) return;
    this.uploads.push(raw);
    const id = toHex(p.messageId);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    const tag = toHex(p.channelTag);
    this.stored.set(tag, [...(this.stored.get(tag) ?? []), raw]);
    for (const s of this.sockets) if (s !== from && s.readyState === 1 && s.tags.has(tag)) s.deliver(raw);
  }

  drop(s: FakeSocket): void {
    this.sockets.delete(s);
  }
}

class FakeSocket implements BridgeSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  tags = new Set<string>();
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(
    private readonly hub: FakeBridgeHub,
    private readonly net: SimNetwork,
  ) {}
  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) return;
    if (typeof data === "string") {
      const msg = JSON.parse(data);
      this.net.enqueue(() => this.hub.subscribe(this, msg.tags));
    } else {
      const copy = data.slice();
      this.net.enqueue(() => this.hub.upload(this, copy));
    }
  }
  deliver(raw: Uint8Array): void {
    const copy = raw.slice();
    this.net.enqueue(() => this.readyState === 1 && this.onmessage?.({ data: copy.buffer }));
  }
  fail(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.hub.drop(this);
    this.onclose?.();
  }
  close(): void {
    this.fail();
  }
}

export function gateway(hub: FakeBridgeHub, net: SimNetwork): SimTransportWrap {
  return (radio) => {
    const bridge = new BridgeLinkTransport({
      url: "ws://test/mesh-bridge",
      createSocket: () => hub.connect(),
      isOnline: () => hub.online,
      watchOnline: hub.watch,
      schedule: (fn, ms) => net.enqueue(fn, ms),
      cancel: () => {},
    });
    return { transport: new CompositeTransport(radio, [bridge]), bridge };
  };
}

