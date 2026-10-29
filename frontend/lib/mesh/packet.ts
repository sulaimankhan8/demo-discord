// Binary mesh packet format, protocol v2 (see docs/10_MESH_CHANNELS_IMPLEMENTATION_PLAN.md §2.1).
//
//   version    u8
//   type       u8
//   ttl        u8      hops left; changes on every relay, so it is not signed
//   flags      u8      bit0 has recipient, bit1 signed, bit2 link-local (never relayed),
//                      bit3 encrypted payload, bit4 has channel tag
//   timestamp  u64     ms, written as two u32
//   messageId  8 B     random, used for dedup
//   senderKey  32 B    Ed25519 public key
//   channelTag 16 B    only when FLAG_HAS_CHANNEL is set (no tag = Lobby)
//   recipient  8 B     only when FLAG_HAS_RECIPIENT is set
//   length     u16
//   payload    n B
//   signature  64 B    only when FLAG_SIGNED is set
//
// Forward compatibility: a packet with an unknown type or unknown flag bits still decodes
// (with `known: false`) so the router can verify and relay it without delivering it. Later
// versions must keep this header layout and put new fields inside the payload.

export const PROTOCOL_VERSION = 2;
/** Oldest version this build understands. v1 packets have a different header and are dropped. */
export const MIN_PROTOCOL_VERSION = 2;
export const MAX_TTL = 7;

export const PacketType = {
  Announce: 1,
  Leave: 2,
  Message: 3,
  Sync: 4,
  ChannelAnnounce: 5,
  JoinRequest: 6,
  KeyGrant: 7,
  EpochChange: 8,
  Members: 9,
  Direct: 10,
  Ack: 11,
} as const;
export type PacketType = (typeof PacketType)[keyof typeof PacketType];

const KNOWN_TYPES = new Set<number>(Object.values(PacketType));

export const FLAG_HAS_RECIPIENT = 0x01;
export const FLAG_SIGNED = 0x02;
/** Meant only for the phone at the other end of the link; never relayed. */
export const FLAG_LINK_LOCAL = 0x04;
/** The payload is ciphertext. */
export const FLAG_ENCRYPTED = 0x08;
/** A 16-byte channel tag follows the sender key. */
export const FLAG_HAS_CHANNEL = 0x10;
const KNOWN_FLAGS = FLAG_HAS_RECIPIENT | FLAG_SIGNED | FLAG_LINK_LOCAL | FLAG_ENCRYPTED | FLAG_HAS_CHANNEL;

/** Hex channel tag used for the Lobby, whose packets carry no tag. */
export const LOBBY_TAG = "";

export const MESSAGE_ID_BYTES = 8;
export const SENDER_KEY_BYTES = 32;
export const CHANNEL_TAG_BYTES = 16;
export const RECIPIENT_BYTES = 8;
export const SIGNATURE_BYTES = 64;
export const MAX_PAYLOAD_BYTES = 4096;

const FIXED_HEADER_BYTES = 4 + 8 + MESSAGE_ID_BYTES + SENDER_KEY_BYTES; // 52
const TTL_OFFSET = 2;
const MESSAGE_ID_OFFSET = 12;

export interface MeshPacket {
  version: number;
  /** A PacketType, or any other number for packets from newer phones. */
  type: number;
  ttl: number;
  timestamp: number;
  messageId: Uint8Array;
  senderKey: Uint8Array;
  /** Missing = Lobby. */
  channelTag?: Uint8Array;
  recipientId?: Uint8Array;
  linkLocal?: boolean;
  encrypted?: boolean;
  payload: Uint8Array;
  signature?: Uint8Array;
  /** Flag bits this build doesn't know. Kept so re-encoding (for signature checks) is exact. */
  unknownFlags?: number;
  /** Set by decodePacket. False when the type or some flag bits are unknown: relay, don't deliver. */
  known?: boolean;
}

function encodeInternal(p: MeshPacket, forSigning: boolean): Uint8Array {
  if (p.messageId.length !== MESSAGE_ID_BYTES) throw new Error("bad messageId length");
  if (p.senderKey.length !== SENDER_KEY_BYTES) throw new Error("bad senderKey length");
  if (p.channelTag && p.channelTag.length !== CHANNEL_TAG_BYTES) throw new Error("bad channel tag length");
  if (p.recipientId && p.recipientId.length !== RECIPIENT_BYTES) throw new Error("bad recipient length");
  if (p.payload.length > MAX_PAYLOAD_BYTES) throw new Error("payload too large");

  const signed = forSigning || !!p.signature;
  if (p.signature && p.signature.length !== SIGNATURE_BYTES) throw new Error("bad signature length");

  let flags = (p.unknownFlags ?? 0) & ~KNOWN_FLAGS;
  if (p.recipientId) flags |= FLAG_HAS_RECIPIENT;
  if (signed) flags |= FLAG_SIGNED;
  if (p.linkLocal) flags |= FLAG_LINK_LOCAL;
  if (p.encrypted) flags |= FLAG_ENCRYPTED;
  if (p.channelTag) flags |= FLAG_HAS_CHANNEL;

  const size =
    FIXED_HEADER_BYTES +
    (p.channelTag ? CHANNEL_TAG_BYTES : 0) +
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
  if (p.channelTag) {
    out.set(p.channelTag, o);
    o += CHANNEL_TAG_BYTES;
  }
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

/** Parses a packet. Returns null for anything malformed or older than v2. */
export function decodePacket(bytes: Uint8Array): MeshPacket | null {
  if (bytes.length < FIXED_HEADER_BYTES + 2) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[0];
  const type = bytes[1];
  const ttl = bytes[TTL_OFFSET];
  const flags = bytes[3];
  if (version < MIN_PROTOCOL_VERSION) return null;
  if (ttl > MAX_TTL) return null;

  const timestamp = view.getUint32(4) * 2 ** 32 + view.getUint32(8);
  let o = MESSAGE_ID_OFFSET;
  const messageId = bytes.slice(o, o + MESSAGE_ID_BYTES);
  o += MESSAGE_ID_BYTES;
  const senderKey = bytes.slice(o, o + SENDER_KEY_BYTES);
  o += SENDER_KEY_BYTES;

  let channelTag: Uint8Array | undefined;
  if (flags & FLAG_HAS_CHANNEL) {
    if (bytes.length < o + CHANNEL_TAG_BYTES + 2) return null;
    channelTag = bytes.slice(o, o + CHANNEL_TAG_BYTES);
    o += CHANNEL_TAG_BYTES;
  }

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

  const unknownFlags = flags & ~KNOWN_FLAGS;
  return {
    version,
    type,
    ttl,
    timestamp,
    messageId,
    senderKey,
    channelTag,
    recipientId,
    linkLocal: (flags & FLAG_LINK_LOCAL) !== 0,
    encrypted: (flags & FLAG_ENCRYPTED) !== 0,
    payload,
    signature,
    unknownFlags: unknownFlags || undefined,
    known: version === PROTOCOL_VERSION && KNOWN_TYPES.has(type) && unknownFlags === 0,
  };
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
