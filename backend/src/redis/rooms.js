import { redis } from "./index.js";

export async function joinRoom(
  roomId,
  userId
) {
  await redis.sadd(
    `room:${roomId}:users`,
    userId
  );
}

export async function leaveRoom(
  roomId,
  userId
) {
  await redis.srem(
    `room:${roomId}:users`,
    userId
  );
}

export async function getRoomCount(
  roomId
) {
  return redis.scard(
    `room:${roomId}:users`
  );
}

export async function getRoomUsers(
  roomId
) {
  return redis.smembers(
    `room:${roomId}:users`
  );
}