
import mediasoup from "mediasoup";
import os from "os";

const numCores = os.cpus().length;

const workers = [];
let nextWorkerIndex = 0;

export async function initMediasoup() {
  for (let i = 0; i < numCores; i++) {
    const worker = await mediasoup.createWorker({
      rtcMinPort: 40000 + i * 1000,
      rtcMaxPort: 40999 + i * 1000,
    });

    worker.on("died", () => {
      console.error("Mediasoup worker died");
      process.exit(1);
    });

    workers.push(worker);
  }

  console.log(`🔥 Created ${workers.length} mediasoup workers`);
}

export function getNextWorker() {
  const worker = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}


/* import mediasoup from 'mediasoup';

let worker;
let router;

export async function initMediasoup() {
  worker = await mediasoup.createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  });

  router = await worker.createRouter({
    mediaCodecs: [
        {
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
        },
        {
            kind: 'video',
            mimeType: 'video/VP8',
            clockRate: 90000,
        }
    ]
  });

  console.log('Mediasoup worker started');

  return router;
}

export function getRouter() {
  return router;
}
 */