// Joining private and hidden channels (docs/10 C3b): join requests, channel leave notices and
// invites.
//
// JOIN_REQUEST [channelId 16][hasInvite u8][invite proof 200]?[noteLen u8][note]
//   invite proof = [invitePub 32][createdAt u64][adminKey 32][adminSig 64][inviteSig 64]
// LEAVE        [channelId 16]   (an empty LEAVE still means "this phone is going offline")
//
// An invite is a one-time Ed25519 key pair made by an admin. The admin signs
//   "mesh-invite" ‖ channelId ‖ invitePub ‖ createdAt
// and the invite text carries the manifest, that signature and the invite's secret key. To join,
// the newcomer signs "mesh-join" ‖ channelId ‖ myKey with the invite key. Any admin can check
// both signatures, so only admins can make invites, and overhearing a request is useless to
// anyone else (the signature names the requester).
//
// Invite text: "mesh-invite:" + base64url([version u8][manifestLen u16][manifest][adminKey 32]
//              [createdAt u64][adminSig 64][inviteSecret 32])

import { ed25519 } from "@noble/curves/ed25519.js";
import { concat, fromUtf8, toHex, truncateUtf8, utf8 } from "../bytes";
import type { MeshIdentity } from "../identity";
import { CHANNEL_ID_BYTES, channelIdOf, decodeManifest, verifyManifest, type ChannelManifest } from "./manifest";

export const INVITE_PREFIX = "mesh-invite:";
export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
export const MAX_NOTE_BYTES = 100;
const INVITE_VERSION = 1;
const PROOF_BYTES = 32 + 8 + 32 + 64 + 64;

export interface InviteProof {
  invitePub: Uint8Array;
  createdAt: number;
  adminKey: Uint8Array;
  adminSig: Uint8Array;
  inviteSig: Uint8Array;
}

export interface JoinRequest {
  channelId: Uint8Array;
  invite?: InviteProof;
  note: string;
}

export interface Invite {
  manifest: ChannelManifest;
  manifestBytes: Uint8Array;
  adminKey: Uint8Array;
  createdAt: number;
  adminSig: Uint8Array;
  inviteSecret: Uint8Array;
}

function u64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setUint32(0, Math.floor(n / 2 ** 32));
  v.setUint32(4, n >>> 0);
  return b;
}

function view(b: Uint8Array) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function readU64(b: Uint8Array, o: number): number {
  return view(b).getUint32(o) * 2 ** 32 + view(b).getUint32(o + 4);
}

const adminMessage = (channelId: Uint8Array, invitePub: Uint8Array, createdAt: number) =>
  concat(utf8("mesh-invite"), channelId, invitePub, u64(createdAt));
const joinMessage = (channelId: Uint8Array, requesterKey: Uint8Array) => concat(utf8("mesh-join"), channelId, requesterKey);

/* ---------------- join requests ---------------- */

export function encodeJoinRequest(r: JoinRequest): Uint8Array {
  const note = utf8(truncateUtf8(r.note.replace(/\s+/g, " ").trim(), MAX_NOTE_BYTES));
  const parts = [r.channelId, Uint8Array.of(r.invite ? 1 : 0)];
  if (r.invite) {
    const i = r.invite;
    parts.push(i.invitePub, u64(i.createdAt), i.adminKey, i.adminSig, i.inviteSig);
  }
  parts.push(Uint8Array.of(note.length), note);
  return concat(...parts);
}

export function decodeJoinRequest(b: Uint8Array): JoinRequest | null {
  if (b.length < CHANNEL_ID_BYTES + 2) return null;
  let o = CHANNEL_ID_BYTES;
  const hasInvite = b[o++];
  if (hasInvite > 1) return null;
  let invite: InviteProof | undefined;
  if (hasInvite) {
    if (b.length < o + PROOF_BYTES + 1) return null;
    invite = {
      invitePub: b.slice(o, o + 32),
      createdAt: readU64(b, o + 32),
      adminKey: b.slice(o + 40, o + 72),
      adminSig: b.slice(o + 72, o + 136),
      inviteSig: b.slice(o + 136, o + 200),
    };
    o += PROOF_BYTES;
  }
  const noteLen = b[o++];
  if (noteLen > MAX_NOTE_BYTES || b.length !== o + noteLen) return null;
  const note = fromUtf8(b.subarray(o, o + noteLen));
  if (note === null) return null;
  return { channelId: b.slice(0, CHANNEL_ID_BYTES), invite, note };
}

/* ---------------- invites ---------------- */

/** Makes a one-time invite. The caller must be an admin, or admins will ignore it. */
export function createInvite(admin: MeshIdentity, manifest: ChannelManifest, manifestBytes: Uint8Array, now: number): Invite {
  const inviteSecret = ed25519.utils.randomSecretKey();
  const invitePub = ed25519.getPublicKey(inviteSecret);
  const channelId = channelIdOf(manifest.ownerKey, manifest.nonce);
  const adminSig = ed25519.sign(adminMessage(channelId, invitePub, now), admin.secretKey);
  return { manifest, manifestBytes, adminKey: admin.publicKey, createdAt: now, adminSig, inviteSecret };
}

/** What the newcomer puts in its JOIN_REQUEST. */
export function proveInvite(invite: Invite, requesterKey: Uint8Array): InviteProof {
  const channelId = channelIdOf(invite.manifest.ownerKey, invite.manifest.nonce);
  return {
    invitePub: ed25519.getPublicKey(invite.inviteSecret),
    createdAt: invite.createdAt,
    adminKey: invite.adminKey,
    adminSig: invite.adminSig,
    inviteSig: ed25519.sign(joinMessage(channelId, requesterKey), invite.inviteSecret),
  };
}

/**
 * Checks an invite proof's signatures and age. Whether `adminKey` really is an admin (and the
 * invite hasn't been used by someone else) is up to the caller. Returns the hex invite ID.
 */
export function checkInviteProof(
  channelId: Uint8Array,
  p: InviteProof,
  requesterKey: Uint8Array,
  now: number,
): string | null {
  if (p.createdAt > now + 10 * 60_000 || now - p.createdAt > INVITE_TTL_MS) return null;
  try {
    if (!ed25519.verify(p.adminSig, adminMessage(channelId, p.invitePub, p.createdAt), p.adminKey)) return null;
    if (!ed25519.verify(p.inviteSig, joinMessage(channelId, requesterKey), p.invitePub)) return null;
  } catch {
    return null;
  }
  return toHex(p.invitePub);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function encodeInvite(i: Invite): string {
  const len = new Uint8Array(2);
  view(len).setUint16(0, i.manifestBytes.length);
  return (
    INVITE_PREFIX +
    toBase64Url(concat(Uint8Array.of(INVITE_VERSION), len, i.manifestBytes, i.adminKey, u64(i.createdAt), i.adminSig, i.inviteSecret))
  );
}

/** Parses invite text (spaces and line breaks from copy-paste are ignored) and checks the manifest. */
export function decodeInvite(text: string): Invite | null {
  const clean = text.replace(/\s+/g, "");
  if (!clean.startsWith(INVITE_PREFIX)) return null;
  const b = fromBase64Url(clean.slice(INVITE_PREFIX.length));
  if (!b || b.length < 3 || b[0] !== INVITE_VERSION) return null;
  const mLen = view(b).getUint16(1);
  const o = 3 + mLen;
  if (b.length !== o + 32 + 8 + 64 + 32) return null;
  const manifestBytes = b.slice(3, o);
  const manifest = decodeManifest(manifestBytes);
  if (!manifest || !verifyManifest(manifest, channelIdOf(manifest.ownerKey, manifest.nonce))) return null;
  return {
    manifest,
    manifestBytes,
    adminKey: b.slice(o, o + 32),
    createdAt: readU64(b, o + 32),
    adminSig: b.slice(o + 40, o + 104),
    inviteSecret: b.slice(o + 104, o + 136),
  };
}
