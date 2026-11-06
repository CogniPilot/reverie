//! Fixed system passwd lookup. No caller-selected account database.
use super::*;
pub(crate) fn username(uid: u32) -> Result<Vec<u32>> {
    let mut length = 16_384usize;
    loop {
        let mut buffer = vec![0u8; length];
        // SAFETY: initialized passwd and a null result pointer are valid output
        // storage; getpwuid_r writes only within the supplied live buffer.
        let mut value: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result = std::ptr::null_mut();
        let status = unsafe {
            libc::getpwuid_r(
                uid,
                &mut value,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE {
            length = length
                .checked_mul(2)
                .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::OutOfMemory))?;
            continue;
        }
        if status != 0 {
            return Err(std::io::Error::from_raw_os_error(status).into());
        }
        need(
            !result.is_null() && !value.pw_name.is_null(),
            ObservationFault::System,
        )?;
        // SAFETY: successful getpwuid_r returns a NUL-terminated name in buffer,
        // which remains alive while these bytes are copied into codepoint data.
        let bytes = unsafe { CStr::from_ptr(value.pw_name) }.to_bytes();
        return Ok(python_text(Path::new(std::ffi::OsStr::from_bytes(bytes))));
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
