//! Fixed system passwd lookup. No caller-selected account database.
use super::*;
pub(crate) fn username(uid: u32) -> Result<Vec<u32>> {
    let value = lookup(Account::Uid(uid))?;
    need(value.is_some(), ObservationFault::System)?;
    Ok(value.expect("checked account").0)
}
pub(crate) fn home_directory(name: Option<&[u32]>) -> std::io::Result<Vec<u32>> {
    let account = match name {
        Some(name) => Account::Name(
            std::ffi::CString::new(python_path(name)?.as_os_str().as_bytes())
                .map_err(|_| std::io::ErrorKind::InvalidInput)?,
        ),
        None => Account::Uid(uid()),
    };
    lookup(account)?
        .map(|value| value.1)
        .ok_or_else(|| std::io::ErrorKind::NotFound.into())
}
enum Account {
    Uid(u32),
    Name(std::ffi::CString),
}
fn lookup(account: Account) -> std::io::Result<Option<(Vec<u32>, Vec<u32>)>> {
    let mut length = 16_384usize;
    loop {
        let mut buffer = vec![0u8; length];
        // SAFETY: initialized passwd and a null result pointer are valid output
        // storage; getpwuid_r writes only within the supplied live buffer.
        let mut value: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result = std::ptr::null_mut();
        // SAFETY: both reentrant NSS lookups share the live output/buffer
        // storage. A named lookup's immutable terminated key stays alive.
        let status = unsafe {
            match &account {
                Account::Uid(uid) => libc::getpwuid_r(
                    *uid,
                    &mut value,
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut result,
                ),
                Account::Name(name) => libc::getpwnam_r(
                    name.as_ptr(),
                    &mut value,
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut result,
                ),
            }
        };
        if status == libc::ERANGE {
            length = length
                .checked_mul(2)
                .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::OutOfMemory))?;
            continue;
        }
        if status != 0 {
            return Err(std::io::Error::from_raw_os_error(status));
        }
        if result.is_null() {
            return Ok(None);
        }
        if value.pw_name.is_null() || value.pw_dir.is_null() {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        // SAFETY: successful getpwuid_r returns a NUL-terminated name in buffer,
        // which remains alive while these bytes are copied into codepoint data.
        let bytes = unsafe { CStr::from_ptr(value.pw_name) }.to_bytes();
        // SAFETY: pw_dir has the same successful NSS lifetime as pw_name.
        let directory = unsafe { CStr::from_ptr(value.pw_dir) }.to_bytes();
        return Ok(Some((
            python_text(Path::new(std::ffi::OsStr::from_bytes(bytes))),
            python_text(Path::new(std::ffi::OsStr::from_bytes(directory))),
        )));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn passwd_names_preserve_non_utf8_and_real_process_account_lookup() {
        assert_eq!(
            python_text(Path::new(std::ffi::OsStr::from_bytes(b"name\xff\xc3\xa9"))),
            vec![110, 97, 109, 101, 0xdcff, 233]
        );
        assert!(!username(uid()).unwrap().is_empty());
    }
}
