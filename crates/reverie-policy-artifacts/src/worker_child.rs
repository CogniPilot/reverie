//! Fixed build-only facts. Neither manifests nor labels grant installed authority.
use crate::output;
use clap::{Parser, Subcommand};
use reverie_core::worker_child::CHILD_PROGRAM;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const ABI: &str = "record-pane-exit-v1";
const LABEL: &str = "org.reverie.worker.child-manifest";

#[derive(Parser)]
struct Arguments {
    #[command(subcommand)]
    action: Action,
}
#[derive(Subcommand)]
enum Action {
    WorkerChildProgram {
        #[arg(long)]
        program: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    VerifyWorkerChildRoot {
        #[arg(long)]
        program: PathBuf,
        #[arg(long)]
        manifest: PathBuf,
    },
    WorkerChildImage {
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        base_provenance: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
}
#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
struct Pin {
    path: String,
    sha256: String,
    bytes: u64,
}
#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Program {
    version: u32,
    purpose: String,
    abi: String,
    program: Pin,
    elf_machine: u16,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Base {
    version: u32,
    purpose: String,
    #[serde(rename = "archiveConfigSHA256")]
    archive_config_sha256: String,
    archive: Pin,
    image_spec: Value,
    factory: Value,
    source: Value,
    toolkit: Value,
}
pub(super) fn requested() -> bool {
    std::env::args_os().nth(1).is_some_and(|v| {
        matches!(
            v.to_str(),
            Some("worker-child-program" | "verify-worker-child-root" | "worker-child-image")
        )
    })
}
pub(super) fn run() -> Result<()> {
    match Arguments::parse().action {
        Action::WorkerChildProgram {
            program: path,
            output: destination,
        } => write(&destination, &serde_json::to_value(program(&path)?)?),
        Action::VerifyWorkerChildRoot {
            program: path,
            manifest,
        } => {
            need(
                path.ends_with(CHILD_PROGRAM.trim_start_matches('/')),
                "WORKER_CHILD_FIXED_GUEST_ALIAS_REQUIRED",
            )?;
            let (expected, _) = manifest_program(&manifest)?;
            need(
                program(&path)? == expected,
                "WORKER_CHILD_ROOT_PROGRAM_DIFFERENT",
            )
        }
        Action::WorkerChildImage {
            manifest,
            base_provenance,
            output,
        } => write(&output, &image(&manifest, &base_provenance)?),
    }
}
fn need(value: bool, reason: &'static str) -> Result<()> {
    if value { Ok(()) } else { Err(reason.into()) }
}
fn fingerprint(m: &fs::Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
    (
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}
fn read(path: &Path, maximum: usize) -> Result<(Vec<u8>, Pin)> {
    let real = reverie_elf_bundle::immutable_input(path)?;
    read_document(&real, maximum)
}
fn read_document(path: &Path, maximum: usize) -> Result<(Vec<u8>, Pin)> {
    let real = path.canonicalize()?;
    let before = fs::metadata(&real)?;
    need(
        before.is_file() && before.mode() & 0o222 == 0 && before.len() <= maximum as u64,
        "WORKER_CHILD_IMMUTABLE_INPUT_BOUND",
    )?;
    let bytes = output::read_bounded(&real, maximum)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    need(
        bytes.len() <= maximum
            && bytes.len() as u64 == before.len()
            && fingerprint(&before) == fingerprint(&fs::metadata(&real)?),
        "WORKER_CHILD_INPUT_CHANGED",
    )?;
    Ok((
        bytes,
        Pin {
            path: real.to_str().ok_or("WORKER_CHILD_INPUT_UTF8")?.into(),
            sha256: digest,
            bytes: before.len(),
        },
    ))
}
fn program(path: &Path) -> Result<Program> {
    let (_, pin) = read(path, 32 << 20)?;
    need(
        Path::new(&pin.path).file_name() == Path::new(CHILD_PROGRAM).file_name(),
        "WORKER_CHILD_FIXED_PROGRAM_NAME",
    )?;
    let machine = reverie_elf_bundle::executable_machine(Path::new(&pin.path))?;
    need(matches!(machine, 62 | 183), "WORKER_CHILD_ELF_MACHINE")?;
    Ok(Program {
        version: 1,
        purpose: "worker-child-program-v1".into(),
        abi: ABI.into(),
        program: pin,
        elf_machine: machine,
    })
}
fn manifest_program(path: &Path) -> Result<(Program, Pin)> {
    let (bytes, pin) = read_document(path, 16 << 10)?;
    let document: Program = serde_json::from_slice(&bytes)?;
    need(
        document.version == 1
            && document.purpose == "worker-child-program-v1"
            && document.abi == ABI,
        "WORKER_CHILD_PROGRAM_SCHEMA",
    )?;
    need(
        program(Path::new(&document.program.path))? == document,
        "WORKER_CHILD_PROGRAM_BYTES_DIFFERENT",
    )?;
    Ok((document, pin))
}
fn image(manifest: &Path, base: &Path) -> Result<Value> {
    let (document, manifest_pin) = manifest_program(manifest)?;
    need(
        Path::new(&manifest_pin.path).starts_with("/nix/store"),
        "WORKER_CHILD_IMAGE_IMMUTABLE_MANIFEST_REQUIRED",
    )?;
    let (raw, base_pin) = read(base, 4 << 20)?;
    let base: Base = serde_json::from_slice(&raw)?;
    assemble(document, manifest_pin, base, base_pin)
}
fn assemble(document: Program, manifest_pin: Pin, base: Base, base_pin: Pin) -> Result<Value> {
    need(
        base.version == 1 && base.purpose == "worker-image-provenance-v1",
        "WORKER_CHILD_BASE_PROVENANCE_SCHEMA",
    )?;
    need(
        base.image_spec["Config"]["Labels"][LABEL].as_str() == Some(manifest_pin.path.as_str()),
        "WORKER_CHILD_IMAGE_MANIFEST_LABEL_DIFFERENT",
    )?;
    let wanted = if document.elf_machine == 62 {
        ("x86_64-linux", "amd64")
    } else {
        ("aarch64-linux", "arm64")
    };
    need(
        base.factory["system"] == wanted.0
            && base.image_spec["Architecture"] == wanted.1
            && base.image_spec["Os"] == "linux",
        "WORKER_CHILD_IMAGE_MACHINE_DIFFERENT",
    )?;
    // The existing fixed factory owns full archive/Config/RootFS/toolkit validation.
    // Keep its exact values; this annex adds only the child construction binding.
    need(
        base.source.is_object() && base.toolkit.is_object(),
        "WORKER_CHILD_BASE_PROVENANCE_SCHEMA",
    )?;
    let mut child = serde_json::to_value(document)?;
    child["manifest"] = serde_json::to_value(manifest_pin)?;
    Ok(
        serde_json::json!({"version":1,"purpose":"worker-child-image-v1","baseProvenance":base_pin,
        "archiveConfigSHA256":base.archive_config_sha256,"archive":base.archive,
        "imageSpec":base.image_spec,"factory":base.factory,"workerChild":child}),
    )
}
fn write(path: &Path, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    Ok(output::write_new(path, &bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(label: Option<&str>, architecture: &str) -> (Program, Pin, Base, Pin) {
        let pin = || Pin {
            path: "/nix/store/fixed/input.json".into(),
            sha256: "a".repeat(64),
            bytes: 12,
        };
        let mut labels = serde_json::Map::new();
        if let Some(label) = label {
            labels.insert(LABEL.into(), label.into());
        }
        let base = Base {
            version: 1,
            purpose: "worker-image-provenance-v1".into(),
            archive_config_sha256: "b".repeat(64),
            archive: pin(),
            image_spec: serde_json::json!({"Config":{"Labels":labels},"RootFS":{"Type":"layers","Layers":[]},"Architecture":architecture,"Os":"linux"}),
            factory: serde_json::json!({"system":"x86_64-linux"}),
            source: serde_json::json!({}),
            toolkit: serde_json::json!({}),
        };
        let program = Program {
            version: 1,
            purpose: "worker-child-program-v1".into(),
            abi: ABI.into(),
            program: pin(),
            elf_machine: 62,
        };
        (program, pin(), base, pin())
    }
    #[test]
    fn preserved_v1_archive_config_key_is_exact() {
        // Literal wire spelling from the existing v1 producer, independent of
        // Rust's field-name conversion. Do not change the base document.
        let actual_v1 = serde_json::json!({
            "version":1, "purpose":"worker-image-provenance-v1",
            "archiveConfigSHA256":"b".repeat(64),
            "archive":{"path":"/nix/store/fixed/archive", "sha256":"a".repeat(64), "bytes":12},
            "imageSpec":{}, "factory":{}, "source":{}, "toolkit":{}
        });
        let decoded: Base = serde_json::from_value(actual_v1.clone()).unwrap();
        assert_eq!(decoded.archive_config_sha256, "b".repeat(64));
        let mut foreign_spelling = actual_v1;
        let fields = foreign_spelling.as_object_mut().unwrap();
        let digest = fields.remove("archiveConfigSHA256").unwrap();
        fields.insert("archiveConfigSha256".into(), digest);
        assert!(serde_json::from_value::<Base>(foreign_spelling).is_err());
    }
    #[test]
    fn annex_refuses_old_foreign_or_wrong_arch_image_and_preserves_exact_spec() {
        for (label, arch) in [
            (None, "amd64"),
            (Some("/nix/store/foreign/manifest.json"), "amd64"),
            (Some("/nix/store/fixed/input.json"), "arm64"),
        ] {
            let (program, manifest, base, pin) = fixture(label, arch);
            assert!(assemble(program, manifest, base, pin).is_err());
        }
        let (program, manifest, base, pin) = fixture(Some("/nix/store/fixed/input.json"), "amd64");
        let expected = base.image_spec.clone();
        let result = assemble(program, manifest, base, pin).unwrap();
        assert_eq!(result["imageSpec"], expected);
        assert_eq!(
            result["workerChild"]["manifest"]["path"],
            "/nix/store/fixed/input.json"
        );
    }
}
