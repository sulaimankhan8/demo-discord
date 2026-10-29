import { describe, expect, it } from "vitest";
import { randomBytes, utf8 } from "../bytes";
import {
  checkPasswordKey,
  decryptMessage,
  encryptMessage,
  passwordCheck,
  passwordKey,
  PasswordKdf,
  type MessageHeaderInfo,
} from "../crypto/channelCrypto";
import { pad, PAD_BUCKETS, unpad } from "../crypto/padding";

function header(): MessageHeaderInfo {
  return {
    channelTag: randomBytes(16),
    messageId: randomBytes(8),
    senderKey: randomBytes(32),
    timestamp: 1_760_000_000_123,
  };
}

describe("padding", () => {
  it("pads to the next bucket and back", () => {
    for (const len of [0, 1, 254, 255, 600, 2046]) {
      const data = randomBytes(len);
      const padded = pad(data);
      expect(PAD_BUCKETS).toContain(padded.length);
      expect(unpad(padded)).toEqual(data);
    }
    expect(pad(new Uint8Array(254)).length).toBe(256);
    expect(pad(new Uint8Array(255)).length).toBe(512);
    expect(() => pad(new Uint8Array(2047))).toThrow();
  });

  it("rejects malformed padding", () => {
    const padded = pad(utf8("hi"));
    expect(unpad(padded.slice(0, 100))).toBeNull();
    const badLen = padded.slice();
    badLen[0] = 0xff;
    expect(unpad(badLen)).toBeNull();
    const junk = padded.slice();
    junk[200] = 1;
    expect(unpad(junk)).toBeNull();
  });
});

describe("message encryption", () => {
  const key = randomBytes(32);
  const text = utf8("meet at the north gate");

  it("round-trips, and the ciphertext has a padded size", () => {
    const h = header();
    const ct = encryptMessage(key, h, text);
    expect(ct.length).toBe(256 + 16);
    expect(decryptMessage(key, h, ct)).toEqual(text);
  });

  it("fails with the wrong key", () => {
    const h = header();
    expect(decryptMessage(randomBytes(32), h, encryptMessage(key, h, text))).toBeNull();
  });

  it("fails if any header field is changed (AAD)", () => {
    const h = header();
    const ct = encryptMessage(key, h, text);
    expect(decryptMessage(key, { ...h, channelTag: randomBytes(16) }, ct)).toBeNull();
    expect(decryptMessage(key, { ...h, messageId: randomBytes(8) }, ct)).toBeNull();
    expect(decryptMessage(key, { ...h, senderKey: randomBytes(32) }, ct)).toBeNull();
    expect(decryptMessage(key, { ...h, timestamp: h.timestamp + 1 }, ct)).toBeNull();
  });

  it("fails if the ciphertext is changed", () => {
    const h = header();
    const ct = encryptMessage(key, h, text);
    ct[10] ^= 1;
    expect(decryptMessage(key, h, ct)).toBeNull();
  });

  it("gives different ciphertext for each message ID", () => {
    const a = header();
    const b = { ...a, messageId: randomBytes(8) };
    expect(encryptMessage(key, a, text)).not.toEqual(encryptMessage(key, b, text));
  });
});

describe("password keys", () => {
  const channelId = randomBytes(16);

  it("derives the same key for the same password and channel, and the check catches wrong ones", async () => {
    const k1 = await passwordKey("open sesame", channelId, PasswordKdf.Argon2id16M);
    const k2 = await passwordKey("open sesame", channelId, PasswordKdf.Argon2id16M);
    const wrong = await passwordKey("open sesame!", channelId, PasswordKdf.Argon2id16M);
    const otherChannel = await passwordKey("open sesame", randomBytes(16), PasswordKdf.Argon2id16M);
    expect(k1).toEqual(k2);
    expect(k1).toHaveLength(32);
    expect(wrong).not.toEqual(k1);
    expect(otherChannel).not.toEqual(k1);
    const check = passwordCheck(k1);
    expect(checkPasswordKey(k2, check)).toBe(true);
    expect(checkPasswordKey(wrong, check)).toBe(false);
  });

  it("supports the scrypt fallback", async () => {
    const k = await passwordKey("open sesame", channelId, PasswordKdf.Scrypt32K);
    expect(k).toHaveLength(32);
    expect(k).not.toEqual(await passwordKey("open sesame", channelId, PasswordKdf.Argon2id16M));
  });
});
