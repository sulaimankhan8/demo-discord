import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import { lt, desc } from "drizzle-orm";
import { messageBuffer, recentMessages } from "../socket.js"; // 🔥 NEW

export async function getMessages(req, res) {
  try {
    const LIMIT = Math.min(Number(req.query.limit ?? 50), 100);
    const before = req.query.before ? BigInt(req.query.before) : null;

    /* ---------------- DB QUERY ---------------- */

     if (!before && recentMessages.length > 0) {
      const slice = recentMessages.slice(-LIMIT);
      return res.json({
        messages: slice,
        hasMore: true,
      });
    }

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
      .limit(LIMIT);

    if (before) {
      query = query.where(lt(messages.snowflake, before.toString()));
    }

    const dbMessages = await query;

    /* ---------------- IN-MEMORY (WAL) ---------------- */
    const buffered = Array.from(messageBuffer.values())
      .flat()
      .filter((m) => !before || BigInt(m.snowflake) < before)
      .map((m) => ({
        id: null,
        userId: m.userId,
        username: m.username,
        content: m.content,
        snowflake: m.snowflake.toString(),
        createdAt: m.createdAt,
      }));

    /* ---------------- MERGE & SORT ---------------- */
    const merged = [...dbMessages, ...buffered]
      .reduce((map, m) => {
        map.set(m.snowflake.toString(), m);
        return map;
      }, new Map())
      .values();

    const ordered = [...merged]
      .sort((a, b) =>
        BigInt(a.snowflake) > BigInt(b.snowflake) ? 1 : -1
      )
      .slice(-LIMIT)
      .map((m) => ({ ...m, snowflake: m.snowflake.toString() }));

    /* ---------------- START-OF-HISTORY FLAG ---------------- */
    const hasMore = ordered.length === LIMIT;

    res.json({
      messages: ordered,
      hasMore, // 🔥 CLIENT USES THIS
    });
  } catch (err) {
    console.error("[GET /messages]", err);
    res.status(500).json({ error: "Failed to load messages" });
  }
}
