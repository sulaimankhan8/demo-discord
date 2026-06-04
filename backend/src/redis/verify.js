import { redis } from "./index.js";

await redis.set(
  "test",
  "hello"
);

console.log(
  await redis.get("test")
);
console.log(
  "[PID]",
  process.pid,
  "Socket:",
  socket.id
);