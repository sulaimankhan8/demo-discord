import mediasoup from "mediasoup";
import os from "os";

const numCores = os.cpus().length;

/*
workers = [
  { worker, pid }
]
*/
const workers = [];
let nextWorkerIndex = 0;

/* ---------------- CREATE WORKER ---------------- */

async function createWorker(index) {
  const worker = await mediasoup.createWorker({
    rtcMinPort: 40000 + index * 1000,
    rtcMaxPort: 40999 + index * 1000,
  });

  console.log(`🔥 Mediasoup worker created (PID ${worker.pid})`);

  worker.on("died", async () => {
    console.error(`💥 Worker ${worker.pid} died. Restarting...`);

    const idx = workers.findIndex(w => w.worker.pid === worker.pid);

    if (idx !== -1) {
      workers.splice(idx, 1);
    }

    try {
      const newWorker = await createWorker(index);
      workers.push({ worker: newWorker, pid: newWorker.pid });

      console.log(`✅ Replacement worker started (PID ${newWorker.pid})`);
    } catch (err) {
      console.error("❌ Failed to restart worker", err);
    }
  });

  return worker;
}

/* ---------------- INIT WORKERS ---------------- */

export async function initMediasoup() {
  for (let i = 0; i < numCores; i++) {
    setTimeout(async () => {
    const worker = await createWorker(i);

    workers.push({
      worker,
      pid: worker.pid
    });
},2000)
  }

  console.log(`🔥 Created ${workers.length} mediasoup workers`);
}

/* ---------------- GET NEXT WORKER ---------------- */

export function getNextWorker() {
  if (workers.length === 0) {
    throw new Error("No mediasoup workers available");
  }

  const workerObj = workers[nextWorkerIndex];

  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;

  return workerObj.worker;
}











/* 
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
      process.exit(1); // 
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

 */