//! Closed bind-only projection: never let Docker create a missing host source.
use super::*;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

const INVALID: &str = "DEPLOYMENT_BIND_LAYOUT_UNSUPPORTED";
fn check(value: bool) -> Result<()> {
    require(value, INVALID)
}
fn list(value: &Value) -> Result<&[Value]> {
    if value.is_null() {
        Ok(&[])
    } else {
        value
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| DeploymentError::new(INVALID))
    }
}
fn path(value: &Value) -> Result<&str> {
    let text = value
        .as_str()
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    check(text.starts_with('/') && !text.contains('\0'))?;
    Ok(text)
}
fn propagation(value: &Value) -> Result<&str> {
    let text = if value.is_null() {
        ""
    } else {
        value
            .as_str()
            .ok_or_else(|| DeploymentError::new(INVALID))?
    };
    match text {
        "" | "rprivate" => Ok("rprivate"),
        p @ ("private" | "shared" | "rshared" | "slave" | "rslave") => Ok(p),
        _ => Err(DeploymentError::new(INVALID)),
    }
}
fn boolean(value: &Value) -> Result<bool> {
    if value.is_null() {
        Ok(false)
    } else {
        value.as_bool().ok_or_else(|| DeploymentError::new(INVALID))
    }
}
fn structured(value: &Value) -> Result<Value> {
    let fields = value
        .as_object()
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    check(fields.keys().all(|k| {
        matches!(
            k.as_str(),
            "Type" | "Source" | "Target" | "ReadOnly" | "BindOptions" | "Consistency"
        )
    }))?;
    check(value["Type"] == "bind")?;
    check(
        value["Consistency"].is_null()
            || matches!(value["Consistency"].as_str(), Some("" | "default")),
    )?;
    let mut options = Map::new();
    if !value["BindOptions"].is_null() {
        let supplied = value["BindOptions"]
            .as_object()
            .ok_or_else(|| DeploymentError::new(INVALID))?;
        check(supplied.keys().all(|k| {
            matches!(
                k.as_str(),
                "Propagation"
                    | "NonRecursive"
                    | "ReadOnlyNonRecursive"
                    | "ReadOnlyForceRecursive"
                    | "CreateMountpoint"
            )
        }))?;
    }
    let supplied = &value["BindOptions"];
    check(!boolean(&supplied["CreateMountpoint"])?)?;
    options.insert("CreateMountpoint".into(), json!(false));
    options.insert(
        "Propagation".into(),
        json!(propagation(&supplied["Propagation"])?),
    );
    for key in [
        "NonRecursive",
        "ReadOnlyNonRecursive",
        "ReadOnlyForceRecursive",
    ] {
        options.insert(key.into(), json!(boolean(&supplied[key])?));
    }
    Ok(
        json!({"Type":"bind","Source":path(&value["Source"])?,"Target":path(&value["Target"])?,
        "ReadOnly":boolean(&value["ReadOnly"])?,"BindOptions":options}),
    )
}
fn grant(value: &Value) -> Result<Value> {
    check(value["Type"] == "bind")?;
    let writable = value["RW"]
        .as_bool()
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    Ok(
        json!({"Type":"bind","Source":path(&value["Source"])?,"Target":path(&value["Destination"])?,
        "ReadOnly":!writable,"Propagation":propagation(&value["Propagation"])?}),
    )
}
fn flags(text: &str, expected: &Value) -> Result<()> {
    let mut access = None;
    let mut prop = None;
    for flag in text.split(',').filter(|s| !s.is_empty()) {
        match flag {
            "ro" | "rw" => {
                check(access.is_none())?;
                access = Some(flag == "ro");
            }
            "private" | "rprivate" | "shared" | "rshared" | "slave" | "rslave" => {
                check(prop.is_none())?;
                prop = Some(flag);
            }
            _ => return Err(DeploymentError::new(INVALID)),
        }
    }
    check(access.unwrap_or(false) == expected["ReadOnly"])?;
    check(prop.unwrap_or("rprivate") == expected["Propagation"])
}
fn projected_mount(
    mount: &Value,
    legacy: &[Value],
    original: &[Value],
    used: &mut BTreeSet<(bool, usize)>,
) -> Result<Value> {
    let expected = grant(mount)?;
    let prefix = format!(
        "{}:{}",
        path(&mount["Source"])?,
        path(&mount["Destination"])?
    );
    let mut selected = None;
    for (index, value) in legacy.iter().enumerate() {
        let text = value
            .as_str()
            .ok_or_else(|| DeploymentError::new(INVALID))?;
        if text == prefix
            || text
                .strip_prefix(&prefix)
                .is_some_and(|s| s.starts_with(':'))
        {
            check(selected.is_none() && used.insert((false, index)))?;
            flags(
                text.strip_prefix(&prefix)
                    .expect("matched prefix")
                    .strip_prefix(':')
                    .unwrap_or(""),
                &expected,
            )?;
            selected = Some(
                json!({"Type":"bind","Source":expected["Source"],"Target":expected["Target"],
                "ReadOnly":expected["ReadOnly"],"BindOptions":{"CreateMountpoint":false,"Propagation":expected["Propagation"]}}),
            );
        }
    }
    for (index, value) in original.iter().enumerate() {
        if value["Source"] == expected["Source"] && value["Target"] == expected["Target"] {
            check(selected.is_none() && used.insert((true, index)))?;
            let candidate = structured(value)?;
            check(
                candidate["ReadOnly"] == expected["ReadOnly"]
                    && candidate["BindOptions"]["Propagation"] == expected["Propagation"],
            )?;
            selected = Some(candidate);
        }
    }
    selected.ok_or_else(|| DeploymentError::new(INVALID))
}
pub(super) fn project(source: &Value) -> Result<Value> {
    let mut host = source["HostConfig"]
        .as_object()
        .cloned()
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    let legacy = list(&source["HostConfig"]["Binds"])?;
    let original = list(&source["HostConfig"]["Mounts"])?;
    let mounts = list(&source["Mounts"])?;
    check(!mounts.is_empty())?;
    let mut used = BTreeSet::new();
    let mut targets = BTreeSet::new();
    let mut output = Vec::new();
    for mount in mounts {
        check(targets.insert(path(&mount["Destination"])?.to_owned()))?;
        output.push(projected_mount(mount, legacy, original, &mut used)?);
    }
    check(used.len() == legacy.len() + original.len())?;
    host.remove("Binds");
    host.insert("Mounts".into(), Value::Array(output));
    Ok(Value::Object(host))
}
fn normalized_host(value: &Value) -> Result<Value> {
    let mut fields = value
        .as_object()
        .cloned()
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    // Docker normalizes the unset optional boolean to false during create.
    // A true value remains distinct; no other host field is normalized here.
    fields.insert(
        "OomKillDisable".into(),
        json!(boolean(&value["OomKillDisable"])?),
    );
    check(list(&value["Binds"])?.is_empty())?;
    fields.remove("Binds");
    let mut mounts = list(&value["Mounts"])?
        .iter()
        .map(structured)
        .collect::<Result<Vec<_>>>()?;
    mounts.sort_by_key(Value::to_string);
    fields.insert("Mounts".into(), json!(mounts));
    Ok(Value::Object(fields))
}
pub(super) fn equivalent(actual: &Value, expected: &Value) -> Result<()> {
    require(
        normalized_host(actual)? == normalized_host(expected)?,
        "DEPLOYMENT_CREATED_HOST_CONFIG_CHANGED",
    )
}
pub(super) fn same_grants(actual: &Value, expected: &Value) -> Result<()> {
    let normalize = |value: &Value| -> Result<Vec<Value>> {
        let mut values = list(value)?.iter().map(grant).collect::<Result<Vec<_>>>()?;
        values.sort_by_key(Value::to_string);
        Ok(values)
    };
    require(
        normalize(actual)? == normalize(expected)?,
        "DEPLOYMENT_CREATED_MOUNTS_CHANGED",
    )
}

#[cfg(test)]
mod tests;
