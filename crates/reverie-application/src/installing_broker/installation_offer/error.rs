//! Diagnostics preserve the typed original cause; strings grant no authority.
use super::*;
use std::fmt;
impl BrokerInstallationOfferCause {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Configuration(error) => error.code(),
            Self::Origin(BrokerControllerBootstrapCause::Configuration(error)) => error.code(),
            Self::Origin(BrokerControllerBootstrapCause::Observation(error)) => error.code(),
            Self::Origin(BrokerControllerBootstrapCause::Native(error)) => {
                error.primary_error().code()
            }
            Self::Origin(BrokerControllerBootstrapCause::Refused(code)) | Self::Refused(code) => {
                code
            }
            Self::NativeOrigin => "POOL_INSTALLATION_NATIVE_ORIGIN_RETAINED",
            Self::Random(error) => error.code(),
        }
    }
}
impl fmt::Debug for BrokerInstallationOfferCause {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_tuple("BrokerInstallationOfferCause")
            .field(&self.code())
            .finish()
    }
}
impl fmt::Display for BrokerInstallationOfferCause {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for BrokerInstallationOfferCause {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Configuration(error) => Some(error),
            Self::Origin(BrokerControllerBootstrapCause::Configuration(error)) => Some(error),
            Self::Origin(BrokerControllerBootstrapCause::Observation(error)) => Some(error),
            Self::Origin(BrokerControllerBootstrapCause::Native(error)) => {
                Some(error.primary_error())
            }
            Self::Random(error) => Some(error),
            Self::Origin(BrokerControllerBootstrapCause::Refused(_))
            | Self::NativeOrigin
            | Self::Refused(_) => None,
        }
    }
}
