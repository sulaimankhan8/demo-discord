import { redis }
from "../redis/index.js";

import { db }
from "../db/index.js";

import {messages} from "../db/schema.js";


async function start() {

  let lastId = "$";

  

  while (true) {

    const data =await redis.xread(
        "BLOCK",
        5000,
        "STREAMS",
        "stream:messages",
        lastId
      );

    if (!data)
      continue;

    const entries =data[0][1];

    for (const [id, fields] of entries) {

      lastId = id;

      const obj = {};

      for (let i = 0;i < fields.length;i += 2) {

        obj[fields[i]] =fields[i + 1];

      }

      await db
        .insert(messages)
        .values({
          userId:obj.userId,

          username:obj.username,

          content:obj.content,

          snowflake:obj.snowflake,

          createdAt:new Date(obj.createdAt),
        });

    }

  }

}

start();