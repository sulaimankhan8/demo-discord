import { redis } from "./index.js";
import { CHAT_RECENT_KEY } from "./constants.js";

const MAX_RECENT_MESSAGES = 100;

/* ---------------- SINGLE MESSAGE ---------------- */

export async function pushRecentMessage(
  message
) {
  await redis
    .multi()
    .lpush(
      CHAT_RECENT_KEY,
      JSON.stringify(message)
    )
    .ltrim(
      CHAT_RECENT_KEY,
      0,
      MAX_RECENT_MESSAGES - 1
    )
    .exec();
}

/* ---------------- BATCH MESSAGES ---------------- */

export async function pushRecentMessages(
  messages
) {
  if (
    !messages ||
    messages.length === 0
  ) {
    return;
  }

  const pipeline =
    redis.pipeline();

  for (const message of messages) {
    pipeline.lpush(
      CHAT_RECENT_KEY,
      JSON.stringify(message)
    );
  }

  pipeline.ltrim(
    CHAT_RECENT_KEY,
    0,
    MAX_RECENT_MESSAGES - 1
  );

  await pipeline.exec();
}

/* ---------------- READ ---------------- */

export async function getRecentMessages(
  limit =
    MAX_RECENT_MESSAGES
) {
  const messages =
    await redis.lrange(
      CHAT_RECENT_KEY,
      0,
      limit - 1
    );

  return messages
    .map(JSON.parse)
    .reverse();
}