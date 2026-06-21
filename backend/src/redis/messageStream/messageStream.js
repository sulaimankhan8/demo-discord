import { redis } from "../index.js";
import pLimit from "p-limit";

export const MESSAGE_STREAM = "stream:messages";

// Track XADD attempts
let xaddAttempts = 0;
let xaddSuccesses = 0;
let xaddFailures = 0;

// ✅ CRITICAL: Limit concurrent XADD operations
const xaddLimiter = pLimit(50); // Only 50 concurrent XADDs

// ✅ Batch state for better performance
let messageBatch = [];
let batchTimer = null;
const BATCH_SIZE = 500;
const BATCH_TIMEOUT = 10; // ms

export async function appendMessage(message) {
  // Use the limiter to control concurrency
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
    
    if (!result) {
      throw new Error('XADD returned no result');
    }
    
    return result;
    
  } catch (err) {
    // Check if we should retry
    if (retryCount < maxRetries && 
        (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.message.includes('timeout'))) {
      
      console.log(`[RETRY ${retryCount + 1}/${maxRetries}] ${message.snowflake} - ${err.code}`);
      
      // Exponential backoff
      const delay = Math.pow(2, retryCount) * 100;
      await new Promise(resolve => setTimeout(resolve, delay));
      
      return appendMessageWithRetry(message, retryCount + 1);
    }
    
    // Log failure
    xaddFailures++;
    console.error(`[XADD FAILED] snowflake=${message.snowflake}`, err.code || err.message);
    
    // Try to save to DLQ
    try {
      await redis.lpush('dlq:messages', JSON.stringify({
        ...message,
        failedAt: new Date().toISOString(),
        error: err.message,
        retries: retryCount
      }));
    } catch (dlqErr) {
      console.error('[DLQ ERROR]', dlqErr.message);
    }
    
    throw err;
  }
}

// ✅ BATCH VERSION with concurrency limiting
export async function appendMessageBatch(messages) {
  if (messages.length === 0) return;
  
  // Use the limiter to control batch concurrency
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
    const successCount = results.filter(r => r[0] === null).length;
    
    xaddAttempts += messages.length;
    xaddSuccesses += successCount;
    xaddFailures += (messages.length - successCount);
    
    if (successCount < messages.length) {
      console.error(`[BATCH] Only ${successCount}/${messages.length} messages persisted`);
    }
    
    return results;
  });
}

// ✅ QUEUE-BASED BATCHING
let batchQueue = [];
let isFlushing = false;

export function queueMessage(message) {
  batchQueue.push(message);
  
  if (batchQueue.length >= BATCH_SIZE) {
    flushQueue();
  } else if (!batchTimer) {
    batchTimer = setTimeout(flushQueue, BATCH_TIMEOUT);
  }
}

async function flushQueue() {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  
  if (isFlushing || batchQueue.length === 0) {
    return;
  }
  
  isFlushing = true;
  const batch = batchQueue.splice(0, BATCH_SIZE);
  
  try {
    await appendMessageBatch(batch);
  } catch (err) {
    console.error('[QUEUE FLUSH ERROR]', err);
    // Re-queue failed messages
    batchQueue.unshift(...batch);
  } finally {
    isFlushing = false;
    
    // Process remaining
    if (batchQueue.length > 0) {
      setTimeout(flushQueue, 0);
    }
  }
}

// ✅ Choose one approach:
// Option A: Use appendMessage() with concurrency limiter (safer)
// Option B: Use queueMessage() for batching (better performance)

// Periodically log stats
setInterval(() => {
  const stats = {
    attempts: xaddAttempts,
    successes: xaddSuccesses,
    failures: xaddFailures,
    successRate: xaddAttempts > 0 ? ((xaddSuccesses/xaddAttempts)*100).toFixed(1) + '%' : '0%',
    queueSize: batchQueue.length,
    isFlushing,
    limiterPending: xaddLimiter.pendingCount || 0,
  };
  
  console.log('[XADD STATS]', stats);
}, 5000);

// Clean up on exit
process.on('exit', () => {
  if (batchQueue.length > 0) {
    console.log('[FINAL FLUSH] Persisting remaining messages...');
    flushQueue();
  }
});

export function getXaddStats() {
  return { 
    attempts: xaddAttempts, 
    successes: xaddSuccesses,
    failures: xaddFailures,
    successRate: xaddAttempts > 0 ? xaddSuccesses/xaddAttempts : 0,
    queueSize: batchQueue.length,
  };
}