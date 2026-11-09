use std::fmt;

/// Safe transport failures only. An error, including a lost reply or failed
/// closure, never establishes that a requested effect did not occur.
#[derive(Debug)]
pub struct ControlError {
    message: &'static str,
    causes: Vec<ControlError>,
}
impl ControlError {
    pub(crate) fn new(message: &'static str) -> Self {
        Self {
            message,
            causes: Vec::new(),
        }
    }
    pub fn message(&self) -> &'static str {
        self.message
    }
    /// Original safe failures retained by checked transport finalization.
    pub fn causes(&self) -> &[Self] {
        &self.causes
    }
    pub(crate) fn finalized<T>(
        result: crate::Result<T>,
        cleanup: crate::Result<()>,
    ) -> crate::Result<T> {
        match (result, cleanup) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(mut error), Err(cleanup)) => {
                error.causes.push(cleanup);
                Err(error)
            }
        }
    }
    pub(crate) fn connection_finished<T>(
        result: crate::Result<T>,
        cleanup: [crate::Result<()>; 2],
    ) -> crate::Result<T> {
        let mut causes: Vec<Self> = cleanup
            .into_iter()
            .filter_map(std::result::Result::err)
            .collect();
        if causes.is_empty() {
            return result;
        }
        if let Err(error) = result {
            causes.insert(0, error);
        }
        Err(Self {
            message: "Worker connection closure unconfirmed",
            causes,
        })
    }
}
impl fmt::Display for ControlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}
impl std::error::Error for ControlError {}
impl From<std::io::Error> for ControlError {
    fn from(_: std::io::Error) -> Self {
        Self::new("OSError")
    }
}
impl From<serde_json::Error> for ControlError {
    fn from(_: serde_json::Error) -> Self {
        Self::new("Invalid worker response")
    }
}
