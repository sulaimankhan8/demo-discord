import { Server } from "socket.io";

import { redis } from "./redis/index.js";
//import { appendMessageWithConcurrencyLimit } from "./redis/messageStream/messageStream.js";
import { createAdapter }
from "@socket.io/redis-adapter";

import {
  pubClient,
  subClient,
} from "./redis/adapter.js";
import { 
  queueMessage,  // ✅ Use batching
  appendMessage,  // Fallback for single messages
  getXaddStats 
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


import Snowflake
from "./snowflake.js";

import {
  eventBus,
} from "./events/eventBus.js";

import {
  EVENTS,
} from "./events/events.js";

import {
  initVoiceNamespace,
} from "./voice/voice.socket.js";
import { subscriber } from "./redis/pubsub/subscriber.js";

import {
  CHANNELS
} from "./redis/pubsub/channels.js";

/* ---------------- CONFIG ---------------- */

const MAX_OUTBOUND_BATCH = 1000;

const OUTBOUND_FLUSH_INTERVAL = 5;

/* ---------------- STATE ---------------- */

let io;

const outboundQueue = [];

/* ---------------- RECENT IN MEMORY ---------------- */

export const recentMessages = [];

const RECENT_LIMIT = 100;

// Track total messages received across all sockets
let totalMessagesReceived = 0;

function pushRecent(message) {
  recentMessages.push(message);

  if (
    recentMessages.length >
    RECENT_LIMIT
  ) {
    recentMessages.shift();
  }
}

/* ---------------- SNOWFLAKE ---------------- */

const snowflakeGn =
  new Snowflake({
    datacenterId: 1,
    workerId:
  Number(process.env.NODE_APP_INSTANCE || 0)
  });

/* ---------------- BROADCAST ---------------- */

function broadcastBatch(batch) {
  if (!batch.length) return;

  io.to("global-chat")
    .emit(
      "new-message-batch",
      batch
    );
}

setInterval(() => {
  if (
    outboundQueue.length === 0
  ) {
    return;
  }

  const batch =
    outboundQueue.splice(
      0,
      MAX_OUTBOUND_BATCH
    );

  broadcastBatch(batch);

}, OUTBOUND_FLUSH_INTERVAL);

/* ---------------- ACK PUBSUB ---------------- */

async function initAckSubscriber() {

  await subscriber.subscribe(
    CHANNELS.MESSAGE_ACK
  );

  subscriber.on(
    "message",
    (channel, payload) => {

      if (
        channel !==
        CHANNELS.MESSAGE_ACK
      ) {
        return;
      }

      const data =
        JSON.parse(payload);

      io.to(data.socketId)
        .emit(
          "message:ack",
          {
            snowflake:
              data.snowflake,
          }
        );
    }
  );
}

/* ---------------- SOCKET ---------------- */

export function initSocket(
  server
) {

  io = new Server(server, {
    cors: {
      origin: "*",
    },

    transports: [
      "websocket",
    ],

    allowUpgrades: false,

    pingInterval:
      20000,

    pingTimeout:
      20000,
  });

  io.adapter(
    createAdapter(
      pubClient,
      subClient
    )
  );

  initVoiceNamespace(io);

  initAckSubscriber();

  io.on(
    "connection",
    async (socket) => {

      console.log(
        "[CONNECTED]",
        process.pid,
        socket.id
      );

      socket.join(
        "global-chat"
      );

      /* ---------------- PRESENCE INIT ---------------- */

      const users =
        await getOnlineUsers();

      socket.emit(
        "presence:update",
        { users }
      );

      /* ---------------- ONLINE ---------------- */

      socket.on(
        "presence:online",
        async ({
          userId,
          username,
        }) => {

          socket.userId =
            userId;

          socket.username =
            username;

          await setOnline({
            userId,
            username,
            socketId:
              socket.id,

            status:
              "online",
          });

          eventBus.emit(
            EVENTS.USER_ONLINE,
            {
              userId,
              username,
            }
          );

          socket
            .to(
              "global-chat"
            )
            .emit(
              "presence:update",
              {
                userId,
                username,
                status:
                  "online",
              }
            );
        }
      );

      /* ---------------- HEARTBEAT ---------------- */

      socket.on(
        "presence:heartbeat",
        async () => {

          if (
            !socket.userId
          ) {
            return;
          }

          await refreshPresence({
            userId:
              socket.userId,

            username:
              socket.username,

            socketId:
              socket.id,
          });
        }
      );

      /* ---------------- DISCONNECT ---------------- */

      socket.on(
        "disconnect",
        async () => {

          if (
            !socket.userId
          ) {
            return;
          }

          const fullyOffline =
            await setOffline(
              socket.userId,
              socket.id
            );

          if (
            !fullyOffline
          ) {
            return;
          }

          eventBus.emit(
            EVENTS.USER_OFFLINE,
            {
              userId:
                socket.userId,

              username:
                socket.username,
            }
          );

          socket
            .to(
              "global-chat"
            )
            .emit(
              "presence:update",
              {
                userId:
                  socket.userId,

                status:
                  "offline",
              }
            );
        }
      );

      /* ---------------- SEND MESSAGE ---------------- */

      // Track pending message operations to prevent duplicates
      const pendingMessages = new Map();
      const MAX_RETRIES = 3;
      const RETRY_DELAY = 1000;

      async function appendMessageWithRetry(message, retryCount = 0) {
        const messageId = message.snowflake;
        
        // If this message is already being processed, return the existing promise
        if (pendingMessages.has(messageId)) {
          return pendingMessages.get(messageId);
        }

        // Create the operation promise
        const operation = (async () => {
          try {
            const result = await appendMessage(message);
            // Remove from pending on success
            pendingMessages.delete(messageId);
            return result;
          } catch (err) {
            if (retryCount < MAX_RETRIES) {
              console.log(`[RETRY ${retryCount + 1}/${MAX_RETRIES}]`, message.snowflake);
              // Wait with exponential backoff
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (retryCount + 1)));
              // Retry - remove from pending first to allow new attempt
              pendingMessages.delete(messageId);
              return appendMessageWithRetry(message, retryCount + 1);
            } else {
              // Critical failure - log to dead letter queue
              console.error('[DLQ] Failed to append message after all retries', message);
              try {
                await redis.lpush('dlq:messages', JSON.stringify(message));
              } catch (dlqErr) {
                console.error('[DLQ ERROR] Failed to save to DLQ', dlqErr);
              }
              // Remove from pending
              pendingMessages.delete(messageId);
              throw err;
            }
          }
        })();

        // Store the promise in pending map
        pendingMessages.set(messageId, operation);
        return operation;
      }

      socket.on(
        "send-message",
        async ({
          userId,
          username,
          content,
        }) => {

          if (io.engine.clientsCount > 2000) {
            socket.emit("server-busy");
            return;
          }
            totalMessagesReceived++;
  if (totalMessagesReceived % 1000 === 0) {
    console.log(`[SOCKET RECEIVED] ${totalMessagesReceived} messages`);
  }

          // const allowed = await canSendMessage(userId);
          // if (!allowed) {
          //   socket.emit("rate-limit");
          //   return;
          // }

          const allowed = true;
          const snowflake = snowflakeGn.generate().toString();
          const createdAt = new Date();

          const message = {
            socketId: socket.id,
            userId,
            username,
            content,
            snowflake,
            createdAt,
          };

          /*
            Optimistic realtime - send to clients immediately
          */
          const payload = {
            ...message,
            createdAt: createdAt.toISOString(),
          };

          outboundQueue.push(payload);
          pushRecent(payload);
queueMessage(message);
          /*
            Durable write with retry and deduplication
          */
        //  await  appendMessageWithRetry(message).catch((err) => {
        //     console.error('[CRITICAL] Message lost despite retries', message, err);
        //     socket.emit('message:error', { 
        //       snowflake, 
        //       error: 'Failed to persist message' 
        //     });
        //   });
        }
      );

      /* ---------------- TYPING ---------------- */

      socket.on(
        "typing:start",
        () => {

          socket
            .to(
              "global-chat"
            )
            .volatile.emit(
              "typing:start",
              {
                userId:
                  socket.userId,

                username:
                  socket.username,
              }
            );
        }
      );

      socket.on(
        "typing:stop",
        () => {

          socket
            .to(
              "global-chat"
            )
            .volatile.emit(
              "typing:stop",
              socket.userId
            );
        }
      );
    }
  );
} 