import http from "http";
import app from "./app.js";
import { initSocket } from "./socket.js";
import { ENV } from "./utils/env.js";
import { initMediasoup } from "./voice/mediasoup.js";
import "./events/index.js";
import { setupMessageStream } from "./workers/messageStreamSetup.js";

const server = http.createServer(app);

await setupMessageStream();
await initMediasoup();
initSocket(server);

server.listen(ENV.PORT, "0.0.0.0", () => {
  console.log(`Backend running on port ${ENV.PORT}`);
});
 