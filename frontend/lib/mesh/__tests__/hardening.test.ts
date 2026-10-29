// Hardening (step C7): fuzzing every decoder, the key vault, power modes, low-battery relaying,
// the native-capability check and the per-sender limit on waiting control packets.

import { describe, expect, it } from "vitest";
import { randomBytes, toHex, utf8 } from "../bytes";
import { decodeInvite, decodeJoinRequest, encodeInvite, createInvite, encodeJoinRequest } from "../channels/invites";
import { ChannelKind, createManifest, decodeManifest, encodeManifest } from "../channels/manifest";
import {
  decodeEpochChange,
  decodeGrant,
  decodeMembers,
  encodeEpochChange,
  encodeGrant,
  encodeMembers,
  EpochReason,
  Role,
} from "../channels/membership";
import { signPacket, verifyPacket } from "../crypto";
import { pad, unpad } from "../crypto/padding";
import { openSealed, seal } from "../crypto/sealed";
import { openDirect, sealDirect } from "../dm/directCrypto";
import { Reassembler } from "../fragment";
import { createIdentity, loadIdentity } from "../identity";
import { decodePacket, encodePacket, MAX_TTL, PacketType, PROTOCOL_VERSION } from "../packet";
import { decodeAnnouncePayload, decodeMessagePayload, decodeSyncPayload, encodeMessagePayload, encodeSyncPayload } from "../payloads";
import { BloomFilter } from "../bloom";
import { pickPowerMode, PowerController, type PowerMode } from "../power";
import { MeshRouter } from "../router";
import { MemoryMeshStore } from "../store";
import { BleLinkTransport, type BleMeshPlugin } from "../transports/BleLinkTransport";
import { KeyVault, SealedMeshStore } from "../vault";
import { prng, SimNetwork } from "./sim";

/* ---------------- fuzzing ---------------- */

function mutations(sample: Uint8Array, rand: () => number, count: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const kind = Math.floor(rand() * 6);
    const b = sample.slice();
    if (kind === 0) b[Math.floor(rand() * b.length)] ^= 1 << Math.floor(rand() * 8); // bit flip
    else if (kind === 1) {
      for (let k = 0; k < 4; k++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
    } else if (kind === 2) out.push(b.slice(0, Math.floor(rand() * b.length))); // truncated
    else if (kind === 3) out.push(new Uint8Array([...b, ...Array.from({ length: 1 + Math.floor(rand() * 20) }, () => Math.floor(rand() * 256))]));
    else if (kind === 4) out.push(Uint8Array.from({ length: Math.floor(rand() * 300) }, () => Math.floor(rand() * 256)));
    else b[Math.floor(rand() * Math.min(b.length, 8))] = Math.floor(rand() * 256); // header bytes
    if (kind !== 2 && kind !== 3 && kind !== 4) out.push(b);
  }
  return out;
}

describe("fuzzing", () => {
  const rand = prng(1234);
  const id = createIdentity();
  const other = createIdentity();
  const channelId = randomBytes(16);
  const manifest = createManifest(id, { name: "fuzz", kind: ChannelKind.Private });
  const manifestBytes = encodeManifest(manifest);
  const packet = encodePacket(
    signPacket(
      {
        version: PROTOCOL_VERSION,
        type: PacketType.Message,
        ttl: MAX_TTL,
        timestamp: Date.now(),
        messageId: randomBytes(8),
        senderKey: id.publicKey,
        channelTag: randomBytes(16),
        recipientId: randomBytes(8),
        payload: encodeMessagePayload({ senderSeq: 3, nickname: "fz", text: "fuzz me" }),
      },
      id.secretKey,
    ),
  );
  const bloom = BloomFilter.forCount(20, 7);

  const decoders: [string, Uint8Array, (b: Uint8Array) => unknown][] = [
    ["packet", packet, decodePacket],
    ["message", encodeMessagePayload({ senderSeq: 1, nickname: "a", text: "b" }), decodeMessagePayload],
    ["announce", utf8("nick"), decodeAnnouncePayload],
    ["sync", encodeSyncPayload({ wants: [randomBytes(16)], bloom }), decodeSyncPayload],
    ["manifest", manifestBytes, decodeManifest],
    [
      "members",
      encodeMembers({ channelId, epoch: 1, version: 2, members: [{ key: toHex(id.publicKey), role: Role.Owner, joinedEpoch: 0 }] }),
      decodeMembers,
    ],
    [
      "epoch change",
      encodeEpochChange({ channelId, newEpoch: 2, prevChangeHash: randomBytes(8), reason: EpochReason.Removed, removed: [toHex(other.publicKey)] }),
      decodeEpochChange,
    ],
    ["grant", encodeGrant({ channelId, entries: [{ epoch: 1, changeHash: randomBytes(8), sealedKey: randomBytes(80) }] }), decodeGrant],
    ["join request", encodeJoinRequest({ channelId, note: "hi" }), decodeJoinRequest],
    ["padding", pad(utf8("x")), unpad],
    ["sealed box", seal(id.publicKey, randomBytes(32)), (b) => openSealed(id, b)],
    ["DM", sealDirect(other, id.publicKey, randomBytes(8), { senderSeq: 1, nickname: "o", text: "t" }), (b) => openDirect(id, other.publicKey, randomBytes(8), b)],
  ];

  // Opening sealed boxes costs an X25519 operation each, so those get fewer rounds.
  const slow = new Set(["sealed box", "DM"]);
  for (const [name, sample, decode] of decoders) {
    const rounds = slow.has(name) ? 500 : 2000;
    it(`${name}: never throws on ${rounds} mutated or random inputs`, () => {
      for (const input of mutations(sample, rand, rounds)) expect(() => decode(input)).not.toThrow();
    }, 30_000);
  }

  it("invite text: never throws on garbage", () => {
    const text = encodeInvite(createInvite(id, manifest, manifestBytes, Date.now()));
    for (let i = 0; i < 2000; i++) {
      const chars = text.split("");
      chars[Math.floor(rand() * chars.length)] = String.fromCharCode(32 + Math.floor(rand() * 95));
      const variant = rand() < 0.3 ? chars.join("").slice(0, Math.floor(rand() * text.length)) : chars.join("");
      expect(() => decodeInvite(variant)).not.toThrow();
    }
  });

  it("a changed packet never passes the signature check (apart from the unsigned ttl)", () => {
    for (const input of mutations(packet, rand, 3000)) {
      const p = decodePacket(input);
      if (!p || !verifyPacket(p)) continue;
      const a = input.slice();
      const b = packet.slice();
      a[2] = 0;
      b[2] = 0;
      expect(toHex(a)).toBe(toHex(b));
    }
  });

  it("the router and the frame reassembler survive garbage from a neighbour", () => {
    const router = new MeshRouter({ identity: createIdentity(), nickname: "x", links: () => ["a", "b"], send: () => {}, schedule: (fn) => fn() });
    const re = new Reassembler();
    for (const input of mutations(packet, rand, 3000)) {
      expect(() => router.handleIncoming("a", input)).not.toThrow();
      expect(() => re.push(input)).not.toThrow();
    }
    expect(router.stats.received).toBeLessThan(50); // almost everything rejected
  });
});

/* ---------------- key vault ---------------- */

describe("key vault", () => {
  const vault = new KeyVault(randomBytes(32));

  it("seals and opens, and a different key can't open it", () => {
    const secret = randomBytes(32);
    const sealed = vault.seal(secret);
    expect(vault.open(sealed)).toEqual(secret);
    expect(new KeyVault(randomBytes(32)).open(sealed)).toBeNull();
    sealed[30] ^= 1;
    expect(vault.open(sealed)).toBeNull();
  });

  it("keeps channel keys and my DM text sealed at rest", async () => {
    const inner = new MemoryMeshStore();
    const store = new SealedMeshStore(inner, vault);
    const key = randomBytes(32);
    await store.saveEpochKey({ channelId: "c", epoch: 0, key, from: "password", receivedAt: 1, alternates: [{ changeHash: "aa", key: randomBytes(32) }] });
    await store.save({ id: "m", raw: new Uint8Array(), channelTag: "dm:x", timestamp: 1, receivedAt: 1, hops: 0, mine: true, plain: { nickname: "me", text: "secret words" } });

    const raw = await inner.loadEpochKeys();
    expect(raw[0].sealed).toBe(true);
    expect(toHex(raw[0].key)).not.toContain(toHex(key));
    const rawMsg = (await inner.load())[0];
    expect(rawMsg.plain).toBeUndefined();
    expect(new TextDecoder().decode(rawMsg.plainSealed!)).not.toContain("secret words");

    expect((await store.loadEpochKeys())[0].key).toEqual(key);
    expect((await store.load())[0].plain).toEqual({ nickname: "me", text: "secret words" });
    // After a wipe of the device key, nothing opens.
    const lost = new SealedMeshStore(inner, new KeyVault(randomBytes(32)));
    expect(await lost.loadEpochKeys()).toEqual([]);
    expect((await lost.load())[0].plain).toBeUndefined();
  });

  it("seals the identity, upgrades an unsealed one, and starts over if the key is gone", () => {
    const storage = new Map<string, string>();
    const s = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) } as unknown as Storage;
    const plain = loadIdentity(s, "id"); // the old, unsealed way
    expect(storage.get("id")).toBe(toHex(plain.secretKey));
    const sealedLoad = loadIdentity(s, "id", vault); // same identity, now sealed
    expect(sealedLoad.fingerprint).toBe(plain.fingerprint);
    expect(storage.get("id")!.startsWith("sealed:")).toBe(true);
    expect(loadIdentity(s, "id", vault).fingerprint).toBe(plain.fingerprint);
    expect(loadIdentity(s, "id", new KeyVault(randomBytes(32))).fingerprint).not.toBe(plain.fingerprint);
  });
});

/* ---------------- power ---------------- */

describe("power modes", () => {
  it("picks the mode from visibility and battery", () => {
    expect(pickPowerMode(true, null)).toBe("foreground");
    expect(pickPowerMode(false, null)).toBe("background");
    expect(pickPowerMode(true, { level: 0.15, charging: false })).toBe("low");
    expect(pickPowerMode(true, { level: 0.15, charging: true })).toBe("foreground");
    expect(pickPowerMode(false, { level: 0.5, charging: false })).toBe("background");
  });

  it("applies a mode only when it changes", async () => {
    let visible = true;
    let level = 0.9;
    let onVisibility = () => {};
    const applied: PowerMode[] = [];
    const pc = new PowerController({
      apply: (m) => applied.push(m),
      readBattery: async () => ({ level, charging: false }),
      isVisible: () => visible,
      watchVisibility: (cb) => ((onVisibility = cb), () => {}),
      setTimer: () => () => {},
    });
    await pc.start();
    visible = false;
    onVisibility();
    onVisibility();
    level = 0.1;
    await pc.refreshBattery();
    visible = true;
    onVisibility();
    expect(applied).toEqual(["foreground", "background", "low"]);
  });

  it("on low battery, stops carrying other people's channels but keeps its own", async () => {
    const net = new SimNetwork();
    const [a, b, c] = await net.addNodes(3);
    net.connect(a, b);
    net.connect(b, c);
    net.run();
    const theirs = await a.service.createChannel({ name: "theirs" });
    const ours = await a.service.createChannel({ name: "ours" });
    net.run();
    await c.service.joinChannel(theirs);
    await c.service.joinChannel(ours);
    await b.service.joinChannel(ours);
    net.run();

    b.service.setPowerMode("low");
    a.service.setActiveChannel(theirs);
    a.service.sendText("not b's channel");
    a.service.setActiveChannel(ours);
    a.service.sendText("b's channel too");
    net.run();
    c.service.setActiveChannel(theirs);
    expect(c.received("not b's channel")).toHaveLength(0);
    c.service.setActiveChannel(ours);
    expect(c.received("b's channel too")).toHaveLength(1);
    expect(b.service["router"].carrier.size).toBe(0);
    expect(b.service.getSnapshot().power).toBe("low");
  });
});

/* ---------------- native capabilities ---------------- */

describe("native capability check", () => {
  function fakePlugin(extra: Partial<BleMeshPlugin>): BleMeshPlugin {
    const notImplemented = () => Promise.reject(Object.assign(new Error("not implemented"), { code: "UNIMPLEMENTED" }));
    return {
      ensurePermissions: async () => ({ granted: true }),
      start: async () => {},
      stop: async () => {},
      send: async () => ({ queued: true }),
      getState: notImplemented,
      enableBluetooth: async () => {},
      addListener: (async () => ({ remove: async () => {} })) as BleMeshPlugin["addListener"],
      getCapabilities: notImplemented,
      setPowerMode: notImplemented,
      getBattery: notImplemented,
      getStorageKey: notImplemented,
      deleteStorageKey: notImplemented,
      ...extra,
    } as BleMeshPlugin;
  }

  it("does nothing extra with an older native build", async () => {
    let calls = 0;
    const t = new BleLinkTransport(fakePlugin({ setPowerMode: async () => void calls++ }));
    await t.setPowerMode("low", 3);
    expect(calls).toBe(0);
    expect(await t.storageKey()).toBeNull();
    expect(await t.readBattery()).toBeNull();
  });

  it("uses the new methods when the build says it has them", async () => {
    const modes: string[] = [];
    const key = randomBytes(32);
    const t = new BleLinkTransport(
      fakePlugin({
        getCapabilities: async () => ({ power: true, battery: true, storageKey: true }),
        setPowerMode: async (o) => void modes.push(`${o.mode}/${o.maxLinks}`),
        getBattery: async () => ({ level: 0.4, charging: true }),
        getStorageKey: async () => ({ key: btoa(String.fromCharCode(...key)) }),
      }),
    );
    await t.setPowerMode("low", 3);
    expect(modes).toEqual(["low/3"]);
    expect(await t.readBattery()).toEqual({ level: 0.4, charging: true });
    expect(await t.storageKey()).toEqual(key);
  });
});

/* ---------------- control-packet queue ---------------- */

describe("waiting control packets", () => {
  it("limits how many one sender can park in the queue", async () => {
    const net = new SimNetwork();
    const [a, b] = await net.addNodes(2);
    net.connect(a, b);
    net.run();
    const id = await a.service.createChannel({ name: "team", kind: ChannelKind.Private });
    net.run();
    await b.service.joinChannel(id);
    net.run();
    a.service.approveJoin(id, toHex(b.identity.publicKey));
    net.run();

    // A stranger floods MEMBERS packets that can't be checked (they'd sit waiting).
    const stranger = createIdentity();
    const { fromHex } = await import("../bytes");
    for (let v = 10; v < 40; v++) {
      const forged = signPacket(
        {
          version: PROTOCOL_VERSION,
          type: PacketType.Members,
          ttl: MAX_TTL,
          timestamp: Date.now(),
          messageId: randomBytes(8),
          senderKey: stranger.publicKey,
          channelTag: fromHex(id)!,
          payload: encodeMembers({
            channelId: fromHex(id)!,
            epoch: 0,
            version: v,
            members: [{ key: toHex(a.identity.publicKey), role: Role.Owner, joinedEpoch: 0 }],
          }),
        },
        stranger.secretKey,
      );
      b.inject(a.name, encodePacket(forged));
    }
    net.run();
    expect(b.service["security"].pendingCount).toBeLessThanOrEqual(8);
  });
});
