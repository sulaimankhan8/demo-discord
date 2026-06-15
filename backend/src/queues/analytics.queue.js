import { Queue } from "bullmq";
import { redis } from "../redis/index.js";

export const analyticsQueue =
  new Queue(
    "analytics",
    {
      connection: redis,

      defaultJobOptions: {
        removeOnComplete: 100,

        removeOnFail: 500,

        attempts: 3,

        backoff: {
          type: "exponential",
          delay: 1000,
        },
      },
    }
  );