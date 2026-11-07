use super::{Result, TelemetryDataError};
use crate::{
    legacy_json::{Node, Text, Value},
    storage_identity::MetadataText,
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::{PythonText, posix_path::PosixPath};
use std::collections::BTreeMap;
/// Lazy constructor fields, preserving the original filesystem/engine phases.
pub struct TelemetrySource<'a>(&'a EffectiveWorkerConfig);
/// Collected raw path DATA, not a canonical/validated source. Nonpath values
/// retain their refusal until the source's later check_sources phase.
pub struct ConfiguredSource(Result<MetadataText>);
impl ConfiguredSource {
    pub fn into_path(self) -> Result<MetadataText> {
        self.0
    }
    fn raw(value: &Value) -> Self {
        Self(text(value))
    }
    fn path(value: MetadataText) -> Self {
        Self(Ok(value))
    }
}
impl<'a> TelemetrySource<'a> {
    pub fn capture(config: &'a EffectiveWorkerConfig) -> Self {
        Self(config)
    }
    fn field(&self, name: &str) -> Result<&Value> {
        let Node::Object(fields) = &self.0.as_value().0 else {
            unreachable!("worker object")
        };
        fields
            .get(&Text(name.chars().map(u32::from).collect()))
            .ok_or(TelemetryDataError::Boundary)
    }
    pub fn uid_matches(&self, uid: u32) -> Result<bool> {
        Ok(self
            .field("uid")?
            .python_eq(&Value(Node::Number(crate::legacy_json::Number::Integer(
                uid.to_string(),
            )))))
    }
    /// Constructor UID equality has Python numeric semantics. Once it matches
    /// the actual host UID, reuse the existing identity-path owner with that
    /// same UID rather than imposing a new bool/float rule on later reads.
    pub fn identity_settings(
        &self,
        uid: u32,
    ) -> Result<crate::resource_config::ResourceIdentitySettings> {
        if !self.uid_matches(uid)? {
            return Err(TelemetryDataError::Boundary);
        }
        crate::resource_config::ResourceIdentitySettings::capture_known_uid(self.0, uid)
            .map_err(|_| TelemetryDataError::Binding)
    }
    pub fn state_root(&self) -> Result<MetadataText> {
        text(self.field("stateRoot")?)
    }
    /// Materialize every configured source BEFORE any source canonicalization.
    /// Path(companyRoot)/leaf is normalized Python Path DATA; raw str sources
    /// preserve their original spelling for canonical(str)'s separate refusal.
    pub fn configured_sources(&self, state: &PosixPath) -> Result<Vec<ConfiguredSource>> {
        let Node::Array(mounts) = &self.field("mounts")?.0 else {
            return Err(TelemetryDataError::Boundary);
        };
        let mut out = Vec::new();
        for mount in mounts {
            let Node::Object(fields) = &mount.0 else {
                return Err(TelemetryDataError::Boundary);
            };
            out.push(ConfiguredSource::raw(
                fields
                    .get(&Text("source".chars().map(u32::from).collect()))
                    .ok_or(TelemetryDataError::Boundary)?,
            ));
        }
        out.push(ConfiguredSource::raw(self.field("scratchRoot")?));
        out.push(ConfiguredSource::raw(self.field("apiSocketRoot")?));
        out.push(ConfiguredSource::path(path_text(
            &state.join(&PosixPath::from_scalar_text("employees")),
        )));
        let company = text(self.field("companyRoot")?)?;
        let company =
            PosixPath::try_new(company.codepoints()).map_err(|_| TelemetryDataError::Boundary)?;
        for leaf in ["accounts", "console/accounts"] {
            out.push(ConfiguredSource::path(path_text(
                &company.join(&PosixPath::from_scalar_text(leaf)),
            )))
        }
        Ok(out)
    }
}
fn text(value: &Value) -> Result<MetadataText> {
    match &value.0 {
        Node::String(value) => Ok(MetadataText::from_text(value.clone())),
        _ => Err(TelemetryDataError::Boundary),
    }
}
fn path_text(value: &PosixPath) -> MetadataText {
    MetadataText::from_python_text(PythonText::try_new(value.codepoints()).expect("checked path"))
}
fn equals(points: &[u32], value: &str) -> bool {
    points.iter().copied().eq(value.bytes().map(u32::from))
}
fn starts(points: &[u32], value: &str) -> bool {
    points.len() >= value.len() && equals(&points[..value.len()], value)
}
/// Parse the complete final argv before inspecting any mount source. Unknown
/// arguments/codepoints are retained data and are not scalar-normalized.
pub fn create_sources(args: &[MetadataText]) -> Result<Vec<MetadataText>> {
    let mut out = Vec::new();
    for (index, arg) in args.iter().enumerate() {
        let arg = arg.codepoints();
        if equals(arg, "-v")
            || equals(arg, "--volume")
            || starts(arg, "--mount=")
            || starts(arg, "--volume=")
        {
            return Err(TelemetryDataError::Inventory);
        }
        if !equals(arg, "--mount") {
            continue;
        }
        let next = args.get(index + 1).ok_or(TelemetryDataError::Inventory)?;
        let mut values = BTreeMap::new();
        for pair in next.codepoints().split(|&point| point == 44) {
            let at = pair.iter().position(|&point| point == 61);
            let (key, value) = at.map_or((pair, None), |at| (&pair[..at], Some(&pair[at + 1..])));
            if values.insert(key, value).is_some() {
                return Err(TelemetryDataError::Inventory);
            }
        }
        let kind = values.get(&[116, 121, 112, 101][..]).copied().flatten();
        if kind.is_some_and(|kind| equals(kind, "tmpfs")) {
            continue;
        }
        if !kind.is_some_and(|kind| equals(kind, "bind")) {
            return Err(TelemetryDataError::Inventory);
        }
        let source = values
            .get(&[115, 114, 99][..])
            .copied()
            .flatten()
            .ok_or(TelemetryDataError::Inventory)?;
        out.push(MetadataText::from_python_text(
            PythonText::try_new(source.to_vec()).expect("checked argv"),
        ));
    }
    Ok(out)
}
