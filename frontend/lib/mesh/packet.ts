// Binary mesh packet format (see docs/08_OFFLINE_BLE_MESH_IMPLEMENTATION_PLAN.md §6).
//
//   version   u8
//   type      u8
//   ttl       u8      hops left; changes on every relay, so it is not signed
//   flags     u8      bit0 has recipient, bit1 signed, bit2 link-local (never relayed)
//   timestamp u64     ms, written as two u32
//   messageId 8 B     random, used for dedup
//   senderKey 32 B    Ed25519 public key
//   recipient 8 B     only when FLAG_HAS_RECIPIENT is set
//   length    u16
//   payload   n B
//   signature 64 B    only when FLAG_SIGNED is set

export const PROTOCOL_VERSION = 1;
export const MAX_TTL = 7;

export const PacketType = {
  Announce: 1,
  Leave: 2,
  Message: 3,
  Sync: 4,
} as const;
export type PacketType = (typeof PacketType)[keyof typeof PacketType];

export const FLAG_HAS_RECIPIENT = 0x01;
export const FLAG_SIGNED = 0x02;
/** Meant only for the phone at the other end of the link; never relayed. */
export const FLAG_LINK_LOCAL = 0x04;

export const MESSAGE_ID_BYTES = 8;
export const SENDER_KEY_BYTES = 32;
export const RECIPIENT_BYTES = 8;
export const SIGNATURE_BYTES = 64;
export const MAX_PAYLOAD_BYTES = 4096;

const FIXED_HEADER_BYTES = 4 + 8 + MESSAGE_ID_BYTES + SENDER_KEY_BYTES; // 52
const TTL_OFFSET = 2;
const MESSAGE_ID_OFFSET = 12;

export interface MeshPacket {
  version: number;
  type: PacketType;
  ttl: number;
  timestamp: number;
  messageId: Uint8Array;
  senderKey: Uint8Array;
  recipientId?: Uint8Array;
  linkLocal?: boolean;
  payload: Uint8Array;
  signature?: Uint8Array;
}

function encodeInternal(p: MeshPacket, forSigning: boolean): Uint8Array {
  if (p.messageId.length !== MESSAGE_ID_BYTES) throw new Error("bad messageId length");
  if (p.senderKey.length !== SENDER_KEY_BYTES) throw new Error("bad senderKey length");
  if (p.recipientId && p.recipientId.length !== RECIPIENT_BYTES) throw new Error("bad recipient length");
  if (p.payload.length > MAX_PAYLOAD_BYTES) throw new Error("payload too large");

  const signed = forSigning || !!p.signature;
  if (p.signature && p.signature.length !== SIGNATURE_BYTES) throw new Error("bad signature length");

  let flags = 0;
  if (p.recipientId) flags |= FLAG_HAS_RECIPIENT;
  if (signed) flags |= FLAG_SIGNED;
  if (p.linkLocal) flags |= FLAG_LINK_LOCAL;

  const size =
    FIXED_HEADER_BYTES +
    (p.recipientId ? RECIPIENT_BYTES : 0) +
    2 +
    p.payload.length +
    (p.signature && !forSigning ? SIGNATURE_BYTES : 0);

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out[0] = p.version;
  out[1] = p.type;
  out[TTL_OFFSET] = forSigning ? 0 : p.ttl;
  out[3] = flags;
  view.setUint32(4, Math.floor(p.timestamp / 2 ** 32));
  view.setUint32(8, p.timestamp >>> 0);
  let o = MESSAGE_ID_OFFSET;
  out.set(p.messageId, o);
  o += MESSAGE_ID_BYTES;
  out.set(p.senderKey, o);
  o += SENDER_KEY_BYTES;
  if (p.recipientId) {
    out.set(p.recipientId, o);
    o += RECIPIENT_BYTES;
  }
  view.setUint16(o, p.payload.length);
  o += 2;
  out.set(p.payload, o);
  o += p.payload.length;
  if (p.signature && !forSigning) out.set(p.signature, o);
  return out;
}

export function encodePacket(p: MeshPacket): Uint8Array {
  return encodeInternal(p, false);
}

/** The bytes covered by the signature: the packet without its signature, with ttl set to 0. */
export function signingBytes(p: MeshPacket): Uint8Array {
  return encodeInternal(p, true);
}

/** Parses a packet. Returns null for anything malformed. */
export function decodePacket(bytes: Uint8Array): MeshPacket | null {
  if (bytes.length < FIXED_HEADER_BYTES + 2) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[0];
  const type = bytes[1] as PacketType;
  const ttl = bytes[TTL_OFFSET];
  const flags = bytes[3];
  if (version !== PROTOCOL_VERSION) return null;
  if (!Object.values(PacketType).includes(type)) return null;
  if (ttl > MAX_TTL) return null;
  if (flags & ~(FLAG_HAS_RECIPIENT | FLAG_SIGNED | FLAG_LINK_LOCAL)) return null;

  const timestamp = view.getUint32(4) * 2 ** 32 + view.getUint32(8);
  let o = MESSAGE_ID_OFFSET;
  const messageId = bytes.slice(o, o + MESSAGE_ID_BYTES);
  o += MESSAGE_ID_BYTES;
  const senderKey = bytes.slice(o, o + SENDER_KEY_BYTES);
  o += SENDER_KEY_BYTES;

  let recipientId: Uint8Array | undefined;
  if (flags & FLAG_HAS_RECIPIENT) {
    if (bytes.length < o + RECIPIENT_BYTES + 2) return null;
    recipientId = bytes.slice(o, o + RECIPIENT_BYTES);
    o += RECIPIENT_BYTES;
  }

  const length = view.getUint16(o);
  o += 2;
  if (length > MAX_PAYLOAD_BYTES) return null;
  const expected = o + length + (flags & FLAG_SIGNED ? SIGNATURE_BYTES : 0);
  if (bytes.length !== expected) return null;

  const payload = bytes.slice(o, o + length);
  o += length;
  const signature = flags & FLAG_SIGNED ? bytes.slice(o, o + SIGNATURE_BYTES) : undefined;

  const linkLocal = (flags & FLAG_LINK_LOCAL) !== 0;
  return { version, type, ttl, timestamp, messageId, senderKey, recipientId, linkLocal, payload, signature };
}

/** Returns a copy of an encoded packet with a new ttl. The signature stays valid. */
export function withTtl(encoded: Uint8Array, ttl: number): Uint8Array {
  const copy = encoded.slice();
  copy[TTL_OFFSET] = ttl;
  return copy;
}

export function ttlOf(encoded: Uint8Array): number {
  return encoded[TTL_OFFSET];
}

/** Reads the message ID from an encoded packet without decoding the rest. */
export function messageIdOf(encoded: Uint8Array): Uint8Array {
  return encoded.slice(MESSAGE_ID_OFFSET, MESSAGE_ID_OFFSET + MESSAGE_ID_BYTES);
}
