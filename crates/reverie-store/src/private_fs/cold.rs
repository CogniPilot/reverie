//! Cold TMP's finite names-only observation. The caller retains the original
//! directory; a separate open description keeps its enumeration offset intact.
use super::*;
use std::time::Instant;

pub(crate) fn cold_directory_names(
    held: &File,
    maximum: usize,
    end: Instant,
) -> Result<Vec<Vec<u8>>> {
    need(Instant::now() < end, StoreFault::StoreBound)?;
    let directory = open_at(
        held.as_raw_fd(),
        OsStr::new("."),
        libc::O_RDONLY | libc::O_DIRECTORY,
        0,
    )
    .map_err(StoreError::io)?;
    scan_directory(directory, Path::new("."), |stream| {
        let mut names = Vec::new();
        loop {
            need(Instant::now() < end, StoreFault::StoreBound)?;
            let Some(name) = next_directory_name(stream)? else {
                return Ok(names);
            };
            need(names.len() < maximum, StoreFault::StoreBound)?;
            names.push(name);
        }
    })
}
