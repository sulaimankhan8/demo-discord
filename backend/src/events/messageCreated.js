
import { eventBus }
  from "./eventBus.js";

import { EVENTS }
  from "./events.js";

import { notificationQueue }
  from "../queues/notification.queue.js";

import { analyticsQueue }
  from "../queues/analytics.queue.js";
eventBus.on(
  EVENTS.MESSAGE_CREATED,
  async (payload) => {

    try {

      await Promise.all([
      
      notificationQueue.add(
        "message-notification",
        payload
      ),

      analyticsQueue.add(
        "message-created",
        payload
      ),]);

    } catch (err) {

      console.error(
        "[MESSAGE_CREATED_EVENT]",
        err
      );

    }
  }
);