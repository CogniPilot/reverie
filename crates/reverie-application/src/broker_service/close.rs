//! Whole-service close in the legacy `serve()` finally order, on the single
//! first-stop budget. Every unconfirmed step is reported as its legacy code,
//! and every unfinished join owner stays retained by the service, so a later
//! `settle_retained` observes the same attempts against the same deadline.
use super::{BrokerService, DRAIN, Record, ServiceError};
use reverie_host::broker_listener::BoundSocket;
use std::{
    net::Shutdown,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

const WATCHDOG_JOIN: Duration = Duration::from_secs(5);
const LEASE_JOIN: Duration = Duration::from_secs(1);
const POLL: Duration = Duration::from_millis(5);

impl BrokerService {
    pub(super) fn close(&self, bound: Option<&mut BoundSocket>) -> Result<(), ServiceError> {
        self.closing.store(true, Ordering::Release);
        let deadline = self.deadline();
        let mut codes = Vec::new();
        self.start_lease_close();
        if !self.core.request_office_close() {
            codes.push("OFFICE_CLOSE_FAILED");
        }
        // Interrupt every live connection, then drain within the budget.
        for stream in self.live_streams() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        let drain = deadline.min(Instant::now() + DRAIN);
        while !self.all_finished() && Instant::now() < drain {
            std::thread::sleep(POLL);
        }
        if !self.core.request_office_close() || !self.core.close_offices(deadline) {
            codes.push("OFFICE_CLOSE_FAILED");
        }
        self.core.reap_viewers();
        codes.extend(self.observe(
            deadline.min(Instant::now() + WATCHDOG_JOIN),
            deadline.min(Instant::now() + LEASE_JOIN),
            deadline,
        ));
        codes.extend(self.core.settle(deadline));
        if Instant::now() >= deadline {
            codes.push("DEADLINE_EXHAUSTED");
        }
        if let Some(bound) = bound
            && bound.remove().is_err()
        {
            codes.push("SOCKET_UNCONFIRMED");
        }
        outcome(codes)
    }
    /// Observe the retained watchdog, lease-close and handler owners again,
    /// without any new close effect and on the original deadline. Owners still
    /// running stay retained; failed joins stay reported.
    pub fn settle_retained(&self) -> Result<(), ServiceError> {
        let deadline = self.retain().deadline;
        let Some(deadline) = deadline else {
            return Err(ServiceError::Unconfirmed(vec!["CLOSE_NOT_STARTED"]));
        };
        outcome(self.observe(deadline, deadline, deadline))
    }
    /// The one first-stop deadline, captured at the first close.
    fn deadline(&self) -> Instant {
        let mut retained = self.retain();
        *retained
            .deadline
            .get_or_insert_with(|| self.core.request_stop())
    }
    /// The lease close is attempted once, ever, on its own thread.
    fn start_lease_close(&self) {
        let mut retained = self.retain();
        if retained.lease_started {
            return;
        }
        retained.lease_started = true;
        let core = self.core.clone();
        match std::thread::Builder::new().spawn(move || core.close_lease_peer()) {
            Ok(handle) => retained.lease = Some(handle),
            Err(_) => retained.lease_failed = true,
        }
    }
    fn observe(
        &self,
        watchdog_by: Instant,
        lease_by: Instant,
        handlers_by: Instant,
    ) -> Vec<&'static str> {
        let mut codes = Vec::new();
        wait_until(watchdog_by, || {
            self.retain()
                .watchdog
                .as_ref()
                .is_none_or(|h| h.is_finished())
        });
        {
            let mut retained = self.retain();
            match retained.watchdog.take() {
                Some(handle) if handle.is_finished() => {
                    retained.watchdog_failed |= handle.join().is_err();
                }
                Some(handle) => {
                    retained.watchdog = Some(handle);
                    codes.push("SUPERVISOR_ACTIVE");
                }
                None => (),
            }
            if retained.watchdog_failed {
                codes.push("SUPERVISOR_ACTIVE");
            }
        }
        wait_until(lease_by, || {
            self.retain().lease.as_ref().is_none_or(|h| h.is_finished())
        });
        {
            let mut retained = self.retain();
            match retained.lease.take() {
                Some(handle) if handle.is_finished() => {
                    retained.lease_failed |= !handle.join().unwrap_or(false);
                }
                Some(handle) => {
                    retained.lease = Some(handle);
                    codes.push("LEASE_PEER_ACTIVE");
                }
                None => (),
            }
            if retained.lease_failed {
                codes.push("LEASE_PEER_ACTIVE");
            }
        }
        // Join every handler, finished ones included, on the same budget.
        wait_until(handlers_by, || self.all_finished());
        self.join_finished();
        if !self.all_finished() {
            codes.push("HANDLER_ACTIVE");
        }
        codes
    }
    fn live_streams(&self) -> Vec<std::os::unix::net::UnixStream> {
        self.records()
            .iter()
            .filter_map(|r| r.stream.try_clone().ok())
            .collect()
    }
    pub(super) fn all_finished(&self) -> bool {
        self.records().iter().all(|r| r.handle.is_finished())
    }
    /// Join finished handlers and keep the rest owned.
    pub(super) fn join_finished(&self) {
        let done: Vec<Record> = {
            let mut records = self.records();
            let (done, live) = records.drain(..).partition(|r| r.handle.is_finished());
            *records = live;
            done
        };
        for record in done {
            let _ = record.handle.join();
        }
    }
}
fn wait_until(end: Instant, done: impl Fn() -> bool) {
    while !done() && Instant::now() < end {
        std::thread::sleep(POLL);
    }
}
fn outcome(mut codes: Vec<&'static str>) -> Result<(), ServiceError> {
    codes.sort_unstable();
    codes.dedup();
    if codes.is_empty() {
        Ok(())
    } else {
        Err(ServiceError::Unconfirmed(codes))
    }
}
