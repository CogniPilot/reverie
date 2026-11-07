use super::{Result, SnapshotError, deadline, directory::Directory, require};
use crate::native::owned_process::{self, Handshake};
#[cfg(test)]
mod diagnostics;
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    os::{fd::OwnedFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const MAX_ATTRIBUTE_BYTES: u64 = 1 << 20;
static UNCERTAIN: Mutex<Vec<Pending>> = Mutex::new(Vec::new());
struct Pending {
    _child: Child,
    _pidfd: Option<OwnedFd>,
    _handshake: Handshake,
    _directories: Vec<Arc<Directory>>,
    _files: Vec<File>,
}
struct Program {
    path: PathBuf,
    identity: crate::native::Stamp,
    role: &'static str,
}
impl Program {
    fn capture(path: &Path, name: &'static str) -> Result<Self> {
        let path = fs::canonicalize(path)?;
        let metadata = fs::symlink_metadata(&path)?;
        require(
            path.starts_with("/nix/store")
                && path.file_name() == Some(OsStr::new(name))
                && metadata.is_file()
                && metadata.uid() == 0
                && metadata.mode() & 0o222 == 0
                && owned_process::executable(&path),
            "SNAPSHOT_TOOL_CUSTODY",
        )?;
        Ok(Self {
            path,
            identity: crate::native::Stamp::of(&metadata),
            role: name,
        })
    }
    fn command(&self, root: &Directory, arguments: &[OsString]) -> Result<Command> {
        require(
            crate::native::Stamp::of(&fs::symlink_metadata(&self.path)?) == self.identity,
            "SNAPSHOT_TOOL_CHANGED",
        )?;
        let mut command = Command::new(&self.path);
        command
            .args(arguments)
            .env_clear()
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .current_dir(root.fd_path())
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        Ok(command)
    }
}
pub(super) struct Tools {
    tar: Program,
    attrs: Program,
    acl: Program,
}
impl Tools {
    pub(super) fn new(tar: &Path, attrs: &Path, acl: &Path) -> Result<Self> {
        Ok(Self {
            tar: Program::capture(tar, "tar")?,
            attrs: Program::capture(attrs, "getfattr")?,
            acl: Program::capture(acl, "getfacl")?,
        })
    }
    pub(super) fn create(
        &self,
        source: &Arc<Directory>,
        destination: &Arc<Directory>,
        archive: &File,
        end: Instant,
        maximum: u64,
    ) -> Result<()> {
        let arguments = strings(&[
            "--create",
            "--format=pax",
            "--numeric-owner",
            "--acls",
            "--xattrs",
            "--xattrs-include=*",
            "--file=-",
            "--",
            "console",
        ]);
        let mut command = self.tar.command(source, &arguments)?;
        command.stdout(archive.try_clone()?);
        run(
            command,
            vec![source.clone(), destination.clone()],
            vec![archive.try_clone()?],
            end,
            Some(maximum),
        )
        .map_err(|error| SnapshotError::caused("SNAPSHOT_TAR_CREATE", error))
    }
    pub(super) fn compare(
        &self,
        root: &Arc<Directory>,
        destination: &Arc<Directory>,
        archive: &File,
        end: Instant,
    ) -> Result<()> {
        self.archive_input(root, destination, archive, end, false)
    }
    pub(super) fn extract(
        &self,
        root: &Arc<Directory>,
        destination: &Arc<Directory>,
        archive: &File,
        end: Instant,
    ) -> Result<()> {
        self.archive_input(root, destination, archive, end, true)
    }
    fn archive_input(
        &self,
        root: &Arc<Directory>,
        destination: &Arc<Directory>,
        archive: &File,
        end: Instant,
        extract: bool,
    ) -> Result<()> {
        let mut input = archive.try_clone()?;
        input.seek(SeekFrom::Start(0))?;
        let arguments = if extract {
            strings(&[
                "--extract",
                "--same-owner",
                "--same-permissions",
                "--numeric-owner",
                "--acls",
                "--xattrs",
                "--xattrs-include=*",
                "--file=-",
            ])
        } else {
            strings(&[
                "--compare",
                "--numeric-owner",
                "--acls",
                "--xattrs",
                "--xattrs-include=*",
                "--file=-",
            ])
        };
        let mut command = self.tar.command(root, &arguments)?;
        command.stdin(input).stdout(Stdio::null());
        run(
            command,
            vec![root.clone(), destination.clone()],
            vec![archive.try_clone()?],
            end,
            None,
        )
        .map_err(|error| {
            SnapshotError::caused(
                if extract {
                    "SNAPSHOT_TAR_EXTRACT"
                } else {
                    "SNAPSHOT_TAR_COMPARE"
                },
                error,
            )
        })
    }
    pub(super) fn attributes(
        &self,
        root: &Arc<Directory>,
        destination: &Arc<Directory>,
        relative: &Path,
        kind: fs::FileType,
        end: Instant,
    ) -> Result<(Vec<u8>, Vec<u8>)> {
        let mut args = strings(&[
            "--absolute-names",
            "--dump",
            "--match=-",
            "--encoding=hex",
            "--no-dereference",
            "--",
        ]);
        args.push(relative.as_os_str().to_owned());
        let attrs = self.output(&self.attrs, root, destination, &args, end)?;
        let attrs = super::attributes::decode(&attrs)?;
        for (name, value) in &attrs {
            let mut args = strings(&["--no-dereference", "--only-values", "--name"]);
            args.push(name.clone());
            args.push(OsString::from("--"));
            args.push(relative.as_os_str().to_owned());
            require(
                self.output(&self.attrs, root, destination, &args, end)? == *value,
                "SNAPSHOT_ATTRIBUTE_AMBIGUOUS",
            )?;
        }
        // Linux symlinks have no POSIX ACL; never read the target's ACL as if
        // it belonged to the link. Its visible xattrs remain NOFOLLOW above.
        let acl = if kind.is_symlink() {
            Vec::new()
        } else {
            let mut args = strings(&[
                "--absolute-names",
                "--omit-header",
                "--numeric",
                "--physical",
                "--",
            ]);
            args.push(relative.as_os_str().to_owned());
            self.output(&self.acl, root, destination, &args, end)?
        };
        Ok((super::attributes::encode(&attrs), acl))
    }
    fn output(
        &self,
        program: &Program,
        root: &Arc<Directory>,
        destination: &Arc<Directory>,
        args: &[OsString],
        end: Instant,
    ) -> Result<Vec<u8>> {
        let mut file = destination.temporary()?;
        let result = (|| {
            let mut command = program.command(root, args)?;
            command.stdout(file.try_clone()?);
            run(
                command,
                vec![root.clone(), destination.clone()],
                vec![file.try_clone()?],
                end,
                Some(MAX_ATTRIBUTE_BYTES),
            )?;
            require(
                file.metadata()?.len() <= MAX_ATTRIBUTE_BYTES,
                "SNAPSHOT_ATTRIBUTE_BOUND",
            )?;
            file.seek(SeekFrom::Start(0))?;
            let mut result = Vec::new();
            file.read_to_end(&mut result)?;
            Ok(result)
        })();
        super::combine(result, crate::native::close(file).map_err(Into::into)).map_err(|error| {
            SnapshotError::caused(
                if program.role == "getfattr" {
                    "SNAPSHOT_GETFATTR"
                } else {
                    "SNAPSHOT_GETFACL"
                },
                error,
            )
        })
    }
}
fn strings(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}
fn run(
    mut command: Command,
    directories: Vec<Arc<Directory>>,
    files: Vec<File>,
    end: Instant,
    maximum: Option<u64>,
) -> Result<()> {
    #[cfg(test)]
    let files = diagnostics::attach(&mut command, directories.last(), files)?;
    let admitted = deadline(end).and_then(|()| {
        require(
            UNCERTAIN
                .lock()
                .map_err(|_| SnapshotError::refused("SNAPSHOT_PROCESS_UNCERTAIN"))?
                .is_empty(),
            "SNAPSHOT_PROCESS_UNCERTAIN",
        )
    });
    if let Err(error) = admitted {
        return super::combine(Err(error), close_files(files));
    }
    let mut handshake = match Handshake::new() {
        Ok(value) => value,
        Err(_) => {
            return super::combine(
                Err(SnapshotError::refused("SNAPSHOT_PROCESS_PREPARATION")),
                close_files(files),
            );
        }
    };
    handshake.configure(&mut command);
    // Spawn/pre-exec and filesystem kernel operations have no hard wall-clock
    // completion promise. The deadline initiates exact-owned-child SIGKILL.
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return super::combine(
                super::combine(Err(error.into()), handshake.finish().map_err(Into::into)),
                close_files(files),
            );
        }
    };
    let pidfd = match handshake.receive() {
        Ok(pidfd) => pidfd,
        Err(error) => {
            let mut cause = SnapshotError::refused("SNAPSHOT_PROCESS_HANDSHAKE");
            if error.close_failed {
                cause
                    .secondary
                    .push(SnapshotError::refused("SNAPSHOT_PROCESS_FINALIZER"));
            }
            return retain(
                Pending {
                    _child: child,
                    _pidfd: None,
                    _handshake: handshake,
                    _directories: directories,
                    _files: files,
                },
                cause,
            );
        }
    };
    if let Err(error) = handshake.finish() {
        return retain(
            Pending {
                _child: child,
                _pidfd: Some(pidfd),
                _handshake: handshake,
                _directories: directories,
                _files: files,
            },
            error.into(),
        );
    }
    let result = wait(&pidfd, &files, end, maximum);
    match result {
        Ok(status) => complete(pidfd, files, status, end, maximum),
        Err(error) => {
            let killed = owned_process::kill(&pidfd);
            let settled = wait_reaped(&pidfd, Instant::now() + Duration::from_millis(100));
            if killed.is_err() || !settled {
                return retain(
                    Pending {
                        _child: child,
                        _pidfd: Some(pidfd),
                        _handshake: handshake,
                        _directories: directories,
                        _files: files,
                    },
                    error,
                );
            }
            super::combine(
                super::combine(Err(error), owned_process::close(pidfd).map_err(Into::into)),
                close_files(files),
            )
        }
    }
}
fn complete(
    pidfd: OwnedFd,
    files: Vec<File>,
    status: owned_process::ProcessStatus,
    end: Instant,
    maximum: Option<u64>,
) -> Result<()> {
    #[cfg(test)]
    let diagnostic = diagnostics::message(&files, status);
    let bounded = files.iter().try_for_each(|file| {
        require(
            maximum.is_none_or(|limit| {
                file.metadata()
                    .is_ok_and(|metadata| metadata.len() <= limit)
            }),
            "SNAPSHOT_OUTPUT_BOUND",
        )
    });
    let result = bounded.and_then(|()| deadline(end)).and_then(|()| {
        if status.successful() {
            Ok(())
        } else {
            Err(SnapshotError::caused(
                "SNAPSHOT_TOOL_FAILED",
                ToolExit(status.shell_code()),
            ))
        }
    });
    let result = super::combine(
        super::combine(result, owned_process::close(pidfd).map_err(Into::into)),
        close_files(files),
    );
    #[cfg(test)]
    if let Some(message) = diagnostic {
        let _ = reverie_diagnostics::stderr(&message);
    }
    result
}
#[derive(Debug)]
struct ToolExit(u8);
impl std::fmt::Display for ToolExit {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "snapshot tool exit {}", self.0)
    }
}
impl std::error::Error for ToolExit {}
fn wait(
    pidfd: &OwnedFd,
    files: &[File],
    end: Instant,
    maximum: Option<u64>,
) -> Result<owned_process::ProcessStatus> {
    loop {
        if let Some(status) = owned_process::reap_status(pidfd)? {
            return Ok(status);
        }
        deadline(end)?;
        #[cfg(test)]
        diagnostics::bound(files)?;
        if let Some(maximum) = maximum {
            for file in files {
                require(
                    file.metadata()?.len() <= maximum,
                    "SNAPSHOT_ATTRIBUTE_BOUND",
                )?;
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn close_files(files: Vec<File>) -> Result<()> {
    let mut result = Ok(());
    // Retain secondary failures while still consuming every owned descriptor.
    for file in files {
        result = super::combine(result, crate::native::close(file).map_err(Into::into));
    }
    result
}
fn wait_reaped(pidfd: &OwnedFd, end: Instant) -> bool {
    loop {
        match owned_process::reap_status(pidfd) {
            Ok(Some(_)) => return true,
            Err(_) => return false,
            Ok(None) => {}
        }
        if Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn retain(pending: Pending, cause: SnapshotError) -> Result<()> {
    match UNCERTAIN.lock() {
        Ok(mut owners) => owners.push(pending),
        Err(_) => {
            let _ = Box::leak(Box::new(pending));
        }
    }
    Err(SnapshotError::caused("SNAPSHOT_PROCESS_UNCERTAIN", cause))
}
