use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const ENGINE_ROOT: &str = "/Users/aantonov1/boris/ww-2";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WwxWorkspace {
    id: String,
    name: String,
    root_path: String,
    visibility: String,
    scope_label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WwxArtifact {
    id: String,
    batch_id: String,
    product_id: String,
    kind: String,
    label: String,
    filename: String,
    mime_type: String,
    size: i64,
    source: String,
    public: bool,
    created_at: i64,
    updated_at: i64,
    revision: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WwxRun {
    id: String,
    batch_id: String,
    status: String,
    current_stage: Option<String>,
    started_at: i64,
    finished_at: Option<i64>,
    error: Option<String>,
    updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WwxQueuedJob {
    id: String,
    product_id: String,
    batch_id: String,
    status: String,
    attempts: i64,
    requested_at: i64,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    updated_at: i64,
    last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WwxStageSummary {
    stage: String,
    status: String,
    approved: bool,
    artifact_count: i64,
    label: String,
    summary: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WwxFinalScript {
    task_id: String,
    script: String,
    decision: String,
    semantic_reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WwxBatch {
    id: String,
    product_id: String,
    product_code: String,
    name: String,
    batch_id: String,
    status: String,
    current_stage: Option<String>,
    created_at: i64,
    updated_at: i64,
    revision: i64,
    artifacts: Vec<WwxArtifact>,
    runs: Vec<WwxRun>,
    decision_counts: DecisionCounts,
    stage_timeline: Vec<WwxStageSummary>,
    final_scripts: Vec<WwxFinalScript>,
    autonomous: bool,
    workflow_state: WwxWorkflowState,
}

#[derive(Debug, Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DecisionCounts {
    ship: i64,
    review: i64,
    fail: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WwxWorkflowAction {
    kind: String,
    label: String,
    prompt: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WwxWorkflowState {
    status: String,
    status_label: String,
    stage: Option<String>,
    stage_label: Option<String>,
    headline: String,
    summary: String,
    tone: String,
    operator_needed: bool,
    retryable: bool,
    failure_kind: Option<String>,
    reason: Option<String>,
    primary_action: Option<WwxWorkflowAction>,
    secondary_action: Option<WwxWorkflowAction>,
    important_artifact_ids: Vec<String>,
    diagnostic_artifact_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WwxProduct {
    id: String,
    product_code: String,
    name: String,
    config_json: String,
    created_at: i64,
    updated_at: i64,
    revision: i64,
    research_artifact_count: i64,
    research_artifact_updated_at: Option<i64>,
    batches: Vec<WwxBatch>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WwxIndex {
    workspace: WwxWorkspace,
    products: Vec<WwxProduct>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WwxArtifactContent {
    artifact: WwxArtifact,
    content_text: Option<String>,
    content_blob: Option<Vec<u8>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WwxProductPackage {
    product_id: String,
    product_code: String,
    name: String,
    config_json: String,
    artifacts: Vec<WwxArtifactContent>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WwxJobResult {
    ok: bool,
    workflow: String,
    batch_id: String,
    product_id: String,
    run_id: String,
    status: String,
    current_stage: Option<String>,
    awaiting_review: bool,
    retryable: bool,
    reason: Option<String>,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    artifacts: Vec<WwxArtifact>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProductInput {
    product_folder: Option<String>,
    config: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBatchInput {
    product_id: String,
    batch_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBundleDocumentInput {
    label: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateProductPackageInput {
    product_code: String,
    batch_id: Option<String>,
    documents: Vec<SourceBundleDocumentInput>,
    batch_request: Option<Value>,
    anthropic_api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResearchPipelineInput {
    product_id: String,
    topic: String,
    anthropic_api_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResearchPipelineResult {
    ok: bool,
    product_id: String,
    product_code: String,
    run_folder: String,
    artifacts: Vec<WwxArtifact>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildStrategyInput {
    product_id: String,
    batch_id: String,
    strategy_plan_json: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildStrategyResult {
    ok: bool,
    product_id: String,
    batch_id: String,
    strategy_json: String,
    artifacts: Vec<WwxArtifact>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateStrategyResult {
    ok: bool,
    product_id: String,
    batch_id: String,
    strategy_json: Option<String>,
    error: Option<String>,
    artifacts: Vec<WwxArtifact>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedProductPackage {
    product_code: String,
    batch_id: String,
    config_json: String,
    archetypes: String,
    hotwords: String,
    mechanisms: String,
    source_angle: String,
    angles: String,
    strategy_json: String,
    operator_input_json: String,
    readiness_assessment_json: String,
    concept_matrix_json: String,
    report_json: String,
    source_bundle_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteArtifactInput {
    product_id: String,
    batch_id: String,
    kind: String,
    label: String,
    filename: String,
    mime_type: Option<String>,
    content_text: Option<String>,
    content_blob: Option<Vec<u8>>,
    source: Option<String>,
    public: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LfsJobInput {
    product_id: String,
    batch_id: String,
    angles_markdown: Option<String>,
    run_mode: Option<String>,
    workers: Option<i64>,
    generation_workers: Option<i64>,
    from_stage: Option<String>,
    anthropic_api_key: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn id(prefix: &str) -> String {
    format!("{prefix}-{:x}-{:x}", now_ms(), randish())
}

fn randish() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
        ^ std::process::id() as u64
}

fn safe_segment(value: &str) -> String {
    let mut out = String::new();
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "untitled".into()
    } else {
        trimmed
    }
}

fn product_code_from_config(config: &Value, fallback: &str) -> String {
    config
        .get("product_code")
        .or_else(|| config.get("product"))
        .or_else(|| config.get("code"))
        .and_then(Value::as_str)
        .map(safe_segment)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| safe_segment(fallback).to_uppercase())
}

fn product_name_from_config(config: &Value, fallback: &str) -> String {
    config
        .get("product_name")
        .or_else(|| config.get("name"))
        .or_else(|| config.get("brand"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("wwx.sqlite3"))
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          product_code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          config_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          deleted_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS batches (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          current_stage TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          deleted_at INTEGER,
          UNIQUE(product_id, batch_id)
        );
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          label TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          content_text TEXT,
          content_blob BLOB,
          size INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL,
          public INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          deleted_at INTEGER,
          UNIQUE(batch_id, filename)
        );
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          batch_id TEXT NOT NULL,
          status TEXT NOT NULL,
          current_stage TEXT,
          runner_pid INTEGER,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          error TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS run_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          stage TEXT,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          payload_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS job_queue (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          requested_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          updated_at INTEGER NOT NULL,
          last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_batches_product ON batches(product_id, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_artifacts_batch ON artifacts(batch_id, public, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_runs_batch ON runs(batch_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status, requested_at);
        "#,
    )
    .map_err(|e| e.to_string())
}

fn artifact_kind(filename: &str) -> String {
    if filename == "angles.md" || filename == "source-angle.md" {
        "angles".into()
    } else if filename == "strategy.json" {
        "strategy".into()
    } else if filename.contains("manifest") {
        "manifest".into()
    } else if filename.ends_with(".json") || filename.ends_with(".jsonl") {
        "json".into()
    } else if filename.ends_with(".md") {
        "markdown".into()
    } else if filename.ends_with(".png")
        || filename.ends_with(".jpg")
        || filename.ends_with(".jpeg")
        || filename.ends_with(".webp")
    {
        "image".into()
    } else {
        "other".into()
    }
}

fn mime_type(filename: &str) -> String {
    if filename.ends_with(".json") {
        "application/json".into()
    } else if filename.ends_with(".jsonl") {
        "application/x-ndjson".into()
    } else if filename.ends_with(".md") {
        "text/markdown".into()
    } else if filename.ends_with(".png") {
        "image/png".into()
    } else if filename.ends_with(".jpg") || filename.ends_with(".jpeg") {
        "image/jpeg".into()
    } else if filename.ends_with(".webp") {
        "image/webp".into()
    } else {
        "text/plain".into()
    }
}

fn upsert_artifact(
    conn: &Connection,
    product_id: &str,
    batch_id: &str,
    filename: &str,
    label: &str,
    content: &[u8],
    source: &str,
    public: bool,
) -> Result<WwxArtifact, String> {
    upsert_artifact_with_metadata(
        conn, product_id, batch_id, filename, label, content, source, public, None, None,
    )
}

#[allow(clippy::too_many_arguments)]
fn upsert_artifact_with_metadata(
    conn: &Connection,
    product_id: &str,
    batch_id: &str,
    filename: &str,
    label: &str,
    content: &[u8],
    source: &str,
    public: bool,
    kind_override: Option<&str>,
    mime_override: Option<&str>,
) -> Result<WwxArtifact, String> {
    let now = now_ms();
    let text = std::str::from_utf8(content).ok().map(|s| s.to_string());
    let blob: Option<Vec<u8>> = if text.is_some() {
        None
    } else {
        Some(content.to_vec())
    };
    let kind = kind_override
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| artifact_kind(filename));
    let mime = mime_override
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| mime_type(filename));
    let size = content.len() as i64;
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM artifacts WHERE batch_id = ?1 AND filename = ?2",
            params![batch_id, filename],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let artifact_id = existing.unwrap_or_else(|| id("art"));
    conn.execute(
        r#"
        INSERT INTO artifacts
          (id, product_id, batch_id, kind, label, filename, mime_type, content_text, content_blob, size, source, public, created_at, updated_at, revision)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, 1)
        ON CONFLICT(batch_id, filename) DO UPDATE SET
          kind=excluded.kind,
          label=excluded.label,
          mime_type=excluded.mime_type,
          content_text=excluded.content_text,
          content_blob=excluded.content_blob,
          size=excluded.size,
          source=excluded.source,
          public=excluded.public,
          updated_at=excluded.updated_at,
          revision=artifacts.revision + 1,
          deleted_at=NULL
        "#,
        params![
            artifact_id,
            product_id,
            batch_id,
            kind,
            label,
            filename,
            mime,
            text,
            blob,
            size,
            source,
            if public { 1 } else { 0 },
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    load_artifact(conn, &artifact_id)
}

fn load_artifact(conn: &Connection, artifact_id: &str) -> Result<WwxArtifact, String> {
    conn.query_row(
        r#"
        SELECT id, batch_id, product_id, kind, label, filename, mime_type, size, source, public, created_at, updated_at, revision
        FROM artifacts WHERE id = ?1 AND deleted_at IS NULL
        "#,
        params![artifact_id],
        |row| {
            Ok(WwxArtifact {
                id: row.get(0)?,
                batch_id: row.get(1)?,
                product_id: row.get(2)?,
                kind: row.get(3)?,
                label: row.get(4)?,
                filename: row.get(5)?,
                mime_type: row.get(6)?,
                size: row.get(7)?,
                source: row.get(8)?,
                public: row.get::<_, i64>(9)? != 0,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
                revision: row.get(12)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

fn list_artifacts_for_batch(conn: &Connection, batch_id: &str) -> Result<Vec<WwxArtifact>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, batch_id, product_id, kind, label, filename, mime_type, size, source, public, created_at, updated_at, revision
            FROM artifacts
            WHERE batch_id = ?1 AND deleted_at IS NULL AND public = 1
            ORDER BY updated_at DESC, filename ASC
            "#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![batch_id], |row| {
            Ok(WwxArtifact {
                id: row.get(0)?,
                batch_id: row.get(1)?,
                product_id: row.get(2)?,
                kind: row.get(3)?,
                label: row.get(4)?,
                filename: row.get(5)?,
                mime_type: row.get(6)?,
                size: row.get(7)?,
                source: row.get(8)?,
                public: row.get::<_, i64>(9)? != 0,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
                revision: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn list_runs_for_batch(conn: &Connection, batch_id: &str) -> Result<Vec<WwxRun>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, batch_id, status, current_stage, started_at, finished_at, error, updated_at FROM runs WHERE batch_id = ?1 ORDER BY updated_at DESC LIMIT 8",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![batch_id], |row| {
            Ok(WwxRun {
                id: row.get(0)?,
                batch_id: row.get(1)?,
                status: row.get(2)?,
                current_stage: row.get(3)?,
                started_at: row.get(4)?,
                finished_at: row.get(5)?,
                error: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn load_queue_job(conn: &Connection, queue_id: &str) -> Result<WwxQueuedJob, String> {
    conn.query_row(
        "SELECT id, product_id, batch_id, status, attempts, requested_at, started_at, finished_at, updated_at, last_error FROM job_queue WHERE id = ?1",
        params![queue_id],
        |row| {
            Ok(WwxQueuedJob {
                id: row.get(0)?,
                product_id: row.get(1)?,
                batch_id: row.get(2)?,
                status: row.get(3)?,
                attempts: row.get(4)?,
                requested_at: row.get(5)?,
                started_at: row.get(6)?,
                finished_at: row.get(7)?,
                updated_at: row.get(8)?,
                last_error: row.get(9)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

fn list_queue_jobs(conn: &Connection) -> Result<Vec<WwxQueuedJob>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, product_id, batch_id, status, attempts, requested_at, started_at, finished_at, updated_at, last_error FROM job_queue ORDER BY requested_at DESC LIMIT 200",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(WwxQueuedJob {
                id: row.get(0)?,
                product_id: row.get(1)?,
                batch_id: row.get(2)?,
                status: row.get(3)?,
                attempts: row.get(4)?,
                requested_at: row.get(5)?,
                started_at: row.get(6)?,
                finished_at: row.get(7)?,
                updated_at: row.get(8)?,
                last_error: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn max_active_queue_jobs() -> Option<i64> {
    std::env::var("WWX_MAX_ACTIVE_QUEUE_JOBS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
}

fn kick_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let claim = {
                let conn = match open_db(&app) {
                    Ok(conn) => conn,
                    Err(_) => return,
                };
                match claim_next_queue_job(&conn) {
                    Ok(job) => job,
                    Err(_) => return,
                }
            };
            let Some((queue_id, input)) = claim else {
                return;
            };
            let app_for_job = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let result = start_lfs_job(app_for_job.clone(), input);
                if let Ok(conn) = open_db(&app_for_job) {
                    let now = now_ms();
                    match result {
                        Ok(job_result) => {
                            let status = if job_result.ok { "complete" } else { "blocked" };
                            let error = if job_result.ok {
                                None
                            } else {
                                job_result.reason
                            };
                            let _ = conn.execute(
                                "UPDATE job_queue SET status = ?2, finished_at = ?3, updated_at = ?3, last_error = ?4 WHERE id = ?1",
                                params![queue_id, status, now, error],
                            );
                        }
                        Err(error) => {
                            let _ = conn.execute(
                                "UPDATE job_queue SET status = 'blocked', finished_at = ?2, updated_at = ?2, last_error = ?3 WHERE id = ?1",
                                params![queue_id, now, error],
                            );
                        }
                    }
                }
                kick_scheduler(app_for_job);
            });
        }
    });
}

fn claim_next_queue_job(conn: &Connection) -> Result<Option<(String, LfsJobInput)>, String> {
    let active: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM job_queue WHERE status = 'running'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if max_active_queue_jobs().is_some_and(|limit| active >= limit) {
        return Ok(None);
    }
    let next: Option<(String, String)> = conn
        .query_row(
            "SELECT id, payload_json FROM job_queue WHERE status = 'queued' ORDER BY requested_at ASC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((queue_id, payload)) = next else {
        return Ok(None);
    };
    let input = serde_json::from_str::<LfsJobInput>(&payload).map_err(|e| e.to_string())?;
    let now = now_ms();
    let changed = conn
        .execute(
            "UPDATE job_queue SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?2), updated_at = ?2 WHERE id = ?1 AND status = 'queued'",
            params![queue_id, now],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Ok(None);
    }
    Ok(Some((queue_id, input)))
}

fn manifest_decision_counts(conn: &Connection, batch_id: &str) -> Result<DecisionCounts, String> {
    let text: Option<String> = conn
        .query_row(
            "SELECT content_text FROM artifacts WHERE batch_id = ?1 AND filename = 'lfs-v41-manifest.json' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
            params![batch_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let Some(text) = text else {
        return Ok(DecisionCounts::default());
    };
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let counts = parsed.get("decision_counts").unwrap_or(&Value::Null);
    Ok(DecisionCounts {
        ship: counts
            .get("ship")
            .and_then(Value::as_i64)
            .or_else(|| parsed.get("ship").and_then(Value::as_i64))
            .unwrap_or(0),
        review: counts
            .get("review")
            .and_then(Value::as_i64)
            .or_else(|| parsed.get("review").and_then(Value::as_i64))
            .unwrap_or(0),
        fail: counts
            .get("fail")
            .and_then(Value::as_i64)
            .or_else(|| parsed.get("fail").and_then(Value::as_i64))
            .unwrap_or(0),
    })
}

fn stage_label(stage: &str) -> String {
    match stage {
        "compile_input" => "Preparing batch",
        "research_cards" => "Checking research",
        "lfs_brief" => "Building briefs",
        "lfs_outline" => "Writing outlines",
        "preflight_v41" => "Checking readiness",
        "batch_generation" => "Generating scripts",
        "materialize_v41_candidates" => "Preparing candidates",
        "objective_finish_pre_semantic" => "Checking structure",
        "semantic_launchable" => "Checking launchability",
        "objective_finish_final" => "Final structure check",
        "semantic_final_check" => "Final quality check",
        "manifest_overview" => "Preparing final ads",
        "strategy_plan" => "Creative direction",
        "strategy" => "Strategy",
        "resume" => "Continuing batch",
        value => return value.replace('_', " ").replace('-', " "),
    }
    .into()
}

fn stage_summary(stage: &str) -> String {
    match stage {
        "compile_input" => "The batch input is being normalized.",
        "research_cards" => "Product research is being checked before ad work starts.",
        "lfs_brief" => "The system is turning direction into briefs for the batch.",
        "lfs_outline" => "The system is shaping the ad outlines.",
        "preflight_v41" => "The batch is being checked before script generation.",
        "batch_generation" => "Scripts are being generated.",
        "materialize_v41_candidates" => "Generated scripts are being prepared for review.",
        "objective_finish_pre_semantic" => "Scripts are being checked for structure and required pieces.",
        "semantic_launchable" => "Scripts are being checked for launchability.",
        "objective_finish_final" => "The final script set is being checked.",
        "semantic_final_check" => "The final script set is getting a last quality pass.",
        "manifest_overview" => "The final ad decisions are being prepared.",
        _ => "The workflow is ready for the next step.",
    }
    .into()
}

fn artifact_is_important(filename: &str) -> bool {
    let clean = filename.trim_start_matches('/');
    clean.starts_with("output-v41/")
        || clean.starts_with("output/")
        || matches!(
            clean,
            "strategy-plan.json"
                | "strategy-plan-validation.json"
                | "strategy.json"
                | "lfs-v41-manifest.json"
                | "lfs-v41-report.json"
                | "source-angle.md"
                | "angles.md"
        )
}

fn workflow_action(kind: &str, label: &str, prompt: Option<&str>) -> WwxWorkflowAction {
    WwxWorkflowAction {
        kind: kind.into(),
        label: label.into(),
        prompt: prompt.map(str::to_string),
    }
}

fn latest_repair_failure(conn: &Connection, batch_id: &str) -> Result<Option<Value>, String> {
    let text: Option<String> = conn
        .query_row(
            "SELECT content_text FROM artifacts WHERE batch_id = ?1 AND filename = 'repair-history.json' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
            params![batch_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let Some(text) = text else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok(parsed
        .get("failures")
        .and_then(Value::as_array)
        .and_then(|items| items.last())
        .cloned())
}

fn batch_workflow_state(
    conn: &Connection,
    batch: &WwxBatch,
) -> Result<WwxWorkflowState, String> {
    let stage = batch.current_stage.clone();
    let stage_label_value = stage.as_deref().map(stage_label);
    let important_artifact_ids = batch
        .artifacts
        .iter()
        .filter(|artifact| artifact_is_important(&artifact.filename))
        .map(|artifact| artifact.id.clone())
        .collect::<Vec<_>>();
    let diagnostic_artifact_ids = batch
        .artifacts
        .iter()
        .filter(|artifact| !artifact_is_important(&artifact.filename))
        .map(|artifact| artifact.id.clone())
        .collect::<Vec<_>>();
    let has_strategy_plan = batch
        .artifacts
        .iter()
        .any(|artifact| artifact.filename == "strategy-plan.json");
    let has_strategy = batch
        .artifacts
        .iter()
        .any(|artifact| artifact.filename == "strategy.json");
    let has_final = !batch.final_scripts.is_empty()
        || batch
            .artifacts
            .iter()
            .any(|artifact| artifact.filename.starts_with("output-v41/"));
    let failure = latest_repair_failure(conn, &batch.id)?;
    let failure_kind = failure
        .as_ref()
        .and_then(|item| item.get("kind"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let reason = failure
        .as_ref()
        .and_then(|item| item.get("reason"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let failure_operator_needed = failure
        .as_ref()
        .and_then(|item| item.get("operator_needed"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let status_label = match batch.status.as_str() {
        "review" => "needs review",
        "blocked" => "blocked",
        "complete" => "complete",
        "running" => "running",
        "ready" => "ready",
        "draft" => "draft",
        _ => "unknown",
    }
    .to_string();
    let mut state = WwxWorkflowState {
        status: batch.status.clone(),
        status_label,
        stage: stage.clone(),
        stage_label: stage_label_value.clone(),
        headline: "Creative direction needed".into(),
        summary: "Add the ARC, A/B, mechanism, format, count, and any swipes or notes.".into(),
        tone: "neutral".into(),
        operator_needed: false,
        retryable: false,
        failure_kind,
        reason,
        primary_action: Some(workflow_action(
            "add_direction",
            "Add creative direction",
            Some("Help me structure creative direction for this batch."),
        )),
        secondary_action: None,
        important_artifact_ids,
        diagnostic_artifact_ids,
    };

    if batch.status == "complete" || has_final {
        state.headline = "Final ads are ready".into();
        state.summary = "Review the ship, review, and fail decisions before upload.".into();
        state.tone = "success".into();
        state.primary_action = Some(workflow_action(
            "review_final",
            "Review final ads",
            Some("Show me the final ads and call out what is ship-ready versus needs review."),
        ));
        state.secondary_action = Some(workflow_action(
            "export",
            "Export ship-ready ads",
            Some("Export the ship-ready scripts for handoff."),
        ));
        return Ok(state);
    }

    if batch.status == "review" {
        let label = stage_label_value.unwrap_or_else(|| "Checkpoint".into());
        state.headline = format!("{label} is ready. Continue to next stage?");
        state.summary = "Skim the checkpoint, then continue when it looks right.".into();
        state.tone = "warning".into();
        state.primary_action = Some(workflow_action(
            "continue",
            "Continue to next stage",
            Some("Continue to the next LFS stage for this batch."),
        ));
        state.secondary_action = Some(workflow_action(
            "open_agent",
            "Ask / Hold",
            Some("I want to ask a question before continuing this batch."),
        ));
        return Ok(state);
    }

    if batch.status == "blocked" {
        let system_repairable = !failure_operator_needed && failure.is_some();
        state.headline = if system_repairable {
            "Repair is available".into()
        } else {
            "Batch needs operator input".into()
        };
        state.summary = state
            .reason
            .clone()
            .unwrap_or_else(|| "Open the Creative Strategist to see the exact blocker.".into());
        state.tone = "danger".into();
        state.operator_needed = !system_repairable;
        state.retryable = system_repairable;
        state.primary_action = Some(if system_repairable {
            workflow_action(
                "repair",
                "Repair and continue",
                Some("Repair the current batch issue and continue from the earliest safe stage."),
            )
        } else {
            workflow_action(
                "provide_input",
                "Provide missing input",
                Some("Tell me exactly what input is missing for this batch."),
            )
        });
        state.secondary_action = Some(workflow_action(
            "open_agent",
            "Open agent",
            Some("Open this batch in the Creative Strategist agent."),
        ));
        return Ok(state);
    }

    if batch.status == "running" {
        let label = stage_label_value.unwrap_or_else(|| "Workflow".into());
        state.headline = format!("{label} is running");
        state.summary = stage.as_deref().map(stage_summary).unwrap_or_else(|| "The workflow is running.".into());
        state.tone = "running".into();
        state.primary_action = Some(workflow_action("wait", "Running", None));
        return Ok(state);
    }

    if has_strategy {
        state.headline = "Strategy is ready".into();
        state.summary = "Run the LFS batch when you are ready for generation.".into();
        state.primary_action = Some(workflow_action("run_batch", "Run Batch", None));
        return Ok(state);
    }
    if has_strategy_plan {
        state.headline = "Creative direction is saved".into();
        state.summary = "Build the strategy before running the LFS batch.".into();
        state.primary_action = Some(workflow_action("build_strategy", "Build Strategy", None));
    }
    Ok(state)
}

fn empty_workflow_state(status: &str, current_stage: Option<String>) -> WwxWorkflowState {
    let stage_label_value = current_stage.as_deref().map(stage_label);
    WwxWorkflowState {
        status: status.into(),
        status_label: status.into(),
        stage: current_stage,
        stage_label: stage_label_value,
        headline: "Creative direction needed".into(),
        summary: "Add the ARC, A/B, mechanism, format, count, and any swipes or notes.".into(),
        tone: "neutral".into(),
        operator_needed: false,
        retryable: false,
        failure_kind: None,
        reason: None,
        primary_action: Some(workflow_action(
            "add_direction",
            "Add creative direction",
            Some("Help me structure creative direction for this batch."),
        )),
        secondary_action: None,
        important_artifact_ids: vec![],
        diagnostic_artifact_ids: vec![],
    }
}

fn agent_stage_timeline(conn: &Connection, batch_id: &str) -> Result<Vec<WwxStageSummary>, String> {
    let text: Option<String> = conn
        .query_row(
            "SELECT content_text FROM artifacts WHERE batch_id = ?1 AND filename = 'agent-run.json' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
            params![batch_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let Some(text) = text else {
        return Ok(vec![]);
    };
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let stages = parsed.get("stages").and_then(Value::as_object);
    let order = [
        "compile_input",
        "research_cards",
        "lfs_brief",
        "lfs_outline",
        "preflight_v41",
        "batch_generation",
        "materialize_v41_candidates",
        "objective_finish_pre_semantic",
        "semantic_launchable",
        "objective_finish_final",
        "semantic_final_check",
        "manifest_overview",
    ];
    Ok(order
        .iter()
        .filter_map(|stage| {
            let entry = stages?.get(*stage)?;
            Some(WwxStageSummary {
                stage: (*stage).into(),
                status: entry
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending")
                    .into(),
                approved: entry
                    .get("approved")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                artifact_count: entry
                    .get("artifacts")
                    .and_then(Value::as_array)
                    .map(|items| items.len() as i64)
                    .unwrap_or(0),
                label: entry
                    .get("public_ui")
                    .and_then(|ui| ui.get("stage_label"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| stage_label(stage)),
                summary: entry
                    .get("public_ui")
                    .and_then(|ui| ui.get("summary"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| stage_summary(stage)),
            })
        })
        .collect())
}

fn manifest_final_scripts(
    conn: &Connection,
    batch_id: &str,
) -> Result<Vec<WwxFinalScript>, String> {
    let text: Option<String> = conn
        .query_row(
            "SELECT content_text FROM artifacts WHERE batch_id = ?1 AND filename = 'lfs-v41-manifest.json' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
            params![batch_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let Some(text) = text else {
        return Ok(vec![]);
    };
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok(parsed
        .get("scripts")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(WwxFinalScript {
                        task_id: item.get("task_id")?.as_str()?.into(),
                        script: item.get("script")?.as_str()?.into(),
                        decision: item.get("decision")?.as_str()?.into(),
                        semantic_reason: item
                            .get("semantic_reason")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

fn batch_autonomous(conn: &Connection, batch_id: &str) -> Result<bool, String> {
    let text: Option<String> = conn
        .query_row(
            "SELECT content_text FROM artifacts WHERE batch_id = ?1 AND filename = 'batch-control.json' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
            params![batch_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    Ok(text
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .and_then(|value| value.get("autonomous").and_then(Value::as_bool))
        .unwrap_or(false))
}

#[tauri::command]
pub fn wwx_list_products(app: AppHandle) -> Result<WwxIndex, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              p.id,
              p.product_code,
              p.name,
              p.config_json,
              p.created_at,
              p.updated_at,
              p.revision,
              (
                SELECT COUNT(*)
                FROM artifacts a
                WHERE a.product_id = p.id
                  AND a.batch_id = p.id
                  AND a.deleted_at IS NULL
                  AND (a.filename LIKE 'research/%' OR a.filename LIKE 'research-runs/%')
              ) AS research_artifact_count,
              (
                SELECT MAX(a.updated_at)
                FROM artifacts a
                WHERE a.product_id = p.id
                  AND a.batch_id = p.id
                  AND a.deleted_at IS NULL
                  AND (a.filename LIKE 'research/%' OR a.filename LIKE 'research-runs/%')
              ) AS research_artifact_updated_at
            FROM products p
            WHERE p.deleted_at IS NULL
            ORDER BY p.updated_at DESC
            "#,
        )
        .map_err(|e| e.to_string())?;
    let products_iter = stmt
        .query_map([], |row| {
            Ok(WwxProduct {
                id: row.get(0)?,
                product_code: row.get(1)?,
                name: row.get(2)?,
                config_json: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                revision: row.get(6)?,
                research_artifact_count: row.get(7)?,
                research_artifact_updated_at: row.get(8)?,
                batches: vec![],
            })
        })
        .map_err(|e| e.to_string())?;

    let mut products = products_iter
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for product in &mut products {
        product.batches = list_batches_for_product(&conn, &product.id, &product.product_code)?;
    }
    Ok(WwxIndex {
        workspace: WwxWorkspace {
            id: "app".into(),
            name: "WWX App Storage".into(),
            root_path: "app://wwx".into(),
            visibility: "account".into(),
            scope_label: "App storage".into(),
        },
        products,
    })
}

fn list_batches_for_product(
    conn: &Connection,
    product_id: &str,
    product_code: &str,
) -> Result<Vec<WwxBatch>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, product_id, name, batch_id, status, current_stage, created_at, updated_at, revision FROM batches WHERE product_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![product_id], |row| {
            Ok(WwxBatch {
                id: row.get(0)?,
                product_id: row.get(1)?,
                product_code: product_code.to_string(),
                name: row.get(2)?,
                batch_id: row.get(3)?,
                status: row.get(4)?,
                current_stage: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                revision: row.get(8)?,
                artifacts: vec![],
                runs: vec![],
                decision_counts: DecisionCounts::default(),
                stage_timeline: vec![],
                final_scripts: vec![],
                autonomous: false,
                workflow_state: empty_workflow_state(
                    &row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ),
            })
        })
        .map_err(|e| e.to_string())?;
    let mut batches = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for batch in &mut batches {
        batch.artifacts = list_artifacts_for_batch(conn, &batch.id)?;
        batch.runs = list_runs_for_batch(conn, &batch.id)?;
        batch.decision_counts = manifest_decision_counts(conn, &batch.id)?;
        batch.stage_timeline = agent_stage_timeline(conn, &batch.id)?;
        batch.final_scripts = manifest_final_scripts(conn, &batch.id)?;
        batch.autonomous = batch_autonomous(conn, &batch.id)?;
        batch.workflow_state = batch_workflow_state(conn, batch)?;
    }
    Ok(batches)
}

#[tauri::command]
pub fn wwx_list_batches(app: AppHandle, product_id: String) -> Result<Vec<WwxBatch>, String> {
    let conn = open_db(&app)?;
    let product_code: String = conn
        .query_row(
            "SELECT product_code FROM products WHERE id = ?1 AND deleted_at IS NULL",
            params![product_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    list_batches_for_product(&conn, &product_id, &product_code)
}

#[tauri::command]
pub fn wwx_read_product_package(
    app: AppHandle,
    product_id: String,
    include_content: Option<bool>,
) -> Result<WwxProductPackage, String> {
    let conn = open_db(&app)?;
    let include_content = include_content.unwrap_or(false);
    let (product_code, name, config_json): (String, String, String) = conn
        .query_row(
            "SELECT product_code, name, config_json FROM products WHERE id = ?1 AND deleted_at IS NULL",
            params![product_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, batch_id, product_id, kind, label, filename, mime_type, size, source, public, created_at, updated_at, revision, content_text, content_blob
            FROM artifacts
            WHERE batch_id = ?1
              AND deleted_at IS NULL
              AND (
                filename IN ('source-bundle.json', 'product-readiness.json')
                OR filename LIKE 'research/%'
                OR filename LIKE 'research-runs/%'
                OR filename LIKE 'package/%'
              )
            ORDER BY filename ASC
            "#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![product_id], |row| {
            Ok(WwxArtifactContent {
                artifact: WwxArtifact {
                    id: row.get(0)?,
                    batch_id: row.get(1)?,
                    product_id: row.get(2)?,
                    kind: row.get(3)?,
                    label: row.get(4)?,
                    filename: row.get(5)?,
                    mime_type: row.get(6)?,
                    size: row.get(7)?,
                    source: row.get(8)?,
                    public: row.get::<_, i64>(9)? != 0,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    revision: row.get(12)?,
                },
                content_text: if include_content { row.get(13)? } else { None },
                content_blob: if include_content { row.get(14)? } else { None },
            })
        })
        .map_err(|e| e.to_string())?;
    let artifacts = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(WwxProductPackage {
        product_id,
        product_code,
        name,
        config_json,
        artifacts,
    })
}

#[tauri::command]
pub fn wwx_create_product(app: AppHandle, input: CreateProductInput) -> Result<WwxProduct, String> {
    let conn = open_db(&app)?;
    let folder = input
        .product_folder
        .as_deref()
        .map(safe_segment)
        .unwrap_or_else(|| "product".into());
    let product_code = product_code_from_config(&input.config, &folder);
    let name = product_name_from_config(&input.config, &product_code);
    let config_json = serde_json::to_string_pretty(&input.config).map_err(|e| e.to_string())?;
    let product_id = format!("prod_{}", product_code);
    let now = now_ms();
    conn.execute(
        r#"
        INSERT INTO products (id, product_code, name, config_json, created_at, updated_at, revision)
        VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1)
        ON CONFLICT(product_code) DO UPDATE SET
          name=excluded.name,
          config_json=excluded.config_json,
          updated_at=excluded.updated_at,
          revision=products.revision + 1,
          deleted_at=NULL
        "#,
        params![product_id, product_code, name, config_json, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(WwxProduct {
        id: product_id,
        product_code,
        name,
        config_json,
        created_at: now,
        updated_at: now,
        revision: 1,
        research_artifact_count: 0,
        research_artifact_updated_at: None,
        batches: vec![],
    })
}

#[tauri::command]
pub fn wwx_update_product(
    app: AppHandle,
    product_id: String,
    config: Value,
) -> Result<WwxProduct, String> {
    let conn = open_db(&app)?;
    let product_code = product_code_from_config(&config, &product_id);
    let name = product_name_from_config(&config, &product_code);
    let config_json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    let now = now_ms();
    conn.execute(
        "UPDATE products SET product_code = ?2, name = ?3, config_json = ?4, updated_at = ?5, revision = revision + 1 WHERE id = ?1 AND deleted_at IS NULL",
        params![product_id, product_code, name, config_json, now],
    )
    .map_err(|e| e.to_string())?;
    let products = wwx_list_products(app)?.products;
    let updated = products
        .into_iter()
        .find(|p| p.id == product_id)
        .ok_or_else(|| "product not found after update".to_string())?;
    Ok(updated)
}

#[tauri::command]
pub fn wwx_create_batch(app: AppHandle, input: CreateBatchInput) -> Result<WwxBatch, String> {
    let conn = open_db(&app)?;
    let product_code: String = conn
        .query_row(
            "SELECT product_code FROM products WHERE id = ?1 AND deleted_at IS NULL",
            params![input.product_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let batch_id = safe_segment(&input.batch_name);
    let batch_pk = format!("batch_{}_{}", product_code, batch_id);
    let now = now_ms();
    conn.execute(
        r#"
        INSERT INTO batches (id, product_id, batch_id, name, status, created_at, updated_at, revision)
        VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?5, 1)
        ON CONFLICT(product_id, batch_id) DO UPDATE SET
          name=excluded.name,
          updated_at=excluded.updated_at,
          revision=batches.revision + 1,
          deleted_at=NULL
        "#,
        params![batch_pk, input.product_id, batch_id, input.batch_name.trim(), now],
    )
    .map_err(|e| e.to_string())?;
    Ok(WwxBatch {
        id: batch_pk,
        product_id: input.product_id,
        product_code,
        name: input.batch_name,
        batch_id,
        status: "draft".into(),
        current_stage: None,
        created_at: now,
        updated_at: now,
        revision: 1,
        artifacts: vec![],
        runs: vec![],
        decision_counts: DecisionCounts::default(),
        stage_timeline: vec![],
        final_scripts: vec![],
        autonomous: false,
        workflow_state: empty_workflow_state("draft", None),
    })
}

#[tauri::command]
pub fn wwx_list_artifacts(app: AppHandle, batch_id: String) -> Result<Vec<WwxArtifact>, String> {
    let conn = open_db(&app)?;
    list_artifacts_for_batch(&conn, &batch_id)
}

#[tauri::command]
pub fn wwx_read_artifact(
    app: AppHandle,
    artifact_id: String,
) -> Result<WwxArtifactContent, String> {
    let conn = open_db(&app)?;
    let artifact = load_artifact(&conn, &artifact_id)?;
    let (text, blob): (Option<String>, Option<Vec<u8>>) = conn
        .query_row(
            "SELECT content_text, content_blob FROM artifacts WHERE id = ?1 AND deleted_at IS NULL",
            params![artifact_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(WwxArtifactContent {
        artifact,
        content_text: text,
        content_blob: blob,
    })
}

#[tauri::command]
pub fn wwx_write_artifact(
    app: AppHandle,
    input: WriteArtifactInput,
) -> Result<WwxArtifact, String> {
    let conn = open_db(&app)?;
    let content = input
        .content_text
        .as_ref()
        .map(|s| s.as_bytes().to_vec())
        .or(input.content_blob)
        .unwrap_or_default();
    upsert_artifact_with_metadata(
        &conn,
        &input.product_id,
        &input.batch_id,
        &input.filename,
        &input.label,
        &content,
        input.source.as_deref().unwrap_or("user"),
        input.public.unwrap_or(true),
        Some(input.kind.as_str()),
        input.mime_type.as_deref(),
    )
}

#[tauri::command]
pub async fn wwx_generate_product_package(
    app: AppHandle,
    input: GenerateProductPackageInput,
) -> Result<GeneratedProductPackage, String> {
    tauri::async_runtime::spawn_blocking(move || generate_product_package(app, input))
        .await
        .map_err(|e| e.to_string())?
}

fn generate_product_package(
    app: AppHandle,
    input: GenerateProductPackageInput,
) -> Result<GeneratedProductPackage, String> {
    if input.documents.is_empty() {
        return Err("Add at least one raw source document before generating a package.".into());
    }
    let product_code = safe_segment(&input.product_code).to_uppercase();
    if product_code.is_empty() {
        return Err("product_code is required".into());
    }
    let batch_id = input
        .batch_id
        .as_deref()
        .map(safe_segment)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{product_code}_LFS_BOOTSTRAP"));
    let root = runner_root(&runner_cache_root(&app)?, &id("package"))?;
    let bundle_path = root.join("source-bundle.json");
    let bundle = serde_json::json!({
        "schema": "wwx-source-bundle/v1",
        "documents": input.documents.iter().map(|doc| serde_json::json!({
            "label": doc.label,
            "content": doc.content,
        })).collect::<Vec<_>>(),
        "batch_request": input.batch_request.unwrap_or_else(|| serde_json::json!({})),
    });
    fs::write(
        &bundle_path,
        serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let script = Path::new(ENGINE_ROOT)
        .join("tools")
        .join("product_package.py");
    let python = Path::new(ENGINE_ROOT)
        .join(".venv")
        .join("bin")
        .join("python");
    let python_bin = if python.exists() {
        python
    } else {
        PathBuf::from("python3")
    };
    let mut cmd = Command::new(python_bin);
    cmd.current_dir(ENGINE_ROOT)
        .arg(script)
        .arg(&bundle_path)
        .arg("--product")
        .arg(&product_code)
        .arg("--batch-id")
        .arg(&batch_id)
        .arg("--base-path")
        .arg(&root);
    if let Some(key) = input
        .anthropic_api_key
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        cmd.env("ANTHROPIC_API_KEY", key);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let _ = fs::remove_dir_all(&root);
        return Err(format!(
            "product package generation failed: {}{}",
            stderr.trim(),
            if stdout.trim().is_empty() {
                "".into()
            } else {
                format!("\n{}", stdout.trim())
            }
        ));
    }
    let product_root = root.join("products").join(&product_code);
    let batch_root = product_root.join("batches").join(&batch_id);
    let result = GeneratedProductPackage {
        product_code,
        batch_id,
        config_json: read_required_text(&product_root.join("config.json"))?,
        archetypes: read_required_text(&product_root.join("research").join("archetypes.md"))?,
        hotwords: read_required_text(&product_root.join("research").join("hotwords.md"))?,
        mechanisms: read_required_text(&product_root.join("research").join("mechanisms.md"))?,
        source_angle: read_required_text(&batch_root.join("source-angle.md"))?,
        angles: read_required_text(&batch_root.join("angles.md"))?,
        strategy_json: read_required_text(&batch_root.join("strategy.json"))?,
        operator_input_json: read_required_text(&batch_root.join("operator-input.json"))?,
        readiness_assessment_json: read_required_text(
            &batch_root.join("readiness-assessment.json"),
        )?,
        concept_matrix_json: read_required_text(&batch_root.join("concept-matrix.json"))?,
        report_json: read_required_text(&batch_root.join("product-package-report.json"))?,
        source_bundle_json: read_required_text(&batch_root.join("source-bundle.json"))?,
    };
    let _ = fs::remove_dir_all(&root);
    Ok(result)
}

#[tauri::command]
pub async fn wwx_run_research_pipeline(
    app: AppHandle,
    input: RunResearchPipelineInput,
) -> Result<RunResearchPipelineResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_research_pipeline(app, input))
        .await
        .map_err(|e| e.to_string())?
}

fn run_research_pipeline(
    app: AppHandle,
    input: RunResearchPipelineInput,
) -> Result<RunResearchPipelineResult, String> {
    let conn = open_db(&app)?;
    let (product_code, config_json): (String, String) = conn
        .query_row(
            "SELECT product_code, config_json FROM products WHERE id = ?1 AND deleted_at IS NULL",
            params![input.product_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    if input.topic.trim().is_empty() {
        return Err("research topic is required".into());
    }

    let root = runner_root(&runner_cache_root(&app)?, &id("research"))?;
    let product_dir = root.join("products").join(&product_code);
    fs::create_dir_all(product_dir.join("research")).map_err(|e| e.to_string())?;
    fs::write(product_dir.join("config.json"), config_json).map_err(|e| e.to_string())?;

    run_ww(
        &[
            "research".into(),
            product_code.clone(),
            "--topic".into(),
            input.topic.trim().into(),
            "--base-path".into(),
            root.to_string_lossy().into_owned(),
        ],
        input.anthropic_api_key.as_deref(),
    )?;

    let research_root = product_dir.join("research");
    let latest_run = fs::read_dir(&research_root)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("ww-research-"))
        })
        .max_by_key(|path| fs::metadata(path).and_then(|meta| meta.modified()).ok());
    let run_dir = latest_run.ok_or_else(|| "research run folder was not created".to_string())?;

    run_ww(
        &[
            "research".into(),
            "synthesize".into(),
            product_code.clone(),
            "--from".into(),
            run_dir.to_string_lossy().into_owned(),
            "--base-path".into(),
            root.to_string_lossy().into_owned(),
        ],
        input.anthropic_api_key.as_deref(),
    )?;
    run_ww(
        &[
            "research-cards".into(),
            product_code.clone(),
            "--force".into(),
            "--base-path".into(),
            root.to_string_lossy().into_owned(),
        ],
        input.anthropic_api_key.as_deref(),
    )?;
    run_ww(
        &[
            "research-cards".into(),
            product_code.clone(),
            "--verify".into(),
            "--base-path".into(),
            root.to_string_lossy().into_owned(),
        ],
        input.anthropic_api_key.as_deref(),
    )?;

    let mut artifacts = vec![];
    for name in [
        "archetypes.md",
        "hotwords.md",
        "mechanisms.md",
        "cards-report.json",
    ] {
        let path = research_root.join(name);
        if path.is_file() {
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            artifacts.push(upsert_artifact(
                &conn,
                &input.product_id,
                &input.product_id,
                &format!("research/{name}"),
                name,
                &bytes,
                "research",
                false,
            )?);
        }
    }
    for name in [
        "README.md",
        "queries.json",
        "filtered_threads.json",
        "filtered-corpus.md",
        "opus-analysis.md",
        "opus-usage.txt",
        "summary.json",
    ] {
        let path = run_dir.join(name);
        if path.is_file() {
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            artifacts.push(upsert_artifact(
                &conn,
                &input.product_id,
                &input.product_id,
                &format!(
                    "research-runs/{}/{}",
                    run_dir
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("latest"),
                    name
                ),
                name,
                &bytes,
                "research",
                false,
            )?);
        }
    }

    let now = now_ms();
    let mut config: Value = serde_json::from_str(
        &conn
            .query_row(
                "SELECT config_json FROM products WHERE id = ?1",
                params![input.product_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if let Some(obj) = config.as_object_mut() {
        obj.insert(
            "wwx_readiness".into(),
            serde_json::json!({
                "status": "production_ready",
                "approved": true,
                "gaps": [],
            }),
        );
    }
    conn.execute(
        "UPDATE products SET config_json = ?2, updated_at = ?3, revision = revision + 1 WHERE id = ?1",
        params![input.product_id, serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?, now],
    )
    .map_err(|e| e.to_string())?;

    let run_folder = run_dir.to_string_lossy().into_owned();
    let _ = fs::remove_dir_all(&root);
    Ok(RunResearchPipelineResult {
        ok: true,
        product_id: input.product_id,
        product_code,
        run_folder,
        artifacts,
    })
}

#[tauri::command]
pub async fn wwx_build_strategy(
    app: AppHandle,
    input: BuildStrategyInput,
) -> Result<BuildStrategyResult, String> {
    tauri::async_runtime::spawn_blocking(move || build_strategy(app, input))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn wwx_validate_strategy_plan(
    app: AppHandle,
    input: BuildStrategyInput,
) -> Result<ValidateStrategyResult, String> {
    tauri::async_runtime::spawn_blocking(move || validate_strategy_plan(app, input))
        .await
        .map_err(|e| e.to_string())?
}

fn validate_strategy_plan(
    app: AppHandle,
    input: BuildStrategyInput,
) -> Result<ValidateStrategyResult, String> {
    let conn = open_db(&app)?;
    let run_id = id("strategy-validate");
    let (root, product_code, batch_id, batch_dir) = materialize_runner(
        &runner_cache_root(&app)?,
        &conn,
        &run_id,
        &input.product_id,
        &input.batch_id,
    )?;
    let plan_path = batch_dir.join("strategy-plan.json");
    fs::write(&plan_path, &input.strategy_plan_json).map_err(|e| e.to_string())?;
    run_ww(
        &[
            "research-cards".into(),
            product_code.clone(),
            "--force".into(),
            "--base-path".into(),
            root.to_string_lossy().into_owned(),
        ],
        None,
    )?;
    run_ww(
        &[
            "research-cards".into(),
            product_code.clone(),
            "--verify".into(),
            "--base-path".into(),
            root.to_string_lossy().into_owned(),
        ],
        None,
    )?;

    let output = Command::new(Path::new(ENGINE_ROOT).join("tools").join("ww"))
        .current_dir(ENGINE_ROOT)
        .env("WW_BASE_PATH", &root)
        .arg("strategy")
        .arg("build")
        .arg("--product")
        .arg(&product_code)
        .arg("--batch-id")
        .arg(&batch_id)
        .arg("--plan")
        .arg(&plan_path)
        .arg("--dry-run")
        .arg("--base-path")
        .arg(&root)
        .output()
        .map_err(|e| e.to_string())?;
    let ok = output.status.success();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let error = (!ok).then_some(if stderr.is_empty() {
        stdout.clone()
    } else {
        stderr.clone()
    });
    let validation_json = serde_json::to_string_pretty(&serde_json::json!({
        "ok": ok,
        "error": error,
    }))
    .map_err(|e| e.to_string())?;
    let artifact = upsert_artifact(
        &conn,
        &input.product_id,
        &input.batch_id,
        "strategy-plan-validation.json",
        "strategy-plan-validation.json",
        validation_json.as_bytes(),
        "strategy-validate",
        true,
    )?;
    conn.execute(
        "UPDATE batches SET status = ?2, current_stage = 'strategy_plan', updated_at = ?3, revision = revision + 1 WHERE id = ?1",
        params![input.batch_id, if ok { "draft" } else { "review" }, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&root);
    Ok(ValidateStrategyResult {
        ok,
        product_id: input.product_id,
        batch_id: input.batch_id,
        strategy_json: ok.then_some(stdout),
        error,
        artifacts: vec![artifact],
    })
}

fn build_strategy(
    app: AppHandle,
    input: BuildStrategyInput,
) -> Result<BuildStrategyResult, String> {
    let conn = open_db(&app)?;
    let run_id = id("strategy");
    let (root, product_code, batch_id, batch_dir) = materialize_runner(
        &runner_cache_root(&app)?,
        &conn,
        &run_id,
        &input.product_id,
        &input.batch_id,
    )?;
    let plan_path = batch_dir.join("strategy-plan.json");
    fs::write(&plan_path, &input.strategy_plan_json).map_err(|e| e.to_string())?;
    run_ww(
        &[
            "research-cards".into(),
            product_code.clone(),
            "--force".into(),
            "--base-path".into(),
            root.to_string_lossy().into_owned(),
        ],
        None,
    )?;
    run_ww(
        &[
            "research-cards".into(),
            product_code.clone(),
            "--verify".into(),
            "--base-path".into(),
            root.to_string_lossy().into_owned(),
        ],
        None,
    )?;
    run_ww(
        &[
            "strategy".into(),
            "build".into(),
            "--product".into(),
            product_code,
            "--batch-id".into(),
            batch_id,
            "--plan".into(),
            plan_path.to_string_lossy().into_owned(),
            "--force".into(),
            "--base-path".into(),
            root.to_string_lossy().into_owned(),
        ],
        None,
    )?;
    let strategy_path = batch_dir.join("strategy.json");
    let strategy_json = read_required_text(&strategy_path)?;
    let artifacts = vec![
        upsert_artifact(
            &conn,
            &input.product_id,
            &input.batch_id,
            "strategy-plan.json",
            "strategy-plan.json",
            input.strategy_plan_json.as_bytes(),
            "strategy-build",
            true,
        )?,
        upsert_artifact(
            &conn,
            &input.product_id,
            &input.batch_id,
            "strategy.json",
            "strategy.json",
            strategy_json.as_bytes(),
            "strategy-build",
            true,
        )?,
    ];
    conn.execute(
        "UPDATE batches SET status = 'ready', current_stage = 'strategy', updated_at = ?2, revision = revision + 1 WHERE id = ?1",
        params![input.batch_id, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&root);
    Ok(BuildStrategyResult {
        ok: true,
        product_id: input.product_id,
        batch_id: input.batch_id,
        strategy_json,
        artifacts,
    })
}

fn run_ww(args: &[String], anthropic_api_key: Option<&str>) -> Result<(), String> {
    let script = Path::new(ENGINE_ROOT).join("tools").join("ww");
    let mut cmd = Command::new(script);
    cmd.current_dir(ENGINE_ROOT);
    if let Some(base_path) = args
        .windows(2)
        .find_map(|pair| (pair[0] == "--base-path").then(|| pair[1].clone()))
    {
        cmd.env("WW_BASE_PATH", base_path);
    }
    for arg in args {
        cmd.arg(arg);
    }
    if let Some(key) = anthropic_api_key.filter(|value| !value.is_empty()) {
        cmd.env("ANTHROPIC_API_KEY", key);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "ww command failed: {}{}",
        String::from_utf8_lossy(&output.stderr).trim(),
        if output.stdout.is_empty() {
            String::new()
        } else {
            format!("\n{}", String::from_utf8_lossy(&output.stdout).trim())
        }
    ))
}

fn read_required_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("failed to read {}: {e}", path.display()))
}

#[tauri::command]
pub async fn wwx_start_lfs_job(app: AppHandle, input: LfsJobInput) -> Result<WwxJobResult, String> {
    tauri::async_runtime::spawn_blocking(move || start_lfs_job(app, input))
        .await
        .map_err(|e| e.to_string())?
}

fn start_lfs_job(app: AppHandle, input: LfsJobInput) -> Result<WwxJobResult, String> {
    let conn = open_db(&app)?;
    let cache_root = runner_cache_root(&app)?;
    start_lfs_job_with_context(&conn, &cache_root, input)
}

fn start_lfs_job_with_context(
    conn: &Connection,
    cache_root: &Path,
    input: LfsJobInput,
) -> Result<WwxJobResult, String> {
    if let Some(markdown) = input
        .angles_markdown
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        reset_batch_for_new_submission(conn, &input.batch_id)?;
        upsert_artifact(
            conn,
            &input.product_id,
            &input.batch_id,
            "source-angle.md",
            "Source Angle",
            markdown.as_bytes(),
            "upload",
            true,
        )?;
        upsert_artifact(
            conn,
            &input.product_id,
            &input.batch_id,
            "angles.md",
            "Angles",
            markdown.as_bytes(),
            "upload",
            true,
        )?;
    }
    run_lfs_with_context(conn, cache_root, input, "submit_lfs_job", false)
}

fn reset_batch_for_new_submission(conn: &Connection, batch_id: &str) -> Result<(), String> {
    let now = now_ms();
    conn.execute(
        "UPDATE artifacts
         SET deleted_at = ?2, updated_at = ?2
         WHERE batch_id = ?1
           AND deleted_at IS NULL
           AND filename NOT IN (
             'source-angle.md',
             'angles.md',
             'strategy-plan.json',
             'strategy-plan-validation.json',
             'strategy.json',
             'batch-control.json',
             'operator-input.json',
             'readiness-assessment.json',
             'concept-matrix.json',
             'concept-matrix-approval.json',
             'product-package-report.json'
           )",
        params![batch_id, now],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE batches SET status = 'draft', current_stage = NULL, updated_at = ?2, revision = revision + 1 WHERE id = ?1",
        params![batch_id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn wwx_advance_lfs_job(
    app: AppHandle,
    input: LfsJobInput,
) -> Result<WwxJobResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_lfs(app, input, "advance_lfs_job", true))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn wwx_resume_lfs_job(
    app: AppHandle,
    input: LfsJobInput,
) -> Result<WwxJobResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_lfs(app, input, "resume_lfs_job", true))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn wwx_enqueue_lfs_job(
    app: AppHandle,
    input: LfsJobInput,
) -> Result<WwxQueuedJob, String> {
    let queued = {
        let conn = open_db(&app)?;
        let now = now_ms();
        let queue_id = id("queue");
        let payload = serde_json::to_string(&input).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO job_queue (id, product_id, batch_id, payload_json, status, requested_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?5)",
            params![queue_id, input.product_id, input.batch_id, payload, now],
        )
        .map_err(|e| e.to_string())?;
        load_queue_job(&conn, &queue_id)?
    };
    kick_scheduler(app);
    Ok(queued)
}

#[tauri::command]
pub fn wwx_list_lfs_queue(app: AppHandle) -> Result<Vec<WwxQueuedJob>, String> {
    let conn = open_db(&app)?;
    list_queue_jobs(&conn)
}

#[tauri::command]
pub fn wwx_cancel_lfs_job(
    app: AppHandle,
    batch_id: String,
    reason: Option<String>,
) -> Result<WwxRun, String> {
    let conn = open_db(&app)?;
    let now = now_ms();
    let run_id = id("run");
    conn.execute(
        "INSERT INTO runs (id, batch_id, status, current_stage, started_at, finished_at, error, updated_at) VALUES (?1, ?2, 'canceled', 'canceled', ?3, ?3, ?4, ?3)",
        params![run_id, batch_id, now, reason],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE batches SET status = 'blocked', current_stage = 'canceled', updated_at = ?2, revision = revision + 1 WHERE id = ?1",
        params![batch_id, now],
    )
    .map_err(|e| e.to_string())?;
    list_runs_for_batch(&conn, &batch_id)?
        .into_iter()
        .find(|r| r.id == run_id)
        .ok_or_else(|| "run not found after cancel".into())
}

fn runner_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map_err(|e| e.to_string())
        .map(|dir| dir.join("wwx-runner"))
}

fn runner_root(cache_root: &Path, run_id: &str) -> Result<PathBuf, String> {
    let dir = cache_root.join(run_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn static_link(src: &Path, dst: &Path) -> Result<(), String> {
    if dst.exists() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, dst).map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    {
        copy_dir(src, dst)
    }
}

#[cfg(not(unix))]
fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn ensure_research_ready(product_dir: &Path) -> Result<(), String> {
    let research = product_dir.join("research");
    let missing = ["archetypes.md", "hotwords.md", "mechanisms.md"]
        .iter()
        .filter(|name| {
            let path = research.join(name);
            !path.is_file()
                || fs::metadata(&path)
                    .map(|meta| meta.len() == 0)
                    .unwrap_or(true)
        })
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        Err(format!(
            "Product research is missing in app storage: {}. Add or import product research before advancing LFS.",
            missing.join(", ")
        ))
    } else {
        let config = fs::read_to_string(product_dir.join("config.json")).unwrap_or_default();
        let parsed: Value = serde_json::from_str(&config).unwrap_or(Value::Null);
        let readiness = parsed.get("wwx_readiness").unwrap_or(&Value::Null);
        let status = readiness.get("status").and_then(Value::as_str);
        if let Some(status) = status.filter(|status| *status != "production_ready") {
            let gaps = readiness
                .get("gaps")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("; ")
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "product package has not been approved for production".into());
            return Err(format!(
                "Product package is not production-ready ({status}): {gaps}"
            ));
        }
        for name in research_filenames() {
            let text =
                fs::read_to_string(product_dir.join("research").join(name)).unwrap_or_default();
            if text.contains("Starter ") || text.contains("Auto-generated from product details") {
                return Err(format!(
                    "Product package is not production-ready: research/{name} is still starter-only"
                ));
            }
        }
        Ok(())
    }
}

fn research_filenames() -> [&'static str; 3] {
    ["archetypes.md", "hotwords.md", "mechanisms.md"]
}

fn materialize_product_research(
    conn: &Connection,
    product_id: &str,
    product_code: &str,
    config_json: &str,
    product_dir: &Path,
) -> Result<(), String> {
    let research_dir = product_dir.join("research");
    fs::create_dir_all(&research_dir).map_err(|e| e.to_string())?;
    copy_app_research(conn, product_id, &research_dir)?;
    if missing_research_files(&research_dir).is_empty() {
        return Ok(());
    }

    if let Some(source) = find_legacy_product_research(product_code, config_json) {
        for name in research_filenames() {
            let src = source.join("research").join(name);
            if !src.is_file() {
                continue;
            }
            let bytes = fs::read(&src).map_err(|e| e.to_string())?;
            upsert_artifact(
                conn,
                product_id,
                product_id,
                &format!("research/{name}"),
                name,
                &bytes,
                "product-research-import",
                false,
            )?;
        }
        copy_app_research(conn, product_id, &research_dir)?;
    }
    Ok(())
}

fn copy_app_research(
    conn: &Connection,
    product_id: &str,
    research_dir: &Path,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT filename, content_text, content_blob FROM artifacts WHERE product_id = ?1 AND batch_id = ?1 AND filename LIKE 'research/%' AND deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![product_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<Vec<u8>>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (filename, text, blob) = row.map_err(|e| e.to_string())?;
        let Some(name) = filename.strip_prefix("research/") else {
            continue;
        };
        if !research_filenames().contains(&name) {
            continue;
        }
        let target = research_dir.join(name);
        if let Some(text) = text {
            fs::write(target, text).map_err(|e| e.to_string())?;
        } else if let Some(blob) = blob {
            fs::write(target, blob).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn missing_research_files(research_dir: &Path) -> Vec<&'static str> {
    research_filenames()
        .iter()
        .filter(|name| {
            let path = research_dir.join(name);
            !path.is_file()
                || fs::metadata(&path)
                    .map(|meta| meta.len() == 0)
                    .unwrap_or(true)
        })
        .copied()
        .collect()
}

fn find_legacy_product_research(product_code: &str, config_json: &str) -> Option<PathBuf> {
    let products = Path::new(ENGINE_ROOT).join("products");
    let mut best: Option<(i32, PathBuf)> = None;
    for entry in fs::read_dir(products).ok()? {
        let entry = entry.ok()?;
        let dir = entry.path();
        if !dir.is_dir() || !missing_research_files(&dir.join("research")).is_empty() {
            continue;
        }
        let score = legacy_product_score(product_code, config_json, &dir);
        if score <= 0 {
            continue;
        }
        if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
            best = Some((score, dir));
        }
    }
    best.map(|(_, dir)| dir)
}

fn legacy_product_score(product_code: &str, config_json: &str, dir: &Path) -> i32 {
    let folder = dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_lowercase();
    let code = product_code.to_lowercase();
    let app = config_json.to_lowercase();
    let legacy_config = fs::read_to_string(dir.join("config.json"))
        .unwrap_or_default()
        .to_lowercase();
    let mut score = 0;
    if folder == code {
        score += 100;
    } else if folder.starts_with(&code) || code.starts_with(&folder) {
        score += 30;
    }
    if !code.is_empty() && legacy_config.contains(&format!("\"product_code\": \"{code}\"")) {
        score += 70;
    }
    for token in ["joint", "joints", "jnt", "walk", "knee", "arthritis"] {
        if app.contains(token) && (folder.contains(token) || legacy_config.contains(token)) {
            score += 25;
        }
    }
    for token in ["thyro", "thyroid", "hormone", "levothyroxine"] {
        if app.contains(token) && (folder.contains(token) || legacy_config.contains(token)) {
            score += 25;
        }
    }
    for token in ["naturalrems", "sea moss", "nrjoints"] {
        if app.contains(token) && legacy_config.contains(token) {
            score += 10;
        }
    }
    score
}

fn materialize_runner(
    cache_root: &Path,
    conn: &Connection,
    run_id: &str,
    product_id: &str,
    batch_pk: &str,
) -> Result<(PathBuf, String, String, PathBuf), String> {
    let root = runner_root(cache_root, run_id)?;
    let (product_code, config_json): (String, String) = conn
        .query_row(
            "SELECT product_code, config_json FROM products WHERE id = ?1 AND deleted_at IS NULL",
            params![product_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let batch_id: String = conn
        .query_row(
            "SELECT batch_id FROM batches WHERE id = ?1 AND deleted_at IS NULL",
            params![batch_pk],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    for name in ["components", "formats"] {
        static_link(&Path::new(ENGINE_ROOT).join(name), &root.join(name))?;
    }
    let product_dir = root.join("products").join(&product_code);
    let batch_dir = product_dir.join("batches").join(&batch_id);
    fs::create_dir_all(&batch_dir).map_err(|e| e.to_string())?;
    fs::write(product_dir.join("config.json"), &config_json).map_err(|e| e.to_string())?;
    materialize_product_research(conn, product_id, &product_code, &config_json, &product_dir)?;

    let mut stmt = conn
        .prepare("SELECT filename, content_text, content_blob FROM artifacts WHERE batch_id = ?1 AND deleted_at IS NULL")
        .map_err(|e| e.to_string())?;
    let artifacts = stmt
        .query_map(params![batch_pk], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<Vec<u8>>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for artifact in artifacts {
        let (filename, text, blob) = artifact.map_err(|e| e.to_string())?;
        let clean = filename.trim_start_matches('/');
        let target = batch_dir.join(clean);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if let Some(text) = text {
            fs::write(target, text).map_err(|e| e.to_string())?;
        } else if let Some(blob) = blob {
            fs::write(target, blob).map_err(|e| e.to_string())?;
        }
    }
    Ok((root, product_code, batch_id, batch_dir))
}

fn ingest_runner(
    conn: &Connection,
    product_id: &str,
    batch_pk: &str,
    batch_dir: &Path,
) -> Result<Vec<WwxArtifact>, String> {
    let mut ingested = vec![];
    let root_files = [
        "source-angle.md",
        "angles.md",
        "strategy-plan.json",
        "strategy-plan-validation.json",
        "strategy.json",
        "batch-control.json",
        "operator-input.json",
        "readiness-assessment.json",
        "concept-matrix.json",
        "concept-matrix-approval.json",
        "spec.json",
        "agent-run.json",
        "agent-events.jsonl",
        "wwx-artifacts.json",
        "lfs-brief-report.json",
        "lfs-outline-report.json",
        "lfs-v41-report.json",
        "lfs-v41-manifest.json",
        "lfs-v41-finish-report.json",
        "lfs-semantic-report.json",
        "report.json",
    ];
    for name in root_files {
        let path = batch_dir.join(name);
        if path.is_file() {
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            ingested.push(upsert_artifact(
                conn,
                product_id,
                batch_pk,
                name,
                name,
                &bytes,
                "runner",
                is_public_root_artifact(name),
            )?);
        }
    }
    for (dir, public) in [
        ("prompts", false),
        ("outlines", false),
        ("output-v41", true),
        ("output", true),
        ("images", true),
    ] {
        let out = batch_dir.join(dir);
        if !out.exists() {
            continue;
        }
        ingest_dir(
            conn,
            product_id,
            batch_pk,
            batch_dir,
            &out,
            public,
            &mut ingested,
        )?;
    }
    Ok(ingested)
}

fn is_public_root_artifact(name: &str) -> bool {
    matches!(
        name,
        "source-angle.md"
            | "angles.md"
            | "strategy-plan.json"
            | "strategy-plan-validation.json"
            | "strategy.json"
            | "batch-control.json"
            | "operator-input.json"
            | "readiness-assessment.json"
            | "concept-matrix.json"
            | "concept-matrix-approval.json"
            | "lfs-brief-report.json"
            | "lfs-outline-report.json"
            | "lfs-v41-report.json"
            | "lfs-v41-manifest.json"
            | "lfs-v41-finish-report.json"
            | "lfs-semantic-report.json"
            | "report.json"
    )
}

fn ingest_dir(
    conn: &Connection,
    product_id: &str,
    batch_pk: &str,
    batch_dir: &Path,
    dir: &Path,
    public: bool,
    out: &mut Vec<WwxArtifact>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            ingest_dir(conn, product_id, batch_pk, batch_dir, &path, public, out)?;
            continue;
        }
        let rel = path.strip_prefix(batch_dir).map_err(|e| e.to_string())?;
        let filename = rel.to_string_lossy().replace('\\', "/");
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        out.push(upsert_artifact(
            conn, product_id, batch_pk, &filename, &filename, &bytes, "runner", public,
        )?);
    }
    Ok(())
}

fn run_lfs(
    app: AppHandle,
    input: LfsJobInput,
    workflow: &str,
    resume: bool,
) -> Result<WwxJobResult, String> {
    let conn = open_db(&app)?;
    let cache_root = runner_cache_root(&app)?;
    run_lfs_with_context(&conn, &cache_root, input, workflow, resume)
}

fn run_lfs_with_context(
    conn: &Connection,
    cache_root: &Path,
    input: LfsJobInput,
    workflow: &str,
    resume: bool,
) -> Result<WwxJobResult, String> {
    let run_id = id("run");
    let now = now_ms();
    conn.execute(
        "INSERT INTO runs (id, batch_id, status, current_stage, started_at, updated_at) VALUES (?1, ?2, 'running', ?3, ?4, ?4)",
        params![run_id, input.batch_id, if resume { "resume" } else { "compile_input" }, now],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE batches SET status = 'running', current_stage = ?2, updated_at = ?3, revision = revision + 1 WHERE id = ?1",
        params![input.batch_id, if resume { "resume" } else { "compile_input" }, now],
    )
    .map_err(|e| e.to_string())?;

    let (root, product_code, batch_id, batch_dir) = materialize_runner(
        cache_root,
        conn,
        &run_id,
        &input.product_id,
        &input.batch_id,
    )?;
    {
        let product_dir = root.join("products").join(&product_code);
        if let Err(reason) = ensure_research_ready(&product_dir) {
            let finished = now_ms();
            let final_stage = Some("research_cards".to_string());
            conn.execute(
                "UPDATE runs SET status = 'blocked', current_stage = ?2, finished_at = ?3, error = ?4, updated_at = ?3 WHERE id = ?1",
                params![run_id, final_stage, finished, reason],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE batches SET status = 'blocked', current_stage = ?2, updated_at = ?3, revision = revision + 1 WHERE id = ?1",
                params![input.batch_id, final_stage, finished],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO run_events (id, run_id, batch_id, stage, level, message, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, 'error', ?5, ?6, ?7)",
                params![
                    id("evt"),
                    run_id,
                    input.batch_id,
                    final_stage,
                    workflow,
                    serde_json::json!({"stderr": reason, "stdout": ""}).to_string(),
                    finished
                ],
            )
            .map_err(|e| e.to_string())?;
            let artifacts = list_artifacts_for_batch(conn, &input.batch_id).unwrap_or_default();
            let _ = fs::remove_dir_all(&root);
            return Ok(WwxJobResult {
                ok: false,
                workflow: workflow.into(),
                batch_id: input.batch_id,
                product_id: input.product_id,
                run_id,
                status: "blocked".into(),
                current_stage: final_stage,
                awaiting_review: false,
                retryable: false,
                reason: Some(reason.clone()),
                stdout: "".into(),
                stderr: reason,
                exit_code: None,
                artifacts,
            });
        }
    }
    let input_angles = batch_dir.join("angles.md");
    let input_strategy = batch_dir.join("strategy.json");
    let script = Path::new(ENGINE_ROOT).join("tools").join("lfs_agent.py");
    let python = Path::new(ENGINE_ROOT)
        .join(".venv")
        .join("bin")
        .join("python");
    let python_bin = if python.exists() {
        python
    } else {
        PathBuf::from("python3")
    };
    let mut cmd = Command::new(python_bin);
    cmd.current_dir(ENGINE_ROOT);
    cmd.arg(script);
    if resume {
        cmd.arg("--resume").arg(&batch_id);
    } else if input_strategy.exists() && !input_angles.exists() {
        cmd.arg(&input_strategy);
    } else {
        cmd.arg(&input_angles);
    }
    if input.run_mode.as_deref() == Some("full") {
        cmd.arg("--yolo");
    } else {
        cmd.arg("--app-step");
    }
    if let Some(workers) = input.workers {
        cmd.arg("--workers").arg(workers.to_string());
    }
    if let Some(workers) = input.generation_workers {
        cmd.arg("--generation-workers").arg(workers.to_string());
    }
    if let Some(stage) = input
        .from_stage
        .as_deref()
        .filter(|stage| !stage.is_empty())
    {
        cmd.arg("--from").arg(stage);
    }
    cmd.arg("--base-path").arg(&root);
    if let Some(key) = input.anthropic_api_key.as_deref().filter(|s| !s.is_empty()) {
        cmd.env("ANTHROPIC_API_KEY", key);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code();
    let artifacts =
        ingest_runner(conn, &input.product_id, &input.batch_id, &batch_dir).unwrap_or_default();
    let final_stage = parse_current_stage(&stdout).or_else(|| parse_agent_stage(&batch_dir));
    let status = if output.status.success() {
        parse_status(&stdout).unwrap_or_else(|| "awaiting_review".into())
    } else {
        "blocked".into()
    };
    let finished = now_ms();
    conn.execute(
        "UPDATE runs SET status = ?2, current_stage = ?3, finished_at = ?4, error = ?5, updated_at = ?4 WHERE id = ?1",
        params![run_id, status, final_stage, finished, if output.status.success() { None::<String> } else { Some(stderr.clone()) }],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE batches SET status = ?2, current_stage = ?3, updated_at = ?4, revision = revision + 1 WHERE id = ?1",
        params![input.batch_id, batch_status(&status), final_stage, finished],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO run_events (id, run_id, batch_id, stage, level, message, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id("evt"), run_id, input.batch_id, final_stage, if output.status.success() { "info" } else { "error" }, workflow, serde_json::json!({"stdout": stdout, "stderr": stderr}).to_string(), finished],
    )
    .map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&root);
    Ok(WwxJobResult {
        ok: output.status.success(),
        workflow: workflow.into(),
        batch_id: input.batch_id,
        product_id: input.product_id,
        run_id,
        status: status.clone(),
        current_stage: final_stage,
        awaiting_review: status == "awaiting_review" || status == "held",
        retryable: !output.status.success() || status == "blocked",
        reason: if output.status.success() {
            None
        } else {
            Some(stderr.clone())
        },
        stdout,
        stderr,
        exit_code,
        artifacts,
    })
}

fn batch_status(status: &str) -> String {
    match status {
        "complete" | "ok" => "complete".into(),
        "awaiting_review" | "held" => "review".into(),
        "running" => "running".into(),
        "blocked" | "failed" => "blocked".into(),
        _ => "ready".into(),
    }
}

fn parse_status(stdout: &str) -> Option<String> {
    parse_app_step(stdout).and_then(|v| v.get("status").and_then(Value::as_str).map(str::to_string))
}

fn parse_current_stage(stdout: &str) -> Option<String> {
    parse_app_step(stdout).and_then(|v| {
        v.get("current_stage")
            .and_then(Value::as_str)
            .or_else(|| v.get("stage").and_then(Value::as_str))
            .map(str::to_string)
    })
}

fn parse_app_step(stdout: &str) -> Option<Value> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| line.contains("lfs-agent-app-step/v1"))
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
}

fn parse_agent_stage(batch_dir: &Path) -> Option<String> {
    let path = batch_dir.join("agent-run.json");
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value
        .get("current_stage")
        .and_then(Value::as_str)
        .or_else(|| value.get("stage").and_then(Value::as_str))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_batch_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(id("wwx-ingest-test"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ingest_runner_persists_private_dependencies_and_public_review_artifacts() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let batch_dir = test_batch_dir();
        fs::write(batch_dir.join("source-angle.md"), "source").unwrap();
        fs::write(batch_dir.join("agent-run.json"), "{}").unwrap();
        fs::create_dir_all(batch_dir.join("prompts")).unwrap();
        fs::write(batch_dir.join("prompts/task.md"), "prompt").unwrap();
        fs::create_dir_all(batch_dir.join("outlines")).unwrap();
        fs::write(batch_dir.join("outlines/task.md"), "outline").unwrap();
        fs::create_dir_all(batch_dir.join("output-v41")).unwrap();
        fs::write(batch_dir.join("output-v41/task.md"), "final").unwrap();

        ingest_runner(&conn, "prod_PAN", "batch_PAN_demo", &batch_dir).unwrap();

        let mut stmt = conn
            .prepare("SELECT filename, public FROM artifacts ORDER BY filename")
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(rows.contains(&("source-angle.md".into(), 1)));
        assert!(rows.contains(&("output-v41/task.md".into(), 1)));
        assert!(rows.contains(&("prompts/task.md".into(), 0)));
        assert!(rows.contains(&("outlines/task.md".into(), 0)));
        assert!(rows.contains(&("agent-run.json".into(), 0)));

        let _ = fs::remove_dir_all(batch_dir);
    }

    #[test]
    fn upsert_artifact_revives_soft_deleted_rows_with_the_original_id() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        let first = upsert_artifact(
            &conn,
            "prod_NR",
            "batch_NR_demo",
            "spec.json",
            "Spec",
            br#"{"old":true}"#,
            "runner",
            true,
        )
        .unwrap();
        conn.execute(
            "UPDATE artifacts SET deleted_at = ?2 WHERE id = ?1",
            params![first.id, now_ms()],
        )
        .unwrap();

        let revived = upsert_artifact(
            &conn,
            "prod_NR",
            "batch_NR_demo",
            "spec.json",
            "Spec",
            br#"{"old":false}"#,
            "runner",
            true,
        )
        .unwrap();

        assert_eq!(revived.id, first.id);
        let active_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM artifacts WHERE batch_id = 'batch_NR_demo' AND filename = 'spec.json' AND deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_rows, 1);
    }

    #[test]
    fn reset_batch_for_new_submission_preserves_planning_and_clears_stale_workflow_artifacts() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let now = now_ms();
        conn.execute(
            "INSERT INTO products (id, product_code, name, config_json, created_at, updated_at, revision) VALUES ('prod_NR', 'NR', 'NR', '{}', ?1, ?1, 1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO batches (id, product_id, batch_id, name, status, current_stage, created_at, updated_at, revision) VALUES ('batch_NR_demo', 'prod_NR', 'demo', 'demo', 'blocked', 'lfs_outline', ?1, ?1, 1)",
            params![now],
        )
        .unwrap();
        upsert_artifact(
            &conn,
            "prod_NR",
            "batch_NR_demo",
            "angles.md",
            "Angles",
            b"old",
            "runner",
            true,
        )
        .unwrap();
        upsert_artifact(
            &conn,
            "prod_NR",
            "batch_NR_demo",
            "strategy-plan.json",
            "Strategy Plan",
            b"{}",
            "desktop",
            true,
        )
        .unwrap();
        upsert_artifact(
            &conn,
            "prod_NR",
            "batch_NR_demo",
            "batch-control.json",
            "Batch Control",
            br#"{"autonomous":true}"#,
            "desktop",
            true,
        )
        .unwrap();
        upsert_artifact(
            &conn,
            "prod_NR",
            "batch_NR_demo",
            "strategy.json",
            "Strategy",
            b"{}",
            "runner",
            true,
        )
        .unwrap();
        upsert_artifact(
            &conn,
            "prod_NR",
            "batch_NR_demo",
            "concept-matrix.json",
            "Concept Matrix",
            b"{}",
            "runner",
            true,
        )
        .unwrap();
        upsert_artifact(
            &conn,
            "prod_NR",
            "batch_NR_demo",
            "prompts/old.md",
            "Prompt",
            b"prompt",
            "runner",
            false,
        )
        .unwrap();

        reset_batch_for_new_submission(&conn, "batch_NR_demo").unwrap();

        let active_artifacts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM artifacts WHERE batch_id = 'batch_NR_demo' AND deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let (status, current_stage): (String, Option<String>) = conn
            .query_row(
                "SELECT status, current_stage FROM batches WHERE id = 'batch_NR_demo'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(active_artifacts, 5);
        assert_eq!(status, "draft");
        assert_eq!(current_stage, None);
    }

    #[test]
    fn batch_autonomous_reads_batch_control_artifact() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        upsert_artifact(
            &conn,
            "prod_NR",
            "batch_NR_demo",
            "batch-control.json",
            "Batch Control",
            br#"{"autonomous":true}"#,
            "desktop",
            true,
        )
        .unwrap();

        assert!(batch_autonomous(&conn, "batch_NR_demo").unwrap());
    }

    #[test]
    fn agent_stage_timeline_uses_operator_public_ui_labels() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        upsert_artifact(
            &conn,
            "prod_NR",
            "batch_NR_demo",
            "agent-run.json",
            "agent-run.json",
            br#"{
              "stages": {
                "lfs_brief": {
                  "status": "ok",
                  "approved": false,
                  "artifacts": ["prompts/task.md"],
                  "public_ui": {
                    "stage_label": "Building briefs",
                    "summary": "Briefs are ready for review."
                  }
                }
              }
            }"#,
            "runner",
            false,
        )
        .unwrap();

        let timeline = agent_stage_timeline(&conn, "batch_NR_demo").unwrap();
        let brief = timeline
            .iter()
            .find(|stage| stage.stage == "lfs_brief")
            .unwrap();

        assert_eq!(brief.label, "Building briefs");
        assert_eq!(brief.summary, "Briefs are ready for review.");
        assert_eq!(brief.artifact_count, 1);
    }

    #[test]
    fn batch_workflow_state_prioritizes_final_outputs_and_hides_diagnostics() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let final_artifact = upsert_artifact(
            &conn,
            "prod_NR",
            "batch_NR_demo",
            "output-v41/task.md",
            "output-v41/task.md",
            b"final",
            "runner",
            true,
        )
        .unwrap();
        let diagnostic = upsert_artifact(
            &conn,
            "prod_NR",
            "batch_NR_demo",
            "repair-history.json",
            "repair-history.json",
            br#"{"failures":[]}"#,
            "repair-history",
            true,
        )
        .unwrap();
        let final_id = final_artifact.id.clone();
        let diagnostic_id = diagnostic.id.clone();
        let batch = WwxBatch {
            id: "batch_NR_demo".into(),
            product_id: "prod_NR".into(),
            product_code: "NR".into(),
            name: "demo".into(),
            batch_id: "demo".into(),
            status: "complete".into(),
            current_stage: Some("manifest_overview".into()),
            created_at: 1,
            updated_at: 1,
            revision: 1,
            artifacts: vec![final_artifact, diagnostic],
            runs: vec![],
            decision_counts: DecisionCounts::default(),
            stage_timeline: vec![],
            final_scripts: vec![],
            autonomous: true,
            workflow_state: empty_workflow_state("complete", Some("manifest_overview".into())),
        };

        let state = batch_workflow_state(&conn, &batch).unwrap();

        assert_eq!(state.headline, "Final ads are ready");
        assert_eq!(state.primary_action.unwrap().kind, "review_final");
        assert!(state.important_artifact_ids.contains(&final_id));
        assert!(state.diagnostic_artifact_ids.contains(&diagnostic_id));
    }

    #[test]
    #[ignore = "requires the local ww-2 engine checkout and exercises a real LFS workflow"]
    fn smoke_uploaded_angle_submission_generates_lfs_artifacts() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        let engine_root = Path::new(ENGINE_ROOT);
        let config_json = fs::read_to_string(engine_root.join("products/org-bloat/config.json"))
            .expect("org-bloat config should exist in the local engine checkout");
        let angle_markdown = fs::read_to_string(
            engine_root.join("products/org-bloat/rips/angles/S06-hair-loss-urgency.md"),
        )
        .expect("real angle markdown should exist in the local engine checkout");
        let now = now_ms();
        let product_id = "prod_ORG-BLOAT";
        let batch_pk = "batch_ORG-BLOAT_desktop-smoke";

        conn.execute(
            "INSERT INTO products (id, product_code, name, config_json, created_at, updated_at, revision) VALUES (?1, 'ORG-BLOAT', 'Organica Lymphatic Drainage Drops', ?2, ?3, ?3, 1)",
            params![product_id, config_json, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO batches (id, product_id, batch_id, name, status, current_stage, created_at, updated_at, revision) VALUES (?1, ?2, 'desktop-smoke', 'desktop smoke', 'blocked', 'lfs_outline', ?3, ?3, 1)",
            params![batch_pk, product_id, now],
        )
        .unwrap();

        upsert_artifact(
            &conn,
            product_id,
            batch_pk,
            "spec.json",
            "Old spec",
            br#"{"task_ids":["ORG-BLOAT_LFS_ARC1_A1B1_M1_May14"]}"#,
            "runner",
            true,
        )
        .unwrap();
        upsert_artifact(
            &conn,
            product_id,
            batch_pk,
            "prompts/ORG-BLOAT_LFS_ARC1_A1B1_M1_May14.md",
            "Old prompt",
            b"stale prompt",
            "runner",
            false,
        )
        .unwrap();
        upsert_artifact_with_metadata(
            &conn,
            product_id,
            batch_pk,
            "uploads/S06-hair-loss-urgency.md",
            "Uploaded angle",
            angle_markdown.as_bytes(),
            "upload",
            false,
            Some("angles"),
            Some("text/markdown"),
        )
        .unwrap();

        let cache_root = test_batch_dir();
        let empty_anthropic = cache_root.join("no-anthropic");
        fs::create_dir_all(&empty_anthropic).unwrap();
        let previous_anthropic_config = std::env::var_os("ANTHROPIC_CONFIG_DIR");
        std::env::set_var("ANTHROPIC_CONFIG_DIR", &empty_anthropic);

        let result = start_lfs_job_with_context(
            &conn,
            &cache_root,
            LfsJobInput {
                product_id: product_id.into(),
                batch_id: batch_pk.into(),
                angles_markdown: Some(angle_markdown),
                run_mode: Some("full".into()),
                workers: Some(1),
                generation_workers: Some(1),
                from_stage: None,
                anthropic_api_key: None,
            },
        )
        .unwrap();

        if let Some(previous) = previous_anthropic_config {
            std::env::set_var("ANTHROPIC_CONFIG_DIR", previous);
        } else {
            std::env::remove_var("ANTHROPIC_CONFIG_DIR");
        }

        assert!(
            result.ok,
            "smoke workflow should complete successfully: {}",
            result.stderr
        );

        let mut stmt = conn
            .prepare(
                "SELECT filename, public FROM artifacts WHERE batch_id = ?1 AND deleted_at IS NULL ORDER BY filename",
            )
            .unwrap();
        let artifacts = stmt
            .query_map(params![batch_pk], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let filenames = artifacts
            .iter()
            .map(|(filename, _)| filename.as_str())
            .collect::<Vec<_>>();

        for required in [
            "source-angle.md",
            "angles.md",
            "strategy.json",
            "lfs-brief-report.json",
            "lfs-outline-report.json",
            "lfs-v41-report.json",
            "lfs-v41-manifest.json",
        ] {
            assert!(
                filenames.contains(&required),
                "missing expected artifact {required}; got {filenames:?}"
            );
        }
        assert!(
            filenames
                .iter()
                .any(|name| name.starts_with("prompts/") && name.ends_with("_V001.md")),
            "expected a stable V001 prompt artifact; got {filenames:?}"
        );
        assert!(
            filenames
                .iter()
                .any(|name| name.starts_with("outlines/") && name.ends_with("_V001.md")),
            "expected a stable V001 outline artifact; got {filenames:?}"
        );
        assert!(
            filenames
                .iter()
                .any(|name| name.starts_with("output-v41/") && name.ends_with("_V001.md")),
            "expected a final output artifact; got {filenames:?}"
        );
        assert!(
            !filenames
                .iter()
                .any(|name| name.contains("May14") || name.contains("May15")),
            "fresh submission should not retain stale dated artifacts: {filenames:?}"
        );
        assert!(
            artifacts
                .iter()
                .any(|(name, public)| name == "lfs-v41-manifest.json" && *public == 1),
            "final manifest should be public: {artifacts:?}"
        );

        let _ = fs::remove_dir_all(cache_root);
    }

    #[test]
    fn queue_claim_reads_payload_and_marks_job_running() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let now = now_ms();
        let input = LfsJobInput {
            product_id: "prod_PAN".into(),
            batch_id: "batch_PAN_demo".into(),
            angles_markdown: Some("angle".into()),
            run_mode: Some("full".into()),
            workers: Some(1),
            generation_workers: Some(1),
            from_stage: None,
            anthropic_api_key: None,
        };
        conn.execute(
            "INSERT INTO job_queue (id, product_id, batch_id, payload_json, status, requested_at, updated_at) VALUES ('queue-1', 'prod_PAN', 'batch_PAN_demo', ?1, 'queued', ?2, ?2)",
            params![serde_json::to_string(&input).unwrap(), now],
        )
        .unwrap();

        let (queue_id, claimed) = claim_next_queue_job(&conn).unwrap().unwrap();
        assert_eq!(queue_id, "queue-1");
        assert_eq!(claimed.batch_id, "batch_PAN_demo");
        let status: String = conn
            .query_row(
                "SELECT status FROM job_queue WHERE id = 'queue-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "running");
    }
}
