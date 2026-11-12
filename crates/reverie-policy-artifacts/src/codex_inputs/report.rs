//! Preserve the existing sorted, default-spaced JSON report bytes. These are
//! public input observations; the native acceptance flag remains false.
use super::{Result, inputs::Qualified};
use serde_json::{Value, json, ser::Formatter};
use std::io::{self, Write};

struct Spaced;
impl Formatter for Spaced {
    fn begin_object_key<W: ?Sized + Write>(
        &mut self,
        writer: &mut W,
        first: bool,
    ) -> io::Result<()> {
        if first {
            Ok(())
        } else {
            writer.write_all(b", ")
        }
    }
    fn begin_object_value<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        writer.write_all(b": ")
    }
}
pub(super) fn write(mode: &str, qualified: &Qualified, metadata: Option<&[u8]>) -> Result<()> {
    let mut value = json!({
        "state":"PUBLIC_INPUTS_QUALIFIED",
        "mode":mode,
        "gitSources":qualified.git_sources(),
        "registryPackages":qualified.registry_packages(),
        "nativeBuildOrRuntimeAcceptance":false,
    });
    if let Some(metadata) = metadata {
        let metadata: Value = serde_json::from_slice(metadata)?;
        let members = metadata["workspace_members"]
            .as_array()
            .ok_or("Cargo workspace members missing")?;
        value["lockedOfflineCargoMetadata"] = json!(true);
        value["workspaceMembers"] = json!(members.len());
    }
    value.sort_all_objects();
    let mut output = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut output, Spaced);
    serde::Serialize::serialize(&value, &mut serializer)?;
    if metadata.is_none() {
        output.push(b'\n');
    }
    let mut stdout = io::stdout().lock();
    stdout.write_all(&output)?;
    stdout.flush()?;
    Ok(())
}
