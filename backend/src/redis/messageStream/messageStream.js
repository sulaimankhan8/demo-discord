import { redis } from "../index.js";
import pLimit from "p-limit";

export const MESSAGE_STREAM = ";stream:messages"

// ✅ Redis shared metrics keys
const METRICS_KEY = "metrics:producer";

// Track XADD attempts (local counters)
let xaddAttempts = 0;
let xaddSuccesses = 0;
let xaddFailures = 0;
let startTime = Date.now();

// ✅ Local received counter (synced to Redis every 5s)
let localReceived = 0;
let localFlushed = 0;
let localStreamWrites = 0;
let localQueued = 0;

// ✅ CRITICAL: Limit concurrent XADD operations
const xaddLimiter = pLimit(50);

// ✅ Batch state - OPTIMIZED for chat
let batchQueue = [];
let activeFlushes = 0;
let flushScheduled = false;
const MAX_CONCURRENT_FLUSHES = 4;
const BATCH_SIZE = 1000; // ✅ 1000 messages per batch (was 4000)
const BATCH_TIMEOUT = 50; // ✅ 50ms max wait (was 200ms)
let batchTimer = null;
let totalQueued = 0;
let totalFlushed = 0;

console.log(`[MESSAGE-STREAM] BATCH_SIZE=${BATCH_SIZE}, TIMEOUT=${BATCH_TIMEOUT}ms, MAX_FLUSHES=${MAX_CONCURRENT_FLUSHES}`);

// ✅ Increment received counter
export function incrementReceived() {
  localReceived++;
}

// ✅ Sync local metrics to Redis every 5 seconds (OFF the hot path!)
setInterval(async () => {
  const toSync = [];
  
  if (localReceived > 0) {
    toSync.push({ key: 'received', value: localReceived });
    localReceived = 0;
  }
  if (localFlushed > 0) {
    toSync.push({ key: 'flushed', value: localFlushed });
    localFlushed = 0;
  }
  if (localStreamWrites > 0) {
    toSync.push({ key: 'stream_writes', value: localStreamWrites });
    localStreamWrites = 0;
  }
  if (localQueued > 0) {
    toSync.push({ key: 'queued', value: localQueued });
    localQueued = 0;
  }
  
  if (toSync.length > 0) {
    const pipeline = redis.pipeline();
    for (const item of toSync) {
      pipeline.incrby(`${METRICS_KEY}:${item.key}`, item.value);
    }
    await pipeline.exec();
  }
}, 5000);

// ✅ Get shared metrics from Redis
export async function getMetrics() {
  const [received, queued, flushed, streamWrites, dbWrites] = await redis.mget(
    `${METRICS_KEY}:received`,
    `${METRICS_KEY}:queued`,
    `${METRICS_KEY}:flushed`,
    `${METRICS_KEY}:stream_writes`,
    `${METRICS_KEY}:db_writes`
  );
  
  return {
    received: parseInt(received || 0),
    sentToRedis: parseInt(queued || 0), // ✅ Renamed for clarity
    flushed: parseInt(flushed || 0),
    streamWrites: parseInt(streamWrites || 0),
    dbWrites: parseInt(dbWrites || 0),
  };
}

// ✅ Single message append (for fallback)
export async function appendMessage(message) {
  return xaddLimiter(() => appendMessageWithRetry(message));
}

async function appendMessageWithRetry(message, retryCount = 0) {
  xaddAttempts++;
  const maxRetries = 3;
  
  try {
    const result = await redis.xadd(
      MESSAGE_STREAM,
      "MAXLEN", "~", 500000,
      "*",
      "snowflake", message.snowflake,
      "socketId", message.socketId,
      "userId", message.userId,
      "username", message.username,
      "content", message.content,
      "createdAt", message.createdAt
    );

    xaddSuccesses++;
    localStreamWrites++; // ✅ Local counter, synced every 5s
    
    if (!result) {
      throw new Error('XADD returned no result');
    }
    
    return result;
    
  } catch (err) {
    if (retryCount < maxRetries && 
        (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.message.includes('timeout'))) {
      
      const delay = Math.pow(2, retryCount) * 100;
      await new Promise(resolve => setTimeout(resolve, delay));
      return appendMessageWithRetry(message, retryCount + 1);
    }
    
    xaddFailures++;
    console.error(`[XADD] ❌ FAILED - ${err.code || err.message}`);
    
    // ✅ DLQ with pipeline
    try {
      const dlq = redis.pipeline();
      dlq.lpush('dlq:messages', JSON.stringify({
        ...message,
        failedAt: new Date().toISOString(),
        error: err.message,
        retries: retryCount
      }));
      await dlq.exec();
    } catch (dlqErr) {
      console.error('[DLQ ERROR]', dlqErr.message);
    }
    
    throw err;
  }
}

// ✅ Batch append
export async function appendMessageBatch(messages) {
  if (messages.length === 0) return;

  return xaddLimiter(async () => {
    const pipeline = redis.pipeline();
    
    for (const message of messages) {
      pipeline.xadd(
        MESSAGE_STREAM,
        "MAXLEN", "~", 500000,
        "*",
        "snowflake", message.snowflake,
        "socketId", message.socketId,
        "userId", message.userId,
        "username", message.username,
        "content", message.content,
        "createdAt", message.createdAt
      );
    }
    
    const results = await pipeline.exec();
    let successCount = 0;
    const failedMessages = [];
    
    for (let i = 0; i < results.length; i++) {
      const [err, result] = results[i];
      if (err === null && result) {
        successCount++;
      } else {
        failedMessages.push({
          message: messages[i],
          error: err
        });
      }
    }
    
    xaddAttempts += messages.length;
    xaddSuccesses += successCount;
    xaddFailures += (messages.length - successCount);
    
    // ✅ Local counters - synced every 5s
    localFlushed += messages.length;
    localStreamWrites += successCount;
    
    // ✅ DLQ failures with pipeline
    if (failedMessages.length > 0) {
      console.error(`[BATCH] ❌ ${failedMessages.length}/${messages.length} failed`);
      
      const dlq = redis.pipeline();
      for (const failed of failedMessages) {
        dlq.lpush('dlq:messages', JSON.stringify({
          ...failed.message,
          failedAt: new Date().toISOString(),
          error: failed.error?.message || 'Pipeline error',
          batchFailed: true
        }));
      }
      await dlq.exec();
    }
    
    return results;
  });
}

// ✅ Queue message
export function queueMessage(message) {
  totalQueued++;
  batchQueue.push(message);
  
  if (batchQueue.length >= BATCH_SIZE) {
    flushQueue().catch(err => {
      console.error('[QUEUE] Flush failed:', err);
    });
  } else if (!batchTimer) {
    batchTimer = setTimeout(() => {
      batchTimer = null;
      flushQueue().catch(err => {
        console.error('[QUEUE] Timed flush failed:', err);
      });
    }, BATCH_TIMEOUT);
  }
}

async function flushQueue() {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  
  // ✅ Prevent timer storm with flushScheduled flag
  if (activeFlushes >= MAX_CONCURRENT_FLUSHES) {
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(() => {
        flushScheduled = false;
        flushQueue().catch(err => {
          console.error('[QUEUE] Retry flush failed:', err);
        });
      }, 10);
    }
    return;
  }
  
  if (batchQueue.length === 0) return;
  
  activeFlushes++;
  const batch = batchQueue.splice(0, BATCH_SIZE);
  
  // ✅ Local counter for queued
  localQueued += batch.length;
  
  try {
    await appendMessageBatch(batch);
    totalFlushed += batch.length;
  } catch (err) {
    console.error('[QUEUE FLUSH ERROR]', err);
    batchQueue.unshift(...batch);
  } finally {
    activeFlushes--;
    
    if (batchQueue.length > 0) {
      setImmediate(() => {
        flushQueue().catch(err => {
          console.error('[QUEUE] Post-flush retry failed:', err);
        });
      });
    }
  }
}

// ✅ Monitor queue growth
setInterval(() => {
  const queueSize = batchQueue.length;
  if (queueSize > 1000) {
    console.warn(`[QUEUE WARNING] ⚠️ Queue size: ${queueSize}`);
  }
  if (queueSize > 5000) {
    console.error(`[QUEUE CRITICAL] 🔴 Queue size: ${queueSize} - BACKPRESSURE!`);
  }
}, 2000);

// ✅ Metrics logging - EVERY 5 SECONDS
setInterval(async () => {
  const uptime = Math.round((Date.now() - startTime) / 1000);
  const stats = await getMetrics();
  
  console.log('[📊 PRODUCER METRICS]', {
    uptime: `${uptime}s`,
    ...stats,
    queueSize: batchQueue.length,
    activeFlushes: activeFlushes,
    xaddAttempts: xaddAttempts,
    xaddSuccesses: xaddSuccesses,
    xaddFailures: xaddFailures,
  });
}, 5000);

// ✅ Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`[${signal}] 🛑 Shutting down...`);
  const stats = await getMetrics();
  console.log(`[${signal}] 📊 Final:`, stats);
  
  if (batchQueue.length > 0) {
    console.log(`[${signal}] 📦 Flushing ${batchQueue.length} remaining...`);
    await flushQueue();
  }
  
  console.log(`[${signal}] ✅ Shutdown complete`);
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export function getXaddStats() {
  return { 
    attempts: xaddAttempts, 
    successes: xaddSuccesses,
    failures: xaddFailures,
    successRate: xaddAttempts > 0 ? xaddSuccesses/xaddAttempts : 0,
    queueSize: batchQueue.length,
    activeFlushes: activeFlushes,
    totalQueued: totalQueued,
    totalFlushed: totalFlushed,
    pending: totalQueued - totalFlushed,
  };
}