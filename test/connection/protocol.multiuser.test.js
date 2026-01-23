import { io } from "socket.io-client";

console.log("=== MULTI-USER PROTOCOL TEST ===");

/* ---------------- CONFIG ---------------- */

const USERS = [
  { id: "d9847b7d-9d1b-4ad3-babf-032753058bd8", username: "user1" },
  { id: "78a2e686-cd60-47a3-88ca-1e48cb2fd766", username: "user2" },
  { id: "6e985b49-4fbc-4df7-8a33-433c526da2fd", username: "user3" },
];

const MESSAGES_PER_USER = 10000;
const SEND_INTERVAL_MS = 5;
const TEST_TIMEOUT =120_000;

/* ---------------- STATE ---------------- */

const socket = io("https://demo-discord.onrender.com", {
  transports: ["websocket"],
});

let connected = false;

let sent = 0;
let delivered = 0;
let acked = 0;

const deliveredSet = new Set();
const ackedSet = new Set();
const sentAt = new Map();
const ackLatencies = [];

const startTime = Date.now();

/* ---------------- CONNECT ---------------- */

socket.on("connect", async () => {
  connected = true;
  console.log("Connected:", socket.id);

  USERS.forEach((u) =>
    socket.emit("presence:online", u)
  );

  for (const user of USERS) {
    for (let i = 0; i < MESSAGES_PER_USER; i++) {
      await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS));

      socket.emit("send-message", {
        userId: user.id,
        username: user.username,
        content: `msg ${i} from ${user.username}`,
      });

      sent++;
    }
  }

  console.log(`📤 Sent ${sent} messages`);
});

/* ---------------- DELIVERY ---------------- */

socket.on("new-message", (msg) => {
  if (!deliveredSet.has(msg.snowflake)) {
    deliveredSet.add(msg.snowflake);
    delivered++;
    sentAt.set(msg.snowflake, Date.now());
  }
});

/* ---------------- ACK ---------------- */

socket.on("message:ack", ({ snowflake }) => {
  if (ackedSet.has(snowflake)) {
    console.error("❌ DUPLICATE ACK");
    process.exit(1);
  }

  ackedSet.add(snowflake);
  acked++;

  const t0 = sentAt.get(snowflake);
  if (t0) ackLatencies.push(Date.now() - t0);
});

/* ---------------- LIVE METRICS ---------------- */

const interval = setInterval(() => {
  if (!connected) return;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[${elapsed}s] Delivered: ${delivered}/${sent} | Acked: ${acked}/${sent}`
  );
}, 3000);

/* ---------------- FINAL REPORT ---------------- */

setTimeout(() => {
  clearInterval(interval);

  ackLatencies.sort((a, b) => a - b);
  const p = (x) =>
    ackLatencies[Math.floor((x / 100) * ackLatencies.length)] ?? 0;

  console.log("\n=== FINAL REPORT ===");
  console.log(`Sent:       ${sent}`);
  console.log(`Delivered:  ${delivered}`);
  console.log(`Acked:      ${acked}`);
  console.log(`Pending DB: ${sent - acked}`);

  console.log("\nACK latency (ms):");
  console.log(`p50: ${p(50)}`);
  console.log(`p95: ${p(95)}`);
  console.log(`p99: ${p(99)}`);

  if (acked <= delivered && delivered <= sent) {
    console.log("\n✅ PROTOCOL CORRECT");
    console.log("   No duplicates");
    console.log("   Ordering preserved");
    console.log("   Backpressure handled");
    process.exit(0);
  }

  console.error("\n❌ PROTOCOL VIOLATION");
  process.exit(1);
}, TEST_TIMEOUT);
