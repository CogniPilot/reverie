//! Retain an existing registered phone without constructing another server.
//! Every alias shares the actual close fence and has no independent close credit.
use super::*;
impl OfficeService {
    pub fn retain_phone(&self, phone: &OfficePhone) -> Result<OfficePhone> {
        self.require_running()?;
        if !Arc::ptr_eq(&phone.origin, &self.company.engine) {
            return Err(OfficeError::Refused);
        }
        let offices = lock_until(
            &self.offices,
            self.deadline(Instant::now() + Duration::from_secs(20)),
        )?;
        let owned = offices.get(&phone.id).ok_or(OfficeError::Closed)?;
        if !Arc::ptr_eq(owned, &phone.owned) {
            return Err(OfficeError::Refused);
        }
        if owned.closing.load(Ordering::Acquire) || owned.first_close.get().is_some() {
            return Err(OfficeError::Closed);
        }
        self.require_running()?;
        Ok(OfficePhone {
            id: phone.id,
            owned: owned.clone(),
            origin: phone.origin.clone(),
            session: phone.session.clone(),
            endpoint: phone.endpoint.clone(),
        })
    }
}
