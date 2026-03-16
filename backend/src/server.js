import http from "http";
import app from "./app.js";
import { initSocket } from "./socket.js";
import { ENV } from "./utils/env.js";
import { initMediasoup } from "./voice/mediasoup.js";
import { monitorEventLoopDelay } from "perf_hooks";

const server = http.createServer(app);

/* -------- EVENT LOOP MONITOR -------- */

const h = monitorEventLoopDelay();
h.enable();

setInterval(() => {
  console.log("event loop lag ms:", (h.mean / 1e6).toFixed(2));
}, 2000);

/* --------- STARTUP SEQUENCE --------- */

await initMediasoup();
initSocket(server);


server.listen(ENV.PORT, "0.0.0.0", () => {
  console.log(`Backend running on port ${ENV.PORT}`);
});
