// Direct messages, delivery receipts, verified contacts (step C6).

import { describe, expect, it } from "vitest";
import { randomBytes, toHex, utf8 } from "../bytes";
import { openDirect, sealDirect } from "../dm/directCrypto";
import { Reassembler } from "../fragment";
import { createIdentity } from "../identity";
import { MeshService } from "../MeshService";
import { decodePacket, PacketType, type MeshPacket } from "../packet";
import { MemoryMeshStore } from "../store";
import { FakeBridgeHub, gateway } from "./fakeBridge";
import { SimNetwork, type SimNode } from "./sim";

const keyOf = (n: SimNode) => toHex(n.identity.publicKey);
const snap = (n: SimNode) => n.service.getSnapshot();
const texts = (n: SimNode) => snap(n).messages.map((m) => m.text);
const dmWith = (n: SimNode, other: SimNode) => `dm:${keyOf(other)}`;

function tap(node: SimNode): MeshPacket[] {
  const packets: MeshPacket[] = [];
  const events = node.transport.events!;
  const original = events.data;
  const r = new Map<string, Reassembler>();
  events.data = (linkId, frame) => {
    if (!r.has(linkId)) r.set(linkId, new Reassembler());
    const raw = r.get(linkId)!.push(frame.slice());
    const p = raw && decodePacket(raw);
    if (p) packets.push(p);
    original(linkId, frame);
  };
  return packets;
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Packet type of a whole (unfragmented) frame, or -1. */
const frameType = (frame: Uint8Array) => (frame[0] === 0 ? frame[2] : -1);

async function line(n: number, netOpts = {}) {
  const net = new SimNetwork({}, netOpts);
  const nodes = await net.addNodes(n);
  for (let i = 0; i < n - 1; i++) net.connect(nodes[i], nodes[i + 1]);
  net.run();
  return { net, nodes };
}

describe("DM sealing", () => {
  const alice = createIdentity();
  const bob = createIdentity();
  const body = { senderSeq: 1, nickname: "alice", text: "just for bob" };

  it("opens only for the recipient", () => {
    const id = randomBytes(8);
    const sealed = sealDirect(alice, bob.publicKey, id, body);
    expect(openDirect(bob, alice.publicKey, id, sealed)).toEqual(body);
    expect(openDirect(createIdentity(), alice.publicKey, id, sealed)).toBeNull();
  });

  it("can't be re-sent under someone else's name or another message ID", () => {
    const id = randomBytes(8);
    const sealed = sealDirect(alice, bob.publicKey, id, body);
    const mallory = createIdentity();
    expect(openDirect(bob, mallory.publicKey, id, sealed)).toBeNull(); // re-signed by mallory
    expect(openDirect(bob, alice.publicKey, randomBytes(8), sealed)).toBeNull(); // replayed as new
  });
});

describe("direct messages", () => {
  it("reaches the recipient through a relay that can't read it, and comes back as delivered", async () => {
    const { net, nodes } = await line(3);
    const [a, b, c] = nodes;
    const seen = tap(b);
    a.service.openDirect(keyOf(c));
    a.service.sendText("meet me at the gate");
    expect(snap(a).messages[0].status).toBe("sending");
    net.run();

    c.service.setActiveChannel(dmWith(c, a));
    expect(texts(c)).toEqual(["meet me at the gate"]);
    expect(snap(c).directs[0].nickname).toBe("n0");
    expect(snap(a).messages[0].status).toBe("delivered");

    const dms = seen.filter((p) => p.type === PacketType.Direct);
    expect(dms.length).toBeGreaterThan(0);
    for (const p of dms) expect(contains(p.payload, utf8("meet me at the gate"))).toBe(false);
    expect(snap(b).directs).toEqual([]); // the relay has no conversation
  });

  it("waits while the recipient is away and gets through when they're back", async () => {
    const { net, nodes } = await line(3);
    const [a, b, c] = nodes;
    net.disconnect(b, c);
    a.service.openDirect(keyOf(c));
    a.service.sendText("are you there?");
    net.run();
    expect(snap(a).messages[0].status).toBe("sending");

    // a walks away too; b still carries the DM.
    net.disconnect(a, b);
    net.connect(b, c);
    net.run();
    c.service.setActiveChannel(dmWith(c, a));
    expect(texts(c)).toEqual(["are you there?"]);

    // The receipt reaches a when a meets b again.
    net.connect(a, b);
    net.run();
    expect(snap(a).messages[0].status).toBe("delivered");
  });

  it("re-sends from the outbox on a new link, and the recipient confirms again if the receipt was lost", async () => {
    let dropAcks = true;
    const { net, nodes } = await line(2, { drop: (_f: string, _t: string, frame: Uint8Array) => dropAcks && frameType(frame) === PacketType.Ack });
    const [a, c] = nodes;
    a.service.openDirect(keyOf(c));
    a.service.sendText("did you get this?");
    net.run();
    c.service.setActiveChannel(dmWith(c, a));
    expect(texts(c)).toEqual(["did you get this?"]);
    expect(snap(a).messages[0].status).toBe("sending"); // the receipt was lost

    dropAcks = false;
    net.disconnect(a, c);
    net.connect(a, c); // a re-sends; c already has it and just confirms again
    net.run();
    expect(snap(a).messages[0].status).toBe("delivered");
    expect(texts(c)).toEqual(["did you get this?"]); // no duplicate
  });

  it("ignores a receipt from someone other than the recipient", async () => {
    const { net, nodes } = await line(3);
    const [a, b, c] = nodes;
    net.disconnect(b, c);
    a.service.openDirect(keyOf(c));
    a.service.sendText("for c only");
    net.run();
    const dmIdHex = snap(a).messages[0].id;
    // b forges a receipt for it.
    b.service["router"].sendDirect(PacketType.Ack, Uint8Array.from(Buffer.from(a.identity.fingerprint, "hex")), randomBytes(16), () =>
      Uint8Array.from(Buffer.from(dmIdHex, "hex")),
    );
    net.run();
    expect(snap(a).messages[0].status).toBe("sending");
  });

  it("keeps conversations, receipts and verified contacts across a restart", async () => {
    const store = new MemoryMeshStore();
    const identity = createIdentity();
    const net = new SimNetwork();
    const me = await net.addNode("me", { store, identity });
    const friend = await net.addNode("friend");
    net.connect(me, friend);
    net.run();
    me.service.openDirect(keyOf(friend));
    me.service.sendText("hello friend");
    net.run();
    friend.service.openDirect(toHex(identity.publicKey));
    friend.service.sendText("hello back");
    net.run();
    me.service.setContactVerified(keyOf(friend), true);
    await me.service.stop();
    net.disconnect(me, friend);

    const again = new MeshService({ transport: me.transport, identity, nickname: "me", store, announceIntervalMs: 0 });
    await again.start();
    again.setActiveChannel(`dm:${keyOf(friend)}`);
    const s = again.getSnapshot();
    expect(s.messages.map((m) => [m.text, m.mine, m.status])).toEqual([
      ["hello friend", true, "delivered"],
      ["hello back", false, undefined],
    ]);
    expect(s.activeDirect?.verified).toBe(true);
    expect(s.activeDirect?.nickname).toBe("friend");
  });

  it("crosses the internet bridge between gateways", async () => {
    const net = new SimNetwork();
    const hub = new FakeBridgeHub(net);
    const a = await net.addNode("a", {}, gateway(hub, net));
    const b = await net.addNode("b", {}, gateway(hub, net));
    net.run();
    expect(net.connected("a", "b")).toBe(false); // no radio path at all
    a.service.openDirect(keyOf(b));
    a.service.sendText("from far away");
    net.run();
    b.service.setActiveChannel(dmWith(b, a));
    expect(texts(b)).toEqual(["from far away"]);
    expect(snap(a).messages[0].status).toBe("delivered");
  });
});
