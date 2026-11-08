//! Pure r12 cleanup configuration and observation contracts.
//!
//! These values confer no filesystem custody, lease, or delete authority. The
//! future native adapter must capture and recheck facts, confine test paths,
//! and enforce the separately reviewed registry/lease/delete boundaries.
mod admission;
mod config;
mod reasons;
pub use admission::{AdmissionError, MountObservation, RootAnchor, RootObservation};
pub use config::{Config, ConfigError, Mode, Pass, RootIdentity};
pub use reasons::{ExitCode, Reason, ordered_reasons};
