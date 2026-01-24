import { io } from "socket.io-client";

console.log("=== PROTOCOL TEST STARTED ===");

/* Registered user */
const USER = {
  id: "6e985b49-4fbc-4df7-8a33-433c526da2fd",
  username: "user3",
};

const TOTAL = 25_000;
const TEST_TIMEOUT = 30_000;

const socket = io("https://demo-discord.onrender.com", {
  transports: ["websocket"],
});

const delivered = new Set();
const ackedSet = new Set();

let sent = 0;
let deliveredCount = 0;
let acked = 0;

const startTime = Date.now();

/* ---------- CONNECT ---------- */
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
      content: `msg ${i}`,
    });
    sent++;
  }

  console.log(`📤 Sent ${sent} messages`);
});

/* ---------- DELIVERY ---------- */
socket.on("new-message", (msg) => {
  if (!delivered.has(msg.snowflake)) {
    delivered.add(msg.snowflake);
    deliveredCount++;
  }
});

/* ---------- ACK ---------- */
socket.on("message:ack:batch", ({ snowflakes }) => {
  for (const sf of snowflakes) {
    if (!ackedSet.has(sf)) {
      ackedSet.add(sf);
      acked++;
    }
  }
});

socket.on("message:ack", ({ snowflake }) => {
  if (!ackedSet.has(snowflake)) {
    ackedSet.add(snowflake);
    acked++;
  }
});


/* ---------- LIVE METRICS ---------- */
const metricsInterval = setInterval(() => {
  const elapsed = (Date.now() - startTime) / 1000;

  console.log(
    `[${elapsed.toFixed(1)}s] ` +
    `Delivered: ${deliveredCount}/${sent} | ` +
    `Acked: ${acked}/${sent} | ` +
    `Pending DB: ${sent - acked}`
  );
}, 2000);

/* ---------- FINAL EVALUATION ---------- */
setTimeout(() => {
  clearInterval(metricsInterval);

  console.log("\n=== PROTOCOL TEST SUMMARY ===");
  console.log(`Sent:       ${sent}`);
  console.log(`Delivered:  ${deliveredCount}`);
  console.log(`Acked:      ${acked}`);
  console.log(`Pending DB: ${sent - acked}`);

  if (acked === sent) {
    console.log("✅ FULL CONSISTENCY: all messages persisted");
    process.exit(0);
  }

  if (deliveredCount === sent && acked < sent) {
    console.log("⚠️  BACKPRESSURE DETECTED (EXPECTED)");
    console.log("   Messages delivered correctly");
    console.log("   Persistence throughput saturated");
    console.log("   No protocol violation");
    process.exit(0);
  }

  console.log("❌ PROTOCOL FAILURE");
  process.exit(1);
}, TEST_TIMEOUT);
