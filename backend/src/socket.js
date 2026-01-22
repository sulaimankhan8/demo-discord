import { Server } from "socket.io";
import { db } from "./db/index.js";
import { and, eq } from "drizzle-orm";

import { generateSnowflake } from "./snowflake.js";
import { messages, messageReactions } from "./db/schema.js";

let io;
/* ---------------- CONFIG ---------------- */

let BATCH_SIZE = 100;
const FLUSH_INTERVAL = 100;
const MAX_BUFFER = 5000;

/* ---------------- STATE ---------------- */

export const messageBuffer = [];
export const WAL = []; // write-ahead log
const presence = new Map(); // userId → status
let flushing = false;
let lastFlush = Date.now();

/* ---------------- SOCKET ---------------- */

export function initSocket(server) {
   io = new Server(server, {
    cors: { origin: "*" },
    transports: ["polling", "websocket"],
  });

  io.on("connection", (socket) => {
    console.log("[SOCKET] connected:", socket.id);

    /* ---------- PRESENCE ---------- */
    io.emit("presence:update", {
  users: Array.from(presence.values()),
});

     socket.on("presence:online", ({ userId, username }) => {
      socket.userId = userId;
      socket.username = username;

      presence.set(userId, { userId, username, status: "online" });

      io.emit("presence:update", {
        users: Array.from(presence.values()),
      });
    });

    socket.on("disconnect", () => {
      if (socket.userId) {
        presence.set(socket.userId, {
          ...presence.get(socket.userId),
          status: "offline",
        });

        io.emit("presence:update", {
          users: Array.from(presence.values()),
        });
      }

      console.log("[SOCKET] disconnected:", socket.id);
    });

    /* ---------- MESSAGE ---------- */
    socket.on("send-message", ({ userId, username, content }) => {
      const snowflake = generateSnowflake();
      const createdAt = new Date();

      const message = {
        userId,
        snowflake,
        username,
        content,
        createdAt,
      };

      /* realtime emit */
      io.emit("new-message", {
        ...message,
        createdAt: createdAt.toISOString(),
      });

      /* WAL + buffer */
      if (messageBuffer.length >= MAX_BUFFER) {
        socket.emit("server-busy");
        return;
      }

      WAL.push(message);
      messageBuffer.push(message);

      if (messageBuffer.length >= BATCH_SIZE) flushMessages();
    });

    /* ---------- TYPING (OPTIMIZED) ---------- */
    socket.on("typing:start", () => {
  socket.broadcast.emit("typing:start", {
    userId: socket.userId,
    username: socket.username,
  });
});


    socket.on("typing:stop", () => {
      socket.broadcast.emit("typing:stop", socket.userId);
    });

    /* ---------- REACTIONS ---------- */
    socket.on("reaction:add", async ({ messageId, userId, emojiCode }) => {
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
    // 🔥 REMOVE (toggle off)
    await db
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.userId, userId),
          eq(messageReactions.emojiCode, emojiCode)
        )
      );

    io.emit("reaction:update", {
      messageId,
      emojiCode,
      delta: -1,
    });

    return;
  }

  // ➕ ADD (toggle on)
  await db.insert(messageReactions).values({
    messageId,
    userId,
    emojiCode,
  });

  io.emit("reaction:update", {
    messageId,
    emojiCode,
    delta: +1,
  });
});
  });
}

/* ---------------- FLUSH ---------------- */

function adjustBatchSize() {
  const delta = Date.now() - lastFlush;
  if (delta < 50) BATCH_SIZE = Math.min(BATCH_SIZE * 2, 1000);
  else if (delta > 200) BATCH_SIZE = Math.max(BATCH_SIZE / 2, 50);
  lastFlush = Date.now();
}

async function flushMessages() {
  if (flushing || messageBuffer.length === 0) return;
  flushing = true;
  adjustBatchSize();

  const batch = messageBuffer.splice(0, BATCH_SIZE);
  batch.sort((a, b) => a.snowflake - b.snowflake);

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
  })
  .execute();

  for (const row of inserted) {
  io.emit("message:ack", {
    id: row.id,
    snowflake: row.snowflake,
  });
}
    WAL.splice(0, batch.length);
  } catch (err) {
    console.error("[DB FAIL]", err.message);
    messageBuffer.unshift(...batch);
  } finally {
    flushing = false;
  }
}

/* ---------------- INTERVAL ---------------- */

setInterval(() => {
  if (messageBuffer.length > 0) flushMessages();
}, FLUSH_INTERVAL);
