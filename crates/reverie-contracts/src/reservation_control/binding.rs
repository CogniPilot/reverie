use super::*;
use crate::{legacy_json::Number, storage_identity::OrderedMetadata};
use reverie_core::decimal::UnsignedInteger;

/// Nonnegative legacy Python inode data has no artificial machine-word cap.
/// Native observers compare these values to actual observed device/inode facts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlIdentity {
    device: UnsignedInteger,
    inode: UnsignedInteger,
}
impl ControlIdentity {
    fn capture(value: &Value) -> Result<Self> {
        let Node::Array(values) = &value.0 else {
            return Err(ControlDataError::BindingSchema);
        };
        if values.len() != 2 {
            return Err(ControlDataError::BindingSchema);
        }
        Ok(Self {
            device: integer(&values[0])?,
            inode: integer(&values[1])?,
        })
    }
    pub fn device(&self) -> &UnsignedInteger {
        &self.device
    }
    pub fn inode(&self) -> &UnsignedInteger {
        &self.inode
    }
    pub fn matches_native(&self, device: u64, inode: u64) -> bool {
        self.device == UnsignedInteger::from_u64(device)
            && self.inode == UnsignedInteger::from_u64(inode)
    }
}
pub struct ControlBinding {
    original: Value,
    directories: [ControlIdentity; 3],
    admission: ControlIdentity,
    state: ControlIdentity,
    locks: [ControlIdentity; 2],
    domain: ControlDomainDigest,
    order: Vec<ControlDirectory>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlDirectory {
    Root,
    Profiles,
    Operations,
}
impl ControlDirectory {
    pub fn name(self) -> &'static str {
        match self {
            Self::Root => ".",
            Self::Profiles => "profiles",
            Self::Operations => "operations",
        }
    }
}
impl ControlBinding {
    /// Preserve the constructor's original check order. The config's option
    /// has already been validated by its owning worker option parser. Its copy
    /// in the marker is compared with Python equality, not revalidated against
    /// a stricter schema (True and 1.0 can equal a configured integer 1).
    pub fn from_metadata(
        metadata: &OrderedMetadata,
        config: &EffectiveWorkerConfig,
    ) -> Result<Self> {
        let value = metadata.as_value();
        let fields = object(value)?;
        exact(
            fields,
            &[
                "schema",
                "state",
                "option",
                "directories",
                "admissionLock",
                "stateDirectory",
                "locks",
                "configurationDigest",
            ],
        )?;
        let source = object(config.as_value())?;
        if !string_is(field(fields, "schema")?, "reverie-resource-control-v1")
            || !string_is(field(fields, "state")?, "READY")
            || !field(fields, "option")?.python_eq(field(source, "resourceReservations")?)
        {
            return Err(ControlDataError::NotReady);
        }
        let domain = domain_digest(config)?;
        if !string_is(field(fields, "configurationDigest")?, &domain.to_hex()) {
            return Err(ControlDataError::DomainChanged);
        }
        let directories = object(field(fields, "directories")?)?;
        exact(directories, &[".", "profiles", "operations"])?;
        let directories = [
            ControlIdentity::capture(field(directories, ".")?)?,
            ControlIdentity::capture(field(directories, "profiles")?)?,
            ControlIdentity::capture(field(directories, "operations")?)?,
        ];
        let admission = ControlIdentity::capture(field(fields, "admissionLock")?)?;
        let state = ControlIdentity::capture(field(fields, "stateDirectory")?)?;
        let locks = object(field(fields, "locks")?)?;
        exact(locks, &["profiles", "operations"])?;
        let locks = [
            ControlIdentity::capture(field(locks, "profiles")?)?,
            ControlIdentity::capture(field(locks, "operations")?)?,
        ];
        let order = metadata
            .object_field_order("directories")
            .ok_or(ControlDataError::BindingSchema)?
            .into_iter()
            .map(|name| {
                if name.equals_ascii(".") {
                    Ok(ControlDirectory::Root)
                } else if name.equals_ascii("profiles") {
                    Ok(ControlDirectory::Profiles)
                } else if name.equals_ascii("operations") {
                    Ok(ControlDirectory::Operations)
                } else {
                    Err(ControlDataError::BindingSchema)
                }
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            original: value.deep_clone(),
            directories,
            admission,
            state,
            locks,
            domain,
            order,
        })
    }
    pub fn root(&self) -> &ControlIdentity {
        &self.directories[0]
    }
    pub fn profiles(&self) -> &ControlIdentity {
        &self.directories[1]
    }
    pub fn operations(&self) -> &ControlIdentity {
        &self.directories[2]
    }
    pub fn admission_lock(&self) -> &ControlIdentity {
        &self.admission
    }
    pub fn state_directory(&self) -> &ControlIdentity {
        &self.state
    }
    pub fn profile_lock(&self) -> &ControlIdentity {
        &self.locks[0]
    }
    pub fn operation_lock(&self) -> &ControlIdentity {
        &self.locks[1]
    }
    pub fn domain(&self) -> &ControlDomainDigest {
        &self.domain
    }
    pub fn directory_order(&self) -> &[ControlDirectory] {
        &self.order
    }
    pub fn directory_identity(&self, directory: ControlDirectory) -> &ControlIdentity {
        match directory {
            ControlDirectory::Root => self.root(),
            ControlDirectory::Profiles => self.profiles(),
            ControlDirectory::Operations => self.operations(),
        }
    }
    pub fn matches_metadata(&self, current: &OrderedMetadata) -> bool {
        self.original.python_eq(current.as_value())
    }
}
fn integer(value: &Value) -> Result<UnsignedInteger> {
    if let Node::Number(Number::Integer(value)) = &value.0 {
        UnsignedInteger::parse(value).ok_or(ControlDataError::BindingSchema)
    } else {
        Err(ControlDataError::BindingSchema)
    }
}
