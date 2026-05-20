use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

#[tauri::command]
pub async fn lm_ping(base_url: String) -> Result<u16, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("empty base url".into());
    }
    let probe = format!("{trimmed}/models");
    let parsed = reqwest::Url::parse(&probe).map_err(|e| e.to_string())?;

    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("scheme not allowed: {s}")),
    }

    let host = parsed.host_str().ok_or_else(|| "missing host".to_string())?;
    if is_blocked_host(host) {
        return Err(format!("host not allowed: {host}"));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    client
        .get(parsed)
        .send()
        .await
        .map(|r| r.status().as_u16())
        .map_err(|e| e.to_string())
}

fn is_blocked_host(host: &str) -> bool {
    matches!(
        host,
        "169.254.169.254"
            | "fd00:ec2::254"
            | "metadata.google.internal"
            | "metadata.azure.com"
    )
}

// AI HTTP proxy — bypasses webview CORS / Mixed-Content / PNA so local-network
// model servers (LM Studio, Ollama, vLLM) work in the production bundle.

#[derive(Debug, Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

fn build_request(
    client: &reqwest::Client,
    method: &str,
    url: &str,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
) -> Result<reqwest::RequestBuilder, String> {
    let method = Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, url);
    if let Some(h) = headers {
        let mut map = HeaderMap::new();
        for (k, v) in h {
            let name = HeaderName::from_bytes(k.as_bytes()).map_err(|e| e.to_string())?;
            let value = HeaderValue::from_str(&v).map_err(|e| e.to_string())?;
            map.insert(name, value);
        }
        req = req.headers(map);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    Ok(req)
}

fn header_map_to_strings(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::with_capacity(headers.len());
    for (k, v) in headers {
        if let Ok(s) = v.to_str() {
            out.insert(k.as_str().to_ascii_lowercase(), s.to_string());
        }
    }
    out
}

#[tauri::command]
pub async fn ai_http_request(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
) -> Result<HttpResponse, String> {
    let client = reqwest::Client::builder()
        // No total timeout — generative endpoints can take minutes for long outputs.
        // Connect timeout protects against unreachable hosts.
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let req = build_request(&client, &method, &url, headers, body)?;
    let resp = req.send().await.map_err(|e| e.to_string())?;

    let status = resp.status().as_u16();
    let headers = header_map_to_strings(resp.headers());
    let body = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiStreamEvent {
    Headers {
        status: u16,
        headers: HashMap<String, String>,
    },
    Chunk {
        bytes: Vec<u8>,
    },
    End,
    Error {
        message: String,
    },
}

#[tauri::command]
pub async fn ai_http_stream(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
    on_event: Channel<AiStreamEvent>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let req = build_request(&client, &method, &url, headers, body)?;
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error {
                message: e.to_string(),
            });
            return Err(e.to_string());
        }
    };

    let status = resp.status().as_u16();
    let headers = header_map_to_strings(resp.headers());
    let _ = on_event.send(AiStreamEvent::Headers { status, headers });

    let mut stream = resp.bytes_stream();
    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
                let bytes: Bytes = chunk;
                if on_event
                    .send(AiStreamEvent::Chunk {
                        bytes: bytes.to_vec(),
                    })
                    .is_err()
                {
                    // Channel dropped (frontend aborted) — stop streaming.
                    return Ok(());
                }
            }
            Err(e) => {
                let _ = on_event.send(AiStreamEvent::Error {
                    message: e.to_string(),
                });
                return Err(e.to_string());
            }
        }
    }

    let _ = on_event.send(AiStreamEvent::End);
    Ok(())
}

#[tauri::command]
pub async fn wwx_auth_listen_once(port: u16, timeout_ms: Option<u64>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| e.to_string())?;
        listener
            .set_nonblocking(false)
            .map_err(|e| e.to_string())?;
        listener
            .set_ttl(64)
            .map_err(|e| e.to_string())?;
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000));
        listener
            .set_nonblocking(false)
            .map_err(|e| e.to_string())?;
        listener
            .set_ttl(64)
            .map_err(|e| e.to_string())?;
        let start = std::time::Instant::now();
        loop {
            if start.elapsed() > timeout {
                return Err("auth callback timed out".into());
            }
            listener
                .set_nonblocking(true)
                .map_err(|e| e.to_string())?;
            match listener.accept() {
                Ok((mut stream, _addr)) => {
                    let mut buf = [0_u8; 8192];
                    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
                    let request = String::from_utf8_lossy(&buf[..n]);
                    let first_line = request.lines().next().unwrap_or_default();
                    let path = first_line
                        .split_whitespace()
                        .nth(1)
                        .ok_or_else(|| "malformed auth callback".to_string())?;
                    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
                    let response = b"HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\nconnection: close\r\n\r\n<html><body><h1>WWX sign-in complete</h1><p>You can close this window and return to WWX Desktop.</p></body></html>";
                    let _ = stream.write_all(response);
                    let _ = stream.flush();
                    return Ok(query.to_string());
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(err) => return Err(err.to_string()),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
