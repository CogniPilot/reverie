//! Fixed manifest in a fresh Nix build output. This is not installed custody,
//! an image grant, a terminal execution, or a runtime configuration interface.
mod files;
use crate::{
    build_input::{Result, need},
    output,
};
use clap::Parser;
use reverie_contracts::resource_actor::HUMAN_TERMINAL_FILES;
use serde_json::{Map, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    about = "Seal the exact two static human-terminal files in a fresh Nix build output; executes neither program"
)]
struct Arguments {
    #[arg(long)]
    root: PathBuf,
    #[arg(long, value_parser=["x86_64-linux", "aarch64-linux"])]
    system: String,
}
pub(super) fn requested() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|v| v == "human-terminal-manifest")
}
pub(super) fn run() -> Result<()> {
    let args = Arguments::parse_from(
        std::iter::once(std::env::args_os().next().unwrap_or_default())
            .chain(std::env::args_os().skip(2)),
    );
    let machine = if args.system == "x86_64-linux" {
        62
    } else {
        183
    };
    files::with_root(&args.root, |root| {
        let mut files = Map::new();
        for name in HUMAN_TERMINAL_FILES {
            let data = root.read(name.trim_start_matches('/'))?;
            reverie_elf_bundle::require_static_elf64(&data, machine)?;
            files.insert(
                name.into(),
                json!({"sha256":format!("{:x}",Sha256::digest(&data)),"bytes":data.len()}),
            );
        }
        let mut value = json!({"version":1,"static":true,"files":files});
        value.sort_all_objects();
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        need(bytes.len() <= 8192, "HUMAN_TOOLKIT_MANIFEST_BOUND")?;
        root.assert_current()?;
        output::write_new(
            &args.root.join("share/reverie-human-terminal/manifest.json"),
            &bytes,
        )?;
        Ok(())
    })
}
