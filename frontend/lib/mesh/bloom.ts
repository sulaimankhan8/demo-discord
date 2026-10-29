// Bloom filter of 8-byte message IDs, used by SYNC v2: "here's what I already have".
// A false positive means one message isn't sent this time; every SYNC uses a fresh salt, so
// the same message isn't missed again on the next link.

import { MESSAGE_ID_BYTES } from "./packet";

export const BLOOM_TARGET_FP = 0.01;

/** 32-bit integer mix (from MurmurHash3's finaliser). */
function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

export class BloomFilter {
  readonly bits: Uint8Array;
  private readonly m: number;

  constructor(
    sizeBytes: number,
    readonly k: number,
    readonly salt: number,
    bits?: Uint8Array,
  ) {
    this.bits = bits ?? new Uint8Array(Math.max(1, sizeBytes));
    this.m = this.bits.length * 8;
  }

  /** Picks a size for `count` IDs at about 1 % false positives, capped at `maxBytes`. */
  static forCount(count: number, salt: number, maxBytes = 2048): BloomFilter {
    const n = Math.max(1, count);
    const bitsNeeded = Math.ceil((-n * Math.log(BLOOM_TARGET_FP)) / Math.LN2 ** 2);
    const bytes = Math.min(maxBytes, Math.max(8, Math.ceil(bitsNeeded / 8)));
    const k = Math.min(10, Math.max(1, Math.round(((bytes * 8) / n) * Math.LN2)));
    return new BloomFilter(bytes, k, salt >>> 0);
  }

  private positions(id: Uint8Array): number[] {
    if (id.length !== MESSAGE_ID_BYTES) throw new Error("bad id length");
    // Double hashing: positions h1 + i·h2, with h1/h2 from the (random) ID mixed with the salt.
    const h1 = mix(readU32(id, 0) ^ this.salt);
    const h2 = mix(readU32(id, 4) ^ ((this.salt << 13) | (this.salt >>> 19))) | 1;
    const out: number[] = [];
    for (let i = 0; i < this.k; i++) out.push(((h1 + Math.imul(i, h2)) >>> 0) % this.m);
    return out;
  }

  add(id: Uint8Array): void {
    for (const p of this.positions(id)) this.bits[p >> 3] |= 1 << (p & 7);
  }

  has(id: Uint8Array): boolean {
    for (const p of this.positions(id)) if (!(this.bits[p >> 3] & (1 << (p & 7)))) return false;
    return true;
  }
}
