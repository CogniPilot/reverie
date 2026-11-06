//! Named command-failure telemetry projections; no execution proof or grant.
mod configuration;
mod event;
mod inventory;
mod report;
mod sources;
pub use configuration::configuration;
pub use event::{decode_event, encode_report};
pub use inventory::{inspect_sources, inventory_ids};
pub use report::{build_report, decode_report_request};
pub use sources::{ConfiguredSource, TelemetrySource, create_sources};
use std::fmt;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TelemetryDataError {
    Configuration,
    Boundary,
    Inventory,
    Event,
    Binding,
    Report,
}
impl TelemetryDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Configuration => "TELEMETRY_CONFIG_REFUSED",
            Self::Boundary => "TELEMETRY_BOUNDARY_REFUSED",
            Self::Inventory => "TELEMETRY_INVENTORY_UNCONFIRMED",
            Self::Event => "TELEMETRY_EVENT_REFUSED",
            Self::Binding => "TELEMETRY_BINDING_REFUSED",
            Self::Report => "TELEMETRY_REPORT_REFUSED",
        }
    }
}
impl fmt::Display for TelemetryDataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for TelemetryDataError {}
type Result<T> = std::result::Result<T, TelemetryDataError>;
