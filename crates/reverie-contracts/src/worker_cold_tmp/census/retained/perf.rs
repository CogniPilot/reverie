//! Closed perf readback over the same actual started-container inspection DATA.
use super::*;
use crate::task_perf_v1::TaskPerfProfile;

impl RetainedInspection {
    pub fn perf_profile(&self) -> Result<TaskPerfProfile> {
        let host = field(self.row().fields(), "HostConfig")
            .and_then(object)
            .ok_or(ColdDataError::Inventory)?;
        for (name, expected) in [("ReadonlyRootfs", true), ("Privileged", false)] {
            if !matches!(field(host,name),Some(Value(Node::Bool(value))) if *value == expected) {
                return Err(ColdDataError::Policy);
            }
        }
        if caps(host, "CapDrop")? != ["ALL"] || caps(host, "CapAdd")? != ["SETGID", "SETUID"] {
            return Err(ColdDataError::Policy);
        }
        let Some(Value(Node::Array(options))) = field(host, "SecurityOpt") else {
            return Err(ColdDataError::Policy);
        };
        if options.len() != 1 {
            return Err(ColdDataError::Policy);
        }
        let option = metadata(options.first(), ColdDataError::Policy)?;
        let option = option.scalar_text().ok_or(ColdDataError::Policy)?;
        let profile = option
            .strip_prefix("seccomp=")
            .ok_or(ColdDataError::Policy)?;
        self.perf_mounts()?;
        TaskPerfProfile::decode(profile.as_bytes()).map_err(|_| ColdDataError::Policy)
    }
    fn perf_mounts(&self) -> Result<()> {
        let prefixes = [
            crate::task_perf_capsule::PREFIX,
            crate::task_perf_capsule::ABSENT_PREFIX,
        ];
        for mount in self.row().mount_values()? {
            let mount = object(mount).ok_or(ColdDataError::Mounts)?;
            let destination = metadata(field(mount, "Destination"), ColdDataError::Mounts)?;
            let destination = destination.scalar_text().ok_or(ColdDataError::Mounts)?;
            let path = std::path::Path::new(&destination);
            if !path.is_absolute()
                || path
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
                || prefixes
                    .iter()
                    .map(std::path::Path::new)
                    .any(|prefix| prefix.starts_with(path) || path.starts_with(prefix))
            {
                return Err(ColdDataError::Mounts);
            }
        }
        Ok(())
    }
}
fn caps(host: &Object, name: &str) -> Result<Vec<String>> {
    let Some(Value(Node::Array(values))) = field(host, name) else {
        return Err(ColdDataError::Policy);
    };
    let mut result = Vec::new();
    for value in values {
        let value = metadata(Some(value), ColdDataError::Policy)?;
        let value = value.scalar_text().ok_or(ColdDataError::Policy)?;
        result.push(value.strip_prefix("CAP_").unwrap_or(&value).to_owned());
    }
    result.sort();
    Ok(result)
}
