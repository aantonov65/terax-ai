import { Pool } from "pg";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ObservabilityClient } from "../../../packages/observability/src/index.js";
import { FakeLfsEngine, LegacyLfs41Engine, type Engine } from "./engine.js";
import { MemoryObservabilityRepository, PostgresObservabilityRepository } from "./observability-repo.js";
import { PostgresStore } from "./postgres.js";
import { RuntimeService } from "./service.js";
import { MemoryObjectStorage, R2ObjectStorage, type ObjectStorage } from "./storage.js";
import { MemoryStore, type Store } from "./store.js";
import { createWorkflowTriggerFromEnv, type WorkflowTrigger } from "./trigger.js";
import { WorkflowRuntimeService } from "./workflow-service.js";

export type RuntimeParts = {
  store: Store;
  storage: ObjectStorage;
  engine: Engine;
  service: RuntimeService;
  observability: ObservabilityClient;
  trigger: WorkflowTrigger;
  workflow: WorkflowRuntimeService;
};

export function createRuntimeFromEnv(): RuntimeParts {
  const maxActiveJobs = parseIntEnv("WORKER_CONCURRENCY", 6);
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
  const store = pool
    ? new PostgresStore(pool, maxActiveJobs)
    : new MemoryStore(maxActiveJobs);
  const storage = createStorageFromEnv();
  const engine = createEngineFromEnv();
  const service = new RuntimeService(store, storage);
  const observability = new ObservabilityClient(
    pool ? new PostgresObservabilityRepository(pool) : new MemoryObservabilityRepository(),
  );
  const trigger = createWorkflowTriggerFromEnv();
  const workflow = new WorkflowRuntimeService(observability, trigger, service);
  return { store, storage, engine, service, observability, trigger, workflow };
}

function createEngineFromEnv(): Engine {
  if (process.env.WWX_RUNTIME_ENGINE !== "fake" && process.env.WW2_ENGINE_ROOT) {
    return new LegacyLfs41Engine(resolveEngineRoot(process.env.WW2_ENGINE_ROOT), process.env.WWX_RUNTIME_WORK_ROOT);
  }
  return new FakeLfsEngine();
}

function resolveEngineRoot(rawRoot: string): string {
  if (isAbsolute(rawRoot)) return rawRoot;
  const runtimeDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), rawRoot),
    resolve(runtimeDir, "../", rawRoot),
    resolve(runtimeDir, "../../", rawRoot),
    resolve(runtimeDir, "../../../", rawRoot),
    resolve(runtimeDir, "../../../../", rawRoot),
    resolve(runtimeDir, "../../../../../", rawRoot),
    join("/app", rawRoot),
    join("/workspace", rawRoot),
    join("/tmp", rawRoot),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "tools", "ww"))) ?? resolve(process.cwd(), rawRoot);
}

function createStorageFromEnv(): ObjectStorage {
  const bucket = process.env.R2_BUCKET;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (bucket && endpoint && accessKeyId && secretAccessKey) {
    return new R2ObjectStorage(bucket, endpoint, accessKeyId, secretAccessKey);
  }
  return new MemoryObjectStorage();
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
