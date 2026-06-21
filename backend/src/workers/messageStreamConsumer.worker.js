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
const BATCH_SIZE = 2000;
const FLUSH_INTERVAL = 100;
const PRESSURE_FLUSH_AGE = 1000;
const MAX_CONCURRENT_FLUSHES = 4;
const RECOVERY_IDLE_TIME = 10000;

/* ---------------- METRICS ---------------- */
let totalRead = 0;
let totalInserted = 0;
let totalFlushes = 0;
let startTime = Date.now();

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

/* ---------------- FLUSH ---------------- */
async function flushMessages() {
  if (flushSemaphore >= MAX_CONCURRENT_FLUSHES) {
    return;
  }

  if (buffer.length === 0) {
    return;
  }

  flushSemaphore++;

  let batch = [];

  try {
    batch = buffer.splice(0, BATCH_SIZE);

    console.log(`[FLUSH] size=${batch.length} remaining=${buffer.length}`);

    // ✅ Insert with ON CONFLICT - no returning needed
    await db
      .insert(messages)
      .values(
        batch.map((m) => ({
          userId: m.userId,
          snowflake: m.snowflake,
          username: m.username,
          content: m.content,
          createdAt: m.createdAt,
        }))
      )
      .onConflictDoNothing();


    // ✅ All messages are handled - update metrics
    totalInserted += batch.length;
    totalFlushes++;

    // ✅ Ack ALL messages - duplicates are handled by ON CONFLICT
    const streamIds = batch.map((m) => m.streamId);
    await redis.xack(STREAM, GROUP, ...streamIds);

    // ✅ Process cache and acks for ALL messages
    const cacheMessages = [];
    const ackPayloads = [];

    for (const msg of batch) {
      cacheMessages.push({
        snowflake: msg.snowflake,
        userId: msg.userId,
        username: msg.username,
        content: msg.content,
        createdAt: msg.createdAt,
      });

      ackPayloads.push({
        socketId: msg.socketId,
        snowflake: msg.snowflake,
      });

      publishMessageCreated({
        userId: msg.userId,
        username: msg.username,
        content: msg.content,
        snowflake: msg.snowflake,
        createdAt: msg.createdAt,
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

    console.log(
      `[FLUSH COMPLETE] inserted=${batch.length} remaining=${buffer.length}`
    );

    if (buffer.length === 0) {
      oldestMessageTime = Date.now();
    }

  } catch (err) {
    console.error(`[FLUSH ERROR]`, err);
    // In case of error, put batch back
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

      if (entries.length === 0) {
        break;
      }

      console.log(`[RECOVERY] claimed ${entries.length} messages`);

      for (const [id, fields] of entries) {
        const msg = parseFields(fields);
        buffer.push({
          streamId: id,
          socketId: msg.socketId,
          snowflake: msg.snowflake,
          userId: msg.userId,
          username: msg.username,
          content: msg.content,
          createdAt: new Date(msg.createdAt),
        });
      }
    }
  } catch (err) {
    console.error("[RECOVERY ERROR]", err);
  }
}

/* ---------------- TIMER FLUSH ---------------- */
setInterval(() => {
  if (buffer.length === 0) return;

  let shouldFlush = false;
  if (Date.now() - oldestMessageTime > PRESSURE_FLUSH_AGE) {
    shouldFlush = true;
  }
  if (buffer.length >= BATCH_SIZE) {
    shouldFlush = true;
  }

  if (shouldFlush) {
    flushMessages();
  }
}, FLUSH_INTERVAL);

/* ---------------- METRICS MONITORING ---------------- */
setInterval(() => {
  const uptime = Math.round((Date.now() - startTime) / 1000);
  const loss = totalRead - totalInserted;
  const lossPercent = totalRead > 0 ? ((loss / totalRead) * 100).toFixed(2) : 0;
  
  console.log(`
[📊 METRICS]
  Uptime:        ${uptime}s
  Read:          ${totalRead}
  Inserted:      ${totalInserted}
  Loss:          ${loss} (${lossPercent}%)
  Buffer:        ${buffer.length}
  Flushes:       ${totalFlushes}
  Semaphore:     ${flushSemaphore}
  `);
}, 10000);

/* ---------------- READ LOOP ---------------- */
async function consumeNewMessages() {
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

      if (!data) continue;

      for (const stream of data) {
        const entries = stream[1];
        for (const [id, fields] of entries) {
          const msg = parseFields(fields);
          buffer.push({
            streamId: id,
            socketId: msg.socketId,
            snowflake: msg.snowflake,
            userId: msg.userId,
            username: msg.username,
            content: msg.content,
            createdAt: new Date(msg.createdAt),
          });

          totalRead++;

          if (buffer.length === 1) {
            oldestMessageTime = Date.now();
          }
        }
      }

      if (buffer.length >= BATCH_SIZE) {
        flushMessages();
      }

    } catch (err) {
      console.error("[STREAM ERROR]", err);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/* ---------------- START ---------------- */
async function start() {
  console.log("[STREAM WORKER STARTING]", CONSUMER);
  console.log(`[CONFIG] BATCH_SIZE=${BATCH_SIZE}, MAX_CONCURRENT_FLUSHES=${MAX_CONCURRENT_FLUSHES}`);
  await recoverPendingMessages();
  await consumeNewMessages();
}

start().catch(console.error);

/* ---------------- SHUTDOWN ---------------- */
async function shutdown() {
  console.log("[SHUTDOWN]");
  console.log(`[FINAL METRICS] Read: ${totalRead}, Inserted: ${totalInserted}, Loss: ${totalRead - totalInserted}`);
  try {
    await flushMessages();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);