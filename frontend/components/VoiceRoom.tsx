"use client";

import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import * as mediasoupClient from "mediasoup-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthSocket } from "@/hooks/useAuthSocket";
import { getVoiceSocket } from "@/lib/voiceSocket";

import { soundFx } from "@/lib/soundFx";
import AppShell from "./AppShell";

const ROOM_ID = "global-voice";
const SPEAKER_HOLD = 800;

type ProducerInfo = {
  producerId: string;
  socketId: string;
  username: string;
  kind: "audio" | "video";
};

type UserWithProducers = {
  socketId: string;
  username: string;
  producers: Record<string, ProducerInfo>;
};

type PeerMedia = {
  socketId: string;
  username: string;
  stream: MediaStream;
  isSelf?: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
  audioEnabled?: boolean;
  videoEnabled?: boolean;
};

export default function VoiceRoom() {
  const LOG_PREFIX = "[VoiceRoom]";
  const log = (...args: any[]) => console.log(LOG_PREFIX, ...args);
  const warn = (...args: any[]) => console.warn(LOG_PREFIX, ...args);

  const router = useRouter();
  useAuthSocket();

  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);

  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<"focus" | "gallery">("focus");

  const [allUsers, setAllUsers] = useState<UserWithProducers[]>([]);
  const [peers, setPeers] = useState<Record<string, PeerMedia>>({});

  const PAGE_SIZE = mode === "focus" ? 6 : 16;

  const socketRef = useRef<any>(null);
  const deviceRef = useRef<any>(null);
  const sendTransportRef = useRef<any>(null);
  const recvTransportRef = useRef<any>(null);
  const audioProducerRef = useRef<any>(null);
  const videoProducerRef = useRef<any>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const joiningRef = useRef(false);
  const manuallyLeftRef = useRef(false);

  const consumedSetRef = useRef<Set<string>>(new Set());
  const consumerMapRef = useRef<Map<string, any>>(new Map());
  const producerOwnerMapRef = useRef<Map<string, { socketId: string; kind: "audio" | "video" }>>(new Map());

  const lastSpeakerRef = useRef<string | null>(null);
  const lastSpeakerAtRef = useRef(0);

  /* -------------------------------- AUTH CHECK -------------------------------- */
  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (!stored) {
      log("no user in localStorage — redirecting to /");
      router.push("/");
    } else {
      log("found user in localStorage");
    }
  }, [router]);

  /* ---------------- PAGINATION (STABLE POSITIONS) ---------------- */
  const orderedUsers = useMemo(() => {
    // Keep stable user order by socketId (no tile swapping on active speaking)
    return allUsers.map((u) => u.socketId);
  }, [allUsers]);

  const finalVisibleUsers = useMemo(() => {
    const start = page * PAGE_SIZE;
    const end = (page + 1) * PAGE_SIZE;
    return orderedUsers.slice(start, end);
  }, [orderedUsers, page, PAGE_SIZE]);

  const totalUsers = allUsers.length;
  const totalPages = Math.max(1, Math.ceil(totalUsers / PAGE_SIZE));

  useEffect(() => {
    if (page >= totalPages) {
      setPage(Math.max(0, totalPages - 1));
    }
  }, [page, totalPages]);

  useEffect(() => {
    setPage(0);
  }, [mode]);

  /* ---------------- VISIBLE PEERS (STABLE SEATING) ---------------- */
  const visiblePeers = useMemo(() => {
    return Object.values(peers)
      .filter((peer) => finalVisibleUsers.includes(peer.socketId) || peer.isSelf)
      .sort((a, b) => {
        // Self is always first, others in stable alphabetical order
        if (a.isSelf) return -1;
        if (b.isSelf) return 1;
        return a.username.localeCompare(b.username);
      });
  }, [peers, finalVisibleUsers]);

  /* ---------------- SERVER SYNC ---------------- */
  useEffect(() => {
    if (!socketRef.current || !joined) return;

    socketRef.current.emit("voice:updateVisible", {
      visibleUsers: finalVisibleUsers,
      mode,
    });
  }, [finalVisibleUsers, mode, joined]);

  /* ---------------- HELPERS ---------------- */
  const upsertPeerTrack = useCallback(
    (socketId: string, username: string, track: MediaStreamTrack, isSelf = false) => {
      setPeers((prev) => {
        const existing = prev[socketId];

        let newStream: MediaStream;

        if (existing) {
          const existingTracks = existing.stream
            .getTracks()
            .filter((t) => t.kind !== track.kind);
          newStream = new MediaStream([...existingTracks, track]);
        } else {
          newStream = new MediaStream([track]);
        }

        return {
          ...prev,
          [socketId]: {
            socketId,
            username,
            stream: newStream,
            isSelf,
            hasAudio: newStream.getAudioTracks().length > 0,
            hasVideo: newStream.getVideoTracks().length > 0,
            audioEnabled: existing?.audioEnabled ?? true,
            videoEnabled: existing?.videoEnabled ?? true,
          },
        };
      });
    },
    []
  );

  const removePeerTrack = useCallback((socketId: string, kind: "audio" | "video") => {
    setPeers((prev) => {
      const peer = prev[socketId];
      if (!peer) return prev;

      const remainingTracks = peer.stream.getTracks().filter((t) => t.kind !== kind);

      if (remainingTracks.length === 0 && !peer.isSelf) {
        const clone = { ...prev };
        delete clone[socketId];
        return clone;
      }

      const newStream = new MediaStream(remainingTracks);

      return {
        ...prev,
        [socketId]: {
          ...peer,
          stream: newStream,
          hasAudio: newStream.getAudioTracks().length > 0,
          hasVideo: newStream.getVideoTracks().length > 0,
        },
      };
    });
  }, []);

  const removePeerCompletely = useCallback((socketId: string) => {
    setPeers((prev) => {
      const clone = { ...prev };
      delete clone[socketId];
      return clone;
    });

    setAllUsers((prev) => prev.filter((u) => u.socketId !== socketId));

    // close all consumers belonging to this peer
    for (const [producerId, meta] of producerOwnerMapRef.current.entries()) {
      if (meta.socketId === socketId) {
        const consumer = consumerMapRef.current.get(producerId);
        if (consumer) {
          try {
            consumer.close();
          } catch {}
          consumerMapRef.current.delete(producerId);
        }

        producerOwnerMapRef.current.delete(producerId);
        consumedSetRef.current.delete(producerId);
      }
    }

    if (activeSpeaker === socketId) {
      setActiveSpeaker(null);
      lastSpeakerRef.current = null;
    }
  }, [activeSpeaker]);

  const updatePeerMediaState = useCallback(
    (socketId: string, next: { audio?: boolean; video?: boolean }) => {
      setPeers((prev) => {
        const peer = prev[socketId];
        if (!peer) return prev;

        return {
          ...prev,
          [socketId]: {
            ...peer,
            audioEnabled: next.audio ?? peer.audioEnabled,
            videoEnabled: next.video ?? peer.videoEnabled,
          },
        };
      });
    },
    []
  );

  /* ---------------- CLEANUP ---------------- */
  const cleanupEverything = useCallback((options?: { keepSocketAlive?: boolean }) => {
    const keepSocketAlive = options?.keepSocketAlive ?? false;

    try {
      audioProducerRef.current?.close();
    } catch {}

    try {
      videoProducerRef.current?.close();
    } catch {}

    try {
      sendTransportRef.current?.close();
    } catch {}

    try {
      recvTransportRef.current?.close();
    } catch {}

    localStreamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {}
    });

    consumerMapRef.current.forEach((consumer) => {
      try {
        consumer.close();
      } catch {}
    });
    consumerMapRef.current.clear();
    producerOwnerMapRef.current.clear();
    consumedSetRef.current.clear();
    if (!keepSocketAlive && socketRef.current) {
      try {
        socketRef.current.removeAllListeners();
      } catch {}

      try {
        socketRef.current.disconnect();
      } catch {}
    }

    if (!keepSocketAlive) {
      socketRef.current = null;
    }

    deviceRef.current = null;
    sendTransportRef.current = null;
    recvTransportRef.current = null;
    audioProducerRef.current = null;
    videoProducerRef.current = null;
    localStreamRef.current = null;
    joiningRef.current = false;

    setPeers({});
    setAllUsers([]);
    setJoined(false);
    setMuted(false);
    setCameraOff(false);
    setActiveSpeaker(null);
    setPage(0);

    lastSpeakerRef.current = null;
    lastSpeakerAtRef.current = 0;
  }, []);

  useEffect(() => {
    return () => {
      manuallyLeftRef.current = true;
      cleanupEverything();
    };
  }, [cleanupEverything]);

  /* -------------------------------- LEAVE VOICE -------------------------------- */
  const leaveVoice = useCallback(() => {
    console.log("🚨 leaveVoice() CALLED");
    soundFx.playLeave();

    manuallyLeftRef.current = true;

    if (socketRef.current) {
      try {
        socketRef.current.emit("voice:leaveRoom");
      } catch {}
    }

    cleanupEverything();
  }, [cleanupEverything]);

  /* ---------------- CONSUME ---------------- */
  const consume = useCallback(
    async (producerId: string, username: string, socketId: string, kind: "audio" | "video") => {
      const socket = socketRef.current;
      const device = deviceRef.current;
      const recvTransport = recvTransportRef.current;

      if (!socket || socket.id === socketId) return;
      if (!device || !recvTransport) return;

      try {
        log("requesting consume", { producerId, username, socketId, kind });

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

        if (!data || data.error) {
          warn("consume failed", data?.error);
          consumedSetRef.current.delete(producerId);
          return;
        }

        const consumer = await recvTransport.consume({
          id: data.id,
          producerId: data.producerId,
          kind: data.kind,
          rtpParameters: data.rtpParameters,
        });

        await consumer.resume?.();

        consumerMapRef.current.set(producerId, consumer);
        producerOwnerMapRef.current.set(producerId, { socketId, kind });

        upsertPeerTrack(socketId, username, consumer.track, false);

        consumer.on("trackended", () => {
          removePeerTrack(socketId, consumer.kind as "audio" | "video");
          consumerMapRef.current.delete(producerId);
          producerOwnerMapRef.current.delete(producerId);
          consumedSetRef.current.delete(producerId);
        });

        consumer.on("transportclose", () => {
          removePeerTrack(socketId, consumer.kind as "audio" | "video");
          consumerMapRef.current.delete(producerId);
          producerOwnerMapRef.current.delete(producerId);
          consumedSetRef.current.delete(producerId);
        });

        consumer.on("producerclose", () => {
          removePeerTrack(socketId, consumer.kind as "audio" | "video");
          consumerMapRef.current.delete(producerId);
          producerOwnerMapRef.current.delete(producerId);
          consumedSetRef.current.delete(producerId);
        });
      } catch (err) {
        warn("consume error", err);
        consumedSetRef.current.delete(producerId);
      }
    },
    [removePeerTrack, upsertPeerTrack]
  );

  /* ---------------- CONSUME ONLY WHAT IS NEEDED ---------------- */
  useEffect(() => {
    if (!joined) return;

    const run = async () => {
      for (const user of allUsers) {
        for (const producer of Object.values(user.producers)) {
          const isVideo = producer.kind === "video";

          // minimal bandwidth:
          // audio = always consume
          // video = only visible users
          if (isVideo && !finalVisibleUsers.includes(user.socketId)) {
            continue;
          }

          if (consumedSetRef.current.has(producer.producerId)) continue;

          consumedSetRef.current.add(producer.producerId);
          await consume(producer.producerId, user.username, user.socketId, producer.kind);
        }
      }
    };

    run();
  }, [allUsers, consume, finalVisibleUsers, joined]);

  /* ---------------- CLEAN HIDDEN VIDEO CONSUMERS ---------------- */
  useEffect(() => {
    for (const [producerId, meta] of producerOwnerMapRef.current.entries()) {
      if (meta.kind !== "video") continue;

      const shouldStillExist = finalVisibleUsers.includes(meta.socketId);

      if (!shouldStillExist) {
        const consumer = consumerMapRef.current.get(producerId);
        if (consumer) {
          try {
            consumer.close();
          } catch {}
        }

        socketRef.current?.emit("voice:closeConsumer", { producerId });

        consumerMapRef.current.delete(producerId);
        producerOwnerMapRef.current.delete(producerId);
        consumedSetRef.current.delete(producerId);

        removePeerTrack(meta.socketId, "video");
      }
    }
  }, [finalVisibleUsers, removePeerTrack]);

  /* ---------------- CLEAN DEAD CONSUMERS ---------------- */
  useEffect(() => {
    consumerMapRef.current.forEach((consumer, producerId) => {
      const stillExists = allUsers.some((u) =>
        Object.values(u.producers).some((p) => p.producerId === producerId)
      );

      if (!stillExists) {
        try {
          consumer.close();
        } catch {}

        socketRef.current?.emit("voice:closeConsumer", { producerId });

        consumerMapRef.current.delete(producerId);

        const meta = producerOwnerMapRef.current.get(producerId);
        if (meta) {
          removePeerTrack(meta.socketId, meta.kind);
          producerOwnerMapRef.current.delete(producerId);
        }

        consumedSetRef.current.delete(producerId);
      }
    });
  }, [allUsers, removePeerTrack]);

  /* ---------------- CLICK TO FOCUS ---------------- */
  const bringToFocus = useCallback((userId: string) => {
    setMode("focus");
    setPage(0);

    requestAnimationFrame(() => {
      setActiveSpeaker(userId);
      lastSpeakerRef.current = userId;
      lastSpeakerAtRef.current = Date.now();
    });
  }, []);

  /* ---------------- JOIN VOICE ---------------- */
  const joinVoice = useCallback(async () => {
    if (joiningRef.current || joined) return;
    joiningRef.current = true;
    manuallyLeftRef.current = false;

    try {
      if (socketRef.current) {
        try {
          socketRef.current.removeAllListeners();
          socketRef.current.disconnect();
        } catch {}
        socketRef.current = null;
      }

      await new Promise((res) => setTimeout(res, 50));

      const user = JSON.parse(localStorage.getItem("user") || "{}");
      if (!user?.username) {
        alert("User not found. Please login again.");
        joiningRef.current = false;
        return;
      }

      const socket = getVoiceSocket();
      socketRef.current = socket;

      const device = new mediasoupClient.Device();
      deviceRef.current = device;

      let stream: MediaStream;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: true,
            echoCancellation: true,
            autoGainControl: true,
          },
          video: {
            width: { ideal: 960 },
            height: { ideal: 540 },
            frameRate: { ideal: 24, max: 24 },
          },
        });
      } catch (err) {
        warn("Media permission denied or getUserMedia failed", err);
        alert("Camera or microphone permission denied.");
        joiningRef.current = false;
        return;
      }

      localStreamRef.current = stream;

      /* ---------- SOCKET LISTENERS ---------- */

      socket.on("voice:existingProducers", (producers: ProducerInfo[]) => {
        const map = new Map<string, UserWithProducers>();

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

        setAllUsers((prev) => {
          const merged = new Map<string, UserWithProducers>();

          prev.forEach((u) => {
            merged.set(u.socketId, {
              ...u,
              producers: { ...u.producers },
            });
          });

          map.forEach((incoming, socketId) => {
            const existing = merged.get(socketId);

            if (existing) {
              merged.set(socketId, {
                ...existing,
                username: incoming.username,
                producers: {
                  ...existing.producers,
                  ...incoming.producers,
                },
              });
            } else {
              merged.set(socketId, incoming);
            }
          });

          return [...merged.values()];
        });
      });

      socket.on("voice:newProducer", (producer: ProducerInfo) => {
        setAllUsers((prev) => {
          const existing = prev.find((p) => p.socketId === producer.socketId);

          if (existing) {
            return prev.map((p) =>
              p.socketId === producer.socketId
                ? {
                    ...p,
                    producers: {
                      ...p.producers,
                      [producer.kind]: producer,
                    },
                  }
                : p
            );
          }

          return [
            ...prev,
            {
              socketId: producer.socketId,
              username: producer.username,
              producers: { [producer.kind]: producer },
            },
          ];
        });
      });

      socket.on("voice:peerLeft", ({ socketId }: { socketId: string }) => {
        log("peerLeft", socketId);
        removePeerCompletely(socketId);
      });

      socket.on(
        "voice:producerClosed",
        ({
          producerId,
          socketId,
          kind,
        }: {
          producerId: string;
          socketId: string;
          kind: "audio" | "video";
        }) => {
          consumedSetRef.current.delete(producerId);

          const consumer = consumerMapRef.current.get(producerId);
          if (consumer) {
            try {
              consumer.close();
            } catch {}
            consumerMapRef.current.delete(producerId);
          }

          producerOwnerMapRef.current.delete(producerId);

          setAllUsers((prev) =>
            prev
              .map((u) => {
                if (u.socketId !== socketId) return u;

                const nextProducers = { ...u.producers };
                delete nextProducers[kind];

                return {
                  ...u,
                  producers: nextProducers,
                };
              })
              .filter((u) => Object.keys(u.producers).length > 0)
          );

          removePeerTrack(socketId, kind);
        }
      );

      socket.on(
        "voice:mediaState",
        ({
          socketId,
          audio,
          video,
        }: {
          socketId: string;
          audio: boolean;
          video: boolean;
        }) => {
          updatePeerMediaState(socketId, { audio, video });
        }
      );

      socket.on("voice:activeSpeaker", ({ socketId }: { socketId: string | null }) => {
        const now = Date.now();

        if (!socketId) {
          if (now - lastSpeakerAtRef.current < SPEAKER_HOLD) return;
          setActiveSpeaker(null);
          lastSpeakerRef.current = null;
          lastSpeakerAtRef.current = now;
          return;
        }

        if (lastSpeakerRef.current === socketId) return;

        if (
          lastSpeakerRef.current &&
          now - lastSpeakerAtRef.current < SPEAKER_HOLD
        ) {
          return;
        }

        lastSpeakerRef.current = socketId;
        lastSpeakerAtRef.current = now;
        setActiveSpeaker(socketId);
      });

      socket.on("disconnect", () => {
        warn("⚠️ disconnected");

        if (manuallyLeftRef.current) return;

        cleanupEverything({ keepSocketAlive: true });
        socketRef.current = null;

        setTimeout(() => {
          if (!manuallyLeftRef.current) {
            joinVoice();
          }
        }, 800);
      });

      if (!socket.connected) {
        await new Promise<void>((resolve) => {
          socket.once("connect", () => {
            log("socket connected", { id: socket.id });
            resolve();
          });
        });
      } else {
        log("socket already connected", { id: socket.id });
      }

      /* ---------- JOIN ROOM ---------- */
      log("emitting voice:joinRoom", { roomId: ROOM_ID, username: user.username });

      const joinRes: any = await new Promise((res) =>
        socket.emit(
          "voice:joinRoom",
          {
            roomId: ROOM_ID,
            username: user.username,
          },
          res
        )
      );

      if (!joinRes || joinRes.error) {
        throw new Error(joinRes?.error || "Join room failed");
      }

      log("voice room joined successfully");

      const rtpCapabilities = await new Promise<any>((res) =>
        socket.emit("voice:getRtpCapabilities", null, res)
      );

      if (!rtpCapabilities || rtpCapabilities.error) {
        throw new Error(rtpCapabilities?.error || "Failed to get RTP capabilities");
      }

      await device.load({ routerRtpCapabilities: rtpCapabilities });

      log("device loaded");
      log("canProduce audio?", device.canProduce("audio"));
      log("canProduce video?", device.canProduce("video"));
      log("router caps", rtpCapabilities);
      log("device caps", device.rtpCapabilities);

      /* ---------- SEND TRANSPORT ---------- */
      const sendParams = await new Promise<any>((res) =>
        socket.emit("voice:createTransport", { type: "send" }, res)
      );

      if (!sendParams || sendParams.error) {
        throw new Error(sendParams?.error || "Failed to create send transport");
      }

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

      sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
        socket.emit(
          "voice:connectTransport",
          { type: "send", dtlsParameters },
          (response: any) => {
            if (response?.error) return errback(response.error);
            callback();
          }
        );
      });

      sendTransport.on("produce", ({ kind, rtpParameters }, callback, errback) => {
        socket.emit("voice:produce", { kind, rtpParameters }, (response: any) => {
          if (response?.error) return errback(response.error);
          callback({ id: response.id });
        });
      });

      /* ---------- RECV TRANSPORT ---------- */
      const recvParams = await new Promise<any>((res) =>
        socket.emit("voice:createTransport", { type: "recv" }, res)
      );

      if (!recvParams || recvParams.error) {
        throw new Error(recvParams?.error || "Failed to create recv transport");
      }

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

      recvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
  socket.emit(
    "voice:connectTransport",
    { type: "recv", dtlsParameters },
    (response: any) => {
      if (response?.error) return errback(response.error);

      callback();
    }
  );
});

      /* ---------- TRANSPORT STATE ---------- */
      sendTransport.on("connectionstatechange", (state) => {
  log("sendTransport state", state);

  if (state === "failed") {
    warn("sendTransport failed — waiting before cleanup");
    setTimeout(() => {
      if (!manuallyLeftRef.current) {
        warn("sendTransport still failed");
        // maybe show reconnect UI instead of leaveVoice()
      }
    }, 4000);
  }
});

recvTransport.on("connectionstatechange", (state) => {
  log("recvTransport state", state);

  if (state === "failed") {
    warn("recvTransport failed — waiting before cleanup");
    setTimeout(() => {
      if (!manuallyLeftRef.current) {
        warn("recvTransport still failed");
      }
    }, 4000);
  }
});

      /* ---------- PRODUCE AUDIO ---------- */
      const audioTrack = stream.getAudioTracks()[0];
      log("audio track found?", !!audioTrack, audioTrack?.readyState);

      if (audioTrack) {
        audioProducerRef.current = await sendTransport.produce({
          track: audioTrack,
          codecOptions: {
            opusDtx: true,
            opusFec: true,
            opusMaxPlaybackRate: 48000,
          },
        });

        log("audio producer created", audioProducerRef.current?.id);
      }

      /* ---------- PRODUCE VIDEO ---------- */
      const videoTrack = stream.getVideoTracks()[0];
      log("video track found?", !!videoTrack, videoTrack?.readyState);

      if (videoTrack) {
        log("🚀 attempting video produce...");
        try {
          videoProducerRef.current = await sendTransport.produce({
            track: videoTrack,
            codecOptions: {
              videoGoogleStartBitrate: 400,
            },
          });

          log("video producer created", videoProducerRef.current?.id);
        } catch (err) {
          warn("❌ video produce failed — continuing with audio only", err);

          try {
            videoTrack.stop();
          } catch {}

          setCameraOff(true);
        }
      }

   /* ---------- SELF PREVIEW ---------- */
const finalLocalTracks = [
  ...(localStreamRef.current?.getAudioTracks() || []),
  ...(videoProducerRef.current
    ? (localStreamRef.current?.getVideoTracks() || [])
    : []),
];

setPeers((prev) => ({
  ...prev,
  [socket.id!]: {
    socketId: socket.id!,
    username: user.username,
    stream: new MediaStream(finalLocalTracks),
    isSelf: true,
    hasAudio: finalLocalTracks.some((t) => t.kind === "audio"),
    hasVideo: finalLocalTracks.some((t) => t.kind === "video"),
    audioEnabled: true,
    videoEnabled: !!videoProducerRef.current,
  },
}));

      /* ---------- INITIAL MEDIA STATE ---------- */
      socket.emit("voice:mediaState", {
  audio: true,
  video: !!videoProducerRef.current,
});
socket.emit("voice:getProducers");
      setJoined(true);
      soundFx.playJoin();
    } catch (err: any) {
      warn("Join voice failed:", err?.message || err);
      leaveVoice();
    } finally {
      joiningRef.current = false;
    }
  }, [
    cleanupEverything,
    consume,
    joined,
    leaveVoice,
    removePeerCompletely,
    removePeerTrack,
    updatePeerMediaState,
  ]);

  /* ---------------- TOGGLE MUTE ---------------- */
  const toggleMute = useCallback(async () => {
    try {
      if (!audioProducerRef.current) return;

      const socket = socketRef.current;

      if (muted) {
        soundFx.playUnmute();
        await audioProducerRef.current.resume();
        localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = true));

        socket?.emit("voice:mediaState", {
          audio: true,
          video: !cameraOff,
        });
      } else {
        soundFx.playMute();
        await audioProducerRef.current.pause();
        localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = false));

        socket?.emit("voice:mediaState", {
          audio: false,
          video: !cameraOff,
        });
      }

      setPeers((prev) => {
        const self = prev[socketRef.current?.id];
        if (!self) return prev;

        return {
          ...prev,
          [self.socketId]: {
            ...self,
            audioEnabled: muted,
          },
        };
      });

      setMuted((prev) => !prev);
    } catch (err) {
      warn("toggleMute failed", err);
    }
  }, [muted, cameraOff]);

  /* ---------------- TOGGLE CAMERA ---------------- */
  const toggleCamera = useCallback(async () => {
    try {
      const socket = socketRef.current;
      const stream = localStreamRef.current;

      if (!stream || !sendTransportRef.current) return;

      if (!cameraOff) {
        // TURN CAMERA OFF
        try {
          videoProducerRef.current?.close();
        } catch {}

        videoProducerRef.current = null;

        localStreamRef.current?.getVideoTracks().forEach((t) => {
          try {
            t.stop();
          } catch {}
        });

        setPeers((prev) => {
          const self = prev[socketRef.current?.id];
          if (!self) return prev;

          const audioTracks = self.stream.getAudioTracks();
          const newStream = new MediaStream(audioTracks);

          return {
            ...prev,
            [self.socketId]: {
              ...self,
              stream: newStream,
              hasAudio: audioTracks.length > 0,
              hasVideo: false,
              videoEnabled: false,
            },
          };
        });

        const currentAudioTracks = localStreamRef.current?.getAudioTracks() || [];
        localStreamRef.current = new MediaStream([...currentAudioTracks]);

        // Force video element to clear stale frame
        const videoElement = document.querySelector(`video[data-socket-id="${socketRef.current?.id}"]`) as HTMLVideoElement;
        if (videoElement) {
          videoElement.pause();
          videoElement.srcObject = null;
        }

        socket?.emit("voice:mediaState", {
          audio: !muted,
          video: false,
        });

        setCameraOff(true);
      } else {
        // TURN CAMERA ON
        const freshStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 960 },
            height: { ideal: 540 },
            frameRate: { ideal: 24, max: 24 },
          },
        });

        const freshVideoTrack = freshStream.getVideoTracks()[0];
        if (!freshVideoTrack || !sendTransportRef.current) return;

        const currentAudioTracks = localStreamRef.current?.getAudioTracks() || [];

        localStreamRef.current = new MediaStream([
          ...currentAudioTracks,
          freshVideoTrack,
        ]);

        videoProducerRef.current = await sendTransportRef.current.produce({
          track: freshVideoTrack,
          codecOptions: {
            videoGoogleStartBitrate: 400,
          },
        });

        setPeers((prev) => {
          const self = prev[socketRef.current?.id];
          if (!self) return prev;
          
const finalLocalTracks = [
  ...(localStreamRef.current?.getAudioTracks() || []),
  ...(videoProducerRef.current
    ? (localStreamRef.current?.getVideoTracks() || [])
    : []),
];
          return {
            ...prev,
            [self.socketId]: {
              ...self,
            stream: new MediaStream(finalLocalTracks),
hasAudio: finalLocalTracks.some(t => t.kind === "audio"),
hasVideo: finalLocalTracks.some(t => t.kind === "video"),
videoEnabled: !!videoProducerRef.current,
            },
          };
        });

        socket?.emit("voice:mediaState", {
          audio: !muted,
          video: true,
        });

        setTimeout(() => {
          socket?.emit("voice:getProducers");
        }, 100);

        setCameraOff(false);
      }
    } catch (err) {
      warn("toggleCamera failed", err);
    }
  }, [cameraOff, muted]);

  const gridCols =
    mode === "focus"
      ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
      : "grid-cols-2 md:grid-cols-4";

  /* -------------------------------- UI -------------------------------- */
  return (
    <AppShell activeChannel="global-voice" onlineCount={totalUsers || 1}>
      <div className="h-full w-full bg-[#171922] text-[#F2F3F5] flex flex-col font-sans overflow-hidden select-none">
        {/* TOP STAGE HEADER */}
        <header className="h-12 px-4 bg-[#171922] border-b border-white/[0.05] flex justify-between items-center shrink-0 z-10">
          <div className="flex items-center gap-2.5 truncate">
            <svg className="w-5 h-5 text-[#23A55A] shrink-0 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            </svg>
            <h1 className="font-semibold text-sm tracking-tight text-white flex items-center gap-2">
              global-voice
              {joined && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono bg-[#23A55A]/15 text-[#23A55A] border border-[#23A55A]/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#23A55A] animate-pulse" />
                  RTC 18ms
                </span>
              )}
            </h1>
            <div className="h-4 w-[1px] bg-white/[0.08] mx-1 hidden sm:block" />
            <p className="text-[11px] text-[#949BA4] font-mono hidden sm:block">
              {totalUsers} {totalUsers === 1 ? "peer connected" : "peers connected"}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {joined && (
              <div className="flex items-center bg-[#12141A] p-0.5 rounded-md border border-white/[0.06] text-xs font-medium">
                <button
                  onClick={() => setMode("focus")}
                  className={`px-2.5 py-1 rounded transition-all cursor-pointer ${
                    mode === "focus"
                      ? "bg-[#5865F2] text-white font-semibold"
                      : "text-[#949BA4] hover:text-white"
                  }`}
                >
                  Focus View
                </button>
                <button
                  onClick={() => setMode("gallery")}
                  className={`px-2.5 py-1 rounded transition-all cursor-pointer ${
                    mode === "gallery"
                      ? "bg-[#5865F2] text-white font-semibold"
                      : "text-[#949BA4] hover:text-white"
                  }`}
                >
                  Gallery View
                </button>
              </div>
            )}

            <Link
              href="/chat"
              className="flex items-center gap-1.5 px-3 py-1 bg-[#1E212D] hover:bg-white/[0.08] text-[#DBDEE1] rounded-md text-xs font-medium transition border border-white/[0.08]"
            >
              <svg className="w-3.5 h-3.5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <span>Open Chat</span>
            </Link>
          </div>
        </header>

        {!joined ? (
          /* PRE-JOIN STAGE GATE */
          <div className="flex flex-col items-center justify-center flex-1 gap-5 p-6 text-center">
            <div className="w-16 h-16 rounded-2xl bg-[#23A55A]/15 border border-[#23A55A]/30 flex items-center justify-center text-[#23A55A] shadow-xl">
              <svg className="w-8 h-8 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <div className="max-w-sm">
              <h2 className="text-lg font-bold text-white tracking-tight">
                Global Voice & Video Stage
              </h2>
              <p className="text-xs text-[#949BA4] mt-1 font-mono">
                Mediasoup SFU v3 Multi-Core Routing with Scalable Video Coding (SVC).
              </p>
            </div>
            <button
              onClick={joinVoice}
              className="px-6 py-2.5 bg-[#23A55A] hover:bg-[#1E904B] text-white font-semibold text-sm rounded-lg transition-all shadow-lg shadow-[#23A55A]/25 hover:scale-[1.01] active:scale-[0.99] flex items-center gap-2 cursor-pointer"
            >
              <span>Connect to Stage</span>
            </button>
          </div>
        ) : (
          <>
            {/* STAGE VIDEO / AUDIO GRID */}
            <div className="flex-1 min-h-0 p-3 overflow-y-auto">
              {visiblePeers.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-[#6D737F] text-xs font-mono gap-2">
                  <span>Awaiting peer media streams…</span>
                </div>
              ) : (
                <div className={`h-full grid gap-3 ${gridCols} auto-rows-fr`}>
                  {visiblePeers.map((peer) => (
                    <PeerTile
                      key={peer.socketId}
                      peer={peer}
                      isActiveSpeaker={activeSpeaker === peer.socketId}
                      onClick={() => bringToFocus(peer.socketId)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* FLOATING ACTION CONTROL DOCK */}
            <div className="h-16 bg-[#12141A] border-t border-white/[0.05] px-6 flex justify-between items-center shrink-0 z-10">
              {/* Left Telemetry */}
              <div className="hidden sm:flex items-center gap-2 text-xs text-[#949BA4] font-mono">
                <span className="w-2 h-2 rounded-full bg-[#23A55A]" />
                <span>Opus 48kHz</span>
                <span className="text-[#6D737F]">•</span>
                <span>{visiblePeers.length} active tiles</span>
              </div>

              {/* Center Controls */}
              <div className="flex items-center gap-2.5 mx-auto sm:mx-0">
                {/* MUTE MIC */}
                <button
                  onClick={toggleMute}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-xs transition cursor-pointer ${
                    muted
                      ? "bg-[#F23F43]/20 text-[#F23F43] border border-[#F23F43]/40 hover:bg-[#F23F43]/30"
                      : "bg-[#1E212D] hover:bg-white/[0.08] text-[#DBDEE1] border border-white/[0.08]"
                  }`}
                >
                  {muted ? (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 19L5 5m14 0L5 19M12 1v6m0 4v4m-4-4h8" />
                      </svg>
                      <span>Unmute</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4 text-[#23A55A]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                      <span>Mute</span>
                    </>
                  )}
                </button>

                {/* TOGGLE CAMERA */}
                <button
                  onClick={toggleCamera}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-xs transition cursor-pointer ${
                    cameraOff
                      ? "bg-[#1E212D] hover:bg-white/[0.08] text-[#949BA4] border border-white/[0.08]"
                      : "bg-[#5865F2] hover:bg-[#4752C4] text-white shadow-md shadow-[#5865F2]/20"
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <span>{cameraOff ? "Camera On" : "Camera Off"}</span>
                </button>

                {/* DISCONNECT */}
                <button
                  onClick={leaveVoice}
                  className="flex items-center gap-2 px-5 py-2 bg-[#F23F43] hover:bg-[#D83A3E] text-white rounded-lg font-semibold text-xs transition shadow-md shadow-[#F23F43]/20 cursor-pointer active:scale-[0.98]"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
                  </svg>
                  <span>Disconnect</span>
                </button>
              </div>

              {/* Right Pagination */}
              {totalPages > 1 ? (
                <div className="flex items-center gap-1.5 font-mono text-xs">
                  <button
                    onClick={() => setPage((p) => Math.max(p - 1, 0))}
                    disabled={page === 0}
                    className="px-2.5 py-1 bg-[#1E212D] text-[#DBDEE1] rounded disabled:opacity-30 transition border border-white/[0.06] cursor-pointer"
                  >
                    Prev
                  </button>
                  <span className="text-[#949BA4] text-[11px] px-1">
                    {page + 1}/{totalPages}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(p + 1, totalPages - 1))}
                    disabled={page === totalPages - 1}
                    className="px-2.5 py-1 bg-[#1E212D] text-[#DBDEE1] rounded disabled:opacity-30 transition border border-white/[0.06] cursor-pointer"
                  >
                    Next
                  </button>
                </div>
              ) : (
                <div className="hidden sm:block w-20" />
              )}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

const PeerTile = React.memo(
  function PeerTile({
    peer,
    isActiveSpeaker,
    onClick,
  }: {
    peer: PeerMedia;
    isActiveSpeaker: boolean;
    onClick: () => void;
  }) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    useEffect(() => {
      const video = videoRef.current;
      const audio = audioRef.current;
      if (!video && !audio) return;

      const videoTracks = peer.stream.getVideoTracks();
      const audioTracks = peer.stream.getAudioTracks();

      if (video) {
        const videoStream = new MediaStream(videoTracks);
        video.srcObject = videoStream;
        video.play().catch((err) => {
          console.warn("video play failed", peer.username, err);
        });
      }

      if (audio) {
        const audioStream = new MediaStream(audioTracks);
        audio.srcObject = audioStream;
        setTimeout(() => {
          audio.play().catch((err) => {
            console.warn("audio play failed", peer.username, err);
          });
        }, 100);
      }
    }, [peer.stream, peer.username]);

    const videoTrack = peer.stream.getVideoTracks()[0];
    const isVideoTrackLive = !!videoTrack && videoTrack.readyState === "live";
    const shouldShowVideo = peer.hasVideo && peer.videoEnabled !== false && isVideoTrackLive;

    const getAvatarColor = (name: string) => {
      const colors = ["#5865F2", "#23A55A", "#F0B232", "#F23F43", "#9B59B6", "#1ABC9C"];
      let hash = 0;
      for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
      return colors[Math.abs(hash) % colors.length];
    };

    return (
      <div
        onClick={onClick}
        className={`relative bg-[#0E0F14] rounded-xl overflow-hidden cursor-pointer transition-all duration-200 select-none group flex items-center justify-center border ${
          isActiveSpeaker
            ? "border-[#23A55A] shadow-[0_0_20px_rgba(35,165,90,0.35)]"
            : "border-white/[0.06] hover:border-white/[0.12]"
        }`}
      >
        {!peer.isSelf && <audio ref={audioRef} autoPlay playsInline />}

        {shouldShowVideo ? (
          <video
            ref={videoRef}
            data-socket-id={peer.socketId}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center bg-[#0E0F14] relative">
            <div
              className={`w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-bold shadow-lg transition-transform ${
                isActiveSpeaker ? "scale-105 ring-2 ring-[#23A55A]" : ""
              }`}
              style={{ backgroundColor: getAvatarColor(peer.username) }}
            >
              {peer.username.charAt(0).toUpperCase()}
            </div>
          </div>
        )}

        {/* TOP-RIGHT STATUS BADGES */}
        <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 z-10">
          {peer.audioEnabled === false && (
            <div className="bg-[#F23F43]/90 text-white p-1 rounded backdrop-blur-md shadow-md" title="Muted">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 19L5 5m14 0L5 19M12 1v6m0 4v4m-4-4h8" />
              </svg>
            </div>
          )}

          {peer.videoEnabled === false && (
            <div className="bg-[#0E0F14]/80 text-[#949BA4] p-1 rounded backdrop-blur-md border border-white/10 shadow-md" title="Camera Off">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
          )}
        </div>

        {/* BOTTOM-LEFT NAME TAG WITH LIVE EQUALIZER */}
        <div className="absolute bottom-2.5 left-2.5 bg-[#08090C]/80 backdrop-blur-md px-2 py-1 rounded text-xs font-semibold text-white flex items-center gap-1.5 border border-white/10 shadow z-10">
          {isActiveSpeaker && (
            <span className="flex items-end gap-[2px] h-3">
              <span className="w-[2px] h-full bg-[#23A55A] rounded-full animate-pulse" />
              <span className="w-[2px] h-2 bg-[#23A55A] rounded-full animate-pulse delay-75" />
              <span className="w-[2px] h-3 bg-[#23A55A] rounded-full animate-pulse delay-150" />
            </span>
          )}
          <span className="max-w-[110px] truncate text-[12px]">{peer.username}</span>
          {peer.isSelf && (
            <span className="text-[9px] bg-[#5865F2] text-white px-1 py-0.2 rounded font-bold">
              YOU
            </span>
          )}
        </div>
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.peer.stream === next.peer.stream &&
      prev.peer.hasAudio === next.peer.hasAudio &&
      prev.peer.hasVideo === next.peer.hasVideo &&
      prev.peer.audioEnabled === next.peer.audioEnabled &&
      prev.peer.videoEnabled === next.peer.videoEnabled &&
      prev.isActiveSpeaker === next.isActiveSpeaker
    );
  }
);