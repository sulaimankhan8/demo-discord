import { getXaddStats } from './redis/messageStream/messageStream.js';
import { redis } from './redis/index.js';

export async function getHealthStatus() {
  const xaddStats = getXaddStats();
  
  let streamInfo;
  try {
    streamInfo = await redis.xinfo('STREAM', 'stream:messages');
  } catch (err) {
    streamInfo = null;
  }

  const dbCount = await db.select({ count: sql`count(*)` }).from(messages);
console.log({status: 'ok',
    timestamp: new Date().toISOString(),
    xadd: xaddStats,
    stream: {
      length: streamInfo?.[1] || 0,
      firstEntry: streamInfo?.[5] || null,
      lastEntry: streamInfo?.[7] || null,
    }});
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    xadd: xaddStats,
    stream: {
      length: streamInfo?.[1] || 0,
      firstEntry: streamInfo?.[5] || null,
      lastEntry: streamInfo?.[7] || null,
    },
    db: {
      count: dbCount[0]?.count || 0,
    },
    mismatch: dbCount[0]?.count - xaddStats.successes,
  };
}