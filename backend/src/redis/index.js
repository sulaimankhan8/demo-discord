import Redis from "ioredis";

const redisUrl = new URL(process.env.REDIS_URL || "redis://localhost:6379");

const BASE_CONFIG = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port || "6379"),
  password: redisUrl.password || undefined,

  connectTimeout: 10000,

  retryStrategy: (times) => {
    console.log(`[REDIS] Retry attempt ${times}`);

    if (times > 10) {
      console.error("[REDIS] Max retries reached");
      return null;
    }

    return Math.min(times * 100, 3000);
  },

  keepAlive: 30000,
  showFriendlyErrorStack: true,
};

/* ------------------------------------------------ */
/* Main Redis Client */
/* ------------------------------------------------ */

export const redis = new Redis({
  ...BASE_CONFIG,

  commandTimeout: 10000,
  maxRetriesPerRequest: 2,

  enableReadyCheck: true,
  lazyConnect: false,

  enableAutoPipelining: false,
});

/* ------------------------------------------------ */
/* Pub/Sub */
/* ------------------------------------------------ */

export const pubClient = new Redis({
  ...BASE_CONFIG,
  maxRetriesPerRequest: 1,
});

export const subClient = new Redis({
  ...BASE_CONFIG,
  maxRetriesPerRequest: 1,
});

/* ------------------------------------------------ */
/* Logging */
/* ------------------------------------------------ */

function registerLogs(client, name) {
  client.on("connect", () =>
    console.log(`🟢 ${name} Connected`)
  );

  client.on("error", (err) =>
    console.error(`🔴 ${name} Error`, err.code, err.message)
  );

  client.on("close", () =>
    console.warn(`🟡 ${name} Connection Closed`)
  );

  client.on("reconnecting", (delay) =>
    console.log(`🟡 ${name} Reconnecting in ${delay}ms`)
  );
}

registerLogs(redis, "Redis");
registerLogs(pubClient, "PubClient");
registerLogs(subClient, "SubClient");