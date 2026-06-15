export function registerTypingHandlers(
  socket
) {

  socket.on(
    "typing:start",
    () => {

      socket
        .to("global-chat")
        .volatile
        .emit(
          "typing:start",
          {
            userId:
              socket.userId,

            username:
              socket.username,
          }
        );

    }
  );

  socket.on(
    "typing:stop",
    () => {

      socket
        .to("global-chat")
        .volatile
        .emit(
          "typing:stop",
          socket.userId
        );

    }
  );
}