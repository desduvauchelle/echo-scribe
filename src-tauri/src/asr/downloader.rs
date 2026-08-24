//! Speech-model downloads, built on the shared resilient engine in
//! [`crate::download`] (resume, retries, stall watchdog, disk preflight,
//! size + SHA-256 verification). This module only owns the storage layout
//! and the [`DownloadProgress`] shape the frontend subscribes to.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tracing::{info, warn};

use crate::download::{self, FetchError, FileSpec};

use super::registry::{ModelEntry, ModelFile};

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub id: String,
    pub bytes_downloaded: u64,
    pub bytes_total: u64,
    /// True while the engine waits out a transient failure before resuming —
    /// lets the UI say "connection lost, retrying" instead of freezing.
    pub retrying: bool,
}

pub type DownloadError = FetchError;

/// Where downloaded models live on disk. `~/Library/Application Support/EchoScribe/models/`
/// on macOS.
pub fn model_storage_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| std::env::temp_dir());
    base.join(crate::data_folder_name()).join("models")
}

/// Per-model directory: `<storage-dir>/<id>/`.
pub fn model_dir(entry: &ModelEntry) -> PathBuf {
    model_storage_dir().join(&entry.id)
}

/// Hardcoded map of historical model-id renames. If a directory under
/// [`model_storage_dir`] exists with the old name and the new one is missing
/// (or empty), the old dir is renamed to the new one on startup so users
/// don't have to re-download identical files.
///
/// Format: `(old_id, new_id)`. Add a new entry whenever a model id changes
/// in `models.json`.
const LEGACY_MODEL_RENAMES: &[(&str, &str)] = &[("parakeet-medium", "parakeet-v3")];

/// Run once at startup. Idempotent: skips entries where the new dir already
/// has files, and silently ignores missing old dirs.
pub fn migrate_legacy_model_dirs() {
    let root = model_storage_dir();
    for (old_id, new_id) in LEGACY_MODEL_RENAMES {
        let old_dir = root.join(old_id);
        let new_dir = root.join(new_id);
        if !old_dir.is_dir() {
            continue;
        }
        let new_has_files = std::fs::read_dir(&new_dir)
            .map(|mut it| it.any(|e| e.is_ok()))
            .unwrap_or(false);
        if new_has_files {
            continue;
        }
        if let Err(e) = std::fs::create_dir_all(root.as_path()) {
            warn!(error = %e, "failed to ensure model storage root");
            continue;
        }
        // If new_dir exists but is empty, remove it before rename.
        let _ = std::fs::remove_dir(&new_dir);
        match std::fs::rename(&old_dir, &new_dir) {
            Ok(()) => {
                info!(from = %old_dir.display(), to = %new_dir.display(), "migrated legacy model dir")
            }
            Err(e) => {
                warn!(error = %e, from = %old_dir.display(), to = %new_dir.display(), "legacy model dir migration failed")
            }
        }
    }
}

/// True if every file listed in `entry` is present AND plausibly complete
/// (non-empty; within 10% of the manifest size, tolerating pre-revision-pin
/// files — see [`download::is_complete_file`]). A truncated or 0-byte file no
/// longer counts as downloaded, so the UI offers a re-download instead of the
/// engine failing to load it with a cryptic error.
pub fn is_downloaded(entry: &ModelEntry) -> bool {
    if !super::registry::is_supported(entry) {
        return false;
    }
    let dir = model_dir(entry);
    entry
        .files
        .iter()
        .all(|f| download::is_complete_file(&dir.join(&f.name), f.size_bytes))
}

/// Bytes currently on disk in this model's directory — includes completed
/// files AND any leftover `.partial` from an interrupted download.
pub fn disk_bytes(entry: &ModelEntry) -> u64 {
    download::dir_bytes(&model_dir(entry))
}

/// True when the model's directory holds bytes but the model is NOT fully
/// downloaded — an interrupted/orphaned download the user can resume or
/// reclaim from the UI.
pub fn has_incomplete_download(entry: &ModelEntry) -> bool {
    !is_downloaded(entry) && disk_bytes(entry) > 0
}

fn spec(file: &ModelFile) -> FileSpec<'_> {
    FileSpec {
        name: &file.name,
        url: &file.url,
        sha256: &file.sha256,
        size_bytes: file.size_bytes,
    }
}

/// Download every file in `entry` into [`model_dir`]`(entry)`. Streams progress
/// across the whole model — `bytes_total` is the sum of all expected file
/// sizes, `bytes_downloaded` is cumulative across files. Resumable: partial
/// files survive failures and continue where they left off.
pub async fn download_model<F>(
    entry: &ModelEntry,
    target_dir: &Path,
    on_progress: F,
) -> Result<PathBuf, DownloadError>
where
    F: Fn(DownloadProgress) + Send + Sync + 'static,
{
    if !super::registry::is_supported(entry) {
        return Err(FetchError::Unsupported(entry.id.clone()));
    }

    tokio::fs::create_dir_all(target_dir).await?;

    let total: u64 = entry.files.iter().map(|f| f.size_bytes).sum();
    // Bytes still to fetch ≈ total minus whatever (complete or partial) is
    // already on disk — so resuming a 90%-done download doesn't demand 100%
    // of the space again.
    let needed = total.saturating_sub(download::dir_bytes(target_dir));
    download::ensure_disk_space(target_dir, needed)?;

    let client = download::build_client()?;
    let mut cumulative_base: u64 = 0;

    for file in &entry.files {
        let final_path = target_dir.join(&file.name);
        if download::is_complete_file(&final_path, file.size_bytes) {
            cumulative_base = cumulative_base.saturating_add(file.size_bytes);
            on_progress(DownloadProgress {
                id: entry.id.clone(),
                bytes_downloaded: cumulative_base,
                bytes_total: total,
                retrying: false,
            });
            continue;
        }

        info!(model = %entry.id, file = %file.name, url = %file.url, "downloading");
        let base = cumulative_base;
        let id = entry.id.clone();
        download::fetch_file(&client, &spec(file), target_dir, |file_bytes, retrying| {
            on_progress(DownloadProgress {
                id: id.clone(),
                bytes_downloaded: base.saturating_add(file_bytes),
                bytes_total: total,
                retrying,
            });
        })
        .await?;
        cumulative_base = cumulative_base.saturating_add(file.size_bytes);
    }

    info!(model = %entry.id, "model fully downloaded");
    Ok(target_dir.to_path_buf())
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
    fn model_dir_uses_model_id() {
        let m = super::super::registry::lookup("parakeet-v3").unwrap();
        let d = model_dir(m);
        assert!(d.ends_with("EchoScribe/models/parakeet-v3"));
    }
}
