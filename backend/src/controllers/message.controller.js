import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { messageBuffer } from "../socket.js";

export async function getMessages(req, res) {
  try {
    const limit = Number(req.query.limit ?? 50);
    const before = req.query.before ? Number(req.query.before) : null;

    const dbMessages = await db.execute(sql`
      SELECT
        m.id,
        m.user_id AS "userId",
        m.username,
        m.content,
        m.snowflake,
        m.created_at AS "createdAt",
        COALESCE(
          jsonb_object_agg(c.emoji_code, c.count)
          FILTER (WHERE c.emoji_code IS NOT NULL),
          '{}'::jsonb
        ) AS reactions
      FROM messages m
      LEFT JOIN message_reaction_counts c
        ON c.message_id = m.id
      ${before ? sql`WHERE m.snowflake < ${before}` : sql``}
      GROUP BY m.id
      ORDER BY m.snowflake DESC
      LIMIT ${limit}
    `);

    const buffered = messageBuffer
      .filter((m) => !before || m.snowflake < before)
      .map((m) => ({
        id: null,
        userId: m.userId,
        username: m.username,
        content: m.content,
        snowflake: m.snowflake,
        createdAt: m.createdAt,
        reactions: {},
      }));

    const merged = [...dbMessages.rows, ...buffered]
      .reduce((map, m) => {
        map.set(m.snowflake, m);
        return map;
      }, new Map())
      .values();

    const ordered = [...merged]
      .sort((a, b) => a.snowflake - b.snowflake)
      .slice(-limit);

    res.json(ordered);
  } catch (err) {
    console.error("[GET /messages]", err);
    res.status(500).json({ error: "Failed to load messages" });
  }
}
