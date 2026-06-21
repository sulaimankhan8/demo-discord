import { redis }
from "../index.js";

import { CHANNELS }
from "./channels.js";

export async function publishMessageAck(
  payload
) {
  await redis.publish(
    CHANNELS.MESSAGE_ACK,
    JSON.stringify(payload)
  );
}