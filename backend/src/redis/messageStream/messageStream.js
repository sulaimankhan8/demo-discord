import { redis } from "../index.js";

export const MESSAGE_STREAM ="stream:messages";

export async function appendMessage(message) {
  return redis.xadd(
    MESSAGE_STREAM,"*",

    "snowflake", message.snowflake,

    "socketId",message.socketId,

    "userId",message.userId,

    "username",message.username,

    "content",message.content,

    "createdAt",message.createdAt
  );
}