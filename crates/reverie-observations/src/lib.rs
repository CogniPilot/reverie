//! USER observation custody (`cleanup/collector_user.py`), the bounded
//! history reader (`cleanup/collector_history.py`) over owned files, and the
//! collector state initializer (`cleanup/collector_state.py`). Projections
//! and output text are data in `reverie_contracts`.
pub mod collector;
pub mod collector_state;
mod custody;
mod source;
pub mod user;

pub use custody::{Owner, canonical_config};
pub use source::{Store, query};

/// Every refusal; the command reports only `Resource history unavailable`.
pub use reverie_contracts::resource_history::HistoryRefused as Refused;
