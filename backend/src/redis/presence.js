import { redis } from "./index.js";
import { PresenceKeys } from "./keys.js";
import { PRESENCE_TTL } from "./constants.js";

export async function setOnline(user) {
  await redis
    .multi()
    .set(
      PresenceKeys.user(user.userId),
      JSON.stringify({
        userId: user.userId,
        username: user.username,
        status: "online",
      }),
      "EX",
      PRESENCE_TTL
    )
    .sadd(
      "online_users",
      user.userId
    )
    .sadd(
      PresenceKeys.sockets(
        user.userId
      ),
      user.socketId
    )
    .set(
      PresenceKeys.socket(
        user.socketId
      ),
      user.userId,
      "EX",
      PRESENCE_TTL * 2
    )
    .exec();
}

export async function setOffline(
  userId,
  socketId
) {
  const socketSet =
    PresenceKeys.sockets(userId);

  await redis.srem(
    socketSet,
    socketId
  );

  await redis.del(
    PresenceKeys.socket(
      socketId
    )
  );

  const remaining =
    await redis.scard(
      socketSet
    );

  if (remaining > 0) {
    return false;
  }

  await redis
    .multi()
    .del(
      PresenceKeys.user(userId)
    )
    .srem(
      "online_users",
      userId
    )
    .del(socketSet)
    .exec();

  return true;
}

export async function getOnlineUsers() {
  const userIds =
    await redis.smembers(
      "online_users"
    );

  if (!userIds.length)
    return [];

  const pipeline =
    redis.pipeline();

  userIds.forEach((userId) => {
    pipeline.get(
      PresenceKeys.user(userId)
    );
  });

  const results =
    await pipeline.exec();

  const users = [];

  for (let i = 0; i < results.length; i++) {
    const [err, data] =
      results[i];

    const userId =
      userIds[i];

    if (err || !data) {
      await redis.srem(
        "online_users",
        userId
      );
      continue;
    }

    try {
      users.push(
        JSON.parse(data)
      );
    } catch {
      await redis.srem(
        "online_users",
        userId
      );
    }
  }

  return users;
}



export async function refreshPresence(
  user
) {
  await redis
    .multi()
    .set(
      PresenceKeys.user(user.userId),
      JSON.stringify({
        userId: user.userId,
        username: user.username,
        status: "online",
      }),
      "EX",
      PRESENCE_TTL
    )
    .expire(
      PresenceKeys.socket(
        user.socketId
      ),
      PRESENCE_TTL * 2
    )
    .exec();

    await redis.expire(
  PresenceKeys.sockets(
    user.userId
  ),
  PRESENCE_TTL * 2
);
}

