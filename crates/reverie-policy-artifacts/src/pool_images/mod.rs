//! Fixed repository image factory facts only, never runtime permission.
mod archive;
mod error;
mod metadata;
use archive::Archive;
use clap::Parser;
use error::{Error, Result, finalized, need};
use reverie_contracts::resource_actor::{
    POOL_IMAGE_INPUT_FACTORY_FILES, POOL_IMAGE_INPUTS_PURPOSE, PoolImageInputsData,
};
use serde_json::{Map, Value, json};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Parser)]
struct Arguments {
    #[arg(long, value_parser=["x86_64-linux", "aarch64-linux"])]
    system: String,
    #[arg(long)]
    controller_archive: PathBuf,
    #[arg(long)]
    anchor_archive: PathBuf,
    #[arg(long)]
    source: PathBuf,
    #[arg(long)]
    output: PathBuf,
}
pub(super) fn requested() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|v| v == "pool-image-inputs")
}
pub(super) fn run() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let args = Arguments::parse_from(
        std::iter::once(std::env::args_os().next().unwrap_or_default())
            .chain(std::env::args_os().skip(2)),
    );
    seal(args).map_err(Into::into)
}
fn seal(args: Arguments) -> Result<()> {
    let end = Instant::now() + Duration::from_secs(300);
    let controller = measure(&args.controller_archive, true, &args.system, end)?;
    let anchor = measure(&args.anchor_archive, false, &args.system, end)?;
    let source = source(&args.source, end)?;
    let raw = serde_json::to_vec(&json!({"version":1,"purpose":POOL_IMAGE_INPUTS_PURPOSE,"system":args.system,"source":source,"controller":controller,"anchor":anchor}))
        .map_err(|_| Error::Refused("POOL_IMAGE_MANIFEST_ENCODING"))?;
    need(
        raw.len() <= archive::MAX_METADATA && Instant::now() < end,
        "POOL_IMAGE_MANIFEST_BOUND",
    )?;
    PoolImageInputsData::decode(&raw)?;
    crate::output::write_new(&args.output, &raw).map_err(Into::into)
}
fn measure(path: &Path, controller: bool, system: &str, end: Instant) -> Result<Value> {
    let mut input = Archive::open(path, end)?;
    let body = (|| {
        let selected = metadata::manifest(&input.metadata("manifest.json")?)?;
        let raw = input.metadata(&selected.config)?;
        let spec = metadata::config(&raw, &selected, controller, system)?;
        for (index, layer) in selected.layers.iter().enumerate() {
            let actual = input.layer_digest(layer)?;
            need(
                spec["RootFS"]["Layers"][index] == format!("sha256:{actual}"),
                "POOL_IMAGE_LAYER_DIGEST",
            )?;
        }
        input.assert_current()?;
        Ok(
            json!({"archive":{"path":input.path()?,"sha256":input.digest(),"bytes":input.bytes()},"archiveConfigSHA256":selected.config.trim_end_matches(".json"),"imageSpec":spec}),
        )
    })();
    finalized(body, input.close())
}
fn source(path: &Path, end: Instant) -> Result<Value> {
    let root = path.canonicalize()?;
    need(root == path && root.is_dir(), "POOL_IMAGE_SOURCE_ROOT")?;
    let mut files = Map::new();
    for name in POOL_IMAGE_INPUT_FACTORY_FILES {
        let mut file = Archive::open(&root.join(name), end)?;
        let body = file
            .assert_current()
            .map(|()| json!({"sha256":file.digest(),"bytes":file.bytes()}));
        files.insert(name.into(), finalized(body, file.close())?);
    }
    Ok(json!({"path":root.to_str().ok_or(Error::Refused("POOL_IMAGE_SOURCE_UTF8"))?,"files":files}))
}
