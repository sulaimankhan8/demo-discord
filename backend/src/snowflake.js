import os from 'os';

const EPOCH = 1577836800000n;
const TIMESTAMP_SHIFT = 22n;
const DATACENTER_SHIFT = 17n;
const WORKER_SHIFT = 12n;
const MAX_SEQUENCE = 4095n;

class Snowflake {
  constructor({ datacenterId, workerId }) {
    this.datacenterId = BigInt(datacenterId);
    
    // Generate a unique worker ID using hostname + PID
    const hostname = os.hostname();
    const pid = process.pid;
    
    // Create a hash from hostname
    let hash = 0;
    for (let i = 0; i < hostname.length; i++) {
      hash = ((hash << 5) - hash) + hostname.charCodeAt(i);
      hash = hash & hash;
    }
    
    // Combine hostname hash and PID to create a unique worker ID (0-31)
    const uniqueWorkerId = Math.abs((hash + pid) % 32);
    this.workerId = BigInt(uniqueWorkerId);
    
    console.log(`[SNOWFLAKE] datacenterId=${datacenterId} workerId=${uniqueWorkerId} hostname=${hostname} pid=${pid}`);
    
    this.lastTimestamp = 0n;
    this.sequence = 0n;
  }

  now() {
    return BigInt(Date.now());
  }

  generate() {
    let timestamp = this.now();

    if (timestamp < this.lastTimestamp) {
      timestamp = this.lastTimestamp;
    }

    if (timestamp === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & MAX_SEQUENCE;
      if (this.sequence === 0n) {
        timestamp = this.lastTimestamp + 1n;
        this.sequence = 0n;
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