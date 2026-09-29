//! App-wide tagging ownership. A stopped run stays paused until a manual start.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};

#[derive(Clone, Default, serde::Serialize)]
pub struct Status {
    pub running: bool,
    pub stopping: bool,
    pub paused: bool,
    pub processed: u32,
    pub total: u32,
    pub assigned: u32,
}
#[derive(Default)]
struct Inner {
    status: Status,
    cancel: Option<Arc<AtomicBool>>,
}
#[derive(Default)]
pub struct Controller(Mutex<Inner>);

pub fn global() -> &'static Arc<Controller> {
    static CONTROL: OnceLock<Arc<Controller>> = OnceLock::new();
    CONTROL.get_or_init(|| Arc::new(Controller::default()))
}
impl Controller {
    pub fn status(&self) -> Status {
        self.0.lock().unwrap().status.clone()
    }
    pub fn begin(self: &Arc<Self>, manual: bool) -> Option<Run> {
        let mut inner = self.0.lock().unwrap();
        if inner.status.running || (!manual && inner.status.paused) {
            return None;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        inner.status = Status {
            running: true,
            ..Default::default()
        };
        inner.cancel = Some(cancel.clone());
        Some(Run {
            controller: self.clone(),
            cancel,
        })
    }
    pub fn stop(&self) -> Status {
        let mut inner = self.0.lock().unwrap();
        inner.status.paused = true;
        inner.status.stopping = inner.status.running;
        if let Some(cancel) = &inner.cancel {
            cancel.store(true, Ordering::SeqCst);
        }
        inner.status.clone()
    }
}
pub struct Run {
    controller: Arc<Controller>,
    pub cancel: Arc<AtomicBool>,
}
impl Run {
    pub fn stopped(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
    pub fn progress(&self, processed: u32, total: u32, assigned: u32) {
        let mut inner = self.controller.0.lock().unwrap();
        inner.status.processed = processed;
        inner.status.total = total;
        inner.status.assigned = assigned;
    }
}
impl Drop for Run {
    fn drop(&mut self) {
        let mut inner = self.controller.0.lock().unwrap();
        inner.status.running = false;
        inner.status.stopping = false;
        inner.cancel = None;
    }
}

/// Cancellation belongs to this run, never to unrelated foreground AI requests.
pub struct Generator<'a, L: crate::llm::LlmGenerator + ?Sized> {
    pub llm: &'a L,
    pub cancel: Arc<AtomicBool>,
}
impl<L: crate::llm::LlmGenerator + ?Sized> crate::llm::LlmGenerator for Generator<'_, L> {
    fn generate<'a>(&'a self, req: crate::llm::GenerateRequest) -> crate::llm::GenerateFuture<'a> {
        self.llm.generate_cancellable(req, self.cancel.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stop_remains_running_until_work_exits_and_blocks_background_restart() {
        let controller = Arc::new(Controller::default());
        let run = controller.begin(false).unwrap();
        run.progress(3, 25, 2);
        assert!(controller.begin(true).is_none());
        let status = controller.stop();
        assert!(status.running && status.stopping && status.paused);
        assert_eq!(status.processed, 3);
        assert!(run.stopped());
        drop(run);
        assert!(!controller.status().running);
        assert!(controller.begin(false).is_none());
        let next = controller.begin(true).unwrap();
        assert!(!next.stopped());
        assert!(!controller.status().paused);
    }
}
