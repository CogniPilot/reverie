use super::super::{Result, build_archive, pin, qualify_layers, qualify_toolkit_binary};
use flate2::{Compression, write::GzEncoder};
use reverie_contracts::resource_actor::{HUMAN_TERMINAL_FILES, WorkerImageProvenanceBuild};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder, File},
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
use tar::{Builder, EntryType, Header};

pub(super) const DIRS: [&str; 4] = [
    "opt",
    "opt/reverie",
    "opt/reverie/human",
    "opt/reverie/human/bin",
];
static NEXT: AtomicUsize = AtomicUsize::new(0);

pub(super) struct Fixture {
    pub(super) root: PathBuf,
    pub(super) profile: Value,
    pub(super) image: Value,
    pub(super) manifest: Value,
    pub(super) program: Vec<u8>,
}

impl Fixture {
    pub(super) fn new(arm: bool) -> Self {
        let root = fresh_root();
        let (system, architecture, elf) = if arm {
            ("aarch64-linux", "arm64", 183)
        } else {
            ("x86_64-linux", "amd64", 62)
        };
        let profile = json!({
            "name":"lib.workerDockerImage","system":system,"uid":1000,"gid":100,
            "subuidStart":100000,"subgidStart":100000,"subidCount":65536,"browser":arm
        });
        let mut image = json!({
            "architecture": architecture, "os": "linux", "created": "1970-01-01T00:00:01Z",
            "config": {
                "User":"1000:100","Entrypoint":["/bin/sleep"],"Cmd":["infinity"],
                "WorkingDir":"/reverie_workspace",
                "Labels":{
                    "org.reverie.worker.uid":"1000","org.reverie.worker.gid":"100",
                    "org.reverie.worker.rootless-docker":"1","org.reverie.worker.rootless-docker.mount-layout":"1",
                    "org.reverie.worker.subuid-start":"100000","org.reverie.worker.subgid-start":"100000",
                    "org.reverie.worker.subid-count":"65536","reverie.worker.nix-store":"1"
                }
            }
        });
        if arm {
            image["config"]["Labels"]["org.reverie.worker.browser"] = json!("1");
        }
        let program = program(elf, 1);
        let mut manifest = json!({"version":1,"static":true,"files":{}});
        for name in HUMAN_TERMINAL_FILES {
            manifest["files"][name] = json!({"sha256": sha(&program), "bytes": program.len()});
        }
        Self {
            root,
            profile,
            image,
            manifest,
            program,
        }
    }

    pub(super) fn entries(&self) -> Vec<Member<'_>> {
        let mut items: Vec<_> = DIRS.iter().map(|name| Member::directory(name)).collect();
        items.extend(
            HUMAN_TERMINAL_FILES
                .iter()
                .map(|name| Member::file(name.trim_start_matches('/'), &self.program)),
        );
        items
    }

    pub(super) fn archive(
        &self,
        levels: &[Vec<Member<'_>>],
        wrong_digest: bool,
        extra: bool,
    ) -> PathBuf {
        let layers: Vec<_> = levels.iter().map(|members| layer(members)).collect();
        let names: Vec<_> = (0..layers.len())
            .map(|n| format!("layer-{n}/layer.tar"))
            .collect();
        let mut hashes: Vec<_> = layers
            .iter()
            .map(|bytes| format!("sha256:{}", sha(bytes)))
            .collect();
        if wrong_digest {
            hashes[0] = format!("sha256:{}", "a".repeat(64));
        }
        let mut metadata = self.image.clone();
        metadata["rootfs"] = json!({"type":"layers","diff_ids":hashes});
        let raw = serde_json::to_vec(&metadata).unwrap();
        let config = format!("{}.json", sha(&raw));
        let manifest = serde_json::to_vec(
            &json!([{"Config":config,"RepoTags":["owned:fixture"],"Layers":names}]),
        )
        .unwrap();
        let path = self.root.join("worker.tar.gz");
        let output = File::create(&path).unwrap();
        let mut archive = Builder::new(GzEncoder::new(output, Compression::fast()));
        for (name, bytes) in names.iter().zip(&layers) {
            Member::file(name, bytes).append(&mut archive);
        }
        Member::file(&config, &raw).append(&mut archive);
        Member::file("manifest.json", &manifest).append(&mut archive);
        if extra {
            Member::file("unreferenced/layer.tar", &layer(&[])).append(&mut archive);
        }
        archive.into_inner().unwrap().finish().unwrap();
        path
    }

    pub(super) fn qualify(&self, path: &Path, end: Instant) -> Result<WorkerImageProvenanceBuild> {
        let mut input = File::open(path)?;
        let (metadata, members) = build_archive::held_metadata(&mut input, end)?;
        let toolkit = serde_json::to_vec(&self.manifest)?;
        let manifest = pin(
            Path::new("/nix/store/fixture-toolkit/share/reverie-human-terminal/manifest.json"),
            &toolkit,
        )?;
        let build = WorkerImageProvenanceBuild::new(
            metadata,
            &serde_json::to_vec(&self.profile)?,
            &toolkit,
            &manifest,
        )?;
        for expected in build.toolkit_files() {
            qualify_toolkit_binary(&self.program, expected, build.elf_machine())?;
        }
        qualify_layers(&mut input, &build, &members, end)?;
        Ok(build)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn fresh_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "reverie-worker-factory-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed),
    ));
    DirBuilder::new().mode(0o700).create(&root).unwrap();
    root
}

pub(super) fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(10)
}

pub(super) fn sha(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}

pub(super) fn program(machine: u16, header: u32) -> Vec<u8> {
    let mut raw = vec![0_u8; 152];
    raw[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
    raw[16..18].copy_from_slice(&2_u16.to_le_bytes());
    raw[18..20].copy_from_slice(&machine.to_le_bytes());
    raw[20..24].copy_from_slice(&1_u32.to_le_bytes());
    raw[32..40].copy_from_slice(&64_u64.to_le_bytes());
    raw[52..54].copy_from_slice(&64_u16.to_le_bytes());
    raw[54..56].copy_from_slice(&56_u16.to_le_bytes());
    raw[56..58].copy_from_slice(&1_u16.to_le_bytes());
    raw[64..68].copy_from_slice(&header.to_le_bytes());
    if header == 2 {
        raw[72..80].copy_from_slice(&120_u64.to_le_bytes());
        raw[96..104].copy_from_slice(&32_u64.to_le_bytes());
        raw[120..128].copy_from_slice(&1_u64.to_le_bytes());
    }
    raw
}

pub(super) struct Member<'a> {
    pub(super) name: &'a str,
    pub(super) kind: EntryType,
    pub(super) mode: u32,
    pub(super) uid: u64,
    pub(super) bytes: &'a [u8],
}

impl<'a> Member<'a> {
    pub(super) fn file(name: &'a str, bytes: &'a [u8]) -> Self {
        Self {
            name,
            mode: 0o555,
            uid: 0,
            kind: EntryType::Regular,
            bytes,
        }
    }

    pub(super) fn directory(name: &'a str) -> Self {
        Self {
            kind: EntryType::Directory,
            mode: 0o755,
            ..Self::file(name, b"")
        }
    }

    fn append(&self, archive: &mut Builder<impl std::io::Write>) {
        let mut header = Header::new_gnu();
        header.set_entry_type(self.kind);
        header.set_mode(self.mode);
        header.set_uid(self.uid);
        header.set_gid(0);
        header.set_size(self.bytes.len() as u64);
        if self.kind.is_hard_link() || self.kind.is_symlink() {
            header.set_link_name("opt/reverie/human/bin/bash").unwrap();
        }
        archive
            .append_data(&mut header, self.name, self.bytes)
            .unwrap();
    }
}

pub(super) fn layer(members: &[Member<'_>]) -> Vec<u8> {
    let mut builder = Builder::new(Vec::new());
    for member in members {
        member.append(&mut builder);
    }
    builder.into_inner().unwrap()
}
