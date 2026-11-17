use crate::{
    archive::{SavedImage, malformed},
    detectors,
    layout::{self, Allowlist},
    report::Report,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs::File,
    io::{self, Read},
};
use tar::{Archive, Entry};

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Manifest {
    config: String,
    layers: Vec<String>,
}

#[derive(Deserialize)]
struct ImageConfig {
    config: Option<serde_json::Map<String, Value>>,
    history: Option<Vec<History>>,
}

#[derive(Deserialize)]
struct History {
    created_by: Option<String>,
}

pub(crate) fn scan(file: File, allowlist: &Allowlist) -> io::Result<Report> {
    let mut image = SavedImage::open(file)?;
    let manifest: Vec<Manifest> = image.json("manifest.json")?;
    let [manifest] = manifest.as_slice() else {
        return Err(malformed("expected exactly one image in the archive"));
    };
    let config: ImageConfig = image.json(&manifest.config)?;
    let mut report = Report::default();
    scan_config(config, &mut report);
    for (index, layer) in manifest.layers.iter().enumerate() {
        scan_layer(image.layer(layer)?, allowlist, index, &mut report)?;
    }
    report.layers = manifest.layers.len();
    report.clean = report.findings.is_empty();
    Ok(report)
}

fn scan_config(config: ImageConfig, report: &mut Report) {
    let entries = config.config.unwrap_or_default();
    for key in ["Env", "Labels", "Entrypoint", "Cmd"] {
        let Some(entry) = entries.get(key) else {
            continue;
        };
        let serialized = entry.to_string();
        let location = format!("config.{key}");
        for detector in detectors::names(&serialized) {
            report.finding(&location, detector);
        }
    }
    let steps = config
        .history
        .into_iter()
        .flatten()
        .filter_map(|step| step.created_by);
    for step in steps {
        for detector in detectors::names(&step) {
            report.finding("config.history", detector);
        }
    }
}

fn scan_layer(
    mut archive: Archive<impl Read>,
    allowlist: &Allowlist,
    index: usize,
    report: &mut Report,
) -> io::Result<()> {
    for item in archive.entries()? {
        let entry = item?;
        let name = layout::path(&String::from_utf8_lossy(&entry.path_bytes())).to_owned();
        if layout::leaf(&name).starts_with(".wh.") {
            continue;
        }
        let location = format!("layer {index}: /{name}");
        if layout::instance_file(&name) {
            report.finding(&location, "instance_file");
        }
        if !entry.header().entry_type().is_dir() && layout::mount_point(&name) {
            report.finding(&location, "mount_point_not_empty");
        }
        scan_entry(entry, &name, &location, allowlist, report)?;
    }
    Ok(())
}

fn scan_entry<R: Read>(
    entry: Entry<'_, R>,
    name: &str,
    location: &str,
    allowlist: &Allowlist,
    report: &mut Report,
) -> io::Result<()> {
    let kind = entry.header().entry_type();
    if kind.is_hard_link() || kind.is_symlink() {
        scan_link(&entry, name, location, report)?;
    }
    if !kind.is_file() && !kind.is_contiguous() && !kind.is_gnu_sparse() {
        return Ok(());
    }
    if let Some(prefix) = layout::third_party(name) {
        report.skip_contents(prefix, entry.size());
        return Ok(());
    }
    for detector in detectors::file_names(entry)? {
        if !allowlist.contains(&(name.to_owned(), detector.to_owned())) {
            report.finding(location, detector);
        }
    }
    Ok(())
}

fn scan_link<R: Read>(
    entry: &Entry<'_, R>,
    name: &str,
    location: &str,
    report: &mut Report,
) -> io::Result<()> {
    let target = entry
        .link_name_bytes()
        .ok_or_else(|| malformed("missing layer link target"))?;
    let target = layout::link_target(
        name,
        &String::from_utf8_lossy(&target),
        entry.header().entry_type().is_symlink(),
    );
    if layout::instance_file(&target) {
        report.finding(location, "link_to_instance_file");
    }
    if layout::mount_point(&format!("{target}/")) {
        report.finding(location, "link_into_mount_point");
    }
    Ok(())
}
