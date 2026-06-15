import {
  registerMessageHandlers,
} from "./handlers/message.handler.js";

import {
  registerPresenceHandlers,
} from "./handlers/presence.handler.js";

import {
  registerTypingHandlers,
} from "./handlers/typing.handler.js";

export function initChatGateway(
  io
) {
  io.on(
    "connection",
    async (socket) => {

      socket.join(
        "global-chat"
      );

      registerPresenceHandlers(
        io,
        socket
      );

      registerTypingHandlers(
        io,
        socket
      );

      registerMessageHandlers(
        io,
        socket
      );

    }
  );
}