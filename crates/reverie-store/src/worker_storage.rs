//! Fixed instruction-publication nonce, sharing the existing OS entropy owner.
//! A name is DATA and confers no file/path or publication permission.
pub fn instruction_temporary_name() -> Result<String, crate::StoreError> {
    Ok(format!(
        ".laptop-instructions-{}",
        crate::private_fs::random_uuid()?
    ))
}
