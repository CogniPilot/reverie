//! Fixed existing installation selectors from the actual worker configuration.
//! No path or domain in this DATA object is filesystem custody or authority.
use super::*;
use crate::{reservation_engine::ReservationConfiguration, worker_config::EffectiveWorkerConfig};
use reverie_core::posix_path::PosixPath;
pub struct ResourceActorSettings {
    path: PosixPath,
    root: PosixPath,
    domain: JournalDigest,
    uid: u32,
    gid: u32,
}
impl ResourceActorSettings {
    /// Closed DATA precondition for the initial installer. Presence of any
    /// selector, including an invalid value, belongs to a different workflow.
    pub fn require_unselected(config: &EffectiveWorkerConfig) -> Result<()> {
        need(
            !object(config.as_value())?.contains_key(&key("resourceActorConfig")),
            "RESOURCE_INSTALL_ALREADY_SELECTED",
        )
    }
    pub fn capture(config: &EffectiveWorkerConfig) -> Result<Self> {
        let selected = ReservationConfiguration::capture(config.clone());
        let root = selected
            .control_paths()
            .map_err(|_| ResourceActorDataError("RESOURCE_INSTALL_FIXED_PATH"))?
            .root()
            .clone();
        let expected = root.join(&PosixPath::from_scalar_text("resource-actor.json"));
        let configured = text(field(config.as_value(), "resourceActorConfig")?)?;
        need(
            configured.codepoints() == expected.codepoints()
                && !configured
                    .codepoints()
                    .iter()
                    .any(|point| [0, 10, 13].contains(point))
                && expected.is_absolute()
                && !expected.has_parent_component(),
            "RESOURCE_INSTALL_FIXED_PATH",
        )?;
        let uid = id(field(config.as_value(), "uid")?)?;
        need(uid > 0, "ORDINARY_OWNER_WEBSITE_REQUIRED")?;
        let gid = id(field(config.as_value(), "gid")?)?;
        let domain = crate::reservation_control::domain_digest(config)
            .map_err(|_| ResourceActorDataError("RESOURCE_INSTALL_DOMAIN"))?;
        Ok(Self {
            path: expected,
            root,
            domain: JournalDigest::parse(&domain.to_hex()).expect("SHA256"),
            uid,
            gid,
        })
    }
    pub fn path(&self) -> &PosixPath {
        &self.path
    }
    pub fn root(&self) -> &PosixPath {
        &self.root
    }
    pub fn uid(&self) -> u32 {
        self.uid
    }
    pub fn gid(&self) -> u32 {
        self.gid
    }
    pub fn domain(&self) -> &JournalDigest {
        &self.domain
    }
    pub fn require_document(&self, document: &InstalledFactsDocument) -> Result<()> {
        need(
            document.configuration_digest == self.domain
                && document.website.uid == self.uid
                && document.website.gid == self.gid,
            "RESOURCE_INSTALL_PROGRAM_BINDING",
        )
    }
}
fn id(value: &Value) -> Result<u32> {
    unsigned(value)?
        .to_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(ResourceActorDataError("ORDINARY_OWNER_WEBSITE_REQUIRED"))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn config() -> serde_json::Value {
        json!({"uid":1000,"gid":100,"stateRoot":"/private/workers",
            "resourceReservations":{"directory":"/private/control"},
            "resourceActorConfig":"/private/control/resource-actor.json",
            "employeeMemoryPolicies":{},"memoryMiB":4096})
    }
    fn capture(value: &serde_json::Value) -> Result<ResourceActorSettings> {
        ResourceActorSettings::capture(
            &crate::worker_config::decode(&serde_json::to_vec(value).unwrap()).unwrap(),
        )
    }
    #[test]
    fn installation_path_is_fixed_to_the_actual_control_root_not_an_arbitrary_private_file() {
        let original = config();
        let selected = capture(&original).unwrap();
        assert_eq!(
            selected.path().codepoints(),
            "/private/control/resource-actor.json"
                .chars()
                .map(u32::from)
                .collect::<Vec<_>>()
        );
        for path in [
            "/elsewhere/resource-actor.json",
            "/private/control/./resource-actor.json",
            "/private/control/other.json",
        ] {
            let mut changed = original.clone();
            changed["resourceActorConfig"] = json!(path);
            assert!(capture(&changed).is_err());
        }
    }
    #[test]
    fn approved_memory_publication_changes_neither_program_domain_nor_private_facts_selector() {
        let original = config();
        let first = capture(&original).unwrap();
        let mut changed = original.clone();
        changed["memoryMiB"] = json!(49152);
        changed["employeeMemoryPolicies"] = json!({"employee":{"memoryHighMiB":4096,"swapMiB":0}});
        let after = capture(&changed).unwrap();
        assert_eq!(first.domain(), after.domain());
        assert_eq!(first.path(), after.path());
        changed["uid"] = json!(0);
        assert!(capture(&changed).is_err());
    }
}
