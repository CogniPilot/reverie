//! Whole-service close in the legacy `serve()` finally order, on the single
//! first-stop budget. Every unconfirmed step is reported as its legacy code;
//! nothing is dropped as if it had settled.
use super::{BrokerService, DRAIN, Record, ServiceError};
use reverie_host::broker_listener::BoundSocket;
use std::{
    net::Shutdown,
    sync::{TryLockError, atomic::Ordering},
    thread::JoinHandle,
    time::{Duration, Instant},
};

const WATCHDOG_JOIN: Duration = Duration::from_secs(5);
const LEASE_JOIN: Duration = Duration::from_secs(1);
const POLL: Duration = Duration::from_millis(5);

impl BrokerService {
    pub(super) fn close(
        &self,
        bound: Option<BoundSocket>,
        watchdog: Option<JoinHandle<()>>,
    ) -> Result<(), ServiceError> {
        self.closing.store(true, Ordering::Release);
        let deadline = self.core.request_stop();
        let mut codes = Vec::new();
        let lease = {
            let core = self.core.clone();
            std::thread::Builder::new().spawn(move || core.close_lease_peer())
        };
        if lease.is_err() {
            codes.push("LEASE_PEER_ACTIVE");
        }
        if !self.core.request_office_close() {
            codes.push("OFFICE_CLOSE_FAILED");
        }
        // Interrupt every live connection, then drain within the budget.
        match lock_until(self, deadline) {
            Some(streams) => {
                for stream in streams {
                    let _ = stream.shutdown(Shutdown::Both);
                }
            }
            None => codes.push("LOCK_UNAVAILABLE"),
        }
        let drain = deadline.min(Instant::now() + DRAIN);
        while !self.all_finished() && Instant::now() < drain {
            std::thread::sleep(POLL);
        }
        if !self.core.request_office_close() || !self.core.close_offices(deadline) {
            codes.push("OFFICE_CLOSE_FAILED");
        }
        self.core.reap_viewers();
        if let Some(watchdog) = watchdog
            && !join_by(watchdog, deadline.min(Instant::now() + WATCHDOG_JOIN))
        {
            codes.push("SUPERVISOR_ACTIVE");
        }
        if let Ok(lease) = lease {
            let end = deadline.min(Instant::now() + LEASE_JOIN);
            while !lease.is_finished() && Instant::now() < end {
                std::thread::sleep(POLL);
            }
            if !lease.is_finished() || !lease.join().unwrap_or(false) {
                codes.push("LEASE_PEER_ACTIVE");
            }
        }
        // Join every handler, finished ones included, on the same budget.
        while !self.all_finished() && Instant::now() < deadline {
            std::thread::sleep(POLL);
        }
        self.join_finished();
        codes.extend(self.core.settle(deadline));
        if !self.all_finished() {
            codes.push("HANDLER_ACTIVE");
        }
        if Instant::now() >= deadline {
            codes.push("DEADLINE_EXHAUSTED");
        }
        if let Some(mut bound) = bound
            && bound.remove().is_err()
        {
            codes.push("SOCKET_UNCONFIRMED");
        }
        codes.sort_unstable();
        codes.dedup();
        if codes.is_empty() {
            Ok(())
        } else {
            Err(ServiceError::Unconfirmed(codes))
        }
    }
    pub(super) fn all_finished(&self) -> bool {
        match self.records.lock() {
            Ok(records) => records.iter().all(|r| r.handle.is_finished()),
            Err(_) => false,
        }
    }
    /// Join finished handlers and keep the rest owned.
    pub(super) fn join_finished(&self) {
        let Ok(mut records) = self.records.lock() else {
            return;
        };
        let (done, live): (Vec<Record>, Vec<Record>) =
            records.drain(..).partition(|r| r.handle.is_finished());
        *records = live;
        drop(records);
        for record in done {
            let _ = record.handle.join();
        }
    }
}
fn lock_until(
    service: &BrokerService,
    deadline: Instant,
) -> Option<Vec<std::os::unix::net::UnixStream>> {
    loop {
        match service.records.try_lock() {
            Ok(records) => {
                return Some(
                    records
                        .iter()
                        .filter_map(|r| r.stream.try_clone().ok())
                        .collect(),
                );
            }
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => std::thread::sleep(POLL),
            Err(_) => return None,
        }
    }
}
fn join_by(handle: JoinHandle<()>, end: Instant) -> bool {
    while !handle.is_finished() && Instant::now() < end {
        std::thread::sleep(POLL);
    }
    handle.is_finished() && handle.join().is_ok()
}
