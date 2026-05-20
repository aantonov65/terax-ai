CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (workspace_id, email)
);

CREATE TABLE IF NOT EXISTS products (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  topic_slug TEXT NOT NULL,
  search_terms JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  corpus_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  synthesis_object_key TEXT,
  canonical_research_object_key TEXT,
  embeddings_ref TEXT,
  lineage JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_research_runs_workspace_product ON research_runs(workspace_id, product_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_research_runs_topic_folder ON research_runs(workspace_id, product_id, topic_slug, id);

CREATE TABLE IF NOT EXISTS batches (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  current_stage TEXT,
  requested_ad_count INTEGER NOT NULL,
  input_hash TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_batches_workspace_product ON batches(workspace_id, product_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS batch_research_runs (
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, batch_id, research_run_id),
  FOREIGN KEY (workspace_id, batch_id) REFERENCES batches(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS batch_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_stage TEXT,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  heartbeat_at BIGINT NOT NULL,
  error_reason TEXT,
  FOREIGN KEY (workspace_id, batch_id) REFERENCES batches(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_batch_runs_batch ON batch_runs(workspace_id, batch_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_batch_runs_heartbeat ON batch_runs(status, heartbeat_at);

CREATE TABLE IF NOT EXISTS stage_states (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES batch_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  expected_items INTEGER NOT NULL DEFAULT 0,
  completed_items INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  UNIQUE (workspace_id, batch_id, stage),
  FOREIGN KEY (workspace_id, batch_id) REFERENCES batches(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stage_work_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES batch_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  item_key TEXT NOT NULL,
  status TEXT NOT NULL,
  artifact_id TEXT,
  idempotency_key TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (workspace_id, batch_id, stage, item_key),
  UNIQUE (idempotency_key),
  FOREIGN KEY (workspace_id, batch_id) REFERENCES batches(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stage_work_items_resume ON stage_work_items(workspace_id, batch_id, stage, status);

CREATE TABLE IF NOT EXISTS job_queue (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at BIGINT,
  run_id TEXT,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (workspace_id, batch_id) REFERENCES batches(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_queue_claim ON job_queue(status, lease_expires_at, created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_job_queue_batch_lock ON job_queue(workspace_id, batch_id, status, lease_expires_at);

CREATE TABLE IF NOT EXISTS run_events (
  sequence BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  run_id TEXT,
  type TEXT NOT NULL,
  stage TEXT,
  message TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (workspace_id, batch_id) REFERENCES batches(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_events_replay ON run_events(workspace_id, batch_id, sequence);

CREATE TABLE IF NOT EXISTS run_control_commands (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  command TEXT NOT NULL,
  reason TEXT,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT,
  FOREIGN KEY (workspace_id, batch_id) REFERENCES batches(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_control_active_stop ON run_control_commands(workspace_id, batch_id)
  WHERE command = 'stop_requested' AND resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  label TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  visibility_class TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  size BIGINT NOT NULL,
  version INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (workspace_id, batch_id, filename, content_sha256),
  FOREIGN KEY (workspace_id, batch_id) REFERENCES batches(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_artifacts_public ON artifacts(workspace_id, batch_id, filename)
  WHERE visibility_class LIKE 'public_%';
CREATE INDEX IF NOT EXISTS idx_artifacts_hidden ON artifacts(workspace_id, batch_id, visibility_class)
  WHERE visibility_class IN ('technical_hidden', 'engine_secret');

CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  object_key TEXT NOT NULL,
  visibility_class TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE IF NOT EXISTS artifact_lineage (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  target_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_bodies (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  content_text TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS ad_analysis (
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  index_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, batch_id),
  FOREIGN KEY (workspace_id, batch_id) REFERENCES batches(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  batch_id TEXT,
  role TEXT NOT NULL,
  public_safe BOOLEAN NOT NULL DEFAULT TRUE,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_batch ON agent_messages(workspace_id, batch_id, created_at);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  batch_id TEXT,
  tool_name TEXT NOT NULL,
  arguments_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  public_safe BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_batch ON agent_tool_calls(workspace_id, batch_id, created_at);

CREATE TABLE IF NOT EXISTS batch_memory_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (workspace_id, batch_id) REFERENCES batches(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_batch_memory_latest ON batch_memory_snapshots(workspace_id, batch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_workspace ON audit_events(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS artifact_access_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  actor_user_id TEXT,
  allowed BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifact_access_logs_artifact ON artifact_access_logs(workspace_id, artifact_id, created_at DESC);
