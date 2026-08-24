//! LLM (llama.cpp GGUF) model downloads, built on the shared resilient
//! engine in [`crate::download`] — same resume/retry/verification behavior as
//! [`crate::asr::downloader`]. Storage lives at
//! `<data-dir>/EchoScribe/llm-models/<id>/<file-name>` so it doesn't collide
//! with the speech model tree.
//!
//! Progress callbacks emit a [`LlmDownloadProgress`] cumulatively across all
//! files in the model — Tauri commands forward these to the
//! `"llm_model:progress"` channel so the React layer can subscribe per stack.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tracing::info;

use crate::download::{self, FetchError, FileSpec};

use super::registry::{LlmModelEntry, LlmModelFile};

#[derive(Debug, Clone, Serialize)]
pub struct LlmDownloadProgress {
    pub id: String,
    pub bytes_downloaded: u64,
    pub bytes_total: u64,
    /// True while the engine waits out a transient failure before resuming —
    /// lets the UI say "connection lost, retrying" instead of freezing.
    pub retrying: bool,
}

pub type LlmDownloadError = FetchError;

/// Where downloaded LLM weights live. `~/Library/Application Support/EchoScribe/llm-models/`
/// on macOS.
pub fn model_storage_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| std::env::temp_dir());
    base.join(crate::data_folder_name()).join("llm-models")
}

pub fn model_dir(entry: &LlmModelEntry) -> PathBuf {
    model_storage_dir().join(&entry.id)
}

/// First file's on-disk path. By convention LLM entries have a single GGUF
/// file; this is just `model_dir(entry).join(entry.files[0].name)`. Returns
/// `None` if the entry has no files.
pub fn model_file_path(entry: &LlmModelEntry) -> Option<PathBuf> {
    entry.files.first().map(|f| model_dir(entry).join(&f.name))
}

/// True if every file is present AND plausibly complete (non-empty; within
/// 10% of the manifest size, tolerating files from before URLs were
/// revision-pinned — see [`download::is_complete_file`]).
pub fn is_downloaded(entry: &LlmModelEntry) -> bool {
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
pub fn disk_bytes(entry: &LlmModelEntry) -> u64 {
    download::dir_bytes(&model_dir(entry))
}

/// True when the model's directory holds bytes but the model is NOT fully
/// downloaded — i.e. an interrupted/orphaned download (e.g. a stray
/// `.partial`) occupying disk the user should be able to reclaim.
pub fn has_incomplete_download(entry: &LlmModelEntry) -> bool {
    !is_downloaded(entry) && disk_bytes(entry) > 0
}

fn spec(file: &LlmModelFile) -> FileSpec<'_> {
    FileSpec {
        name: &file.name,
        url: &file.url,
        sha256: &file.sha256,
        size_bytes: file.size_bytes,
    }
}

pub async fn download_model<F>(
    entry: &LlmModelEntry,
    target_dir: &Path,
    on_progress: F,
) -> Result<PathBuf, LlmDownloadError>
where
    F: Fn(LlmDownloadProgress) + Send + Sync + 'static,
{
    if !super::registry::is_supported(entry) {
        return Err(FetchError::Unsupported(entry.id.clone()));
    }

    tokio::fs::create_dir_all(target_dir).await?;

    let total: u64 = entry.files.iter().map(|f| f.size_bytes).sum();
    // Bytes still to fetch ≈ total minus whatever is already on disk, so a
    // resume doesn't demand the full model's space again.
    let needed = total.saturating_sub(download::dir_bytes(target_dir));
    download::ensure_disk_space(target_dir, needed)?;

    let client = download::build_client()?;
    let mut cumulative_base: u64 = 0;

    for file in &entry.files {
        let final_path = target_dir.join(&file.name);
        if download::is_complete_file(&final_path, file.size_bytes) {
            cumulative_base = cumulative_base.saturating_add(file.size_bytes);
            on_progress(LlmDownloadProgress {
                id: entry.id.clone(),
                bytes_downloaded: cumulative_base,
                bytes_total: total,
                retrying: false,
            });
            continue;
        }

        info!(model = %entry.id, file = %file.name, url = %file.url, "downloading llm");
        let base = cumulative_base;
        let id = entry.id.clone();
        download::fetch_file(&client, &spec(file), target_dir, |file_bytes, retrying| {
            on_progress(LlmDownloadProgress {
                id: id.clone(),
                bytes_downloaded: base.saturating_add(file_bytes),
                bytes_total: total,
                retrying,
            });
        })
        .await?;
        cumulative_base = cumulative_base.saturating_add(file.size_bytes);
    }

    info!(model = %entry.id, "llm model fully downloaded");
    Ok(target_dir.to_path_buf())
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
        let m = super::super::registry::lookup("gemma-4-e2b-it-q4_k_m").unwrap();
        let p = model_file_path(m).unwrap();
        assert!(p.ends_with("gemma-4-e2b-it-q4_k_m/google_gemma-4-E2B-it-Q4_K_M.gguf"));
    }

    #[test]
    fn incomplete_when_only_partial_on_disk() {
        // has_incomplete_download is (bytes on disk) && !is_downloaded; a lone
        // .partial is the canonical case.
        let m = super::super::registry::lookup("gemma-4-e4b-it-q4_k_m").unwrap();
        // No assertion on a real dir here (state depends on the machine);
        // just exercise both helpers for panics/type drift.
        let _ = disk_bytes(m);
        let _ = has_incomplete_download(m);
    }
}
