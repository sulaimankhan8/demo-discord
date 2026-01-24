import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import { lt, desc } from "drizzle-orm";
import { messageBuffer } from "../socket.js";

export async function getMessages(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 100);
    const before = req.query.before
      ? BigInt(req.query.before)
      : null;

    let query = db
      .select({
        id: messages.id,
        userId: messages.userId,
        username: messages.username,
        content: messages.content,
        snowflake: messages.snowflake,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .orderBy(desc(messages.snowflake))
      .limit(limit);

    if (before) {
  query = query.where(
    lt(messages.snowflake, before.toString())
  );
}


    const dbMessages = await query;

    const buffered = Array.from(messageBuffer.values())
  .flat()
  .filter((m) => !before || BigInt(m.snowflake) < before)
  .map((m) => ({
    id: null, // not persisted yet
    userId: m.userId,
    username: m.username,
    content: m.content,
    snowflake: m.snowflake.toString(),
    createdAt: m.createdAt,
  }));


    const merged = [...dbMessages, ...buffered]
      .reduce((map, m) => {
        map.set(m.snowflake, m);
        return map;
      }, new Map())
      .values();

    const ordered = [...merged]
  .sort((a, b) =>
    BigInt(a.snowflake) > BigInt(b.snowflake) ? 1 : -1
  )
  .slice(-limit)
  .map((m) => ({
    ...m,
    snowflake: m.snowflake.toString(), // ✅ FIX
  }));

res.json(ordered);
  } catch (err) {
    console.error("[GET /messages]", err);
    res.status(500).json({ error: "Failed to load messages" });
  }
}