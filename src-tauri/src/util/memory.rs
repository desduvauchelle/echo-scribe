//! Model cache policy. Never evict an engine while its inference lock is held.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static LOW_MEMORY: AtomicBool = AtomicBool::new(false);

pub fn set_low_memory(enabled: bool) {
    LOW_MEMORY.store(enabled, Ordering::Relaxed);
    tracing::info!(target: "mem", enabled, "low-memory mode updated");
}

pub fn low_memory() -> bool {
    LOW_MEMORY.load(Ordering::Relaxed)
}

#[cfg(target_os = "macos")]
fn sysctl<const N: usize>(name: &[u8]) -> Option<[u8; N]> {
    let mut value = [0u8; N];
    let mut size = N;
    // Read-only kernel query. An unavailable key falls back to normal timers.
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr().cast(),
            value.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (result == 0 && size == N).then_some(value)
}

pub fn default_low_memory() -> bool {
    #[cfg(target_os = "macos")]
    {
        return sysctl::<8>(b"hw.memsize\0")
            .map(u64::from_ne_bytes)
            .is_some_and(|bytes| bytes <= 8 * 1024 * 1024 * 1024);
    }
    #[cfg(not(target_os = "macos"))]
    false
}

pub fn under_pressure() -> bool {
    #[cfg(target_os = "macos")]
    {
        // XNU exports dispatch levels: 1 normal, 2 warning, 4 critical.
        return sysctl::<4>(b"kern.memorystatus_vm_pressure_level\0")
            .map(u32::from_ne_bytes)
            .is_some_and(|level| matches!(level, 2 | 4));
    }
    #[cfg(not(target_os = "macos"))]
    false
}

fn timeout(configured: Duration, low: bool, pressure: bool) -> Option<Duration> {
    let cap = if pressure {
        Some(Duration::from_secs(5))
    } else if low {
        Some(Duration::from_secs(30))
    } else {
        None
    };
    match (configured.is_zero(), cap) {
        (true, cap) => cap,
        (false, Some(cap)) => Some(configured.min(cap)),
        (false, None) => Some(configured),
    }
}

pub fn should_unload(idle: Duration, configured: Duration) -> bool {
    timeout(configured, low_memory(), under_pressure()).is_some_and(|limit| idle >= limit)
}

pub fn defer_indexing(foreground_recent: bool) -> bool {
    under_pressure() || (low_memory() && foreground_recent)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normal_policy_preserves_user_timeout_and_keep_loaded() {
        assert_eq!(timeout(Duration::ZERO, false, false), None);
        assert_eq!(
            timeout(Duration::from_secs(300), false, false),
            Some(Duration::from_secs(300))
        );
    }
    #[test]
    fn constrained_policy_caps_even_keep_loaded_without_extending_short_timeouts() {
        assert_eq!(
            timeout(Duration::ZERO, true, false),
            Some(Duration::from_secs(30))
        );
        assert_eq!(
            timeout(Duration::from_secs(300), false, true),
            Some(Duration::from_secs(5))
        );
        assert_eq!(
            timeout(Duration::from_secs(2), true, true),
            Some(Duration::from_secs(2))
        );
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn reads_real_mac_memory_without_allocating_pressure() {
        assert!(
            sysctl::<8>(b"hw.memsize\0")
                .map(u64::from_ne_bytes)
                .unwrap()
                > 0
        );
        assert!(matches!(
            sysctl::<4>(b"kern.memorystatus_vm_pressure_level\0").map(u32::from_ne_bytes),
            Some(1 | 2 | 4)
        ));
    }
}
