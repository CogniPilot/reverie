use super::*;
/// Thread-confined original native facts errors never escape into shared Gate
/// errors. Independent checked-close errors occupy a separate bounded slot.
#[derive(Debug)]
pub enum ActorSetupControlError {
    Refused(&'static str),
    Host(GpuHostError),
    Facts(Rc<ActorSetupFactsError>),
    Data(ActorSetupDataError),
    Finalized {
        primary: Rc<Self>,
        secondary: Rc<Self>,
    },
}
impl ActorSetupControlError {
    pub fn is_uncertain(&self) -> bool {
        match self {
            Self::Host(error) => error.is_uncertain() || error.has_unconfirmed_close(),
            Self::Facts(error) => error.has_unconfirmed_close(),
            Self::Finalized { primary, secondary } => {
                primary.is_uncertain() || secondary.is_uncertain()
            }
            _ => false,
        }
    }
    pub fn has_unconfirmed_close(&self) -> bool {
        match self {
            Self::Host(error) => error.has_unconfirmed_close(),
            Self::Facts(error) => error.has_unconfirmed_close(),
            Self::Finalized { primary, secondary } => {
                primary.has_unconfirmed_close() || secondary.has_unconfirmed_close()
            }
            _ => false,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Host(e) => e.code(),
            Self::Facts(e) => e.code(),
            Self::Data(e) => e.code(),
            Self::Finalized { primary, .. } => primary.code(),
        }
    }
}
impl std::fmt::Display for ActorSetupControlError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ActorSetupControlError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refused(_) => None,
            Self::Host(e) => Some(e),
            Self::Facts(e) => Some(e.as_ref()),
            Self::Data(e) => Some(e),
            Self::Finalized { primary, .. } => Some(primary.as_ref()),
        }
    }
}
#[derive(Default)]
pub(super) struct Causes {
    pub(super) primary: Option<Rc<ActorSetupControlError>>,
    pub(super) cleanup: Option<Rc<ActorSetupControlError>>,
    facts_close_recorded: bool,
}
impl Causes {
    pub(super) fn facts_close(
        &mut self,
        error: Rc<ActorSetupFactsError>,
    ) -> Rc<ActorSetupControlError> {
        if !self.facts_close_recorded {
            self.facts_close_recorded = true;
            let error = Rc::new(ActorSetupControlError::Facts(error));
            self.cleanup = Some(match self.cleanup.take() {
                None => error,
                Some(primary) => Rc::new(ActorSetupControlError::Finalized {
                    primary,
                    secondary: error,
                }),
            });
        }
        self.cleanup
            .as_ref()
            .expect("same original facts close cause")
            .clone()
    }
    pub(super) fn record(&mut self, error: ActorSetupControlError) -> Rc<ActorSetupControlError> {
        self.primary.get_or_insert_with(|| Rc::new(error)).clone()
    }
    pub(super) fn host(&mut self, error: GpuHostError) -> Rc<ActorSetupControlError> {
        if self.primary.is_some() {
            self.cleanup
                .get_or_insert_with(|| Rc::new(ActorSetupControlError::Host(error)));
            self.primary.as_ref().expect("original cause").clone()
        } else {
            self.record(ActorSetupControlError::Host(error))
        }
    }
}
