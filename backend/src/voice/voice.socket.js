import { getNextWorker } from "./mediasoup.js";

const rooms = new Map();

/*
rooms structure:
roomId -> {
  router,
  audioObserver,
  peers: Map(socketId -> {
    socketId,
    username,
    sendTransport,
    recvTransport,
    producers: [],
    consumers: [],
    consumerMap: Map(),
    visibleUsers: Set(socketId),
    mode: "focus" | "gallery",
    maxBitrate
  }),
  aS,
  updateTimeout,
  resumeTimers
}
*/

const MAX_VIDEO_STREAMS = {
  focus: 6,
  gallery: 16,
};

function log(socket, event, data = "") {
  console.log(`[VOICE] [${event}] [socket:${socket.id}]`, data || "");
}

function clearResumeTimers(room) {
  if (!room.resumeTimers) return;
  for (const timer of room.resumeTimers) {
    clearTimeout(timer);
  }
  room.resumeTimers.clear();
}

function cleanupPeer(room, socket, reason = "unknown") {
  const peer = room.peers.get(socket.id);
  if (!peer) return;

  console.log(`[VOICE] Cleaning peer ${socket.id} reason=${reason}`);

  const closedProducerIds = [];

  peer.producers.forEach((producer) => {
    try {
      closedProducerIds.push({
        producerId: producer.id,
        kind: producer.kind,
      });
      producer.close();
    } catch {}
  });

  peer.consumers.forEach((consumer) => {
    try {
      consumer.close();
    } catch {}
  });

  try {
    peer.sendTransport?.close();
  } catch {}

  try {
    peer.recvTransport?.close();
  } catch {}

  room.peers.delete(socket.id);

  if (room.aS === socket.id) {
    room.aS = null;
  }

  // tell others this peer is fully gone
  socket.to(socket.roomId).emit("voice:peerLeft", {
    socketId: socket.id,
  });

  // also tell others all producers are gone
  closedProducerIds.forEach(({ producerId, kind }) => {
    socket.to(socket.roomId).emit("voice:producerClosed", {
      producerId,
      socketId: socket.id,
      kind,
    });
  });

  safeUpdate(room);

  console.log(
    `[VOICE] Peer cleaned ${socket.id} remaining=${room.peers.size}`
  );

  if (room.peers.size === 0) {
    console.log(`[VOICE] Closing room ${socket.roomId}`);

    clearResumeTimers(room);

    try {
      room.audioObserver.close();
    } catch {}

    try {
      room.router.close();
    } catch {}

    rooms.delete(socket.roomId);
  }
}

function safeUpdate(room) {
  if (room.updateTimeout) return;

  room.updateTimeout = setTimeout(() => {
    clearResumeTimers(room);
    updateAllConsumers(room);
    room.updateTimeout = null;
  }, 50);
}

export function initVoiceNamespace(io) {
  const voice = io.of("/voice");

  voice.on("connection", (socket) => {
    console.log(`[VOICE] User connected ${socket.id}`);

    /* ---------------- JOIN ROOM ---------------- */
    socket.on("voice:joinRoom", async ({ roomId, username }, callback) => {
      try {
        log(socket, "JOIN_ROOM", { roomId, username });

        if (!rooms.has(roomId)) {
          console.log(`[VOICE] Creating router for room ${roomId}`);

          const worker = getNextWorker();

          const router = await worker.createRouter({
            mediaCodecs: [
              {
                kind: "audio",
                mimeType: "audio/opus",
                clockRate: 48000,
                channels: 2,
              },
              {
                kind: "video",
                mimeType: "video/VP9",
                clockRate: 90000,
                parameters: {
                  "profile-id": 2,
                },
              },
            ],
          });

          console.log(`[VOICE] Room ${roomId} assigned to worker ${worker.pid}`);

          const audioObserver = await router.createAudioLevelObserver({
            maxEntries: 1,
            threshold: -55,
            interval: 500,
          });

          rooms.set(roomId, {
            router,
            audioObserver,
            peers: new Map(),
            aS: null,
            updateTimeout: null,
            resumeTimers: new Set(),
          });

          audioObserver.on("volumes", (volumes) => {
            if (!volumes.length) return;

            const speaker = volumes[0].producer.appData.socketId;
            const room = rooms.get(roomId);
            if (!room) return;

            if (room.aS === speaker) return;

            room.aS = speaker;

            voice.to(roomId).emit("voice:activeSpeaker", {
              socketId: speaker,
            });

            safeUpdate(room);
          });

          audioObserver.on("silence", () => {
            const room = rooms.get(roomId);
            if (!room) return;

            room.aS = null;

            voice.to(roomId).emit("voice:activeSpeaker", {
              socketId: null,
            });

            safeUpdate(room);
          });
        }

        const room = rooms.get(roomId);

        socket.join(roomId);
        socket.roomId = roomId;

        room.peers.set(socket.id, {
          socketId: socket.id,
          username,
          sendTransport: null,
          recvTransport: null,
          producers: [],
          consumers: [],
          consumerMap: new Map(),
          visibleUsers: new Set(),
          mode: "focus",
          maxBitrate: 2000000,
        });

        console.log(
          `[VOICE] Peer joined room ${roomId} totalPeers=${room.peers.size}`
        );

        callback?.({ joined: true });
      } catch (err) {
        console.error("[VOICE] Join room error:", err);
        callback?.({ error: "Join room failed" });
      }
    });

    /* ---------------- GET PRODUCERS ---------------- */
    socket.on("voice:getProducers", () => {
      const room = rooms.get(socket.roomId);
      if (!room) return;

      const producers = [];

      for (const [otherSocketId, otherPeer] of room.peers) {
        if (otherSocketId === socket.id) continue;

        otherPeer.producers.forEach((producer) => {
          producers.push({
            producerId: producer.id,
            kind: producer.kind,
            socketId: otherSocketId,
            username: otherPeer.username,
          });
        });
      }

      console.log(`[VOICE] Sending ${producers.length} producers to ${socket.id}`);
      socket.emit("voice:existingProducers", producers);
    });

    /* ---------------- VISIBLE USERS ---------------- */
    socket.on("voice:updateVisible", ({ visibleUsers, mode }) => {
      const room = rooms.get(socket.roomId);
      if (!room) return;

      const peer = room.peers.get(socket.id);
      if (!peer) return;

      peer.visibleUsers = new Set(visibleUsers);
      peer.mode = mode;

      // minimal bandwidth growth
      peer.maxBitrate = mode === "gallery" ? 800000 : 2000000;

      if (peer.recvTransport) {
        peer.recvTransport
          .setMaxIncomingBitrate(peer.maxBitrate)
          .catch(() => {});
      }

      safeUpdate(room);
    });

    /* ---------------- MEDIA STATE ---------------- */
    socket.on("voice:mediaState", ({ audio, video }) => {
      if (!socket.roomId) return;
      const room = rooms.get(socket.roomId);
      if (!room) return;

      socket.to(socket.roomId).emit("voice:mediaState", {
        socketId: socket.id,
        audio,
        video,
      });
    });

    /* ---------------- RTP CAPABILITIES ---------------- */
    socket.on("voice:getRtpCapabilities", (_, callback) => {
      const room = rooms.get(socket.roomId);
      if (!room) return callback({ error: "Room not found" });

      console.log(`[VOICE] RTP capabilities requested by ${socket.id}`);
      callback(room.router.rtpCapabilities);
    });

    /* ---------------- CREATE TRANSPORT ---------------- */
    socket.on("voice:createTransport", async ({ type }, callback) => {
      try {
        log(socket, "CREATE_TRANSPORT", { type });

        if (!socket.roomId) {
          return callback({ error: "Join room first" });
        }

        const room = rooms.get(socket.roomId);
        if (!room) return callback({ error: "Room not found" });

        const router = room.router;
        const peer = room.peers.get(socket.id);

        if (!peer) return callback({ error: "Peer not found" });

        const transport = await router.createWebRtcTransport({
          listenIps: [
            {
              ip: "0.0.0.0",
              announcedIp: process.env.PUBLIC_IP || "127.0.0.1",
            },
          ],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          initialAvailableOutgoingBitrate: 1000000,
        });

        transport
          .setMaxIncomingBitrate(peer.maxBitrate || 2000000)
          .catch(() => {});

        console.log(`[VOICE] Transport created type=${type} socket=${socket.id}`);

        if (type === "send") {
          peer.sendTransport = transport;
        } else {
          peer.recvTransport = transport;
        }

        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (err) {
        console.error("[VOICE] Transport creation error:", err);
        callback({ error: "Transport creation failed" });
      }
    });

    /* ---------------- CONNECT TRANSPORT ---------------- */
    socket.on("voice:connectTransport", async ({ type, dtlsParameters }, callback) => {
      try {
        log(socket, "TRANSPORT_CONNECT", { type });

        const room = rooms.get(socket.roomId);
        if (!room) return callback({ error: "Room not found" });

        const peer = room.peers.get(socket.id);
        if (!peer) return callback({ error: "Peer not found" });

        if (type === "send" && peer.sendTransport) {
          await peer.sendTransport.connect({ dtlsParameters });
        }

        if (type === "recv" && peer.recvTransport) {
          await peer.recvTransport.connect({ dtlsParameters });
        }

        callback({ connected: true });
      } catch (err) {
        console.error("[VOICE] Transport connect error:", err);
        callback({ error: "Connect failed" });
      }
    });

    /* ---------------- PRODUCE ---------------- */
    socket.on("voice:produce", async ({ kind, rtpParameters }, callback) => {
      try {
        log(socket, "PRODUCE_REQUEST", { kind });

        const room = rooms.get(socket.roomId);
        if (!room) return callback({ error: "Room not found" });

        const peer = room.peers.get(socket.id);

        if (!peer || !peer.sendTransport) {
          return callback({ error: "No send transport" });
        }

        const producer = await peer.sendTransport.produce({
          kind,
          rtpParameters,
          appData: {
            socketId: socket.id,
          },
        });

        peer.producers.push(producer);

        console.log(`[VOICE] PRODUCER_CREATED ${producer.id} kind=${kind}`);

        if (kind === "audio") {
          room.audioObserver.addProducer({ producerId: producer.id }).catch(() => {});

          producer.on("pause", () => {
            room.audioObserver.removeProducer({ producerId: producer.id }).catch(() => {});
          });

          producer.on("resume", () => {
            room.audioObserver.addProducer({ producerId: producer.id }).catch(() => {});
          });
        }

        console.log(`[VOICE] Broadcasting new producer ${producer.id}`);

        safeUpdate(room);

        room.peers.forEach((otherPeer, otherSocketId) => {
          if (otherSocketId === socket.id) return;
          if (!otherPeer.recvTransport) return;

          voice.to(otherSocketId).emit("voice:newProducer", {
            producerId: producer.id,
            kind,
            socketId: socket.id,
            username: peer.username,
          });
        });

        producer.on("close", () => {
          console.log(`[VOICE] Producer closed ${producer.id}`);

          peer.producers = peer.producers.filter((p) => p.id !== producer.id);

          socket.to(socket.roomId).emit("voice:producerClosed", {
            producerId: producer.id,
            socketId: socket.id,
            kind: producer.kind,
          });

          room.peers.forEach((p) => {
            p.consumers = p.consumers.filter((c) => {
              if (c.producerId === producer.id) {
                try {
                  c.close();
                } catch {}
                p.consumerMap.delete(producer.id);
                return false;
              }
              return true;
            });
          });

          safeUpdate(room);
        });

        callback({ id: producer.id });
      } catch (err) {
        console.error("[VOICE] Produce error:", err);
        callback({ error: "Produce failed" });
      }
    });

    /* ---------------- CONSUME ---------------- */
    socket.on("voice:consume", async ({ producerId, rtpCapabilities }, callback) => {
      try {
        log(socket, "CONSUME_REQUEST", { producerId });

        const room = rooms.get(socket.roomId);
        if (!room) return callback({ error: "Room not found" });

        const router = room.router;
        const peer = room.peers.get(socket.id);

        if (!peer || !peer.recvTransport) {
          return callback({ error: "No recv transport" });
        }

        if (!router.canConsume({ producerId, rtpCapabilities })) {
          return callback({ error: "Cannot consume" });
        }

        const consumer = await peer.recvTransport.consume({
          producerId,
          rtpCapabilities,
          paused: true,
        });

        peer.consumers.push(consumer);
        peer.consumerMap.set(producerId, consumer);

        safeUpdate(room);

        console.log(`[VOICE] CONSUMER_CREATED ${consumer.id} for producer ${producerId}`);

        consumer.on("transportclose", () => {
          try {
            consumer.close();
          } catch {}
        });

        consumer.on("producerclose", () => {
          console.log(`[VOICE] Producer closed for consumer ${consumer.id}`);

          try {
            consumer.close();
          } catch {}

          peer.consumers = peer.consumers.filter((c) => c.id !== consumer.id);
          peer.consumerMap.delete(producerId);
        });

        callback({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (err) {
        console.error("[VOICE] Consume error:", err);
        callback({ error: "Consume failed" });
      }
    });

    /* ---------------- LEAVE ROOM ---------------- */
    socket.on("voice:leaveRoom", () => {
      log(socket, "LEAVE_ROOM");

      const room = rooms.get(socket.roomId);
      if (!room) return;

      cleanupPeer(room, socket, "leaveRoom");

      try {
        socket.leave(socket.roomId);
      } catch {}
    });

    /* ---------------- DISCONNECT ---------------- */
    socket.on("disconnect", () => {
      log(socket, "DISCONNECT");

      const room = rooms.get(socket.roomId);
      if (!room) return;

      cleanupPeer(room, socket, "disconnect");
    });
  });
}

function updateAllConsumers(room) {
  room.peers.forEach((peer) => {
    updateConsumers(room, peer);
  });
}

function updateConsumers(room, peer) {
  const maxStreams = MAX_VIDEO_STREAMS[peer.mode];
  let videoCount = 0;
  let resumeIndex = 0;

  const sortedPeers = [...room.peers.values()].sort((a, b) => {
    if (a.socketId === room.aS) return -1;
    if (b.socketId === room.aS) return 1;
    return 0;
  });

  for (const other of sortedPeers) {
    for (const producer of other.producers) {
      if (producer.appData.socketId === peer.socketId) continue;

      let consumer = peer.consumerMap.get(producer.id);

      if (!consumer || consumer.closed) {
        peer.consumerMap.delete(producer.id);
        continue;
      }

      const isVisible = peer.visibleUsers.has(producer.appData.socketId);
      const isSpeaker = room.aS === producer.appData.socketId;

      // audio always flows
      if (producer.kind === "audio") {
        if (consumer.paused) {
          consumer.resume().catch(() => {});
        }
        continue;
      }

      const shouldReceiveSpeaker = isSpeaker && videoCount < maxStreams;
      const shouldReceiveVisible = isVisible && videoCount < maxStreams;
      const shouldReceive = shouldReceiveSpeaker || shouldReceiveVisible;

      if (shouldReceive) {
        const delay = isSpeaker ? 0 : resumeIndex * 15;

        const timer = setTimeout(() => {
          room.resumeTimers.delete(timer);

          if (consumer.closed) return;

          if (consumer.paused) {
            consumer.resume().catch(() => {});
          }

          if (consumer.type === "simulcast" || consumer.type === "svc") {
            let spatialLayer = 0;

            if (isSpeaker) spatialLayer = 2;
            else if (isVisible) spatialLayer = 1;
            else spatialLayer = 0;

            consumer
              .setPreferredLayers({
                spatialLayer,
                temporalLayer: isSpeaker ? 2 : 1,
              })
              .catch(() => {});
          }

          consumer.appData = consumer.appData || {};

          if (
            !consumer.appData.lastKeyframe ||
            Date.now() - consumer.appData.lastKeyframe > 3000
          ) {
            consumer.requestKeyFrame?.();
            consumer.appData.lastKeyframe = Date.now();
          }
        }, delay);

        room.resumeTimers.add(timer);
        videoCount++;
        resumeIndex++;
      } else {
        if (!consumer.paused) {
          consumer.pause().catch(() => {});
        }
      }
    }
  }
}