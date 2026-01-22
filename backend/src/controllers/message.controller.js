import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import { desc } from "drizzle-orm";

export async function getMessages(req, res) {
  try {
    const data = await db
      .select()
      .from(messages)
      .orderBy(desc(messages.createdAt))
      .limit(50);

    res.json(data.reverse());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
