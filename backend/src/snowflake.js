const EPOCH = 1577836800000n;

const TIMESTAMP_SHIFT = 22n;
const DATACENTER_SHIFT = 17n;
const WORKER_SHIFT = 12n;

const MAX_SEQUENCE = 4095n;

class Snowflake {
  constructor({ datacenterId, workerId }) {
    this.datacenterId = BigInt(datacenterId);
    this.workerId = BigInt(workerId);
    this.lastTimestamp = 0n;
    this.sequence = 0n;
  }

  now() {
    return BigInt(Date.now());
  }

  waitNextMillis(ts) {
    let now = this.now();
    while (now <= ts) now = this.now();
    return now;
  }

  generate() {
    let timestamp = this.now();

    if (timestamp < this.lastTimestamp) {
      throw new Error("Clock moved backwards");
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

    return (
      ((timestamp - EPOCH) << TIMESTAMP_SHIFT) |
      (this.datacenterId << DATACENTER_SHIFT) |
      (this.workerId << WORKER_SHIFT) |
      this.sequence
    );
  }
}

export default Snowflake;
