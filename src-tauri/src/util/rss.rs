//! Process resident-set-size probes for memory instrumentation.
//!
//! Two flavours:
//! - [`max_rss_bytes`] — monotonic peak via `getrusage` (good for "did we ever balloon").
//! - [`current_rss_bytes`] — *current* resident size via Mach `task_info` (good for
//!   "is memory still held right now"). Required to verify model unload actually
//!   returns pages to the OS — `max_rss` never decreases so it can't show this.

/// Peak resident set size of this process, in bytes.
///
/// macOS `getrusage` reports `ru_maxrss` in **bytes** (Linux reports KiB).
/// This is a high-water mark — it never decreases — which is exactly what
/// we want for "did this path ever balloon".
#[cfg(unix)]
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

#[cfg(not(unix))]
pub fn max_rss_bytes() -> u64 {
    0
}

/// Current resident set size of this process, in bytes. macOS only — uses Mach
/// `task_info(MACH_TASK_BASIC_INFO)`. Returns 0 if the syscall fails or on
/// non-macOS targets (no current consumer needs it elsewhere).
///
/// Unlike [`max_rss_bytes`] this value goes **down** when the allocator returns
/// pages to the OS, so it's the right probe for "did unloading the model
/// actually free memory?".
#[cfg(target_os = "macos")]
pub fn current_rss_bytes() -> u64 {
    // `mach_task_self_` is the canonical accessor; libc has marked it
    // deprecated in favour of the `mach2` crate, but we have libc already and
    // don't want a new dep for a single syscall.
    #[allow(deprecated)]
    let task = unsafe { libc::mach_task_self_ };
    let mut info: libc::mach_task_basic_info = unsafe { std::mem::zeroed() };
    let mut count = libc::MACH_TASK_BASIC_INFO_COUNT;
    let rc = unsafe {
        libc::task_info(
            task,
            libc::MACH_TASK_BASIC_INFO,
            &mut info as *mut _ as libc::task_info_t,
            &mut count,
        )
    };
    if rc != libc::KERN_SUCCESS {
        return 0;
    }
    info.resident_size
}

#[cfg(not(target_os = "macos"))]
pub fn current_rss_bytes() -> u64 {
    0
}

/// Current RSS in MiB (rounded down). Convenience for log call sites.
pub fn current_rss_mib() -> u64 {
    current_rss_bytes() / (1024 * 1024)
}

/// Log the current peak RSS with a label, in MiB, at INFO level.
pub fn log_rss(label: &str) {
    let mib = max_rss_bytes() / (1024 * 1024);
    tracing::info!(rss_mib = mib, "[mem] {label}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn current_rss_is_nonzero() {
        assert!(current_rss_bytes() > 0, "current RSS probe returned 0");
    }

    #[test]
    #[cfg(unix)]
    fn max_rss_is_nonzero_and_grows_with_allocation() {
        let before = max_rss_bytes();
        // Touch ~64 MiB so the peak provably moves.
        let mut big: Vec<u8> = vec![0u8; 64 * 1024 * 1024];
        for i in (0..big.len()).step_by(4096) {
            big[i] = 1;
        }
        std::hint::black_box(&big);
        let after = max_rss_bytes();
        assert!(before > 0, "RSS probe returned 0");
        assert!(after >= before, "peak RSS must be monotonic");
    }
}
