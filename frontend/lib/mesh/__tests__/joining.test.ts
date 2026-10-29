// Joining, leaving, invites, scheduled key changes and hourly tags (step C3b).

import { describe, expect, it } from "vitest";
import { toHex } from "../bytes";
import { createInvite, decodeInvite, encodeInvite } from "../channels/invites";
import { ChannelKind } from "../channels/manifest";
import { Role } from "../channels/membership";
import { Reassembler } from "../fragment";
import { createIdentity } from "../identity";
import { MeshService, ROTATE_AFTER_MESSAGES, ROTATE_AFTER_MS } from "../MeshService";
import { decodePacket, PacketType, type MeshPacket } from "../packet";
import { MemoryMeshStore } from "../store";
import { SimNetwork, type SimNode } from "./sim";

const keyOf = (n: SimNode) => toHex(n.identity.publicKey);
const info = (n: SimNode, id: string) => n.service.getSnapshot().channels.find((c) => c.id === id)!;
const texts = (n: SimNode) => n.service.getSnapshot().messages.map((m) => m.text);
const memberKeys = (n: SimNode, id: string) => info(n, id).members!.map((m) => m.key);

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

async function line(n: number, opts = {}) {
  const net = new SimNetwork(opts);
  const nodes = await net.addNodes(n);
  for (let i = 0; i < n - 1; i++) net.connect(nodes[i], nodes[i + 1]);
  net.run();
  return { net, nodes };
}

describe("join requests", () => {
  it("lets an admin see a request and let the person in", async () => {
    const { net, nodes } = await line(3);
    const [a, b, c] = nodes;
    const id = await a.service.createChannel({ name: "team", kind: ChannelKind.Private });
    net.run();
    expect(c.service.getSnapshot().nearbyChannels.map((x) => x.kind)).toEqual([ChannelKind.Private]);

    expect(await c.service.joinChannel(id, undefined, "it's Carol from the north gate")).toBe("waiting_for_key");
    net.run();
    expect(info(c, id).waitingForApproval).toBe(true);
    const requests = info(a, id).joinRequests!;
    expect(requests.map((r) => r.note)).toEqual(["it's Carol from the north gate"]);
    expect(requests[0].fingerprint).toBe(c.identity.fingerprint);
    expect(info(b, id)).toBeUndefined(); // the relay isn't involved

    a.service.approveJoin(id, keyOf(c));
    net.run();
    expect(info(a, id).joinRequests).toEqual([]);
    expect(info(c, id).waitingForApproval).toBe(false);
    c.service.sendText("I'm in");
    net.run();
    expect(texts(a)).toEqual(["I'm in"]);
  });

  it("re-sends the request on new links until someone answers", async () => {
    const net = new SimNetwork();
    const [a, c] = await net.addNodes(2);
    net.connect(a, c);
    net.run();
    const id = await a.service.createChannel({ name: "team", kind: ChannelKind.Private });
    net.run();
    net.disconnect(a, c); // c knows the channel, but nobody is in reach when it asks

    expect(await c.service.joinChannel(id)).toBe("waiting_for_key");
    net.run();
    expect(info(a, id).joinRequests).toEqual([]);

    net.connect(a, c);
    net.run();
    expect(info(a, id).joinRequests!.map((r) => r.key)).toEqual([keyOf(c)]);
  });

  it("forgets a declined request, including its re-sends", async () => {
    const net = new SimNetwork();
    const [a, c] = await net.addNodes(2);
    net.connect(a, c);
    net.run();
    const id = await a.service.createChannel({ name: "team", kind: ChannelKind.Private });
    net.run();
    await c.service.joinChannel(id);
    net.run();
    a.service.declineJoin(id, keyOf(c));
    net.disconnect(a, c);
    net.connect(a, c); // c re-sends
    net.run();
    expect(info(a, id).joinRequests).toEqual([]);
    expect(memberKeys(a, id)).not.toContain(keyOf(c));
  });
});

describe("invites", () => {
  it("lets someone into a hidden channel straight away, once", async () => {
    const { net, nodes } = await line(3);
    const [a, b, d] = nodes;
    const id = await a.service.createChannel({ name: "quiet", kind: ChannelKind.Hidden });
    a.service.sendText("hello hidden");
    net.run();
    for (const n of [b, d]) expect(n.service.getSnapshot().nearbyChannels).toEqual([]); // never listed

    const text = a.service.createInvite(id);
    expect(text.startsWith("mesh-invite:")).toBe(true);
    expect(await d.service.joinWithInvite(text)).toBe("waiting_for_key");
    net.run();
    expect(info(d, id).myRole).toBe(Role.Member);
    expect(texts(d)).toEqual(["hello hidden"]);

    // A second person with the same invite has to be let in by hand.
    const e = await net.addNode("e");
    net.connect(d, e);
    net.run();
    expect(await e.service.joinWithInvite(text)).toBe("waiting_for_key");
    net.run();
    expect(memberKeys(a, id)).not.toContain(keyOf(e));
    expect(info(a, id).joinRequests!.map((r) => r.key)).toEqual([keyOf(e)]);
  });

  it("only accepts invites made by an admin", async () => {
    const { net, nodes } = await line(3);
    const [a, c, e] = nodes;
    const id = await a.service.createChannel({ name: "team", kind: ChannelKind.Private });
    net.run();
    await c.service.joinChannel(id);
    net.run();
    a.service.approveJoin(id, keyOf(c));
    net.run();

    // c is a plain member: the app refuses, and a hand-made invite isn't honoured.
    expect(() => c.service.createInvite(id)).toThrow();
    const manifest = a.service["registry"].get(id)!; // test-only peek at the signed manifest
    const fake = encodeInvite(createInvite(c.identity, manifest.manifest, manifest.manifestBytes, Date.now()));
    expect(await e.service.joinWithInvite(fake)).toBe("waiting_for_key");
    net.run();
    expect(memberKeys(a, id)).not.toContain(keyOf(e));
    expect(info(a, id).joinRequests!.map((r) => r.key)).toEqual([keyOf(e)]);
  });

  it("rejects garbage and expired invites", async () => {
    const { net, nodes } = await line(2);
    const [a, d] = nodes;
    const id = await a.service.createChannel({ name: "team", kind: ChannelKind.Private });
    net.run();
    expect(await d.service.joinWithInvite("hello")).toBe("invalid_invite");
    const text = a.service.createInvite(id);
    expect(await d.service.joinWithInvite(text.slice(0, -4))).toBe("invalid_invite");
    expect(decodeInvite(` ${text.slice(0, 40)}\n${text.slice(40)} `)).not.toBeNull(); // copy-paste whitespace

    const later = new MeshService({
      transport: { kind: "memory", start: async () => {}, stop: async () => {}, send: () => {} },
      identity: createIdentity(),
      nickname: "late",
      announceIntervalMs: 0,
      now: () => Date.now() + 8 * 24 * 60 * 60_000,
    });
    expect(await later.joinWithInvite(text)).toBe("expired_invite");
  });
});

describe("leaving and key changes", () => {
  it("takes a member who leaves off the list and changes the key", async () => {
    const { net, nodes } = await line(3);
    const [a, b, c] = nodes;
    const id = await a.service.createChannel({ name: "team", kind: ChannelKind.Private });
    net.run();
    for (const n of [b, c]) {
      await n.service.joinChannel(id);
      net.run();
      a.service.approveJoin(id, keyOf(n));
      net.run();
    }
    c.service.leaveChannel(id);
    net.run();
    expect(memberKeys(a, id)).not.toContain(keyOf(c));
    expect(memberKeys(b, id)).not.toContain(keyOf(c));
    expect(a.service.channelEpoch(id)).toBe(1);
    expect(info(b, id).canSend).toBe(true);
  });

  it("changes the key after 24 hours or 500 messages (admins only)", async () => {
    let clock = 10_000_000;
    const { net, nodes } = await line(2, { now: () => clock });
    const [a, b] = nodes;
    const id = await a.service.createChannel({ name: "team", kind: ChannelKind.Private });
    net.run();
    await b.service.joinChannel(id);
    net.run();
    a.service.approveJoin(id, keyOf(b));
    net.run();

    clock += ROTATE_AFTER_MS - 60_000;
    a.service.tickRotations();
    b.service.tickRotations();
    expect(a.service.channelEpoch(id)).toBe(0);
    clock += 31 * 60_000 + 60_000; // past 24 h plus the largest jitter
    b.service.tickRotations(); // not an admin: does nothing
    expect(b.service.channelEpoch(id)).toBe(0);
    a.service.tickRotations();
    net.run();
    expect(a.service.channelEpoch(id)).toBe(1);
    expect(b.service.channelEpoch(id)).toBe(1);

    a.service.setActiveChannel(id);
    for (let i = 0; i < ROTATE_AFTER_MESSAGES + 50; i++) b.service.sendText(`m${i}`);
    net.run();
    a.service.tickRotations();
    net.run();
    expect(a.service.channelEpoch(id)).toBe(2);
    expect(b.service.channelEpoch(id)).toBe(2);
  }, 30_000);

  it("keeps both people when two admins add someone at the same time", async () => {
    const net = new SimNetwork();
    const [a, b, x, y] = await net.addNodes(4);
    net.connect(a, b);
    net.run();
    const id = await a.service.createChannel({ name: "team", kind: ChannelKind.Private });
    net.run();
    await b.service.joinChannel(id);
    net.run();
    a.service.addMember(id, keyOf(b), Role.Admin);
    net.run();

    net.disconnect(a, b);
    net.connect(a, x);
    net.connect(b, y);
    net.run();
    await x.service.joinChannel(id);
    await y.service.joinChannel(id);
    net.run();
    a.service.approveJoin(id, keyOf(x)); // both make version 3
    b.service.approveJoin(id, keyOf(y));
    net.run();

    net.connect(a, b);
    net.run();
    for (const n of [a, b, x, y]) {
      expect(memberKeys(n, id).sort()).toEqual([keyOf(a), keyOf(b), keyOf(x), keyOf(y)].sort());
    }
  });
});

describe("hourly tags", () => {
  it("hides which channel a message is for, and members still read across the hour", async () => {
    let clock = 3 * 60 * 60_000 - 5 * 60_000; // 5 minutes before an hour boundary
    const { net, nodes } = await line(3, { now: () => clock });
    const [a, b, c] = nodes;
    const relayed = tap(b);
    const id = await a.service.createChannel({ name: "team", kind: ChannelKind.Private });
    net.run();
    await c.service.joinChannel(id);
    net.run();
    a.service.approveJoin(id, keyOf(c));
    net.run();

    a.service.sendText("before the hour");
    net.run();
    clock += 10 * 60_000;
    a.service.sendText("after the hour");
    net.run();
    expect(texts(c)).toEqual(["before the hour", "after the hour"]);

    const tags = relayed.filter((p) => p.type === PacketType.Message).map((p) => toHex(p.channelTag!));
    expect(tags).toHaveLength(2);
    expect(tags[0]).not.toBe(tags[1]);
    expect(tags).not.toContain(id);
    for (const p of relayed.filter((x) => x.type === PacketType.Message)) {
      expect(new TextDecoder().decode(p.payload).includes("hour")).toBe(false);
    }
  });

  it("keeps working after a restart (old hourly tags still map to the channel)", async () => {
    let clock = Date.now(); // storage pruning uses the real clock
    const store = new MemoryMeshStore();
    const identity = createIdentity();
    const net = new SimNetwork({ now: () => clock });
    const owner = await net.addNode("owner");
    const me = await net.addNode("me", { store, identity });
    net.connect(owner, me);
    net.run();
    const id = await owner.service.createChannel({ name: "team", kind: ChannelKind.Private });
    net.run();
    await me.service.joinChannel(id);
    net.run();
    owner.service.approveJoin(id, toHex(identity.publicKey));
    owner.service.sendText("hours ago");
    net.run();
    await me.service.stop();
    net.disconnect(owner, me);

    clock += 5 * 60 * 60_000;
    const again = new MeshService({
      transport: me.transport,
      identity,
      nickname: "me",
      store,
      announceIntervalMs: 0,
      now: () => clock,
    });
    await again.start();
    again.setActiveChannel(id);
    expect(again.getSnapshot().messages.map((m) => m.text)).toEqual(["hours ago"]);
  });
});
