//! Compile an owner-selected, immutable worker GPU profile for the boxed image.

use crate::config::Result;
use reverie_core::device_policy::NvidiaCdiDevice;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;

pub(crate) fn project(mut arguments: impl Iterator<Item = OsString>) -> Result<i32> {
    let input = arguments
        .next()
        .ok_or("boxed runtime configuration required")?;
    let device = arguments.next().ok_or("worker GPU CDI device required")?;
    let device = device
        .to_str()
        .ok_or("worker GPU CDI device must be UTF-8")?;
    let paths = arguments
        .map(|path| path.into_string().map_err(|_| "driver path must be UTF-8"))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut configuration: Value = serde_json::from_slice(&fs::read(input)?)?;
    let fields = configuration
        .as_object_mut()
        .ok_or("expected a boxed runtime object")?;
    if fields.contains_key("workerGpu") {
        return Err("workerGpu already present in boxed runtime configuration".into());
    }
    fields.insert("workerGpu".into(), projection(device, &paths)?);
    let encoded = configuration.to_string();
    if encoded.len() > 16384 {
        return Err("boxed runtime configuration exceeds 16 KiB".into());
    }
    println!("{encoded}");
    Ok(0)
}

fn projection(device: &str, paths: &[String]) -> Result<Value> {
    let device = NvidiaCdiDevice::parse(device).map_err(|_| "exact NVIDIA CDI UUID required")?;
    if paths.len() > 96 {
        return Err("worker GPU driver closure exceeds 96 store paths".into());
    }
    let closure: BTreeSet<_> = paths.iter().collect();
    if closure.len() != paths.len() || !closure.iter().all(|path| store_path(path)) {
        return Err("worker GPU driver closure has duplicate or invalid store paths".into());
    }
    Ok(json!({
        "device": device.as_str(),
        "driverStorePaths": closure,
    }))
}

fn store_path(path: &str) -> bool {
    let Some(basename) = path.strip_prefix("/nix/store/") else {
        return false;
    };
    basename.len() <= 211
        && basename.split_once('-').is_some_and(|(hash, name)| {
            hash.len() == 32
                && hash
                    .bytes()
                    .all(|b| b"0123456789abcdfghijklmnpqrsvwxyz".contains(&b))
                && !name.is_empty()
                && !name.ends_with(".drv")
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+-._?=".contains(&b))
        })
}

#[cfg(test)]
mod tests {
    use super::projection;
    use serde_json::json;

    const DEVICE: &str = "nvidia.com/gpu=GPU-aaaaaaaa-1111-2222-3333-444444444444";
    const DRIVER: &str = "/nix/store/00000000000000000000000000000000-nvidia";
    const DEPENDENCY: &str = "/nix/store/11111111111111111111111111111111-glibc";

    #[test]
    fn emits_an_exact_device_and_sorted_read_only_mount_sources() {
        assert_eq!(
            projection(DEVICE, &[DEPENDENCY.into(), DRIVER.into()]).unwrap(),
            json!({"device":DEVICE,"driverStorePaths":[DRIVER,DEPENDENCY]})
        );
        assert!(projection(DEVICE, &[]).is_ok());
    }

    #[test]
    fn rejects_wildcard_devices_whole_store_and_duplicate_mounts() {
        assert!(projection("nvidia.com/gpu=all", &[]).is_err());
        assert!(projection(DEVICE, &["/nix/store".into()]).is_err());
        assert!(projection(DEVICE, &[format!("{DRIVER}/lib")]).is_err());
        assert!(projection(DEVICE, &[DRIVER.into(), DRIVER.into()]).is_err());
    }
}
