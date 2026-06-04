export const PresenceKeys = {
  user: (userId) =>
    `presence:user:${userId}`,

  sockets: (userId) =>
    `presence:sockets:${userId}`,

  socket: (socketId) =>
    `presence:socket:${socketId}`,
};

export const RoomKeys = {
  room: (roomId) =>
    `room:${roomId}`,
};