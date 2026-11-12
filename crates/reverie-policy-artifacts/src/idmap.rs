//! Fixed build-only ELF producer; no helper execution or privilege grant.
use clap::Parser;
use reverie_elf_bundle::{Tools, build_idmap};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "reverie-policy-artifacts idmap-image")]
struct Arguments {
    #[arg(long)]
    shadow: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    closure: PathBuf,
    #[arg(long)]
    patchelf: PathBuf,
    #[arg(long)]
    readelf: PathBuf,
}
pub(super) fn requested() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|value| value == "idmap-image")
}
pub(super) fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = Arguments::parse_from(
        std::iter::once(std::env::args_os().next().unwrap_or_default())
            .chain(std::env::args_os().skip(2)),
    );
    let tools = Tools::new(&args.patchelf, &args.readelf)?;
    build_idmap(&args.shadow, &args.output, &args.closure, &tools)
}
