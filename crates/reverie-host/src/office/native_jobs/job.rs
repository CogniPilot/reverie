use super::{OfficeError, Purpose, RequestLifetime, Result};
use crate::{
    captured_client::CapturedCall,
    installed_worker_engine::InstalledWorkerEngine,
    worker_recovery::{self, WorkerRecoveryError},
};
use reverie_contracts::worker_recovery::OfficeAddressData;
use std::{
    net::{SocketAddr, ToSocketAddrs},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
#[derive(Clone)]
pub(in crate::office) enum NativeValue {
    Address(OfficeAddressData, Instant),
    Socket(Vec<SocketAddr>),
}
type Output = std::result::Result<NativeValue, Arc<OfficeError>>;
struct PendingCall {
    engine: Arc<InstalledWorkerEngine>,
    call: CapturedCall,
}
struct Completed {
    output: Output,
    call: Option<PendingCall>,
    uncertain: bool,
}
pub(in crate::office) struct NativeJob {
    owner: Weak<RequestLifetime>,
    waiters: Mutex<Vec<Arc<RequestLifetime>>>,
    output: Mutex<Option<Output>>,
    call: Mutex<Option<PendingCall>>,
    uncertain: AtomicBool,
    thread: Mutex<Option<JoinHandle<()>>>,
    joined: AtomicBool,
    join_failed: AtomicBool,
}
impl NativeJob {
    pub(super) fn new(lifetime: Arc<RequestLifetime>) -> Arc<Self> {
        Arc::new(Self {
            owner: Arc::downgrade(&lifetime),
            waiters: Mutex::new(vec![lifetime]),
            output: Mutex::new(None),
            call: Mutex::new(None),
            uncertain: AtomicBool::new(false),
            thread: Mutex::new(None),
            joined: AtomicBool::new(false),
            join_failed: AtomicBool::new(false),
        })
    }
    pub(super) fn start(self: &Arc<Self>, purpose: Purpose) -> Result<()> {
        let mut slot = self.thread.lock().map_err(|_| OfficeError::Unconfirmed)?;
        let job = self.clone();
        match std::thread::Builder::new()
            .name("reverie-office-native".into())
            .spawn(move || job.publish(run(purpose)))
        {
            Ok(thread) => *slot = Some(thread),
            Err(error) => {
                *self.output.lock().map_err(|_| OfficeError::Unconfirmed)? =
                    Some(Err(Arc::new(OfficeError::Io(error))));
                self.joined.store(true, Ordering::Release);
                self.waiters
                    .lock()
                    .map_err(|_| OfficeError::Unconfirmed)?
                    .clear();
                return Err(OfficeError::Unconfirmed);
            }
        }
        Ok(())
    }
    fn publish(&self, completed: Completed) {
        self.uncertain.store(completed.uncertain, Ordering::Release);
        *self.call.lock().unwrap_or_else(|error| error.into_inner()) = completed.call;
        *self
            .output
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(completed.output);
    }
    pub(in crate::office) fn retain_waiter(&self, lifetime: Arc<RequestLifetime>) -> Result<()> {
        let mut waiters = self.waiters.lock().map_err(|_| OfficeError::Unconfirmed)?;
        // A waiter racing completed-job reaping must not reintroduce a seat
        // after the registry has confirmed and removed that actual job.
        if self.joined.load(Ordering::Acquire)
            && !self.uncertain.load(Ordering::Acquire)
            && !self.join_failed.load(Ordering::Acquire)
        {
            return Ok(());
        }
        if !waiters.iter().any(|value| Arc::ptr_eq(value, &lifetime)) {
            waiters.push(lifetime);
        }
        Ok(())
    }
    pub(in crate::office) fn is_owner(&self, lifetime: &Arc<RequestLifetime>) -> Result<bool> {
        Ok(Weak::ptr_eq(&self.owner, &Arc::downgrade(lifetime)))
    }
    pub(in crate::office) fn poll(&self) -> Result<Option<Output>> {
        let Ok(mut thread) = self.thread.try_lock() else {
            return Ok(None);
        };
        if thread.as_ref().is_some_and(|value| value.is_finished()) {
            let failed = thread.take().expect("observed own thread").join().is_err();
            self.join_failed.store(failed, Ordering::Release);
            self.joined.store(true, Ordering::Release);
        }
        if !self.joined.load(Ordering::Acquire) {
            return Ok(None);
        }
        if self.join_failed.load(Ordering::Acquire) {
            return Err(OfficeError::Unconfirmed);
        }
        let output = self
            .output
            .try_lock()
            .map_err(|_| OfficeError::Unconfirmed)?
            .clone()
            .ok_or(OfficeError::Unconfirmed)?;
        if !self.uncertain.load(Ordering::Acquire) {
            self.call
                .try_lock()
                .map_err(|_| OfficeError::Unconfirmed)?
                .take();
            self.waiters
                .try_lock()
                .map_err(|_| OfficeError::Unconfirmed)?
                .clear();
        }
        Ok(Some(output))
    }
    pub(super) fn known_settled(&self) -> bool {
        self.poll().is_ok_and(|value| value.is_some())
            && !self.uncertain.load(Ordering::Acquire)
            && !self.join_failed.load(Ordering::Acquire)
    }
    pub(super) fn close(&self, end: Instant) -> Result<()> {
        while self.poll()?.is_none() {
            let remaining = end.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(OfficeError::Unconfirmed);
            }
            std::thread::sleep(remaining.min(Duration::from_millis(5)));
        }
        let mut pending = super::super::lock_until(&self.call, end)?;
        if let Some(owned) = pending.as_ref() {
            let cleanup = owned
                .engine
                .engine
                .client
                .settle_call(&owned.call, end)
                .map_err(|error| {
                    OfficeError::Backend(Arc::new(WorkerRecoveryError::Engine(error.into())))
                });
            if let Err(error) = cleanup {
                let original = self
                    .output
                    .lock()
                    .map_err(|_| OfficeError::Unconfirmed)?
                    .as_ref()
                    .and_then(|value| value.as_ref().err())
                    .cloned();
                return super::super::finalized(
                    original.map_or(Ok(()), |error| Err(OfficeError::Task(error))),
                    Err(error),
                );
            }
        }
        pending.take();
        self.uncertain.store(false, Ordering::Release);
        self.waiters
            .lock()
            .map_err(|_| OfficeError::Unconfirmed)?
            .clear();
        Ok(())
    }
}
fn run(purpose: Purpose) -> Completed {
    match purpose {
        Purpose::Backend { engine, name } => {
            match worker_recovery::inspect_fixed_container_scoped(&engine, &name) {
                Ok(row) => Completed {
                    output: row
                        .office_address_data()
                        .map(|value| NativeValue::Address(value, Instant::now()))
                        .map_err(|error| {
                            Arc::new(OfficeError::Backend(Arc::new(WorkerRecoveryError::Data(
                                error,
                            ))))
                        }),
                    call: None,
                    uncertain: false,
                },
                Err(failure) => {
                    let uncertain = matches!(&failure.error,WorkerRecoveryError::Engine(error) if error.is_uncertain())
                        && failure.call.is_some();
                    Completed {
                        output: Err(Arc::new(OfficeError::Backend(Arc::new(failure.error)))),
                        call: failure.call.map(|call| PendingCall { engine, call }),
                        uncertain,
                    }
                }
            }
        }
        Purpose::Socket(address) => {
            let result = (|| {
                let raw = address.scalar_text().ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "Python socket host encoding",
                    )
                })?;
                let ascii = crate::embeddings::idna::host_to_ascii(&raw).map_err(|_| {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, "Python socket IDNA")
                })?;
                Ok(NativeValue::Socket(
                    (ascii.as_str(), 3000).to_socket_addrs()?.collect(),
                ))
            })();
            Completed {
                output: result.map_err(|error| Arc::new(OfficeError::Io(error))),
                call: None,
                uncertain: false,
            }
        }
    }
}
