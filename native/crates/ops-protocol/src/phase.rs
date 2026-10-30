//! Fork-only phase timing for the index go/no-go experiment (fork issue #11).
//!
//! Disabled unless `DSH_OPS_PHASE_TIMING=1`; the host never sets it, so shipped behaviour is
//! unchanged. The counters are process-global because one worker handles exactly one request.
#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

static ENABLED: AtomicBool = AtomicBool::new(false);
static INIT: AtomicBool = AtomicBool::new(false);

pub static READDIR_NS: AtomicU64 = AtomicU64::new(0);
pub static STAT_NS: AtomicU64 = AtomicU64::new(0);
pub static FILTER_NS: AtomicU64 = AtomicU64::new(0);
pub static STAMP_NS: AtomicU64 = AtomicU64::new(0);
pub static CALLBACK_NS: AtomicU64 = AtomicU64::new(0);

/// Read the opt-in once; a disabled process pays one atomic load per timer.
pub fn enabled() -> bool {
    if !INIT.swap(true, Ordering::Relaxed) {
        let on = std::env::var("DSH_OPS_PHASE_TIMING").map(|value| value == "1").unwrap_or(false);
        ENABLED.store(on, Ordering::Relaxed);
    }
    ENABLED.load(Ordering::Relaxed)
}

/// Add one block's elapsed time to a counter, when timing is on.
pub fn add(counter: &AtomicU64, start: Instant) {
    if enabled() {
        let elapsed = start.elapsed().as_nanos() as u64;
        let _ = counter.fetch_add(elapsed, Ordering::Relaxed);
    }
}

fn ms(counter: &AtomicU64) -> f64 {
    counter.load(Ordering::Relaxed) as f64 / 1_000_000.0
}

/// A per-walk snapshot of the accumulators.
pub fn snapshot() -> serde_json::Value {
    serde_json::json!({
        "readdirMs": ms(&READDIR_NS),
        "statMs": ms(&STAT_NS),
        "filterMs": ms(&FILTER_NS),
        "stampMs": ms(&STAMP_NS),
        "callbackMs": ms(&CALLBACK_NS),
    })
}

/// Emit one machine-readable line to stderr; stdout stays the tool result.
pub fn emit(value: serde_json::Value) {
    if enabled() {
        eprintln!("PHASE {}", value);
    }
}
