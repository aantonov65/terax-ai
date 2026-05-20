ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_workflow_type_check;

ALTER TABLE runs
  ADD CONSTRAINT runs_workflow_type_check
  CHECK (workflow_type IN (
    'lfs_ads',
    'research',
    'strategy',
    'image_batch',
    'modular_video',
    'avatar_video',
    'lp_rip',
    'meta_upload',
    'handoff_export'
  ));
