import { eventBus }
from "../eventBus.js";

import { EVENTS }
from "../events.js";

export function publishVoiceJoined(
  payload
) {
  eventBus.emit(
    EVENTS.VOICE_JOINED,
    payload
  );
}

export function publishVoiceLeft(
  payload
) {
  eventBus.emit(
    EVENTS.VOICE_LEFT,
    payload
  );
}