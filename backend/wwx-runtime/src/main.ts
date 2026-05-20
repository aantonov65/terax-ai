import { buildApi } from "./api.js";
import { createRuntimeFromEnv } from "./runtime.js";
import { initSentry } from "./sentry.js";
import { RuntimeWorker } from "./worker.js";

initSentry();
const runtime = createRuntimeFromEnv();
const app = buildApi(runtime.service, runtime.workflow, runtime.observability);
const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const host = process.env.HOST ?? "0.0.0.0";

if (process.env.WWX_RUNTIME_EMBED_WORKER === "1") {
  const worker = new RuntimeWorker("embedded-api-worker", runtime.store, runtime.service, runtime.engine);
  setInterval(() => {
    worker.runOne().catch((error: unknown) => app.log.error({ error }, "embedded worker failed"));
  }, 500);
}

await app.listen({ port, host });
