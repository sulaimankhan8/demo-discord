import { redis } from "../redis/index.js";
import { db } from "../db/index.js";
import { messageReactionCounts, messageReactions } from "../db/schema.js";
import { sql } from "drizzle-orm";

const STREAM = "stream:reactions";
const GROUP = "reaction-consumers";
const CONSUMER = `reaction-worker-${process.pid}`;

/* ---------------- CONFIG ---------------- */
const BATCH_SIZE = 500;
const FLUSH_INTERVAL = 100;
const MAX_CONCURRENT_FLUSHES = 1;

/* ---------------- METRICS ---------------- */
let totalProcessed = 0;
let totalFlushes = 0;

/* ---------------- STATE ---------------- */
const buffer = [];
let flushSemaphore = 0;

function parseFields(fields) {
  const obj = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

/* ---------------- STREAM SETUP ---------------- */
async function setupGroup() {
  try {
    await redis.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
    console.log(`[Reaction Worker] Consumer group "${GROUP}" created on "${STREAM}".`);
  } catch (err) {
    if (err.message.includes("BUSYGROUP")) {
      console.log(`[Reaction Worker] Consumer group "${GROUP}" already exists.`);
    } else {
      console.error(`[Reaction Worker] Setup error:`, err);
    }
  }
}

/* ---------------- FLUSH BATCH TO DB ---------------- */
async function flushReactions() {
  if (flushSemaphore >= MAX_CONCURRENT_FLUSHES) return;
  if (buffer.length === 0) return;

  flushSemaphore++;
  let batch = [];

  try {
    batch = buffer.splice(0, BATCH_SIZE);
    const streamIds = batch.map((item) => item.streamId);

    // 1. In-memory collapse deltas: key -> delta
    const deltaMap = new Map(); // "snowflake:emoji" -> delta
    const auditRows = [];

    for (const item of batch) {
      if (!item.snowflake || !item.emoji) continue;

      const key = `${item.snowflake}:${item.emoji}`;
      const isAdded = item.action === "ADDED";
      const delta = isAdded ? 1 : -1;

      const current = deltaMap.get(key) || 0;
      deltaMap.set(key, current + delta);

      auditRows.push({
        messageSnowflake: item.snowflake,
        userId: item.userId || "anonymous",
        emojiCode: item.emoji,
        action: item.action,
        createdAt: item.timestamp ? new Date(Number(item.timestamp)) : new Date(),
      });
    }

    // 2. Bulk UPSERT counts into PostgreSQL
    for (const [key, delta] of deltaMap.entries()) {
      if (delta === 0) continue;
      const [snowflake, emoji] = key.split(":");

      await db
        .insert(messageReactionCounts)
        .values({
          messageSnowflake: snowflake,
          emojiCode: emoji,
          count: Math.max(0, delta),
        })
        .onConflictDoUpdate({
          target: [
            messageReactionCounts.messageSnowflake,
            messageReactionCounts.emojiCode,
          ],
          set: {
            count: sql`GREATEST(0, ${messageReactionCounts.count} + ${delta})`,
          },
        });
    }

    // 3. Bulk Insert audit trail
    if (auditRows.length > 0) {
      await db.insert(messageReactions).values(auditRows);
    }

    // 4. Acknowledge processed stream IDs
    if (streamIds.length > 0) {
      await redis.xack(STREAM, GROUP, ...streamIds);
    }

    totalProcessed += batch.length;
    totalFlushes++;
  } catch (err) {
    console.error("[Reaction Worker] Flush error:", err);
  } finally {
    flushSemaphore--;
  }
}

/* ---------------- CONSUME LOOP ---------------- */
async function startConsumer() {
  await setupGroup();
  console.log(`[Reaction Worker] Consumer active (${CONSUMER}). Listening on ${STREAM}...`);

  setInterval(flushReactions, FLUSH_INTERVAL);

  while (true) {
    try {
      const response = await redis.xreadgroup(
        "GROUP", GROUP, CONSUMER,
        "BLOCK", "1000",
        "COUNT", String(BATCH_SIZE),
        "STREAMS", STREAM, ">"
      );

      if (!response || response.length === 0) continue;

      const [streamKey, entries] = response[0];
      for (const [streamId, fields] of entries) {
        const parsed = parseFields(fields);
        buffer.push({
          streamId,
          ...parsed,
        });
      }

      if (buffer.length >= BATCH_SIZE) {
        await flushReactions();
      }
    } catch (err) {
      console.error("[Reaction Worker] Read loop error:", err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

startConsumer().catch(console.error);
