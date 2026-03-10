import { getNextWorker } from "./mediasoup.js";

const rooms = new Map();

/*
rooms structure:
roomId -> {
  router,
  audioObserver,
  peers: Map(socketId -> {
    username,
    sendTransport,
    recvTransport,
    producers: [],
    consumers: []
  })
}
*/

function log(socket, event, data = "") {
  console.log(`[VOICE] [${event}] [socket:${socket.id}]`, data || "");
}

export function initVoiceNamespace(io) {

  const voice = io.of("/voice");

  voice.on("connection", (socket) => {

    console.log(`[VOICE] User connected ${socket.id}`);

    /* ---------------- JOIN ROOM ---------------- */

    socket.on("voice:joinRoom", async ({ roomId, username }) => {

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
              mimeType: "video/VP8",
              clockRate: 90000,
            },
          ],
        });

        console.log(`[VOICE] Room ${roomId} assigned to worker ${worker.pid}`);

        const audioObserver = await router.createAudioLevelObserver({
          maxEntries: 1,
          threshold: -80,
          interval: 800,
        });

        rooms.set(roomId, {
          router,
          audioObserver,
          peers: new Map(),
        });

        let lastSpeaker = null;

audioObserver.on("volumes", (volumes) => {
  if (!volumes.length) return;

  const speaker = volumes[0].producer.appData.socketId;

  if (speaker === lastSpeaker) return;

  lastSpeaker = speaker;

  voice.to(roomId).emit("voice:activeSpeaker", {
    socketId: speaker
  });
});

      }

      const room = rooms.get(roomId);

      socket.join(roomId);
      socket.roomId = roomId;

      room.peers.set(socket.id, {
        username,
        sendTransport: null,
        recvTransport: null,
        producers: [],
        consumers: [],
      });

      console.log(`[VOICE] Peer joined room ${roomId} totalPeers=${room.peers.size}`);

      socket.emit("voice:joined");

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
          initialAvailableOutgoingBitrate: 500000
        });

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

          room.audioObserver.addProducer({ producerId: producer.id });

          producer.on("pause", () => {
            room.audioObserver.removeProducer({ producerId: producer.id });
          });

          producer.on("resume", () => {
            room.audioObserver.addProducer({ producerId: producer.id });
          });

        }

        console.log(`[VOICE] Broadcasting new producer ${producer.id}`);

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

          peer.producers = peer.producers.filter(p => p.id !== producer.id);

          socket.to(socket.roomId).emit("voice:producerClosed", {
            producerId: producer.id,
          });

          room.peers.forEach(p => {

            p.consumers = p.consumers.filter(c => {

              if (c.producerId === producer.id) {
                c.close();
                return false;
              }

              return true;

            });

          });

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
          paused: false,
        });

        peer.consumers.push(consumer);

        console.log(`[VOICE] CONSUMER_CREATED ${consumer.id} for producer ${producerId}`);

        consumer.on("transportclose", () => {
          consumer.close();
        });

        consumer.on("producerclose", () => {

          console.log(`[VOICE] Producer closed for consumer ${consumer.id}`);

          consumer.close();

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

      const peer = room.peers.get(socket.id);
      if (!peer) return;

      peer.producers.forEach(p => p.close());
      peer.consumers.forEach(c => c.close());

      if (peer.sendTransport) peer.sendTransport.close();
      if (peer.recvTransport) peer.recvTransport.close();

      room.peers.delete(socket.id);

      console.log(`[VOICE] Peer left room ${socket.roomId} remaining=${room.peers.size}`);

      if (room.peers.size === 0) {

        console.log(`[VOICE] Closing room ${socket.roomId}`);

        room.audioObserver.close();
        room.router.close();

        rooms.delete(socket.roomId);

      }

      socket.leave(socket.roomId);

    });

    /* ---------------- DISCONNECT ---------------- */

   socket.on("disconnect", () => {

  log(socket, "DISCONNECT");

  const room = rooms.get(socket.roomId);
  if (!room) return;

  const peer = room.peers.get(socket.id);
  if (!peer) return;

  peer.producers.forEach(p => p.close());
  peer.consumers.forEach(c => c.close());

  peer.sendTransport?.close();
  peer.recvTransport?.close();

  room.peers.delete(socket.id);

  socket.to(socket.roomId).emit("voice:peerLeft", {
    socketId: socket.id,
  });

});

  });

}