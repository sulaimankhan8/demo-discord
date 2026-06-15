import { Worker }
from "bullmq";

import { redis }
from "../redis/index.js";

import { db }
from "../db/index.js";

import {
  notifications,
} from "../db/schema.js";

const worker =
  new Worker(
    "notifications",

    async (job) => {

      await db
        .insert(
          notifications
        )
        .values({

          userId:
            job.data.userId,

          type:
            "message",

          title:
            `${job.data.username} sent a message`,

          payload:
            job.data,

        });

    },

    {
      connection:
        redis,

      concurrency: 20,
    }
  );

worker.on(
  "completed",
  (job) => {

    console.log(
      `[NOTIFICATION COMPLETED] ${job.id}`
    );

  }
);

worker.on(
  "failed",
  (job, err) => {

    console.error(
      `[NOTIFICATION FAILED] ${job?.id}`,
      err
    );

  }
);

console.log(
  "Notification Worker Started"
);