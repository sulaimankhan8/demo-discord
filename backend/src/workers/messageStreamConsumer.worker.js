import { redis } from "../redis/index.js";

const STREAM = "stream:messages";
const GROUP ="message-consumers";
const CONSUMER = `worker-${process.pid}`;

/* ---------------- CONFIG ---------------- */

let BATCH_SIZE = 100;

const FLUSH_INTERVAL = 200;
const PRESSURE_FLUSH_AGE = 1000;
const MAX_CONCURRENT_FLUSHES = 2;

/* ---------------- STATE ---------------- */

const buffer = [];

let flushSemaphore = 0;
let lastFlush = Date.now();
let oldestMessageTime = Date.now();

console.log(
  "[STREAM WORKER]",
  CONSUMER
);

/* ---------------- HELPERS ---------------- */

function parseFields(fields) {
  const obj = {};

  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }

  return obj;
}

function adjustBatchSize() {
  const delta = Date.now() - lastFlush;

  if (delta < 50) {
    BATCH_SIZE = Math.min(
      BATCH_SIZE * 2,
      500
    );
  } else if (delta > 200) {
    BATCH_SIZE = Math.max(
      Math.floor(BATCH_SIZE / 2),
      50
    );
  }

  lastFlush = Date.now();
}

/* ---------------- FLUSH ---------------- */

async function flushMessages() {
  if (
    flushSemaphore >=
    MAX_CONCURRENT_FLUSHES
  ) {
    return;
  }

  if (buffer.length === 0) {
    return;
  }

  flushSemaphore++;

  try {
    adjustBatchSize();

    const batch =
      buffer.splice(
        0,
        BATCH_SIZE
      );

   console.log(
  "[FLUSH]",
  batch.length,
  "remaining:",
  buffer.length
);


const inserted =
  await db
    .insert(messages)
    .values(
      batch.map((m) => ({
        userId:
          m.userId,

        snowflake:
          m.snowflake,

        username:
          m.username,

        content:
          m.content,

        createdAt:
          m.createdAt,
      }))
    )
    .returning({
      id: messages.id,
      snowflake:
        messages.snowflake,
    });



    const streamIds =
  batch.map(
    (m) => m.streamId
  );


  await redis.xack(
  STREAM,
  GROUP,
  ...streamIds
);

    /*
      NEXT STEP:

      await db.insert(...)

      then:

      await redis.xack(...)
    */
    console.log(
      `[DB FLUSHED] ${inserted.length}`
    );

    if (
  buffer.length === 0
) {
  oldestMessageTime =
    Date.now();
}


  } catch (err) {
    console.error(
      "[FLUSH ERROR]",
      err
    );
  } finally {
    flushSemaphore--;
  }
}

/* ---------------- TIMER FLUSH ---------------- */

setInterval(() => {
  if (buffer.length === 0) {
    return;
  }

  let shouldFlush = false;

  if (
    Date.now() -
      oldestMessageTime >
    PRESSURE_FLUSH_AGE
  ) {
    shouldFlush = true;
  }

  if (
    buffer.length >=
    BATCH_SIZE
  ) {
    shouldFlush = true;
  }

  if (shouldFlush) {
    flushMessages();
  }
}, FLUSH_INTERVAL);

/* ---------------- CONSUMER LOOP ---------------- */

async function start() {
  while (true) {
    try {
      const data =
        await redis.xreadgroup(
          "GROUP",
          GROUP,
          CONSUMER,

          "COUNT",
          100,

          "BLOCK",
          5000,

          "STREAMS",
          STREAM,
          ">"
        );

      if (!data) {
        continue;
      }

      for (const stream of data) {
        const entries =
          stream[1];

        for (const [
          id,
          fields,
        ] of entries) {
          const msg =
            parseFields(fields);

          buffer.push({
            streamId: id,

            socketId:
              msg.socketId,

            snowflake:
              msg.snowflake,

            userId:
              msg.userId,

            username:
              msg.username,

            content:
              msg.content,

            createdAt:
              new Date(
                msg.createdAt
              ),
          });

          oldestMessageTime =
            Math.min(
              oldestMessageTime,
              Date.now()
            );
        }
      }

      if (
        buffer.length >=
        BATCH_SIZE
      ) {
        flushMessages();
      }
    } catch (err) {
      console.error(
        "[STREAM ERROR]",
        err
      );
    }
  }
}

start();