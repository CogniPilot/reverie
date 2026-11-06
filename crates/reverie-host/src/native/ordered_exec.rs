//! Ordered POSIX argv/env bytes, prepared before fork. Only fixed-purpose
//! private host adapters call this primitive; it is no public command endpoint.
#![allow(unsafe_code)]
use std::{
    convert::Infallible,
    ffi::{CString, OsString, c_char},
    io,
    os::unix::{ffi::OsStrExt, process::CommandExt},
    path::Path,
    process::Command,
    sync::Arc,
};
pub(crate) struct PreparedExec {
    program: CString,
    _arguments: Vec<CString>,
    _environment: Vec<CString>,
    arguments: Vec<*const c_char>,
    environment: Vec<*const c_char>,
}
// SAFETY: these pointers address immutable CString heap allocations owned by
// this same object. Moving it never relocates those allocations. Only Arc
// sharing is allowed; no mutable accessor or Clone can invalidate pointers.
// execute holds &self for the synchronous syscall; drop cannot race that borrow.
unsafe impl Send for PreparedExec {}
// SAFETY: as above, all buffers/pointer arrays are immutable after construction.
unsafe impl Sync for PreparedExec {}
impl PreparedExec {
    pub(crate) fn new(
        program: &Path,
        arguments: &[OsString],
        environment: &[(OsString, OsString)],
    ) -> io::Result<Arc<Self>> {
        let program = cstring(program.as_os_str().as_bytes())?;
        if arguments.is_empty() {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let args = arguments
            .iter()
            .map(|value| cstring(value.as_bytes()))
            .collect::<io::Result<Vec<_>>>()?;
        let env = environment
            .iter()
            .map(|(key, value)| {
                if key.is_empty() || key.as_bytes().contains(&b'=') {
                    return Err(io::ErrorKind::InvalidInput.into());
                }
                let mut entry = key.as_bytes().to_vec();
                entry.push(b'=');
                entry.extend_from_slice(value.as_bytes());
                cstring(&entry)
            })
            .collect::<io::Result<Vec<_>>>()?;
        let arguments = args
            .iter()
            .map(|value| value.as_ptr())
            .chain([std::ptr::null()])
            .collect();
        let environment = env
            .iter()
            .map(|value| value.as_ptr())
            .chain([std::ptr::null()])
            .collect();
        Ok(Arc::new(Self {
            program,
            _arguments: args,
            _environment: env,
            arguments,
            environment,
        }))
    }
    pub(crate) fn execute(&self) -> io::Result<Infallible> {
        // SAFETY: constructor built two terminated pointer arrays into live
        // immutable terminated strings; &self pins every backing allocation.
        // execve is async-signal-safe. Success replaces this process and cannot
        // return; failure returns errno and no second execution is attempted.
        unsafe {
            libc::execve(
                self.program.as_ptr(),
                self.arguments.as_ptr(),
                self.environment.as_ptr(),
            );
        }
        Err(io::Error::last_os_error())
    }
    pub(crate) fn configure(self: &Arc<Self>, command: &mut Command) {
        let prepared = Arc::clone(self);
        // SAFETY: callback performs only the fixed execve syscall and errno
        // capture; all strings/pointers were prepared before fork. It neither
        // allocates nor takes locks. An Err stops stdlib's execution path.
        unsafe {
            command.pre_exec(move || match prepared.execute() {
                Err(error) => Err(error),
                Ok(never) => match never {},
            });
        }
    }
}
fn cstring(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes).map_err(|_| io::ErrorKind::InvalidInput.into())
}
