import { redis } from '../redis/index.js';
import { appendMessage } from '../redis/messageStream/messageStream.js';

async function recoverDeadLetterQueue() {
  console.log('[RECOVERY] Starting DLQ recovery');
  
  let recovered = 0;
  while (true) {
    const item = await redis.rpop('dlq:messages');
    if (!item) break;
    
    try {
      const message = JSON.parse(item);
      await appendMessage(message);
      recovered++;
      if (recovered % 100 === 0) {
        console.log(`[RECOVERY] Recovered ${recovered} messages`);
      }
    } catch (err) {
      console.error('[RECOVERY] Failed to recover message', err);
      // Re-queue to a retry queue
      await redis.lpush('dlq:retry', item);
    }
  }
  
  console.log(`[RECOVERY] Completed. Recovered ${recovered} messages`);
  process.exit(0);
}

recoverDeadLetterQueue();