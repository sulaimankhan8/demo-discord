//run/use it simultaniously with  protocol.multiuser.test.js

import { io } from "socket.io-client";
import fetch from "node-fetch";

/* ---------------- CONFIG ---------------- */

const BASE_URL = "https://demo-discord.onrender.com";
const SOCKET_URL = BASE_URL;

const USER = {
  id: "d9847b7d-9d1b-4ad3-babf-032753058bd8",
  username: "user_live_merge_test",
};

const PAGINATION_STEPS = 25;
const PAGINATION_DELAY_MS = 400;
const TEST_DURATION_MS = 120_000;

/* ---------------- STATE ---------------- */

const seenSnowflakes = new Set();
let before = null;
let liveCount = 0;
let httpCount = 0;

const startTime = Date.now();

/* ---------------- SOCKET ---------------- */

const socket = io(SOCKET_URL, {
  transports: ["websocket"],
});

socket.on("connect", () => {
  console.log("✅ Socket connected:", socket.id);
  socket.emit("presence:online", USER);
});

/* ---------------- LIVE MESSAGES ---------------- */

socket.on("new-message", (msg) => {
  const sf = msg.snowflake;

  if (seenSnowflakes.has(sf)) {
    console.error("❌ DUPLICATE MESSAGE (LIVE)", sf);
    process.exit(1);
  }

  seenSnowflakes.add(sf);
  liveCount++;
});

/* ---------------- HTTP PAGINATION ---------------- */

async function paginate() {
  for (let i = 0; i < PAGINATION_STEPS; i++) {
    const url = before
      ? `${BASE_URL}/api/messages?before=${before}`
      : `${BASE_URL}/api/messages`;

    const res = await fetch(url);
    if (!res.ok) {
      console.error("❌ HTTP ERROR", res.status);
      process.exit(1);
    }

    const body = await res.json();

    for (const m of body.messages) {
      const sf = m.snowflake;

      if (seenSnowflakes.has(sf)) {
        console.error("❌ DUPLICATE MESSAGE (HTTP)", sf);
        process.exit(1);
      }

      seenSnowflakes.add(sf);
      httpCount++;
    }

    if (body.messages.length === 0) break;

    before = body.messages[0].snowflake;
    await new Promise((r) => setTimeout(r, PAGINATION_DELAY_MS));
  }
}

/* ---------------- TEST LOOP ---------------- */

(async () => {
  console.log("🚀 Starting live-merge test");

  const interval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[${elapsed}s] HTTP=${httpCount} LIVE=${liveCount} TOTAL=${seenSnowflakes.size}`
    );
  }, 3000);

  while (Date.now() - startTime < TEST_DURATION_MS) {
    await paginate();
  }

  clearInterval(interval);

  console.log("\n=== FINAL REPORT ===");
  console.log("HTTP messages:", httpCount);
  console.log("Live messages:", liveCount);
  console.log("Unique snowflakes:", seenSnowflakes.size);

  console.log("\n✅ LIVE-MERGE CORRECT");
  console.log("• No duplicates");
  console.log("• Pagination stable");
  console.log("• Live + HTTP merge safe");

  process.exit(0);
})();
