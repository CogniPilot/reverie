use super::report::{Aggregate, Run, run_id};
use chrono::{DateTime, Utc};
use rustix::{
    fs::{self, AtFlags, Dir, Mode, OFlags, RenameFlags},
    io::Errno,
};
use serde::Serialize;
use serde_json::ser::{PrettyFormatter, Serializer};
use std::{
    ffi::OsStr,
    fs::File,
    io::{self, Read, Write},
    os::unix::ffi::OsStrExt,
    path::Path,
};

const KEEP: usize = 60;
const SUMMARY_LIMIT: u64 = 4 * 1024 * 1024;
const SUMMARY_SUFFIX: &str = ".summary.json";
const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

fn open_directory(path: &Path) -> io::Result<File> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "directory must be absolute",
        ));
    }
    let mut parent = File::from(fs::open("/", DIRECTORY, Mode::empty())?);
    let parts = path.as_os_str().as_bytes().split(|&byte| byte == b'/');
    for part in parts.filter(|part| !part.is_empty()) {
        if matches!(part, b"." | b"..") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "directory must be canonical",
            ));
        }
        parent = File::from(fs::openat(
            &parent,
            OsStr::from_bytes(part),
            DIRECTORY,
            Mode::empty(),
        )?);
    }
    Ok(parent)
}

fn names(directory: &File, suffix: &str) -> io::Result<Vec<String>> {
    let mut found = Vec::new();
    for item in Dir::read_from(directory)? {
        let item = item?;
        if let Ok(name) = item.file_name().to_str()
            && run_id(name, suffix).is_some()
        {
            found.push(name.to_owned());
        }
    }
    found.sort_unstable();
    Ok(found)
}

fn read_summary(directory: &File, name: &str) -> io::Result<Vec<u8>> {
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK;
    let file = File::from(fs::openat(directory, name, flags, Mode::empty())?);
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > SUMMARY_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid cleanup summary file",
        ));
    }
    let mut raw = Vec::new();
    file.take(SUMMARY_LIMIT + 1).read_to_end(&mut raw)?;
    if raw.len() as u64 > SUMMARY_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "cleanup summary exceeds the byte limit",
        ));
    }
    Ok(raw)
}

pub(super) fn newest_summary(state: &Path, now: DateTime<Utc>) -> io::Result<Option<Aggregate>> {
    let directory = match open_directory(&state.join("logs")) {
        Ok(directory) => directory,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let Some(name) = names(&directory, SUMMARY_SUFFIX)?.pop() else {
        return Ok(None);
    };
    let id = run_id(&name, SUMMARY_SUFFIX)
        .expect("matched summary name")
        .to_owned();
    Aggregate::decode(id, &read_summary(&directory, &name)?, now).map(Some)
}

fn temporary_name() -> io::Result<String> {
    let mut bytes = [0; 12];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| io::Error::other("could not choose a report temporary name"))?;
    let nonce = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!(".tmp-{}-{nonce}", std::process::id()))
}

fn write_record(file: &mut File, record: &impl Serialize) -> io::Result<()> {
    let mut value = serde_json::to_value(record)?;
    value.sort_all_objects();
    value.serialize(&mut Serializer::with_formatter(
        &mut *file,
        PrettyFormatter::with_indent(b" "),
    ))?;
    file.write_all(b"\n")?;
    file.sync_all()
}

fn publish(
    directory: &File,
    name: &str,
    record: &impl Serialize,
    flags: RenameFlags,
) -> io::Result<bool> {
    let temporary = temporary_name()?;
    let create =
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mode = Mode::from_raw_mode(0o644);
    let mut file = File::from(fs::openat(directory, &temporary, create, mode)?);
    let written = fs::fchmod(&file, mode)
        .map_err(io::Error::from)
        .and_then(|()| write_record(&mut file, record));
    drop(file);
    let publication = written.and_then(|()| {
        match fs::renameat_with(directory, &temporary, directory, name, flags) {
            Ok(()) => Ok(true),
            Err(Errno::EXIST) if flags == RenameFlags::NOREPLACE => Ok(false),
            Err(error) => Err(error.into()),
        }
    });
    if !matches!(publication, Ok(true)) {
        let cleanup =
            fs::unlinkat(directory, &temporary, AtFlags::empty()).map_err(io::Error::from);
        return publication.and_then(|published| cleanup.map(|()| published));
    }
    publication
}

pub(super) fn write_reports(path: &Path, record: Run) -> io::Result<()> {
    let directory = open_directory(path)?;
    let fresh = match (record.run_id(), &record.summary) {
        (Some(id), Some(summary)) => publish(
            &directory,
            &format!("{id}.json"),
            summary,
            RenameFlags::NOREPLACE,
        )?,
        _ => false,
    };
    publish(
        &directory,
        "latest.json",
        &record.latest(fresh),
        RenameFlags::empty(),
    )?;
    let history = names(&directory, ".json")?;
    let retired = history.len().saturating_sub(KEEP);
    for name in history.into_iter().take(retired) {
        match fs::unlinkat(&directory, name, AtFlags::empty()) {
            Ok(()) | Err(Errno::NOENT) => (),
            Err(error) => return Err(error.into()),
        }
    }
    directory.sync_all()
}
