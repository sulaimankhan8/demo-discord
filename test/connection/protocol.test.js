import { io } from "socket.io-client";

/* ===== CONFIG ===== */
const API = "https://demo-discord.onrender.com";

/* Pick an already registered user */
const USER = {
  id: "6e985b49-4fbc-4df7-8a33-433c526da2fd",
  username: "user3",
};

const TOTAL = 200;
const TIMEOUT_MS = 30000;

/* ===== STATE ===== */
let sent = 0;
let acked = 0;
const seen = new Set();

/* ===== START ===== */
console.log("Protocol test started");

const socket = io(API, {
  transports: ["websocket"],
});

socket.on("connect", () => {
  console.log("Connected:", socket.id);

  socket.emit("presence:online", {
    userId: USER.id,
    username: USER.username,
  });

  for (let i = 0; i < TOTAL; i++) {
    socket.emit("send-message", {
      userId: USER.id,
      username: USER.username,
      content: `protocol-msg ${i}`,
    });
    sent++;
  }
});

/* ===== RECEIVE ACK ===== */
socket.on("message:ack", ({ snowflake }) => {
  if (seen.has(snowflake)) return;
  seen.add(snowflake);
  acked++;

  if (acked === sent) {
    console.log("✔ Protocol correctness verified");
    process.exit(0);
  }
});

/* ===== FAIL SAFE ===== */
setTimeout(() => {
  console.error("❌ Protocol timeout");
  console.error(`Sent: ${sent}, Acked: ${acked}`);
  process.exit(1);
}, TIMEOUT_MS);
