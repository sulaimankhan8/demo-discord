// tests/stateful-user.js
import { io } from "socket.io-client";

function random(min, max) {
  return Math.random() * (max - min) + min;
}

export function startUser(user) {
  const socket = io("https://demo-discord.onrender.com", {
    transports: ["websocket"],
  });

  socket.on("connect", () => {
    socket.emit("presence:online", user);
    loop();
  });

  function loop() {
    socket.emit("typing:start");

    setTimeout(() => {
      socket.emit("typing:stop");

      socket.emit("send-message", {
        ...user,
        content: `hello from ${user.username}`,
      });
    }, random(300, 1200));
  }

  socket.on("message:ack", () => {
    setTimeout(loop, random(1000, 5000));
  });

  // simulate flaky network
  setTimeout(() => {
    socket.disconnect();
    setTimeout(() => socket.connect(), random(1000, 3000));
  }, random(20000, 40000));
}
