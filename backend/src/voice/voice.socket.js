import { getNextWorker } from "./mediasoup.js";

const rooms = new Map();
/*
rooms structure:
roomId -> {
  router,
  audioObserver,
  peers: Map(socketId -> {
    sendTransport,
    recvTransport,
    producers: [],
    consumers: []
  })
}
*/

export function initVoiceNamespace(io) {
    const voice = io.of("/voice");

    voice.on("connection", (socket) => {
        console.log("Voice user connected:", socket.id);

        /* ---------------- JOIN ROOM ---------------- */

        socket.on("voice:joinRoom", async ({ roomId, username }) => {
            if (!rooms.has(roomId)) {
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
                console.log(`Room ${roomId} assigned to worker ${worker.pid}`);
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

                audioObserver.on("volumes", (volumes) => {
                    if (!volumes.length) return;

                    const { producer } = volumes[0];

                    voice.to(roomId).emit("voice:activeSpeaker", {
                        
                        socketId: producer.appData.socketId
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

            socket.emit("voice:joined");
        });
        /* socket.on("voice:joinRoom", ({ roomId, username  }) => {
            if (!roomId) return;

            socket.join(roomId);

            if (!rooms.has(roomId)) {
                rooms.set(roomId, { peers: new Map() });
            }

            const room = rooms.get(roomId);

            room.peers.set(socket.id, {
                username,
                sendTransport: null,
                recvTransport: null,
                producers: [],
                consumers: [],
            });

            socket.roomId = roomId;

            console.log(`User ${socket.id} joined voice room ${roomId}`);

            // Send existing producers to new joiner
            const existingProducers = [];

            for (const [otherSocketId, otherPeer] of room.peers) {
                if (otherSocketId === socket.id) continue;

                otherPeer.producers.forEach((producer) => {
                    existingProducers.push({
                        producerId: producer.id,
                        kind: producer.kind,
                        socketId: otherSocketId,
                        username: otherPeer.username,
                    });
                });
            }

            
        }); */

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

            socket.emit("voice:existingProducers", producers);
        });
        /* ---------------- CREATE TRANSPORT ---------------- */

        socket.on("voice:getRtpCapabilities", (_, callback) => {
            const room = rooms.get(socket.roomId);
            if (!room) return callback({ error: "Room not found" });
            callback(room.router.rtpCapabilities);
        });
        socket.on("voice:createTransport", async ({ type }, callback) => {
            try {
                if (!socket.roomId) {
                    return callback({ error: "Join room first" });
                }


                const room = rooms.get(socket.roomId);
                if (!room) return callback({ error: "Room not found" });
                const router = room.router;
                const peer = room?.peers.get(socket.id);

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

                    initialAvailableOutgoingBitrate: 500000// 500kbps aprox 240px
                });

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
                console.error("Transport creation error:", err);
                callback({ error: "Transport creation failed" });
            }
        });

        /* ---------------- CONNECT TRANSPORT ---------------- */

        socket.on(
            "voice:connectTransport",
            async ({ type, dtlsParameters }, callback) => {
                try {
                    const room = rooms.get(socket.roomId);
                    if (!room) return callback({ error: "Room not found" });
                    const peer = room?.peers.get(socket.id);
                    if (!peer) return callback({ error: "Peer not found" });

                    if (type === "send" && peer.sendTransport) {
                        await peer.sendTransport.connect({ dtlsParameters });
                    } else if (type === "recv" && peer.recvTransport) {
                        await peer.recvTransport.connect({ dtlsParameters });
                    }

                    callback({ connected: true });
                } catch (err) {
                    console.error("Transport connect error:", err);
                    callback({ error: "Connect failed" });
                }
            }
        );
        /* ---------------- PRODUCE ---------------- */

        socket.on("voice:produce", async ({ kind, rtpParameters }, callback) => {
            try {
                const room = rooms.get(socket.roomId);
                if (!room) return callback({ error: "Room not found" });

                const peer = room?.peers.get(socket.id);
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

                if (kind === "audio") {
                    room.audioObserver.addProducer({ producerId: producer.id });

                     producer.on("pause", () => {
    room.audioObserver.removeProducer({ producerId: producer.id });
  });

  producer.on("resume", () => {
    room.audioObserver.addProducer({ producerId: producer.id });
  });
                }
                // Notify others in the same room
                socket.to(socket.roomId).emit("voice:newProducer", {
                    producerId: producer.id,
                    kind,
                    socketId: socket.id,
                    username: peer.username,
                });

                // Handle producer close
                producer.on("close", () => {
                    peer.producers = peer.producers.filter(p => p.id !== producer.id);

                    socket.to(socket.roomId).emit("voice:producerClosed", {
                        producerId: producer.id,
                    });

                    room.peers.forEach(p =>{
                        p.consumers = p.consumers.filter(c => {
                            if(c.producerId === producer.id){
                                c.close();
                                return false;
                            }
                            return true;
                        })
                    })
                });

                callback({ id: producer.id });
            } catch (err) {
                console.error("Produce error:", err);
                callback({ error: "Produce failed" });
            }
        });

        /* ---------------- CONSUME ---------------- */


        socket.on(
            "voice:consume",
            async ({ producerId, rtpCapabilities }, callback) => {
                try {

                    const room = rooms.get(socket.roomId);
                    if (!room) return callback({ error: "Room not found" });
                    const router = room.router;
                    const peer = room?.peers.get(socket.id);

                    if (!peer || !peer.recvTransport) {
                        return callback({ error: "No recv transport" });
                    }

                    if (!router.canConsume({ producerId, rtpCapabilities })) {
                        return callback({ error: "Cannot consume" });
                    }

                    const consumer = await peer.recvTransport.consume({
                        producerId,
                        rtpCapabilities,
                        paused: true, // IMPORTANT
                    });

                    peer.consumers.push(consumer);

                    // Resume AFTER creation
                    await consumer.resume();

                    consumer.on("transportclose", () => {
                        consumer.close();
                    });

                    callback({
                        id: consumer.id,
                        producerId,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                    });
                } catch (err) {
                    console.error("Consume error:", err);
                    callback({ error: "Consume failed" });
                }
            }
        );

        /* ---------------- DISCONNECT ---------------- */

        socket.on("voice:leaveRoom", () => {
            const room = rooms.get(socket.roomId);
            if (!room) return;

            const peer = room.peers.get(socket.id);
            if (!peer) return;

            peer.producers.forEach((p) => p.close());
            peer.consumers.forEach((c) => c.close());
            if (peer.sendTransport) peer.sendTransport.close();
            if (peer.recvTransport) peer.recvTransport.close();

            room.peers.delete(socket.id);

            if (room.peers.size === 0) {
                room.audioObserver.close();
                room.router.close();
                rooms.delete(socket.roomId);
            }
            socket.leave(socket.roomId);
        });
        socket.on("disconnect", () => {
            const room = rooms.get(socket.roomId);
            if (!room) return;

            room.peers.delete(socket.id);

            if (room.peers.size === 0) {
                room.audioObserver.close();
                room.router.close();
                rooms.delete(socket.roomId);
            }
            socket.to(socket.roomId).emit("voice:peerLeft", {
                socketId: socket.id,
            });
        });
    });
}