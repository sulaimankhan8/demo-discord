// Private-channel membership rules (docs/10 C3a). Pure logic: payload formats plus the checks
// that decide whether a MEMBERS list or EPOCH_CHANGE is accepted. No I/O.
//
// MEMBERS      [channelId 16][epoch u32][version u32][count u8][(key 32)(role u8)(joinedEpoch u32)]…
// EPOCH_CHANGE [channelId 16][newEpoch u32][prevChangeHash 8][reason u8][count u8][removed key 32]…
// KEY_GRANT    [channelId 16][count u8][(epoch u32)(changeHash 8)(sealed key 80)]…
//
// Rules:
// - The manifest owner is always Owner. A list must contain the owner, as Owner, and no other Owner.
// - A MEMBERS list is accepted only with a higher version, signed by someone who is at least
//   Admin in the list I currently hold (the owner always counts). Two different lists with the
//   same version (two admins at once): the lower hash wins, like epoch changes.
// - Admins may add, remove and edit Members only. Co-owners may also manage Admins. Only the owner
//   may make or remove Co-owners. Co-owners keep the channel running if the owner never returns.
// - EPOCH_CHANGE: the higher epoch wins; for the same epoch, the change with the lower hash wins,
//   so every phone ends on the same key whichever order it hears them in.

import { sha256 } from "@noble/hashes/sha2.js";
import { concat, fromHex, toHex } from "../bytes";
import { SEAL_OVERHEAD } from "../crypto/sealed";
import { CHANNEL_ID_BYTES } from "./manifest";

export const Role = {
  Member: 0,
  Admin: 1,
  CoOwner: 2,
  Owner: 3,
} as const;
export type Role = (typeof Role)[keyof typeof Role];
const ROLES = new Set<number>(Object.values(Role));

export const EpochReason = {
  Rotate: 0,
  Removed: 1,
  Left: 2,
  Periodic: 3,
} as const;
export type EpochReason = (typeof EpochReason)[keyof typeof EpochReason];

export const MAX_MEMBERS = 100;
export const CHANGE_HASH_BYTES = 8;
/** The "change" that created epoch 0, before any rotation. */
export const GENESIS_HASH = new Uint8Array(CHANGE_HASH_BYTES);
const KEY_BYTES = 32;
const SEALED_KEY_BYTES = KEY_BYTES + SEAL_OVERHEAD; // 80
const MAX_GRANT_KEYS = 32;

export interface Member {
  /** Hex Ed25519 public key. */
  key: string;
  role: Role;
  joinedEpoch: number;
}

export interface MembersList {
  channelId: Uint8Array;
  epoch: number;
  version: number;
  members: Member[];
}

export interface EpochChange {
  channelId: Uint8Array;
  newEpoch: number;
  prevChangeHash: Uint8Array;
  reason: EpochReason;
  /** Hex keys of members removed with this change (for display). */
  removed: string[];
}

export interface GrantEntry {
  epoch: number;
  changeHash: Uint8Array;
  sealedKey: Uint8Array;
}

export interface KeyGrant {
  channelId: Uint8Array;
  entries: GrantEntry[];
}

/* ---------------- encoding ---------------- */

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

function readU32(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o);
}

export function encodeMembers(l: MembersList): Uint8Array {
  if (l.members.length > MAX_MEMBERS) throw new Error("too many members");
  const parts = [l.channelId, u32(l.epoch), u32(l.version), Uint8Array.of(l.members.length)];
  for (const m of l.members) {
    const key = fromHex(m.key);
    if (!key || key.length !== 32) throw new Error("bad member key");
    parts.push(key, Uint8Array.of(m.role), u32(m.joinedEpoch));
  }
  return concat(...parts);
}

export function decodeMembers(b: Uint8Array): MembersList | null {
  const head = CHANNEL_ID_BYTES + 4 + 4 + 1;
  if (b.length < head) return null;
  const count = b[head - 1];
  if (count > MAX_MEMBERS || b.length !== head + count * 37) return null;
  const members: Member[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const o = head + i * 37;
    const key = toHex(b.subarray(o, o + 32));
    const role = b[o + 32];
    if (!ROLES.has(role) || seen.has(key)) return null;
    seen.add(key);
    members.push({ key, role: role as Role, joinedEpoch: readU32(b, o + 33) });
  }
  return {
    channelId: b.slice(0, CHANNEL_ID_BYTES),
    epoch: readU32(b, CHANNEL_ID_BYTES),
    version: readU32(b, CHANNEL_ID_BYTES + 4),
    members,
  };
}

export function encodeEpochChange(c: EpochChange): Uint8Array {
  if (c.prevChangeHash.length !== CHANGE_HASH_BYTES) throw new Error("bad change hash");
  if (c.removed.length > MAX_MEMBERS) throw new Error("too many removed");
  const removed = c.removed.map((k) => {
    const b = fromHex(k);
    if (!b || b.length !== 32) throw new Error("bad key");
    return b;
  });
  return concat(c.channelId, u32(c.newEpoch), c.prevChangeHash, Uint8Array.of(c.reason, removed.length), ...removed);
}

export function decodeEpochChange(b: Uint8Array): EpochChange | null {
  const head = CHANNEL_ID_BYTES + 4 + CHANGE_HASH_BYTES + 2;
  if (b.length < head) return null;
  const reason = b[head - 2];
  const count = b[head - 1];
  if (reason > EpochReason.Periodic || b.length !== head + count * 32) return null;
  const removed: string[] = [];
  for (let i = 0; i < count; i++) removed.push(toHex(b.subarray(head + i * 32, head + (i + 1) * 32)));
  return {
    channelId: b.slice(0, CHANNEL_ID_BYTES),
    newEpoch: readU32(b, CHANNEL_ID_BYTES),
    prevChangeHash: b.slice(CHANNEL_ID_BYTES + 4, CHANNEL_ID_BYTES + 4 + CHANGE_HASH_BYTES),
    reason: reason as EpochReason,
    removed,
  };
}

export function encodeGrant(g: KeyGrant): Uint8Array {
  if (g.entries.length === 0 || g.entries.length > MAX_GRANT_KEYS) throw new Error("bad grant size");
  const parts = [g.channelId, Uint8Array.of(g.entries.length)];
  for (const e of g.entries) {
    if (e.sealedKey.length !== SEALED_KEY_BYTES || e.changeHash.length !== CHANGE_HASH_BYTES) {
      throw new Error("bad grant entry");
    }
    parts.push(u32(e.epoch), e.changeHash, e.sealedKey);
  }
  return concat(...parts);
}

export function decodeGrant(b: Uint8Array): KeyGrant | null {
  const head = CHANNEL_ID_BYTES + 1;
  if (b.length < head) return null;
  const count = b[head - 1];
  const entryBytes = 4 + CHANGE_HASH_BYTES + SEALED_KEY_BYTES;
  if (count === 0 || count > MAX_GRANT_KEYS || b.length !== head + count * entryBytes) return null;
  const entries: GrantEntry[] = [];
  for (let i = 0; i < count; i++) {
    const o = head + i * entryBytes;
    entries.push({
      epoch: readU32(b, o),
      changeHash: b.slice(o + 4, o + 4 + CHANGE_HASH_BYTES),
      sealedKey: b.slice(o + 4 + CHANGE_HASH_BYTES, o + entryBytes),
    });
  }
  return { channelId: b.slice(0, CHANNEL_ID_BYTES), entries };
}

/** The channel ID at the start of every control payload, or null if too short. */
export function controlChannelId(payload: Uint8Array): string | null {
  return payload.length >= CHANNEL_ID_BYTES ? toHex(payload.subarray(0, CHANNEL_ID_BYTES)) : null;
}

/** Identifies one EPOCH_CHANGE; also the tie-breaker between two changes for the same epoch. */
export function changeHash(signerKey: Uint8Array, payload: Uint8Array): Uint8Array {
  return sha256(concat(signerKey, payload)).slice(0, CHANGE_HASH_BYTES);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/* ---------------- state ---------------- */

export type MembersVerdict = "ok" | "stale" | "unauthorized" | "invalid";
export type EpochVerdict = "newer" | "tie_win" | "stale" | "unauthorized" | "invalid";

export class MembershipState {
  version = 0;
  /** Hash of the list I hold, to break ties between two lists with the same version. */
  listHash: Uint8Array = GENESIS_HASH;
  epoch = 0;
  changeHash: Uint8Array = GENESIS_HASH;
  private members = new Map<string, Member>();

  constructor(
    readonly channelId: string,
    /** Hex key of the manifest owner. */
    readonly ownerKey: string,
  ) {}

  list(): Member[] {
    return [...this.members.values()].sort((a, b) => b.role - a.role || a.key.localeCompare(b.key));
  }

  has(key: string): boolean {
    return this.members.has(key);
  }

  /** The owner is always Owner, even before the first list arrives. */
  roleOf(key: string): Role | undefined {
    if (key === this.ownerKey) return Role.Owner;
    return this.members.get(key)?.role;
  }

  canAdmin(key: string): boolean {
    return (this.roleOf(key) ?? -1) >= Role.Admin;
  }

  /** `hash` (changeHash of signer + payload) lets a same-version list win a tie. */
  checkMembers(list: MembersList, signer: string, hash?: Uint8Array): MembersVerdict {
    if (toHex(list.channelId) !== this.channelId) return "invalid";
    if (list.members.length > MAX_MEMBERS) return "invalid";
    const owners = list.members.filter((m) => m.role === Role.Owner);
    if (owners.length !== 1 || owners[0].key !== this.ownerKey) return "invalid";
    const tieWin = list.version === this.version && this.version > 0 && !!hash && compareBytes(hash, this.listHash) < 0;
    if (list.version < this.version || (list.version === this.version && !tieWin)) return "stale";

    const signerRole = this.roleOf(signer);
    if (signerRole === undefined || signerRole < Role.Admin) return "unauthorized";
    if (signerRole === Role.Owner) return "ok";

    const next = new Map(list.members.map((m) => [m.key, m]));
    for (const key of new Set([...this.members.keys(), ...next.keys()])) {
      const before = this.members.get(key)?.role;
      const after = next.get(key)?.role;
      if (before === after) continue;
      const touches = (r: Role) => before === r || after === r;
      // Admins can only touch Members; co-owners can't touch co-owners.
      if (signerRole === Role.Admin && (touches(Role.Admin) || touches(Role.CoOwner))) return "unauthorized";
      if (signerRole === Role.CoOwner && touches(Role.CoOwner)) return "unauthorized";
    }
    return "ok";
  }

  /** Applies a list after checkMembers said "ok". */
  applyMembers(list: MembersList, hash: Uint8Array = GENESIS_HASH): void {
    this.version = list.version;
    this.listHash = hash;
    this.members = new Map(list.members.map((m) => [m.key, { ...m }]));
  }

  checkEpochChange(change: EpochChange, signer: string, hash: Uint8Array): EpochVerdict {
    if (toHex(change.channelId) !== this.channelId || change.newEpoch === 0) return "invalid";
    if (!this.canAdmin(signer)) return "unauthorized";
    if (change.newEpoch > this.epoch) return "newer";
    if (change.newEpoch === this.epoch && compareBytes(hash, this.changeHash) < 0) return "tie_win";
    return "stale";
  }

  applyEpochChange(change: EpochChange, hash: Uint8Array): void {
    this.epoch = change.newEpoch;
    this.changeHash = hash;
  }

  /** A copy of the list with one member changed (undefined role removes them). Doesn't apply it. */
  draftWith(key: string, role: Role | undefined): MembersList {
    const next = new Map(this.members);
    if (!next.has(this.ownerKey)) next.set(this.ownerKey, { key: this.ownerKey, role: Role.Owner, joinedEpoch: 0 });
    if (role === undefined) next.delete(key);
    else next.set(key, { key, role, joinedEpoch: next.get(key)?.joinedEpoch ?? this.epoch });
    return {
      channelId: fromHex(this.channelId)!,
      epoch: this.epoch,
      version: this.version + 1,
      members: [...next.values()],
    };
  }
}
