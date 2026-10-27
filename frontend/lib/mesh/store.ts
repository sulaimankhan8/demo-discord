// Local message history. Uses its own IndexedDB database ("mesh-db"), separate from
// everything Text Chat and Voice use.

import { openDB, type IDBPDatabase } from "idb";

export interface StoredMessage {
  id: string;
  raw: Uint8Array;
  timestamp: number;
  receivedAt: number;
  hops: number;
  mine: boolean;
}

export interface MeshStore {
  load(): Promise<StoredMessage[]>;
  save(message: StoredMessage): Promise<void>;
  prune(maxCount: number, maxAgeMs: number): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryMeshStore implements MeshStore {
  private items = new Map<string, StoredMessage>();

  async load(): Promise<StoredMessage[]> {
    return [...this.items.values()].sort((a, b) => a.timestamp - b.timestamp);
  }
  async save(message: StoredMessage): Promise<void> {
    this.items.set(message.id, message);
  }
  async prune(maxCount: number, maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    const keep = (await this.load()).filter((m) => m.timestamp >= cutoff).slice(-maxCount);
    this.items = new Map(keep.map((m) => [m.id, m]));
  }
  async clear(): Promise<void> {
    this.items.clear();
  }
}

const DB_NAME = "mesh-db";
const STORE = "messages";

export class IdbMeshStore implements MeshStore {
  private db: Promise<IDBPDatabase>;

  constructor() {
    this.db = openDB(DB_NAME, 1, {
      upgrade(db) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp");
      },
    });
  }

  async load(): Promise<StoredMessage[]> {
    return (await this.db).getAllFromIndex(STORE, "timestamp");
  }

  async save(message: StoredMessage): Promise<void> {
    await (await this.db).put(STORE, message);
  }

  async prune(maxCount: number, maxAgeMs: number): Promise<void> {
    const db = await this.db;
    const all: StoredMessage[] = await db.getAllFromIndex(STORE, "timestamp");
    const cutoff = Date.now() - maxAgeMs;
    const tooOld = all.filter((m) => m.timestamp < cutoff);
    const remaining = all.filter((m) => m.timestamp >= cutoff);
    const overflow = remaining.slice(0, Math.max(0, remaining.length - maxCount));
    const tx = db.transaction(STORE, "readwrite");
    for (const m of [...tooOld, ...overflow]) tx.store.delete(m.id);
    await tx.done;
  }

  async clear(): Promise<void> {
    await (await this.db).clear(STORE);
  }
}
