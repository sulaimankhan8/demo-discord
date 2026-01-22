import http from "http";
import app from "./app.js";
import { initSocket } from "./socket.js";
import { ENV } from "./utils/env.js";

const server = http.createServer(app);
initSocket(server);

server.listen(ENV.PORT, "0.0.0.0", () => {
  console.log(`Backend running on port ${ENV.PORT}`);
});
