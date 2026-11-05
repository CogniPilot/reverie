use super::{CodecError, MAX_BYTES, SCHEMA};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::profiles::{MAX_PROFILES, ProfileBinding, ProfileDocument, ResourceProfile};
use reverie_core::resources::{BudgetMode, CpuQuota, ResourcePolicy};
use reverie_core::revision::{Generation, ProfileVersion, StoreRevision};
use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use std::collections::BTreeMap;
use std::fmt;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    schema: String,
    #[serde(deserialize_with = "unsigned")]
    revision: u64,
    #[serde(deserialize_with = "unique_profiles")]
    profiles: BTreeMap<String, Profile>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    #[serde(deserialize_with = "unsigned")]
    version: u64,
    resources: Resources,
    binding: Binding,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Resources {
    budget_mode: String,
    #[serde(rename = "memoryMiB", deserialize_with = "small_unsigned")]
    memory_mib: u32,
    #[serde(deserialize_with = "small_unsigned")]
    pids_limit: u32,
    cpus: Box<RawValue>,
    #[serde(rename = "poolMemoryMiB", deserialize_with = "small_unsigned")]
    pool_memory_mib: u32,
    #[serde(deserialize_with = "small_unsigned")]
    pool_tasks_max: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    employee_id: String,
    current_sid: String,
    target_sid: String,
    #[serde(deserialize_with = "unsigned")]
    current_generation: u64,
    #[serde(deserialize_with = "unsigned")]
    target_generation: u64,
}

// Python json.loads(-0) is integer zero, whereas serde's normal unsigned
// decoder rejects it as a float. Preserve lexical integer semantics explicitly.
fn unsigned<'de, D: Deserializer<'de>>(decoder: D) -> Result<u64, D::Error> {
    let raw: Box<RawValue> = Deserialize::deserialize(decoder)?;
    let value = raw
        .get()
        .parse::<i128>()
        .map_err(|_| de::Error::custom("VERSION_TYPE"))?;
    u64::try_from(value).map_err(|_| de::Error::custom("VERSION_TYPE"))
}
fn small_unsigned<'de, D: Deserializer<'de>>(decoder: D) -> Result<u32, D::Error> {
    u32::try_from(unsigned(decoder)?).map_err(|_| de::Error::custom("RESOURCE_LIMIT"))
}

struct UniqueProfiles;
impl<'de> Visitor<'de> for UniqueProfiles {
    type Value = BTreeMap<String, Profile>;
    fn expecting(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("unique profile keys")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut entries: A) -> Result<Self::Value, A::Error> {
        let mut profiles = BTreeMap::new();
        while let Some((key, value)) = entries.next_entry::<String, Profile>()? {
            if profiles.insert(key, value).is_some() {
                return Err(de::Error::custom("DUPLICATE_KEY"));
            }
            if profiles.len() > MAX_PROFILES {
                return Err(de::Error::custom("PROFILE_COUNT"));
            }
        }
        Ok(profiles)
    }
}
fn unique_profiles<'de, D: Deserializer<'de>>(
    decoder: D,
) -> Result<BTreeMap<String, Profile>, D::Error> {
    decoder.deserialize_map(UniqueProfiles)
}

fn cpu(raw: &RawValue) -> Result<CpuQuota, CodecError> {
    let text = raw.get();
    if !text.contains(['.', 'e', 'E']) {
        let integer = text.parse::<i64>().map_err(|_| CodecError::ClosedSchema)?;
        return Ok(CpuQuota::from_integer(
            u64::try_from(integer).map_err(|_| CodecError::ClosedSchema)?,
        )?);
    }
    Ok(CpuQuota::from_float(
        text.parse::<f64>().map_err(|_| CodecError::ClosedSchema)?,
    )?)
}
impl Resources {
    fn checked(self) -> Result<ResourcePolicy, CodecError> {
        let mode = match self.budget_mode.as_str() {
            "pool" => BudgetMode::Pool,
            "admission" => BudgetMode::Admission,
            _ => return Err(CodecError::ClosedSchema),
        };
        Ok(ResourcePolicy::try_new(
            mode,
            self.memory_mib,
            self.pids_limit,
            cpu(&self.cpus)?,
            self.pool_memory_mib,
            self.pool_tasks_max,
        )?)
    }
}
impl Binding {
    fn checked(self) -> Result<ProfileBinding, CodecError> {
        Ok(ProfileBinding::try_new(
            ProfileEmployeeId::parse(&self.employee_id)?,
            ProfileSessionId::parse(&self.current_sid)?,
            ProfileSessionId::parse(&self.target_sid)?,
            Generation::try_new(self.current_generation)?,
            Generation::try_new(self.target_generation)?,
        )?)
    }
}

pub fn decode(raw: &[u8]) -> Result<ProfileDocument, CodecError> {
    if raw.len() > MAX_BYTES {
        return Err(CodecError::StoreBound);
    }
    let text = super::text::decode(raw)?;
    let wire: Document = serde_json::from_str(&text).map_err(|error| {
        let message = error.to_string();
        if message.starts_with("DUPLICATE_KEY") || message.starts_with("duplicate field") {
            CodecError::DuplicateKey
        } else if message.starts_with("PROFILE_COUNT") {
            CodecError::InvalidProfile(reverie_core::profiles::ProfileError::ProfileCount)
        } else {
            CodecError::ClosedSchema
        }
    })?;
    if wire.schema != SCHEMA {
        return Err(CodecError::StoreSchema);
    }
    let mut profiles = BTreeMap::new();
    for (employee, profile) in wire.profiles {
        profiles.insert(
            ProfileEmployeeId::parse(&employee)?,
            ResourceProfile::new(
                ProfileVersion::try_new(profile.version)?,
                profile.resources.checked()?,
                profile.binding.checked()?,
            ),
        );
    }
    Ok(ProfileDocument::try_new(
        StoreRevision::try_new(wire.revision)?,
        profiles,
    )?)
}
