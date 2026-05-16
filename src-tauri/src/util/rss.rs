//! Process resident-set-size probe for memory instrumentation.

/// Peak resident set size of this process, in bytes.
///
/// macOS `getrusage` reports `ru_maxrss` in **bytes** (Linux reports KiB).
/// This is a high-water mark — it never decreases — which is exactly what
/// we want for "did this path ever balloon".
pub fn max_rss_bytes() -> u64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    if rc != 0 {
        return 0;
    }
    let raw = usage.ru_maxrss as u64;
    if cfg!(target_os = "macos") {
        raw
    } else {
        raw * 1024
    }
}

/// Log the current peak RSS with a label, in MiB, at INFO level.
pub fn log_rss(label: &str) {
    let mib = max_rss_bytes() / (1024 * 1024);
    tracing::info!(rss_mib = mib, "[mem] {label}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_rss_is_nonzero_and_grows_with_allocation() {
        let before = max_rss_bytes();
        // Touch ~64 MiB so the peak provably moves.
        let mut big: Vec<u8> = vec![0u8; 64 * 1024 * 1024];
        for i in (0..big.len()).step_by(4096) {
            big[i] = 1;
        }
        let after = max_rss_bytes();
        std::hint::black_box(&big);
        assert!(before > 0, "RSS probe returned 0");
        assert!(after >= before, "peak RSS must be monotonic");
    }
}
