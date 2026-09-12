import { redis } from "../index.js";

/**
 * Toggle a reaction on a message for a given user in Redis.
 * Uses atomic Hashes for counts and Sets for per-user idempotency.
 * Appends event to Redis Stream `stream:reactions` for asynchronous persistence.
 *
 * @param {string} snowflake - Message Snowflake ID
 * @param {string} userId - User UUID
 * @param {string} emoji - Emoji identifier (e.g. 'fire', 'heart', 'like', 'star')
 */
export async function toggleMessageReaction(snowflake, userId, emoji) {
  const countKey = `reactions:counts:${snowflake}`;
  const usersKey = `reactions:users:${snowflake}:${emoji}`;

  // 1. Check if user already reacted
  const alreadyReacted = await redis.sismember(usersKey, userId);

  let action = "ADDED";
  let newCount = 0;

  if (alreadyReacted) {
    // 🔻 User is un-reacting
    await redis.srem(usersKey, userId);
    newCount = await redis.hincrby(countKey, emoji, -1);

    if (newCount <= 0) {
      await redis.hdel(countKey, emoji);
      newCount = 0;
    }
    action = "REMOVED";
  } else {
    // 🔺 User is reacting
    await redis.sadd(usersKey, userId);
    newCount = await redis.hincrby(countKey, emoji, 1);
  }

  // 2. Append event to Redis Stream for asynchronous database write-behind
  try {
    await redis.xadd(
      "stream:reactions",
      "*",
      "snowflake", snowflake,
      "userId", userId,
      "emoji", emoji,
      "action", action,
      "timestamp", Date.now().toString()
    );
  } catch (err) {
    console.error("[ReactionService] Failed to append to stream:reactions:", err);
  }

  return {
    action,
    emoji,
    count: Math.max(0, newCount),
    hasReacted: action === "ADDED",
  };
}

/**
 * Fetch all reaction counts for multiple messages in batch
 * @param {string[]} snowflakes - Array of message snowflake IDs
 * @returns {Promise<Map<string, Array<{ emoji: string, count: number }>>>}
 */
export async function getBulkMessageReactions(snowflakes) {
  if (!snowflakes || snowflakes.length === 0) return new Map();

  const pipeline = redis.pipeline();
  snowflakes.forEach((sf) => {
    pipeline.hgetall(`reactions:counts:${sf}`);
  });

  const results = await pipeline.exec();
  const reactionsMap = new Map();

  snowflakes.forEach((sf, index) => {
    const [err, countsHash] = results[index] || [null, {}];
    if (!err && countsHash && Object.keys(countsHash).length > 0) {
      const reactions = Object.entries(countsHash)
        .map(([emoji, count]) => ({
          emoji,
          count: parseInt(count, 10),
        }))
        .filter((r) => r.count > 0);
      reactionsMap.set(sf, reactions);
    } else {
      reactionsMap.set(sf, []);
    }
  });

  return reactionsMap;
}

/**
 * Check which reactions a specific user has clicked for a list of messages
 * @param {string[]} snowflakes
 * @param {string} userId
 * @param {string[]} availableEmojis
 */
export async function getUserReactionStates(snowflakes, userId, availableEmojis = ["like", "heart", "fire", "star"]) {
  if (!snowflakes || snowflakes.length === 0 || !userId) return new Map();

  const pipeline = redis.pipeline();
  const keysList = [];

  snowflakes.forEach((sf) => {
    availableEmojis.forEach((emoji) => {
      pipeline.sismember(`reactions:users:${sf}:${emoji}`, userId);
      keysList.push({ snowflake: sf, emoji });
    });
  });

  const results = await pipeline.exec();
  const userReactedMap = new Map(); // "snowflake:emoji" -> boolean

  results.forEach(([err, isMember], i) => {
    if (!err && isMember === 1) {
      const { snowflake, emoji } = keysList[i];
      if (!userReactedMap.has(snowflake)) {
        userReactedMap.set(snowflake, new Set());
      }
      userReactedMap.get(snowflake).add(emoji);
    }
  });

  return userReactedMap;
}
