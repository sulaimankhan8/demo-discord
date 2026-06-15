import { redis } from "../redis/index.js";

try {
    await redis.xgroup(
        "CREATE",
        "stream:messages",
        "message-consumers",
        "$",
        "MKSTREAM"
    );

    console.log("Consumer group created successfully.");
} catch (err) {

    if (err.message.includes("BUSYGROUP")) {

    console.log(
      "Consumer group exists"
    );

  } else {

    console.error("Error creating consumer group:", err);
  }
}