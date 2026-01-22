// backend/src/snowflake.js

let lastTimestamp = 0;
let sequence = 0;

const EPOCH = 1577836800000; // custom epoch

export function generateSnowflake() {
  let now = Date.now();

  if (now === lastTimestamp) {
    sequence = (sequence + 1) & 4095; // 12-bit sequence
    if (sequence === 0) {
      while (Date.now() <= lastTimestamp) {}
      now = Date.now();
    }
  } else {
    sequence = 0;
  }

  lastTimestamp = now;

  return ((now - EPOCH) << 12) | sequence;
}
