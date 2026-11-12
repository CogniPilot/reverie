//! Only six protected paths are retained. Layer entries remain ordered;
//! whiteouts operate on lower state before this layer's additions.
use super::{Result, build_archive, need};
use reverie_contracts::resource_actor::{CodeFile, HUMAN_TERMINAL_FILES};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{self, Read},
};

const TRACKED: [&[u8]; 6] = [
    b"opt",
    b"opt/reverie",
    b"opt/reverie/human",
    b"opt/reverie/human/bin",
    b"opt/reverie/human/bin/bash",
    b"opt/reverie/human/bin/reverie-human-shell",
];
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    File,
    Directory,
    Other,
}
struct Fact {
    kind: Kind,
    uid: u64,
    gid: u64,
    mode: u32,
    pin: Option<(String, u64)>,
}
pub(super) struct Layer {
    pub digest: String,
    deletes: Vec<(Vec<u8>, bool)>,
    entries: Vec<(Vec<u8>, Fact)>,
}
pub(super) fn canonical(name: &[u8]) -> Result<Vec<u8>> {
    need(
        build_archive::python_name(name).codepoints().len() <= 8192
            && !name.contains(&0)
            && !name.split(|b| *b == b'/').any(|v| v == b".."),
        "WORKER_BUILD_CANONICAL_LAYER_PATH",
    )?;
    let mut output = Vec::new();
    for part in name
        .split(|b| *b == b'/')
        .filter(|p| !p.is_empty() && *p != b".")
    {
        if !output.is_empty() {
            output.push(b'/');
        }
        output.extend_from_slice(part);
    }
    Ok(output)
}
pub(super) fn read(
    reader: &mut impl Read,
    files: &[CodeFile],
    budget: &mut usize,
) -> Result<Layer> {
    let mut archive = tar::Archive::new(reader);
    let mut layer = Layer {
        digest: String::new(),
        deletes: Vec::new(),
        entries: Vec::new(),
    };
    for member in archive.entries()? {
        let mut member = member?;
        *budget = budget
            .checked_sub(1)
            .ok_or("WORKER_BUILD_LAYER_MEMBER_BOUND")?;
        let name = canonical(&member.path_bytes())?;
        if let Some(delete) = whiteout(&name) {
            if TRACKED
                .iter()
                .any(|target| removed(target, &delete.0, delete.1))
            {
                layer.deletes.push(delete);
            }
        } else if TRACKED.contains(&name.as_slice()) {
            let fact = fact(&name, &mut member, files)?;
            layer.entries.push((name, fact));
        }
        need(
            layer.entries.len() + layer.deletes.len() <= 4096,
            "WORKER_BUILD_LAYER_EVENT_BOUND",
        )?;
        io::copy(&mut member, &mut io::sink())?;
    }
    build_archive::drain(archive)?;
    Ok(layer)
}
fn fact(name: &[u8], member: &mut tar::Entry<'_, impl Read>, files: &[CodeFile]) -> Result<Fact> {
    let kind = if member.header().entry_type().is_dir() {
        Kind::Directory
    } else if build_archive::regular_entry(member.header().entry_type()) {
        Kind::File
    } else {
        Kind::Other
    };
    let mut fact = Fact {
        kind,
        uid: member.header().uid()?,
        gid: member.header().gid()?,
        mode: member.header().mode()? & 0o7777,
        pin: None,
    };
    if let Some(expected) = target(name, files)
        && kind == Kind::File
    {
        need(
            member.size() == expected.bytes && member.size() <= 16 << 20,
            "WORKER_BUILD_ARCHIVED_TOOLKIT_SIZE",
        )?;
        let mut raw = Vec::new();
        member.take((16 << 20) + 1).read_to_end(&mut raw)?;
        let digest = format!("{:x}", Sha256::digest(&raw));
        need(
            raw.len() as u64 == expected.bytes && digest == expected.sha256.as_str(),
            "WORKER_BUILD_ARCHIVED_TOOLKIT_BYTES",
        )?;
        fact.pin = Some((digest, raw.len() as u64));
    }
    Ok(fact)
}
fn target<'a>(name: &[u8], files: &'a [CodeFile]) -> Option<&'a CodeFile> {
    HUMAN_TERMINAL_FILES
        .iter()
        .position(|target| target.as_bytes().get(1..) == Some(name))
        .and_then(|index| files.get(index))
}
fn whiteout(name: &[u8]) -> Option<(Vec<u8>, bool)> {
    let slash = name.iter().rposition(|b| *b == b'/');
    let parent = slash.map_or(&b""[..], |i| &name[..i]);
    let base = slash.map_or(name, |i| &name[i + 1..]);
    let suffix = base.strip_prefix(b".wh.")?;
    if base == b".wh..wh..opq" {
        Some((parent.to_vec(), false))
    } else {
        let mut prefix = parent.to_vec();
        if !prefix.is_empty() {
            prefix.push(b'/');
        }
        prefix.extend_from_slice(suffix);
        Some((prefix, true))
    }
}
fn removed(name: &[u8], prefix: &[u8], include: bool) -> bool {
    prefix.is_empty()
        || (include && name == prefix)
        || name
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with(b"/"))
}
pub(super) fn verify_final(layers: &[&Layer], files: &[CodeFile]) -> Result<()> {
    let mut state: BTreeMap<Vec<u8>, &Fact> = BTreeMap::new();
    for layer in layers {
        for (prefix, include) in &layer.deletes {
            state.retain(|name, _| !removed(name, prefix, *include));
        }
        for (name, fact) in &layer.entries {
            if fact.kind != Kind::Directory {
                state.retain(|child, _| !removed(child, name, false));
            }
            if target(name, files).is_some() {
                require_ancestors(name, &state)?;
            }
            state.insert(name.clone(), fact);
        }
    }
    for name in TRACKED {
        let fact = state.get(name).ok_or("WORKER_BUILD_FINAL_TOOLKIT_PATH")?;
        need(
            fact.uid == 0 && fact.gid == 0,
            "WORKER_BUILD_FINAL_TOOLKIT_ROOT_OWNER",
        )?;
        if let Some(expected) = target(name, files) {
            need(
                fact.kind == Kind::File
                    && fact.mode == 0o555
                    && fact.pin.as_ref().is_some_and(|(hash, bytes)| {
                        hash == expected.sha256.as_str() && *bytes == expected.bytes
                    }),
                "WORKER_BUILD_FINAL_DIRECT_TOOLKIT_FILE",
            )?;
        } else {
            need(
                fact.kind == Kind::Directory && fact.mode & 0o022 == 0,
                "WORKER_BUILD_FINAL_PROTECTED_DIRECTORY",
            )?;
        }
    }
    Ok(())
}
fn require_ancestors(name: &[u8], state: &BTreeMap<Vec<u8>, &Fact>) -> Result<()> {
    for (i, _) in name.iter().enumerate().filter(|(_, b)| **b == b'/') {
        need(
            state
                .get(&name[..i])
                .is_some_and(|fact| fact.kind == Kind::Directory),
            "WORKER_BUILD_TOOLKIT_ANCESTOR_REPLACED",
        )?;
    }
    Ok(())
}
