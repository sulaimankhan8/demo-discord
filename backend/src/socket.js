import { Server } from "socket.io";
import { db } from "./db/index.js";
import { messages } from "./db/schema.js";

export function initSocket(server) {
  const io = new Server(server, {
    cors: { origin: "*" },
  });

  io.on("connection", (socket) => {
    socket.on("send-message", ({ userId, username, content }) => {
      const message = {
        userId,
        username,
        content,
        //createdAt: new Date().toISOString(),
      };

      // 1️⃣ Instant broadcast
      io.emit("new-message", {
        ...message,
        createdAt: new Date().toISOString(), // only for UI
      });

      // 2️⃣ Persist async (fire-and-forget)
      db.insert(messages).values(message).catch(console.error);
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



