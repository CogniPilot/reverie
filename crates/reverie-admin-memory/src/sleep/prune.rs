use super::{Result, policy::Prune, storage};
use jiff::{Timestamp, civil::DateTime, tz::TimeZone};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, Metadata},
    io::{self, Read, Write},
    os::unix::fs::MetadataExt,
    path::Path,
};

pub(super) fn apply(entry: &Prune, now: f64, state: &Path) -> Result<Option<usize>> {
    let path = &entry.path;
    let mut source = match storage::regular(path, false) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let original_metadata = source.metadata()?;
    let mut original = Vec::new();
    source.read_to_end(&mut original)?;
    let key = format!("{:x}", Sha256::digest(path.as_os_str().as_encoded_bytes()));
    let mark = state.join(format!("prune-tail-{}.sha256", &key[..16]));
    let seen = match fs::read_to_string(&mark) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let cutoff = now - f64::from(entry.days) * 86_400.0;
    let filtered = filter(&original, cutoff, seen.trim());
    if !entry.live {
        return Ok(Some(filtered.dropped));
    }
    if filtered.dropped != 0 {
        storage::replace_checked(
            path,
            0o600,
            |file| {
                file.write_all(&filtered.keep)?;
                carry_appends(path, &original_metadata, &original, file)
            },
            |observed| confirm(path, &observed),
        )?;
    }
    update_mark(&mark, filtered.tail.as_deref())?;
    Ok(Some(filtered.dropped))
}

fn carry_appends(
    path: &Path,
    original_metadata: &Metadata,
    original: &[u8],
    output: &mut impl Write,
) -> Result<Metadata> {
    let mut current = storage::regular(path, false)?;
    let mut bytes = Vec::new();
    current.read_to_end(&mut bytes)?;
    let observed = current.metadata()?;
    if inode(&observed) != inode(original_metadata)
        || observed.len() != bytes.len() as u64
        || !bytes.starts_with(original)
    {
        return Err("log changed during sleep pruning".into());
    }
    output.write_all(&bytes[original.len()..])?;
    Ok(observed)
}

fn confirm(path: &Path, observed: &Metadata) -> Result<()> {
    let current = fs::symlink_metadata(path)?;
    if inode(&current) != inode(observed)
        || current.len() != observed.len()
        || (current.ctime(), current.ctime_nsec()) != (observed.ctime(), observed.ctime_nsec())
    {
        return Err("log changed before the pruned file could be published".into());
    }
    Ok(())
}

fn inode(metadata: &Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

struct Filtered {
    keep: Vec<u8>,
    dropped: usize,
    tail: Option<String>,
}

fn filter(data: &[u8], cutoff: f64, seen: &str) -> Filtered {
    let mut result = Filtered {
        keep: Vec::new(),
        dropped: 0,
        tail: None,
    };
    for line in data.split_inclusive(|byte| *byte == b'\n') {
        let keep = if line.ends_with(b"\n") {
            timestamp(line).is_some_and(|at| at >= cutoff)
        } else {
            let digest = format!("{:x}", Sha256::digest(line));
            if digest != seen {
                result.tail = Some(digest);
                true
            } else {
                false
            }
        };
        if keep {
            result.keep.extend_from_slice(line);
        } else {
            result.dropped += 1;
        }
    }
    result
}

fn timestamp(raw: &[u8]) -> Option<f64> {
    let row: Value = serde_json::from_slice(raw).ok()?;
    let at = row.get("at")?.as_str()?;
    let stamp = at.parse::<Timestamp>().ok().or_else(|| {
        at.parse::<DateTime>()
            .ok()?
            .to_zoned(TimeZone::system())
            .ok()
            .map(|date| date.timestamp())
    })?;
    Some(stamp.as_second() as f64 + f64::from(stamp.subsec_nanosecond()) / 1_000_000_000.0)
}

fn update_mark(path: &Path, digest: Option<&str>) -> Result<()> {
    if let Some(digest) = digest {
        return storage::replace(path, 0o600, |file| {
            writeln!(file, "{digest}")?;
            Ok(())
        });
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;

    #[test]
    fn concurrent_appends_are_carried_and_conflicting_rewrites_are_refused() {
        let root = nix::unistd::mkdtemp(&std::env::temp_dir().join("rv-prune-XXXXXX")).unwrap();
        let path = root.join("log");
        let original = b"a removed line\n";
        fs::write(&path, original).unwrap();
        let before = fs::metadata(&path).unwrap();
        let mut writer = OpenOptions::new().append(true).open(&path).unwrap();
        writer.write_all(b"new line\n").unwrap();
        let mut output = Vec::new();
        let fresh = carry_appends(&path, &before, original, &mut output).unwrap();
        assert_eq!(output, b"new line\n");
        confirm(&path, &fresh).unwrap();
        writer.write_all(b"second append\n").unwrap();
        assert!(confirm(&path, &fresh).is_err());
        fs::write(&path, "replacement").unwrap();
        assert!(carry_appends(&path, &before, original, &mut output).is_err());
        drop(writer);
        fs::remove_dir_all(root).unwrap();
    }
}
