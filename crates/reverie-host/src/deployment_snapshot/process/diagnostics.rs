//! Test-only stderr for owned synthetic fixtures. Production tools retain null
//! stderr. Delivery uses the shared bounded diagnostic owner after finalization.
use super::*;
const MAX_STDERR: u64 = 16_384;
pub(super) fn attach(
    command: &mut Command,
    directory: Option<&Arc<Directory>>,
    files: Vec<File>,
) -> Result<Vec<File>> {
    let output = match directory
        .ok_or_else(|| SnapshotError::refused("SNAPSHOT_TEST_OUTPUT"))
        .and_then(|directory| directory.temporary())
    {
        Ok(file) => file,
        Err(error) => return super::super::combine(Err(error), close_files(files)),
    };
    let (output, child) = match super::super::retain_file(output, |file| Ok(file.try_clone()?)) {
        Ok(value) => value,
        Err(error) => return super::super::combine(Err(error), close_files(files)),
    };
    command.stderr(child);
    let mut files = files;
    files.push(output);
    Ok(files)
}
pub(super) fn bound(files: &[File]) -> Result<()> {
    require(
        files.last().is_some_and(|file| {
            file.metadata()
                .is_ok_and(|metadata| metadata.len() <= MAX_STDERR)
        }),
        "SNAPSHOT_TEST_STDERR_BOUND",
    )
}
pub(super) fn message(files: &[File], status: owned_process::ProcessStatus) -> Option<Vec<u8>> {
    if status.successful() {
        return None;
    }
    let output = files.last()?;
    let file = output.try_clone().ok()?;
    let result = (|| {
        let mut file = &file;
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = format!(
            "snapshot synthetic tool exit {} stderr: ",
            status.shell_code()
        )
        .into_bytes();
        file.take(768).read_to_end(&mut bytes)?;
        Ok(bytes)
    })();
    super::super::combine(result, crate::native::close(file).map_err(Into::into)).ok()
}
