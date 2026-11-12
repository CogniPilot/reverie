//! Only these two fixed ephemeral mounts may accompany the retained real binds.
use super::*;
mod options;
pub(in crate::model) use options::normalize;

const TMP: &str = "rw,nosuid,nodev,size=256m,mode=1777";
pub(super) fn options(source: &Value) -> Result<Value> {
    let user = string(&source["Config"], "User")?;
    let (uid, gid) = user
        .split_once(':')
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_NUMERIC_OWNER_REQUIRED"))?;
    let parse = |value: &str| -> Result<u32> {
        let parsed = value
            .parse::<u32>()
            .map_err(|_| DeploymentError::new("DEPLOYMENT_NUMERIC_OWNER_REQUIRED"))?;
        require(
            parsed.to_string() == value,
            "DEPLOYMENT_NUMERIC_OWNER_REQUIRED",
        )?;
        Ok(parsed)
    };
    require(parse(uid)? > 0, "DEPLOYMENT_NUMERIC_OWNER_REQUIRED")?;
    parse(gid)?;
    Ok(json!({"/tmp":TMP,"/run":format!(
        "rw,nosuid,nodev,noexec,size=16m,mode=0755,uid={uid},gid={gid}"
    )}))
}
pub(super) fn source(source: &Value) -> Result<()> {
    let rows = mounts(source)?;
    if has_configuration(source) || rows.iter().any(|row| row["Type"] == "tmpfs") {
        return protected(source);
    }
    require(
        rows.iter().all(|row| row["Type"] == "bind")
            && (source["HostConfig"]["Tmpfs"].is_null()
                || source["HostConfig"]["Tmpfs"]
                    .as_object()
                    .is_some_and(|v| v.is_empty())),
        "DEPLOYMENT_EPHEMERAL_MOUNTS_UNSUPPORTED",
    )
}
pub(super) fn protected(source: &Value) -> Result<()> {
    let rows = mounts(source)?;
    require(
        normalize(&source["HostConfig"]["Tmpfs"])? == normalize(&options(source)?)?
            && source["HostConfig"]["IpcMode"] == "private"
            && matches!(
                source["HostConfig"]["PidMode"].as_str(),
                Some("" | "private")
            ),
        "DEPLOYMENT_EPHEMERAL_MOUNTS_CHANGED",
    )?;
    let mut selected = std::collections::BTreeSet::new();
    for row in rows {
        if row["Type"] == "bind" {
            continue;
        }
        let destination = row["Destination"].as_str();
        require(
            row["Type"] == "tmpfs"
                && matches!(destination, Some("/tmp" | "/run"))
                && selected.insert(destination.expect("checked fixed destination"))
                && row["RW"] == true
                && empty(&row["Source"])
                && mode(row, &source["HostConfig"]["Tmpfs"])?
                && empty(&row["Propagation"]),
            "DEPLOYMENT_EPHEMERAL_MOUNTS_CHANGED",
        )?;
    }
    // Legacy HostConfig.Tmpfs is not part of Container.MountPoints on Moby;
    // inspect can therefore list only real binds. Any corroborating rows must
    // still be the complete exact fixed pair, never a partial/unknown set.
    require(
        selected.is_empty() || selected.len() == 2,
        "DEPLOYMENT_EPHEMERAL_MOUNTS_CHANGED",
    )?;
    settings(&source["Config"], &source["HostConfig"], &source["Mounts"])
}
fn empty(value: &Value) -> bool {
    value.is_null() || value.as_str() == Some("")
}
fn mode(row: &Value, configured: &Value) -> Result<bool> {
    if empty(&row["Mode"]) {
        return Ok(true);
    }
    let destination = string(row, "Destination")?;
    Ok(options::row(&row["Mode"])? == options::row(&configured[destination])?)
}
pub(super) fn prospective(source: &Value) -> Result<Value> {
    let mut rows = Vec::new();
    for row in mounts(source)?.iter().filter(|row| row["Type"] == "bind") {
        require(
            !matches!(row["Destination"].as_str(), Some("/" | "/tmp" | "/run")),
            "DEPLOYMENT_EPHEMERAL_BIND_COLLISION",
        )?;
        rows.push(row.clone());
    }
    for destination in ["/tmp", "/run"] {
        rows.push(json!({"Type":"tmpfs","Source":"","Destination":destination,
            "Mode":"","RW":true,"Propagation":""}));
    }
    Ok(json!(rows))
}
pub(in crate::model) fn observed_mounts(source: &Value) -> Result<()> {
    if !has_configuration(source) && mounts(source)?.iter().all(|row| row["Type"] == "bind") {
        Ok(())
    } else {
        protected(source)
    }
}
pub(super) fn has_configuration(source: &Value) -> bool {
    let value = &source["HostConfig"]["Tmpfs"];
    !value.is_null() && value.as_object().is_none_or(|fields| !fields.is_empty())
}
