use super::native;
thread_local! { static VIEWER_RELEASE: std::cell::RefCell<Option<std::sync::mpsc::Sender<std::time::Instant>>> = const { std::cell::RefCell::new(None) }; }
pub(crate) fn observe_viewer_release(sender: std::sync::mpsc::Sender<std::time::Instant>) {
    VIEWER_RELEASE.with(|next| *next.borrow_mut() = Some(sender));
}
pub(super) fn viewer_release(end: std::time::Instant) {
    if let Some(sender) = VIEWER_RELEASE.with(|next| next.borrow_mut().take()) {
        let _ = sender.send(end);
    }
}
pub(crate) struct CleanupSlotObservation {
    pub(crate) end: Option<std::time::Instant>,
    pub(crate) released_by_caller: bool,
    pub(crate) same_job: bool,
}
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
#[derive(Clone, Default)]
pub(crate) struct Hooks {
    pub gate: Option<Arc<Gate>>,
    pub starts: Arc<AtomicUsize>,
    pub reap_blocked: Arc<AtomicBool>,
    pub close_failed: Arc<AtomicBool>,
    pub reads: Arc<AtomicUsize>,
    pub preparation_failed: Arc<AtomicBool>,
    pub registration_close_failed: Arc<AtomicBool>,
    pub result_gate: Option<Arc<Gate>>,
    pub handoff_contended: Arc<AtomicBool>,
    pub admission_waited: Arc<AtomicBool>,
}
#[derive(Default)]
pub(crate) struct Gate {
    pub(crate) entered: AtomicBool,
    pub(crate) released: AtomicBool,
}
impl Hooks {
    pub(crate) fn before_result(&self) {
        if let Some(gate) = &self.result_gate {
            gate.entered.store(true, Ordering::Release);
            while !gate.released.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
    pub(crate) fn prepared(
        &self,
        result: std::result::Result<native::Handshake, native::PreparationError>,
    ) -> std::result::Result<native::Handshake, native::PreparationError> {
        if !self.preparation_failed.swap(false, Ordering::SeqCst) {
            return result;
        }
        if let Ok(mut handshake) = result {
            let _ = handshake.finish();
        }
        Err(native::PreparationError { close_failed: true })
    }
    pub(crate) fn before_spawn(&self) {
        self.starts.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.gate {
            gate.entered.store(true, Ordering::SeqCst);
            while !gate.released.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
    pub(crate) fn defer_reap(&self) -> bool {
        self.reap_blocked.load(Ordering::SeqCst)
    }
    pub(crate) fn closed(&self, index: usize, value: std::io::Result<()>) -> std::io::Result<()> {
        if index == 0 && self.close_failed.swap(false, Ordering::SeqCst) {
            Err(std::io::Error::from_raw_os_error(libc::EIO))
        } else {
            value
        }
    }
    pub(crate) fn registration_closed(&self, value: std::io::Result<()>) -> std::io::Result<()> {
        if self.registration_close_failed.swap(false, Ordering::SeqCst) {
            Err(std::io::Error::from_raw_os_error(libc::EIO))
        } else {
            value
        }
    }
}

/// An actual admitted sibling on the same private capture. Test verdicts run
/// only after releasing and joining it; no fake Busy/error is supplied.
pub(crate) struct RunningSibling {
    gate: Arc<Gate>,
    thread: Option<std::thread::JoinHandle<super::Result<super::CapturedOutput>>>,
}
impl RunningSibling {
    pub(crate) fn start(client: Arc<super::CapturedClient>, gate: Arc<Gate>) -> Self {
        let thread = std::thread::spawn(move || {
            client.run(
                Vec::new(),
                std::time::Instant::now() + Duration::from_secs(5),
                &super::CancellationToken::new(),
                super::Policy {
                    maximum: Duration::from_secs(5),
                    maximum_output: 4 * 1024 * 1024,
                    successful_exit: false,
                },
            )
        });
        let owned = Self {
            gate,
            thread: Some(thread),
        };
        let end = std::time::Instant::now() + Duration::from_secs(3);
        while !owned.gate.entered.load(Ordering::Acquire) {
            assert!(std::time::Instant::now() < end, "actual sibling admitted");
            std::thread::sleep(Duration::from_millis(1));
        }
        owned
    }
    pub(crate) fn release(mut self) -> super::Result<super::CapturedOutput> {
        self.gate.released.store(true, Ordering::Release);
        self.thread.take().unwrap().join().unwrap()
    }
}
impl Drop for RunningSibling {
    fn drop(&mut self) {
        self.gate.released.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
