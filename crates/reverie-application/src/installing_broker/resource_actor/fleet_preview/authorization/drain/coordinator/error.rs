use super::*;
use crate::installing_broker::pool_controller::BrokerControllerActivationFailure;

pub(super) enum MigrationCause<'a> {
    Authorization(FleetMaintenanceCheckError),
    Gate(GateError),
    Native(Cause),
    Transition(Box<PoolTransitionFailure>),
    Drain(Box<LegacyFleetDrainFailure<'a>>),
    DrainComponent(DrainCause),
    Activation(Box<BrokerControllerActivationFailure>),
    Refused(&'static str),
}
impl MigrationCause<'_> {
    fn code(&self) -> &'static str {
        match self {
            Self::Authorization(cause) => cause.code(),
            Self::Gate(cause) => cause.code(),
            Self::Native(cause) => cause.code(),
            Self::Transition(cause) => cause.cause().code(),
            Self::Drain(cause) => cause.primary_error().code(),
            Self::DrainComponent(cause) => cause.code(),
            Self::Activation(cause) => match cause.as_ref() {
                BrokerControllerActivationFailure::Native(cause) => cause.primary_error().code(),
                BrokerControllerActivationFailure::Bootstrap(cause) => match cause.cause() {
                    BrokerControllerBootstrapCause::Configuration(cause) => cause.code(),
                    BrokerControllerBootstrapCause::Native(cause) => cause.primary_error().code(),
                    BrokerControllerBootstrapCause::Observation(cause) => cause.code(),
                    BrokerControllerBootstrapCause::Refused(code) => code,
                },
            },
            Self::Refused(code) => code,
        }
    }
}
impl PoolMigrationFailure<'_> {
    pub fn code(&self) -> &'static str {
        self.cause.as_ref().expect("original cause").code()
    }
}
impl std::fmt::Debug for PoolMigrationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("PoolMigrationFailure")
            .field(&self.code())
            .finish()
    }
}
impl std::fmt::Display for PoolMigrationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for PoolMigrationFailure<'_> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self.cause.as_ref().expect("original cause") {
            MigrationCause::Authorization(cause) => Some(cause),
            MigrationCause::Gate(cause) => Some(cause),
            MigrationCause::Native(cause) => Some(cause),
            MigrationCause::Transition(cause) => Some(cause.as_ref()),
            MigrationCause::Drain(cause) => Some(cause.primary_error()),
            MigrationCause::DrainComponent(cause) => Some(cause),
            MigrationCause::Activation(cause) => match cause.as_ref() {
                BrokerControllerActivationFailure::Native(cause) => Some(cause.primary_error()),
                BrokerControllerActivationFailure::Bootstrap(cause) => match cause.cause() {
                    BrokerControllerBootstrapCause::Configuration(cause) => Some(cause),
                    BrokerControllerBootstrapCause::Native(cause) => Some(cause.primary_error()),
                    BrokerControllerBootstrapCause::Observation(cause) => Some(cause),
                    BrokerControllerBootstrapCause::Refused(_) => None,
                },
            },
            MigrationCause::Refused(_) => None,
        }
    }
}
