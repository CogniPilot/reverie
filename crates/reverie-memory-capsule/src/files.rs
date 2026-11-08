pub(crate) use reverie_elf_bundle::{copy, digest, machine, readonly, tree};

#[derive(serde::Serialize)]
pub(crate) struct Entry {
    pub(crate) path: String,
    pub(crate) input_sha256: Option<String>,
    pub(crate) sha256: String,
    pub(crate) machine: Option<u16>,
    pub(crate) treatment: String,
}
