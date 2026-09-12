import os from 'os';

const EPOCH = 1577836800000n;
const TIMESTAMP_SHIFT = 22n;
const DATACENTER_SHIFT = 17n;
const WORKER_SHIFT = 12n;
const MAX_SEQUENCE = 4095n;

class Snowflake {
  constructor({ datacenterId = 1, workerId } = {}) {
    this.datacenterId = BigInt(datacenterId) & 31n;
    
    if (workerId !== undefined && workerId !== null && !isNaN(Number(workerId))) {
      this.workerId = BigInt(workerId) & 31n;
    } else {
      // Generate a fallback worker ID using hostname + PID
      const hostname = os.hostname();
      const pid = process.pid;
      
      let hash = 0;
      for (let i = 0; i < hostname.length; i++) {
        hash = ((hash << 5) - hash) + hostname.charCodeAt(i);
        hash = hash & hash;
      }
      
      const uniqueWorkerId = Math.abs((hash + pid) % 32);
      this.workerId = BigInt(uniqueWorkerId);
    }
    
    console.log(`[SNOWFLAKE] datacenterId=${this.datacenterId} workerId=${this.workerId} pid=${process.pid}`);
    
    this.lastTimestamp = 0n;
    this.sequence = 0n;
  }

  now() {
    return BigInt(Date.now());
  }

  waitNextMillis(lastTimestamp) {
    let timestamp = this.now();
    while (timestamp <= lastTimestamp) {
      timestamp = this.now();
    }
    return timestamp;
  }

  generate() {
    let timestamp = this.now();

    // Clock moved backwards, wait until it catches up
    if (timestamp < this.lastTimestamp) {
      timestamp = this.waitNextMillis(this.lastTimestamp);
    }

    if (timestamp === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & MAX_SEQUENCE;
      if (this.sequence === 0n) {
        timestamp = this.waitNextMillis(this.lastTimestamp);
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = timestamp;

    const snowflake = (
      ((timestamp - EPOCH) << TIMESTAMP_SHIFT) |
      (this.datacenterId << DATACENTER_SHIFT) |
      (this.workerId << WORKER_SHIFT) |
      this.sequence
    );

    return snowflake.toString(); // 👈 Return as string!
  }
}

export default Snowflake;