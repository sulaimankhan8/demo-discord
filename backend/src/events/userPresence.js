import { eventBus } from "./eventBus.js";
import { EVENTS } from "./events.js";

import {
  analyticsQueue,
} from "../queues/analytics.queue.js";

eventBus.on(
  EVENTS.USER_ONLINE,
  async (payload) => {

    try {

      await analyticsQueue.add(
        "user-online",
        payload
      );

    } catch (err) {

      console.error(
        "[USER_ONLINE_EVENT]",
        err
      );

    }

  }
);

eventBus.on(
  EVENTS.USER_OFFLINE,
  async (payload) => {

    try {

      await analyticsQueue.add(
        "user-offline",
        payload
      );

    } catch (err) {

      console.error(
        "[USER_OFFLINE_EVENT]",
        err
      );

    }

  }
);