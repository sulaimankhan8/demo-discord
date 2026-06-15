import { Worker } from "bullmq";

import { redis } from "../redis/index.js";

import { db } from "../db/index.js";

import { analyticsEvents } from "../db/schema.js";

new Worker("analytics",

  async (job) => {

    await db
      .insert(
        analyticsEvents
      )
      .values({
        eventType:
          job.name,

        payload:
          job.data,
      });

  },

  {
    connection:
      redis,

    concurrency: 50,
  }
);

console.log(
  "Analytics Worker Started"
);