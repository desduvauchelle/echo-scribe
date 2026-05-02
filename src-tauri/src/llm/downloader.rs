//! Streaming HTTPS downloader for [`super::registry::LlmModelEntry`] files.
//!
//! Mirrors [`crate::asr::downloader`] — same atomic `.partial` → final rename
//! and same SHA-256 verify (skipped on the `"PLACEHOLDER"` sentinel). Storage
//! lives at `<data-dir>/EchoScribe/llm-models/<id>/<file-name>` so it doesn't
//! collide with the speech model tree.
//!
//! Progress callbacks emit a [`LlmDownloadProgress`] cumulatively across all
//! files in the model — Tauri commands forward these to the
//! `"llm_model:progress"` channel so the React layer can subscribe per stack.

use std::path::{Path, PathBuf};
use std::time::Instant;

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tracing::{info, warn};

use super::registry::{LlmModelEntry, LlmModelFile};

#[derive(Debug, Clone, Serialize)]
pub struct LlmDownloadProgress {
    pub id: String,
    pub bytes_downloaded: u64,
    pub bytes_total: u64,
}

#[derive(Debug, Error)]
pub enum LlmDownloadError {
    #[error("network error: {0}")]
    Network(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("sha256 mismatch for {file}: expected {expected}, got {actual}")]
    HashMismatch {
        file: String,
        expected: String,
        actual: String,
    },
    #[error("model {0} has no downloadable files (placeholder)")]
    Unsupported(String),
}

impl From<reqwest::Error> for LlmDownloadError {
    fn from(e: reqwest::Error) -> Self {
        LlmDownloadError::Network(e.to_string())
    }
}

/// Where downloaded LLM weights live. `~/Library/Application Support/EchoScribe/llm-models/`
/// on macOS.
pub fn model_storage_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| std::env::temp_dir());
    base.join("EchoScribe").join("llm-models")
}

pub fn model_dir(entry: &LlmModelEntry) -> PathBuf {
    model_storage_dir().join(&entry.id)
}

/// First file's on-disk path. By convention LLM entries have a single GGUF
/// file; this is just `model_dir(entry).join(entry.files[0].name)`. Returns
/// `None` if the entry has no files.
pub fn model_file_path(entry: &LlmModelEntry) -> Option<PathBuf> {
    entry
        .files
        .first()
        .map(|f| model_dir(entry).join(&f.name))
}

pub fn is_downloaded(entry: &LlmModelEntry) -> bool {
    if !super::registry::is_supported(entry) {
        return false;
    }
    let dir = model_dir(entry);
    entry.files.iter().all(|f| dir.join(&f.name).is_file())
}

pub async fn download_model<F>(
    entry: &LlmModelEntry,
    target_dir: &Path,
    on_progress: F,
) -> Result<PathBuf, LlmDownloadError>
where
    F: Fn(LlmDownloadProgress) + Send + 'static,
{
    if !super::registry::is_supported(entry) {
        return Err(LlmDownloadError::Unsupported(entry.id.clone()));
    }

    fs::create_dir_all(target_dir).await?;

    let total: u64 = entry.files.iter().map(|f| f.size_bytes).sum();
    let mut cumulative: u64 = 0;

    let client = reqwest::Client::builder()
        .user_agent(concat!("EchoScribe/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| LlmDownloadError::Network(e.to_string()))?;

    for file in &entry.files {
        let final_path = target_dir.join(&file.name);
        if final_path.is_file() {
            cumulative = cumulative.saturating_add(file.size_bytes);
            on_progress(LlmDownloadProgress {
                id: entry.id.clone(),
                bytes_downloaded: cumulative,
                bytes_total: total,
            });
            continue;
        }

        cumulative = download_one(&client, file, target_dir, &entry.id, total, cumulative, &on_progress)
            .await?;
    }

    info!(model = %entry.id, "llm model fully downloaded");
    Ok(target_dir.to_path_buf())
}

async fn download_one<F>(
    client: &reqwest::Client,
    file: &LlmModelFile,
    target_dir: &Path,
    model_id: &str,
    total: u64,
    mut cumulative: u64,
    on_progress: &F,
) -> Result<u64, LlmDownloadError>
where
    F: Fn(LlmDownloadProgress) + Send + 'static,
{
    let final_path = target_dir.join(&file.name);
    let partial_path = target_dir.join(format!("{}.partial", file.name));

    info!(model = %model_id, file = %file.name, url = %file.url, "downloading llm");

    let resp = client
        .get(&file.url)
        .send()
        .await?
        .error_for_status()?;

    let mut stream = resp.bytes_stream();
    let mut out = fs::File::create(&partial_path).await?;
    let mut hasher = Sha256::new();

    let mut last_emit = Instant::now();
    let mut bytes_since_emit: u64 = 0;
    let cumulative_at_start = cumulative;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        hasher.update(&chunk);
        out.write_all(&chunk).await?;
        cumulative = cumulative.saturating_add(chunk.len() as u64);
        bytes_since_emit = bytes_since_emit.saturating_add(chunk.len() as u64);

        if bytes_since_emit >= 64 * 1024 || last_emit.elapsed().as_millis() >= 100 {
            on_progress(LlmDownloadProgress {
                id: model_id.to_string(),
                bytes_downloaded: cumulative,
                bytes_total: total,
            });
            last_emit = Instant::now();
            bytes_since_emit = 0;
        }
    }

    out.flush().await?;
    drop(out);

    if file.sha256 == "PLACEHOLDER" {
        warn!(file = %file.name, "skipping SHA-256 verification (placeholder)");
    } else {
        let actual = hex_lower(hasher.finalize().as_slice());
        if !actual.eq_ignore_ascii_case(&file.sha256) {
            let _ = fs::remove_file(&partial_path).await;
            return Err(LlmDownloadError::HashMismatch {
                file: file.name.clone(),
                expected: file.sha256.clone(),
                actual,
            });
        }
    }

    fs::rename(&partial_path, &final_path).await?;
    let elapsed = (cumulative - cumulative_at_start) as f64 / 1024.0 / 1024.0;
    info!(file = %file.name, mib = elapsed, "downloaded");
    Ok(cumulative)
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_dir_is_under_data_dir() {
        let p = model_storage_dir();
        assert!(p.ends_with("EchoScribe/llm-models"));
    }

    #[test]
    fn model_file_path_uses_first_file_name() {
        let m = super::super::registry::lookup("gemma-3-4b-it-q4_k_m").unwrap();
        let p = model_file_path(m).unwrap();
        assert!(p.ends_with("gemma-3-4b-it-q4_k_m/model.gguf"));
    }
}
