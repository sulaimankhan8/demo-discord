import { redis } from "./index.js";
import { PRESENCE_TTL , CHAT_RECENT_KEY } from "./constants.js";
const MAX_RECENT_MESSAGES=100;

export async function pushRecentMessage(message) {
    await redis.multi()
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

export async function getRecentMessages(
    limit = MAX_RECENT_MESSAGES
){

    const messages = await redis.lrange(
        CHAT_RECENT_KEY,
        0,
        limit-1
    );

    return messages.map(JSON.parse).reverse();

}