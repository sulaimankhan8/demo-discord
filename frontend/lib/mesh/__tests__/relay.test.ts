// Carrier cache and relay tuning (step C4).

import { describe, expect, it } from "vitest";
import { randomBytes, toHex } from "../bytes";
import { CarrierCache } from "../carrier";
import { ChannelKind } from "../channels/manifest";
import { signPacket } from "../crypto";
import { createIdentity } from "../identity";
import { MeshService } from "../MeshService";
import { encodePacket, MAX_TTL, PacketType, PROTOCOL_VERSION } from "../packet";
import { encodeAnnouncePayload, encodeMessagePayload } from "../payloads";
import { MeshRouter } from "../router";
import { MemoryMeshStore } from "../store";
import { prng, SimNetwork, type SimNode } from "./sim";

const keyOf = (n: SimNode) => toHex(n.identity.publicKey);
const texts = (n: SimNode) => n.service.getSnapshot().messages.map((m) => m.text);

describe("carrier cache", () => {
  it("drops the oldest when over budget, and anything older than its age limit", () => {
    let t = 1000;
    const c = new CarrierCache(() => t, 300, 60_000);
    c.add("a", "x", new Uint8Array(100));
    t += 10;
    c.add("b", "x", new Uint8Array(100));
    t += 10;
    c.add("c", "y", new Uint8Array(100));
    expect(c.bytes).toBe(300);
    c.add("d", "y", new Uint8Array(100)); // over budget: "a" goes
    expect(c.forTag("x").map((e) => e.id)).toEqual(["b"]);
    expect(c.forTag("y").map((e) => e.id)).toEqual(["c", "d"]);
    t += 60_001;
    expect(c.all()).toEqual([]);
  });
});

describe("carrying messages across gaps", () => {
  it("hands a public channel's messages to a member who arrives after the sender left", async () => {
    const net = new SimNetwork();
    const [a, b, c] = await net.addNodes(3);
    net.connect(a, b);
    net.connect(b, c);
    net.run();
    const id = await a.service.createChannel({ name: "news" });
    net.run();
    await c.service.joinChannel(id);
    net.disconnect(b, c); // c wanders off

    a.service.sendText("posted while you were away");
    net.run();
    expect(b.service.getSnapshot().channels).toHaveLength(0); // b is only a carrier
    await a.service.stop();
    net.disconnect(a, b);

    // c walks past b. No member is around, only b's carrier cache.
    net.connect(b, c);
    net.run();
    expect(texts(c)).toEqual(["posted while you were away"]);
  });

  it("carries private messages by their hourly tags, without the carrier knowing the channel", async () => {
    const net = new SimNetwork();
    const [a, b, c] = await net.addNodes(3);
    net.connect(a, b);
    net.connect(b, c);
    net.run();
    const id = await a.service.createChannel({ name: "team", kind: ChannelKind.Private });
    net.run();
    await c.service.joinChannel(id);
    net.run();
    a.service.approveJoin(id, keyOf(c));
    net.run();

    net.disconnect(b, c);
    a.service.sendText("for c, via the carrier");
    net.run();
    await a.service.stop();
    net.disconnect(a, b);
    expect(b.service.getSnapshot().channels).toHaveLength(0);

    net.connect(b, c);
    net.run();
    expect(texts(c)).toEqual(["for c, via the carrier"]);
  });

  it("keeps carried packets across a restart", async () => {
    const store = new MemoryMeshStore();
    const identity = createIdentity();
    const net = new SimNetwork();
    const a = await net.addNode("a");
    const b = await net.addNode("b", { store, identity });
    const c = await net.addNode("c");
    net.connect(a, b);
    net.connect(b, c);
    net.run();
    const id = await a.service.createChannel({ name: "news" });
    net.run();
    await c.service.joinChannel(id);
    net.disconnect(b, c);
    a.service.sendText("carried through a restart");
    net.run();
    await a.service.stop();
    await b.service.stop();
    net.disconnect(a, b);
    expect((await store.loadCarrier()).length).toBeGreaterThan(0);

    const b2 = new MeshService({
      transport: b.transport,
      identity,
      nickname: "b",
      store,
      announceIntervalMs: 0,
      schedule: (fn) => net.enqueue(fn),
    });
    await b2.start();
    net.connect(b, c); // b's transport now belongs to b2
    net.run();
    expect(texts(c)).toEqual(["carried through a restart"]);
  });
});

describe("duplicate suppression", () => {
  async function clique(suppress: boolean) {
    const net = new SimNetwork(
      { relayJitterMs: [10, 80], random: prng(4), maxRelaysPerSecond: 1000 },
      { timed: true, latencyMs: 3 },
    );
    const n = await net.addNodes(10);
    for (let i = 0; i < n.length; i++)
      for (let j = i + 1; j < n.length; j++) {
        if ((i * 7 + j * 3) % 4 !== 0) net.connect(n[i], n[j]); // dense, not complete
      }
    if (!suppress) for (const node of n) node.service["router"]["opts"].suppressDuplicates = false;
    net.run();
    net.framesSent = 0;
    n[0].service.sendText("dense");
    net.run();
    const delivered = n.slice(1).filter((x) => x.received("dense").length === 1).length;
    const suppressed = n.reduce((s, x) => s + (x.service.getSnapshot().stats.suppressed ?? 0), 0);
    return { delivered, frames: net.framesSent, suppressed };
  }

  it("cuts relay traffic in a dense mesh and still reaches everyone", async () => {
    const off = await clique(false);
    const on = await clique(true);
    expect(off.delivered).toBe(9);
    expect(on.delivered).toBe(9);
    expect(on.suppressed).toBeGreaterThan(0);
    expect(on.frames).toBeLessThan(off.frames);
  });

  it("never suppresses along a chain", async () => {
    const net = new SimNetwork({ relayJitterMs: [10, 80], random: prng(5) }, { timed: true });
    const n = await net.addNodes(6);
    for (let i = 0; i < 5; i++) net.connect(n[i], n[i + 1]);
    net.run();
    n[0].service.sendText("down the line");
    net.run();
    expect(n[5].received("down the line")).toHaveLength(1);
    expect(n.reduce((s, x) => s + (x.service.getSnapshot().stats.suppressed ?? 0), 0)).toBe(0);
  });
});

describe("relay priority", () => {
  it("sends member lists and keys before chat, and announces last, when the budget is tight", () => {
    let now = 1_000_000;
    const tasks: { at: number; fn: () => void }[] = [];
    const sent: number[] = [];
    const router = new MeshRouter({
      identity: createIdentity(),
      nickname: "me",
      links: () => ["a", "b"],
      send: (l, p) => l === "b" && sent.push(p[1]), // packet type byte
      schedule: (fn, ms) => tasks.push({ at: now + ms, fn }),
      relayJitterMs: [0, 0],
      maxRelaysPerSecond: 1,
      now: () => now,
    });
    const runDue = () => {
      for (;;) {
        tasks.sort((x, y) => x.at - y.at);
        const t = tasks[0];
        if (!t || t.at > now) return;
        tasks.shift();
        t.fn();
      }
    };
    const author = createIdentity();
    const packet = (type: number, payload: Uint8Array, channelTag?: Uint8Array) =>
      encodePacket(
        signPacket(
          {
            version: PROTOCOL_VERSION,
            type,
            ttl: MAX_TTL,
            timestamp: now,
            messageId: randomBytes(8),
            senderKey: author.publicKey,
            channelTag,
            payload,
          },
          author.secretKey,
        ),
      );
    // Use up the one token, then queue three kinds at once.
    router.handleIncoming("a", packet(PacketType.Announce, encodeAnnouncePayload("x")));
    runDue();
    sent.length = 0;
    router.handleIncoming("a", packet(PacketType.Announce, encodeAnnouncePayload("y")));
    router.handleIncoming("a", packet(PacketType.Message, encodeMessagePayload({ senderSeq: 1, nickname: "x", text: "hi" })));
    router.handleIncoming("a", packet(PacketType.Members, randomBytes(30), randomBytes(16)));
    runDue();
    for (let i = 0; i < 4; i++) {
      now += 1000;
      runDue();
    }
    expect(sent).toEqual([PacketType.Members, PacketType.Message, PacketType.Announce]);
  });
});

describe("per-channel reach", () => {
  it("stops a 3-hop channel's messages after 3 hops, with the right hop count", async () => {
    const net = new SimNetwork();
    const n = await net.addNodes(5);
    for (let i = 0; i < 4; i++) net.connect(n[i], n[i + 1]);
    net.run();
    const id = await n[0].service.createChannel({ name: "local", ttl: 3 });
    net.run();
    for (const x of n.slice(1)) await x.service.joinChannel(id);
    net.run();
    n[0].service.sendText("close by only");
    net.run();
    expect(n[1].received("close by only")[0].hops).toBe(1);
    expect(n[3].received("close by only")[0].hops).toBe(3);
    expect(n[4].received("close by only")).toHaveLength(0);
  });
});

describe("gap repair", () => {
  it("asks again when a sender's counter jumps, and gets the missing message", async () => {
    let dropping = false;
    const net = new SimNetwork({}, { drop: (from, to) => dropping && from === "n1" && to === "n2" });
    const [a, b, c] = await net.addNodes(3);
    net.connect(a, b);
    net.connect(b, c);
    net.run();
    const id = await a.service.createChannel({ name: "g" });
    net.run();
    await b.service.joinChannel(id);
    await c.service.joinChannel(id);
    net.run();

    a.service.sendText("first");
    net.run();
    dropping = true;
    a.service.sendText("lost on the way");
    net.run();
    dropping = false;
    expect(texts(c)).toEqual(["first"]);

    a.service.sendText("next one");
    net.run();
    expect(c.service.gapSyncs).toBe(1);
    expect(texts(c)).toEqual(["first", "lost on the way", "next one"]);
  });
});
