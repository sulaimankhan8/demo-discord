// Hourly tags for private and hidden channels (docs/10 §2.4).
//
//   tag = HMAC-SHA256(tagKey(epochKey), channelId ‖ hourNumber)[0..16]
//   hourNumber = floor(timestamp / 1 h)
//
// The tag changes every hour and with every key, so someone without the key can't tell that two
// messages belong to the same channel. A member recognises a tag by computing it for the
// message's own hour (from its timestamp) with each key they hold.

import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, utf8 } from "../bytes";
import { CHANNEL_TAG_BYTES } from "../packet";

export const HOUR_MS = 60 * 60_000;
const TAG_INFO = utf8("mesh-tag");

function tagKey(epochKey: Uint8Array): Uint8Array {
  return hkdf(sha256, epochKey, undefined, TAG_INFO, 32);
}

export function hourOf(timestamp: number): number {
  return Math.floor(timestamp / HOUR_MS);
}

export function privateTag(epochKey: Uint8Array, channelId: Uint8Array, timestamp: number): Uint8Array {
  const hour = new Uint8Array(4);
  new DataView(hour.buffer).setUint32(0, hourOf(timestamp) >>> 0);
  return hmac(sha256, tagKey(epochKey), concat(channelId, hour)).slice(0, CHANNEL_TAG_BYTES);
}
