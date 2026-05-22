ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS source_run_id TEXT,
  ADD COLUMN IF NOT EXISTS source_run_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS source_run_cancelled BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_artifacts_source_run
  ON artifacts(workspace_id, batch_id, source_run_id);

CREATE INDEX IF NOT EXISTS idx_artifacts_cancelled_origin
  ON artifacts(workspace_id, batch_id, source_run_cancelled)
  WHERE source_run_cancelled = true;
