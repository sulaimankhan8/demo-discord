// tests/stateful-user.js
import { io } from "socket.io-client";
import fs from "fs";

function random(min, max) {
  return Math.random() * (max - min) + min;
}

export function startUser(user, config) {
  const socket = io(config.url, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 3000,
  });

  /* ---------------- STATE ---------------- */

  let sent = 0;
  let acked = 0;
  let reconnects = 0;
  let lastAckAt = Date.now();

  const startedAt = Date.now();

  /* ---------------- CONNECT ---------------- */

  socket.on("connect", () => {
    log(`[${user.username}] connected (${socket.id})`);
    socket.emit("presence:online", user);
    loop();
  });

  socket.on("disconnect", () => {
    reconnects++;
    log(`[${user.username}] disconnected (${reconnects})`);
  });

  /* ---------------- MAIN LOOP ---------------- */

  function loop() {
    if (!socket.connected) return;

    socket.emit("typing:start");

    setTimeout(() => {
      socket.emit("typing:stop");

      socket.emit("send-message", {
        userId: user.id,
        username: user.username,
        content: `hello from ${user.username}`,
      });

      sent++;
    }, random(300, 1200));
  }

  /* ---------------- ACK HANDLING ---------------- */

  socket.on("message:ack", onAck);
  socket.on("message:ack:batch", ({ snowflakes }) => {
    acked += snowflakes.length;
    onAck();
  });

  function onAck() {
    acked++;
    lastAckAt = Date.now();
    setTimeout(loop, random(1000, 5000));
  }

  /* ---------------- WATCHDOG ---------------- */

  setInterval(() => {
    const idleMs = Date.now() - lastAckAt;
    if (idleMs > 10_000) {
      log(
        `[${user.username}] ⚠️ stalled ${idleMs}ms ` +
        `(sent=${sent}, acked=${acked})`
      );
    }
  }, 5000);

  /* ---------------- PERIODIC REPORT ---------------- */

  setInterval(() => {
    const now = Date.now();
    const minutes = ((now - startedAt) / 60000).toFixed(1);

    const report = {
      timestamp: new Date().toISOString(),
      user: user.username,
      runtime_min: minutes,
      sent,
      acked,
      pending: sent - acked,
      reconnects,
    };

    fs.appendFileSync(
      config.outputFile,
      JSON.stringify(report) + "\n"
    );

    log(
      `[${user.username}] ${minutes}min | ` +
      `sent=${sent} acked=${acked} pending=${sent - acked}`
    );
  }, config.reportIntervalMs);

  /* ---------------- STOP AFTER RUNTIME ---------------- */

  setTimeout(() => {
    log(`[${user.username}] stopping (runtime reached)`);

    fs.appendFileSync(
      config.outputFile,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        user: user.username,
        event: "ENDED",
        sent,
        acked,
        reconnects,
      }) + "\n"
    );

    socket.disconnect();
  }, config.totalRuntimeMs);

  /* ---------------- FLAKY NETWORK ---------------- */

  setTimeout(() => {
    log(`[${user.username}] simulating network drop`);
    socket.disconnect();
    setTimeout(() => socket.connect(), random(1000, 3000));
  }, random(20_000, 40_000));
}

/* ---------------- LOG HELPER ---------------- */

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
