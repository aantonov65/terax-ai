CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'dev';
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_subject TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS desktop_client_version TEXT;
ALTER TABLE users ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
UPDATE users SET auth_subject = id WHERE auth_subject IS NULL;
ALTER TABLE users ALTER COLUMN auth_subject SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_subject ON users(auth_provider, auth_subject);
CREATE INDEX IF NOT EXISTS idx_users_workspace_role ON users(workspace_id, role, status);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger_run_id TEXT UNIQUE,
  correlation_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  product_id TEXT,
  batch_id TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  current_stage TEXT,
  total_cost_usd NUMERIC NOT NULL DEFAULT 0,
  desktop_client_version TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_category TEXT,
  failure_message_safe TEXT,
  canary_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'quarantined')),
  CHECK (workflow_type IN ('lfs_ads', 'research', 'image_batch', 'modular_video', 'avatar_video', 'lp_rip', 'meta_upload', 'handoff_export'))
);

CREATE INDEX IF NOT EXISTS idx_runs_workspace_status ON runs(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_user_created ON runs(created_by_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_product ON runs(workspace_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_batch ON runs(workspace_id, batch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_stages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_name TEXT NOT NULL,
  provider TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  error_category TEXT,
  error_code TEXT,
  error_message_safe TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'retrying'))
);

CREATE INDEX IF NOT EXISTS idx_run_stages_run ON run_stages(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_stages_stage_status ON run_stages(stage_name, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_stages_running ON run_stages(status, started_at) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS ai_calls (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id TEXT REFERENCES run_stages(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_template_id TEXT,
  prompt_version TEXT,
  prompt_hash TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  status TEXT NOT NULL,
  error_code TEXT,
  error_category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_ai_calls_run ON ai_calls(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_calls_provider ON ai_calls(provider, model, created_at DESC);

CREATE TABLE IF NOT EXISTS media_compute_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id TEXT REFERENCES run_stages(id) ON DELETE SET NULL,
  tool TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_count INTEGER NOT NULL DEFAULT 0,
  output_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  file_duration_seconds NUMERIC,
  output_size_bytes BIGINT,
  status TEXT NOT NULL,
  error_code TEXT,
  error_category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_media_compute_run ON media_compute_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_media_compute_tool ON media_compute_events(tool, operation, created_at DESC);

CREATE TABLE IF NOT EXISTS run_artifacts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id TEXT,
  batch_id TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  workflow_type TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  status TEXT NOT NULL,
  size_bytes BIGINT,
  storage_ref_id TEXT,
  public_export_allowed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('created', 'uploaded', 'failed', 'quarantined', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_run_artifacts_run ON run_artifacts(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_workspace ON run_artifacts(workspace_id, workflow_type, artifact_type, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_run_events (
  sequence BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id TEXT REFERENCES run_stages(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  message_safe TEXT NOT NULL,
  metadata_safe JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_events_replay ON workflow_run_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_workflow_run_events_type ON workflow_run_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS observability_alerts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  stage_id TEXT REFERENCES run_stages(id) ON DELETE SET NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  message_safe TEXT,
  metadata_safe JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  CHECK (status IN ('open', 'acknowledged', 'resolved', 'ignored'))
);

CREATE INDEX IF NOT EXISTS idx_observability_alerts_status ON observability_alerts(status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observability_alerts_run ON observability_alerts(run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_audit_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  metadata_safe JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_audit_events_workspace ON workflow_audit_events(workspace_id, created_at DESC);
