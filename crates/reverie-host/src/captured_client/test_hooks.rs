use super::native;
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
