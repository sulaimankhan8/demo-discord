// Channel encryption (docs/10 step C2).
//
// - Password channels: key = Argon2id(password, salt = channelId). Derived once on join and
//   kept as epoch 0. A short check value in the manifest catches a wrong password at once.
// - Every message gets its own key: msgKey = HKDF(channelKey, salt = messageId, "mesh-msg").
//   Because each key encrypts exactly one message, XChaCha20-Poly1305 can use a zero nonce.
// - The header fields that identify the message (tag, ID, sender, time) are authenticated as
//   AAD, so a relay can't move a ciphertext to another channel, sender or time.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, equalBytes, utf8 } from "../bytes";
import { CHANNEL_TAG_BYTES, MESSAGE_ID_BYTES, SENDER_KEY_BYTES } from "../packet";
import { pad, unpad } from "./padding";

export const KEY_BYTES = 32;
export const PASSWORD_CHECK_BYTES = 8;
const NONCE = new Uint8Array(24); // safe: every message key is used once
const MSG_INFO = utf8("mesh-msg");
const CHECK_INFO = utf8("check");

/**
 * How the password key is derived. Stored in the manifest so the setting can be tuned later
 * (doc 10 C2: measure on the slowest phone) without breaking existing channels.
 */
export const PasswordKdf = {
  /** Argon2id, 16 MiB, 2 passes. ~0.2–0.3 s on a desktop; aim for < 1 s on phones. */
  Argon2id16M: 1,
  /** scrypt N = 2^15, r = 8: fallback if Argon2 turns out too slow in a phone's WebView. */
  Scrypt32K: 2,
} as const;
export type PasswordKdf = (typeof PasswordKdf)[keyof typeof PasswordKdf];
export const DEFAULT_PASSWORD_KDF: PasswordKdf = PasswordKdf.Argon2id16M;
const KDFS = new Set<number>(Object.values(PasswordKdf));

export function isKnownKdf(id: number): id is PasswordKdf {
  return KDFS.has(id);
}

/** Derives the channel key from a password. Async so the screen keeps responding. */
export async function passwordKey(password: string, channelId: Uint8Array, kdf: PasswordKdf): Promise<Uint8Array> {
  const pw = utf8(password.normalize("NFKC"));
  // Salt: the channel ID, padded out so it's never shorter than the KDF's minimum.
  const salt = concat(utf8("mesh-channel-pw"), channelId);
  if (kdf === PasswordKdf.Argon2id16M) {
    return argon2idAsync(pw, salt, { m: 16 * 1024, t: 2, p: 1, dkLen: KEY_BYTES, asyncTick: 20 });
  }
  if (kdf === PasswordKdf.Scrypt32K) {
    return scryptAsync(pw, salt, { N: 2 ** 15, r: 8, p: 1, dkLen: KEY_BYTES, asyncTick: 20 });
  }
  throw new Error("unknown password KDF");
}

export function passwordCheck(key: Uint8Array): Uint8Array {
  return hmac(sha256, key, CHECK_INFO).slice(0, PASSWORD_CHECK_BYTES);
}

export function checkPasswordKey(key: Uint8Array, expected: Uint8Array): boolean {
  return equalBytes(passwordCheck(key), expected);
}

/** The header fields that are bound to a ciphertext. */
export interface MessageHeaderInfo {
  channelTag: Uint8Array;
  messageId: Uint8Array;
  senderKey: Uint8Array;
  timestamp: number;
}

function aad(h: MessageHeaderInfo): Uint8Array {
  if (h.channelTag.length !== CHANNEL_TAG_BYTES) throw new Error("bad channel tag");
  if (h.messageId.length !== MESSAGE_ID_BYTES) throw new Error("bad message id");
  if (h.senderKey.length !== SENDER_KEY_BYTES) throw new Error("bad sender key");
  const time = new Uint8Array(8);
  const view = new DataView(time.buffer);
  view.setUint32(0, Math.floor(h.timestamp / 2 ** 32));
  view.setUint32(4, h.timestamp >>> 0);
  return concat(h.channelTag, h.messageId, h.senderKey, time);
}

function messageKey(channelKey: Uint8Array, messageId: Uint8Array): Uint8Array {
  return hkdf(sha256, channelKey, messageId, MSG_INFO, KEY_BYTES);
}

/** Pads and encrypts a payload for one message. */
export function encryptMessage(channelKey: Uint8Array, header: MessageHeaderInfo, plaintext: Uint8Array): Uint8Array {
  return xchacha20poly1305(messageKey(channelKey, header.messageId), NONCE, aad(header)).encrypt(pad(plaintext));
}

/** Returns the plaintext, or null if the key is wrong or anything was changed. */
export function decryptMessage(
  channelKey: Uint8Array,
  header: MessageHeaderInfo,
  ciphertext: Uint8Array,
): Uint8Array | null {
  try {
    const padded = xchacha20poly1305(messageKey(channelKey, header.messageId), NONCE, aad(header)).decrypt(ciphertext);
    return unpad(padded);
  } catch {
    return null;
  }
}
