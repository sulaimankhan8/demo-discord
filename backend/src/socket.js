import { Server } from "socket.io";
import { db } from "./db/index.js";
import { generateSnowflake } from "./snowflake.js";
import { messages } from "./db/schema.js";

const BATCH_SIZE = 100;
const FLUSH_INTERVAL = 100;
const MAX_BUFFER = 5000;

const messageBuffer = [];
let flushing = false;

export function initSocket(server) {
  const io = new Server(server, {
    cors: { origin: "*" },
    transports: ["polling","websocket"],
    allowUpgrades: false,
  });

  io.on("connection", (socket) => {
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

  
  // 1️⃣ realtime emit (UI ordering uses snowflake)
  io.emit("new-message", {
  userId,
  snowflake,
  username,
  content,
  createdAt: createdAt.toISOString(),
});


  // 2️⃣ buffer for DB
if (messageBuffer.length >= MAX_BUFFER) {
  socket.emit("server-busy");
  return;
}

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
  console.log("Flushing batch:", batch.length);

  if (messageBuffer.length === 0) return;

  flushing = true;

  const batch = messageBuffer.splice(
  0,
  Math.min(BATCH_SIZE, messageBuffer.length)
);

  // 🔑 enforce creation order
  batch.sort((a, b) => a.snowflake - b.snowflake);

  try {
    await db.insert(messages).values(
      batch.map((m) => ({
        userId: m.userId,
        snowflake: m.snowflake,
        username: m.username,
        content: m.content,
        createdAt: m.createdAt,
      }))
    ).execute();
  } catch (err) {
    console.error("Batch insert failed", err);

    // resistance: retry
    messageBuffer.unshift(...batch);
  } finally {
    flushing = false;
     if (messageBuffer.length >= BATCH_SIZE) {
    flushMessages();
  }
  }
}

setInterval(() => {
  if (messageBuffer.length > 0) {
    flushMessages();
  }
}, FLUSH_INTERVAL);
