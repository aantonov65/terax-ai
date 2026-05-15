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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsJobInput {
    product_id: String,
    batch_id: String,
    angles_markdown: Option<String>,
    run_mode: Option<String>,
    workers: Option<i64>,
    generation_workers: Option<i64>,
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
        CREATE INDEX IF NOT EXISTS idx_batches_product ON batches(product_id, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_artifacts_batch ON artifacts(batch_id, public, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_runs_batch ON runs(batch_id, updated_at);
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
            "SELECT id FROM artifacts WHERE batch_id = ?1 AND filename = ?2 AND deleted_at IS NULL",
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

#[tauri::command]
pub fn wwx_list_products(app: AppHandle) -> Result<WwxIndex, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, product_code, name, config_json, created_at, updated_at, revision FROM products WHERE deleted_at IS NULL ORDER BY updated_at DESC",
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
            })
        })
        .map_err(|e| e.to_string())?;
    let mut batches = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for batch in &mut batches {
        batch.artifacts = list_artifacts_for_batch(conn, &batch.id)?;
        batch.runs = list_runs_for_batch(conn, &batch.id)?;
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
pub async fn wwx_start_lfs_job(app: AppHandle, input: LfsJobInput) -> Result<WwxJobResult, String> {
    tauri::async_runtime::spawn_blocking(move || start_lfs_job(app, input))
        .await
        .map_err(|e| e.to_string())?
}

fn start_lfs_job(app: AppHandle, input: LfsJobInput) -> Result<WwxJobResult, String> {
    if let Some(markdown) = input
        .angles_markdown
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        let conn = open_db(&app)?;
        reset_batch_for_new_submission(&conn, &input.batch_id)?;
        upsert_artifact(
            &conn,
            &input.product_id,
            &input.batch_id,
            "source-angle.md",
            "Source Angle",
            markdown.as_bytes(),
            "upload",
            true,
        )?;
        upsert_artifact(
            &conn,
            &input.product_id,
            &input.batch_id,
            "angles.md",
            "Angles",
            markdown.as_bytes(),
            "upload",
            true,
        )?;
    }
    run_lfs(app, input, "submit_lfs_job", false)
}

fn reset_batch_for_new_submission(conn: &Connection, batch_id: &str) -> Result<(), String> {
    let now = now_ms();
    conn.execute(
        "UPDATE artifacts SET deleted_at = ?2, updated_at = ?2 WHERE batch_id = ?1 AND deleted_at IS NULL",
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

fn runner_root(app: &AppHandle, run_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("wwx-runner")
        .join(run_id);
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
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Product research is missing in app storage: {}. Add or import product research before advancing LFS.",
            missing.join(", ")
        ))
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
    app: &AppHandle,
    conn: &Connection,
    run_id: &str,
    product_id: &str,
    batch_pk: &str,
) -> Result<(PathBuf, String, String, PathBuf), String> {
    let root = runner_root(app, run_id)?;
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
        "strategy.json",
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
            | "strategy.json"
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

    let (root, product_code, batch_id, batch_dir) =
        materialize_runner(&app, &conn, &run_id, &input.product_id, &input.batch_id)?;
    if resume {
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
            let artifacts = list_artifacts_for_batch(&conn, &input.batch_id).unwrap_or_default();
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
    cmd.arg("--base-path").arg(&root);
    if let Some(key) = input.anthropic_api_key.as_deref().filter(|s| !s.is_empty()) {
        cmd.env("ANTHROPIC_API_KEY", key);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code();
    let artifacts =
        ingest_runner(&conn, &input.product_id, &input.batch_id, &batch_dir).unwrap_or_default();
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
    fn reset_batch_for_new_submission_clears_stale_workflow_artifacts() {
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

        assert_eq!(active_artifacts, 0);
        assert_eq!(status, "draft");
        assert_eq!(current_stage, None);
    }
}
