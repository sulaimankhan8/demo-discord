import { eventBus }
from "../eventBus.js";

import { EVENTS }
from "../events.js";

export function publishUserOnline(
  payload
) {
  eventBus.emit(
    EVENTS.USER_ONLINE,
    payload
  );
}

export function publishUserOffline(
  payload
) {
  eventBus.emit(
    EVENTS.USER_OFFLINE,
    payload
  );
}