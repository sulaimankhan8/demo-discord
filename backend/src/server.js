import fs from "fs";
import http from "http";
import https from "https";
import app from "./app.js";
import { initSocket } from "./socket.js";
import { ENV } from "./utils/env.js";
import { initMediasoup } from "./voice/mediasoup.js";
import "./events/index.js";
import { setupMessageStream } from "./workers/messageStreamSetup.js";

// Serve HTTPS when a cert is configured, so browsers on other LAN machines
// allow camera/mic access (they only do on https:// or localhost).
const useHttps = Boolean(ENV.SSL_KEY_PATH && ENV.SSL_CERT_PATH);

const server = useHttps
  ? https.createServer(
      {
        key: fs.readFileSync(ENV.SSL_KEY_PATH),
        cert: fs.readFileSync(ENV.SSL_CERT_PATH),
      },
      app
    )
  : http.createServer(app);

await setupMessageStream();
await initMediasoup();
initSocket(server);
(await import("./mesh/bridge.js")).attachMeshBridge(server); // offline-mesh internet bridge (docs/10 C5)

server.listen(ENV.PORT, "0.0.0.0", () => {
  console.log(`Backend running on ${useHttps ? "https" : "http"} port ${ENV.PORT}`);
});
