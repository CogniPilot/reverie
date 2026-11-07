//! Shutdown observation data, never a release permit or effect/save receipt.
//! Owners keep their existing sticky negative fences independently of this
//! distinction. Only an actual successful close can produce Complete.
#[derive(Debug)]
#[must_use = "retain Pending work; Refused permits only negative termination"]
pub enum ShutdownStatus<E> {
    Complete,
    Pending(E),
    Refused(E),
}
impl<E> ShutdownStatus<E> {
    pub fn into_result(self) -> Result<(), E> {
        match self {
            Self::Complete => Ok(()),
            Self::Pending(error) | Self::Refused(error) => Err(error),
        }
    }
}
