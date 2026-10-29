// Local mesh storage. Uses its own IndexedDB database ("mesh-db"), separate from
// everything Text Chat and Voice use. Schema: docs/10_MESH_CHANNELS_IMPLEMENTATION_PLAN.md §3.

import { deleteDB, openDB, type IDBPDatabase, type IDBPTransaction, type StoreNames } from "idb";
import { LOBBY_TAG } from "./packet";

/** Lobby messages have no channel tag. */
export { LOBBY_TAG };

export interface StoredMessage {
  id: string;
  raw: Uint8Array;
  /** Hex channel tag from the packet header; LOBBY_TAG for the Lobby. */
  channelTag: string;
  timestamp: number;
  receivedAt: number;
  hops: number;
  mine: boolean;
  /** False while an encrypted message waits for its key (C2/C3). Missing = plaintext. */
  decrypted?: boolean;
  /** DMs I sent: their text (only the recipient can open the sealed packet). */
  plain?: { nickname: string; text: string };
  /** `plain`, sealed with the device storage key (see vault.ts). */
  plainSealed?: Uint8Array;
  /** DMs I sent: the recipient confirmed it arrived. */
  delivered?: boolean;
}

/** Someone I've talked to directly; `verified` once fingerprints were compared in person. */
export interface StoredContact {
  key: string;
  nickname: string;
  verified: boolean;
  verifiedAt?: number;
}

export type ChannelRole = "owner" | "member";

export interface StoredChannel {
  channelId: string;
  /** Encoded, owner-signed manifest. */
  manifest: Uint8Array;
  role: ChannelRole;
  joinedAt: number;
  /** Timestamp of the newest message I've seen in this channel. */
  lastRead: number;
  muted: boolean;
  /** Set when I leave; the row stays until I delete it, so rejoining keeps settings. */
  left?: boolean;
}

export interface StoredEpochKey {
  channelId: string;
  /** 0 = the password key of a password channel, or a private channel's first key. */
  epoch: number;
  key: Uint8Array;
  /** Hex hash of the EPOCH_CHANGE this key belongs to (private channels). */
  changeHash?: string;
  /** Keys from losing changes for the same epoch, kept so their messages stay readable. */
  alternates?: { changeHash: string; key: Uint8Array }[];
  /** `key` and `alternates` are sealed with the device storage key (see vault.ts). */
  sealed?: boolean;
  /** Where it came from: "password", or (C3) the hex key of the admin who granted it. */
  from: string;
  receivedAt: number;
}

/** A MEMBERS, EPOCH_CHANGE or KEY_GRANT packet kept so it can be passed to members who missed it. */
export interface StoredControl {
  id: string;
  channelId: string;
  type: number;
  raw: Uint8Array;
}

/** A packet re-sent on every new link until it's answered or expires (join requests, later DMs). */
export interface StoredOutbox {
  id: string;
  channelId: string;
  raw: Uint8Array;
  expires: number;
}

/** A packet carried for a channel I'm not in (docs/10 C4). */
export interface StoredCarrier {
  id: string;
  /** Hex tag as it appears on the wire. */
  channelTag: string;
  raw: Uint8Array;
  receivedAt: number;
}

export interface RetentionLimit {
  maxCount: number;
  maxAgeMs: number;
}

/** Retention for each channel tag. maxCount 0 deletes everything in that channel. */
export type RetentionFor = (channelTag: string) => RetentionLimit;

export interface MeshStore {
  load(): Promise<StoredMessage[]>;
  save(message: StoredMessage): Promise<void>;
  prune(limits: RetentionFor): Promise<void>;
  clear(): Promise<void>;
  loadChannels(): Promise<StoredChannel[]>;
  saveChannel(channel: StoredChannel): Promise<void>;
  loadEpochKeys(): Promise<StoredEpochKey[]>;
  saveEpochKey(key: StoredEpochKey): Promise<void>;
  /** Forgets every key of a channel (after leaving it). */
  deleteEpochKeys(channelId: string): Promise<void>;
  loadControl(): Promise<StoredControl[]>;
  saveControl(row: StoredControl): Promise<void>;
  deleteControl(ids: string[]): Promise<void>;
  loadOutbox(): Promise<StoredOutbox[]>;
  saveOutbox(row: StoredOutbox): Promise<void>;
  deleteOutbox(ids: string[]): Promise<void>;
  loadCarrier(): Promise<StoredCarrier[]>;
  saveCarrier(row: StoredCarrier): Promise<void>;
  deleteCarrier(ids: string[]): Promise<void>;
  loadContacts(): Promise<StoredContact[]>;
  saveContact(row: StoredContact): Promise<void>;
  /** Deletes everything (panic wipe). The store can't be used afterwards. */
  destroy(): Promise<void>;
}

/** Which messages to delete under per-channel limits. `all` must be sorted by timestamp. */
export function messagesToPrune(all: StoredMessage[], limits: RetentionFor, now = Date.now()): StoredMessage[] {
  const byTag = new Map<string, StoredMessage[]>();
  for (const m of all) {
    const list = byTag.get(m.channelTag) ?? [];
    list.push(m);
    byTag.set(m.channelTag, list);
  }
  const out: StoredMessage[] = [];
  for (const [tag, list] of byTag) {
    const { maxCount, maxAgeMs } = limits(tag);
    const cutoff = now - maxAgeMs;
    const fresh = list.filter((m) => m.timestamp >= cutoff);
    out.push(...list.filter((m) => m.timestamp < cutoff));
    out.push(...fresh.slice(0, Math.max(0, fresh.length - maxCount)));
  }
  return out;
}

export class MemoryMeshStore implements MeshStore {
  private items = new Map<string, StoredMessage>();
  private channels = new Map<string, StoredChannel>();
  private keys = new Map<string, StoredEpochKey>();
  private control = new Map<string, StoredControl>();
  private outbox = new Map<string, StoredOutbox>();
  private carrier = new Map<string, StoredCarrier>();
  private contacts = new Map<string, StoredContact>();

  async load(): Promise<StoredMessage[]> {
    return [...this.items.values()].sort((a, b) => a.timestamp - b.timestamp);
  }
  async save(message: StoredMessage): Promise<void> {
    this.items.set(message.id, message);
  }
  async prune(limits: RetentionFor): Promise<void> {
    for (const m of messagesToPrune(await this.load(), limits)) this.items.delete(m.id);
  }
  async clear(): Promise<void> {
    this.items.clear();
  }
  async loadChannels(): Promise<StoredChannel[]> {
    return [...this.channels.values()].map((c) => ({ ...c }));
  }
  async saveChannel(channel: StoredChannel): Promise<void> {
    this.channels.set(channel.channelId, { ...channel });
  }
  async loadEpochKeys(): Promise<StoredEpochKey[]> {
    return [...this.keys.values()].map((k) => ({ ...k }));
  }
  async saveEpochKey(key: StoredEpochKey): Promise<void> {
    this.keys.set(`${key.channelId}/${key.epoch}`, { ...key });
  }
  async deleteEpochKeys(channelId: string): Promise<void> {
    for (const [k, v] of this.keys) if (v.channelId === channelId) this.keys.delete(k);
  }
  async loadControl(): Promise<StoredControl[]> {
    return [...this.control.values()].map((c) => ({ ...c }));
  }
  async saveControl(row: StoredControl): Promise<void> {
    this.control.set(row.id, { ...row });
  }
  async deleteControl(ids: string[]): Promise<void> {
    for (const id of ids) this.control.delete(id);
  }
  async loadOutbox(): Promise<StoredOutbox[]> {
    return [...this.outbox.values()].map((o) => ({ ...o }));
  }
  async saveOutbox(row: StoredOutbox): Promise<void> {
    this.outbox.set(row.id, { ...row });
  }
  async deleteOutbox(ids: string[]): Promise<void> {
    for (const id of ids) this.outbox.delete(id);
  }
  async loadCarrier(): Promise<StoredCarrier[]> {
    return [...this.carrier.values()].map((c) => ({ ...c }));
  }
  async saveCarrier(row: StoredCarrier): Promise<void> {
    this.carrier.set(row.id, { ...row });
  }
  async deleteCarrier(ids: string[]): Promise<void> {
    for (const id of ids) this.carrier.delete(id);
  }
  async loadContacts(): Promise<StoredContact[]> {
    return [...this.contacts.values()].map((c) => ({ ...c }));
  }
  async saveContact(row: StoredContact): Promise<void> {
    this.contacts.set(row.key, { ...row });
  }
  async destroy(): Promise<void> {
    for (const m of [this.items, this.channels, this.keys, this.control, this.outbox, this.carrier, this.contacts]) {
      (m as Map<string, unknown>).clear();
    }
  }
}

export const DB_NAME = "mesh-db";
export const DB_VERSION = 3;

/** Object store names. Only `messages` is used so far; the rest are filled in by steps C1–C6. */
export const Stores = {
  messages: "messages",
  channels: "channels",
  epochKeys: "epochKeys",
  control: "control",
  outbox: "outbox",
  carrier: "carrier",
  contacts: "contacts",
} as const;

/**
 * Creates or upgrades the schema. Exported so tests can run it against a fake IndexedDB.
 * v1 → v2: add the channel stores, index messages by channel, and move old messages to the Lobby.
 * v2 → v3: add contacts (C6).
 */
export function upgradeMeshDb(
  db: IDBPDatabase,
  oldVersion: number,
  tx: IDBPTransaction<unknown, StoreNames<unknown>[], "versionchange">,
): void {
  if (oldVersion < 1) {
    const messages = db.createObjectStore(Stores.messages, { keyPath: "id" });
    messages.createIndex("timestamp", "timestamp");
  }
  if (oldVersion < 2) {
    const messages = tx.objectStore(Stores.messages);
    messages.createIndex("byChannel", ["channelTag", "timestamp"]);
    db.createObjectStore(Stores.channels, { keyPath: "channelId" });
    db.createObjectStore(Stores.epochKeys, { keyPath: ["channelId", "epoch"] });
    db.createObjectStore(Stores.control, { keyPath: "id" });
    db.createObjectStore(Stores.outbox, { keyPath: "id" });
    const carrier = db.createObjectStore(Stores.carrier, { keyPath: "id" });
    carrier.createIndex("byTag", "channelTag");

    // v1 rows have no channelTag. Their packets are v1 and won't decode any more, so they are
    // skipped on load and age out with normal pruning; tagging them keeps the index complete.
    if (oldVersion >= 1) {
      void messages.openCursor().then(async function tag(cursor): Promise<void> {
        if (!cursor) return;
        const row = cursor.value as Partial<StoredMessage>;
        if (row.channelTag === undefined) await cursor.update({ ...row, channelTag: LOBBY_TAG });
        return tag(await cursor.continue());
      });
    }
  }
  if (oldVersion < 3) db.createObjectStore(Stores.contacts, { keyPath: "key" });
}

export function openMeshDb(name = DB_NAME): Promise<IDBPDatabase> {
  return openDB(name, DB_VERSION, {
    upgrade: (db, oldVersion, _newVersion, tx) => upgradeMeshDb(db, oldVersion, tx),
  });
}

export class IdbMeshStore implements MeshStore {
  private db: Promise<IDBPDatabase>;

  constructor(private readonly name = DB_NAME) {
    this.db = openMeshDb(name);
  }

  async loadContacts(): Promise<StoredContact[]> {
    return (await this.db).getAll(Stores.contacts);
  }

  async saveContact(row: StoredContact): Promise<void> {
    await (await this.db).put(Stores.contacts, row);
  }

  async destroy(): Promise<void> {
    (await this.db).close();
    await deleteDB(this.name);
  }

  async load(): Promise<StoredMessage[]> {
    return (await this.db).getAllFromIndex(Stores.messages, "timestamp");
  }

  async save(message: StoredMessage): Promise<void> {
    await (await this.db).put(Stores.messages, message);
  }

  async prune(limits: RetentionFor): Promise<void> {
    const db = await this.db;
    const all: StoredMessage[] = await db.getAllFromIndex(Stores.messages, "timestamp");
    const tx = db.transaction(Stores.messages, "readwrite");
    for (const m of messagesToPrune(all, limits)) tx.store.delete(m.id);
    await tx.done;
  }

  async loadChannels(): Promise<StoredChannel[]> {
    return (await this.db).getAll(Stores.channels);
  }

  async saveChannel(channel: StoredChannel): Promise<void> {
    await (await this.db).put(Stores.channels, channel);
  }

  async loadEpochKeys(): Promise<StoredEpochKey[]> {
    return (await this.db).getAll(Stores.epochKeys);
  }

  async saveEpochKey(key: StoredEpochKey): Promise<void> {
    await (await this.db).put(Stores.epochKeys, key);
  }

  async deleteEpochKeys(channelId: string): Promise<void> {
    const db = await this.db;
    const range = IDBKeyRange.bound([channelId, 0], [channelId, Number.MAX_SAFE_INTEGER]);
    await db.delete(Stores.epochKeys, range);
  }

  async loadControl(): Promise<StoredControl[]> {
    return (await this.db).getAll(Stores.control);
  }

  async saveControl(row: StoredControl): Promise<void> {
    await (await this.db).put(Stores.control, row);
  }

  async deleteControl(ids: string[]): Promise<void> {
    const tx = (await this.db).transaction(Stores.control, "readwrite");
    for (const id of ids) void tx.store.delete(id);
    await tx.done;
  }

  async loadOutbox(): Promise<StoredOutbox[]> {
    return (await this.db).getAll(Stores.outbox);
  }

  async saveOutbox(row: StoredOutbox): Promise<void> {
    await (await this.db).put(Stores.outbox, row);
  }

  async deleteOutbox(ids: string[]): Promise<void> {
    const tx = (await this.db).transaction(Stores.outbox, "readwrite");
    for (const id of ids) void tx.store.delete(id);
    await tx.done;
  }

  async loadCarrier(): Promise<StoredCarrier[]> {
    return (await this.db).getAll(Stores.carrier);
  }

  async saveCarrier(row: StoredCarrier): Promise<void> {
    await (await this.db).put(Stores.carrier, row);
  }

  async deleteCarrier(ids: string[]): Promise<void> {
    const tx = (await this.db).transaction(Stores.carrier, "readwrite");
    for (const id of ids) void tx.store.delete(id);
    await tx.done;
  }

  async clear(): Promise<void> {
    await (await this.db).clear(Stores.messages);
  }

  async close(): Promise<void> {
    (await this.db).close();
  }
}
