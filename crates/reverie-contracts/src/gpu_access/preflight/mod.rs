//! Standalone preflight DATA. Its current-generation and report contracts are
//! distinct from the GPU queue: these facts authorize no grant or mutation.
mod cdi;
mod current;
mod laptop;
mod metadata;
mod process;
mod report;
use super::*;
pub use cdi::PreflightCdiData;
pub use current::{PreflightBinding, PreflightSelection};
pub use laptop::{PreflightLaptop, PreflightLaptopData};
pub use metadata::{PreflightCandidate, PreflightImage, PreflightImageLabels};
pub use process::{PreflightProcessData, PreflightProcessStat};
pub use report::{PreflightReport, PreflightReportData};
