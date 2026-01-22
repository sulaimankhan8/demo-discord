import { Server } from "socket.io";
import { db } from "./db/index.js";
import { generateSnowflake } from "./snowflake.js";
import { messages } from "./db/schema.js";

const BATCH_SIZE = 100;
const FLUSH_INTERVAL = 100;

const messageBuffer = [];
let flushing = false;

export function initSocket(server) {
  const io = new Server(server, {
    cors: { origin: "*" },
  });

  io.on("connection", (socket) => {
  socket.on("send-message", ({ username, content }) => {
  const snowflake = generateSnowflake();
  const createdAt = new Date();

  const message = {
    snowflake,
    username,
    content,
    createdAt,
  };

  // 1️⃣ realtime emit (UI ordering uses snowflake)
  io.emit("new-message", {
    ...message,
    createdAt: createdAt.toISOString(),
  });

  // 2️⃣ buffer for DB
  messageBuffer.push(message);

  // 3️⃣ size-based flush
  if (messageBuffer.length >= BATCH_SIZE) {
    flushMessages();
  }
});


    // Typing indicator
    socket.on("typing", ({ username }) => {
      socket.broadcast.emit("typing", { username });
    });

    socket.on("stop-typing", ({ username }) => {
      socket.broadcast.emit("stop-typing", { username });
    });
  });
}



async function flushMessages() {
  if (flushing) return;
  if (messageBuffer.length === 0) return;

  flushing = true;

  const batch = messageBuffer.splice(0, BATCH_SIZE);

  // 🔑 enforce creation order
  batch.sort((a, b) => a.snowflake - b.snowflake);

  try {
    await db.insert(messages).values(
      batch.map((m) => ({
        snowflake: m.snowflake,
        username: m.username,
        content: m.content,
        createdAt: m.createdAt,
      }))
    );
  } catch (err) {
    console.error("Batch insert failed", err);

    // resistance: retry
    messageBuffer.unshift(...batch);
  } finally {
    flushing = false;
  }
}

setInterval(() => {
  if (messageBuffer.length > 0) {
    flushMessages();
  }
}, FLUSH_INTERVAL);
