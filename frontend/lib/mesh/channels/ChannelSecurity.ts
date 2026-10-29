// Keys and control packets for locked channels (docs/10 C2, C3a).
//
// Password channels: one key (epoch 0) from the password.
// Private/Hidden channels: a series of epoch keys. The owner makes epoch 0; an admin makes a new
// epoch when someone is removed (or on request). Keys reach members in KEY_GRANT packets sealed to
// each member's identity key. MEMBERS lists say who is in and with what role.
//
// Every accepted control packet is kept and sent first in SYNC replies, so a member who was away
// gets the member list and its keys before the messages that need them.

import { fromHex, randomBytes, toHex } from "../bytes";
import { openSealed, seal } from "../crypto/sealed";
import { fingerprintOf, type MeshIdentity } from "../identity";
import { decodePacket, PacketType, type MeshPacket } from "../packet";
import type { MeshStore, StoredControl, StoredEpochKey } from "../store";
import type { JoinedChannel } from "./ChannelRegistry";
import { ChannelKind, HistoryPolicy, type ChannelManifest } from "./manifest";
import {
  changeHash,
  controlChannelId,
  decodeEpochChange,
  decodeGrant,
  decodeMembers,
  encodeEpochChange,
  encodeGrant,
  encodeMembers,
  EpochReason,
  GENESIS_HASH,
  MembershipState,
  Role,
  type GrantEntry,
  type Member,
  type MembersList,
} from "./membership";

export interface ChannelKeySet {
  /** Key to encrypt new messages with; null while I don't have the current epoch's key. */
  send: Uint8Array | null;
  /** Every key I hold for this channel, newest first, to try when reading. */
  all: Uint8Array[];
}

interface KeyEntry {
  epoch: number;
  changeHash: string;
  key: Uint8Array;
}

interface ControlEntry {
  id: string;
  raw: Uint8Array;
}

interface PrivateState {
  id: string;
  manifest: ChannelManifest;
  members: MembershipState;
  keys: KeyEntry[];
  /** When the current epoch began (its EPOCH_CHANGE's timestamp; channel creation for epoch 0). */
  epochStarted: number;
  /** MEMBERS packets since the owner last signed one, oldest first: lets a newcomer check them. */
  chain: (ControlEntry & { version: number; signer: string })[];
  /**
   * My last member change. If another admin's list wins over mine (same version, lower hash),
   * I re-apply this on top of theirs, so two admins adding people at once both get through.
   */
  intent?: { key: string; role: Role | undefined; version: number };
  /** Latest accepted EPOCH_CHANGEs (a few, for members who missed one). */
  changes: (ControlEntry & { epoch: number })[];
  /** KEY_GRANTs, kept so they can reach their recipient later. */
  grants: (ControlEntry & { recipient: string; maxEpoch: number })[];
}

interface Pending {
  channelId: string;
  packet: MeshPacket;
  raw: Uint8Array;
  at: number;
}

export interface ChannelSecurityDeps {
  identity: MeshIdentity;
  now: () => number;
  /** Floods a control packet tagged for the channel; returns its ID and bytes. */
  sendControl: (
    type: PacketType,
    payload: Uint8Array,
    channelId: Uint8Array,
    recipientId?: Uint8Array,
  ) => { id: string; raw: Uint8Array };
  store?: MeshStore;
  /** My keys for a channel changed (decrypt waiting messages, re-enable sending). */
  onKeysChanged?: (channelId: string) => void;
  onMembersChanged?: (channelId: string) => void;
}

const MAX_CHAIN = 64;
const KEEP_CHANGES = 3;
const KEEP_EPOCHS_MIN = 3;
const KEEP_EPOCHS_MAX = 20;
const MAX_PENDING = 64;
/** One sender can't fill the queue and push out other people's packets (docs/10 C7). */
const MAX_PENDING_PER_SENDER = 8;
const PENDING_TTL_MS = 15 * 60_000;

export class ChannelSecurity {
  private passwordKeys = new Map<string, Uint8Array>();
  private priv = new Map<string, PrivateState>();
  private pending: Pending[] = [];
  private readonly me: string;
  private readonly myFingerprint: string;

  constructor(private readonly deps: ChannelSecurityDeps) {
    this.me = toHex(deps.identity.publicKey);
    this.myFingerprint = deps.identity.fingerprint;
  }

  /* ---------------- setup ---------------- */

  /** Restores keys and control packets for the channels I'm in. */
  load(joined: JoinedChannel[], keys: StoredEpochKey[], control: StoredControl[]): void {
    for (const c of joined) {
      if (c.manifest.kind === ChannelKind.Password) {
        const row = keys.find((k) => k.channelId === c.id && k.epoch === 0);
        if (row) this.passwordKeys.set(c.id, row.key);
      } else if (isPrivateKind(c.manifest.kind)) {
        const st = this.ensure(c);
        for (const row of keys.filter((k) => k.channelId === c.id)) {
          st.keys.push({ epoch: row.epoch, changeHash: row.changeHash ?? toHex(GENESIS_HASH), key: row.key });
          for (const alt of row.alternates ?? []) st.keys.push({ epoch: row.epoch, changeHash: alt.changeHash, key: alt.key });
        }
      }
    }
    // Replay control packets: member lists in version order, then epoch changes, then grants.
    const decoded = control
      .map((row) => ({ row, packet: decodePacket(row.raw) }))
      .filter((x): x is { row: StoredControl; packet: MeshPacket } => !!x.packet);
    const order = (p: MeshPacket) =>
      p.type === PacketType.Members ? 0 : p.type === PacketType.EpochChange ? 1 : 2;
    const version = (p: MeshPacket) => (p.type === PacketType.Members ? (decodeMembers(p.payload)?.version ?? 0) : 0);
    const epoch = (p: MeshPacket) => (p.type === PacketType.EpochChange ? (decodeEpochChange(p.payload)?.newEpoch ?? 0) : 0);
    decoded.sort((a, b) => order(a.packet) - order(b.packet) || version(a.packet) - version(b.packet) || epoch(a.packet) - epoch(b.packet));
    for (const { row, packet } of decoded) {
      const st = this.priv.get(row.channelId);
      if (st) this.process(st, packet, row.raw, false);
    }
    this.retryPending(false);
  }

  /** Called for every joined channel, so private ones get their state. */
  track(c: JoinedChannel): void {
    if (isPrivateKind(c.manifest.kind)) this.ensure(c);
  }

  setPasswordKey(channelId: string, key: Uint8Array): void {
    this.passwordKeys.set(channelId, key);
    void this.deps.store
      ?.saveEpochKey({ channelId, epoch: 0, key, from: "password", receivedAt: this.deps.now() })
      .catch(() => {});
  }

  /** Forgets everything about a channel (after leaving it). */
  forget(channelId: string): void {
    this.passwordKeys.delete(channelId);
    const st = this.priv.get(channelId);
    this.priv.delete(channelId);
    this.pending = this.pending.filter((p) => p.channelId !== channelId);
    void this.deps.store?.deleteEpochKeys(channelId).catch(() => {});
    if (st) void this.deps.store?.deleteControl(this.controlEntries(st).map((e) => e.id)).catch(() => {});
  }

  /* ---------------- reading ---------------- */

  /** Keys for a locked channel, or undefined if I hold nothing for it. */
  keysFor(c: JoinedChannel): ChannelKeySet {
    if (c.manifest.kind === ChannelKind.Password) {
      const key = this.passwordKeys.get(c.id) ?? null;
      return { send: key, all: key ? [key] : [] };
    }
    const st = this.priv.get(c.id);
    if (!st) return { send: null, all: [] };
    const sorted = [...st.keys].sort((a, b) => b.epoch - a.epoch);
    const current = toHex(st.members.changeHash);
    const sendEntry = st.members.has(this.me)
      ? sorted.find((k) => k.epoch === st.members.epoch && k.changeHash === current)
      : undefined;
    return { send: sendEntry?.key ?? null, all: sorted.map((k) => k.key) };
  }

  members(channelId: string): Member[] {
    return this.priv.get(channelId)?.members.list() ?? [];
  }

  roleOf(channelId: string, key: string): Role | undefined {
    return this.priv.get(channelId)?.members.roleOf(key);
  }

  isMember(channelId: string, key: string = this.me): boolean {
    return this.priv.get(channelId)?.members.has(key) ?? false;
  }

  canAdmin(channelId: string, key: string = this.me): boolean {
    const st = this.priv.get(channelId);
    return !!st && st.members.has(key) && st.members.canAdmin(key);
  }

  /** How many control packets are waiting to be checked (for tests). */
  get pendingCount(): number {
    return this.pending.length;
  }

  epochStartedAt(channelId: string): number {
    return this.priv.get(channelId)?.epochStarted ?? 0;
  }

  /** How many keys I hold for a channel (to notice when new ones arrive). */
  keyCount(channelId: string): number {
    if (this.passwordKeys.has(channelId)) return 1;
    return this.priv.get(channelId)?.keys.length ?? 0;
  }

  myRole(channelId: string): Role | undefined {
    return this.priv.get(channelId)?.members.roleOf(this.me);
  }

  epoch(channelId: string): number {
    return this.priv.get(channelId)?.members.epoch ?? 0;
  }

  /** Control packets to send first in a SYNC reply. */
  controlFor(channelId: string): Uint8Array[] {
    const st = this.priv.get(channelId);
    return st ? this.controlEntries(st).map((e) => e.raw) : [];
  }

  /**
   * Handles a MEMBERS / EPOCH_CHANGE / KEY_GRANT packet. Returns true if it belongs to a private
   * channel I'm in (so the router keeps it), false if I should only pass it on.
   */
  receive(channel: JoinedChannel | undefined, packet: MeshPacket, raw: Uint8Array): boolean {
    const id = controlChannelId(packet.payload);
    if (!id || !channel || channel.id !== id) return false;
    if (packet.channelTag && toHex(packet.channelTag) !== id) return false;
    const st = this.priv.get(id);
    if (!st) return false;
    const result = this.process(st, packet, raw, true);
    if (result === "pending") this.addPending({ channelId: id, packet, raw, at: this.deps.now() });
    if (result === "applied") this.retryPending(true);
    return true;
  }

  /* ---------------- admin actions ---------------- */

  /** Sets up a private channel I just created: first key and a member list with just me. */
  initPrivate(c: JoinedChannel): void {
    const st = this.ensure(c);
    this.addKey(st, 0, toHex(GENESIS_HASH), randomBytes(32));
    this.persistKeys(st);
    this.publishMembers(st, {
      channelId: fromHex(st.id)!,
      epoch: 0,
      version: 1,
      members: [{ key: this.me, role: Role.Owner, joinedEpoch: 0 }],
    });
  }

  /** Adds someone (or changes nothing if they're in) and sends them the keys the history policy allows. */
  addMember(channelId: string, memberKey: string, role: Role = Role.Member): void {
    const st = this.need(channelId);
    if (!fromHex(memberKey) || fromHex(memberKey)!.length !== 32) throw new Error("bad member key");
    if (!st.members.has(memberKey) || st.members.roleOf(memberKey) !== role) this.change(st, memberKey, role);
    this.grantTo(st, memberKey, this.keysForNewMember(st));
  }

  setRole(channelId: string, memberKey: string, role: Role): void {
    const st = this.need(channelId);
    if (!st.members.has(memberKey)) throw new Error("not a member");
    this.change(st, memberKey, role);
  }

  /** Removes a member and moves everyone else to a new key the removed member never gets. */
  removeMember(channelId: string, memberKey: string): void {
    const st = this.need(channelId);
    if (!st.members.has(memberKey)) return;
    this.change(st, memberKey, undefined);
    this.rotate(channelId, EpochReason.Removed, [memberKey]);
  }

  /** Starts a new epoch and grants its key to every member. */
  rotate(channelId: string, reason: EpochReason = EpochReason.Rotate, removed: string[] = []): void {
    const st = this.need(channelId);
    if (!st.members.canAdmin(this.me)) throw new Error("only admins can change the key");
    const change = {
      channelId: fromHex(st.id)!,
      newEpoch: st.members.epoch + 1,
      prevChangeHash: st.members.changeHash,
      reason,
      removed,
    };
    const payload = encodeEpochChange(change);
    const hash = changeHash(this.deps.identity.publicKey, payload);
    const key = randomBytes(32);
    const sent = this.deps.sendControl(PacketType.EpochChange, payload, fromHex(st.id)!);
    st.members.applyEpochChange(change, hash);
    st.epochStarted = this.deps.now();
    this.keepChange(st, sent.id, sent.raw, change.newEpoch);
    this.addKey(st, change.newEpoch, toHex(hash), key);
    this.persistKeys(st);
    const entry = { epoch: change.newEpoch, changeHash: toHex(hash), key };
    for (const m of st.members.list()) if (m.key !== this.me) this.grantTo(st, m.key, [entry]);
    this.deps.onKeysChanged?.(st.id);
  }

  /* ---------------- internals ---------------- */

  private ensure(c: JoinedChannel): PrivateState {
    let st = this.priv.get(c.id);
    if (!st) {
      st = {
        id: c.id,
        manifest: c.manifest,
        members: new MembershipState(c.id, toHex(c.manifest.ownerKey)),
        keys: [],
        epochStarted: c.manifest.createdAt,
        chain: [],
        changes: [],
        grants: [],
      };
      this.priv.set(c.id, st);
    }
    return st;
  }

  private need(channelId: string): PrivateState {
    const st = this.priv.get(channelId);
    if (!st) throw new Error("not a private channel I'm in");
    return st;
  }

  private change(st: PrivateState, key: string, role: Role | undefined): void {
    const list = st.members.draftWith(key, role);
    this.publishMembers(st, list);
    st.intent = { key, role, version: list.version };
  }

  /**
   * After accepting someone else's list. If it replaced mine in a tie (same version), put my
   * change back on top. A newer version means others built on my change (or chose to undo it):
   * either way it's theirs to decide now.
   */
  private reapplyIntent(st: PrivateState, version: number): void {
    const intent = st.intent;
    if (!intent) return;
    if (version !== intent.version) {
      st.intent = undefined;
      return;
    }
    st.intent = undefined;
    const now = st.members.has(intent.key) ? st.members.roleOf(intent.key) : undefined;
    if (now === intent.role) return;
    try {
      this.change(st, intent.key, intent.role);
    } catch {
      // No longer allowed (e.g. my admin role was taken away).
    }
  }

  private publishMembers(st: PrivateState, list: MembersList): void {
    const verdict = st.members.checkMembers(list, this.me);
    if (verdict !== "ok") throw new Error(verdict === "unauthorized" ? "you can't make that change" : "invalid member list");
    const payload = encodeMembers(list);
    const sent = this.deps.sendControl(PacketType.Members, payload, fromHex(st.id)!);
    this.acceptMembers(st, list, this.me, changeHash(this.deps.identity.publicKey, payload), sent.id, sent.raw, true);
  }

  private acceptMembers(
    st: PrivateState,
    list: MembersList,
    signer: string,
    hash: Uint8Array,
    id: string,
    raw: Uint8Array,
    persist: boolean,
  ) {
    // A same-version list that won a tie replaces the one it beat in the chain.
    const replaced = st.chain.filter((c) => c.version === list.version);
    st.chain = st.chain.filter((c) => c.version !== list.version);
    if (replaced.length && persist) void this.deps.store?.deleteControl(replaced.map((r) => r.id)).catch(() => {});
    st.members.applyMembers(list, hash);
    // An owner-signed list proves itself, so older ones aren't needed any more.
    const dropped = signer === st.members.ownerKey ? st.chain.splice(0) : [];
    st.chain.push({ id, raw, version: list.version, signer });
    if (st.chain.length > MAX_CHAIN) dropped.push(...st.chain.splice(0, st.chain.length - MAX_CHAIN));
    if (persist) {
      this.saveControl(st.id, PacketType.Members, id, raw);
      if (dropped.length) void this.deps.store?.deleteControl(dropped.map((d) => d.id)).catch(() => {});
    }
    this.deps.onMembersChanged?.(st.id);
    // Being added or removed changes whether I can send.
    this.deps.onKeysChanged?.(st.id);
  }

  private keepChange(st: PrivateState, id: string, raw: Uint8Array, epoch: number, persist = true): void {
    st.changes.push({ id, raw, epoch });
    st.changes.sort((a, b) => a.epoch - b.epoch);
    const dropped = st.changes.splice(0, Math.max(0, st.changes.length - KEEP_CHANGES));
    if (persist) {
      this.saveControl(st.id, PacketType.EpochChange, id, raw);
      if (dropped.length) void this.deps.store?.deleteControl(dropped.map((d) => d.id)).catch(() => {});
    }
  }

  private keepGrant(st: PrivateState, id: string, raw: Uint8Array, recipient: string, maxEpoch: number, persist: boolean) {
    if (st.grants.some((g) => g.id === id)) return;
    st.grants.push({ id, raw, recipient, maxEpoch });
    const floor = st.members.epoch - (KEEP_EPOCHS_MIN - 1);
    const dropped = st.grants.filter((g) => g.maxEpoch < floor);
    st.grants = st.grants.filter((g) => g.maxEpoch >= floor);
    if (persist) {
      this.saveControl(st.id, PacketType.KeyGrant, id, raw);
      if (dropped.length) void this.deps.store?.deleteControl(dropped.map((d) => d.id)).catch(() => {});
    }
  }

  /** "applied" changed my state; "pending" might be valid once I have more of the history. */
  private process(st: PrivateState, packet: MeshPacket, raw: Uint8Array, persist: boolean): "applied" | "pending" | "ignored" {
    const signer = toHex(packet.senderKey);
    const id = toHex(packet.messageId);
    switch (packet.type) {
      case PacketType.Members: {
        const list = decodeMembers(packet.payload);
        if (!list) return "ignored";
        const hash = changeHash(packet.senderKey, packet.payload);
        const verdict = st.members.checkMembers(list, signer, hash);
        if (verdict === "unauthorized") return "pending";
        if (verdict !== "ok") return "ignored";
        this.acceptMembers(st, list, signer, hash, id, raw, persist);
        if (persist && signer !== this.me) this.reapplyIntent(st, list.version);
        return "applied";
      }
      case PacketType.EpochChange: {
        const change = decodeEpochChange(packet.payload);
        if (!change) return "ignored";
        const hash = changeHash(packet.senderKey, packet.payload);
        const verdict = st.members.checkEpochChange(change, signer, hash);
        if (verdict === "unauthorized") return "pending";
        if (verdict !== "newer" && verdict !== "tie_win") return "ignored";
        st.members.applyEpochChange(change, hash);
        st.epochStarted = packet.timestamp;
        this.keepChange(st, id, raw, change.newEpoch, persist);
        this.pruneKeys(st);
        this.deps.onKeysChanged?.(st.id);
        return "applied";
      }
      case PacketType.KeyGrant: {
        const grant = decodeGrant(packet.payload);
        if (!grant || !packet.recipientId) return "ignored";
        if (!st.members.canAdmin(signer)) return "pending";
        const recipient = toHex(packet.recipientId);
        const maxEpoch = Math.max(...grant.entries.map((e) => e.epoch));
        this.keepGrant(st, id, raw, recipient, maxEpoch, persist);
        if (recipient !== this.myFingerprint) return "applied";
        let added = false;
        for (const e of grant.entries) added = this.openEntry(st, e) || added;
        if (added) {
          this.pruneKeys(st);
          if (persist) this.persistKeys(st);
          this.deps.onKeysChanged?.(st.id);
        }
        return "applied";
      }
    }
    return "ignored";
  }

  private openEntry(st: PrivateState, e: GrantEntry): boolean {
    const key = openSealed(this.deps.identity, e.sealedKey);
    if (!key || key.length !== 32) return false;
    return this.addKey(st, e.epoch, toHex(e.changeHash), key);
  }

  /** Adds a key unless one is already held for that exact change. Returns true if added. */
  private addKey(st: PrivateState, epoch: number, hash: string, key: Uint8Array): boolean {
    if (st.keys.some((k) => k.epoch === epoch && k.changeHash === hash)) return false;
    st.keys.push({ epoch, changeHash: hash, key });
    return true;
  }

  /** Keeps the last 3 epochs, or more (up to 20) when new members may read older history. */
  private pruneKeys(st: PrivateState): void {
    const keep = st.manifest.historyPolicy === HistoryPolicy.SinceJoin ? KEEP_EPOCHS_MIN : KEEP_EPOCHS_MAX;
    const floor = st.members.epoch - (keep - 1);
    st.keys = st.keys.filter((k) => k.epoch >= floor);
  }

  private keysForNewMember(st: PrivateState): KeyEntry[] {
    const current = toHex(st.members.changeHash);
    const winners = new Map<number, KeyEntry>();
    for (const k of [...st.keys].sort((a, b) => a.epoch - b.epoch)) {
      // Per epoch, prefer the winning change's key (only known for the current epoch).
      if (!winners.has(k.epoch) || (k.epoch === st.members.epoch && k.changeHash === current)) winners.set(k.epoch, k);
    }
    const all = [...winners.values()];
    if (st.manifest.historyPolicy === HistoryPolicy.SinceJoin) return all.filter((k) => k.epoch === st.members.epoch);
    return all;
  }

  private grantTo(st: PrivateState, memberKey: string, entries: KeyEntry[]): void {
    if (entries.length === 0) return;
    const memberPub = fromHex(memberKey)!;
    const payload = encodeGrant({
      channelId: fromHex(st.id)!,
      entries: entries.map((e) => ({
        epoch: e.epoch,
        changeHash: fromHex(e.changeHash)!,
        sealedKey: seal(memberPub, e.key),
      })),
    });
    const recipient = fingerprintOf(memberPub);
    const sent = this.deps.sendControl(PacketType.KeyGrant, payload, fromHex(st.id)!, fromHex(recipient)!);
    this.keepGrant(st, sent.id, sent.raw, recipient, Math.max(...entries.map((e) => e.epoch)), true);
  }

  private addPending(p: Pending): void {
    if (this.pending.some((x) => toHex(x.packet.messageId) === toHex(p.packet.messageId))) return;
    const sender = toHex(p.packet.senderKey);
    const theirs = this.pending.filter((x) => toHex(x.packet.senderKey) === sender);
    if (theirs.length >= MAX_PENDING_PER_SENDER) this.pending.splice(this.pending.indexOf(theirs[0]), 1);
    this.pending.push(p);
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
  }

  /** Re-tries held packets after the state moved on (e.g. the signer has just been made admin). */
  private retryPending(persist: boolean): void {
    const cutoff = this.deps.now() - PENDING_TTL_MS;
    let progress = true;
    while (progress) {
      progress = false;
      for (const p of [...this.pending]) {
        const st = this.priv.get(p.channelId);
        if (!st || p.at < cutoff) {
          this.pending.splice(this.pending.indexOf(p), 1);
          continue;
        }
        const r = this.process(st, p.packet, p.raw, persist);
        if (r !== "pending") {
          this.pending.splice(this.pending.indexOf(p), 1);
          if (r === "applied") progress = true;
        }
      }
    }
  }

  private controlEntries(st: PrivateState): ControlEntry[] {
    return [...st.chain, ...st.changes, ...st.grants];
  }

  private saveControl(channelId: string, type: number, id: string, raw: Uint8Array): void {
    void this.deps.store?.saveControl({ id, channelId, type, raw }).catch(() => {});
  }

  private persistKeys(st: PrivateState): void {
    const store = this.deps.store;
    if (!store) return;
    const byEpoch = new Map<number, KeyEntry[]>();
    for (const k of st.keys) byEpoch.set(k.epoch, [...(byEpoch.get(k.epoch) ?? []), k]);
    void store
      .deleteEpochKeys(st.id)
      .then(async () => {
        for (const [epoch, [first, ...rest]] of byEpoch) {
          await store.saveEpochKey({
            channelId: st.id,
            epoch,
            key: first.key,
            changeHash: first.changeHash,
            alternates: rest.map((r) => ({ changeHash: r.changeHash, key: r.key })),
            from: "grant",
            receivedAt: this.deps.now(),
          });
        }
      })
      .catch(() => {});
  }
}

export function isPrivateKind(kind: ChannelKind): boolean {
  return kind === ChannelKind.Private || kind === ChannelKind.Hidden;
}
