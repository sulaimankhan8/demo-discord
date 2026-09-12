import Redis from "ioredis";

// Use the same config as main redis
export const subscriber = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,  // ✅ Changed from null
  enableReadyCheck: true,
  connectTimeout: 10000,
  commandTimeout: 5000,
  retryStrategy: (times) => {
    console.log(`[SUBSCRIBER] Retry attempt ${times}`);
    if (times > 10) return null;
    return Math.min(times * 100, 3000);
  },
});