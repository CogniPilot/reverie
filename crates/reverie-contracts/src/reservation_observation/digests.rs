use super::*;
use crate::reservation_engine::{NativeLimitBinding, NativeStorageBinding, StoppedWebsite};
use reverie_core::{
    decimal::UnsignedInteger,
    operations::{JournalDigest, JournalId},
    profiles::ResourceProfile,
};
pub enum PoolWebsite<'a> {
    Running(&'a NativeLimitBinding),
    Stopped(&'a StoppedWebsite),
}
pub fn pool_revision_digest(
    pool: &JournalId,
    budget: &UnsignedInteger,
    site: PoolWebsite<'_>,
    reserve_mib: u32,
    commitments: &[NativeLimitBinding],
) -> Result<JournalDigest> {
    let mut sorted = commitments.iter().collect::<Vec<_>>();
    sorted.sort_by(|a, b| a.container_id().cmp(b.container_id()));
    let site = match site {
        PoolWebsite::Running(value) => value.data().deep_clone(),
        PoolWebsite::Stopped(value) => value.data(),
    };
    let fields = [
        (key("pool"), Value(Node::String(key(pool.as_str())))),
        (key("budget"), integer(budget)),
        (key("site"), site),
        (
            key("reserve"),
            Value(Node::Number(Number::Integer(reserve_mib.to_string()))),
        ),
        (
            key("commitments"),
            Value(Node::Array(
                sorted
                    .into_iter()
                    .map(|value| value.data().deep_clone())
                    .collect(),
            )),
        ),
    ]
    .into_iter()
    .collect();
    digest(&Value(Node::Object(fields)))
}
pub fn source_binding_digest(
    employee: &ReservationEmployee,
    native: &NativeLimitBinding,
    storage: &NativeStorageBinding,
    profile: &ResourceProfile,
) -> Result<JournalDigest> {
    // profiles_v1 is a closed ASCII schema: UUIDs, bounded integers and finite
    // CPU numbers only. Unlike arbitrary company/worker data, its encoded
    // strings cannot contain adjacent surrogate codepoints requiring a copy.
    let bytes = crate::profiles_v1::encode_profile(profile)
        .map_err(|_| ObservationDataError::Fingerprint)?;
    let profile =
        crate::legacy_json::decode_utf8(&bytes).map_err(|_| ObservationDataError::Fingerprint)?;
    let fields = [
        (key("employee"), employee.data().deep_clone()),
        (key("native"), native.data().deep_clone()),
        (key("storage"), storage.data().deep_clone()),
        (key("profile"), profile),
    ]
    .into_iter()
    .collect();
    digest(&Value(Node::Object(fields)))
}
pub(super) fn digest(value: &Value) -> Result<JournalDigest> {
    let bytes = crate::reservation_control::fingerprint(value)
        .map_err(|_| ObservationDataError::Fingerprint)?;
    Ok(JournalDigest::parse(&crate::digest::hex(&bytes)).expect("SHA256 is a lowercase digest"))
}
fn integer(value: &UnsignedInteger) -> Value {
    Value(Node::Number(Number::Integer(value.as_str().to_owned())))
}
