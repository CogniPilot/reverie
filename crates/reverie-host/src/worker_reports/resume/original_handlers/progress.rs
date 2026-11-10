use super::*;

impl WorkerOriginalHandlersDrain {
    /// Advance only unfinished rows of this SAME retained operation. The
    /// original per-row issued flags, records, budget and error owners remain
    /// authoritative; a completed shutdown is never issued a second time.
    pub fn advance_interruption(
        &mut self,
        channel: &WorkerActorChannel,
        expected: &Arc<WorkerReportService>,
        runtime: &WorkerRuntime,
    ) -> DrainResult<WorkerOriginalInterruptionProgress> {
        let originals = self.originals();
        if !Arc::ptr_eq(expected, &originals.selection.service)
            || !Arc::ptr_eq(&channel.connection.record, &originals.selection.own)
            || channel.purpose != Purpose::FleetMaintenanceWebsite
        {
            return Err(self.primary(WorkerReportError::Unconfirmed));
        }
        if let Err(cause) = self.assert_runtime(runtime) {
            return Err(self.primary(cause));
        }
        self.interrupt(channel, expected, runtime)?;
        Ok(if self.admitted && self.interrupted {
            WorkerOriginalInterruptionProgress::Issued
        } else {
            WorkerOriginalInterruptionProgress::Pending
        })
    }
    fn forward_current(
        &self,
        channel: &WorkerActorChannel,
        expected: &Arc<WorkerReportService>,
        runtime: &WorkerRuntime,
    ) -> Result<bool> {
        self.assert_runtime(runtime)?;
        let originals = self.originals();
        if !Arc::ptr_eq(expected, &originals.selection.service)
            || !Arc::ptr_eq(&channel.connection.record, &originals.selection.own)
            || channel.purpose != Purpose::FleetMaintenanceWebsite
            || channel.close != ClosePhase::Open
            || Instant::now() >= self.deadline(runtime)?
        {
            return Err(WorkerReportError::Unconfirmed);
        }
        channel.assert_service(expected)?;
        channel.require_connected()?;
        let records = match expected.records.try_lock() {
            Ok(records) => records,
            Err(TryLockError::WouldBlock) => return Ok(false),
            Err(TryLockError::Poisoned(_)) => {
                expected.opaque.store(true, Ordering::Release);
                return Err(WorkerReportError::Unconfirmed);
            }
        };
        if !records
            .iter()
            .any(|row| Arc::ptr_eq(row, &originals.selection.own))
        {
            return Err(WorkerReportError::Unconfirmed);
        }
        Ok(true)
    }
    /// Authorized forward phase only. Each selected socket gets at most one
    /// actual shutdown attempt. A contended, not-issued attempt stays Pending.
    /// The App must supply its actual consent/fence before calling this method.
    pub fn interrupt(
        &mut self,
        channel: &WorkerActorChannel,
        expected: &Arc<WorkerReportService>,
        runtime: &WorkerRuntime,
    ) -> DrainResult<WorkerHandlersProgress> {
        if let Some(cause) = self.primary.as_ref().or(self.cleanup.as_ref()) {
            return Err(Rc::clone(cause));
        }
        if self.interrupted {
            return Ok(WorkerHandlersProgress::Pending);
        }
        let count = self.originals().selection.records.len();
        for index in 0..count.max(1) {
            match self.forward_current(channel, expected, runtime) {
                Ok(true) => self.admitted = true,
                Ok(false) => return Ok(WorkerHandlersProgress::Pending),
                Err(cause) => return Err(self.primary(cause)),
            }
            if index >= count || self.originals().selected[index].interrupted {
                continue;
            }
            let originals = self.originals();
            let result = originals.selection.records[index]
                .try_interrupt_original(&originals.selection.service, originals.end);
            let row = &mut self
                .originals
                .as_mut()
                .expect("original rows retained")
                .selected[index];
            match result {
                Ok(issued) => row.interrupted = issued,
                Err(cause) => {
                    row.interrupted = true;
                    let cause = Rc::new(cause);
                    row.primary = Some(Rc::clone(&cause));
                    self.primary.get_or_insert(cause);
                }
            }
        }
        self.interrupted = self.originals().selected.iter().all(|row| row.interrupted);
        self.primary
            .as_ref()
            .map_or(Ok(WorkerHandlersProgress::Pending), |cause| {
                Err(Rc::clone(cause))
            })
    }
    fn primary(&mut self, cause: WorkerReportError) -> Rc<WorkerReportError> {
        Rc::clone(self.primary.get_or_insert_with(|| Rc::new(cause)))
    }
    fn cleanup(&mut self, cause: WorkerReportError) -> Rc<WorkerReportError> {
        Rc::clone(self.cleanup.get_or_insert_with(|| Rc::new(cause)))
    }
    /// Settle ONLY the selected original jobs. No live Q, fresh deadline, new
    /// capture or service cancellation is needed. Responses carry no closure.
    pub fn settle(&mut self, runtime: &WorkerRuntime) -> DrainResult<WorkerHandlersProgress> {
        if let Err(cause) = self.assert_runtime(runtime) {
            return Err(self.cleanup(cause));
        }
        if !self.admitted {
            return Err(self.cleanup(WorkerReportError::Unconfirmed));
        }
        let live = Instant::now() < self.deadline(runtime).map_err(Rc::new)?;
        let mut settled = true;
        for index in 0..self.originals().selection.records.len() {
            match self.settle_original(index, live) {
                Ok(known) => settled &= known,
                Err(cause) => {
                    settled = false;
                    let row = &mut self
                        .originals
                        .as_mut()
                        .expect("same originals retained")
                        .selected[index];
                    let cause = Rc::clone(row.cleanup.get_or_insert_with(|| Rc::new(cause)));
                    self.cleanup.get_or_insert(cause);
                }
            }
        }
        match self.current_registry_settled() {
            Ok(known) => settled &= known,
            Err(cause) => {
                settled = false;
                self.cleanup(cause);
            }
        }
        self.settled = settled;
        if let Some(cause) = &self.cleanup {
            return Err(Rc::clone(cause));
        }
        Ok(if settled {
            WorkerHandlersProgress::Settled
        } else {
            WorkerHandlersProgress::Pending
        })
    }
    fn settle_original(&mut self, index: usize, live: bool) -> Result<bool> {
        let record = Arc::clone(&self.originals().selection.records[index]);
        let row = &mut self
            .originals
            .as_mut()
            .expect("selected originals retained")
            .selected[index];
        let job = match record.handler_job() {
            Ok(Some(job)) => job,
            Ok(None) => return Ok(false),
            Err(_) if !record.opaque() => return Ok(false),
            Err(cause) => return Err(cause),
        };
        if live && !row.reconciled && !job.known_settled() {
            row.reconciled = job.try_reconcile_original()?;
        }
        let joined = job.join_once()?;
        if record.opaque() {
            return Err(WorkerReportError::Unconfirmed);
        }
        Ok(joined && record.settled())
    }
    fn current_registry_settled(&self) -> Result<bool> {
        let originals = self.originals();
        if originals.selection.service.opaque.load(Ordering::Acquire) {
            return Err(WorkerReportError::Unconfirmed);
        }
        let records = match originals.selection.service.records.try_lock() {
            Ok(records) => records,
            Err(TryLockError::WouldBlock) => return Ok(false),
            Err(TryLockError::Poisoned(_)) => {
                originals
                    .selection
                    .service
                    .opaque
                    .store(true, Ordering::Release);
                return Err(WorkerReportError::Unconfirmed);
            }
        };
        for record in records
            .iter()
            .filter(|record| !Arc::ptr_eq(record, &originals.selection.own))
        {
            if record.opaque() {
                return Err(WorkerReportError::Unconfirmed);
            }
            let job = match record.handler_job() {
                Ok(Some(job)) => job,
                Ok(None) => return Ok(false),
                Err(_) if !record.opaque() => return Ok(false),
                Err(cause) => return Err(cause),
            };
            let known = job.known_settled() && record.settled();
            if record.opaque() {
                return Err(WorkerReportError::Unconfirmed);
            }
            if !known {
                return Ok(false);
            }
        }
        Ok(!originals.selection.service.opaque.load(Ordering::Acquire))
    }
}
