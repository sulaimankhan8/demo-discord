import { describe, expect, it } from "vitest";
import { randomBytes } from "../bytes";
import { BloomFilter } from "../bloom";
import {
  ChannelKind,
  channelIdOf,
  cleanChannelName,
  createManifest,
  decodeManifest,
  encodeManifest,
  HistoryPolicy,
  manifestId,
  verifyManifest,
} from "../channels/manifest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createIdentity } from "../identity";
import { decodeSyncPayload, encodeSyncPayload, LOBBY_WANT_TAG } from "../payloads";

const owner = createIdentity();

describe("channel manifest", () => {
  it("round-trips and verifies", () => {
    const m = createManifest(owner, {
      name: "Team North",
      description: "  Meet at the gate  ",
      kind: ChannelKind.Public,
      historyPolicy: HistoryPolicy.SinceJoin,
      retentionHours: 72,
    });
    const decoded = decodeManifest(encodeManifest(m))!;
    expect(decoded.name).toBe("team-north");
    expect(decoded.description).toBe("Meet at the gate");
    expect(decoded.historyPolicy).toBe(HistoryPolicy.SinceJoin);
    expect(decoded.retentionHours).toBe(72);
    expect(manifestId(decoded)).toBe(manifestId(m));
    expect(verifyManifest(decoded, channelIdOf(owner.publicKey, m.nonce))).toBe(true);
  });

  it("rejects a tampered manifest", () => {
    const bytes = encodeManifest(createManifest(owner, { name: "real", kind: ChannelKind.Public }));
    const nameAt = 64 + 1; // first byte of the name
    bytes[nameAt] = "f".charCodeAt(0);
    const decoded = decodeManifest(bytes)!;
    expect(decoded.name).toBe("feal");
    expect(verifyManifest(decoded)).toBe(false);
  });

  it("can't be copied under someone else's channel ID", () => {
    const real = createManifest(owner, { name: "real", kind: ChannelKind.Public });
    const realId = channelIdOf(real.ownerKey, real.nonce);
    // An attacker re-signs the same nonce with their own key: valid signature, different ID.
    const attacker = createIdentity();
    const fake = createManifest(attacker, { name: "real", kind: ChannelKind.Public });
    const forged = { ...fake, nonce: real.nonce };
    const resigned = createManifest(attacker, { name: "real", kind: ChannelKind.Public });
    expect(verifyManifest(forged, realId)).toBe(false);
    expect(verifyManifest({ ...resigned, ownerKey: owner.publicKey }, realId)).toBe(false);
    expect(manifestId(fake)).not.toBe(manifestId(real));
  });

  it("rejects a signature from the wrong key", () => {
    const m = createManifest(owner, { name: "x", kind: ChannelKind.Public });
    const other = createIdentity();
    const badSig = ed25519.sign(new Uint8Array([1, 2, 3]), other.secretKey);
    expect(verifyManifest({ ...m, ownerSig: badSig })).toBe(false);
  });

  it("returns null for malformed bytes", () => {
    const bytes = encodeManifest(createManifest(owner, { name: "x", kind: ChannelKind.Public }));
    expect(decodeManifest(bytes.slice(0, bytes.length - 1))).toBeNull();
    expect(decodeManifest(new Uint8Array(10))).toBeNull();
    const badKind = bytes.slice();
    badKind[56] = 9;
    expect(decodeManifest(badKind)).toBeNull();
  });

  it("cleans channel names", () => {
    expect(cleanChannelName("  My  Team!! ")).toBe("my-team");
    expect(cleanChannelName("---")).toBe("");
    expect(cleanChannelName("café_2")).toBe("café_2");
    expect(() => createManifest(owner, { name: "!!!", kind: ChannelKind.Public })).toThrow();
  });
});

describe("bloom filter", () => {
  it("never misses an ID it holds and has about 1 % false positives", () => {
    const ids = Array.from({ length: 500 }, () => randomBytes(8));
    const bloom = BloomFilter.forCount(ids.length, 1234);
    for (const id of ids) bloom.add(id);
    for (const id of ids) expect(bloom.has(id)).toBe(true);
    let fp = 0;
    for (let i = 0; i < 10_000; i++) if (bloom.has(randomBytes(8))) fp++;
    expect(fp / 10_000).toBeLessThan(0.03);
  });

  it("round-trips through a SYNC payload", () => {
    const id = randomBytes(8);
    const bloom = BloomFilter.forCount(10, 99);
    bloom.add(id);
    const tag = randomBytes(16);
    const decoded = decodeSyncPayload(encodeSyncPayload({ wants: [LOBBY_WANT_TAG, tag], bloom }))!;
    expect(decoded.wants).toEqual([LOBBY_WANT_TAG, tag]);
    expect(decoded.bloom.has(id)).toBe(true);
    expect(decoded.bloom.salt).toBe(99);
  });

  it("uses a different salt to change which IDs collide", () => {
    const a = new BloomFilter(8, 3, 1);
    const b = new BloomFilter(8, 3, 2);
    const id = randomBytes(8);
    a.add(id);
    b.add(id);
    expect(a.bits).not.toEqual(b.bits);
  });
});
