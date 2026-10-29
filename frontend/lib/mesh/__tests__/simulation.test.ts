// Mesh behaviour on simulated phones (see sim.ts), plus router security checks.

import { describe, expect, it } from "vitest";
import { randomBytes } from "../bytes";
import { signPacket } from "../crypto";
import { createIdentity } from "../identity";
import { encodePacket, MAX_TTL, PacketType, PROTOCOL_VERSION, type MeshPacket } from "../packet";
import { encodeMessagePayload } from "../payloads";
import { MeshRouter, type DeliveredMessage } from "../router";
import { MeshService, type SeqStorage } from "../MeshService";
import type { LinkTransport } from "../transports/LinkTransport";
import { prng, SimNetwork, type SimNode } from "./sim";

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
          payload: encodeMessagePayload({ senderSeq: 1, nickname: "x", text }),
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

/** A signed packet from someone outside the simulation. */
function foreignPacket(extra: Partial<MeshPacket>): Uint8Array {
  const author = createIdentity();
  return encodePacket(
    signPacket(
      {
        version: PROTOCOL_VERSION,
        type: PacketType.Message,
        ttl: MAX_TTL,
        timestamp: Date.now(),
        messageId: randomBytes(8),
        senderKey: author.publicKey,
        payload: encodeMessagePayload({ senderSeq: 1, nickname: "x", text: "foreign" }),
        ...extra,
      },
      author.secretKey,
    ),
  );
}

describe("protocol v2 forward compatibility", () => {
  async function chain() {
    const net = new SimNetwork();
    const n = await net.addNodes(3);
    net.connect(n[0], n[1]);
    net.connect(n[1], n[2]);
    net.run();
    return { net, n };
  }
  const received = (node: SimNode) => node.service.getSnapshot().stats.received;

  it("relays a packet of unknown type 99 without delivering it", async () => {
    const { net, n } = await chain();
    const before = n.map(received);
    n[1].inject(n[0].name, foreignPacket({ type: 99, payload: new Uint8Array([1, 2, 3]) }));
    net.run();
    expect(received(n[1])).toBe(before[1] + 1);
    expect(received(n[2])).toBe(before[2] + 1); // reached n2 through n1
    expect(received(n[0])).toBe(before[0]); // not sent back where it came from
    for (const node of n) expect(node.service.getSnapshot().messages).toHaveLength(0);
  });

  it("relays packets with unknown flag bits", async () => {
    const { net, n } = await chain();
    const before = received(n[2]);
    n[1].inject(n[0].name, foreignPacket({ unknownFlags: 0x80 }));
    net.run();
    expect(received(n[2])).toBe(before + 1);
    expect(n[2].received("foreign")).toHaveLength(0);
  });

  it("never relays an unknown link-local packet", async () => {
    const { net, n } = await chain();
    const before = received(n[2]);
    n[1].inject(n[0].name, foreignPacket({ type: 99, linkLocal: true, ttl: 1 }));
    net.run();
    expect(received(n[1])).toBeGreaterThan(0);
    expect(received(n[2])).toBe(before);
  });

  it("relays messages for channels it has not joined, without showing them", async () => {
    const { net, n } = await chain();
    const before = received(n[2]);
    n[1].inject(n[0].name, foreignPacket({ channelTag: randomBytes(16) }));
    net.run();
    expect(received(n[2])).toBe(before + 1);
    for (const node of n) expect(node.received("foreign")).toHaveLength(0);
  });
});

describe("sender sequence numbers", () => {
  it("counts up per message and survives a restart (and reads the old single-number format)", async () => {
    let saved: Record<string, number> | number = 5; // what older builds stored
    const seqStorage: SeqStorage = { load: () => saved, save: (n) => void (saved = n) };
    const identity = createIdentity();
    const service = () =>
      new MeshService({
        transport: { kind: "memory", start: async () => {}, stop: async () => {}, send: () => {} },
        identity,
        nickname: "me",
        seqStorage,
        announceIntervalMs: 0,
      });

    const first = service();
    await first.start();
    first.sendText("one");
    first.sendText("two");
    await first.stop();
    expect(saved).toEqual({ "": 7 }); // Lobby counter, carried on from 5

    const second = service();
    await second.start();
    second.sendText("three");
    expect(saved).toEqual({ "": 8 });
  });

  it("carries the sender's seq on the wire", () => {
    const delivered: number[] = [];
    const router = new MeshRouter({
      identity: createIdentity(),
      nickname: "probe",
      links: () => [],
      send: () => {},
      onMessage: (m) => delivered.push(m.senderSeq),
    });
    router.handleIncoming(
      "x",
      foreignPacket({ payload: encodeMessagePayload({ senderSeq: 77, nickname: "y", text: "z" }) }),
    );
    expect(delivered).toEqual([77]);
  });
});
