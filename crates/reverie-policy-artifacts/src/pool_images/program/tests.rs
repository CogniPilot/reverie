//! Byte-level image/program linkage controls, without executing any fixture bytes.
use super::*;
use std::{fs, io::Write, time::Duration};

const PROGRAM: &str = "/nix/store/synthetic-controller/bin/reverie-worker-resource-controller";
const ELF: &[u8] = b"\x7fELFsynthetic program bytes";

fn append_program(archive: &mut tar::Builder<Vec<u8>>, path: &str, data: &[u8]) {
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o555);
    // Preserve the actual archive spelling, including absolute and unsafe test
    // paths that Builder::append_data intentionally declines to manufacture.
    assert!(path.len() < 100);
    header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
    header.set_cksum();
    archive.append(&header, data).unwrap();
}
fn layer(variant: &str) -> Vec<u8> {
    let mut archive = tar::Builder::new(Vec::new());
    if variant != "missing-file" {
        let data = if variant == "changed-bytes" {
            b"different bytes".as_slice()
        } else {
            ELF
        };
        let relative = PROGRAM.trim_start_matches('/');
        let path = match variant {
            "absolute" => PROGRAM.to_owned(),
            "traversal" => format!("../{relative}"),
            _ => relative.to_owned(),
        };
        append_program(&mut archive, &path, data);
        if variant == "duplicate" || variant == "absolute-duplicate" {
            let duplicate = if variant == "absolute-duplicate" {
                PROGRAM
            } else {
                &path
            };
            append_program(&mut archive, duplicate, data);
        }
    }
    if variant != "missing-entry" {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_mode(0o777);
        header.set_size(0);
        header
            .set_link_name(if variant == "wrong-link" {
                "/bin/foreign"
            } else {
                PROGRAM
            })
            .unwrap();
        header.set_cksum();
        archive
            .append_data(&mut header, ENTRY, io::empty())
            .unwrap();
    }
    if variant == "whiteout" {
        let mut header = tar::Header::new_gnu();
        header.set_size(0);
        header.set_mode(0o444);
        header.set_cksum();
        archive
            .append_data(
                &mut header,
                "bin/.wh.reverie-worker-resource-controller",
                io::empty(),
            )
            .unwrap();
    }
    if variant == "root-link" {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_mode(0o777);
        header.set_size(0);
        header.set_link_name("/foreign").unwrap();
        header.as_mut_bytes()[0] = b'/';
        header.set_cksum();
        archive.append(&header, io::empty()).unwrap();
    }
    archive.into_inner().unwrap()
}
fn check(variant: &str) -> Result<()> {
    let member = format!("{}/layer.tar", "a".repeat(64));
    let root = std::env::temp_dir().join(format!(
        "image-program-test-{}-{variant}",
        std::process::id()
    ));
    fs::create_dir(&root).unwrap();
    let path = root.join("image.tar.gz");
    let file = File::create(&path).unwrap();
    let gzip = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
    let mut archive = tar::Builder::new(gzip);
    let bytes = layer(variant);
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o444);
    header.set_cksum();
    archive
        .append_data(&mut header, &member, bytes.as_slice())
        .unwrap();
    let mut gzip = archive.into_inner().unwrap();
    gzip.flush().unwrap();
    gzip.finish().unwrap();
    let mut file = File::open(&path).unwrap();
    let result = verify(
        &mut file,
        &[member],
        Path::new(PROGRAM),
        &format!("{:x}", Sha256::digest(ELF)),
        ELF.len() as u64,
        Instant::now() + Duration::from_secs(2),
    );
    drop(file);
    fs::remove_dir_all(root).unwrap();
    result
}

#[test]
fn exact_entry_link_and_program_bytes_are_required_together() {
    check("valid").unwrap();
    check("absolute").unwrap();
}

#[test]
fn missing_changed_duplicate_or_shadowed_program_never_creates_a_binding() {
    for case in [
        "missing-file",
        "missing-entry",
        "changed-bytes",
        "duplicate",
        "absolute-duplicate",
        "traversal",
        "wrong-link",
        "whiteout",
        "root-link",
    ] {
        assert!(check(case).is_err(), "{case}");
    }
}
