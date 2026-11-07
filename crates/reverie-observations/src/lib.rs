//! USER observation custody (`cleanup/collector_user.py`) and the bounded
//! history reader (`cleanup/collector_history.py`) over owned files. The
//! projection itself is `reverie_contracts::resource_history`, as data. The
//! prune receipts adapter (`cleanup/receipts.py`) is `receipts`.
mod custody;
pub mod receipts;
mod source;

pub use custody::Owner;
pub use source::{Store, query};

/// Every refusal; the command reports only `Resource history unavailable`.
pub use reverie_contracts::resource_history::HistoryRefused as Refused;
