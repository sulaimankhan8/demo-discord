import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import { lt, desc } from "drizzle-orm";
import { messageBuffer, recentMessages } from "../socket.js"; // 🔥 NEW

export async function getMessages(req, res) {
  try {
    const LIMIT = Math.min(Number(req.query.limit ?? 50), 100);
    const before = req.query.before ? BigInt(req.query.before) : null;

    /* ---------------- DB QUERY ---------------- */



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
    const walMessages  = Array.from(messageBuffer.values())
      .flat()
      .filter((m) => !before || BigInt(m.snowflake) < before)
      .map((m) => ({
        id: m.id ?? null,
        userId: m.userId,
        username: m.username,
        content: m.content,
        snowflake: m.snowflake.toString(),
        createdAt: m.createdAt,
      }));

      /* ---------------- RECENT CACHE (hot accelerator) ---------------- */

    const recent = recentMessages
      .filter(m => !before || BigInt(m.snowflake) < before)
      .map(m => ({
        ...m,
        id: null,
      }));

    /* ---------------- MERGE & SORT ---------------- */
    const mergedMap = new Map();

    for (const m of [...dbMessages, ...walMessages, ...recent]) {
      mergedMap.set(m.snowflake.toString(), m);
    }

    const ordered = [...mergedMap.values()]
  .sort((a, b) =>
    BigInt(a.snowflake) > BigInt(b.snowflake) ? 1 : -1
  )
  .slice(-LIMIT)
  .map((m) => ({
    ...m,
    snowflake: m.snowflake.toString(),
    delivered: !!m.id, // 🔥 THIS LINE
  }));


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
