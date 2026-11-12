//! Closed controller messages. These are correlation/selection DATA, never a
//! serialized consent, maintenance fence, Created owner or pool capability.
use super::super::*;
use reverie_contracts::worker_pool::WorkerPoolMemberPolicy;
use reverie_core::operations::JournalId;
use serde::{Deserialize, Serialize};

pub(in crate::worker_pool) const MAX_FRAME: usize = 8192;
const PURPOSE: &str = "reverie-worker-pool-control-v1";
pub(in crate::worker_pool) const MEMBER_POLICY_EDIT_VERSION: u32 = 1;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    version: u8,
    purpose: String,
    deadline_monotonic_ns: u64,
    request: Request,
}
pub(in crate::worker_pool) struct Received {
    pub(in crate::worker_pool) request: Request,
    pub(in crate::worker_pool) end: std::time::Instant,
}
#[derive(Deserialize)]
#[serde(
    tag = "verb",
    deny_unknown_fields,
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(in crate::worker_pool) enum Request {
    Status {
        request_id: String,
    },
    ContinueOriginal {
        request_id: String,
    },
    Close {
        request_id: String,
    },
    Activate {
        request_id: String,
        host_reserve_mi_b: u32,
    },
    Resume {
        request_id: String,
        host_reserve_mi_b: u32,
    },
    ConfigureMember {
        request_id: String,
        employee: String,
        session: String,
        container: String,
    },
    ObserveMember {
        request_id: String,
        employee: String,
        session: String,
        container: String,
    },
    ApplyMemberPolicy {
        request_id: String,
        version: u32,
        edit: MemberPolicyEdit,
    },
    CommitMemberPolicy {
        request_id: String,
        version: u32,
        operation: String,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::worker_pool) struct MemberPolicyEdit {
    pub(in crate::worker_pool) operation: String,
    pub(in crate::worker_pool) employee: String,
    pub(in crate::worker_pool) session: String,
    pub(in crate::worker_pool) container: String,
    pub(in crate::worker_pool) pid: u32,
    pub(in crate::worker_pool) start: String,
    pub(in crate::worker_pool) leaf: (u64, u64),
    pub(in crate::worker_pool) before: WorkerPoolMemberPolicy,
    pub(in crate::worker_pool) proposed: WorkerPoolMemberPolicy,
    pub(in crate::worker_pool) expected_revision: u64,
}
impl Request {
    pub(in crate::worker_pool) fn decode(raw: &[u8]) -> Result<Received> {
        need(
            !raw.is_empty() && raw.len() <= MAX_FRAME,
            "WORKER_POOL_CONTROL_FRAME_BOUND",
        )?;
        let envelope: Envelope = serde_json::from_slice(raw)
            .map_err(|_| PoolError::Refused("WORKER_POOL_CONTROL_FRAME"))?;
        need(
            envelope.version == 1 && envelope.purpose == PURPOSE,
            "WORKER_POOL_CONTROL_VERSION",
        )?;
        let before = std::time::Instant::now();
        let remaining = envelope
            .deadline_monotonic_ns
            .saturating_sub(monotonic_ns()?)
            .min(20_000_000_000);
        let end = before + std::time::Duration::from_nanos(remaining);
        let value = envelope.request;
        need(
            JournalId::parse(value.id()).is_ok(),
            "WORKER_POOL_CONTROL_REQUEST_ID",
        )?;
        match &value {
            Self::Activate {
                host_reserve_mi_b, ..
            }
            | Self::Resume {
                host_reserve_mi_b, ..
            } => need(
                *host_reserve_mi_b >= 256,
                "WORKER_POOL_CONTROL_HOST_RESERVE",
            )?,
            Self::ConfigureMember {
                employee,
                session,
                container,
                ..
            }
            | Self::ObserveMember {
                employee,
                session,
                container,
                ..
            } => {
                need(
                    reverie_core::ids::ProfileEmployeeId::parse(employee).is_ok()
                        && reverie_core::ids::ProfileSessionId::parse(session).is_ok()
                        && reverie_contracts::worker_pool::hex_id(container),
                    "WORKER_POOL_CONTROL_MEMBER",
                )?;
            }
            Self::Status { .. } | Self::ContinueOriginal { .. } | Self::Close { .. } => (),
            Self::ApplyMemberPolicy { version, edit, .. } => {
                edit.validate(*version)?;
            }
            Self::CommitMemberPolicy {
                version, operation, ..
            } => {
                need(
                    *version == MEMBER_POLICY_EDIT_VERSION && JournalId::parse(operation).is_ok(),
                    "WORKER_POOL_MEMBER_EDIT_REQUEST",
                )?;
            }
        }
        Ok(Received {
            request: value,
            end,
        })
    }
    pub(in crate::worker_pool) fn id(&self) -> &str {
        match self {
            Self::Status { request_id }
            | Self::ContinueOriginal { request_id }
            | Self::Close { request_id }
            | Self::Activate { request_id, .. }
            | Self::Resume { request_id, .. }
            | Self::ConfigureMember { request_id, .. }
            | Self::ObserveMember { request_id, .. }
            | Self::ApplyMemberPolicy { request_id, .. }
            | Self::CommitMemberPolicy { request_id, .. } => request_id,
        }
    }
}

impl MemberPolicyEdit {
    fn validate(&self, version: u32) -> Result<()> {
        need(
            version == MEMBER_POLICY_EDIT_VERSION
                && JournalId::parse(&self.operation).is_ok()
                && reverie_core::ids::ProfileEmployeeId::parse(&self.employee).is_ok()
                && reverie_core::ids::ProfileSessionId::parse(&self.session).is_ok()
                && reverie_contracts::worker_pool::hex_id(&self.container)
                && self.pid > 1
                && self
                    .start
                    .parse::<u64>()
                    .is_ok_and(|value| value.to_string() == self.start)
                && self.leaf.1 > 0,
            "WORKER_POOL_MEMBER_EDIT_REQUEST",
        )
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::worker_pool) struct Reply<'a> {
    pub(in crate::worker_pool) version: u8,
    pub(in crate::worker_pool) request_id: &'a str,
    pub(in crate::worker_pool) phase: &'a str,
    pub(in crate::worker_pool) known: bool,
    pub(in crate::worker_pool) primary_error: Option<&'static str>,
    pub(in crate::worker_pool) anchor: Option<AnchorData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::worker_pool) member_policy_edit_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::worker_pool) restored_birth: Option<RestoredBirthAck>,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::worker_pool) struct RestoredBirthAck {
    birth_sha256: String,
    member_revision: u64,
}

impl RestoredBirthAck {
    pub(in crate::worker_pool) fn from_birth(
        birth: &reverie_contracts::worker_pool::ControllerServiceBirth,
        digest: [u8; 32],
    ) -> Option<Self> {
        birth.restored().then(|| Self {
            birth_sha256: super::super::policy::digest_text(digest),
            member_revision: birth
                .member_snapshot()
                .map_or(0, |snapshot| snapshot.revision()),
        })
    }

    pub(in crate::worker_pool) fn assert_reply(
        &self,
        reply: &serde_json::Value,
        phase: &'static str,
    ) -> Result<()> {
        let observed = reply
            .get("restoredBirth")
            .ok_or(PoolError::Refused("WORKER_POOL_RESTORED_BIRTH_UNSUPPORTED"))?;
        let observed: Self = serde_json::from_value(observed.clone())
            .map_err(|_| PoolError::Refused("WORKER_POOL_RESTORED_BIRTH_ACK"))?;
        need(
            &observed == self
                && reply["memberPolicyEditVersion"] == MEMBER_POLICY_EDIT_VERSION
                && reply["known"] == true
                && reply["phase"] == phase
                && reply["primaryError"].is_null(),
            "WORKER_POOL_RESTORED_BIRTH_ACK",
        )
    }
}
#[derive(Serialize)]
pub(in crate::worker_pool) struct AnchorData {
    pub(in crate::worker_pool) container: String,
    pub(in crate::worker_pool) pid: u32,
}
pub(in crate::worker_pool) fn monotonic_ns() -> Result<u64> {
    let value = nix::time::clock_gettime(nix::time::ClockId::CLOCK_MONOTONIC)
        .map_err(std::io::Error::from)?;
    u64::try_from(value.tv_sec())
        .ok()
        .and_then(|seconds| seconds.checked_mul(1_000_000_000))
        .and_then(|seconds| {
            u64::try_from(value.tv_nsec())
                .ok()
                .and_then(|ns| seconds.checked_add(ns))
        })
        .ok_or(PoolError::Refused("WORKER_POOL_CLOCK"))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn frame(request: serde_json::Value, deadline: u64) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"version":1,"purpose":PURPOSE,"deadlineMonotonicNs":deadline,"request":request})).unwrap()
    }
    #[test]
    fn closed_protocol_refuses_unversioned_unknown_commands_and_extra_members() {
        let request =
            serde_json::json!({"verb":"status","requestId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"});
        assert!(
            Request::decode(&frame(
                request.clone(),
                monotonic_ns().unwrap() + 1_000_000_000
            ))
            .is_ok()
        );
        for request in [
            serde_json::json!({"verb":"exec","requestId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","command":"true"}),
            serde_json::json!({"verb":"status","requestId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","owner":true}),
        ] {
            assert!(Request::decode(&frame(request, 0)).is_err());
        }
        assert!(Request::decode(br#"{"request":{"verb":"status"}}"#).is_err());
    }
    #[test]
    fn expired_sender_deadline_is_not_renewed_at_receiver() {
        let received=Request::decode(&frame(serde_json::json!({"verb":"activate","requestId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","hostReserveMiB":4096}),0)).unwrap();
        assert!(received.end <= std::time::Instant::now());
        assert!(super::super::check(received.end).is_err());
    }
    #[test]
    fn receiver_caps_sender_budget_even_for_maximum_integer() {
        let before = std::time::Instant::now();
        let received = Request::decode(&frame(
            serde_json::json!({"verb":"status","requestId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}),
            u64::MAX,
        ))
        .unwrap();
        assert!(received.end <= before + std::time::Duration::from_secs(21));
    }

    #[test]
    fn resume_accepts_only_the_original_correlation_and_bounded_reserve() {
        let mut request = serde_json::json!({
            "verb":"resume","requestId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","hostReserveMiB":256
        });
        let received = Request::decode(&frame(request.clone(), u64::MAX)).unwrap();
        assert!(matches!(
            received.request,
            Request::Resume {
                host_reserve_mi_b: 256,
                ..
            }
        ));
        request["anchor"] = serde_json::json!("a".repeat(64));
        assert!(Request::decode(&frame(request.clone(), u64::MAX)).is_err());
        request.as_object_mut().unwrap().remove("anchor");
        request["hostReserveMiB"] = serde_json::json!(255);
        assert!(Request::decode(&frame(request, u64::MAX)).is_err());
    }
}
