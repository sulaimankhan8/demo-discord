// Private channels on simulated phones (step C3a): epoch keys, grants, member lists.

import { describe, expect, it } from "vitest";
import { toHex, utf8 } from "../bytes";
import { ChannelKind, HistoryPolicy } from "../channels/manifest";
import { Role } from "../channels/membership";
import { Reassembler } from "../fragment";
import { createIdentity } from "../identity";
import { MeshService } from "../MeshService";
import { decodePacket, PacketType, type MeshPacket } from "../packet";
import { MemoryMeshStore } from "../store";
import { SimNetwork, type SimNode } from "./sim";

const keyOf = (n: SimNode) => toHex(n.identity.publicKey);
const info = (n: SimNode, id: string) => n.service.getSnapshot().channels.find((c) => c.id === id)!;
const texts = (n: SimNode) => n.service.getSnapshot().messages.map((m) => m.text);

/** Records every packet that reaches this phone. */
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

async function privateChannel(net: SimNetwork, owner: SimNode, historyPolicy: HistoryPolicy = HistoryPolicy.Recent) {
  const id = await owner.service.createChannel({ name: "team", kind: ChannelKind.Private, historyPolicy });
  net.run();
  return id;
}

/** `member` joins (seeing it under Nearby first) and `admin` adds it. */
async function addToChannel(net: SimNetwork, id: string, admin: SimNode, member: SimNode, role: Role = Role.Member) {
  expect(await member.service.joinChannel(id)).toBe("waiting_for_key");
  net.run();
  admin.service.addMember(id, keyOf(member), role);
  net.run();
}

describe("private channels", () => {
  it("keeps messages waiting until an admin adds you, then shows them", async () => {
    const net = new SimNetwork();
    const [a, b, c] = await net.addNodes(3);
    net.connect(a, b);
    net.connect(b, c);
    net.run();
    const relayed = tap(b);
    const id = await privateChannel(net, a);

    expect(await c.service.joinChannel(id)).toBe("waiting_for_key");
    a.service.sendText("before you were added");
    net.run();
    // With hourly tags, c can't even tell the message is for this channel until it has a key.
    expect(info(c, id).waitingForKey).toBe(0);
    expect(info(c, id).waitingForApproval).toBe(true);
    expect(info(c, id).canSend).toBe(false);
    expect(texts(c)).toEqual([]);

    a.service.addMember(id, keyOf(c));
    net.run();
    expect(texts(c)).toEqual(["before you were added"]); // fetched again once c had the key
    expect(info(c, id).waitingForApproval).toBe(false);
    expect(info(c, id).waitingForKey).toBe(0);
    expect(info(c, id).canSend).toBe(true);
    expect(info(c, id).myRole).toBe(Role.Member);
    expect(info(c, id).members!.map((m) => m.role)).toEqual([Role.Owner, Role.Member]);

    c.service.sendText("thanks");
    net.run();
    expect(texts(a)).toEqual(["before you were added", "thanks"]);

    // The relay only ever saw ciphertext, and shows nothing.
    for (const p of relayed.filter((x) => x.type === PacketType.Message)) {
      expect(p.encrypted).toBe(true);
      expect(contains(p.payload, utf8("before you were added"))).toBe(false);
      expect(contains(p.payload, utf8("thanks"))).toBe(false);
    }
    expect(b.service.getSnapshot().channels).toHaveLength(0);
  });

  for (const [policy, label, seesOld] of [
    [HistoryPolicy.Recent, "recent", true],
    [HistoryPolicy.Full, "full", true],
    [HistoryPolicy.SinceJoin, "since join", false],
  ] as const) {
    it(`gives a newcomer older epochs' keys only when the policy allows (${label})`, async () => {
      const net = new SimNetwork();
      const [a, b, c] = await net.addNodes(3);
      net.connect(a, b);
      net.connect(a, c);
      net.run();
      const id = await privateChannel(net, a, policy);
      await addToChannel(net, id, a, b);
      a.service.sendText("epoch zero");
      net.run();
      a.service.rotateChannelKey(id);
      a.service.sendText("epoch one");
      net.run();
      expect(a.service.channelEpoch(id)).toBe(1);

      await addToChannel(net, id, a, c);
      a.service.sendText("after joining");
      net.run();
      // "Since join" gets only the current key, and hides anything sent before joining.
      expect(texts(c)).toEqual(seesOld ? ["epoch zero", "epoch one", "after joining"] : ["after joining"]);
      expect(info(c, id).waitingForKey).toBe(0); // "epoch zero" isn't even recognisable without its key
    });
  }

  it("removes a member: they can't read new messages but still relay them", async () => {
    const net = new SimNetwork();
    const [a, c, b] = await net.addNodes(3); // a – c – b: c sits in the middle
    net.connect(a, c);
    net.connect(c, b);
    net.run();
    const id = await privateChannel(net, a);
    await addToChannel(net, id, a, c);
    await addToChannel(net, id, a, b);
    a.service.sendText("everyone");
    net.run();
    expect(texts(b)).toEqual(["everyone"]);

    a.service.removeMember(id, keyOf(c));
    net.run();
    expect(a.service.channelEpoch(id)).toBe(1);
    expect(info(c, id).canSend).toBe(false);
    expect(info(c, id).myRole).toBeUndefined();

    a.service.sendText("after c left");
    net.run();
    expect(texts(b)).toEqual(["everyone", "after c left"]); // went through c
    expect(texts(c)).toEqual(["everyone"]);
    // c can't recognise new-key messages at all (their hourly tags come from the new key).
    expect(info(c, id).waitingForKey).toBe(0);
  });

  it("converges after a split where one side changed the key", async () => {
    const net = new SimNetwork();
    const [a, b, c, d] = await net.addNodes(4);
    net.connect(a, b);
    net.connect(b, c);
    net.connect(c, d);
    net.run();
    const id = await privateChannel(net, a);
    await addToChannel(net, id, a, b, Role.Admin);
    await addToChannel(net, id, a, c);
    await addToChannel(net, id, a, d);

    net.disconnect(b, c); // {a, b} | {c, d}
    a.service.rotateChannelKey(id);
    a.service.sendText("side one, new key");
    c.service.sendText("side two, old key");
    net.run();
    expect(texts(d)).toEqual(["side two, old key"]);
    expect(info(d, id).waitingForKey).toBe(0); // d never saw the new-key message yet

    net.connect(b, c);
    net.run();
    for (const n of [a, b, c, d]) {
      expect(n.service.channelEpoch(id)).toBe(1);
      expect(texts(n).sort()).toEqual(["side one, new key", "side two, old key"]);
      expect(info(n, id).canSend).toBe(true);
    }
  });

  it("settles on one key when two admins change it at the same time", async () => {
    const net = new SimNetwork();
    const [a, b, c, d] = await net.addNodes(4);
    net.connect(a, c);
    net.connect(c, b);
    net.connect(b, d);
    net.run();
    const id = await privateChannel(net, a);
    await addToChannel(net, id, a, b, Role.Admin);
    await addToChannel(net, id, a, c);
    await addToChannel(net, id, a, d);

    net.disconnect(c, b); // {a, c} | {b, d}
    a.service.rotateChannelKey(id);
    b.service.rotateChannelKey(id);
    a.service.sendText("from a's key");
    d.service.sendText("from b's key");
    net.run();

    net.connect(c, b);
    net.run();
    for (const n of [a, b, c, d]) {
      expect(n.service.channelEpoch(id)).toBe(1);
      expect(texts(n).sort()).toEqual(["from a's key", "from b's key"]);
    }
    // Everyone sends with the same winning key now.
    c.service.sendText("after the merge");
    net.run();
    for (const n of [a, b, d]) expect(texts(n)).toContain("after the merge");
  });

  it("ignores a member list from a plain member, and replays of old lists", async () => {
    let clock = 10_000_000;
    const net = new SimNetwork({ now: () => clock });
    const [a, b, c] = await net.addNodes(3);
    net.connect(a, b);
    net.connect(b, c);
    net.run();
    const id = await privateChannel(net, a);
    const control = tap(b);
    await addToChannel(net, id, a, b);
    await addToChannel(net, id, a, c);

    // c (a plain member) can't change the list: not through the app...
    expect(() => c.service.addMember(id, toHex(createIdentity().publicKey))).toThrow();
    // ...nor by signing a list packet itself.
    const { encodeMembers } = await import("../channels/membership");
    const { signPacket } = await import("../crypto");
    const { encodePacket: enc, MAX_TTL, PROTOCOL_VERSION } = await import("../packet");
    const { fromHex, randomBytes } = await import("../bytes");
    const intruder = toHex(createIdentity().publicKey);
    const forged = signPacket(
      {
        version: PROTOCOL_VERSION,
        type: PacketType.Members,
        ttl: MAX_TTL,
        timestamp: clock,
        messageId: randomBytes(8),
        senderKey: c.identity.publicKey,
        channelTag: fromHex(id)!,
        payload: encodeMembers({
          channelId: fromHex(id)!,
          epoch: 0,
          version: 99,
          members: [
            { key: keyOf(a), role: Role.Owner, joinedEpoch: 0 },
            { key: keyOf(c), role: Role.Admin, joinedEpoch: 0 },
            { key: intruder, role: Role.Member, joinedEpoch: 0 },
          ],
        }),
      },
      c.identity.secretKey,
    );
    b.inject(c.name, enc(forged));
    net.run();
    expect(info(b, id).members!.map((m) => m.key)).not.toContain(intruder);
    expect(info(a, id).members!.find((m) => m.key === keyOf(c))?.role).toBe(Role.Member);

    // Capture the list that had c in it, remove c, then replay the old list 20 minutes later
    // (after the duplicate filter has forgotten it).
    const withC = control.filter((p) => p.type === PacketType.Members).at(-1)!;
    a.service.removeMember(id, keyOf(c));
    net.run();
    expect(info(b, id).members!.map((m) => m.key)).not.toContain(keyOf(c));
    clock += 20 * 60_000;
    const { encodePacket } = await import("../packet");
    b.inject(a.name, encodePacket(withC));
    net.run();
    expect(info(b, id).members!.map((m) => m.key)).not.toContain(keyOf(c));
  });

  it("lets a newcomer check a list made by an admin while the owner is away", async () => {
    const net = new SimNetwork();
    const [owner, admin, newcomer] = await net.addNodes(3);
    net.connect(owner, admin);
    net.run();
    const id = await privateChannel(net, owner);
    await addToChannel(net, id, owner, admin, Role.Admin);
    owner.service.sendText("from the owner");
    net.run();
    await owner.service.stop();
    net.disconnect(owner, admin);

    net.connect(admin, newcomer);
    net.run();
    await addToChannel(net, id, admin, newcomer);
    expect(info(newcomer, id).myRole).toBe(Role.Member);
    expect(texts(newcomer)).toEqual(["from the owner"]);
    newcomer.service.sendText("hi admin");
    net.run();
    expect(texts(admin)).toContain("hi admin");
  });

  it("keeps keys and members across a restart", async () => {
    const store = new MemoryMeshStore();
    const identity = createIdentity();
    const net = new SimNetwork();
    const owner = await net.addNode("owner");
    const me = await net.addNode("me", { store, identity });
    net.connect(owner, me);
    net.run();
    const id = await privateChannel(net, owner);
    await addToChannel(net, id, owner, me);
    owner.service.rotateChannelKey(id);
    owner.service.sendText("saved");
    net.run();
    await me.service.stop();
    net.disconnect(owner, me);

    const again = new MeshService({ transport: me.transport, identity, nickname: "me", store, announceIntervalMs: 0 });
    await again.start();
    again.setActiveChannel(id);
    const snap = again.getSnapshot();
    expect(snap.messages.map((m) => m.text)).toEqual(["saved"]);
    expect(snap.activeChannel?.canSend).toBe(true);
    expect(snap.activeChannel?.members).toHaveLength(2);
    expect(again.channelEpoch(id)).toBe(1);
  });
});
