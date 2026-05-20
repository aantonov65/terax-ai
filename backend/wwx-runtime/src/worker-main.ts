import { createRuntimeFromEnv } from "./runtime.js";
import { RuntimeWorker } from "./worker.js";

const runtime = createRuntimeFromEnv();
const concurrency = Number.parseInt(process.env.WORKER_CONCURRENCY ?? "6", 10);
const workerCount = Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 6;

await Promise.all(
  Array.from({ length: workerCount }, (_, index) => workerLoop(`worker-${index + 1}`)),
);

async function workerLoop(workerId: string): Promise<void> {
  const worker = new RuntimeWorker(workerId, runtime.store, runtime.service, runtime.engine);
  for (;;) {
    const ran = await worker.runOne();
    if (!ran) await sleep(500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
