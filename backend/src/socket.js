import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter"; 
import {
  redis,
  pubClient,
  subClient,
} from "./redis/index.js";
import {
  queueMessage,
  appendMessage,
  incrementReceived,  // ✅ Added
  getXaddStats,
  getMetrics,        // ✅ Added
} from "./redis/messageStream/messageStream.js";
import {
  setOnline,
  setOffline,
  getOnlineUsers,
  refreshPresence,
} from "./redis/presence.js";

import {
  canSendMessage,
} from "./redis/ratelimiter.js";

import Snowflake from "./snowflake.js";
import { eventBus } from "./events/eventBus.js";
import { EVENTS } from "./events/events.js";
import { initVoiceNamespace } from "./voice/voice.socket.js";
import { subscriber } from "./redis/pubsub/subscriber.js";
import { CHANNELS } from "./redis/pubsub/channels.js";

/* ---------------- CONFIG ---------------- */
const MAX_OUTBOUND_BATCH = 1000;
const OUTBOUND_FLUSH_INTERVAL = 5;

/* ---------------- STATE ---------------- */
let io;
const outboundQueue = [];
export const recentMessages = [];
const RECENT_LIMIT = 100;

// Track total messages received across all sockets
let totalMessagesReceived = 0;


setInterval(() => {
  console.log(
    `[${process.pid}] SERVER_RECEIVED = ${totalMessagesReceived}`
  );
}, 5000);


function pushRecent(message) {
  recentMessages.push(message);
  if (recentMessages.length > RECENT_LIMIT) {
    recentMessages.shift();
  }
}

/* ---------------- SNOWFLAKE ---------------- */
const snowflakeGn = new Snowflake({
  datacenterId: 1,
  workerId: Number(process.env.NODE_APP_INSTANCE || 0)
});

/* ---------------- BROADCAST ---------------- */
function broadcastBatch(batch) {
  if (!batch.length) return;
  io.to("global-chat").emit("new-message-batch", batch);
}

setInterval(() => {
  if (outboundQueue.length === 0) return;
  const batch = outboundQueue.splice(0, MAX_OUTBOUND_BATCH);
  broadcastBatch(batch);
}, OUTBOUND_FLUSH_INTERVAL);

/* ---------------- ACK PUBSUB ---------------- */
async function initAckSubscriber() {
  await subscriber.subscribe(CHANNELS.MESSAGE_ACK);
  subscriber.on("message", (channel, payload) => {
    if (channel !== CHANNELS.MESSAGE_ACK) return;
    const data = JSON.parse(payload);
    io.to(data.socketId).emit("message:ack", {
      snowflake: data.snowflake,
    });
  });
}

/* ---------------- SOCKET ---------------- */
export function initSocket(server) {
  io = new Server(server, {
    cors: { origin: "*" },
    transports: ["websocket"],
    allowUpgrades: false,
    pingInterval: 20000,
    pingTimeout: 20000,
  });

  io.adapter(createAdapter(pubClient, subClient));
  initVoiceNamespace(io);
  initAckSubscriber();

  // ✅ Socket stats every 5 seconds
  // setInterval(async () => {
  //   const stats = await getMetrics();
  //   console.log('[📊 SOCKET STATS]', {
  //     clients: io.engine.clientsCount,
  //     ...stats,
  //   });
  // }, 5000);

  io.on("connection", async (socket) => {
    console.log("[CONNECTED]", process.pid, socket.id);
    socket.join("global-chat");

    const users = await getOnlineUsers();
    socket.emit("presence:update", { users });

    socket.on("presence:online", async ({ userId, username }) => {
      socket.userId = userId;
      socket.username = username;

      await setOnline({
        userId,
        username,
        socketId: socket.id,
        status: "online",
      });

      eventBus.emit(EVENTS.USER_ONLINE, { userId, username });
      socket.to("global-chat").emit("presence:update", {
        userId,
        username,
        status: "online",
      });
    });

    socket.on("presence:heartbeat", async () => {
      if (!socket.userId) return;
      await refreshPresence({
        userId: socket.userId,
        username: socket.username,
        socketId: socket.id,
      });
    });

    socket.on("disconnect", async () => {
      if (!socket.userId) return;
      const fullyOffline = await setOffline(socket.userId, socket.id);
      if (!fullyOffline) return;

      eventBus.emit(EVENTS.USER_OFFLINE, {
        userId: socket.userId,
        username: socket.username,
      });

      socket.to("global-chat").emit("presence:update", {
        userId: socket.userId,
        status: "offline",
      });
    });




    /* ---------------- SEND MESSAGE ---------------- */
    socket.on("send-message", async ({ userId, username, content }, ack) => {
       try {
   
        if (io.engine.clientsCount > 2000) {
        socket.emit("server-busy");
        return;
      }

      // ✅ Increment received counter
      incrementReceived();
      totalMessagesReceived++;

      if (totalMessagesReceived % 1000 === 0) {
        console.log(`[SOCKET RECEIVED] ${totalMessagesReceived} messages`);
      }

       // const allowed = await canSendMessage(userId);
          // if (!allowed) {
          //   socket.emit("rate-limit");
          //   return;
          // }
          
      const snowflake = snowflakeGn.generate().toString();
      const createdAt = new Date();
      const createdAtISO = createdAt.toISOString();

      const message = {
        socketId: socket.id,
        userId,
        username,
        content,
        snowflake,
        createdAt: createdAtISO,
      };

      const payload = {
        ...message,
        createdAt: createdAtISO,
      };

      outboundQueue.push(payload);
      pushRecent(payload);
      await appendMessage(message);
    ack?.({
        ok: true,
        snowflake,
      });
    } catch (err) {
      ack?.({
        ok: false,
        error: err.message,
      });
    }
  }
);

    /* ---------------- TYPING ---------------- */
    socket.on("typing:start", () => {
      socket.to("global-chat").volatile.emit("typing:start", {
        userId: socket.userId,
        username: socket.username,
      });
    });

    socket.on("typing:stop", () => {
      socket.to("global-chat").volatile.emit("typing:stop", socket.userId);
    });
  });
}