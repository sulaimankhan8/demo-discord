import { redis } from "../redis/index.js";
import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import {
  publishMessageCreated,
} from "../events/publishers/message.publisher.js";
import {
  pushRecentMessages,
} from "../redis/chatCache.js";
import { CHANNELS } from "../redis/pubsub/channels.js";

const STREAM = "stream:messages";
const GROUP = "message-consumers";
const CONSUMER = `worker-${process.pid}`;

/* ---------------- CONFIG ---------------- */
const BATCH_SIZE = 1000;
const FLUSH_INTERVAL = 50;
const PRESSURE_FLUSH_AGE = 200;
const MAX_CONCURRENT_FLUSHES = 1; // ✅ Single flush for PostgreSQL
const RECOVERY_IDLE_TIME = 10000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeUserId(userId) {
  if (typeof userId === "string" && UUID_REGEX.test(userId)) {
    return userId;
  }
  return "00000000-0000-0000-0000-000000000000";
}

/* ---------------- METRICS ---------------- */
let totalRead = 0;
let totalInserted = 0;
let totalDuplicates = 0;
let totalAcked = 0;
let totalFlushes = 0;
let startTime = Date.now();
let lastReadTime = Date.now();

/* ---------------- STATE ---------------- */
const buffer = [];
let flushSemaphore = 0;
let oldestMessageTime = Date.now();

/* ---------------- HELPERS ---------------- */
function parseFields(fields) {
  const obj = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

function safeParseDate(dateString) {
  if (!dateString) return new Date();
  const dt = new Date(dateString);
  if (isNaN(dt.getTime())) return new Date();
  return dt;
}

async function moveToDLQ(message, reason) {
  try {
    await redis.lpush('dlq:consumer:bad_messages', JSON.stringify({
      ...message,
      failedAt: new Date().toISOString(),
      reason: reason,
      consumer: CONSUMER,
    }));
  } catch {
    // intentionally ignored
  }
}

/* ---------------- FLUSH ---------------- */
async function flushMessages() {
  if (flushSemaphore >= MAX_CONCURRENT_FLUSHES) return;
  if (buffer.length === 0) return;

  flushSemaphore++;
  let batch = [];

  try {
    batch = buffer.splice(0, BATCH_SIZE);

    const validMessages = [];
    const invalidMessages = [];

    for (const msg of batch) {
      if (!msg.snowflake || !msg.userId) {
        invalidMessages.push(msg);
        await moveToDLQ(msg, 'Missing required fields (snowflake or userId)');
      } else {
        validMessages.push(msg);
      }
    }

    if (validMessages.length === 0) {
      const streamIds = batch.map((m) => m.streamId);
      await redis.xack(STREAM, GROUP, ...streamIds);
      totalAcked += batch.length;
      return;
    }

    const inserted = await db
      .insert(messages)
      .values(
        validMessages.map((m) => ({
          userId: normalizeUserId(m.userId),
          snowflake: m.snowflake,
          username: m.username || 'unknown',
          content: m.content || '',
          createdAt: m.createdAt instanceof Date ? m.createdAt : safeParseDate(m.createdAt),
        }))
      )
      .onConflictDoNothing()
      .returning({
        snowflake: messages.snowflake,
      });

    const insertedCount = inserted.length;
    const duplicatesCount = validMessages.length - insertedCount;

    totalInserted += insertedCount;
    totalDuplicates += duplicatesCount;
    totalFlushes++;

    if (insertedCount > 0) {
      await redis.incrby('metrics:producer:db_writes', insertedCount);
    }

    const streamIds = batch.map((m) => m.streamId);
    await redis.xack(STREAM, GROUP, ...streamIds);
    totalAcked += batch.length;

    const cacheMessages = [];
    const ackPayloads = [];

    for (const msg of validMessages) {
      cacheMessages.push({
        snowflake: msg.snowflake,
        userId: msg.userId,
        username: msg.username || 'unknown',
        content: msg.content || '',
        createdAt: msg.createdAt instanceof Date ? msg.createdAt : safeParseDate(msg.createdAt),
      });

      ackPayloads.push({
        socketId: msg.socketId || '',
        snowflake: msg.snowflake,
      });

      publishMessageCreated({
        userId: msg.userId,
        username: msg.username || 'unknown',
        content: msg.content || '',
        snowflake: msg.snowflake,
        createdAt: msg.createdAt instanceof Date ? msg.createdAt : safeParseDate(msg.createdAt),
      });
    }

    if (cacheMessages.length) {
      await pushRecentMessages(cacheMessages);
    }

    if (ackPayloads.length) {
      const pipeline = redis.pipeline();
      for (const ack of ackPayloads) {
        pipeline.publish(CHANNELS.MESSAGE_ACK, JSON.stringify(ack));
      }
      await pipeline.exec();
    }

    if (buffer.length === 0) {
      oldestMessageTime = Date.now();
    }
  } catch (err) {
    console.error("[FLUSH ERROR]", err.message);
    buffer.unshift(...batch);
  } finally {
    flushSemaphore--;
  }
}

/* ---------------- RECOVERY ---------------- */
async function recoverPendingMessages() {
  let startId = "0-0";

  try {
    while (true) {
      const result = await redis.xautoclaim(
        STREAM,
        GROUP,
        CONSUMER,
        RECOVERY_IDLE_TIME,
        startId,
        "COUNT",
        2000
      );

      startId = result[0];
      const entries = result?.[1] || [];

      if (entries.length === 0) break;

      for (const [id, fields] of entries) {
        try {
          const msg = parseFields(fields);

          if (!msg.snowflake || !msg.userId) {
            await redis.xack(STREAM, GROUP, id);
            continue;
          }

          const createdAt = safeParseDate(msg.createdAt);

          buffer.push({
            streamId: id,
            socketId: msg.socketId || '',
            snowflake: msg.snowflake,
            userId: msg.userId,
            username: msg.username || 'unknown',
            content: msg.content || '',
            createdAt: createdAt,
          });

          totalRead++;
        } catch {
          await redis.xack(STREAM, GROUP, id);
        }
      }
    }

    if (buffer.length > 0) {
      await flushMessages();
    }
  } catch {
    // intentionally ignored
  }
}

/* ---------------- TIMER FLUSH ---------------- */
setInterval(() => {
  if (buffer.length === 0) return;

  const shouldFlush =
    Date.now() - oldestMessageTime > PRESSURE_FLUSH_AGE ||
    buffer.length >= BATCH_SIZE;

  if (shouldFlush) {
    flushMessages();
  }
}, FLUSH_INTERVAL);

/* ---------------- METRICS MONITORING ---------------- */
const INSTANCE = process.env.NODE_APP_INSTANCE || "0";

if (INSTANCE === "0") {
  setInterval(() => {
    const uptime = Math.round((Date.now() - startTime) / 1000);
    const loss = totalRead - totalInserted - totalDuplicates;
    const lossPercent = totalRead > 0 ? ((loss / totalRead) * 100).toFixed(2) : 0;
    const timeSinceLastRead = Math.round((Date.now() - lastReadTime) / 1000);
    
    console.log(`
[📊 CONSUMER METRICS] ${CONSUMER}
  Uptime:              ${uptime}s
  Time Since Last Read: ${timeSinceLastRead}s
  Read:                ${totalRead}
  Inserted:            ${totalInserted}
  Duplicates:          ${totalDuplicates}
  Acked:               ${totalAcked}
  Loss:                ${loss} (${lossPercent}%)
  Buffer:              ${buffer.length}
  Flushes:             ${totalFlushes}
  Semaphore:           ${flushSemaphore}
  Batch Size:          ${BATCH_SIZE}
    `);
  }, 10000);
}

/* ---------------- READ LOOP ---------------- */
async function consumeNewMessages() {
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;

  while (true) {
    try {
      const data = await redis.xreadgroup(
        "GROUP",
        GROUP,
        CONSUMER,
        "COUNT",
        2000,
        "BLOCK",
        5000,
        "STREAMS",
        STREAM,
        ">"
      );

      if (!data) {
        consecutiveErrors = 0;
        continue;
      }

      consecutiveErrors = 0;
      lastReadTime = Date.now();

      for (const stream of data) {
        const entries = stream[1];

        for (const [id, fields] of entries) {
          const msg = parseFields(fields);
          const createdAt = safeParseDate(msg.createdAt);

          buffer.push({
            streamId: id,
            socketId: msg.socketId || '',
            snowflake: msg.snowflake || 'unknown',
            userId: msg.userId || '',
            username: msg.username || 'unknown',
            content: msg.content || '',
            createdAt: createdAt,
          });

          totalRead++;

          if (buffer.length === 1) {
            oldestMessageTime = Date.now();
          }
        }
      }

      if (buffer.length >= BATCH_SIZE) {
        await flushMessages();
      }
    } catch (err) {
      if (err.message && (err.message.includes('timed out') || err.message.includes('timeout'))) {
        consecutiveErrors = 0;
        continue;
      }

      consecutiveErrors++;

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        process.exit(1);
      }

      const delay = Math.min(consecutiveErrors * 1000, 30000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/* ---------------- START ---------------- */
export async function startMessageConsumer() {
  try {
    await redis.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
    console.log("✅ Message stream consumer group ready.");
  } catch (err) {
    if (!err.message?.includes("BUSYGROUP")) {
      console.error("❌ Message consumer group error:", err);
    }
  }

  console.log(`🚀 Message Stream Consumer [${CONSUMER}] started.`);
  await recoverPendingMessages();
  await consumeNewMessages();
}

// Auto-start if executed directly via node CLI
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").includes("messageStreamConsumer.worker.js")) {
  startMessageConsumer().catch((err) => {
    console.error("Fatal message consumer error:", err);
    process.exit(1);
  });
}

/* ---------------- SHUTDOWN ---------------- */
async function shutdown() {
  try {
    if (buffer.length > 0) {
      await flushMessages();
    }
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);