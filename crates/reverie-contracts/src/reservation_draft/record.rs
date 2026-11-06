use super::*;
use reverie_core::operations::{MemoryBytes, OperationRequest};
/// Already observed DATA and fresh opaque IDs, selected by the fixed native
/// application while its actual journal reader/flock is held.
pub struct DraftFields<'a> {
    pub draft: &'a JournalId,
    pub key: &'a JournalId,
    pub operation: &'a JournalId,
    pub reservation: &'a JournalId,
    pub scope: &'a OperationScope,
    pub profile: &'a ResourceProfile,
    pub observed: &'a ReservationObservation,
}
pub struct DraftRecord {
    value: Value,
}
impl DraftRecord {
    pub fn from_observed_data(
        fields: DraftFields<'_>,
        document: &OperationDocument,
    ) -> Result<Self> {
        let target = JournalId::parse(fields.profile.binding().target_session().as_str())?;
        let current = fields.observed.fields().current_session.as_str();
        let refs = [
            fields.operation.as_str(),
            fields.reservation.as_str(),
            target.as_str(),
            fields.draft.as_str(),
            current,
        ];
        need(
            refs.into_iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == 5,
            DraftDataError::Ids,
        )?;
        for op in document.operations().values() {
            let op = op.data();
            let occupied = [
                op.id.as_str(),
                op.reservation_id.as_str(),
                op.reserved_sid.as_str(),
                op.observation.data().current_sid.as_str(),
            ];
            need(
                [
                    fields.operation.as_str(),
                    fields.reservation.as_str(),
                    target.as_str(),
                ]
                .iter()
                .all(|id| !occupied.contains(id)),
                DraftDataError::Ids,
            )?;
        }
        let value = Value(Node::Object(
            [
                (key("schema"), string("reverie-resource-private-draft-v1")),
                (key("draftId"), string(fields.draft.as_str())),
                (key("idempotencyKey"), string(fields.key.as_str())),
                (key("operationId"), string(fields.operation.as_str())),
                (key("reservationId"), string(fields.reservation.as_str())),
                (key("targetSid"), string(target.as_str())),
                (key("scope"), scope_value(fields.scope)),
                (key("profile"), profile_value(fields.profile)?),
                (key("observation"), fields.observed.value()),
            ]
            .into_iter()
            .collect(),
        ));
        Ok(Self { value })
    }
    /// Fixed file reader result; validate outer shape/scope/hash before role
    /// parsing. No private handle or effect permission is reconstructed.
    pub fn capture(
        metadata: &crate::storage_identity::Metadata,
        id: &JournalId,
        scope: &OperationScope,
        expected: &JournalDigest,
    ) -> Result<Self> {
        let value = metadata.as_value();
        let fields = object(value)?;
        let names = [
            "schema",
            "draftId",
            "idempotencyKey",
            "operationId",
            "reservationId",
            "targetSid",
            "scope",
            "profile",
            "observation",
        ];
        need(
            fields.len() == names.len() && names.iter().all(|name| fields.contains_key(&key(name))),
            DraftDataError::Changed,
        )?;
        need(
            field(fields, "schema")?.python_eq(&string("reverie-resource-private-draft-v1"))
                && field(fields, "draftId")?.python_eq(&string(id.as_str()))
                && field(fields, "scope")?.python_eq(&scope_value(scope))
                && digest(value)? == *expected,
            DraftDataError::Changed,
        )?;
        for name in [
            "idempotencyKey",
            "operationId",
            "reservationId",
            "targetSid",
        ] {
            JournalId::parse(&scalar(field(fields, name)?)?)?;
        }
        // J.observation is purpose-specific and intentionally stricter than
        // preview's nil-capable ReservationObservation.
        crate::operations_v1::decode_observation(&crate::worker_config::compact_data(field(
            fields,
            "observation",
        )?))?;
        let binding = object(field(object(field(fields, "profile")?)?, "binding")?)?;
        need(
            field(fields, "targetSid")?.python_eq(field(binding, "target_sid")?),
            DraftDataError::Changed,
        )?;
        Ok(Self {
            value: value.deep_clone(),
        })
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        digest(&self.value)?;
        Ok(crate::worker_config::compact_data(&self.value))
    }
    pub fn digest(&self) -> Result<JournalDigest> {
        digest(&self.value)
    }
    pub fn id(&self) -> JournalId {
        self.identifier("draftId")
    }
    pub fn key(&self) -> JournalId {
        self.identifier("idempotencyKey")
    }
    pub fn operation(&self) -> JournalId {
        self.identifier("operationId")
    }
    pub fn reservation(&self) -> JournalId {
        self.identifier("reservationId")
    }
    pub fn target(&self) -> JournalId {
        self.identifier("targetSid")
    }
    pub fn employee(&self) -> Result<reverie_core::ids::ProfileEmployeeId> {
        let observed = object(field(object(&self.value)?, "observation")?)?;
        reverie_core::ids::ProfileEmployeeId::parse(&scalar(field(observed, "employee_id")?)?)
            .map_err(|_| DraftDataError::Changed)
    }
    fn identifier(&self, name: &str) -> JournalId {
        JournalId::parse(
            &scalar(
                field(object(&self.value).expect("checked draft"), name).expect("checked field"),
            )
            .expect("checked scalar"),
        )
        .expect("checked ID")
    }
    pub fn assert_current_profile(&self, profile: Option<&ResourceProfile>) -> Result<()> {
        let fields = object(&self.value)?;
        need(
            profile.is_some_and(|profile| {
                field(fields, "profile")
                    .expect("checked draft")
                    .python_eq(&profile_value(profile).expect("checked closed profile"))
                    && field(fields, "targetSid")
                        .expect("checked draft")
                        .python_eq(&string(profile.binding().target_session().as_str()))
            }),
            DraftDataError::Changed,
        )
    }
    pub fn request(&self) -> Result<OperationRequest> {
        let fields = object(&self.value)?;
        let observed = crate::operations_v1::decode_observation(
            &crate::worker_config::compact_data(field(fields, "observation")?),
        )?;
        let profile = object(field(fields, "profile")?)?;
        let resources = object(field(profile, "resources")?)?;
        let bytes = |value: &Value| crate::worker_config::compact_data(value);
        // Reuse J's checked request field types, preserving source's late profile
        // version and memory validation rather than inventing a profile read.
        let memory = match &field(resources, "memoryMiB")?.0 {
            Node::Number(crate::legacy_json::Number::Integer(value)) => value
                .parse::<u64>()
                .ok()
                .and_then(|v| v.checked_mul(reverie_core::operations::MIB)),
            _ => None,
        }
        .ok_or(DraftDataError::Changed)?;
        let version = bytes(field(profile, "version")?);
        let version = std::str::from_utf8(&version).map_err(|_| DraftDataError::Changed)?;
        let version = version.parse::<u64>().map_err(|_| {
            DraftDataError::Operation(reverie_core::operations::OperationError::new("UINT64"))
        })?;
        let data = observed.data();
        Ok(OperationRequest {
            employee_id: data.employee_id.clone(),
            pool_id: data.pool_id.clone(),
            source_binding_digest: data.source_binding_digest.clone(),
            profile_version: reverie_core::revision::ObservedProfileVersion::try_new(version)
                .map_err(|_| {
                    DraftDataError::Operation(reverie_core::operations::OperationError::new(
                        "PROFILE_VERSION",
                    ))
                })?,
            requested_memory_bytes: MemoryBytes::try_new(memory)?,
            preview_digest: self.digest()?,
            observation_digest: crate::operations_v1::observation_digest(&observed),
        })
    }
    pub fn observation(&self) -> Result<reverie_core::operations::CapacityObservation> {
        Ok(crate::operations_v1::decode_observation(
            &crate::worker_config::compact_data(field(object(&self.value)?, "observation")?),
        )?)
    }
    /// Canonical comparison fields for the pre-claim observation phase. The
    /// draft's original version/memory spelling is still checked by request()
    /// only at the actual journal-claim phase, not by this data projection.
    pub fn comparison_request(&self, profile: &ResourceProfile) -> Result<OperationRequest> {
        let observed = self.observation()?;
        let data = observed.data();
        Ok(OperationRequest {
            employee_id: data.employee_id.clone(),
            pool_id: data.pool_id.clone(),
            source_binding_digest: data.source_binding_digest.clone(),
            profile_version: reverie_core::revision::ObservedProfileVersion::try_new(
                profile.version().get(),
            )
            .expect("positive checked profile"),
            requested_memory_bytes: MemoryBytes::try_new(
                u64::from(profile.resources().memory_mib()) * reverie_core::operations::MIB,
            )?,
            preview_digest: self.digest()?,
            observation_digest: crate::operations_v1::observation_digest(&observed),
        })
    }
    /// Source compares the decimal request string against the current checked
    /// profile before journal request parsing. Float memory is Python-equal to
    /// an integer profile but produces a different string after multiplication.
    pub fn requested_memory_matches(&self, expected: u64) -> Result<bool> {
        let profile = object(field(object(&self.value)?, "profile")?)?;
        let resources = object(field(profile, "resources")?)?;
        Ok(
            matches!(&field(resources,"memoryMiB")?.0,Node::Number(crate::legacy_json::Number::Integer(value)) if value.parse::<u64>().ok().and_then(|value|value.checked_mul(reverie_core::operations::MIB))==Some(expected)),
        )
    }
}
fn scope_value(scope: &OperationScope) -> Value {
    Value(Node::Object(
        [
            (key("company_id"), string(scope.company_id.as_str())),
            (
                key("owner_scope_digest"),
                string(scope.owner_scope_digest.as_str()),
            ),
        ]
        .into_iter()
        .collect(),
    ))
}
