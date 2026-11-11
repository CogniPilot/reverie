//! A failed bind's actual retained owner, not a completed phone or session
//! capability. This module joins the next recovery composition after the
//! frozen lazy-backend checkpoint; no raw constructor is exported.
use super::*;
#[must_use = "retain and close the exact failed Office construction"]
pub struct OfficeConstruction {
    id: u64,
    owned: Arc<OwnedOffice>,
    origin: Arc<Company>,
}
pub struct OfficeBindFailure {
    pub(super) error: OfficeError,
    construction: Option<OfficeConstruction>,
}
impl OfficeBindFailure {
    pub fn error(&self) -> &OfficeError {
        &self.error
    }
    pub fn into_parts(self) -> (OfficeError, Option<OfficeConstruction>) {
        (self.error, self.construction)
    }
}
impl OfficeConstruction {
    pub(super) fn captured(service: &OfficeService, id: u64, owned: &Arc<OwnedOffice>) -> Self {
        Self {
            id,
            owned: owned.clone(),
            origin: service.company.clone(),
        }
    }
}
impl OfficeService {
    /// Bind only beneath the socket root captured by the actual worker
    /// constructor. Directory effects occur at this late phone phase; neither
    /// an arbitrary directory nor a second configuration is accepted here.
    pub fn bind_worker_retained(
        &self,
        session: ProfileSessionId,
    ) -> std::result::Result<OfficePhone, OfficeBindFailure> {
        self.bind_worker_retained_scoped(session, None)
    }
    /// Bound admission and construction by the original recovery deadline.
    pub fn bind_worker_retained_until(
        &self,
        session: ProfileSessionId,
        end: Instant,
    ) -> std::result::Result<OfficePhone, OfficeBindFailure> {
        self.bind_worker_retained_scoped(session, Some(end))
    }
    fn bind_worker_retained_scoped(
        &self,
        session: ProfileSessionId,
        inherited_end: Option<Instant>,
    ) -> std::result::Result<OfficePhone, OfficeBindFailure> {
        let directory = self
            .require_running()
            .and_then(|()| {
                self.require_bind_deadline(inherited_end)?;
                let root = self
                    .company
                    .worker_socket_root
                    .as_ref()
                    .ok_or(OfficeError::Refused)?;
                worker_path::prepare(root, &session)
            })
            .map_err(|error| OfficeBindFailure {
                error,
                construction: None,
            })?;
        self.bind_retained_scoped(directory, session, inherited_end)
    }
    /// Same original constructor sequence; the private bind owner records an
    /// actual registry insertion before any thread can start or fail.
    pub fn bind_retained(
        &self,
        directory: PathBuf,
        session: ProfileSessionId,
    ) -> std::result::Result<OfficePhone, OfficeBindFailure> {
        self.bind_retained_scoped(directory, session, None)
    }
    fn bind_retained_scoped(
        &self,
        directory: PathBuf,
        session: ProfileSessionId,
        inherited_end: Option<Instant>,
    ) -> std::result::Result<OfficePhone, OfficeBindFailure> {
        let mut construction = None;
        self.bind_attempt(directory, session, inherited_end, &mut construction)
            .map_err(|error| OfficeBindFailure {
                error,
                construction,
            })
    }
    pub fn close_construction(
        &self,
        construction: &OfficeConstruction,
        deadline: Instant,
    ) -> Result<()> {
        if !Arc::ptr_eq(&construction.origin, &self.company) {
            return Err(OfficeError::Refused);
        }
        let mut offices = lock_until(&self.offices, self.deadline(deadline))?;
        let Some(owned) = offices.get(&construction.id) else {
            // A Company sweep may already have removed this exact known-close
            // owner. The genuine token still retains its original close latch.
            return close(&construction.owned, self.deadline(deadline));
        };
        if !Arc::ptr_eq(owned, &construction.owned) {
            return Err(OfficeError::Refused);
        }
        close(owned, self.deadline(deadline))?;
        offices.remove(&construction.id);
        Ok(())
    }
}
