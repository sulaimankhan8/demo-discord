import { Server } from "socket.io";
import { db } from "./db/index.js";
import { generateSnowflake } from "./snowflake.js";
import { messages } from "./db/schema.js";

const BATCH_SIZE = 100;
const FLUSH_INTERVAL = 100;
const MAX_BUFFER = 5000;

export const messageBuffer = [];
let flushing = false;

export function initSocket(server) {
  const io = new Server(server, {
    cors: { origin: "*" },
    transports: ["polling", "websocket"],
    allowUpgrades: true,
  });

  io.on("connection", (socket) => {
    console.log("[SOCKET] client connected:", socket.id);

    socket.on("send-message", ({ userId, username, content }) => {
      const snowflake = generateSnowflake();
      const createdAt = new Date();

      console.log("[MSG IN]", {
        socketId: socket.id,
        userId,
        username,
        snowflake,
      });

      const message = {
        userId,
        snowflake,
        username,
        content,
        createdAt,
      };

      /* realtime emit */
      io.emit("new-message", {
        userId,
        snowflake,
        username,
        content,
        createdAt: createdAt.toISOString(),
      });

      console.log("[EMIT] new-message", snowflake);

      /* buffer */
      if (messageBuffer.length >= MAX_BUFFER) {
        console.warn("[BUFFER FULL] dropping message", snowflake);
        socket.emit("server-busy");
        return;
      }

      messageBuffer.push(message);
      console.log(
        "[BUFFER PUSH]",
        "size:",
        messageBuffer.length,
        "snowflake:",
        snowflake
      );

      /* trigger flush */
      if (messageBuffer.length >= BATCH_SIZE) {
        console.log("[FLUSH TRIGGER] size-based");
        flushMessages();
      }
    });

    socket.on("typing", ({ username }) => {
      console.log("[TYPING]", username);
      socket.broadcast.emit("typing", { username });
    });

    socket.on("stop-typing", ({ username }) => {
      console.log("[STOP TYPING]", username);
      socket.broadcast.emit("stop-typing", { username });
    });

    socket.on("disconnect", () => {
      console.log("[SOCKET] disconnected:", socket.id);
    });
  });
}

/* ---------------- FLUSH ---------------- */

async function flushMessages() {
  if (flushing) {
    console.log("[FLUSH SKIP] already flushing");
    return;
  }

  if (messageBuffer.length === 0) {
    console.log("[FLUSH SKIP] buffer empty");
    return;
  }

  flushing = true;

  const batch = messageBuffer.splice(
    0,
    Math.min(BATCH_SIZE, messageBuffer.length)
  );

  console.log(
    "[FLUSH START]",
    "batch size:",
    batch.length,
    "buffer left:",
    messageBuffer.length
  );

  batch.sort((a, b) => a.snowflake - b.snowflake);

  console.log(
    "[FLUSH ORDER]",
    "first:",
    batch[0]?.snowflake,
    "last:",
    batch[batch.length - 1]?.snowflake
  );

  try {
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
      .execute();
      console.log(messages);
      

    console.log("[DB INSERT OK]", batch.length);
  } catch (err) {
    console.error("[DB INSERT FAIL]", err.message);
    messageBuffer.unshift(...batch);
    console.warn("[BUFFER RESTORED]", messageBuffer.length);
  } finally {
    flushing = false;

    if (messageBuffer.length >= BATCH_SIZE) {
      console.log("[FLUSH CONTINUE]");
      flushMessages();
    }
  }
}

/* ---------------- INTERVAL ---------------- */

setInterval(() => {
  if (messageBuffer.length > 0) {
    console.log("[INTERVAL FLUSH]", "buffer:", messageBuffer.length);
    flushMessages();
  }
}, FLUSH_INTERVAL);
