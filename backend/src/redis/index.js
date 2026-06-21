import Redis from "ioredis";

// Parse REDIS_URL to get proper config
const redisUrl = new URL(process.env.REDIS_URL || "redis://localhost:6379");

export const redis = new Redis({
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port || "6379"),
  password: redisUrl.password || undefined,
  
  // CRITICAL FIX: Limit retries and set timeout
  maxRetriesPerRequest: 3, // ✅ Changed from null
  enableReadyCheck: true,
  lazyConnect: false,
  
  // Connection timeout
  connectTimeout: 10000,
  commandTimeout: 5000,
  
  // Retry strategy with backoff
  retryStrategy: (times) => {
    console.log(`[REDIS] Retry attempt ${times}`);
    if (times > 10) {
      console.error('[REDIS] Max retries reached, giving up');
      return null; // Stop retrying
    }
    return Math.min(times * 100, 3000);
  },
  
  // Connection pool settings
  maxRetriesPerRequest: 3,
  enableAutoPipelining: true, // ✅ Enable auto-pipelining for performance
  autoResendUnfulfilledCommands: false, // Don't resend failed commands
  
  // Keep connection alive
  keepAlive: 30000,
  
  // Show friendly errors
  showFriendlyErrorStack: true,
});

// Connection event handlers
redis.on("connect", () => {
  console.log("🟢 Redis Connected");
});

redis.on("error", (err) => {
  console.error("🔴 Redis Error", err.code, err.message);
});

redis.on("close", () => {
  console.warn("🟡 Redis Connection Closed");
});

redis.on("reconnecting", (delay) => {
  console.log(`🟡 Redis Reconnecting in ${delay}ms`);
});

// Export for adapters
export const pubClient = new Redis({
  ...redis.options,
  maxRetriesPerRequest: 1, // Pub/sub needs fewer retries
});

export const subClient = new Redis({
  ...redis.options,
  maxRetriesPerRequest: 1,
});