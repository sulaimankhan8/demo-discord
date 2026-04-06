"use client";

import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import * as mediasoupClient from "mediasoup-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthSocket } from "@/hooks/useAuthSocket";
import { getVoiceSocket } from "@/lib/voiceSocket";

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

  /* ---------------- PAGINATION ---------------- */
  const orderedUsers = useMemo(() => {
    const ids = allUsers.map((u) => u.socketId);

    if (!activeSpeaker || !ids.includes(activeSpeaker)) {
      return ids;
    }

    return [activeSpeaker, ...ids.filter((id) => id !== activeSpeaker)];
  }, [allUsers, activeSpeaker]);

  const finalVisibleUsers = useMemo(() => {
    const start = page * PAGE_SIZE;
    const end = (page + 1) * PAGE_SIZE;
    let visible = orderedUsers.slice(start, end);

    if (
      activeSpeaker &&
      !visible.includes(activeSpeaker) &&
      orderedUsers.includes(activeSpeaker)
    ) {
      visible = [activeSpeaker, ...visible.slice(0, PAGE_SIZE - 1)];
    }

    return visible;
  }, [orderedUsers, page, PAGE_SIZE, activeSpeaker]);

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

  /* ---------------- VISIBLE PEERS ---------------- */
  const visiblePeers = useMemo(() => {
    return Object.values(peers)
      .filter((peer) => finalVisibleUsers.includes(peer.socketId) || peer.isSelf)
      .sort((a, b) => {
        if (a.socketId === activeSpeaker) return -1;
        if (b.socketId === activeSpeaker) return 1;
        return 0;
      });
  }, [peers, finalVisibleUsers, activeSpeaker]);

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
    log("leaveVoice() called");
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

      const sendTransport = device.createSendTransport(sendParams);
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

      const recvTransport = device.createRecvTransport(recvParams);
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
        if (state === "failed" || state === "closed") {
          if (!manuallyLeftRef.current) leaveVoice();
        }
      });

      recvTransport.on("connectionstatechange", (state) => {
        log("recvTransport state", state);
        if (state === "failed" || state === "closed") {
          if (!manuallyLeftRef.current) leaveVoice();
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
        // VP9 does NOT support simulcast in mediasoup the way you're trying.
        // Keep bandwidth minimal using single stream + server-side pause/resume/layers logic.
        videoProducerRef.current = await sendTransport.produce({
          track: videoTrack,
          codecOptions: {
            videoGoogleStartBitrate: 400,
          },
        });

        log("video producer created", videoProducerRef.current?.id);
      }

      /* ---------- SELF PREVIEW ---------- */
      setPeers((prev) => ({
        ...prev,
        [socket.id!]: {
          socketId: socket.id!,
          username: user.username,
          stream: new MediaStream(stream.getTracks()),
          isSelf: true,
          hasAudio: stream.getAudioTracks().length > 0,
          hasVideo: stream.getVideoTracks().length > 0,
          audioEnabled: true,
          videoEnabled: true,
        },
      }));

      /* ---------- INITIAL MEDIA STATE ---------- */
      socket.emit("voice:mediaState", {
        audio: true,
        video: true,
      });

      socket.emit("voice:getProducers");
      setJoined(true);
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
        await audioProducerRef.current.resume();
        localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = true));

        socket?.emit("voice:mediaState", {
          audio: true,
          video: !cameraOff,
        });
      } else {
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

          return {
            ...prev,
            [self.socketId]: {
              ...self,
              stream: new MediaStream(localStreamRef.current!.getTracks()),
              hasAudio: currentAudioTracks.length > 0,
              hasVideo: true,
              videoEnabled: true,
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
    <div className="h-screen bg-gray-900 text-white flex flex-col">
      <div className="p-3 bg-gray-800 flex justify-between items-center">
        <h2>Global Voice</h2>

        <div className="flex gap-2">
          <button
            onClick={() => setMode("focus")}
            className={`px-3 py-1 rounded ${
              mode === "focus" ? "bg-green-600" : "bg-gray-600"
            }`}
          >
            Focus
          </button>

          <button
            onClick={() => setMode("gallery")}
            className={`px-3 py-1 rounded transition ${
              mode === "gallery" ? "bg-green-600" : "bg-gray-600"
            }`}
          >
            Gallery
          </button>
        </div>

        <Link href="/chat" className="text-indigo-400 hover:underline">
          Go to Chat
        </Link>
      </div>

      <div className="px-4 py-2 text-sm text-gray-400 shrink-0">
        Mode: {mode.toUpperCase()} | Visible: {finalVisibleUsers.length} | Users: {totalUsers}
      </div>

      {!joined ? (
        <div className="flex items-center justify-center flex-1">
          <button
            onClick={joinVoice}
            className="px-6 py-3 bg-green-600 rounded-lg hover:bg-green-500 transition"
          >
            Join Global Voice
          </button>
        </div>
      ) : (
        <>
          <div className={`flex-1 min-h-0 grid gap-4 p-4 ${gridCols}`}>
            {visiblePeers.map((peer) => (
              <PeerTile
                key={peer.socketId}
                peer={peer}
                isActiveSpeaker={activeSpeaker === peer.socketId}
                onClick={() => bringToFocus(peer.socketId)}
              />
            ))}
          </div>

          {/* CONTROLS */}
          <div className="p-4 flex justify-center gap-4 bg-gray-800 shrink-0">
            <button
              onClick={toggleMute}
              className="px-4 py-2 bg-yellow-600 rounded hover:bg-yellow-500 transition"
            >
              {muted ? "Unmute" : "Mute"}
            </button>

            <button
              onClick={leaveVoice}
              className="px-4 py-2 bg-red-600 rounded hover:bg-red-500 transition"
            >
              Leave
            </button>

            <button
              onClick={toggleCamera}
              className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-500 transition"
            >
              {cameraOff ? "Camera On" : "Camera Off"}
            </button>
          </div>

          {totalPages > 1 && (
            <div className="flex gap-2 justify-center items-center py-3 bg-gray-900 shrink-0">
              <button
                onClick={() => setPage((p) => Math.max(p - 1, 0))}
                disabled={page === 0}
                className="px-3 py-1 bg-gray-700 rounded disabled:opacity-40"
              >
                Prev
              </button>

              <span className="px-2">
                Page {page + 1} / {totalPages}
              </span>

              <button
                onClick={() => setPage((p) => Math.min(p + 1, totalPages - 1))}
                disabled={page === totalPages - 1}
                className="px-3 py-1 bg-gray-700 rounded disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
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

    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;

      if (video.srcObject !== peer.stream) {
        video.srcObject = peer.stream;
      }
    }, [peer.stream]);

    const videoTrack = peer.stream.getVideoTracks()[0];
    const isVideoTrackLive =
      !!videoTrack &&
      videoTrack.readyState === "live" &&
      !videoTrack.muted;

    const shouldShowVideo =
      peer.hasVideo &&
      peer.videoEnabled !== false &&
      isVideoTrackLive;

    return (
      <div
        onClick={onClick}
        className={`relative bg-black rounded-lg overflow-hidden cursor-pointer transition-all ${
          isActiveSpeaker ? "ring-4 ring-green-400" : "ring-2 ring-gray-700"
        }`}
      >
        {shouldShowVideo ? (
          <video
            ref={videoRef}
            data-socket-id={peer.socketId}
            autoPlay
            playsInline
            muted={peer.isSelf}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gray-800 text-gray-300 text-lg font-medium">
            {peer.username.charAt(0).toUpperCase()}
          </div>
        )}

        <div className="absolute top-2 right-2 flex gap-2">
          {peer.audioEnabled === false && (
            <div className="bg-red-600/90 text-xs px-2 py-1 rounded">Muted</div>
          )}

          {peer.videoEnabled === false && (
            <div className="bg-blue-600/90 text-xs px-2 py-1 rounded">Camera Off</div>
          )}

          {!peer.hasVideo && peer.hasAudio && peer.videoEnabled !== false && (
            <div className="bg-green-600/80 text-xs px-2 py-1 rounded">Audio</div>
          )}
        </div>

        <div className="absolute bottom-2 left-2 bg-black/60 px-2 py-1 rounded text-sm">
          {peer.username}
          {peer.isSelf ? " (You)" : ""}
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