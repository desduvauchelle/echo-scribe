//! Shared resilient download engine behind `asr::downloader` and
//! `llm::downloader`.
//!
//! What "resilient" means here (each item traces back to a real first-install
//! failure):
//! - connect timeout + a per-chunk stall watchdog, so a dead connection
//!   surfaces as an error instead of a progress bar frozen forever;
//! - resume: `<name>.partial` is kept across failures and re-fetched with an
//!   HTTP `Range` header, so a dropped multi-GB download continues instead of
//!   restarting from byte 0;
//! - automatic retries with backoff for transient failures — and the retry
//!   budget resets whenever an attempt makes real progress, so a flaky
//!   connection that keeps inching forward is never declared dead;
//! - an upfront free-disk-space check with a friendly error;
//! - post-download size + SHA-256 verification (the manifests pin revisioned
//!   URLs, so both are stable); a file that fails verification is deleted
//!   rather than left masquerading as a working model.
//!
//! Callers surface [`FetchError::friendly`] to the UI and log the raw error
//! (`Display`) at the failure site, per the project's diagnostics rules.

use std::path::Path;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::{info, warn};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Waiting on response headers.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// Max time with zero bytes received before an attempt counts as stalled.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(60);
/// Consecutive no-progress attempts before giving up.
pub const MAX_ATTEMPTS: u32 = 4;
/// An attempt that grows the partial by at least this much resets the retry
/// budget — progress means the connection works, however flakily.
const PROGRESS_RESET_BYTES: u64 = 8 * 1024 * 1024;
/// Extra space to keep free beyond the download itself.
const DISK_HEADROOM_BYTES: u64 = 200 * 1024 * 1024;

/// One downloadable file, borrowed from a manifest entry.
pub struct FileSpec<'a> {
    pub name: &'a str,
    pub url: &'a str,
    /// Lowercase hex SHA-256, or the literal `"PLACEHOLDER"` to skip.
    pub sha256: &'a str,
    /// Expected byte size; 0 = unknown (skips size validation).
    pub size_bytes: u64,
}

#[derive(Debug, Error)]
pub enum FetchError {
    #[error("network error: {0}")]
    Network(String),
    #[error("download stalled: no data for {}s", STALL_TIMEOUT.as_secs())]
    Stalled,
    #[error("http {status} fetching {file}: {body}")]
    Http {
        file: String,
        status: u16,
        body: String,
    },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("not enough disk space: need {needed} bytes free, have {available}")]
    DiskSpace { needed: u64, available: u64 },
    #[error("truncated download for {file}: got {got} of {expected} bytes")]
    Truncated {
        file: String,
        got: u64,
        expected: u64,
    },
    #[error("oversized download for {file}: got {got}, expected {expected} bytes")]
    TooLarge {
        file: String,
        got: u64,
        expected: u64,
    },
    #[error("sha256 mismatch for {file}: expected {expected}, got {actual}")]
    HashMismatch {
        file: String,
        expected: String,
        actual: String,
    },
    #[error("model {0} has no downloadable files (placeholder)")]
    Unsupported(String),
}

impl From<reqwest::Error> for FetchError {
    fn from(e: reqwest::Error) -> Self {
        FetchError::Network(e.to_string())
    }
}

impl FetchError {
    /// Transient failures worth another attempt (with the partial file kept
    /// for resume). Hash mismatches and client-side HTTP errors are not.
    fn is_retryable(&self) -> bool {
        match self {
            FetchError::Network(_) | FetchError::Stalled | FetchError::Truncated { .. } => true,
            // Oversized: the partial is deleted first, then a clean retry is fine.
            FetchError::TooLarge { .. } => true,
            FetchError::Http { status, .. } => {
                *status >= 500 || *status == 429 || *status == 408
            }
            _ => false,
        }
    }

    /// Short human message for the UI. The raw detail stays in the log.
    pub fn friendly(&self) -> String {
        match self {
            FetchError::Network(_) | FetchError::Stalled | FetchError::Truncated { .. } => {
                "Connection problem while downloading. Check your internet and click Download \
                 again — progress is saved, so it resumes where it left off."
                    .to_string()
            }
            FetchError::Http { status, .. } => format!(
                "The model file couldn't be fetched from the server (HTTP {status}). \
                 Try again in a little while."
            ),
            FetchError::DiskSpace { needed, available } => format!(
                "Not enough free disk space: this download needs {} free but only {} is \
                 available. Free up space and try again.",
                fmt_gb(*needed),
                fmt_gb(*available)
            ),
            FetchError::Io(e) if e.raw_os_error() == Some(libc::ENOSPC) => {
                "Your disk filled up during the download. Free up some space and click \
                 Download to resume."
                    .to_string()
            }
            FetchError::Io(_) => {
                "Couldn't write the model file to disk. See Settings → Diagnostics → logs \
                 for details."
                    .to_string()
            }
            FetchError::HashMismatch { .. } | FetchError::TooLarge { .. } => {
                "The downloaded file failed verification and was removed. Click Download \
                 to try again."
                    .to_string()
            }
            FetchError::Unsupported(id) => {
                format!("Model {id} isn't available for download yet.")
            }
        }
    }
}

fn fmt_gb(bytes: u64) -> String {
    let gb = bytes as f64 / 1_000_000_000.0;
    if gb >= 1.0 {
        format!("{gb:.1} GB")
    } else {
        format!("{:.0} MB", bytes as f64 / 1_000_000.0)
    }
}

pub fn build_client() -> Result<reqwest::Client, FetchError> {
    reqwest::Client::builder()
        .user_agent(concat!("EchoScribe/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| FetchError::Network(e.to_string()))
}

/// Free bytes available to the current user on the volume holding `dir`.
/// `None` when the probe isn't available (non-unix, or statvfs failed).
#[cfg(unix)]
pub fn free_disk_bytes(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some(st.f_bavail as u64 * st.f_frsize as u64)
}

#[cfg(not(unix))]
pub fn free_disk_bytes(_dir: &Path) -> Option<u64> {
    None
}

/// Fail fast (with a friendly error) when the volume can't hold `needed`
/// more bytes plus headroom. A failed probe never blocks the download.
pub fn ensure_disk_space(dir: &Path, needed: u64) -> Result<(), FetchError> {
    let Some(available) = free_disk_bytes(dir) else {
        return Ok(());
    };
    let required = needed.saturating_add(DISK_HEADROOM_BYTES);
    if available < required {
        warn!(
            target: "download",
            needed = required,
            available,
            dir = %dir.display(),
            "insufficient disk space for download"
        );
        return Err(FetchError::DiskSpace {
            needed: required,
            available,
        });
    }
    Ok(())
}

/// A final (non-`.partial`) file counts as complete when it is non-empty and,
/// if the expected size is known, within 10% of it. The slack is deliberate:
/// files downloaded before URLs were revision-pinned can differ by a few KB
/// from the current manifest and must not be flagged as missing (which would
/// force a multi-GB re-download on upgrade). Truncated/0-byte files — the
/// corruption we actually see — fall far outside the slack.
pub fn is_complete_file(path: &Path, expected_size: u64) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() == 0 {
        return false;
    }
    expected_size == 0 || meta.len().saturating_mul(10) >= expected_size.saturating_mul(9)
}

/// Sum of the sizes of all regular files directly inside `dir` (including
/// any `.partial`). 0 if the directory is absent or unreadable.
pub fn dir_bytes(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    rd.flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_secs((1u64 << attempt.min(4)).min(15))
}

/// Download one file into `target_dir`, resuming any `<name>.partial`,
/// retrying transient failures, then verifying size + hash and atomically
/// renaming into place.
///
/// `on_progress(file_bytes_on_disk, retrying)` reports bytes present for THIS
/// file (the caller adds its cumulative base). `retrying = true` marks the
/// pause between a failed attempt and the next one so the UI can say
/// "connection lost — retrying" instead of freezing the bar.
pub async fn fetch_file<F>(
    client: &reqwest::Client,
    spec: &FileSpec<'_>,
    target_dir: &Path,
    mut on_progress: F,
) -> Result<(), FetchError>
where
    F: FnMut(u64, bool) + Send,
{
    let final_path = target_dir.join(spec.name);
    let partial_path = target_dir.join(format!("{}.partial", spec.name));

    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let before = partial_len(&partial_path).await;
        let outcome = fetch_attempt(client, spec, &partial_path, &mut on_progress).await;
        let after = partial_len(&partial_path).await;

        let err = match outcome {
            Ok(()) => {
                if spec.size_bytes == 0 || after == spec.size_bytes {
                    break;
                }
                if after > spec.size_bytes {
                    // Wrong content (e.g. an HTML error page appended, or a
                    // server that ignored our Range math). Start clean.
                    let _ = fs::remove_file(&partial_path).await;
                    FetchError::TooLarge {
                        file: spec.name.to_string(),
                        got: after,
                        expected: spec.size_bytes,
                    }
                } else {
                    // Stream ended cleanly but short — resume next attempt.
                    FetchError::Truncated {
                        file: spec.name.to_string(),
                        got: after,
                        expected: spec.size_bytes,
                    }
                }
            }
            Err(e) => e,
        };

        // Real progress proves the connection works — keep going.
        if after.saturating_sub(before) >= PROGRESS_RESET_BYTES {
            attempt = 0;
        }
        if attempt >= MAX_ATTEMPTS || !err.is_retryable() {
            warn!(
                target: "download",
                file = %spec.name,
                attempt,
                bytes_on_disk = after,
                error = %err,
                "download failed; giving up"
            );
            return Err(err);
        }
        warn!(
            target: "download",
            file = %spec.name,
            attempt,
            bytes_on_disk = after,
            error = %err,
            "download attempt failed; retrying"
        );
        on_progress(after, true);
        tokio::time::sleep(backoff(attempt)).await;
    }

    // Size is already validated (or unknown); verify content hash before the
    // atomic rename so a bad file never becomes a "downloaded model".
    if spec.sha256 == "PLACEHOLDER" {
        warn!(target: "download", file = %spec.name, "skipping SHA-256 verification (placeholder)");
    } else {
        let actual = sha256_of(&partial_path).await?;
        if !actual.eq_ignore_ascii_case(spec.sha256) {
            let _ = fs::remove_file(&partial_path).await;
            return Err(FetchError::HashMismatch {
                file: spec.name.to_string(),
                expected: spec.sha256.to_string(),
                actual,
            });
        }
    }

    fs::rename(&partial_path, &final_path).await?;
    let bytes = partial_len(&final_path).await;
    info!(target: "download", file = %spec.name, bytes, "downloaded");
    Ok(())
}

async fn partial_len(path: &Path) -> u64 {
    fs::metadata(path).await.map(|m| m.len()).unwrap_or(0)
}

/// One network attempt: open (or resume) the partial file and stream until
/// the body ends, a chunk stalls past [`STALL_TIMEOUT`], or an error occurs.
async fn fetch_attempt<F>(
    client: &reqwest::Client,
    spec: &FileSpec<'_>,
    partial_path: &Path,
    on_progress: &mut F,
) -> Result<(), FetchError>
where
    F: FnMut(u64, bool) + Send,
{
    let existing = partial_len(partial_path).await;

    let mut req = client.get(spec.url);
    if existing > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let resp = tokio::time::timeout(RESPONSE_TIMEOUT, req.send())
        .await
        .map_err(|_| FetchError::Stalled)??;

    let status = resp.status();
    let (mut out, mut written) = if existing > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT {
        info!(target: "download", file = %spec.name, resume_from = existing, "resuming download");
        let f = fs::OpenOptions::new().append(true).open(partial_path).await?;
        (f, existing)
    } else if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // Our partial is at/past the remote size — it can't be right. Restart.
        warn!(target: "download", file = %spec.name, existing, "range not satisfiable; restarting from zero");
        let _ = fs::remove_file(partial_path).await;
        return Err(FetchError::Truncated {
            file: spec.name.to_string(),
            got: 0,
            expected: spec.size_bytes,
        });
    } else if status.is_success() {
        if existing > 0 {
            info!(target: "download", file = %spec.name, "server ignored Range; restarting from zero");
        }
        (fs::File::create(partial_path).await?, 0)
    } else {
        let body = resp.text().await.unwrap_or_default();
        let body = body.chars().take(300).collect::<String>();
        return Err(FetchError::Http {
            file: spec.name.to_string(),
            status: status.as_u16(),
            body,
        });
    };

    let mut stream = resp.bytes_stream();
    let mut last_emit = Instant::now();
    let mut bytes_since_emit: u64 = 0;
    on_progress(written, false);

    loop {
        let next = tokio::time::timeout(STALL_TIMEOUT, stream.next()).await;
        let chunk = match next {
            Err(_) => {
                out.flush().await?;
                return Err(FetchError::Stalled);
            }
            Ok(None) => break,
            Ok(Some(c)) => c?,
        };
        out.write_all(&chunk).await?;
        written = written.saturating_add(chunk.len() as u64);
        bytes_since_emit = bytes_since_emit.saturating_add(chunk.len() as u64);
        // Emit at most every 64 KiB or every 100 ms.
        if bytes_since_emit >= 64 * 1024 || last_emit.elapsed().as_millis() >= 100 {
            on_progress(written, false);
            last_emit = Instant::now();
            bytes_since_emit = 0;
        }
    }

    out.flush().await?;
    on_progress(written, false);
    Ok(())
}

/// Streaming SHA-256 of a file (1 MiB reads).
async fn sha256_of(path: &Path) -> Result<String, FetchError> {
    let mut f = fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(hasher.finalize().as_slice()))
}

pub fn hex_lower(bytes: &[u8]) -> String {
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
    fn backoff_grows_and_caps() {
        assert_eq!(backoff(1), Duration::from_secs(2));
        assert_eq!(backoff(2), Duration::from_secs(4));
        assert_eq!(backoff(3), Duration::from_secs(8));
        assert_eq!(backoff(4), Duration::from_secs(15));
        assert_eq!(backoff(40), Duration::from_secs(15));
    }

    #[test]
    fn retryability_matches_failure_kind() {
        assert!(FetchError::Stalled.is_retryable());
        assert!(FetchError::Network("reset".into()).is_retryable());
        assert!(FetchError::Truncated {
            file: "f".into(),
            got: 1,
            expected: 2
        }
        .is_retryable());
        assert!(FetchError::Http {
            file: "f".into(),
            status: 503,
            body: String::new()
        }
        .is_retryable());
        assert!(!FetchError::Http {
            file: "f".into(),
            status: 404,
            body: String::new()
        }
        .is_retryable());
        assert!(!FetchError::HashMismatch {
            file: "f".into(),
            expected: "a".into(),
            actual: "b".into()
        }
        .is_retryable());
        assert!(!FetchError::DiskSpace {
            needed: 1,
            available: 0
        }
        .is_retryable());
    }

    #[test]
    fn complete_file_tolerates_revision_drift_but_not_truncation() {
        let tmp = std::env::temp_dir().join("echoscribe_complete_file_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let p = tmp.join("model.bin");

        assert!(!is_complete_file(&p, 1000), "missing file is incomplete");

        std::fs::write(&p, vec![0u8; 0]).unwrap();
        assert!(!is_complete_file(&p, 0), "0-byte file is never complete");

        std::fs::write(&p, vec![0u8; 995]).unwrap();
        assert!(
            is_complete_file(&p, 1000),
            "a file within 10% of expected (old upstream revision) still counts"
        );

        std::fs::write(&p, vec![0u8; 500]).unwrap();
        assert!(!is_complete_file(&p, 1000), "a half-downloaded file does not");

        std::fs::write(&p, vec![0u8; 42]).unwrap();
        assert!(is_complete_file(&p, 0), "unknown expected size: presence + non-empty");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn friendly_messages_are_human() {
        let msg = FetchError::DiskSpace {
            needed: 3_662_000_000,
            available: 1_100_000_000,
        }
        .friendly();
        assert!(msg.contains("3.7 GB"), "{msg}");
        assert!(msg.contains("1.1 GB"), "{msg}");
        let msg = FetchError::Stalled.friendly();
        assert!(msg.contains("resumes"), "{msg}");
        assert!(!msg.contains("error sending request"), "no raw reqwest text");
    }

    #[test]
    fn dir_bytes_sums_files_and_is_zero_when_missing() {
        let tmp = std::env::temp_dir().join("echoscribe_engine_dir_bytes_test");
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(dir_bytes(&tmp), 0);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("model.gguf.partial"), vec![0u8; 1000]).unwrap();
        std::fs::write(tmp.join("notes.txt"), vec![0u8; 24]).unwrap();
        assert_eq!(dir_bytes(&tmp), 1024);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
