// Payload formats carried inside mesh packets.

import { MESSAGE_ID_BYTES } from "./packet";
import { concat, fromUtf8, truncateUtf8, utf8 } from "./bytes";

export const MAX_NICKNAME_BYTES = 32;
export const MAX_TEXT_BYTES = 2000;
export const MAX_SYNC_IDS = 200;

export function cleanNickname(nickname: string): string {
  return truncateUtf8(nickname.replace(/\s+/g, " ").trim(), MAX_NICKNAME_BYTES);
}

/* MESSAGE: [nickLen u8][nickname][text] */

export interface MessagePayload {
  nickname: string;
  text: string;
}

export function encodeMessagePayload(m: MessagePayload): Uint8Array {
  const nick = utf8(cleanNickname(m.nickname));
  const text = utf8(m.text);
  if (text.length === 0) throw new Error("empty message");
  if (text.length > MAX_TEXT_BYTES) throw new Error("message too long");
  return concat(Uint8Array.of(nick.length), nick, text);
}

export function decodeMessagePayload(bytes: Uint8Array): MessagePayload | null {
  if (bytes.length < 2) return null;
  const nickLen = bytes[0];
  if (nickLen > MAX_NICKNAME_BYTES || bytes.length < 1 + nickLen + 1) return null;
  const nickname = fromUtf8(bytes.subarray(1, 1 + nickLen));
  const textBytes = bytes.subarray(1 + nickLen);
  if (textBytes.length > MAX_TEXT_BYTES) return null;
  const text = fromUtf8(textBytes);
  if (nickname === null || text === null) return null;
  return { nickname, text };
}

/* ANNOUNCE: [nickname] */

export function encodeAnnouncePayload(nickname: string): Uint8Array {
  return utf8(cleanNickname(nickname));
}

export function decodeAnnouncePayload(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_NICKNAME_BYTES) return null;
  return fromUtf8(bytes);
}

/* SYNC: list of 8-byte message IDs the sender already has */

export function encodeSyncPayload(ids: Uint8Array[]): Uint8Array {
  return concat(...ids.slice(-MAX_SYNC_IDS));
}

export function decodeSyncPayload(bytes: Uint8Array): Uint8Array[] | null {
  if (bytes.length % MESSAGE_ID_BYTES !== 0) return null;
  const count = bytes.length / MESSAGE_ID_BYTES;
  if (count > MAX_SYNC_IDS) return null;
  const ids: Uint8Array[] = [];
  for (let i = 0; i < count; i++) ids.push(bytes.slice(i * MESSAGE_ID_BYTES, (i + 1) * MESSAGE_ID_BYTES));
  return ids;
}
