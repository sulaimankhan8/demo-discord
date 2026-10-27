// Browser-tab simulator: each tab acts as one phone, and tabs "see" each other over a
// BroadcastChannel. Positions let you build a chain (tab 1 – tab 2 – tab 3) to test relaying:
// a tab only links to tabs whose position is one step away. With no position set, every tab
// links to every other tab.

import { toHex, randomBytes } from "../bytes";
import type { LinkTransport, LinkTransportEvents } from "./LinkTransport";

type SimMessage =
  | { t: "hello"; from: string; pos: number | null }
  | { t: "bye"; from: string }
  | { t: "data"; from: string; to: string; frame: Uint8Array };

const CHANNEL = "mesh-sim-v1";
const HELLO_MS = 2000;
const LINK_TIMEOUT_MS = 7000;
/** Typical BLE write size after MTU negotiation; small enough to exercise fragmentation. */
const SIM_FRAME_BYTES = 180;

export class DevLinkTransport implements LinkTransport {
  readonly kind = "sim" as const;
  readonly nodeId = toHex(randomBytes(6));

  private channel: BroadcastChannel | null = null;
  private events: LinkTransportEvents | null = null;
  private links = new Map<string, number>(); // nodeId -> last hello time
  private positions = new Map<string, number | null>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private position: number | null = null) {}

  async start(events: LinkTransportEvents): Promise<void> {
    this.events = events;
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.onmessage = (e: MessageEvent<SimMessage>) => this.onMessage(e.data);
    this.hello();
    this.timer = setInterval(() => {
      this.hello();
      this.expireLinks();
    }, HELLO_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.post({ t: "bye", from: this.nodeId });
    for (const id of [...this.links.keys()]) this.drop(id);
    this.channel?.close();
    this.channel = null;
    this.events = null;
  }

  send(linkId: string, frame: Uint8Array): void {
    if (!this.links.has(linkId)) return;
    this.post({ t: "data", from: this.nodeId, to: linkId, frame });
  }

  getPosition(): number | null {
    return this.position;
  }

  /** Moves this tab in the simulated chain; links that are now out of reach drop. */
  setPosition(position: number | null): void {
    this.position = position;
    for (const [id, pos] of this.positions) if (!this.canSee(pos) && this.links.has(id)) this.drop(id);
    this.hello();
  }

  private canSee(otherPos: number | null | undefined): boolean {
    if (this.position === null || otherPos === null || otherPos === undefined) return true;
    return Math.abs(this.position - otherPos) <= 1;
  }

  private onMessage(msg: SimMessage): void {
    if (!msg || msg.from === this.nodeId) return;
    switch (msg.t) {
      case "hello":
        this.positions.set(msg.from, msg.pos);
        if (!this.canSee(msg.pos)) {
          if (this.links.has(msg.from)) this.drop(msg.from);
          return;
        }
        this.touch(msg.from);
        return;
      case "bye":
        this.positions.delete(msg.from);
        if (this.links.has(msg.from)) this.drop(msg.from);
        return;
      case "data":
        if (msg.to !== this.nodeId) return;
        if (!this.canSee(this.positions.get(msg.from))) return;
        this.touch(msg.from);
        this.events?.data(msg.from, msg.frame);
        return;
    }
  }

  private touch(id: string): void {
    const isNew = !this.links.has(id);
    this.links.set(id, Date.now());
    if (isNew) {
      // Reply at once so the other tab links to us without waiting for our next hello.
      this.hello();
      this.events?.linkUp({ linkId: id, maxFrameBytes: SIM_FRAME_BYTES });
    }
  }

  private drop(id: string): void {
    this.links.delete(id);
    this.events?.linkDown(id);
  }

  private expireLinks(): void {
    const cutoff = Date.now() - LINK_TIMEOUT_MS;
    for (const [id, last] of this.links) if (last < cutoff) this.drop(id);
  }

  private hello(): void {
    this.post({ t: "hello", from: this.nodeId, pos: this.position });
  }

  private post(msg: SimMessage): void {
    try {
      this.channel?.postMessage(msg);
    } catch {
      // Channel closed.
    }
  }
}
