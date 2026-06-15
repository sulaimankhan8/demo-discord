import { eventBus }
from "../eventBus.js";

import { EVENTS }
from "../events.js";

export function publishMessageCreated(
  payload
) {
  eventBus.emit(
    EVENTS.MESSAGE_CREATED,
    payload
  );
}