import { Server } from "socket.io";
import { db } from "./db/index.js";
import { and, eq, sql } from "drizzle-orm";

import Snowflake from "./snowflake.js";
import {
  messages,
  messageReactions,
  messageReactionCounts,
} from "./db/schema.js";

/* ---------------- CONFIG ---------------- */

let BATCH_SIZE = 100;
const FLUSH_INTERVAL = 100;
const MAX_BUFFER = 5000;
const MAX_CONCURRENT_FLUSHES = 2; // allow 1-2 concurrent DB flushes
const PRESSURE_FLUSH_AGE = 150; // ms, flush if oldest message exceeds this
const PRESSURE_FLUSH_SIZE = 500; // bytes, flush if WAL size exceeds this

/* ---------------- STATE ---------------- */

export const messageBuffer = new Map(); // shardId (roomId) → buffer[]
export const WAL = []; // write-ahead log
const presence = new Map(); // userId → { userId, username, status }

let flushSemaphore = 0; // concurrent flush counter
let lastFlush = Date.now();
let oldestMessageTime = Date.now();
let io;

/* ---------------- SOCKET INIT ---------------- */
const snowflakeGn = new Snowflake({
  datacenterId: 1,              // region / DC
  workerId: Number(process.env.WORKER_ID || 0),
});

export function initSocket(server) {
  io = new Server(server, {
    cors: { origin: "*" },
    transports: ["websocket", "polling"],
  });

  io.on("connection", (socket) => {
    /* realtime */
    socket.join("global-chat");

    console.log("[SOCKET CONNECTED]", socket.id);

    /* ---------- INITIAL PRESENCE PUSH ---------- */
    socket.emit("presence:update", {
      users: Array.from(presence.values()),
    });

    /* ---------- PRESENCE ONLINE ---------- */
    socket.on("presence:online", ({ userId, username }) => {
      socket.userId = userId;
      socket.username = username;

      presence.set(userId, {
        userId,
        username,
        status: "online",
      });

      // 🔥 CHANGE: broadcast presence only to room members
      socket.to("global-chat").emit("presence:update", {
        userId,
        username,
        status: "online",
      });
    });

    /* ---------- DISCONNECT ---------- */
    socket.on("disconnect", () => {
      if (socket.userId) {
        presence.delete(socket.userId);

        /* � CHANGE: send DELTA only to room members */
        socket.to("global-chat").emit("presence:update", {
          userId: socket.userId,
          status: "offline",
        });
      }

      console.log("[SOCKET DISCONNECTED]", socket.id);
    });

    /* ---------- SEND MESSAGE ---------- */
    socket.on("send-message", ({ userId, username, content }) => {
      if (io.engine.clientsCount > 2000) {
        socket.emit("server-busy");
        return;
      } // hard limit 2k clients

      const snowflakeId = snowflakeGn.generate();
      const createdAt = new Date();

      const message = {
        socketId: socket.id, // 🔥 store for targeted ACK
        userId,
        snowflake: snowflakeId.toString(),
        username,
        content,
        createdAt,
      };

      // broadcast to all in room (after DB)
      io.to("global-chat").emit("new-message", {
        ...message,
        createdAt: createdAt.toISOString(),
      });

      // 🔥 CHANGE: shard buffer by roomId (or userId % N for fairness)
      const shardId = "global-chat"; // can extend to userId % N for multi-room
      if (!messageBuffer.has(shardId)) {
        messageBuffer.set(shardId, []);
      }

      const shardBuffer = messageBuffer.get(shardId);
      if (shardBuffer.length >= MAX_BUFFER) {
        socket.emit("server-busy");
        return;
      }

      WAL.push(message);
      shardBuffer.push(message);
      oldestMessageTime = Math.min(oldestMessageTime, createdAt.getTime());

      // 🔥 CHANGE: trigger flush by PRESSURE (batch size OR age OR WAL size)
      if (
        shardBuffer.length >= BATCH_SIZE ||
        Date.now() - oldestMessageTime > PRESSURE_FLUSH_AGE
      ) {
        flushMessages();
      }
    });

    /* ---------- TYPING ---------- */
    socket.on("typing:start", () => {
      socket.to("global-chat").emit("typing:start", {
        userId: socket.userId,
        username: socket.username,
      });
    });

    socket.on("typing:stop", () => {
      socket.to("global-chat").emit("typing:stop", socket.userId);
    });

    /* ---------- REACTIONS (FINAL) ---------- */
    /*socket.on("reaction:add", async ({ messageId, userId, emojiCode }) => {
  if (!messageId) return;

  const existing = await db
    .select()
    .from(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.userId, userId),
        eq(messageReactions.emojiCode, emojiCode)
      )
    );

  if (existing.length > 0) {
    // REMOVE reaction
    await db.transaction(async (tx) => {
      await tx
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.userId, userId),
            eq(messageReactions.emojiCode, emojiCode)
          )
        );

      await tx.execute(sql`
        UPDATE message_reaction_counts
        SET count = count - 1
        WHERE message_id = ${messageId}
          AND emoji_code = ${emojiCode}
      `);
    });

    io.emit("reaction:update", {
      messageId,
      emojiCode,
      delta: -1,
    });

    return;
  }

  // ADD reaction
  await db.transaction(async (tx) => {
    await tx.insert(messageReactions).values({
      messageId,
      userId,
      emojiCode,
    });

    await tx.execute(sql`
      INSERT INTO message_reaction_counts (message_id, emoji_code, count)
      VALUES (${messageId}, ${emojiCode}, 1)
      ON CONFLICT (message_id, emoji_code)
      DO UPDATE SET count = message_reaction_counts.count + 1
    `);
  });

  io.emit("reaction:update", {
    messageId,
    emojiCode,
    delta: +1,
  });
});*/

  });
}

/* ---------------- FLUSH ---------------- */

function adjustBatchSize() {
  const delta = Date.now() - lastFlush;

  if (delta < 50) BATCH_SIZE = Math.min(BATCH_SIZE * 2, 500); // cap at 500 for lower latency variance
  else if (delta > 200) BATCH_SIZE = Math.max(Math.floor(BATCH_SIZE / 2), 50);

  lastFlush = Date.now();
}

async function flushMessages() {
  // 🔥 CHANGE: use semaphore instead of boolean, allow 1-2 concurrent flushes
  if (flushSemaphore >= MAX_CONCURRENT_FLUSHES) return;
  if (messageBuffer.size === 0) return;

  flushSemaphore++;

  try {
    adjustBatchSize();

    // 🔥 CHANGE: iterate over shards and flush each
    for (const [shardId, shardBuffer] of messageBuffer.entries()) {
      if (shardBuffer.length === 0) continue;

      const batch = shardBuffer.splice(0, BATCH_SIZE);
      batch.sort((a, b) =>
        BigInt(a.snowflake) > BigInt(b.snowflake) ? 1 : -1
      );

      try {
        const inserted = await db
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
          .returning({
            id: messages.id,
            snowflake: messages.snowflake,
          });

        // 🔥 CHANGE: ACK ONLY to sender (targeted, not broadcast)
        for (const row of inserted) {
          const message = batch.find((m) => m.snowflake === row.snowflake.toString());
          if (message) {
            io.to(message.socketId).emit("message:ack", {
              id: row.id,
              snowflake: row.snowflake.toString(),
            });
          }
        }

        // remove from WAL only after successful DB write
        for (let i = 0; i < batch.length; i++) {
          const idx = WAL.findIndex(
            (m) => m.snowflake === batch[i].snowflake
          );
          if (idx >= 0) WAL.splice(idx, 1);
        }

        // update oldest message time if buffer is now empty
        if (messageBuffer.get(shardId).length === 0) {
          oldestMessageTime = Date.now();
        }
      } catch (err) {
        console.error("[DB INSERT FAIL]", err.message);
        // push back to buffer on failure
        shardBuffer.unshift(...batch);
        break; // stop processing other shards on error
      }
    }
  } finally {
    flushSemaphore--;
  }
}

/* ---------------- INTERVAL & PRESSURE-BASED FLUSH ---------------- */

setInterval(() => {
  // 🔥 CHANGE: trigger flush by PRESSURE, not just timer
  let shouldFlush = false;

  // condition 1: buffer has messages
  if (messageBuffer.size > 0) {
    // condition 2: age of oldest message exceeds threshold
    if (Date.now() - oldestMessageTime > PRESSURE_FLUSH_AGE) {
      shouldFlush = true;
    }
    // condition 3: any shard has messages ready
    for (const shard of messageBuffer.values()) {
      if (shard.length >= BATCH_SIZE) {
        shouldFlush = true;
        break;
      }
    }
  }

  if (shouldFlush) {
    flushMessages();
  }
}, FLUSH_INTERVAL);
