"use client";

import { useEffect, useRef, useState } from "react";
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

export default function VoiceRoom() {
  const [joined, setJoined] = useState(false);
  const [peers, setPeers] = useState<PeerVideo[]>([]);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);

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
    if (!stored) router.push("/");
  }, []);

  /* -------------------------------- LEAVE VOICE -------------------------------- */

  const leaveVoice = () => {
    audioProducerRef.current?.close();
    videoProducerRef.current?.close();

    sendTransportRef.current?.close();
    recvTransportRef.current?.close();

    localStreamRef.current?.getTracks().forEach((t) => t.stop());

    if (socketRef.current) {
      socketRef.current.emit("voice:leaveRoom");
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
    }

    socketRef.current = null;
    deviceRef.current = null;
    sendTransportRef.current = null;
    recvTransportRef.current = null;
    audioProducerRef.current = null;
    videoProducerRef.current = null;

    setMuted(false);
    setCameraOff(false);
    setPeers([]);
    setJoined(false);
  };

  /* -------------------------------- TAB VISIBILITY -------------------------------- */

  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        videoProducerRef.current?.pause();
      } else {
        videoProducerRef.current?.resume();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  /* -------------------------------- CLEANUP -------------------------------- */

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      sendTransportRef.current?.close();
      recvTransportRef.current?.close();
    };
  }, []);

  /* -------------------------------- JOIN VOICE -------------------------------- */

  const joinVoice = async () => {
    if (joiningRef.current || joined) return;
    joiningRef.current = true;

    try {
      const user = JSON.parse(localStorage.getItem("user") || "{}");

      const socket = getVoiceSocket();

      socket.off("voice:existingProducers");
      socket.off("voice:newProducer");
      socket.off("voice:activeSpeaker");
      socket.off("voice:peerLeft");
      socket.off("voice:producerClosed");

      socketRef.current = socket;

      const device = new mediasoupClient.Device();
      deviceRef.current = device;

      /* ---------- SOCKET LISTENERS ---------- */

      socket.on("voice:existingProducers", async (producers) => {
        for (const producer of producers) {
          await consume(
            producer.producerId,
            producer.username,
            producer.socketId
          );
        }
      });

      socket.on("voice:newProducer", async ({ producerId, username, socketId }) => {
        await consume(producerId, username, socketId);
      });

      socket.on("voice:peerLeft", ({ socketId }) => {
        setPeers((prev) => prev.filter((p) => p.socketId !== socketId));
      });

      socket.on("voice:producerClosed", ({ producerId }) => {
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

      socket.on("voice:activeSpeaker", ({  socketId }) => {
          console.log("Active speaker producer:", socketId);
        setActiveSpeaker(socketId);

       /*  setTimeout(() => {
          setActiveSpeaker(null);
        }, 1200); */
      });

      /* ---------- CONNECT ---------- */

      if (!socket.connected) {
        await new Promise<void>((resolve) => {
          socket.on("connect", () => resolve());
        });
      }

      socket.emit("voice:joinRoom", {
        roomId: ROOM_ID,
        username: user.username,
      });

      /* ---------- LOAD DEVICE ---------- */

      const rtpCapabilities = await new Promise<any>((res) =>
        socket.emit("voice:getRtpCapabilities", null, res)
      );

      await device.load({ routerRtpCapabilities: rtpCapabilities });

      /* ---------- SEND TRANSPORT ---------- */

      const sendParams = await new Promise<any>((res) =>
        socket.emit("voice:createTransport", { type: "send" }, res)
      );

      const sendTransport = device.createSendTransport({
        ...sendParams,
      iceServers:[
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

      sendTransport.on("connect", ({ dtlsParameters }, callback) => {
        socket.emit(
          "voice:connectTransport",
          { type: "send", dtlsParameters },
          () => callback()
        );
      });

      sendTransport.on("produce", ({ kind, rtpParameters }, callback: (arg : {id : string }) => void) => {
        socket.emit("voice:produce", { kind, rtpParameters },(response :{ id:string }) =>
          callback({ id : response.id })
        );
      });

      /* ---------- RECV TRANSPORT ---------- */

      const recvParams = await new Promise<any>((res) =>
        socket.emit("voice:createTransport", { type: "recv" }, res)
      );

      const recvTransport = device.createRecvTransport({
        ...recvParams,
      iceServers:[
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

      recvTransport.on("connect", ({ dtlsParameters }, callback) => {
        socket.emit(
          "voice:connectTransport",
          { type: "recv", dtlsParameters },
          () => callback()
        );
      });

      /* ---------- TRANSPORT STATE ---------- */

      sendTransport.on("connectionstatechange", (state) => {
        if (state === "failed" || state === "closed") {
          console.log("Send transport failed");
          leaveVoice();
        }
      });

      recvTransport.on("connectionstatechange", (state) => {
        if (state === "failed" || state === "closed") {
          console.log("Recv transport failed");
          leaveVoice();
        }
      });

      /* ---------- GET MEDIA ---------- */

      let stream: MediaStream;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: true,
            echoCancellation: true,
          },
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
      } catch (err) {
        console.error("Media permission denied", err);
        alert("Camera or microphone permission denied.");
        return;
      }

      localStreamRef.current = stream;

      
      /* ---------- PRODUCE AUDIO ---------- */

      
      const audioTrack = stream.getAudioTracks()[0];

      if (audioTrack  && device.canProduce("audio")) {
        audioProducerRef.current = await sendTransport.produce({
          track: audioTrack,
          codecOptions: {
            opusDtx: true,
            opusFec: true,
          },
        });
      }else {
  console.warn("Audio production not supported by device");
}

      /* ---------- PRODUCE VIDEO ---------- */
   
      const videoTrack = stream.getVideoTracks()[0];

      if (videoTrack && device.canProduce("video")) {
        videoProducerRef.current = await sendTransport.produce({
          track: videoTrack,
          encodings: [
            { maxBitrate: 150000 },
            { maxBitrate: 500000 },
            { maxBitrate: 1200000 },
          ],
        });
      }

      
      socket.emit("voice:getProducers");
      setPeers([
        {
          socketId: socket.id!,
          username: user.username,
          stream,
          isSelf: true,
        },
      ]);

      setJoined(true);
    } catch (err) {
      console.error("Join voice failed:", err);
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

    if (data.error) return;

    const consumer = await recvTransport.consume({
      id: data.id,
      producerId: data.producerId,
      kind: data.kind,
      rtpParameters: data.rtpParameters,
    });

    setPeers((prev) => {
      const existing = prev.find((p) => p.socketId === socketId);

      if (existing) {
        existing.stream.addTrack(consumer.track);
        return [...prev];
      }

      const stream = new MediaStream();
      stream.addTrack(consumer.track);

      return [...prev, { socketId, username, stream }];
    });
  };

  /* -------------------------------- UI -------------------------------- */

  return (
    <div className="h-screen bg-gray-900 text-white flex flex-col">
      <div className="p-3 bg-gray-800 flex justify-between">
        <h2>Global Voice</h2>
        <Link href="/chat" className="text-indigo-400 hover:underline">
          Go to Chat
        </Link>
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
          <div
            className="flex-1 grid gap-4 p-4"
            style={{
              gridTemplateColumns: `repeat(auto-fit, minmax(250px, 1fr))`,
            }}
          >
            
            {peers.map((peer) => (
              <div
                key={peer.socketId}
                className={`relative bg-black rounded-lg overflow-hidden ${activeSpeaker === peer.socketId
                    ? "ring-4 ring-green-400" 
                    : "ring-5 ring-red-700" 
                  }`}

              >
               
                <video
                  autoPlay
                  playsInline
                  muted={peer.isSelf}
                  ref={(video) => {
                    if (!video) return;

                    if (video.srcObject !== peer.stream) {
                      video.srcObject = peer.stream;
                    }
                  }}
                  className="w-full h-full object-cover"
                />
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
              onClick={() => {
                cameraOff
                  ? videoProducerRef.current?.resume()
                  : videoProducerRef.current?.pause();
                setCameraOff(!cameraOff);
              }}
              className="px-4 py-2 bg-blue-600 rounded"
            >
              {cameraOff ? "Camera On" : "Camera Off"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/*
Tab A:

Joins

Produces

Ready

Tab B:

Joins

Produces

Then requests producers

Server now sees Tab A producers

Returns them

B consumes A

Tab C:

Same logic

Requests producers AFTER producing

Sees A + B

Now:

1st → 3
2nd → 3
3rd → 3
*/