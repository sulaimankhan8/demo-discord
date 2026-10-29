// Channels on simulated phones (step C1): discovery, joining, per-channel delivery, history sync.

import { describe, expect, it } from "vitest";
import { HistoryPolicy } from "../channels/manifest";
import { createIdentity } from "../identity";
import { LOBBY_TAG, MeshService } from "../MeshService";
import { MemoryMeshStore } from "../store";
import { prng, SimNetwork, type SimNode } from "./sim";

/** Every message with this text this phone has, in any channel or the Lobby. */
function seenAnywhere(node: SimNode, text: string): number {
  const s = node.service;
  const active = s.getSnapshot().activeChannelId;
  let n = 0;
  for (const id of [LOBBY_TAG, ...s.getSnapshot().channels.map((c) => c.id)]) {
    s.setActiveChannel(id);
    n += node.received(text).length;
  }
  s.setActiveChannel(active);
  return n;
}

function randomMesh(n: SimNode[], net: SimNetwork, seed: number) {
  const rand = prng(seed);
  for (let i = 1; i < n.length; i++) net.connect(n[i], n[Math.floor(rand() * i)]);
  for (let k = 0; k < 15; k++) {
    const a = n[Math.floor(rand() * n.length)];
    const b = n[Math.floor(rand() * n.length)];
    if (a !== b && !net.connected(a.name, b.name)) net.connect(a, b);
  }
  net.run();
}

describe("channels", () => {
  it("shows a new channel under Nearby on every phone, and joining opens it", async () => {
    const net = new SimNetwork();
    const [a, b, c] = await net.addNodes(3);
    net.connect(a, b);
    net.connect(b, c);
    net.run();

    const id = await a.service.createChannel({ name: "test" });
    net.run();
    expect(a.service.getSnapshot().activeChannel?.name).toBe("test");
    expect(a.service.getSnapshot().activeChannel?.role).toBe("owner");

    const nearby = c.service.getSnapshot().nearbyChannels;
    expect(nearby.map((x) => x.name)).toEqual(["test"]);
    expect(nearby[0].hops).toBe(2);

    expect(await c.service.joinChannel(id)).toBe("joined");
    expect(c.service.getSnapshot().activeChannelId).toBe(id);
    expect(c.service.getSnapshot().nearbyChannels).toHaveLength(0);
  });

  it("delivers a channel message to every member exactly once; non-members only relay", async () => {
    const net = new SimNetwork({ random: prng(7) });
    const n = await net.addNodes(20);
    randomMesh(n, net, 42);

    const id = await n[0].service.createChannel({ name: "a" });
    net.run();
    const members = [n[0], n[3], n[5], n[8], n[11], n[14], n[17], n[19]];
    for (const m of members.slice(1)) expect(await m.service.joinChannel(id)).toBe("joined");
    net.run();
    const others = n.filter((x) => !members.includes(x));
    const relayedBefore = others.reduce((s, x) => s + x.service.getSnapshot().stats.relayed, 0);

    n[5].service.sendText("only for #a");
    net.run();

    for (const m of members) expect(m.received("only for #a")).toHaveLength(1);
    for (const o of others) expect(seenAnywhere(o, "only for #a")).toBe(0);
    const relayedAfter = others.reduce((s, x) => s + x.service.getSnapshot().stats.relayed, 0);
    expect(relayedAfter).toBeGreaterThan(relayedBefore);
  });

  it("keeps two channels apart", async () => {
    const net = new SimNetwork();
    const [a, b] = await net.addNodes(2);
    net.connect(a, b);
    net.run();
    const one = await a.service.createChannel({ name: "one" });
    const two = await a.service.createChannel({ name: "two" });
    net.run();
    await b.service.joinChannel(one);
    await b.service.joinChannel(two);

    a.service.setActiveChannel(one);
    a.service.sendText("in one");
    a.service.setActiveChannel(two);
    a.service.sendText("in two");
    a.service.setActiveChannel(LOBBY_TAG);
    a.service.sendText("in lobby");
    net.run();

    b.service.setActiveChannel(one);
    expect(b.service.getSnapshot().messages.map((m) => m.text)).toEqual(["in one"]);
    b.service.setActiveChannel(two);
    expect(b.service.getSnapshot().messages.map((m) => m.text)).toEqual(["in two"]);
    b.service.setActiveChannel(LOBBY_TAG);
    expect(b.service.getSnapshot().messages.map((m) => m.text)).toEqual(["in lobby"]);
  });

  it("counts unread messages in channels that aren't open", async () => {
    const net = new SimNetwork();
    const [a, b] = await net.addNodes(2);
    net.connect(a, b);
    net.run();
    const id = await a.service.createChannel({ name: "busy" });
    net.run();
    await b.service.joinChannel(id);
    b.service.setActiveChannel(LOBBY_TAG);
    a.service.sendText("1");
    a.service.sendText("2");
    net.run();
    expect(b.service.getSnapshot().channels[0].unread).toBe(2);
    b.service.setActiveChannel(id);
    expect(b.service.getSnapshot().channels[0].unread).toBe(0);
  });

  it("gives a late joiner the history from another member while the owner is gone", async () => {
    const net = new SimNetwork();
    const [owner, member, late] = await net.addNodes(3);
    net.connect(owner, member);
    net.run();
    const id = await owner.service.createChannel({ name: "history" });
    net.run();
    await member.service.joinChannel(id);
    owner.service.sendText("first");
    owner.service.sendText("second");
    net.run();
    await owner.service.stop();
    net.disconnect(owner, member);

    net.connect(member, late);
    net.run();
    // The member lists its channels to the new neighbour, so it shows under Nearby at once.
    expect(late.service.getSnapshot().nearbyChannels.map((c) => c.id)).toEqual([id]);
    await late.service.joinChannel(id);
    net.run();
    expect(late.service.getSnapshot().messages.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("still gives a phone the messages it relayed before joining", async () => {
    const net = new SimNetwork();
    const [a, b, c] = await net.addNodes(3);
    net.connect(a, b);
    net.connect(b, c);
    net.run();
    const id = await a.service.createChannel({ name: "passing" });
    net.run();
    await c.service.joinChannel(id);
    c.service.sendText("relayed by b");
    net.run();
    expect(b.service.getSnapshot().stats.relayed).toBeGreaterThan(0);

    await b.service.joinChannel(id);
    net.run();
    expect(b.received("relayed by b")).toHaveLength(1);
    expect(a.received("relayed by b")).toHaveLength(1); // and nobody got it twice
  });

  it("hides older messages from new members when the channel says 'since join'", async () => {
    let clock = 10_000_000;
    const net = new SimNetwork({ now: () => clock });
    const [a, b] = await net.addNodes(2);
    net.connect(a, b);
    net.run();
    const id = await a.service.createChannel({ name: "fresh", historyPolicy: HistoryPolicy.SinceJoin });
    a.service.sendText("before");
    net.run();
    clock += 60_000;
    await b.service.joinChannel(id);
    net.run();
    clock += 60_000;
    a.service.sendText("after");
    net.run();
    expect(b.service.getSnapshot().messages.map((m) => m.text)).toEqual(["after"]);
  });

  it("stops delivering a channel after leaving it", async () => {
    const net = new SimNetwork();
    const [a, b] = await net.addNodes(2);
    net.connect(a, b);
    net.run();
    const id = await a.service.createChannel({ name: "bye" });
    net.run();
    await b.service.joinChannel(id);
    b.service.leaveChannel(id);
    expect(b.service.getSnapshot().activeChannelId).toBe(LOBBY_TAG);
    expect(b.service.getSnapshot().nearbyChannels.map((c) => c.id)).toEqual([id]);
    a.service.sendText("after you left");
    net.run();
    expect(seenAnywhere(b, "after you left")).toBe(0);
  });

  it("keeps channels and history across a restart, without duplicates", async () => {
    const store = new MemoryMeshStore();
    const identity = createIdentity();
    const net = new SimNetwork();
    const friend = await net.addNode("friend");
    const me = await net.addNode("me", { store, identity });
    net.connect(me, friend);
    net.run();
    const id = await me.service.createChannel({ name: "kept" });
    me.service.sendText("remember me");
    net.run();
    await me.service.stop();
    net.disconnect(me, friend);

    const again = new MeshService({ transport: me.transport, identity, nickname: "me", store, announceIntervalMs: 0 });
    await again.start();
    // Hearing the channel announced again doesn't add a second copy.
    await again.joinChannel(id);
    const snap = again.getSnapshot();
    expect(snap.channels.map((c) => c.name)).toEqual(["kept"]);
    again.setActiveChannel(id);
    expect(again.getSnapshot().messages.map((m) => m.text)).toEqual(["remember me"]);
  });
});

describe("channel announces", () => {
  it("stay at about one per channel per minute, however many members there are", async () => {
    let clock = 10_000_000;
    const net = new SimNetwork({ now: () => clock, random: prng(3) });
    const n = await net.addNodes(20);
    randomMesh(n, net, 5);
    const id = await n[0].service.createChannel({ name: "busy" });
    net.run();
    for (const node of n.slice(1)) await node.service.joinChannel(id);
    net.run();

    const sentBefore = n.reduce((s, x) => s + x.service.channelAnnouncesSent, 0);
    const minutes = 20;
    // 200 ms steps (roughly how long an announce takes to cross a few hops). Each phone checks
    // its timer once a second, at its own offset, like real phones started at different times.
    for (let step = 0; step < (minutes * 60_000) / 200; step++) {
      clock += 200;
      n.forEach((node, i) => step % 5 === i % 5 && node.service.tickChannelAnnounces());
      net.run();
    }
    const sent = n.reduce((s, x) => s + x.service.channelAnnouncesSent, 0) - sentBefore;
    // Without suppression this would be ~20 members × 20 minutes ≈ 300+.
    expect(sent).toBeGreaterThanOrEqual(minutes * 0.6);
    expect(sent).toBeLessThanOrEqual(minutes * 1.5);
    // Every phone still sees the channel the whole time.
    for (const node of n) expect(node.service.getSnapshot().channels.map((c) => c.id)).toEqual([id]);
  }, 30_000); // simulates 20 minutes on 20 phones

  it("let non-members keep a channel under Nearby", async () => {
    let clock = 10_000_000;
    const net = new SimNetwork({ now: () => clock, random: prng(9) });
    const [owner, relay, outsider] = await net.addNodes(3);
    net.connect(owner, relay);
    net.connect(relay, outsider);
    net.run();
    await owner.service.createChannel({ name: "seen" });
    net.run();
    for (let t = 0; t < 24; t++) {
      clock += 5_000;
      owner.service.tickChannelAnnounces();
      net.run();
    }
    // 2 minutes later it's still listed, because the owner kept announcing it.
    expect(outsider.service.getSnapshot().nearbyChannels.map((c) => c.name)).toEqual(["seen"]);
  });
});

describe("SYNC v2", () => {
  it("only sends what the other phone is missing", async () => {
    const net = new SimNetwork({ random: prng(11) });
    const [a, b] = await net.addNodes(2);
    net.connect(a, b);
    net.run();
    for (let i = 0; i < 5; i++) a.service.sendText(`shared ${i}`);
    net.run();
    net.disconnect(a, b);

    a.service.sendText("missed 1");
    a.service.sendText("missed 2");
    const dupBefore = b.service.getSnapshot().stats.duplicates;
    const recvBefore = b.service.getSnapshot().stats.received;

    net.connect(a, b);
    net.run();
    const s = b.service.getSnapshot();
    expect(b.received("missed 1")).toHaveLength(1);
    expect(b.received("missed 2")).toHaveLength(1);
    expect(s.messages).toHaveLength(7);
    expect(s.stats.duplicates - dupBefore).toBe(0); // none of the 5 shared ones were resent
    // 2 missed messages + hello + sync from a.
    expect(s.stats.received - recvBefore).toBe(4);
  });
});
