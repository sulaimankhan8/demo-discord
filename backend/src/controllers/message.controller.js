import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import { desc } from "drizzle-orm";
import { messageBuffer } from "../socket.js";

export async function getMessages(req, res) {
  try {
    console.log("[GET /messages] request");

    const dbMessages = await db
      .select()
      .from(messages)
      .orderBy(desc(messages.snowflake))
      .limit(50);

    

    const buffered = messageBuffer.slice(-50);

    

    const merged = [...dbMessages, ...buffered]
      .reduce((map, msg) => {
        map.set(msg.snowflake, msg);
        return map;
      }, new Map())
      .values();

    const ordered = [...merged]
      .sort((a, b) => a.snowflake - b.snowflake)
      .slice(-50);

   

    res.json(ordered);
  } catch (error) {
    console.error("[GET /messages ERROR]", error.message);
    res.status(500).json({ error: error.message });
  }
}
