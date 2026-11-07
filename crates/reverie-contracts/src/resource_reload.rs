//! Source worker_resources.validate_resource_reload and OLD6 data checks.
//! Native storage/effective-policy observations are explicitly performed by
//! the application between these named data stages. No config is persisted.
use crate::{
    legacy_json::{Node, Text, Value},
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    operations::{JournalId, OperationError},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};
type Object = BTreeMap<Text, Value>;
type Result<T> = std::result::Result<T, ReloadDataError>;
const RESOURCES: [&str; 6] = [
    "budgetMode",
    "memoryMiB",
    "pidsLimit",
    "cpus",
    "poolMemoryMiB",
    "poolTasksMax",
];
const MAPS: [&str; 5] = [
    "sessionResources",
    "employeeResources",
    "employeeMemoryPolicies",
    "laptopSwapPoolMiB",
    "softLimitHelperSocket",
];
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReloadDataError {
    Resource(crate::broker_resources::ResourceConfigError),
    Role(OperationError),
    Domain,
    Distinct,
    Global,
    Peer,
    Shape,
    OldPolicy,
}
impl ReloadDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Resource(e) => e.code(),
            Self::Role(e) => e.code(),
            Self::Domain => "RESOURCE_RELOAD_DOMAIN_CHANGED",
            Self::Distinct => "RESERVATION_DISTINCT_TARGET",
            Self::Global => "RESERVATION_GLOBAL_POLICY_CHANGED",
            Self::Peer => "RESERVATION_PEER_POLICY_CHANGED",
            Self::Shape => "RESERVATION_RESOURCE_CONFIG_SHAPE",
            Self::OldPolicy => "RESERVATION_OLD_POLICY_CHANGED",
        }
    }
}
impl fmt::Display for ReloadDataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for ReloadDataError {}
fn key(s: &str) -> Text {
    Text(s.chars().map(u32::from).collect())
}
fn root(config: &EffectiveWorkerConfig) -> &Object {
    let Node::Object(value) = &config.as_value().0 else {
        unreachable!("worker object invariant")
    };
    value
}
fn field<'a>(config: &'a EffectiveWorkerConfig, name: &str) -> Result<&'a Value> {
    root(config).get(&key(name)).ok_or(ReloadDataError::Shape)
}
fn need(value: bool, error: ReloadDataError) -> Result<()> {
    if value { Ok(()) } else { Err(error) }
}
fn ignored(name: &Text) -> bool {
    RESOURCES
        .iter()
        .chain(MAPS.iter())
        .any(|key| name.equals_ascii(key))
}
fn domain(config: &EffectiveWorkerConfig) -> Value {
    Value(Node::Object(
        root(config)
            .iter()
            .filter(|(name, _)| !ignored(name))
            .map(|(name, value)| (name.clone(), value.deep_clone()))
            .collect(),
    ))
}
/// Validate only the original session/EID maps before comparing the remaining
/// complete dictionaries by Python equality. Empty maps do not read globals.
pub fn validate_reload(
    before: &EffectiveWorkerConfig,
    after: &EffectiveWorkerConfig,
) -> Result<()> {
    crate::broker_resources::validate_maps(after.as_value()).map_err(ReloadDataError::Resource)?;
    need(
        domain(before).python_eq(&domain(after)),
        ReloadDataError::Domain,
    )
}
/// Initial checks before the original native storage lookup. Not authority.
pub struct OldPolicyStart {
    before: EffectiveWorkerConfig,
    projected: EffectiveWorkerConfig,
    old: ProfileSessionId,
    target: ProfileSessionId,
}
pub struct OldPolicyFreeze(OldPolicyStart);
pub struct FrozenOldPolicy {
    before: EffectiveWorkerConfig,
    candidate: EffectiveWorkerConfig,
    old: ProfileSessionId,
    target: ProfileSessionId,
}
impl OldPolicyStart {
    pub fn capture(
        before: EffectiveWorkerConfig,
        projected: EffectiveWorkerConfig,
        old: ProfileSessionId,
        target: ProfileSessionId,
    ) -> Result<Self> {
        JournalId::parse(old.as_str()).map_err(ReloadDataError::Role)?;
        JournalId::parse(target.as_str()).map_err(ReloadDataError::Role)?;
        need(old != target, ReloadDataError::Distinct)?;
        validate_reload(&before, &projected)?;
        for name in RESOURCES {
            need(
                field(&before, name)?.python_eq(field(&projected, name)?),
                ReloadDataError::Global,
            )?;
        }
        Ok(Self {
            before,
            projected,
            old,
            target,
        })
    }
    pub fn before(&self) -> &EffectiveWorkerConfig {
        &self.before
    }
    pub fn for_employee(self, employee: &ProfileEmployeeId) -> Result<OldPolicyFreeze> {
        peers(
            &self.before,
            &self.projected,
            "employeeResources",
            &[employee.as_str()],
        )?;
        peers(
            &self.before,
            &self.projected,
            "sessionResources",
            &[self.old.as_str(), self.target.as_str()],
        )?;
        Ok(OldPolicyFreeze(self))
    }
}
impl OldPolicyFreeze {
    pub fn before(&self) -> &EffectiveWorkerConfig {
        &self.0.before
    }
    pub fn freeze(self, old_effective: &EffectiveWorkerConfig) -> Result<FrozenOldPolicy> {
        let Self(mut data) = self;
        let mut policy = Object::new();
        for name in RESOURCES {
            policy.insert(key(name), field(old_effective, name)?.deep_clone());
        }
        let changed = match (
            root(&data.before).get(&key("employeeMemoryPolicies")),
            root(&data.projected).get(&key("employeeMemoryPolicies")),
        ) {
            (None, None) => false,
            (Some(before), Some(after)) => !before.python_eq(after),
            _ => true,
        };
        let prior =
            root(&data.before)
                .get(&key("sessionResources"))
                .and_then(|value| match &value.0 {
                    Node::Object(entries) => entries.get(&key(data.old.as_str())),
                    _ => None,
                });
        let versioned = prior
            .map(crate::session_resources_v2::decode)
            .transpose()
            .map_err(ReloadDataError::Resource)?
            .flatten()
            .is_some();
        let policy = if changed || versioned {
            crate::session_resources_v2::wrap(
                policy,
                root(old_effective)
                    .get(&key("laptopMemoryPolicy"))
                    .map(Value::deep_clone),
            )
        } else {
            Value(Node::Object(policy))
        };
        let mut value = data.projected.into_value();
        let Node::Object(root) = &mut value.0 else {
            unreachable!("worker object invariant")
        };
        let policies = root
            .entry(key("sessionResources"))
            .or_insert_with(|| Value(Node::Object(Object::new())));
        let Node::Object(policies) = &mut policies.0 else {
            return Err(ReloadDataError::Shape);
        };
        policies.insert(key(data.old.as_str()), policy);
        let Node::Object(fields) = std::mem::replace(&mut value.0, Node::Null) else {
            unreachable!()
        };
        data.projected = EffectiveWorkerConfig::from_object(fields);
        validate_reload(&data.before, &data.projected)?;
        Ok(FrozenOldPolicy {
            before: data.before,
            candidate: data.projected,
            old: data.old,
            target: data.target,
        })
    }
}
impl FrozenOldPolicy {
    pub fn before(&self) -> &EffectiveWorkerConfig {
        &self.before
    }
    pub fn candidate(&self) -> &EffectiveWorkerConfig {
        &self.candidate
    }
    /// Preserve the source's actual before-map insertion order for subsequent
    /// native effective-config reads. Capturing order never validated a SID.
    pub fn peer_sessions(&self) -> impl Iterator<Item = Result<ProfileSessionId>> + '_ {
        self.before
            .session_resource_order()
            .iter()
            .filter(|sid| {
                sid.scalar_text()
                    .is_none_or(|sid| sid != self.old.as_str() && sid != self.target.as_str())
            })
            .map(|sid| {
                ProfileSessionId::parse(&sid.scalar_text().ok_or(ReloadDataError::Shape)?)
                    .map_err(|_| ReloadDataError::Shape)
            })
    }
    pub fn assert_old_policy(
        &self,
        before_effective: &EffectiveWorkerConfig,
        after_effective: &EffectiveWorkerConfig,
    ) -> Result<()> {
        need(
            crate::worker_config::policy_digest(before_effective)
                == crate::worker_config::policy_digest(after_effective),
            ReloadDataError::OldPolicy,
        )
    }
    pub fn assert_peer(
        before_effective: &EffectiveWorkerConfig,
        after_effective: &EffectiveWorkerConfig,
    ) -> Result<()> {
        need(
            crate::worker_config::equivalent(before_effective, after_effective),
            ReloadDataError::Peer,
        )
    }
    pub fn into_configuration(self) -> EffectiveWorkerConfig {
        self.candidate
    }
}
fn map<'a>(config: &'a EffectiveWorkerConfig, name: &str) -> Result<Option<&'a Object>> {
    match root(config).get(&key(name)) {
        None => Ok(None),
        Some(Value(Node::Object(value))) => Ok(Some(value)),
        _ => Err(ReloadDataError::Shape),
    }
}
fn same(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) | (None, Some(Value(Node::Null))) | (Some(Value(Node::Null)), None) => true,
        (Some(left), Some(right)) => left.python_eq(right),
        _ => false,
    }
}
fn peers(
    before: &EffectiveWorkerConfig,
    after: &EffectiveWorkerConfig,
    name: &str,
    selected: &[&str],
) -> Result<()> {
    let before = map(before, name)?;
    let after = map(after, name)?;
    let keys = before
        .into_iter()
        .chain(after)
        .flat_map(|map| map.keys())
        .collect::<BTreeSet<_>>();
    for key in keys {
        if selected.iter().any(|sid| key.equals_ascii(sid)) {
            continue;
        }
        need(
            same(
                before.and_then(|map| map.get(key)),
                after.and_then(|map| map.get(key)),
            ),
            ReloadDataError::Peer,
        )?;
    }
    Ok(())
}
