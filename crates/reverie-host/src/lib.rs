//! Linux host observations. Returned data never grants owner or effect authority.
mod native;
mod observation;
pub mod task_perf;

pub use observation::{ObservationError, ObservationFault};
