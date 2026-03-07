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

  const socketRef = useRef<any>(null);
  const deviceRef = useRef<any>(null);
  const sendTransportRef = useRef<any>(null);
  const recvTransportRef = useRef<any>(null);
  const audioProducerRef = useRef<any>(null);
  const videoProducerRef = useRef<any>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const router = useRouter();
  useAuthSocket();

  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (!stored) router.push("/");
  }, []);

 const leaveVoice = () => {
  audioProducerRef.current?.close();
  videoProducerRef.current?.close();

  sendTransportRef.current?.close();
  recvTransportRef.current?.close();

  localStreamRef.current?.getTracks().forEach((t) => t.stop());

  if (socketRef.current) {
    socketRef.current.removeAllListeners();
    socketRef.current.disconnect();
  }

  setMuted(false);
setCameraOff(false);

  socketRef.current = null;
  deviceRef.current = null;
  sendTransportRef.current = null;
  recvTransportRef.current = null;
  audioProducerRef.current = null;
  videoProducerRef.current = null;

  setPeers([]);
  setJoined(false);
};
  

  /* Cleanup on unmount */
  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      sendTransportRef.current?.close();
      recvTransportRef.current?.close();
    };
  }, []);

 const joinVoice = async () => {
  const user = JSON.parse(localStorage.getItem("user") || "{}");

  const socket = getVoiceSocket();
  socket.removeAllListeners();
  socketRef.current = socket;

  const device = new mediasoupClient.Device();
  deviceRef.current = device;

  /* ---------- ATTACH LISTENERS FIRST ---------- */

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

  socket.on("voice:activeSpeaker", ({ producerId }) => {
  setActiveSpeaker(producerId);
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

  /* ---------- CONNECT ---------- */

  if (!socket.connected) {
    await new Promise<void>((resolve) => {
      socket.on("connect", () => resolve());
    });
  }

  /* ---------- JOIN ROOM AFTER LISTENERS ---------- */

  socket.emit("voice:joinRoom", {
    roomId: ROOM_ID,
    username: user.username,
  });

  /* ---------- LOAD DEVICE ---------- */

  const rtpCapabilities = await new Promise<any>((res) =>
    socket.emit("voice:getRtpCapabilities", null, res)
  );

  await device.load({ routerRtpCapabilities: rtpCapabilities });

  /* ---------- CREATE SEND TRANSPORT ---------- */

  const sendParams = await new Promise<any>((res) =>
    socket.emit("voice:createTransport", { type: "send" }, res)
  );

  const sendTransport = device.createSendTransport(sendParams);
  sendTransportRef.current = sendTransport;

  sendTransport.on("connect", ({ dtlsParameters }, callback) => {
    socket.emit(
      "voice:connectTransport",
      { type: "send", dtlsParameters },
      () => callback()
    );
  });

  sendTransport.on("produce", ({ kind, rtpParameters }, callback) => {
    socket.emit("voice:produce", { kind, rtpParameters }, ({ id }) =>
      callback({ id })
    );
  });

  /* ---------- CREATE RECV TRANSPORT ---------- */

  const recvParams = await new Promise<any>((res) =>
    socket.emit("voice:createTransport", { type: "recv" }, res)
  );

  const recvTransport = device.createRecvTransport(recvParams);
  recvTransportRef.current = recvTransport;

  recvTransport.on("connect", ({ dtlsParameters }, callback) => {
    socket.emit(
      "voice:connectTransport",
      { type: "recv", dtlsParameters },
      () => callback()
    );
  });
  /* ---------- GET MEDIA ---------- */

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      noiseSuppression: true,
      echoCancellation: true,
    },
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });

  audioProducerRef.current = await sendTransport.produce({
    track: stream.getAudioTracks()[0],
  });

  videoProducerRef.current = await sendTransport.produce({
    track: stream.getVideoTracks()[0],
    encodings: [
    { maxBitrate: 150000 },
    { maxBitrate: 500000 },
    { maxBitrate: 1200000 }
  ]
  });

  socket.emit("voice:getProducers");

  setPeers([
    {
      socketId: socket.id,
      username: user.username,
      stream,
      isSelf: true,
    },
  ]);

  setJoined(true);
};

  /* ---------------- CONSUME ---------------- */

  const consume = async (
    producerId: string,
    username: string,
    socketId: string
  ) => {
    
    const socket = socketRef.current;
      if (socket.id === socketId) return;


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

  /* ---------------- UI ---------------- */

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
                className="relative bg-black rounded-lg overflow-hidden"
              >
                <video
                  autoPlay
                  playsInline
                  muted={peer.isSelf}
                  ref={(video) => {
                    if (video) video.srcObject = peer.stream;
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
                  ? audioProducerRef.current.resume()
                  : audioProducerRef.current.pause();
                setMuted(!muted);
              }}
              className="px-4 py-2 bg-yellow-600 rounded"
            >
              {muted ? "Unmute" : "Mute"}
            </button>

              <button
              onClick={leaveVoice}
              className="px-4 py-2 bg-yellow-600 rounded"
            >
              {"Leave"}
            </button>
            <button
              onClick={() => {
                cameraOff
                  ? videoProducerRef.current.resume()
                  : videoProducerRef.current.pause();
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