//! Native initial-setup components. None is an installation consent, private
//! writer, service/current-provider grant or a pool-readiness certificate.
use super::*;
mod facts;
mod history;
pub use facts::{ActorSetupFacts, ActorSetupFactsError};
pub use history::{ActorSetupHistoryClosed, ActorSetupHistoryError, ActorSetupHistoryObservation};
