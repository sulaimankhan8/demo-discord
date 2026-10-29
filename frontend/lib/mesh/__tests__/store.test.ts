// mesh-db schema and the v1 → v2 upgrade, run against an in-memory IndexedDB.

import "fake-indexeddb/auto";
import { openDB } from "idb";
import { describe, expect, it } from "vitest";
import { DB_VERSION, IdbMeshStore, LOBBY_TAG, MemoryMeshStore, openMeshDb, Stores } from "../store";

let dbCounter = 0;
const freshName = () => `mesh-db-test-${++dbCounter}`;

describe("mesh-db", () => {
  it("creates every v2 object store on a fresh install", async () => {
    const db = await openMeshDb(freshName());
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual(Object.values(Stores).sort());
    const tx = db.transaction([Stores.messages, Stores.carrier]);
    expect([...tx.objectStore(Stores.messages).indexNames].sort()).toEqual(["byChannel", "timestamp"]);
    expect([...tx.objectStore(Stores.carrier).indexNames]).toEqual(["byTag"]);
    db.close();
  });

  it("can be wiped completely", async () => {
    const name = freshName();
    const store = new IdbMeshStore(name);
    await store.saveContact({ key: "aa", nickname: "x", verified: true });
    await store.destroy();
    const again = new IdbMeshStore(name);
    expect(await again.loadContacts()).toEqual([]);
    await again.close();
  });

  it("upgrades a v1 database, keeping messages and moving them to the Lobby", async () => {
    const name = freshName();
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        const store = db.createObjectStore("messages", { keyPath: "id" });
        store.createIndex("timestamp", "timestamp");
      },
    });
    await v1.put("messages", { id: "aa", raw: new Uint8Array([1]), timestamp: 5, receivedAt: 5, hops: 1, mine: false });
    await v1.put("messages", { id: "bb", raw: new Uint8Array([2]), timestamp: 6, receivedAt: 6, hops: 0, mine: true });
    v1.close();

    const db = await openMeshDb(name);
    expect(db.objectStoreNames.contains(Stores.epochKeys)).toBe(true);
    const rows = await db.getAll(Stores.messages);
    expect(rows.map((r) => r.id).sort()).toEqual(["aa", "bb"]);
    for (const r of rows) expect(r.channelTag).toBe(LOBBY_TAG);
    const lobby = await db.getAllFromIndex(
      Stores.messages,
      "byChannel",
      IDBKeyRange.bound([LOBBY_TAG, 0], [LOBBY_TAG, Infinity]),
    );
    expect(lobby).toHaveLength(2);
    db.close();
  });

  it("saves, loads in time order and prunes", async () => {
    for (const store of [new IdbMeshStore(freshName()), new MemoryMeshStore()]) {
      const now = Date.now();
      const row = (id: string, timestamp: number) => ({
        id,
        raw: new Uint8Array([0]),
        channelTag: LOBBY_TAG,
        timestamp,
        receivedAt: timestamp,
        hops: 1,
        mine: false,
      });
      await store.save(row("b", now - 1000));
      await store.save(row("a", now - 2000));
      await store.save(row("old", now - 100_000));
      expect((await store.load()).map((m) => m.id)).toEqual(["old", "a", "b"]);
      await store.prune(() => ({ maxCount: 1, maxAgeMs: 50_000 }));
      expect((await store.load()).map((m) => m.id)).toEqual(["b"]);
      if (store instanceof IdbMeshStore) await store.close();
    }
  });
});
