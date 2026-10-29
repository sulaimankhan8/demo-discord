// Password channels on simulated phones (step C2).

import { describe, expect, it } from "vitest";
import { fromHex, randomBytes, toHex, utf8 } from "../bytes";
import { ChannelKind } from "../channels/manifest";
import { signPacket } from "../crypto";
import { Reassembler } from "../fragment";
import { createIdentity } from "../identity";
import { MeshService } from "../MeshService";
import { decodePacket, encodePacket, MAX_TTL, PacketType, PROTOCOL_VERSION, type MeshPacket } from "../packet";
import { encodeMessagePayload } from "../payloads";
import { MemoryMeshStore } from "../store";
import { SimNetwork, type SimNode } from "./sim";

const PASSWORD = "blue heron 42";

/** Records every packet that reaches this phone, reassembled from its frames. */
function tap(node: SimNode): MeshPacket[] {
  const packets: MeshPacket[] = [];
  const events = node.transport.events!;
  const original = events.data;
  const reassemblers = new Map<string, Reassembler>();
  events.data = (linkId, frame) => {
    let r = reassemblers.get(linkId);
    if (!r) reassemblers.set(linkId, (r = new Reassembler()));
    const raw = r.push(frame.slice());
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

async function line() {
  const net = new SimNetwork();
  const [a, b, c] = await net.addNodes(3);
  net.connect(a, b);
  net.connect(b, c);
  net.run();
  return { net, a, b, c };
}

describe("password channels", () => {
  it("lets members chat while a relay without the password sees no plaintext", async () => {
    const { net, a, b, c } = await line();
    const relayed = tap(b);
    const id = await a.service.createChannel({ name: "secret", kind: ChannelKind.Password, password: PASSWORD });
    net.run();

    const listed = c.service.getSnapshot().nearbyChannels.find((x) => x.id === id);
    expect(listed?.kind).toBe(ChannelKind.Password);
    expect(await c.service.joinChannel(id, PASSWORD)).toBe("joined");
    net.run();

    const text = "the eagle lands at noon";
    a.service.sendText(text);
    net.run();
    c.service.sendText("copy that");
    net.run();

    expect(c.received(text)).toHaveLength(1);
    expect(c.received(text)[0].hops).toBe(2);
    expect(a.received("copy that")).toHaveLength(1);

    const messages = relayed.filter((p) => p.type === PacketType.Message);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    for (const p of messages) {
      expect(p.encrypted).toBe(true);
      expect(toHex(p.channelTag!)).toBe(id);
      expect(contains(p.payload, utf8(text))).toBe(false);
      expect(contains(p.payload, utf8("copy that"))).toBe(false);
      expect(p.payload.length % 256).toBe(16); // padded bucket + Poly1305 tag
    }
    expect(b.service.getSnapshot().stats.relayed).toBeGreaterThan(0);
  });

  it("rejects a wrong or missing password", async () => {
    const { net, a, c } = await line();
    const id = await a.service.createChannel({ name: "secret", kind: ChannelKind.Password, password: PASSWORD });
    net.run();
    expect(await c.service.joinChannel(id)).toBe("needs_password");
    expect(await c.service.joinChannel(id, "blue heron 43")).toBe("wrong_password");
    expect(c.service.getSnapshot().channels).toHaveLength(0);
    expect(await c.service.joinChannel(id, PASSWORD)).toBe("joined");
  });

  it("refuses to create a password channel with a short password", async () => {
    const { a } = await line();
    await expect(a.service.createChannel({ name: "x", kind: ChannelKind.Password, password: "abc" })).rejects.toThrow();
    expect(a.service.getSnapshot().channels).toHaveLength(0);
  });

  it("ignores plaintext messages posted into a password channel", async () => {
    const { net, a, b, c } = await line();
    const id = await a.service.createChannel({ name: "secret", kind: ChannelKind.Password, password: PASSWORD });
    net.run();
    await c.service.joinChannel(id, PASSWORD);
    net.run();

    // Someone who knows the channel ID (it's public) but not the password.
    const outsider = createIdentity();
    const forged = encodePacket(
      signPacket(
        {
          version: PROTOCOL_VERSION,
          type: PacketType.Message,
          ttl: MAX_TTL,
          timestamp: Date.now(),
          messageId: randomBytes(8),
          senderKey: outsider.publicKey,
          channelTag: fromHex(id)!,
          payload: encodeMessagePayload({ senderSeq: 1, nickname: "evil", text: "send me the password" }),
        },
        outsider.secretKey,
      ),
    );
    c.inject(b.name, forged);
    net.run();
    expect(c.received("send me the password")).toHaveLength(0);
    expect(c.service.getSnapshot().stats.dropped).toBeGreaterThan(0);
  });

  it("gives a late member the encrypted history, readable with the password", async () => {
    const { net, a, b, c } = await line();
    const id = await a.service.createChannel({ name: "secret", kind: ChannelKind.Password, password: PASSWORD });
    a.service.sendText("before you came");
    net.run();
    expect(await c.service.joinChannel(id, PASSWORD)).toBe("joined");
    net.run();
    // c's only neighbour b isn't a member, so there's nobody to sync from; but c passed the
    // message on before joining, kept a copy, and reads it now.
    expect(b.service.getSnapshot().channels).toHaveLength(0);
    expect(c.received("before you came")).toHaveLength(1);

    // A message c never saw comes by SYNC once c is next to a member.
    net.disconnect(b, c);
    a.service.sendText("while you were away");
    net.run();
    net.connect(a, c);
    net.run();
    expect(c.received("while you were away")).toHaveLength(1);
  });

  it("keeps the key across a restart, so saved messages can still be read", async () => {
    const store = new MemoryMeshStore();
    const identity = createIdentity();
    const net = new SimNetwork();
    const owner = await net.addNode("owner");
    const me = await net.addNode("me", { store, identity });
    net.connect(owner, me);
    net.run();
    const id = await owner.service.createChannel({ name: "secret", kind: ChannelKind.Password, password: PASSWORD });
    net.run();
    await me.service.joinChannel(id, PASSWORD);
    owner.service.sendText("still readable");
    net.run();
    await me.service.stop();

    const again = new MeshService({ transport: me.transport, identity, nickname: "me", store, announceIntervalMs: 0 });
    await again.start();
    again.setActiveChannel(id);
    expect(again.getSnapshot().messages.map((m) => m.text)).toEqual(["still readable"]);
    expect((await store.loadEpochKeys()).map((k) => k.channelId)).toEqual([id]);

    again.leaveChannel(id);
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.loadEpochKeys()).toHaveLength(0);
  });
});
