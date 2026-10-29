// Pads plaintext to a few fixed sizes so ciphertext length says little about the message.
// Layout: [length u16][bytes][zeros up to the bucket size].

export const PAD_BUCKETS = [256, 512, 1024, 2048] as const;
const LEN_BYTES = 2;

export function pad(data: Uint8Array): Uint8Array {
  const needed = data.length + LEN_BYTES;
  const size = PAD_BUCKETS.find((b) => b >= needed);
  if (size === undefined) throw new Error("too large to pad");
  const out = new Uint8Array(size);
  out[0] = data.length >>> 8;
  out[1] = data.length & 0xff;
  out.set(data, LEN_BYTES);
  return out;
}

/** Returns null if the padding is malformed. */
export function unpad(padded: Uint8Array): Uint8Array | null {
  if (!(PAD_BUCKETS as readonly number[]).includes(padded.length)) return null;
  const len = (padded[0] << 8) | padded[1];
  if (len + LEN_BYTES > padded.length) return null;
  for (let i = LEN_BYTES + len; i < padded.length; i++) if (padded[i] !== 0) return null;
  return padded.slice(LEN_BYTES, LEN_BYTES + len);
}
