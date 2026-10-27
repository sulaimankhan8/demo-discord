// Simulated mesh: many MeshService nodes connected by in-memory links. Deliveries run from a
// single queue so each test is deterministic.

import { describe, expect, it } from "vitest";
import { randomBytes } from "../bytes";
import { signPacket } from "../crypto";
import { createIdentity } from "../identity";
import { encodePacket, MAX_TTL, PacketType, PROTOCOL_VERSION } from "../packet";
import { encodeMessagePayload } from "../payloads";
import { MeshRouter, type DeliveredMessage } from "../router";
import { MeshService } from "../MeshService";
import type { LinkTransport, LinkTransportEvents } from "../transports/LinkTransport";

class SimNetwork {
  queue: (() => void)[] = [];
  nodes = new Map<string, SimNode>();
  edges = new Set<string>();
  framesSent = 0;

  async addNode(name: string): Promise<SimNode> {
    const node = new SimNode(name, this);
    this.nodes.set(name, node);
    await node.service.start();
    return node;
  }

  async addNodes(count: number): Promise<SimNode[]> {
    const out: SimNode[] = [];
    for (let i = 0; i < count; i++) out.push(await this.addNode(`n${i}`));
    return out;
  }

  connect(a: SimNode, b: SimNode, maxFrameBytes = 180): void {
    this.edges.add(edgeKey(a.name, b.name));
    a.transport.events!.linkUp({ linkId: b.name, maxFrameBytes });
    b.transport.events!.linkUp({ linkId: a.name, maxFrameBytes });
  }

  connected(a: string, b: string): boolean {
    return this.edges.has(edgeKey(a, b));
  }

  run(maxSteps = 1_000_000): void {
    let steps = 0;
    while (this.queue.length) {
      if (++steps > maxSteps) throw new Error("simulation did not settle");
      this.queue.shift()!();
    }
  }
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

class SimTransport implements LinkTransport {
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
    const copy = frame.slice();
    this.net.queue.push(() => this.net.nodes.get(linkId)?.transport.events?.data(this.name, copy));
  }
}

class SimNode {
  readonly transport: SimTransport;
  readonly service: MeshService;
  constructor(
    readonly name: string,
    net: SimNetwork,
  ) {
    this.transport = new SimTransport(name, net);
    this.service = new MeshService({
      transport: this.transport,
      identity: createIdentity(),
      nickname: name,
      announceIntervalMs: 0,
      relayJitterMs: [0, 0],
      maxRelaysPerSecond: 1_000_000,
      schedule: (fn) => net.queue.push(fn),
    });
  }
  received(text: string) {
    return this.service.getSnapshot().messages.filter((m) => m.text === text);
  }
}

/** Small seeded PRNG so random topologies are the same on every run. */
function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe("mesh simulation", () => {
  it("relays a message down a chain of 5 phones", async () => {
    const net = new SimNetwork();
    const n = await net.addNodes(5);
    for (let i = 0; i < 4; i++) net.connect(n[i], n[i + 1]);
    net.run();

    n[0].service.sendText("hello chain");
    net.run();

    for (let i = 1; i < 5; i++) {
      const got = n[i].received("hello chain");
      expect(got).toHaveLength(1);
      expect(got[0].hops).toBe(i);
      expect(got[0].nickname).toBe("n0");
    }
  });

  it("stops after 7 hops", async () => {
    const net = new SimNetwork();
    const n = await net.addNodes(MAX_TTL + 2);
    for (let i = 0; i < n.length - 1; i++) net.connect(n[i], n[i + 1]);
    net.run();

    n[0].service.sendText("how far");
    net.run();

    expect(n[MAX_TTL].received("how far")).toHaveLength(1);
    expect(n[MAX_TTL + 1].received("how far")).toHaveLength(0);
  });

  it("reaches all 20 phones in a random mesh exactly once, with bounded traffic", async () => {
    const rand = prng(42);
    const net = new SimNetwork();
    const n = await net.addNodes(20);
    // A spanning chain keeps it connected; extra random links make loops.
    for (let i = 1; i < n.length; i++) net.connect(n[i], n[Math.floor(rand() * i)]);
    for (let k = 0; k < 15; k++) {
      const a = n[Math.floor(rand() * n.length)];
      const b = n[Math.floor(rand() * n.length)];
      if (a !== b && !net.connected(a.name, b.name)) net.connect(a, b);
    }
    net.run();
    // The random graph above is shallow, so 7 hops covers it. Check that holds:
    // (each node is reached, so the test is meaningful rather than lucky).

    net.framesSent = 0;
    n[0].service.sendText("flood test");
    net.run();

    for (const node of n.slice(1)) expect(node.received("flood test")).toHaveLength(1);
    // Every phone forwards each message at most once per link.
    expect(net.framesSent).toBeLessThanOrEqual(2 * net.edges.size);
  });

  it("delivers recent messages to a phone that joins later", async () => {
    const net = new SimNetwork();
    const [a, b, c] = await net.addNodes(3);
    net.connect(a, b);
    net.run();

    a.service.sendText("before you arrived");
    net.run();
    expect(c.received("before you arrived")).toHaveLength(0);

    net.connect(b, c);
    net.run();
    const got = c.received("before you arrived");
    expect(got).toHaveLength(1);
    expect(got[0].hops).toBe(2);
  });

  it("carries a 2 KB message across links with tiny writes", async () => {
    const net = new SimNetwork();
    const n = await net.addNodes(3);
    net.connect(n[0], n[1], 23);
    net.connect(n[1], n[2], 40);
    net.run();

    const big = "x".repeat(2000);
    n[0].service.sendText(big);
    net.run();
    expect(n[2].received(big)).toHaveLength(1);
  });

  it("lists peers from announcements, with hop counts", async () => {
    const net = new SimNetwork();
    const n = await net.addNodes(3);
    net.connect(n[0], n[1]);
    net.connect(n[1], n[2]);
    net.run();
    n[2].service.setNickname("carol");
    net.run();

    const peers = n[0].service.getSnapshot().peers;
    const carol = peers.find((p) => p.nickname === "carol");
    expect(carol).toBeDefined();
    expect(carol!.hops).toBe(2);
    expect(carol!.direct).toBe(false);
    expect(peers.find((p) => p.nickname === "n1")?.direct).toBe(true);
  });
});

describe("router security", () => {
  function setup() {
    const delivered: DeliveredMessage[] = [];
    const sent: [string, Uint8Array][] = [];
    const router = new MeshRouter({
      identity: createIdentity(),
      nickname: "me",
      links: () => ["a", "b"],
      send: (l, p) => sent.push([l, p]),
      onMessage: (m) => delivered.push(m),
      schedule: (fn) => fn(),
      relayJitterMs: [0, 0],
    });
    return { router, delivered, sent };
  }

  function signedMessage(text: string, timestamp = Date.now()) {
    const author = createIdentity();
    return encodePacket(
      signPacket(
        {
          version: PROTOCOL_VERSION,
          type: PacketType.Message,
          ttl: MAX_TTL,
          timestamp,
          messageId: randomBytes(8),
          senderKey: author.publicKey,
          payload: encodeMessagePayload({ nickname: "x", text }),
        },
        author.secretKey,
      ),
    );
  }

  it("delivers and relays a valid message once", () => {
    const { router, delivered, sent } = setup();
    const raw = signedMessage("ok");
    router.handleIncoming("a", raw);
    router.handleIncoming("b", raw);
    expect(delivered).toHaveLength(1);
    expect(sent.map(([l]) => l)).toEqual(["b"]); // not back to the link it came from
    expect(router.stats.duplicates).toBe(1);
  });

  it("drops forged or tampered messages without relaying them", () => {
    const { router, delivered, sent } = setup();
    const raw = signedMessage("original");
    raw[raw.length - 65] ^= 0x01; // last payload byte
    router.handleIncoming("a", raw);
    expect(delivered).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(router.stats.dropped).toBe(1);
  });

  it("ignores messages older than 24 hours", () => {
    const { router, delivered } = setup();
    router.handleIncoming("a", signedMessage("old", Date.now() - 25 * 60 * 60_000));
    expect(delivered).toHaveLength(0);
  });

  it("never relays link-local hellos", () => {
    const { router, sent } = setup();
    const neighbour = new MeshRouter({
      identity: createIdentity(),
      nickname: "nb",
      links: () => ["me"],
      send: (_l, p) => router.handleIncoming("a", p),
    });
    neighbour.linkUp("me"); // sends a link-local announce + sync
    expect(sent.filter(([l]) => l === "b")).toHaveLength(0);
  });

  it("limits how many packets one phone relays per second", () => {
    const sent: [string, Uint8Array][] = [];
    const router = new MeshRouter({
      identity: createIdentity(),
      nickname: "me",
      links: () => ["a", "b"],
      send: (l, p) => sent.push([l, p]),
      schedule: (fn) => fn(),
      relayJitterMs: [0, 0],
      maxRelaysPerSecond: 5,
      now: () => 1_000_000,
      maxMessageAgeMs: Number.MAX_SAFE_INTEGER,
    });
    for (let i = 0; i < 20; i++) router.handleIncoming("a", signedMessage(`m${i}`, 1_000_000));
    expect(sent.length).toBe(5);
  });
});

describe("service lifecycle", () => {
  it("shuts the transport down if stopped while still starting", async () => {
    let started = 0;
    let stopped = 0;
    const transport: LinkTransport = {
      kind: "memory",
      start: async () => void started++,
      stop: async () => void stopped++,
      send: () => {},
    };
    const service = new MeshService({ transport, identity: createIdentity(), nickname: "x", announceIntervalMs: 0 });
    const starting = service.start();
    await service.stop(); // like React unmounting the page mid-start
    await starting;
    expect(started).toBe(1);
    expect(stopped).toBe(1);
    expect(service.getSnapshot().status).toBe("stopped");
  });
});
