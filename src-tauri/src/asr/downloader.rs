//! Streaming HTTPS downloader for [`super::registry::ModelEntry`] files.
//!
//! Each model has one or more files; each file is downloaded into
//! `<data-dir>/EchoScribe/models/<model-id>/<file-name>.partial` and then
//! atomically renamed to `<file-name>` once the SHA-256 matches. If a model
//! file's `sha256` is the literal string `"PLACEHOLDER"` we log a warning and
//! skip hash verification — this lets us ship a working downloader before all
//! upstream hashes are pinned.

use std::path::{Path, PathBuf};
use std::time::Instant;

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tracing::{info, warn};

use super::registry::{ModelEntry, ModelFile};

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub id: String,
    pub bytes_downloaded: u64,
    pub bytes_total: u64,
}

#[derive(Debug, Error)]
pub enum DownloadError {
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

impl From<reqwest::Error> for DownloadError {
    fn from(e: reqwest::Error) -> Self {
        DownloadError::Network(e.to_string())
    }
}

/// Where downloaded models live on disk. `~/Library/Application Support/EchoScribe/models/`
/// on macOS.
pub fn model_storage_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| std::env::temp_dir());
    base.join("EchoScribe").join("models")
}

/// Per-model directory: `<storage-dir>/<id>/`.
pub fn model_dir(entry: &ModelEntry) -> PathBuf {
    model_storage_dir().join(&entry.id)
}

/// True if every file listed in `entry` is already present on disk. Does not
/// verify hashes (intentionally cheap — we hash on download, not on every
/// startup poll).
pub fn is_downloaded(entry: &ModelEntry) -> bool {
    if !super::registry::is_supported(entry) {
        return false;
    }
    let dir = model_dir(entry);
    entry.files.iter().all(|f| dir.join(&f.name).is_file())
}

/// Download every file in `entry` into [`model_dir`]`(entry)`. Streams progress
/// across the whole model — `bytes_total` is the sum of all expected file
/// sizes, `bytes_downloaded` is cumulative across files.
pub async fn download_model<F>(
    entry: &ModelEntry,
    target_dir: &Path,
    on_progress: F,
) -> Result<PathBuf, DownloadError>
where
    F: Fn(DownloadProgress) + Send + 'static,
{
    if !super::registry::is_supported(entry) {
        return Err(DownloadError::Unsupported(entry.id.clone()));
    }

    fs::create_dir_all(target_dir).await?;

    let total: u64 = entry.files.iter().map(|f| f.size_bytes).sum();
    let mut cumulative: u64 = 0;

    let client = reqwest::Client::builder()
        .user_agent(concat!("EchoScribe/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| DownloadError::Network(e.to_string()))?;

    for file in &entry.files {
        let final_path = target_dir.join(&file.name);
        if final_path.is_file() {
            // Already on disk — count it toward progress and skip.
            cumulative = cumulative.saturating_add(file.size_bytes);
            on_progress(DownloadProgress {
                id: entry.id.clone(),
                bytes_downloaded: cumulative,
                bytes_total: total,
            });
            continue;
        }

        cumulative = download_one(&client, file, target_dir, &entry.id, total, cumulative, &on_progress)
            .await?;
    }

    info!(model = %entry.id, "model fully downloaded");
    Ok(target_dir.to_path_buf())
}

async fn download_one<F>(
    client: &reqwest::Client,
    file: &ModelFile,
    target_dir: &Path,
    model_id: &str,
    total: u64,
    mut cumulative: u64,
    on_progress: &F,
) -> Result<u64, DownloadError>
where
    F: Fn(DownloadProgress) + Send + 'static,
{
    let final_path = target_dir.join(&file.name);
    let partial_path = target_dir.join(format!("{}.partial", file.name));

    info!(model = %model_id, file = %file.name, url = %file.url, "downloading");

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

        // Emit at most every 64 KiB or every 100 ms.
        if bytes_since_emit >= 64 * 1024 || last_emit.elapsed().as_millis() >= 100 {
            on_progress(DownloadProgress {
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

    // Hash check.
    if file.sha256 == "PLACEHOLDER" {
        warn!(file = %file.name, "skipping SHA-256 verification (placeholder)");
    } else {
        let actual = hex_lower(hasher.finalize().as_slice());
        if !actual.eq_ignore_ascii_case(&file.sha256) {
            // Don't leave a corrupted .partial around.
            let _ = fs::remove_file(&partial_path).await;
            return Err(DownloadError::HashMismatch {
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
        assert!(p.ends_with("EchoScribe/models"));
    }

    #[test]
    fn is_downloaded_returns_false_for_placeholder_models() {
        let small = super::super::registry::lookup("parakeet-small").unwrap();
        assert!(!is_downloaded(small));
    }
}
