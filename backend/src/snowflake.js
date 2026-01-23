// backend/src/snowflake.js

let lastTimestamp = 0n;
let sequence = 0n;

const EPOCH = 1577836800000n; // bigint

export function generateSnowflake() {
  let now = BigInt(Date.now());

  if (now === lastTimestamp) {
    sequence = (sequence + 1n) & 4095n;
    if (sequence === 0n) {
      while (BigInt(Date.now()) <= lastTimestamp) {}
      now = BigInt(Date.now());
    }
  } else {
    sequence = 0n;
  }

  lastTimestamp = now;

  return ((now - EPOCH) << 12n) | sequence;
}
