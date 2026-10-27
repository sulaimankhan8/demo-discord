import { describe, expect, it } from "vitest";
import { randomBytes } from "../bytes";
import { signPacket, verifyPacket } from "../crypto";
import { createIdentity } from "../identity";
import {
  decodePacket,
  encodePacket,
  MAX_TTL,
  PacketType,
  PROTOCOL_VERSION,
  withTtl,
  type MeshPacket,
} from "../packet";
import { decodeMessagePayload, encodeMessagePayload, MAX_TEXT_BYTES } from "../payloads";

const id = createIdentity();

function makePacket(extra: Partial<MeshPacket> = {}): MeshPacket {
  return signPacket(
    {
      version: PROTOCOL_VERSION,
      type: PacketType.Message,
      ttl: MAX_TTL,
      timestamp: 1_760_000_000_123,
      messageId: randomBytes(8),
      senderKey: id.publicKey,
      payload: encodeMessagePayload({ nickname: "ali", text: "hello mesh" }),
      ...extra,
    },
    id.secretKey,
  );
}

describe("packet encoding", () => {
  it("round-trips a signed packet", () => {
    const p = makePacket();
    const decoded = decodePacket(encodePacket(p));
    expect(decoded).not.toBeNull();
    expect(decoded!.timestamp).toBe(p.timestamp);
    expect(decoded!.messageId).toEqual(p.messageId);
    expect(decodeMessagePayload(decoded!.payload)).toEqual({ nickname: "ali", text: "hello mesh" });
    expect(verifyPacket(decoded!)).toBe(true);
  });

  it("round-trips a packet with a recipient", () => {
    const p = makePacket({ recipientId: randomBytes(8) });
    const decoded = decodePacket(encodePacket(p))!;
    expect(decoded.recipientId).toEqual(p.recipientId);
    expect(verifyPacket(decoded)).toBe(true);
  });

  it("keeps the signature valid when the ttl changes on relay", () => {
    const raw = encodePacket(makePacket());
    const relayed = decodePacket(withTtl(raw, 3))!;
    expect(relayed.ttl).toBe(3);
    expect(verifyPacket(relayed)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const raw = encodePacket(makePacket());
    raw[raw.length - 70] ^= 0xff; // inside the payload
    const decoded = decodePacket(raw);
    expect(decoded === null || !verifyPacket(decoded)).toBe(true);
  });

  it("rejects a packet signed by a different key", () => {
    const other = createIdentity();
    const p = signPacket({ ...makePacket(), signature: undefined }, other.secretKey);
    expect(verifyPacket(p)).toBe(false);
  });

  it("returns null for malformed input", () => {
    const raw = encodePacket(makePacket());
    expect(decodePacket(new Uint8Array(0))).toBeNull();
    expect(decodePacket(raw.slice(0, raw.length - 1))).toBeNull();
    const badVersion = raw.slice();
    badVersion[0] = 99;
    expect(decodePacket(badVersion)).toBeNull();
    const badTtl = raw.slice();
    badTtl[2] = MAX_TTL + 1;
    expect(decodePacket(badTtl)).toBeNull();
  });

  it("refuses text over the size limit", () => {
    expect(() => encodeMessagePayload({ nickname: "a", text: "x".repeat(MAX_TEXT_BYTES + 1) })).toThrow();
    expect(() => encodeMessagePayload({ nickname: "a", text: "x".repeat(MAX_TEXT_BYTES) })).not.toThrow();
  });

  it("truncates long nicknames without breaking characters", () => {
    const payload = encodeMessagePayload({ nickname: "ü".repeat(40), text: "hi" });
    const decoded = decodeMessagePayload(payload)!;
    expect(decoded.nickname).toBe("ü".repeat(16)); // 2 bytes each, 32-byte limit
  });
});
