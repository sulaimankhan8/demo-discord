// Payload formats carried inside mesh packets.

import { BloomFilter } from "./bloom";
import { CHANNEL_TAG_BYTES } from "./packet";
import { concat, fromUtf8, truncateUtf8, utf8 } from "./bytes";

export const MAX_NICKNAME_BYTES = 32;
export const MAX_TEXT_BYTES = 2000;

export function cleanNickname(nickname: string): string {
  return truncateUtf8(nickname.replace(/\s+/g, " ").trim(), MAX_NICKNAME_BYTES);
}

/* MESSAGE v2: [senderSeq u32][nickLen u8][nickname][text]
 * senderSeq counts up per identity, so a member can notice gaps ("missing 41-43 from Bob"). */

export const MAX_SENDER_SEQ = 0xffffffff;

export interface MessagePayload {
  senderSeq: number;
  nickname: string;
  text: string;
}

export function encodeMessagePayload(m: MessagePayload): Uint8Array {
  if (!Number.isInteger(m.senderSeq) || m.senderSeq < 0 || m.senderSeq > MAX_SENDER_SEQ) {
    throw new Error("bad senderSeq");
  }
  const nick = utf8(cleanNickname(m.nickname));
  const text = utf8(m.text);
  if (text.length === 0) throw new Error("empty message");
  if (text.length > MAX_TEXT_BYTES) throw new Error("message too long");
  const seq = new Uint8Array(4);
  new DataView(seq.buffer).setUint32(0, m.senderSeq);
  return concat(seq, Uint8Array.of(nick.length), nick, text);
}

export function decodeMessagePayload(bytes: Uint8Array): MessagePayload | null {
  if (bytes.length < 4 + 1 + 1) return null;
  const senderSeq = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const nickLen = bytes[4];
  if (nickLen > MAX_NICKNAME_BYTES || bytes.length < 5 + nickLen + 1) return null;
  const nickname = fromUtf8(bytes.subarray(5, 5 + nickLen));
  const textBytes = bytes.subarray(5 + nickLen);
  if (textBytes.length > MAX_TEXT_BYTES) return null;
  const text = fromUtf8(textBytes);
  if (nickname === null || text === null) return null;
  return { senderSeq, nickname, text };
}

/* ANNOUNCE: [nickname] */

export function encodeAnnouncePayload(nickname: string): Uint8Array {
  return utf8(cleanNickname(nickname));
}

export function decodeAnnouncePayload(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_NICKNAME_BYTES) return null;
  return fromUtf8(bytes);
}

/* SYNC v2: [wantCount u8][want tags 16 B each][bloom salt u32][bloom k u8][bloom bits…]
 * "Send me stored packets with these channel tags whose IDs aren't in this filter."
 * The Lobby is the all-zero tag. */

export const MAX_SYNC_WANTS = 64;
export const LOBBY_WANT_TAG = new Uint8Array(CHANNEL_TAG_BYTES);

export interface SyncPayload {
  wants: Uint8Array[];
  bloom: BloomFilter;
}

export function encodeSyncPayload(s: SyncPayload): Uint8Array {
  if (s.wants.length > MAX_SYNC_WANTS) throw new Error("too many sync wants");
  const head = new Uint8Array(1 + s.wants.length * CHANNEL_TAG_BYTES + 5);
  const view = new DataView(head.buffer);
  head[0] = s.wants.length;
  s.wants.forEach((t, i) => {
    if (t.length !== CHANNEL_TAG_BYTES) throw new Error("bad tag length");
    head.set(t, 1 + i * CHANNEL_TAG_BYTES);
  });
  const o = 1 + s.wants.length * CHANNEL_TAG_BYTES;
  view.setUint32(o, s.bloom.salt);
  head[o + 4] = s.bloom.k;
  return concat(head, s.bloom.bits);
}

export function decodeSyncPayload(bytes: Uint8Array): SyncPayload | null {
  if (bytes.length < 1) return null;
  const count = bytes[0];
  if (count > MAX_SYNC_WANTS) return null;
  const o = 1 + count * CHANNEL_TAG_BYTES;
  if (bytes.length < o + 5 + 1) return null;
  const wants: Uint8Array[] = [];
  for (let i = 0; i < count; i++) wants.push(bytes.slice(1 + i * CHANNEL_TAG_BYTES, 1 + (i + 1) * CHANNEL_TAG_BYTES));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const salt = view.getUint32(o);
  const k = bytes[o + 4];
  if (k < 1 || k > 16) return null;
  return { wants, bloom: new BloomFilter(0, k, salt, bytes.slice(o + 5)) };
}
