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

/* ---------------- STATE ---------------- */

export const messageBuffer = [];
export const WAL = []; // write-ahead log
const presence = new Map(); // userId → { userId, username, status }

let flushing = false;
let lastFlush = Date.now();
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

      io.emit("presence:update", {
        userId,
        username,
        status: "online",
      });
    });

    /* ---------- DISCONNECT ---------- */
    socket.on("disconnect", () => {
      if (socket.userId) {
        presence.delete(socket.userId);

        /* 🔴 CHANGED: send DELTA */
        io.emit("presence:update", {
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
      }// hard limit 2k clients

      const snowflakeId = snowflakeGn.generate();
      const createdAt = new Date();

      const message = {
        socketId: socket.id,
        userId,
        snowflake: snowflakeId.toString(),
        username,
        content,
        createdAt,
      };

      // later
      io.to("global-chat").emit("new-message", {
        ...message,
        createdAt: createdAt.toISOString(),
      });

      if (messageBuffer.length >= MAX_BUFFER) {
        socket.emit("server-busy");
        return;
      }

      WAL.push(message);
      messageBuffer.push(message);

      if (messageBuffer.length >= BATCH_SIZE) flushMessages();
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

  if (delta < 50) BATCH_SIZE = Math.min(BATCH_SIZE * 2, 1000);
  else if (delta > 200) BATCH_SIZE = Math.max(Math.floor(BATCH_SIZE / 2), 50);

  lastFlush = Date.now();
}

async function flushMessages() {
  if (flushing || messageBuffer.length === 0) return;
  flushing = true;

  adjustBatchSize();

  const batch = messageBuffer.splice(0, BATCH_SIZE);
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

    for (let i = 0; i < inserted.length; i++) {
      io.to(batch[i].socketId).emit("message:ack", {
        id: inserted[i].id,
        snowflake: inserted[i].snowflake.toString(),
      });
    }

    WAL.splice(0, batch.length);
  } catch (err) {
    console.error("[DB INSERT FAIL]", err.message);
    messageBuffer.unshift(...batch);
  } finally {
    flushing = false;
  }
}

/* ---------------- INTERVAL ---------------- */

setInterval(() => {
  if (messageBuffer.length > 0) flushMessages();
}, FLUSH_INTERVAL);
