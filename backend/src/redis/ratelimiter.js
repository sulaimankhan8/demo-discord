import { redis } from "./index.js";

export async function canSendMessage(
  userId
) {
  const key =`rate:user:${userId}`;

  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(
      key,
      10
    );
  }

  return count <= 20;
}