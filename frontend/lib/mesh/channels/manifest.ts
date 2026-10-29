// Channel manifest: the owner-signed description of a channel (docs/10 §2.3).
//
//   [nonce 16][ownerKey 32][createdAt u64][kind u8][historyPolicy u8][retentionHours u16]
//   [maxMessages u16][ttl u8][flags u8][nameLen u8][name][descLen u8][desc]
//   flags: bit0 = may be carried over the internet bridge (C5); other bits reserved
//   [kdf u8][passwordCheck 8]   (password kind only; kdf says how the password key is derived)
//   [ownerSig 64]
//
// channelId = SHA-256(ownerKey ‖ nonce)[0..16], so only the owner's key can produce a valid
// manifest for a given ID: nobody can announce a fake copy of someone else's channel.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, equalBytes, fromUtf8, randomBytes, toHex, truncateUtf8, utf8 } from "../bytes";
import type { MeshIdentity } from "../identity";

export const ChannelKind = {
  Public: 1,
  Password: 2,
  Private: 3,
  Hidden: 4,
} as const;
export type ChannelKind = (typeof ChannelKind)[keyof typeof ChannelKind];

/** What a new member gets to read. Only matters for locked kinds; Public shows what's synced. */
export const HistoryPolicy = {
  Recent: 0,
  SinceJoin: 1,
  Full: 2,
} as const;
export type HistoryPolicy = (typeof HistoryPolicy)[keyof typeof HistoryPolicy];

export const CHANNEL_ID_BYTES = 16;
export const NONCE_BYTES = 16;
export const PASSWORD_CHECK_BYTES = 8;
export const MAX_CHANNEL_NAME_BYTES = 32;
export const MAX_CHANNEL_DESC_BYTES = 140;
export const MAX_RETENTION_HOURS = 168;
export const MAX_CHANNEL_MESSAGES = 1000;
/** Most hops a channel's messages travel (the mesh-wide limit). */
export const MAX_CHANNEL_TTL = 7;
const SIG_BYTES = 64;
const FIXED_BYTES = NONCE_BYTES + 32 + 8 + 1 + 1 + 2 + 2 + 1 + 1; // 64
export const MANIFEST_FLAG_BRIDGE = 0x01;

export interface ChannelManifest {
  nonce: Uint8Array;
  ownerKey: Uint8Array;
  createdAt: number;
  kind: ChannelKind;
  historyPolicy: HistoryPolicy;
  retentionHours: number;
  maxMessages: number;
  /** How many hops the channel's messages travel (1–7). A local event channel might use 3. */
  ttl: number;
  /** Raw flags byte, kept as-is so flags added later still verify. See channelAllowsBridge. */
  flags: number;
  name: string;
  description: string;
  /** Password kind only: PasswordKdf id. */
  passwordKdf?: number;
  passwordCheck?: Uint8Array;
  ownerSig: Uint8Array;
}

export interface NewChannel {
  name: string;
  description?: string;
  kind: ChannelKind;
  historyPolicy?: HistoryPolicy;
  retentionHours?: number;
  maxMessages?: number;
  ttl?: number;
  /** Let gateways carry the channel over the internet bridge. */
  bridge?: boolean;
  passwordKdf?: number;
  passwordCheck?: Uint8Array;
  /** Pick the nonce up front when the ID is needed before signing (password key salt). */
  nonce?: Uint8Array;
}

const KINDS = new Set<number>(Object.values(ChannelKind));
const POLICIES = new Set<number>(Object.values(HistoryPolicy));

export function channelIdOf(ownerKey: Uint8Array, nonce: Uint8Array): Uint8Array {
  return sha256(concat(ownerKey, nonce)).slice(0, CHANNEL_ID_BYTES);
}

/** Lower-cases, turns spaces into dashes and drops anything odd: "My Team!" → "my-team". */
export function cleanChannelName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return truncateUtf8(slug, MAX_CHANNEL_NAME_BYTES);
}

function cleanDescription(desc: string): string {
  return truncateUtf8(desc.replace(/\s+/g, " ").trim(), MAX_CHANNEL_DESC_BYTES);
}

function body(m: Omit<ChannelManifest, "ownerSig">): Uint8Array {
  const name = utf8(m.name);
  const desc = utf8(m.description);
  const fixed = new Uint8Array(FIXED_BYTES);
  const view = new DataView(fixed.buffer);
  fixed.set(m.nonce, 0);
  fixed.set(m.ownerKey, NONCE_BYTES);
  view.setUint32(48, Math.floor(m.createdAt / 2 ** 32));
  view.setUint32(52, m.createdAt >>> 0);
  fixed[56] = m.kind;
  fixed[57] = m.historyPolicy;
  view.setUint16(58, m.retentionHours);
  view.setUint16(60, m.maxMessages);
  fixed[62] = m.ttl;
  fixed[63] = m.flags;
  const parts = [fixed, Uint8Array.of(name.length), name, Uint8Array.of(desc.length), desc];
  if (m.kind === ChannelKind.Password) {
    parts.push(Uint8Array.of(m.passwordKdf ?? 0), m.passwordCheck ?? new Uint8Array(PASSWORD_CHECK_BYTES));
  }
  return concat(...parts);
}

export function createManifest(identity: MeshIdentity, opts: NewChannel, now = Date.now()): ChannelManifest {
  const name = cleanChannelName(opts.name);
  if (!name) throw new Error("channel needs a name");
  if (!KINDS.has(opts.kind)) throw new Error("bad channel kind");
  if (opts.kind === ChannelKind.Password && (opts.passwordCheck?.length !== PASSWORD_CHECK_BYTES || !opts.passwordKdf)) {
    throw new Error("password channels need a password check");
  }
  if (opts.nonce && opts.nonce.length !== NONCE_BYTES) throw new Error("bad nonce length");
  const unsigned = {
    nonce: opts.nonce ?? randomBytes(NONCE_BYTES),
    ownerKey: identity.publicKey,
    createdAt: now,
    kind: opts.kind,
    historyPolicy: opts.historyPolicy ?? HistoryPolicy.Recent,
    retentionHours: clampInt(opts.retentionHours ?? 24, 1, MAX_RETENTION_HOURS),
    maxMessages: clampInt(opts.maxMessages ?? 500, 1, MAX_CHANNEL_MESSAGES),
    ttl: clampInt(opts.ttl ?? MAX_CHANNEL_TTL, 1, MAX_CHANNEL_TTL),
    flags: opts.bridge ? MANIFEST_FLAG_BRIDGE : 0,
    name,
    description: cleanDescription(opts.description ?? ""),
    passwordKdf: opts.kind === ChannelKind.Password ? opts.passwordKdf : undefined,
    passwordCheck: opts.kind === ChannelKind.Password ? opts.passwordCheck : undefined,
  };
  return { ...unsigned, ownerSig: ed25519.sign(body(unsigned), identity.secretKey) };
}

export function encodeManifest(m: ChannelManifest): Uint8Array {
  return concat(body(m), m.ownerSig);
}

/** Parses a manifest. Returns null for malformed bytes; call verifyManifest before trusting it. */
export function decodeManifest(bytes: Uint8Array): ChannelManifest | null {
  if (bytes.length < FIXED_BYTES + 2 + SIG_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = bytes[56];
  const historyPolicy = bytes[57];
  if (!KINDS.has(kind) || !POLICIES.has(historyPolicy)) return null;
  const retentionHours = view.getUint16(58);
  const maxMessages = view.getUint16(60);
  if (retentionHours < 1 || retentionHours > MAX_RETENTION_HOURS) return null;
  if (maxMessages < 1 || maxMessages > MAX_CHANNEL_MESSAGES) return null;
  const ttl = bytes[62];
  if (ttl < 1 || ttl > MAX_CHANNEL_TTL) return null;
  const flags = bytes[63];

  let o = FIXED_BYTES;
  const nameLen = bytes[o++];
  if (nameLen === 0 || nameLen > MAX_CHANNEL_NAME_BYTES || bytes.length < o + nameLen + 1) return null;
  const name = fromUtf8(bytes.subarray(o, o + nameLen));
  o += nameLen;
  const descLen = bytes[o++];
  if (descLen > MAX_CHANNEL_DESC_BYTES) return null;
  const description = fromUtf8(bytes.subarray(o, o + descLen));
  o += descLen;
  let passwordKdf: number | undefined;
  let passwordCheck: Uint8Array | undefined;
  if (kind === ChannelKind.Password) {
    if (bytes.length < o + 1 + PASSWORD_CHECK_BYTES + SIG_BYTES) return null;
    passwordKdf = bytes[o++];
    passwordCheck = bytes.slice(o, o + PASSWORD_CHECK_BYTES);
    o += PASSWORD_CHECK_BYTES;
  }
  if (bytes.length !== o + SIG_BYTES || name === null || description === null) return null;

  return {
    nonce: bytes.slice(0, NONCE_BYTES),
    ownerKey: bytes.slice(NONCE_BYTES, NONCE_BYTES + 32),
    createdAt: view.getUint32(48) * 2 ** 32 + view.getUint32(52),
    kind: kind as ChannelKind,
    historyPolicy: historyPolicy as HistoryPolicy,
    retentionHours,
    maxMessages,
    ttl,
    flags,
    name,
    description,
    passwordKdf,
    passwordCheck,
    ownerSig: bytes.slice(o, o + SIG_BYTES),
  };
}

/** True if the owner signature is valid and, when given, the ID matches the owner key + nonce. */
export function verifyManifest(m: ChannelManifest, expectedId?: Uint8Array): boolean {
  if (expectedId && !equalBytes(channelIdOf(m.ownerKey, m.nonce), expectedId)) return false;
  try {
    return ed25519.verify(m.ownerSig, body(m), m.ownerKey);
  } catch {
    return false;
  }
}

export function manifestId(m: ChannelManifest): string {
  return toHex(channelIdOf(m.ownerKey, m.nonce));
}

/** True for kinds whose packets carry the channel ID as their tag (Private/Hidden use rotating tags). */
export function usesPlainTag(kind: ChannelKind): boolean {
  return kind === ChannelKind.Public || kind === ChannelKind.Password;
}

/** The owner allowed this channel on the internet bridge. */
export function channelAllowsBridge(m: ChannelManifest): boolean {
  return (m.flags & MANIFEST_FLAG_BRIDGE) !== 0;
}

/** Kinds whose messages are encrypted. */
export function isLocked(kind: ChannelKind): boolean {
  return kind !== ChannelKind.Public;
}

/** Hidden channels are never announced. */
export function isDiscoverable(kind: ChannelKind): boolean {
  return kind !== ChannelKind.Hidden;
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}
