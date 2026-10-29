// Simulated mesh for tests: many MeshService nodes connected by in-memory links.
//
// Two modes:
// - Default: one FIFO queue, delays ignored. Fast and fully deterministic.
// - Timed (`timed: true`): events run in time order on a shared fake clock, links have latency,
//   and relay jitter really waits. Needed when timing matters (duplicate suppression, benchmarks).

import { toFrames } from "../fragment";
import { createIdentity, type MeshIdentity } from "../identity";
import { MeshService, type MeshBridge, type MeshServiceOptions } from "../MeshService";
import type { LinkTransport, LinkTransportEvents } from "../transports/LinkTransport";

export type SimNodeOptions = Partial<Omit<MeshServiceOptions, "transport">>;

/** Wraps a node's simulated radio, e.g. to add an internet bridge next to it. */
export type SimTransportWrap = (radio: SimTransport) => { transport: LinkTransport; bridge?: MeshBridge };

export interface SimNetworkOptions {
  timed?: boolean;
  /** Per-frame link delay in timed mode (ms). */
  latencyMs?: number;
  /** Return true to drop a frame on the way from `from` to `to` (lossy links). */
  drop?: (from: string, to: string, frame: Uint8Array) => boolean;
  /** Start of the fake clock in timed mode. */
  startTime?: number;
}

interface TimedEvent {
  at: number;
  seq: number;
  fn: () => void;
}

export class SimNetwork {
  queue: (() => void)[] = [];
  nodes = new Map<string, SimNode>();
  edges = new Set<string>();
  framesSent = 0;
  /** Fake clock in timed mode. */
  clock: number;
  private heap: TimedEvent[] = [];
  private seq = 0;

  /** `defaults` are options given to every node (e.g. a shared fake clock). */
  constructor(
    readonly defaults: SimNodeOptions = {},
    readonly options: SimNetworkOptions = {},
  ) {
    this.clock = options.startTime ?? Date.now();
  }

  get timed(): boolean {
    return !!this.options.timed;
  }

  /** Runs `fn` after `delayMs` (timed mode) or after everything already queued (default mode). */
  enqueue(fn: () => void, delayMs = 0): void {
    if (!this.timed) {
      this.queue.push(fn);
      return;
    }
    heapPush(this.heap, { at: this.clock + Math.max(0, delayMs), seq: this.seq++, fn });
  }

  async addNode(name: string, opts: SimNodeOptions = {}, wrap?: SimTransportWrap): Promise<SimNode> {
    const merged: SimNodeOptions = { ...this.defaults, ...opts };
    if (this.timed && !merged.now) merged.now = () => this.clock;
    const node = new SimNode(name, this, merged, wrap);
    this.nodes.set(name, node);
    await node.service.start();
    return node;
  }

  async addNodes(count: number, prefix = "n"): Promise<SimNode[]> {
    const out: SimNode[] = [];
    for (let i = 0; i < count; i++) out.push(await this.addNode(`${prefix}${i}`));
    return out;
  }

  connect(a: SimNode, b: SimNode, maxFrameBytes = 180): void {
    this.edges.add(edgeKey(a.name, b.name));
    a.transport.events?.linkUp({ linkId: b.name, maxFrameBytes });
    b.transport.events?.linkUp({ linkId: a.name, maxFrameBytes });
  }

  disconnect(a: SimNode, b: SimNode): void {
    this.edges.delete(edgeKey(a.name, b.name));
    a.transport.events?.linkDown(b.name);
    b.transport.events?.linkDown(a.name);
  }

  connected(a: string, b: string): boolean {
    return this.edges.has(edgeKey(a, b));
  }

  /** Runs until nothing is left (timed mode: or until `untilTime`). */
  run(maxSteps = 5_000_000, untilTime = Infinity): void {
    let steps = 0;
    if (!this.timed) {
      while (this.queue.length) {
        if (++steps > maxSteps) throw new Error("simulation did not settle");
        this.queue.shift()!();
      }
      return;
    }
    while (this.heap.length && this.heap[0].at <= untilTime) {
      if (++steps > maxSteps) throw new Error("simulation did not settle");
      const e = heapPop(this.heap)!;
      this.clock = Math.max(this.clock, e.at);
      e.fn();
    }
    if (untilTime !== Infinity) this.clock = Math.max(this.clock, untilTime);
  }
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/* small binary heap ordered by (at, seq) */
function less(a: TimedEvent, b: TimedEvent): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}
function heapPush(h: TimedEvent[], e: TimedEvent): void {
  h.push(e);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!less(h[i], h[p])) break;
    [h[i], h[p]] = [h[p], h[i]];
    i = p;
  }
}
function heapPop(h: TimedEvent[]): TimedEvent | undefined {
  if (!h.length) return undefined;
  const top = h[0];
  const last = h.pop()!;
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && less(h[l], h[m])) m = l;
      if (r < h.length && less(h[r], h[m])) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
  }
  return top;
}

export class SimTransport implements LinkTransport {
  readonly kind = "memory" as const;
  events: LinkTransportEvents | null = null;
  constructor(
    private readonly name: string,
    private readonly net: SimNetwork,
  ) {}
  async start(events: LinkTransportEvents) {
    this.events = events;
  }
  async stop() {
    this.events = null;
  }
  send(linkId: string, frame: Uint8Array) {
    if (!this.net.connected(this.name, linkId)) return;
    this.net.framesSent++;
    if (this.net.options.drop?.(this.name, linkId, frame)) return;
    const copy = frame.slice();
    this.net.enqueue(
      () => this.net.nodes.get(linkId)?.transport.events?.data(this.name, copy),
      this.net.options.latencyMs ?? 2,
    );
  }
}

export class SimNode {
  readonly transport: SimTransport;
  readonly service: MeshService;
  readonly identity: MeshIdentity;
  constructor(
    readonly name: string,
    net: SimNetwork,
    opts: SimNodeOptions = {},
    wrap?: SimTransportWrap,
  ) {
    this.transport = new SimTransport(name, net);
    this.identity = opts.identity ?? createIdentity();
    const wrapped = wrap?.(this.transport);
    this.service = new MeshService({
      nickname: name,
      announceIntervalMs: 0,
      relayJitterMs: [0, 0],
      maxRelaysPerSecond: 1_000_000,
      schedule: (fn, ms) => net.enqueue(fn, ms),
      ...opts,
      identity: this.identity,
      transport: wrapped?.transport ?? this.transport,
      bridge: wrapped?.bridge,
    });
  }
  /** Feeds a packet into this phone as if it arrived from the neighbour `from`. */
  inject(from: string, raw: Uint8Array) {
    for (const frame of toFrames(raw, 180, Math.floor(Math.random() * 2 ** 32))) {
      this.transport.events!.data(from, frame);
    }
  }
  /** Messages with this text in the channel that's open on this phone. */
  received(text: string) {
    return this.service.getSnapshot().messages.filter((m) => m.text === text);
  }
}

/** Small seeded PRNG so random topologies are the same on every run. */
export function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
