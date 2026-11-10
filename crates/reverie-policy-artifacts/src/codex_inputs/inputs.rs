//! Checks public lock/provenance DATA. Output names select no executable and
//! the resulting plan grants no installed custody, build or runtime acceptance.
use super::{Result, need};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
struct Lock {
    package: Vec<Package>,
}
#[derive(Deserialize)]
struct Package {
    name: String,
    version: String,
    source: Option<String>,
    checksum: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Provenance {
    lock_sha256: String,
    git_sources: BTreeMap<String, GitPin>,
    registry_packages: usize,
    patched_files: BTreeMap<String, String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitPin {
    output_hash_key: String,
    hash: String,
}
pub(super) struct Qualified {
    git_sources: usize,
    registry_packages: usize,
    patched_files: BTreeMap<String, String>,
    vendor_names: BTreeSet<String>,
}
impl Qualified {
    pub(super) fn from_inputs(lock: &[u8], provenance: &[u8], hashes: &[u8]) -> Result<Self> {
        // Decode JSON through Value first to retain the original producer's
        // last-key-wins input behavior, including known provenance fields.
        let provenance: Provenance = serde_json::from_value(serde_json::from_slice(provenance)?)?;
        let hashes: BTreeMap<String, String> = serde_json::from_slice(hashes)?;
        need(
            digest(lock) == provenance.lock_sha256,
            "Reconciled lock mismatch",
        )?;
        let lock: Lock = toml::from_str(std::str::from_utf8(lock)?)?;
        let groups = git_groups(&lock, &provenance)?;
        validate_git(&groups, &provenance.git_sources, &hashes)?;
        let registry_packages = registry_count(&lock)?;
        need(
            registry_packages == provenance.registry_packages,
            "Registry package count mismatch",
        )?;
        let vendor_names = lock
            .package
            .iter()
            .filter(|p| p.source.is_some())
            .map(package_name)
            .collect();
        Ok(Self {
            git_sources: groups.len(),
            registry_packages,
            patched_files: provenance.patched_files,
            vendor_names,
        })
    }
    pub(super) fn git_sources(&self) -> usize {
        self.git_sources
    }
    pub(super) fn registry_packages(&self) -> usize {
        self.registry_packages
    }
    pub(super) fn patched_files(&self) -> &BTreeMap<String, String> {
        &self.patched_files
    }
    pub(super) fn vendor_names(&self) -> &BTreeSet<String> {
        &self.vendor_names
    }
}
fn package_name(package: &Package) -> String {
    format!("{}-{}", package.name, package.version)
}
fn git_groups(lock: &Lock, provenance: &Provenance) -> Result<BTreeMap<String, Vec<String>>> {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for package in &lock.package {
        if let Some(source) = package.source.as_ref().filter(|v| v.starts_with("git+")) {
            groups
                .entry(source.clone())
                .or_default()
                .push(package_name(package));
        }
    }
    need(
        groups.keys().eq(provenance.git_sources.keys()),
        "Unexpected Git source or revision",
    )?;
    Ok(groups)
}
fn validate_git(
    groups: &BTreeMap<String, Vec<String>>,
    pins: &BTreeMap<String, GitPin>,
    hashes: &BTreeMap<String, String>,
) -> Result<()> {
    let keys: BTreeSet<_> = groups.values().map(|names| &names[0]).collect();
    need(
        keys.iter().copied().eq(hashes.keys()) && hashes.values().all(|v| sri(v)),
        "Missing, extra or invalid actual Git output hash",
    )?;
    for (source, names) in groups {
        let pin = &pins[source];
        need(
            pin.output_hash_key == names[0] && hashes[&names[0]] == pin.hash,
            "Git hash differs from qualified source manifest",
        )?;
    }
    Ok(())
}
fn registry_count(lock: &Lock) -> Result<usize> {
    let mut count = 0;
    for package in &lock.package {
        if package
            .source
            .as_ref()
            .is_some_and(|v| v.starts_with("registry+"))
        {
            need(
                package.checksum.as_deref().is_some_and(hex_digest),
                "Registry checksum unavailable",
            )?;
            count += 1;
        }
    }
    Ok(count)
}
fn hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
fn sri(value: &str) -> bool {
    value.strip_prefix("sha256-").is_some_and(|value| {
        value.len() == 44
            && value.ends_with('=')
            && value.as_bytes()[..43]
                .iter()
                .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'+' | b'/'))
    })
}
pub(super) fn digest(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}
pub(super) fn validate_vendor_configuration(raw: &[u8]) -> Result<()> {
    let value: toml::Value = toml::from_str(std::str::from_utf8(raw)?)?;
    need(
        value
            .get("source")
            .and_then(|v| v.get("crates-io"))
            .and_then(|v| v.get("replace-with"))
            .and_then(toml::Value::as_str)
            == Some("vendored-sources"),
        "Registry is not locked to the vendor directory",
    )
}
