// Direct messages (docs/10 C6): conversations, the DM outbox, delivery receipts and contacts.
//
// A DM is flooded like any packet, but only its recipient can open it. Until the recipient's
// ACK comes back it stays in the outbox (12 h) and is re-sent on every new link, so it gets
// through once the recipient (or a phone that carries it) is back in range. Phones in between
// carry it by the recipient's mailbox tag; the recipient asks for that tag in SYNC.

import { fromHex, toHex } from "../bytes";
import { fingerprintOf, type MeshIdentity } from "../identity";
import type { MeshChatMessage } from "../MeshService";
import { decodePacket, encodePacket, MAX_TTL, PacketType, type MeshPacket } from "../packet";
import type { MeshRouter, SyncWant } from "../router";
import type { MeshStore, StoredContact, StoredMessage } from "../store";
import { mailboxTag, mailboxTagHex, openDirect, sealDirect } from "./directCrypto";

export const DM_PREFIX = "dm:";
export const DM_OUTBOX_TTL_MS = 12 * 60 * 60_000;
export const DM_RETENTION = { maxCount: 500, maxAgeMs: 7 * 24 * 60 * 60_000 };
const MAX_UI_MESSAGES = 500;
const REACK_COOLDOWN_MS = 30_000;
/** Mailboxes of this many recent conversations may be uploaded to the bridge (for ACKs). */
const BRIDGE_PEERS = 50;

export type DmStatus = "sending" | "delivered" | "failed";

export interface MeshDirectInfo {
  /** "dm:<hex key>": use as the active channel ID. */
  id: string;
  key: string;
  fingerprint: string;
  nickname: string;
  unread: number;
  verified: boolean;
  lastMessageAt: number;
}

interface Conversation {
  peer: string;
  nickname: string;
  messages: MeshChatMessage[];
  lastRead: number;
}

interface OutboxEntry {
  peer: string;
  tag: string;
  raw: Uint8Array;
  expires: number;
}

export interface DirectDeps {
  identity: MeshIdentity;
  router: MeshRouter;
  store?: MeshStore;
  now: () => number;
  nickname: () => string;
  nextSeq: (bucket: string) => number;
  /** A nickname heard in announces, for people I haven't messaged yet. */
  peerName: (key: string) => string | undefined;
  emit: () => void;
  /** Outbox or conversations changed: the bridge's tags may need updating. */
  tagsChanged: () => void;
}

export function dmId(peer: string): string {
  return DM_PREFIX + peer;
}

export function isDmId(id: string): boolean {
  return id.startsWith(DM_PREFIX);
}

export class DirectMessages {
  private convs = new Map<string, Conversation>();
  private outbox = new Map<string, OutboxEntry>();
  private contacts = new Map<string, StoredContact>();
  private reacked = new Map<string, number>();
  private readonly me: string;
  private readonly myTag: Uint8Array;

  constructor(private readonly deps: DirectDeps) {
    this.me = toHex(deps.identity.publicKey);
    this.myTag = mailboxTag(deps.identity.publicKey);
  }

  /* ---------------- loading ---------------- */

  load(messages: StoredMessage[], contacts: StoredContact[], outbox: { id: string; channelId: string; raw: Uint8Array; expires: number }[]) {
    for (const c of contacts) this.contacts.set(c.key, c);
    const t = this.deps.now();
    for (const o of outbox) {
      if (!isDmId(o.channelId) || o.expires < t) continue;
      const peer = o.channelId.slice(DM_PREFIX.length);
      this.outbox.set(o.id, { peer, tag: mailboxTagHex(fromHex(peer)!), raw: o.raw, expires: o.expires });
    }
    for (const row of messages) {
      if (!isDmId(row.channelTag)) continue;
      const peer = row.channelTag.slice(DM_PREFIX.length);
      const conv = this.conv(peer);
      if (row.mine) {
        if (!row.plain) continue;
        const status: DmStatus = row.delivered ? "delivered" : this.outbox.has(row.id) ? "sending" : "failed";
        this.add(conv, { id: row.id, fingerprint: this.deps.identity.fingerprint, nickname: row.plain.nickname, text: row.plain.text, timestamp: row.timestamp, hops: 0, mine: true, status });
        continue;
      }
      const packet = decodeSafe(row.raw);
      const body = packet && openDirect(this.deps.identity, packet.senderKey, packet.messageId, packet.payload);
      if (!packet || !body) continue;
      conv.nickname = body.nickname;
      this.add(conv, {
        id: row.id,
        fingerprint: fingerprintOf(packet.senderKey),
        nickname: body.nickname,
        text: body.text,
        timestamp: row.timestamp,
        hops: row.hops,
        mine: false,
      });
    }
    // Saved conversations count as read.
    for (const c of this.convs.values()) c.lastRead = c.messages.at(-1)?.timestamp ?? 0;
  }

  /* ---------------- sending ---------------- */

  /** Starts (or reopens) a conversation with someone, by their hex public key. */
  open(peer: string, nickname?: string): string {
    if (!fromHex(peer) || fromHex(peer)!.length !== 32 || peer === this.me) throw new Error("bad contact");
    const conv = this.conv(peer);
    if (nickname) conv.nickname = nickname;
    this.deps.tagsChanged(); // the bridge may now upload to their mailbox
    return dmId(peer);
  }

  send(peer: string, text: string): void {
    const peerKey = fromHex(peer)!;
    const conv = this.conv(peer);
    this.deps.tagsChanged(); // before sending, so the bridge lets it out
    const nickname = this.deps.nickname();
    const senderSeq = this.deps.nextSeq(dmId(peer));
    const sent = this.deps.router.sendDirect(PacketType.Direct, fromHex(fingerprintOf(peerKey))!, mailboxTag(peerKey), (mid) =>
      sealDirect(this.deps.identity, peerKey, mid, { senderSeq, nickname, text }),
    );
    const now = this.deps.now();
    const entry = { peer, tag: mailboxTagHex(peerKey), raw: sent.raw, expires: now + DM_OUTBOX_TTL_MS };
    this.outbox.set(sent.id, entry);
    this.add(conv, {
      id: sent.id,
      fingerprint: this.deps.identity.fingerprint,
      nickname,
      text,
      timestamp: now,
      hops: 0,
      mine: true,
      status: "sending",
    });
    conv.lastRead = now;
    const store = this.deps.store;
    void store?.saveOutbox({ id: sent.id, channelId: dmId(peer), raw: sent.raw, expires: entry.expires }).catch(() => {});
    void store
      ?.save({ id: sent.id, raw: sent.raw, channelTag: dmId(peer), timestamp: now, receivedAt: now, hops: 0, mine: true, plain: { nickname, text } })
      .catch(() => {});
    this.deps.tagsChanged();
    this.deps.emit();
  }

  /** Re-sends waiting DMs on a new link; ones that waited 12 h give up. */
  flush(linkId: string): void {
    const t = this.deps.now();
    for (const [id, o] of this.outbox) {
      if (o.expires < t) {
        this.drop(id);
        this.setStatus(o.peer, id, "failed");
      } else {
        this.deps.router.resend(linkId, o.raw);
      }
    }
  }

  /* ---------------- receiving ---------------- */

  onDirect(packet: MeshPacket): void {
    if (packet.type === PacketType.Ack) return this.onAck(packet);
    const body = openDirect(this.deps.identity, packet.senderKey, packet.messageId, packet.payload);
    if (!body) return;
    const peer = toHex(packet.senderKey);
    const conv = this.conv(peer);
    conv.nickname = body.nickname;
    const id = toHex(packet.messageId);
    const hops = Math.max(1, MAX_TTL - packet.ttl + 1);
    const fresh = this.add(conv, {
      id,
      fingerprint: fingerprintOf(packet.senderKey),
      nickname: body.nickname,
      text: body.text,
      timestamp: packet.timestamp,
      hops,
      mine: false,
    });
    this.deps.tagsChanged(); // the receipt goes to their mailbox
    this.sendAck(packet);
    const contact = this.contacts.get(peer);
    if (!contact || contact.nickname !== body.nickname) this.saveContact({ key: peer, nickname: body.nickname, verified: contact?.verified ?? false, verifiedAt: contact?.verifiedAt });
    if (fresh) {
      const now = this.deps.now();
      void this.deps.store
        ?.save({ id, raw: encodePacket(packet), channelTag: dmId(peer), timestamp: packet.timestamp, receivedAt: now, hops, mine: false })
        .catch(() => {});
    }
    this.deps.tagsChanged();
    this.deps.emit();
  }

  /** The sender re-sent a DM I already have: my ACK probably got lost, so send it again. */
  onDirectDuplicate(packet: MeshPacket): void {
    if (!openDirect(this.deps.identity, packet.senderKey, packet.messageId, packet.payload)) return;
    const id = toHex(packet.messageId);
    const last = this.reacked.get(id) ?? -Infinity;
    if (this.deps.now() - last < REACK_COOLDOWN_MS) return;
    this.reacked.set(id, this.deps.now());
    if (this.reacked.size > 1000) this.reacked.clear();
    this.sendAck(packet);
  }

  private sendAck(dm: MeshPacket): void {
    this.deps.router.sendDirect(PacketType.Ack, fromHex(fingerprintOf(dm.senderKey))!, mailboxTag(dm.senderKey), () =>
      dm.messageId.slice(),
    );
  }

  private onAck(packet: MeshPacket): void {
    if (packet.payload.length !== 8) return;
    const id = toHex(packet.payload);
    const entry = this.outbox.get(id);
    // Only the person I wrote to can confirm it.
    if (!entry || entry.peer !== toHex(packet.senderKey)) return;
    this.drop(id);
    this.setStatus(entry.peer, id, "delivered");
    this.deps.tagsChanged();
    this.deps.emit();
  }

  /* ---------------- state ---------------- */

  has(id: string): boolean {
    return isDmId(id) && this.convs.has(id.slice(DM_PREFIX.length));
  }

  messages(id: string): MeshChatMessage[] {
    return this.convs.get(id.slice(DM_PREFIX.length))?.messages ?? [];
  }

  markRead(id: string): void {
    const c = this.convs.get(id.slice(DM_PREFIX.length));
    if (c) c.lastRead = Math.max(c.lastRead, c.messages.at(-1)?.timestamp ?? 0);
  }

  list(): MeshDirectInfo[] {
    return [...this.convs.values()]
      .map((c) => ({
        id: dmId(c.peer),
        key: c.peer,
        fingerprint: fingerprintOf(fromHex(c.peer)!),
        nickname: c.nickname || this.deps.peerName(c.peer) || `#${fingerprintOf(fromHex(c.peer)!).slice(0, 4)}`,
        unread: c.messages.filter((m) => !m.mine && m.timestamp > c.lastRead).length,
        verified: this.contacts.get(c.peer)?.verified ?? false,
        lastMessageAt: c.messages.at(-1)?.timestamp ?? 0,
      }))
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.nickname.localeCompare(b.nickname));
  }

  isVerified(peer: string): boolean {
    return this.contacts.get(peer)?.verified ?? false;
  }

  /** Marks a contact verified after comparing fingerprints in person (or clears it). */
  setVerified(peer: string, verified: boolean): void {
    const c = this.contacts.get(peer);
    this.saveContact({
      key: peer,
      nickname: c?.nickname ?? this.convs.get(peer)?.nickname ?? this.deps.peerName(peer) ?? "",
      verified,
      verifiedAt: verified ? this.deps.now() : undefined,
    });
    this.deps.emit();
  }

  /** What to ask for in SYNC: my mailbox. */
  syncWant(): SyncWant {
    return { tag: this.myTag, bucket: toHex(this.myTag) };
  }

  /** Waiting DMs with this mailbox tag, for SYNC replies. */
  outboxForTag(tag: string): Uint8Array[] {
    return [...this.outbox.values()].filter((o) => o.tag === tag).map((o) => o.raw);
  }

  /** Internet bridge: subscribe to my mailbox; upload to recent contacts' mailboxes. */
  bridgeTags(): { subscribe: string[]; upload: string[] } {
    const recent = this.list().slice(0, BRIDGE_PEERS).map((c) => mailboxTagHex(fromHex(c.key)!));
    const pending = [...this.outbox.values()].map((o) => o.tag);
    return { subscribe: [toHex(this.myTag)], upload: [...new Set([...pending, ...recent])] };
  }

  /* ---------------- internals ---------------- */

  private conv(peer: string): Conversation {
    let c = this.convs.get(peer);
    if (!c) {
      c = { peer, nickname: this.contacts.get(peer)?.nickname ?? this.deps.peerName(peer) ?? "", messages: [], lastRead: 0 };
      this.convs.set(peer, c);
    }
    return c;
  }

  /** Adds a message (sorted, deduped). Returns false if it was already there. */
  private add(conv: Conversation, msg: MeshChatMessage): boolean {
    if (conv.messages.some((m) => m.id === msg.id)) return false;
    const next = [...conv.messages, msg];
    if (next.length > 1 && msg.timestamp < next[next.length - 2].timestamp) {
      next.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    }
    conv.messages = next.slice(-MAX_UI_MESSAGES);
    return true;
  }

  private setStatus(peer: string, id: string, status: DmStatus): void {
    const conv = this.convs.get(peer);
    if (!conv) return;
    conv.messages = conv.messages.map((m) => (m.id === id ? { ...m, status } : m));
    if (status === "delivered") {
      const m = conv.messages.find((x) => x.id === id);
      if (m) {
        void this.deps.store
          ?.save({
            id,
            raw: new Uint8Array(),
            channelTag: dmId(peer),
            timestamp: m.timestamp,
            receivedAt: m.timestamp,
            hops: 0,
            mine: true,
            plain: { nickname: m.nickname, text: m.text },
            delivered: true,
          })
          .catch(() => {});
      }
    }
  }

  private drop(id: string): void {
    this.outbox.delete(id);
    void this.deps.store?.deleteOutbox([id]).catch(() => {});
  }

  private saveContact(c: StoredContact): void {
    this.contacts.set(c.key, c);
    void this.deps.store?.saveContact(c).catch(() => {});
  }
}

function decodeSafe(raw: Uint8Array): MeshPacket | null {
  try {
    return decodePacket(raw);
  } catch {
    return null;
  }
}
