use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

/// Keep symlinked configuration working and validate the object actually opened.
/// A FIFO without a writer must never stall the shared request channel.
pub(crate) fn open(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected a regular configuration file",
        ));
    }
    Ok(file)
}
