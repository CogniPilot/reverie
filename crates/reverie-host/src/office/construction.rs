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
    /// Same original constructor sequence; the private bind owner records an
    /// actual registry insertion before any thread can start or fail.
    pub fn bind_retained(
        &self,
        directory: PathBuf,
        session: ProfileSessionId,
    ) -> std::result::Result<OfficePhone, OfficeBindFailure> {
        let mut construction = None;
        self.bind_attempt(directory, session, &mut construction)
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
