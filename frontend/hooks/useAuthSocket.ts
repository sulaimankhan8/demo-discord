"use client";

import { useEffect } from "react";
import { getSocket } from "@/lib/socket";

export function useAuthSocket() {
  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (!stored) return;

    const user = JSON.parse(stored);
    const socket = getSocket();

    if (!socket.connected) {
      socket.connect();
    }

    socket.emit("presence:online", {
      userId: user.id,
      username: user.username,
    });

  }, []);
}