import { io, Socket } from "socket.io-client";

export function getVoiceSocket(): Socket {
  return io(`${process.env.NEXT_PUBLIC_SOCKET_URL}/voice`, {
    transports: ["websocket"],
    upgrade: false,
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
}

