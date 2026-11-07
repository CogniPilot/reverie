//! Fixed instruction-publication nonce, sharing the existing OS entropy owner.
//! A name is DATA and confers no file/path or publication permission.
pub fn instruction_temporary_name() -> Result<String, crate::StoreError> {
    Ok(format!(
        ".laptop-instructions-{}",
        crate::private_fs::random_uuid()?
    ))
}

/// Bounded names-only cold TMP observation over a borrowed directory. No
/// entries are followed or changed, and no deletion/admission proof is minted.
/// Enumeration and its fallible finalizer share the existing filesystem owner.
pub fn cold_directory_names(
    directory: &std::fs::File,
    maximum: usize,
    end: std::time::Instant,
) -> Result<Vec<Vec<u8>>, crate::StoreError> {
    crate::private_fs::cold_directory_names(directory, maximum, end)
}
