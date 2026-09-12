import { redis } from "../redis/index.js";

// ✅ This should be called ONCE at server startup
export async function setupMessageStream() {
  try {
    await redis.xgroup(
      "CREATE",
      "stream:messages",
      "message-consumers",
      "0",
      "MKSTREAM"
    );
    console.log("✅ Consumer group created successfully.");
  } catch (err) {
    if (err.message.includes("BUSYGROUP")) {
      console.log("✅ Consumer group already exists.");
    } else {
      console.error("❌ Error creating consumer group:", err);
      throw err;
    }
  }
}