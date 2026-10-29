// Internet bridge (step C5): two meshes with no radio path between them, joined through a fake
// of the backend's /mesh-bridge (see fakeBridge.ts).

import { describe, expect, it } from "vitest";
import { toHex } from "../bytes";
import { ChannelKind } from "../channels/manifest";
import { Role } from "../channels/membership";
import { decodePacket } from "../packet";
import { bridgeUrlFrom } from "../transports/BridgeLinkTransport";
import { FakeBridgeHub, gateway } from "./fakeBridge";
import { SimNetwork, type SimNode } from "./sim";

const texts = (n: SimNode) => n.service.getSnapshot().messages.map((m) => m.text);
const keyOf = (n: SimNode) => toHex(n.identity.publicKey);

/** a – g1 ~~internet~~ g2 – b, after everyone met once (g1 – g2 linked by radio). */
async function twoGroups() {
  const net = new SimNetwork();
  const hub = new FakeBridgeHub(net);
  const a = await net.addNode("a");
  const g1 = await net.addNode("g1", {}, gateway(hub, net));
  const g2 = await net.addNode("g2", {}, gateway(hub, net));
  const b = await net.addNode("b");
  net.connect(a, g1);
  net.connect(g1, g2);
  net.connect(g2, b);
  net.run();
  return { net, hub, a, g1, g2, b };
}

describe("internet bridge", () => {
  it("builds the bridge address from the backend URL", () => {
    expect(bridgeUrlFrom("https://192.168.88.3:4000")).toBe("wss://192.168.88.3:4000/mesh-bridge");
    expect(bridgeUrlFrom("http://10.0.2.2:4000/")).toBe("ws://10.0.2.2:4000/mesh-bridge");
    expect(bridgeUrlFrom("not a url")).toBeNull();
  });

  it("joins two groups with no radio path in a bridged public channel", async () => {
    const { net, a, g1, g2, b } = await twoGroups();
    expect(g1.service.getSnapshot().bridge).toBe("up");
    const id = await a.service.createChannel({ name: "city", bridge: true });
    net.run();
    for (const n of [g1, g2, b]) await n.service.joinChannel(id);
    net.run();

    net.disconnect(g1, g2); // the groups move apart
    a.service.sendText("hello from the north");
    net.run();
    expect(texts(b)).toEqual(["hello from the north"]);
    b.service.sendText("hello from the south");
    net.run();
    expect(texts(a)).toEqual(["hello from the north", "hello from the south"]);
  });

  it("keeps channels without the bridge flag (and the Lobby) local", async () => {
    const { net, hub, a, g1, g2, b } = await twoGroups();
    const id = await a.service.createChannel({ name: "local-only" });
    net.run();
    for (const n of [g1, g2, b]) await n.service.joinChannel(id);
    net.run();
    net.disconnect(g1, g2);
    hub.uploads.length = 0;
    a.service.sendText("stays here");
    a.service.setActiveChannel("");
    a.service.sendText("lobby stays here");
    net.run();
    expect(texts(b)).toEqual([]);
    expect(hub.uploads).toEqual([]);
  });

  it("carries a private channel, including a key change, without the server reading it", async () => {
    const { net, hub, a, g1, g2, b } = await twoGroups();
    const id = await a.service.createChannel({ name: "team", kind: ChannelKind.Private, bridge: true });
    net.run();
    for (const n of [g1, g2, b]) {
      await n.service.joinChannel(id);
      net.run();
      a.service.approveJoin(id, keyOf(n));
      net.run();
    }
    net.disconnect(g1, g2);

    a.service.rotateChannelKey(id); // new key: grants and hourly tags cross the bridge
    net.run();
    expect(b.service.channelEpoch(id)).toBe(1);
    hub.uploads.length = 0;
    a.service.sendText("new key, far away");
    net.run();
    expect(texts(b)).toEqual(["new key, far away"]);
    for (const raw of hub.uploads) {
      const p = decodePacket(raw)!;
      expect(new TextDecoder().decode(p.payload).includes("far away")).toBe(false);
    }
  });

  it("lets someone far away join a hidden channel with an invite", async () => {
    const { net, hub, a, g1 } = await twoGroups();
    const id = await a.service.createChannel({ name: "quiet", kind: ChannelKind.Hidden, bridge: true });
    net.run();
    await g1.service.joinChannel(id).catch(() => "unknown"); // hidden: g1 can't see it
    const text = a.service.createInvite(id);
    // g1 is a's gateway: it has to be in the channel to carry it. Let it in by invite too.
    await g1.service.joinWithInvite(text);
    net.run();
    const d = await net.addNode("d", {}, gateway(hub, net)); // far away, with internet
    net.run();
    expect(await d.service.joinWithInvite(a.service.createInvite(id))).toBe("waiting_for_key");
    net.run();
    const info = d.service.getSnapshot().channels.find((c) => c.id === id)!;
    expect(info.myRole).toBe(Role.Member);
    a.service.sendText("welcome, d");
    net.run();
    expect(texts(d)).toEqual(["welcome, d"]);
  });

  it("catches a late gateway up, and the local mesh keeps working when the internet goes", async () => {
    const { net, hub, a, g1, g2, b } = await twoGroups();
    const id = await a.service.createChannel({ name: "city", bridge: true });
    net.run();
    for (const n of [g1, g2, b]) await n.service.joinChannel(id);
    net.run();
    net.disconnect(g1, g2);

    hub.setOnline(false);
    net.run();
    expect(g1.service.getSnapshot().bridge).toBe("offline");
    a.service.sendText("while offline");
    net.run();
    expect(texts(g1)).toEqual(["while offline"]); // the local mesh still works
    expect(texts(b)).toEqual([]);

    hub.setOnline(true);
    net.run();
    expect(g1.service.getSnapshot().bridge).toBe("up");
    a.service.sendText("back online");
    net.run();
    expect(texts(b)).toContain("back online");

    // On reconnecting, the bridge replays what it kept for the subscribed tags; that mustn't
    // show twice. (Catching up on missed packets is tested against the real server in
    // backend/test/meshBridge.test.js.)
    g2.service.refresh();
    hub.setOnline(false);
    net.run();
    hub.setOnline(true);
    net.run();
    expect(texts(b).filter((t) => t === "back online")).toHaveLength(1);
  });
});
