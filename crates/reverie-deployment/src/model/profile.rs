//! Closed deployment choices, never an exception to backup or writer custody.
use super::*;
mod ephemeral;
mod security;
pub(super) use ephemeral::normalize as normalized_tmpfs;
pub(super) use ephemeral::observed_mounts;
pub(super) use security::normalized as normalized_security_options;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum DeploymentProfile {
    #[default]
    Ordinary,
    ProtectedWebsite,
}
impl DeploymentProfile {
    pub(crate) fn version(self) -> u32 {
        match self {
            Self::Ordinary => 1,
            Self::ProtectedWebsite => 2,
        }
    }
    pub(crate) fn preview(self) -> Option<Self> {
        match self {
            Self::Ordinary => None,
            Self::ProtectedWebsite => Some(self),
        }
    }
}

pub(super) fn source_mounts(source: &Value, profile: DeploymentProfile) -> Result<()> {
    match profile {
        DeploymentProfile::Ordinary => {
            let rows = source["Mounts"]
                .as_array()
                .ok_or_else(|| DeploymentError::new("DEPLOYMENT_MOUNTS_REQUIRED"))?;
            require(
                !rows.is_empty()
                    && rows.iter().all(|row| row["Type"] == "bind")
                    && !ephemeral::has_configuration(source),
                "DEPLOYMENT_MOUNTS_UNSUPPORTED",
            )
        }
        DeploymentProfile::ProtectedWebsite => ephemeral::source(source),
    }
}
pub(super) fn mounts(source: &Value) -> Result<&[Value]> {
    source["Mounts"]
        .as_array()
        .filter(|rows| !rows.is_empty())
        .map(Vec::as_slice)
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_MOUNTS_REQUIRED"))
}
fn protected_host(source: &Value) -> Result<Value> {
    source_mounts(source, DeploymentProfile::ProtectedWebsite)?;
    let mut host = crate::binds::project_profile(source, DeploymentProfile::ProtectedWebsite)?;
    let fields = host.as_object_mut().expect("projected host object");
    fields.insert("ReadonlyRootfs".into(), json!(true));
    fields.insert("CapDrop".into(), json!(["ALL"]));
    fields.insert("CapAdd".into(), Value::Null);
    fields.insert(
        "SecurityOpt".into(),
        security::protected(&source["HostConfig"]["SecurityOpt"])?,
    );
    fields.insert("PidMode".into(), json!("private"));
    fields.insert("IpcMode".into(), json!("private"));
    fields.insert("Tmpfs".into(), ephemeral::options(source)?);
    Ok(host)
}
pub(super) fn host(source: &Value, profile: DeploymentProfile) -> Result<Value> {
    match profile {
        DeploymentProfile::Ordinary => crate::binds::project(source),
        DeploymentProfile::ProtectedWebsite => protected_host(source),
    }
}
pub(super) fn validate_body(
    source: &Value,
    body: &Value,
    profile: DeploymentProfile,
) -> Result<()> {
    if profile == DeploymentProfile::Ordinary {
        return Ok(());
    }
    require(
        body["User"] == source["Config"]["User"] && body["HostConfig"] == protected_host(source)?,
        "DEPLOYMENT_PROTECTED_PROFILE_CHANGED",
    )?;
    settings(body, &body["HostConfig"], &ephemeral::prospective(source)?)
}
pub(super) fn candidate(actual: &Value, profile: DeploymentProfile) -> Result<()> {
    if profile == DeploymentProfile::ProtectedWebsite {
        ephemeral::protected(actual)?;
    }
    Ok(())
}
pub(super) fn settings(config: &Value, host: &Value, mounts: &Value) -> Result<()> {
    let raw = serde_json::to_vec(&json!({"Config":config,"HostConfig":host,"Mounts":mounts}))?;
    reverie_contracts::resource_actor::validate_protected_website_settings(&raw)
        .map_err(|error| DeploymentError::new(error.code()))
}
