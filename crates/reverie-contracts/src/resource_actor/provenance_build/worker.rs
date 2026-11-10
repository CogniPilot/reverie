//! Existing v1 worker factory DATA. Its legacy selected-file pins are not a
//! complete Rust source proof or an authority grant. Qualification is external.
use super::*;
use sha2::{Digest, Sha256};

pub const WORKER_IMAGE_V1_FACTORY_FILES: [&str; 11] = [
    "flake.nix",
    "nix/image.nix",
    "nix/human-terminal-toolkit.nix",
    "nix/worker-idmap.nix",
    "nix/worker-idmap.py",
    "nix/worker-base-tools.nix",
    "python/reverie/human_terminal_static.c",
    "python/reverie/worker_image_provenance.py",
    "python/reverie/website_image_provenance.py",
    "python/reverie/__init__.py",
    "nix/worker-image-provenance.nix",
];
pub const HUMAN_TERMINAL_FILES: [&str; 2] = [
    "/opt/reverie/human/bin/bash",
    "/opt/reverie/human/bin/reverie-human-shell",
];
pub struct WorkerImageProvenanceBuild {
    image: WebsiteArchiveConfiguration,
    factory: Value,
    toolkit: Value,
    toolkit_files: Vec<CodeFile>,
    machine: u16,
}
impl WorkerImageProvenanceBuild {
    /// Native build caller must verify each toolkit pin and ELF, all actual
    /// layer hashes and final path state before publishing the encoded facts.
    pub fn new(
        image: WebsiteArchiveConfiguration,
        factory: &[u8],
        toolkit: &[u8],
        manifest: &CodeFile,
    ) -> Result<Self> {
        need(
            manifest.bytes == toolkit.len() as u64
                && manifest.sha256.as_str() == format!("{:x}", Sha256::digest(toolkit)),
            "WORKER_BUILD_TOOLKIT_MANIFEST_BYTES",
        )?;
        let factory = decode(factory, 4096)?;
        super::super::worker_image::factory::validate(&factory, &image.image)?;
        let mut toolkit = decode(toolkit, 8192)?;
        closed(&toolkit, &["version", "static", "files"])?;
        let Node::Object(fields) = &mut toolkit.0 else {
            unreachable!("closed object");
        };
        fields.insert(key("manifest"), code_value(manifest));
        super::super::worker_image::factory::toolkit(&toolkit)?;
        let files = object(field(&toolkit, "files")?)?;
        let mut toolkit_files = Vec::new();
        for name in HUMAN_TERMINAL_FILES {
            let pin = files
                .get(&key(name))
                .ok_or(ResourceActorDataError("WORKER_BUILD_TOOLKIT_PIN"))?;
            let bytes = unsigned(field(pin, "bytes")?)?
                .to_u64()
                .ok_or(ResourceActorDataError("WORKER_BUILD_TOOLKIT_PIN"))?;
            need((64..=16 << 20).contains(&bytes), "WORKER_BUILD_TOOLKIT_PIN")?;
            toolkit_files.push(CodeFile {
                path: PythonText::from_scalar_text(name),
                sha256: digest(field(pin, "sha256")?)?,
                bytes,
            });
        }
        let machine = if scalar(field(&factory, "system")?)? == "x86_64-linux" {
            62
        } else {
            183
        };
        Ok(Self {
            image,
            factory,
            toolkit,
            toolkit_files,
            machine,
        })
    }
    pub fn toolkit_files(&self) -> &[CodeFile] {
        &self.toolkit_files
    }
    pub fn elf_machine(&self) -> u16 {
        self.machine
    }
    pub fn require_layer_hashes(
        &self,
        selected: &WebsiteArchiveManifest,
        actual: &[(PythonText, JournalDigest)],
    ) -> Result<()> {
        let names = selected.layer_members();
        let expected = array(field(field(&self.image.image, "RootFS")?, "Layers")?)?;
        need(
            names.len() == actual.len()
                && names.len() == expected.len()
                && names
                    .iter()
                    .enumerate()
                    .all(|(i, name)| !names[..i].contains(name)),
            "WORKER_BUILD_COMPLETE_LAYER_ORDER",
        )?;
        for (name, expected) in names.iter().zip(expected) {
            let matched: Vec<_> = actual.iter().filter(|(path, _)| path == name).collect();
            need(
                matched.len() == 1
                    && scalar(expected)? == format!("sha256:{}", matched[0].1.as_str()),
                "WORKER_BUILD_LAYER_DIFF_ID",
            )?;
        }
        Ok(())
    }
    pub fn encode(
        &self,
        archive: &CodeFile,
        source: &PythonText,
        files: &[CodeFile],
    ) -> Result<Vec<u8>> {
        need(
            files.len() == WORKER_IMAGE_V1_FACTORY_FILES.len(),
            "WORKER_BUILD_V1_SOURCE_PINS",
        )?;
        let mut source_files = BTreeMap::new();
        for (name, pin) in WORKER_IMAGE_V1_FACTORY_FILES.iter().zip(files) {
            let mut expected = source.codepoints().to_vec();
            expected.extend(format!("/{name}").chars().map(u32::from));
            need(
                pin.path.codepoints() == expected && (1..=1 << 20).contains(&pin.bytes),
                "WORKER_BUILD_V1_SOURCE_PINS",
            )?;
            source_files.insert(key(name), pin_value(pin));
        }
        let value = fields([
            ("version", integer(1)),
            ("purpose", string("worker-image-provenance-v1")),
            ("archiveConfigSHA256", string(self.image.digest.as_str())),
            ("imageSpec", self.image.image.deep_clone()),
            ("archive", code_value(archive)),
            ("factory", self.factory.deep_clone()),
            (
                "source",
                fields([
                    ("path", python_string(source)),
                    ("factoryFiles", Value(Node::Object(source_files))),
                ]),
            ),
            ("toolkit", self.toolkit.deep_clone()),
        ]);
        let mut bytes = crate::worker_config::compact_data(&value);
        bytes.push(b'\n');
        Ok(bytes)
    }
}
fn code_value(pin: &CodeFile) -> Value {
    fields([
        ("path", python_string(&pin.path)),
        ("sha256", string(pin.sha256.as_str())),
        ("bytes", integer(pin.bytes)),
    ])
}
