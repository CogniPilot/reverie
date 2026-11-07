use super::*;
use reverie_core::posix_path::PosixPath;

pub(super) fn normalize(value: &Value) -> Result<Value> {
    let rows = array(value).map_err(|_| ResourceActorDataError("COMPLETE_MOUNTS_REQUIRED"))?;
    need(rows.len() <= 256, "COMPLETE_MOUNTS_REQUIRED")?;
    let mut sorted = BTreeMap::new();
    for row in rows {
        let path = destination(row)?;
        need(
            sorted.insert(path, row.deep_clone()).is_none(),
            "MOUNT_DESTINATIONS",
        )?;
    }
    Ok(Value(Node::Array(sorted.into_values().collect())))
}
fn destination(row: &Value) -> Result<Text> {
    let value =
        field(row, "Destination").map_err(|_| ResourceActorDataError("MOUNT_DESTINATIONS"))?;
    let Node::String(value) = &value.0 else {
        return Err(ResourceActorDataError("MOUNT_DESTINATIONS"));
    };
    let path =
        PosixPath::try_new(&value.0).map_err(|_| ResourceActorDataError("MOUNT_DESTINATIONS"))?;
    need(
        path.is_absolute() && path.codepoints() == value.0 && !path.has_parent_component(),
        "MOUNT_DESTINATIONS",
    )?;
    Ok(value.clone())
}
pub(super) fn require_unmasked(value: &Value) -> Result<()> {
    let nix = PosixPath::from_scalar_text("/nix");
    for row in array(value)? {
        let target = destination(row)?;
        let target = PosixPath::try_new(&target.0).expect("validated Python codepoints");
        need(!target.overlaps(&nix), "IMMUTABLE_BACKEND_CODE_MASKED")?;
    }
    Ok(())
}
