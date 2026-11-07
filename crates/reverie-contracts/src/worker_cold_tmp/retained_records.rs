//! Fixed original retained/lease wire DATA only. Encoding an epoch, reference
//! report or native record cannot mint the Host's real resource/phase owner.
use super::*;
use super::{
    records::{integer, text},
    reference_report::ReferenceReport,
};
use crate::legacy_json::{Number, ordered::OrderedValue};
use reverie_core::{
    decimal::UnsignedInteger,
    ids::{ContainerId, NativeOperationId, ProfileSessionId},
    posix_path::PosixPath,
};

#[derive(Clone, Copy)]
pub struct RetainedRecordIdentity<'a> {
    pub attempt: &'a NativeOperationId,
    pub identity: &'a str,
    pub session: &'a ProfileSessionId,
    pub owner: Option<&'a MetadataText>,
}
#[derive(Clone, Copy)]
pub struct RetainedRecordEpoch<'a> {
    pub identity: RetainedRecordIdentity<'a>,
    pub envelope: &'a PosixPath,
    pub old: (u64, u64),
}
#[derive(Clone, Copy)]
pub struct RetainedRecordFresh<'a> {
    pub epoch: RetainedRecordEpoch<'a>,
    pub new: (u64, u64),
    pub reservation_until: &'a RetainedReservationUntil,
}
pub struct RetainedNativeRecord<'a> {
    pub container: &'a ContainerId,
    pub image: &'a MetadataText,
    pub pid: &'a UnsignedInteger,
    pub start: &'a str,
}
fn points(points: &[u32]) -> Value {
    Value(Node::String(Text(points.to_vec())))
}
fn path(value: &PosixPath) -> Value {
    points(&value.codepoints())
}
fn float(value: f64) -> Value {
    Value(Node::Number(Number::Float(value)))
}
fn identity(value: RetainedRecordIdentity<'_>) -> Object {
    BTreeMap::from([
        (key("version"), integer(1)),
        (key("attemptId"), text(value.attempt.as_str())),
        (key("identity"), text(value.identity)),
        (key("sessionId"), text(value.session.as_str())),
        (
            key("owner"),
            value
                .owner
                .map_or_else(|| Value(Node::Null), |owner| points(owner.codepoints())),
        ),
    ])
}
fn epoch(value: RetainedRecordEpoch<'_>) -> Object {
    let mut fields = identity(value.identity);
    fields.extend([
        (key("oldDevice"), integer(value.old.0)),
        (key("oldInode"), integer(value.old.1)),
        (
            key("retainedData"),
            path(&value.envelope.join(&PosixPath::from_scalar_text("data"))),
        ),
        (key("oldDataDeleted"), Value(Node::Bool(false))),
        (key("deepTreeInspected"), Value(Node::Bool(false))),
    ]);
    fields
}
fn fresh(value: RetainedRecordFresh<'_>) -> Object {
    let mut fields = epoch(value.epoch);
    fields.extend([
        (key("newDevice"), integer(value.new.0)),
        (key("newInode"), integer(value.new.1)),
        (
            key("reservationUntil"),
            value.reservation_until.0.deep_clone(),
        ),
    ]);
    fields
}
fn references(before: &ReferenceReport, after: &ReferenceReport) -> Value {
    Value(Node::Object(BTreeMap::from([
        (key("before"), before.value()),
        (key("after"), after.value()),
    ])))
}
pub fn retained_keep_record() -> Vec<u8> {
    worker_config::encode_data(&Value(Node::Object(BTreeMap::from([(
        key("purpose"),
        text("Retained old TMP; not disposable; separate reclamation admission required"),
    )]))))
}
pub fn retained_intent_record(
    value: RetainedRecordEpoch<'_>,
    before: &ReferenceReport,
    digest: &str,
) -> Vec<u8> {
    let mut fields = epoch(value);
    fields.extend([
        (key("strategy"), text("retain-and-replace")),
        (key("state"), text("RETIREMENT_INTENT")),
        (
            key("freshStage"),
            text(&format!(".cold-fresh-{}", value.identity.attempt.as_str())),
        ),
        (key("referenceObservations"), before.value()),
        (key("configDigest"), text(digest)),
    ]);
    worker_config::encode_data(&Value(Node::Object(fields)))
}
pub fn retained_prepared_record(
    value: RetainedRecordFresh<'_>,
    before: &ReferenceReport,
    after: &ReferenceReport,
) -> Vec<u8> {
    let mut fields = fresh(value);
    fields.extend([
        (key("state"), text("OLD_TMP_RETAINED_FRESH_TMP_FENCED")),
        (
            key("preservationMarker"),
            path(
                &value
                    .epoch
                    .envelope
                    .join(&PosixPath::from_scalar_text(".keep")),
            ),
        ),
        (key("references"), references(before, after)),
    ]);
    worker_config::encode_data(&Value(Node::Object(fields)))
}
pub fn retained_bound_record(
    value: RetainedRecordFresh<'_>,
    before: &ReferenceReport,
    after: &ReferenceReport,
    commits: [&ReferenceReport; 2],
    native: RetainedNativeRecord<'_>,
) -> Vec<u8> {
    let mut fields = fresh(value);
    fields.extend([
        (
            key("state"),
            text("OLD_TMP_RETAINED_FRESH_TMP_BOUND_PENDING_RELEASE"),
        ),
        (
            key("requiresAbsentFenceForUse"),
            text("cold-tmp-cleanup.pending.json"),
        ),
        (key("permanentKeepMarker"), Value(Node::Bool(true))),
        (key("references"), references(before, after)),
        (
            key("commitReferences"),
            Value(Node::Array(
                commits.into_iter().map(ReferenceReport::value).collect(),
            )),
        ),
        (
            key("nativeContainer"),
            Value(Node::Object(BTreeMap::from([
                (key("containerId"), text(native.container.as_str())),
                (key("image"), points(native.image.codepoints())),
                (
                    key("pid"),
                    Value(Node::Number(Number::Integer(
                        native.pid.as_str().to_owned(),
                    ))),
                ),
                (key("startTick"), text(native.start)),
            ]))),
        ),
    ]);
    worker_config::encode_data(&Value(Node::Object(fields)))
}
fn lease(fields: Vec<(&str, Value)>) -> Vec<u8> {
    let mut raw = OrderedValue::object(
        fields
            .into_iter()
            .map(|(name, value)| (key(name), OrderedValue::scalar(value)))
            .collect(),
    )
    .encode();
    raw.push(b'\n');
    raw
}
pub fn retained_path_record(directory: &PosixPath, now: f64) -> Vec<u8> {
    lease(vec![
        ("version", integer(1)),
        ("path", path(directory)),
        ("first_seen_utc", float(now)),
    ])
}
pub fn retained_reservation_record(directory: &PosixPath, now: f64) -> Vec<u8> {
    lease(vec![
        ("version", integer(1)),
        ("path", path(directory)),
        ("created_utc", float(now)),
        ("until_utc", float(now + 86400.0)),
        ("owner", text("retained-cold-tmp")),
    ])
}
/// Original json.loads(bytes) and exact tuple equality after the private Host
/// has already checked its captured prepared-file hash. No ownership is minted.
pub fn retained_prepared_binding(
    raw: &[u8],
    identity: &str,
    session: &ProfileSessionId,
    owner: Option<&MetadataText>,
) -> Result<()> {
    let value =
        crate::legacy_json::decode_rootless_profile(raw).map_err(|_| ColdDataError::Json)?;
    let fields = object(&value).ok_or(ColdDataError::Json)?;
    let expected = [
        ("identity", text(identity)),
        ("sessionId", text(session.as_str())),
        (
            "owner",
            owner.map_or_else(|| Value(Node::Null), |owner| points(owner.codepoints())),
        ),
    ];
    for (name, expected) in expected {
        if !field(fields, name)
            .ok_or(ColdDataError::Json)?
            .python_eq(&expected)
        {
            return Err(ColdDataError::Json);
        }
    }
    Ok(())
}
