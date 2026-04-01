"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import * as mediasoupClient from "mediasoup-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthSocket } from "@/hooks/useAuthSocket";
import { getVoiceSocket } from "@/lib/voiceSocket";

const ROOM_ID = "global-voice";

type PeerVideo = {
  socketId: string;
  username: string;
  stream: MediaStream;
  isSelf?: boolean;
};

type UserWithProducers = {//to be updated
  socketId: string;
  username: string;
  producers: Record<string, ProducerInfo>;
};



type ProducerInfo = {
  producerId: string;
  socketId: string;
  username: string;
  kind: "audio" | "video";
};

export default function VoiceRoom() {
  const LOG_PREFIX = "[VoiceRoom]";
  const log = (...args: any[]) => console.log(LOG_PREFIX, ...args);
  const info = (...args: any[]) => console.info(LOG_PREFIX, ...args);
  const warn = (...args: any[]) => console.warn(LOG_PREFIX, ...args);


  const [joined, setJoined] = useState(false);
  const [peers, setPeers] = useState<PeerVideo[]>([]);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);

  const [page, setPage] = useState(0);
  const [allUsers, setAllUsers] = useState<UserWithProducers[]>([]);
  const [mode, setMode] = useState<"focus" | "gallery">("focus");
  const PAGE_SIZE = mode === "focus" ? 6 : 24;
  const consumedSetRef = useRef(new Set());

  const socketRef = useRef<any>(null);
  const deviceRef = useRef<any>(null);
  const sendTransportRef = useRef<any>(null);
  const recvTransportRef = useRef<any>(null);
  const audioProducerRef = useRef<any>(null);
  const videoProducerRef = useRef<any>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const joiningRef = useRef(false);

  const router = useRouter();
  useAuthSocket();

  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (!stored) {
      log("no user in localStorage — redirecting to /");
      router.push("/");
    } else {
      log("found user in localStorage");
    }
  }, []);

  /* -------------------------------- LEAVE VOICE -------------------------------- */

  const leaveVoice = () => {
    log("leaveVoice() called");

    if (socketRef.current) {
      log("emitting voice:leaveRoom to server", { socketId: socketRef.current.id });
      socketRef.current.emit("voice:leaveRoom");
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
      log("socket disconnected");
    }

    audioProducerRef.current?.close();
    videoProducerRef.current?.close();

    sendTransportRef.current?.close();
    recvTransportRef.current?.close();

    localStreamRef.current?.getTracks().forEach((t) => t.stop());

    

    socketRef.current = null;
    deviceRef.current = null;
    sendTransportRef.current = null;
    recvTransportRef.current = null;
    audioProducerRef.current = null;
    videoProducerRef.current = null;

    consumedSetRef.current.clear();

    setMuted(false);
    setCameraOff(false);
    setPeers([]);
    setJoined(false);
  };

  /* ---------------- DERIVED PAGINATION ---------------- */
  const finalVisibleUsers = useMemo(() => {
    const orderedUsers = [
      ...(activeSpeaker ? [activeSpeaker] : []),
      ...allUsers
        .map((u) => u.socketId)
        .filter((id) => id !== activeSpeaker),
    ];

    const paginated = orderedUsers.slice(
      page * PAGE_SIZE,
      (page + 1) * PAGE_SIZE
    );

    let result = [...paginated];

    if (activeSpeaker && !result.includes(activeSpeaker)) {
      result = [activeSpeaker, ...result.slice(0, PAGE_SIZE - 1)];
    }

    return result;
  }, [allUsers, activeSpeaker, page, PAGE_SIZE]);

  const totalUsers = allUsers.length;
  const totalPages = Math.ceil(totalUsers / PAGE_SIZE);

  /* ---------------- FIX PAGE OVERFLOW ---------------- */
  useEffect(() => {
    if (page >= totalPages) {
      setPage(Math.max(0, totalPages - 1));
    }
  }, [totalPages]);

  useEffect(() => {
    setPage(0);
  }, [mode]);

  /* ---------------- SERVER SYNC ---------------- */
  useEffect(() => {
    if (!socketRef.current) return;

    socketRef.current.emit("voice:updateVisible", {
      visibleUsers: finalVisibleUsers,
      mode,
    });
  }, [finalVisibleUsers, mode]);

  /* ---------------- CONSUME ---------------- */
  useEffect(() => {
  const run = async () => {
    for (const user of allUsers) {
      for (const producer of Object.values(user.producers)) {
        if (consumedSetRef.current.has(producer.producerId)) continue;

        consumedSetRef.current.add(producer.producerId);

        await consume(producer.producerId, user.username, user.socketId);
      }
    }
  };

  run();
}, [allUsers]);

const bringToFocus = (userId: string) => {
  setMode("focus");
  setPage(0);

  // small delay prevents layout jank
  requestAnimationFrame(() => {
    setActiveSpeaker(userId);
  });
};
  /* -------------------------------- CLEANUP -------------------------------- */

  useEffect(() => {
    return () => {
      log("component unmount — cleaning up transports and socket");
      socketRef.current?.disconnect();
      sendTransportRef.current?.close();
      recvTransportRef.current?.close();
    };
  }, []);

  /* -------------------------------- JOIN VOICE -------------------------------- */

  const joinVoice = async () => {
    if (joiningRef.current || joined) return;
    log("joinVoice() start", { joiningRef: joiningRef.current, joined });
    joiningRef.current = true;

    try {
      const user = JSON.parse(localStorage.getItem("user") || "{}");

      const socket = getVoiceSocket();
      socketRef.current = socket;
      log("obtained voice socket (pre-connect)", socket);

      socket.off("voice:existingProducers");
      socket.off("voice:newProducer");
      socket.off("voice:activeSpeaker");
      socket.off("voice:peerLeft");
      socket.off("voice:producerClosed");


      log("socketRef set", socket);

      const device = new mediasoupClient.Device();
      deviceRef.current = device;


      /* ---------- MEDIA FIRST (better ICE timing) ---------- */

      let stream: MediaStream;

      try {
        log("requesting getUserMedia");

        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: true,
            echoCancellation: true,
          },
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 }
          },
        });

      } catch (err) {
        warn("Media permission denied or getUserMedia failed", err);
        alert("Camera or microphone permission denied.");
        joiningRef.current = false;
        return;
      }

      log("obtained local media stream", {
        tracks: stream.getTracks().map((t) => ({
          id: t.id,
          kind: t.kind,
        })),
      });

      localStreamRef.current = stream;
      /* ---------- SOCKET LISTENERS ---------- */

      socket.on("voice:existingProducers", (producers: ProducerInfo[]) => {
        const map = new Map<
  string,
  {
    socketId: string;
    username: string;
    producers: Record<string, ProducerInfo>;
  }
>();

        producers.forEach((p) => {
    if (!map.has(p.socketId)) {
      map.set(p.socketId, {
        socketId: p.socketId,
        username: p.username,
        producers: {},
      });
    }

    map.get(p.socketId)!.producers[p.kind] = p;
  });

  setAllUsers([...map.values()]);
});


      socket.on("voice:newProducer", (producer) => {
        setAllUsers(prev => {
          const existing = prev.find(p => p.socketId === producer.socketId);

          if (existing) {
            existing.producers[producer.kind] = producer;
            return [...prev];
          }

          return [
            ...prev,
            {
              socketId: producer.socketId,
              username: producer.username,
              producers: { [producer.kind]: producer }
            }
          ];
        });
      });

      socket.on("voice:peerLeft", ({ socketId }) => {
        log("voice:peerLeft", { socketId });
        setPeers((prev) => prev.filter((p) => p.socketId !== socketId));
        setAllUsers((prev) => prev.filter((p) => p.socketId !== socketId));
      });

      socket.on("voice:producerClosed", ({ producerId }) => {
        consumedSetRef.current.delete(producerId);

        setPeers((prev) =>
          prev.filter((peer) => {
            const tracks = peer.stream
              .getTracks()
              .filter((t) => t.id !== producerId);

            peer.stream = new MediaStream(tracks);

            return peer.stream.getTracks().length > 0;
          })
        );
      });

      socket.on("voice:activeSpeaker", ({ socketId }) => {
        log("voice:activeSpeaker", { socketId });
        setActiveSpeaker(socketId);

        /*  setTimeout(() => {
           setActiveSpeaker(null);
         }, 1200); */
      });

      /* ---------- CONNECT ---------- */

      if (!socket.connected) {
        log("socket not connected yet — waiting for connect event");
        await new Promise<void>((resolve) => {
          socket.on("connect", () => {
            log("socket connected", { id: socket.id });
            resolve();
          });
        });
      } else {
        log("socket already connected", { id: socket.id });
      }

      log("emitting voice:joinRoom", { roomId: ROOM_ID, username: user.username });
      socket.emit("voice:joinRoom", {
        roomId: ROOM_ID,
        username: user.username,
      });

      /* ---------- LOAD DEVICE ---------- */

      log("requesting RTP capabilities from server");
      const rtpCapabilities = await new Promise<any>((res) =>
        socket.emit("voice:getRtpCapabilities", null, res)
      );

      log("received RTP capabilities", { rtpCapabilities });

      await device.load({ routerRtpCapabilities: rtpCapabilities });

      log("device.canProduce", {
        audio: device.canProduce("audio"),
        video: device.canProduce("video"),
      });

      /* ---------- SEND TRANSPORT ---------- */

      log("requesting createTransport (send)");
      const sendParams = await new Promise<any>((res) =>
        socket.emit("voice:createTransport", { type: "send" }, res)
      );

      log("receive send transport params", { sendParams });

      const sendTransport = device.createSendTransport({
        ...sendParams,
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          {
            urls: "turn:demo-discord.duckdns.org:3478?transport=tcp",
            username: "demo",
            credential: "strongpassword"
          },
          {
            urls: "turns:demo-discord.duckdns.org:5349",
            username: "demo",
            credential: "strongpassword"
          }
        ]
      });
      sendTransportRef.current = sendTransport;

      log("created sendTransport", { id: sendTransport.id });

      sendTransport.on("connect", ({ dtlsParameters }, callback) => {
        log("sendTransport connect event", { dtlsParameters });
        socket.emit(
          "voice:connectTransport",
          { type: "send", dtlsParameters },
          () => {
            log("sent voice:connectTransport (send) ack");
            callback();
          }
        );
      });

      sendTransport.on("produce", ({ kind, rtpParameters }, callback: (arg: { id: string }) => void) => {
        log("sendTransport produce event", { kind, rtpParameters });
        socket.emit("voice:produce", { kind, rtpParameters }, (response: { id: string }) => {
          log("voice:produce response", response);
          callback({ id: response.id });
        }
        );
      });

      /* ---------- RECV TRANSPORT ---------- */

      log("requesting createTransport (recv)");
      const recvParams = await new Promise<any>((res) =>
        socket.emit("voice:createTransport", { type: "recv" }, res)
      );

      log("receive recv transport params", { recvParams });

      const recvTransport = device.createRecvTransport({
        ...recvParams,
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          {
            urls: "turn:demo-discord.duckdns.org:3478?transport=tcp",
            username: "demo",
            credential: "strongpassword"
          },
          {
            urls: "turns:demo-discord.duckdns.org:5349",
            username: "demo",
            credential: "strongpassword"
          }
        ]
      });
      recvTransportRef.current = recvTransport;

      log("created recvTransport", { id: recvTransport.id });

      recvTransport.on("connect", ({ dtlsParameters }, callback) => {
        log("recvTransport connect event", { dtlsParameters });
        socket.emit(
          "voice:connectTransport",
          { type: "recv", dtlsParameters },
          () => {
            log("sent voice:connectTransport (recv) ack");

            callback();
          }
        );
      });

      /* ---------- TRANSPORT STATE ---------- */

      sendTransport.on("connectionstatechange", (state) => {
        log("sendTransport connectionstatechange", state);
        if (state === "failed" || state === "closed") {
          warn("Send transport failed or closed", state);
          leaveVoice();
        }
      });

      recvTransport.on("connectionstatechange", (state) => {
        log("recvTransport connectionstatechange", state);
        if (state === "failed" || state === "closed") {
          warn("Recv transport failed or closed", state);
          leaveVoice();
        }
      });


      /* ---------- PRODUCE AUDIO ---------- */


      const audioTrack = stream.getAudioTracks().find(t => t.readyState === "live");

      if (audioTrack) {
        log("producing audio track", { trackId: audioTrack.id });

        audioProducerRef.current = await sendTransport.produce({
          track: audioTrack,
          codecOptions: {
            opusDtx: true,
            opusFec: true,
          },
        });
        log("audio producer created", { id: audioProducerRef.current?.id });
      } else {
        warn("Audio production not supported by device or no audio track", { canProduce: device.canProduce("audio"), audioTrack });
      }

      /* ---------- PRODUCE VIDEO ---------- */

      const videoTrack = stream.getVideoTracks().find(t => t.readyState === "live");

      if (videoTrack) {
        log("producing video track", { trackId: videoTrack.id });
        videoProducerRef.current = await sendTransport.produce({
          track: videoTrack,
          codecOptions: {
            videoGoogleMaxBitrate: 1000
          }
        });
        log("video producer created", { id: videoProducerRef.current?.id });
      } else {
        warn("Video production not supported or no video track", { canProduce: device.canProduce("video"), videoTrack });
      }


      log("emitting voice:getProducers");
      socket.emit("voice:getProducers");
      setPeers([
        {
          socketId: socket.id!,
          username: user.username,
          stream,
          isSelf: true,
        },
      ]);

      log("initial peers set (self added)", { socketId: socket.id, username: user.username });
      setJoined(true);
    } catch (err) {
      warn("Join voice failed:", err);
    } finally {
      joiningRef.current = false;
    }
  };

  /* -------------------------------- CONSUME -------------------------------- */

  const consume = async (
    producerId: string,
    username: string,
    socketId: string
  ) => {
    const socket = socketRef.current;
    if (!socket || socket.id === socketId) return;

    const device = deviceRef.current;
    const recvTransport = recvTransportRef.current;

    if (!device || !recvTransport) return;

    log("requesting consume", { producerId, username, socketId });
    const data: any = await new Promise((res) =>
      socket.emit(
        "voice:consume",
        {
          producerId,
          rtpCapabilities: device.rtpCapabilities,
        },
        res
      )
    );

    log("consume response", { data });

    if (data.error) return;

    const consumer = await recvTransport.consume({
      id: data.id,
      producerId: data.producerId,
      kind: data.kind,
      rtpParameters: data.rtpParameters,
    });

    log("created consumer", { id: consumer.id, producerId: consumer.producerId, kind: consumer.kind });

    setPeers((prev) => {
      const existing = prev.find((p) => p.socketId === socketId);

      if (existing) {

        const newStream = new MediaStream([
          ...existing.stream.getTracks(),
          consumer.track
        ]);

        return prev.map((p) =>
          p.socketId === socketId
            ? { ...p, stream: newStream }
            : p
        );

      }

      const stream = new MediaStream([consumer.track]);
      log("creating new peer with stream", { socketId, username, trackId: consumer.track.id });

      return [...prev, { socketId, username, stream }];
    });
  };

  
  
  const gridCols =
    mode === "focus"
      ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
      : "grid-cols-2 md:grid-cols-4 lg:grid-cols-6";

  /* -------------------------------- UI -------------------------------- */

  return (
    <div className="h-screen bg-gray-900 text-white flex flex-col">
      <div className="p-3 bg-gray-800 flex justify-between items-center">
        <h2>Global Voice</h2>

        <div className="flex gap-2">
          <button
            onClick={() => setMode("focus")}
            className={`px-3 py-1 rounded ${mode === "focus" ? "bg-green-600" : "bg-gray-600"
              }`}
          >
            Focus
          </button>

          <button
            onClick={() => setMode("gallery")}
            className={`px-3 py-1 rounded ${mode === "gallery" ? "bg-green-600" : "bg-gray-600"
              }`}
          >
            Gallery
          </button>
        </div>

        <Link href="/chat" className="text-indigo-400 hover:underline">
          Go to Chat
        </Link>
      </div>
      <div className="px-4 py-2 text-sm text-gray-400">
        Mode: {mode.toUpperCase()} | Visible: {finalVisibleUsers.length}
      </div>
      {!joined ? (
        <div className="flex items-center justify-center flex-1">
          <button
            onClick={joinVoice}
            className="px-6 py-3 bg-green-600 rounded-lg"
          >
            Join Global Voice
          </button>
        </div>
      ) : (
        <>
          <div className={`flex-1 grid gap-4 p-4 ${gridCols}`}>

            {peers
  .filter(peer => finalVisibleUsers.includes(peer.socketId) || peer.isSelf)
  .map((peer) => (
              <div
                key={peer.socketId}
                onClick={() => bringToFocus(peer.socketId)}
                className={`relative bg-black rounded-lg overflow-hidden cursor-pointer ${activeSpeaker === peer.socketId
                    ? "ring-4 ring-green-400"
                    : "ring-2 ring-gray-700"
                  }`}

              >

{(() => {
  const videoTrack = peer.stream.getVideoTracks()[0];

  const isVideoActive =
    videoTrack &&
    videoTrack.readyState === "live" &&
    !videoTrack.muted;

  if (!isVideoActive) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-800 text-gray-400">
        {peer.username}
      </div>
    );
  }

  return (
                <video
                  autoPlay
                  playsInline
                  muted={peer.isSelf}
                  ref={(video) => {
                    if (!video) return;

                    if (video.srcObject !== peer.stream) {
                      video.style.opacity = "0";

                      video.srcObject = peer.stream;

                      video.onloadeddata = () => {
                        video.style.opacity = "1";
                      };
                    }
                  }}
                  className="w-full h-full object-cover"
                />
 );
})()}

                <div className="absolute bottom-2 left-2 bg-black/60 px-2 py-1 rounded text-sm">
                  {peer.username}
                </div>
              </div>
            ))}
          </div>

          <div className="p-4 flex justify-center gap-4 bg-gray-800">
            <button
              onClick={() => {
                muted
                  ? audioProducerRef.current?.resume()
                  : audioProducerRef.current?.pause();
                setMuted(!muted);
              }}
              className="px-4 py-2 bg-yellow-600 rounded"
            >
              {muted ? "Unmute" : "Mute"}
            </button>

            <button
              onClick={leaveVoice}
              className="px-4 py-2 bg-red-600 rounded"
            >
              Leave
            </button>

            <button
              onClick={async () => {
                if (!cameraOff) {
                  videoProducerRef.current?.close();
                  videoProducerRef.current = null;
                  setCameraOff(true);
                } else {
                  const stream = localStreamRef.current;

                  const videoTrack = stream?.getVideoTracks()[0];

                  if (videoTrack && sendTransportRef.current) {
                    videoProducerRef.current = await sendTransportRef.current.produce({
                      track: videoTrack,
                    });
                  }

                  setCameraOff(false);
                }
              }}
              className="px-4 py-2 bg-blue-600 rounded"
            >
              {cameraOff ? "Camera On" : "Camera Off"}
            </button>
          </div>
        </>

      )}

{totalPages > 1 && (
  <div className="flex gap-2 justify-center">
    <button
      onClick={() => setPage(p => Math.max(p - 1, 0))}
      disabled={page === 0}
      className="px-3 py-1 bg-gray-700 rounded disabled:opacity-40"
    >
      Prev
    </button>

    <span className="px-2">
      Page {page + 1} / {totalPages}
    </span>

    <button
      onClick={() => setPage(p => Math.min(p + 1, totalPages - 1))}
      disabled={page === totalPages - 1}
      className="px-3 py-1 bg-gray-700 rounded disabled:opacity-40"
    >
      Next
    </button>
  </div>
)}
    </div>

  );
}