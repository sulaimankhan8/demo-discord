import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import { lt, desc } from "drizzle-orm";
//import {  recentMessages } from "../socket.js"; // 🔥 NEW
import { getRecentMessages } from "../redis/chatCache.js";
import { getBulkMessageReactions } from "../redis/reactions/reactionService.js";

export async function getMessages(req, res) {
  try {
    const LIMIT = Math.min(Number(req.query.limit ?? 50), 100);
    const rawBefore = typeof req.query.before === "string" ? req.query.before.trim() : null;
    let before = null;
    if (rawBefore) {
      if (!/^\d+$/.test(rawBefore)) {
        return res.status(400).json({ error: "Invalid 'before' cursor parameter. Expected numeric Snowflake ID." });
      }
      before = BigInt(rawBefore);
    }

    /* ---------------- DB SHORT-CIRCUIT (no pagination + recent cache full + no WAL) ---------------- */
    const redisRecent = !before ? await getRecentMessages( LIMIT ) : [];
    
    const canSkipDb = !before && redisRecent.length >= LIMIT;

    if (canSkipDb) {
      const snowflakes = redisRecent.map((m) => m.snowflake.toString());
      const reactionsMap = await getBulkMessageReactions(snowflakes);

      return res.json({
        messages: redisRecent.map((m) => ({
          ...m,
          snowflake: m.snowflake.toString(),
          delivered: true,
          reactions: reactionsMap.get(m.snowflake.toString()) || [],
        })),
        hasMore: true,
      });
    }

  


//     console.log(
//  recentMessages.length
// );

console.log(
 redisRecent.length
);
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
    // const walMessages  = Array.from(messageBuffer.values())
    //   .flat()
    //   .filter((m) => !before || BigInt(m.snowflake) < before)
    //   .map((m) => ({
    //     id: m.id ?? null,
    //     userId: m.userId,
    //     username: m.username,
    //     content: m.content,
    //     snowflake: m.snowflake.toString(),
    //     createdAt: m.createdAt,
    //   }));

      /* ---------------- RECENT CACHE (hot accelerator) ---------------- */

    const recent =
  redisRecent
    .filter(
      (m) =>
        !before ||
        BigInt(
          m.snowflake
        ) < before
    )
    .map((m) => ({
      ...m,
      id: null,
    }));

    /* ---------------- MERGE & SORT (DB wins > WAL > recent) ---------------- */
    const mergedMap = new Map();

    // Merge order: recent < WAL < DB (ensures DB is source of truth)
    for (const m of [...recent,  ...dbMessages]) {
      mergedMap.set(m.snowflake.toString(), m);
    }

    const orderedSnowflakes = [...mergedMap.values()]
      .sort((a, b) => (BigInt(a.snowflake) > BigInt(b.snowflake) ? 1 : -1))
      .slice(-LIMIT)
      .map((m) => m.snowflake.toString());

    const reactionsMap = await getBulkMessageReactions(orderedSnowflakes);

    const ordered = [...mergedMap.values()]
      .sort((a, b) => (BigInt(a.snowflake) > BigInt(b.snowflake) ? 1 : -1))
      .slice(-LIMIT)
      .map((m) => {
        const sf = m.snowflake.toString();
        return {
          ...m,
          snowflake: sf,
          delivered: !!m.id,
          reactions: reactionsMap.get(sf) || [],
        };
      });

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
