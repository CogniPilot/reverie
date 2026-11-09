use std::{
    io::{self, Write},
    path::Path,
};
pub(super) fn run(source: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let report = reverie_application::worker_inventory::read_owner_inventory(source)?;
    let mut out = io::stdout().lock();
    out.write_all(report.bytes())?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}
