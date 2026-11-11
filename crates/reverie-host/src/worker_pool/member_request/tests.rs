use super::*;

const REQUEST: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

fn reply() -> serde_json::Value {
    serde_json::json!({
        "version":1, "requestId":REQUEST, "phase":"memberRefused", "known":true,
        "primaryError":"WORKER_POOL_MEMBER_CAPACITY_EXHAUSTED", "anchor":null
    })
}

#[test]
fn only_exact_closed_refusal_settles_its_original_dispatch() {
    for original in [
        MemberRequestRefusal::deadline(),
        MemberRequestRefusal::capacity(),
        MemberRequestRefusal::already_attempted(),
        MemberRequestRefusal::policy(),
    ] {
        let actual = crate::worker_pool::service::protocol::Reply {
            version: 1,
            request_id: REQUEST,
            phase: "memberRefused",
            known: true,
            primary_error: Some(original.code()),
            anchor: Some(crate::worker_pool::service::protocol::AnchorData {
                container: "d".repeat(64),
                pid: 7,
            }),
            member_policy_edit_version: None,
            restored_birth: None,
        };
        let actual = serde_json::to_value(actual).unwrap();
        let mut unknown = false;
        let dispatch = MemberRequestDispatch::begin(REQUEST.into(), &mut unknown);
        assert!(unknown);
        let receipt = dispatch.refused(&actual).unwrap();
        assert!(
            unknown,
            "correlation alone cannot settle the original owner"
        );
        receipt.require_original_known().unwrap();
        let refusal = receipt.settle_after_current(&mut unknown, Ok(())).unwrap();
        assert_eq!(refusal.code(), original.code());
        assert!(!unknown);
    }

    // A prior unknown belongs to an earlier owner and cannot be laundered by a
    // later request's genuine no-effect reply.
    let mut unknown = true;
    let dispatch = MemberRequestDispatch::begin(REQUEST.into(), &mut unknown);
    let receipt = dispatch.refused(&reply()).unwrap();
    assert!(receipt.require_original_known().is_err());
    assert!(receipt.settle_after_current(&mut unknown, Ok(())).is_ok());
    assert!(unknown);
}

#[test]
fn failed_current_controller_guard_never_clears_real_dispatch_uncertainty() {
    use crate::worker_pool::PoolError;
    for error in [
        PoolError::Refused("WORKER_POOL_CONTROLLER_PEER"),
        PoolError::MetadataClose(Box::new(PoolError::Io(std::io::Error::other(
            "checked native observation close",
        )))),
    ] {
        let mut unknown = false;
        let dispatch = MemberRequestDispatch::begin(REQUEST.into(), &mut unknown);
        let receipt = dispatch.refused(&reply()).unwrap();
        assert!(unknown);
        let code = error.code();
        let retained = receipt
            .settle_after_current(&mut unknown, Err(error))
            .unwrap_err();
        assert_eq!(retained.code(), code);
        assert!(unknown, "failed current guard must retain the actual flag");
    }
}

#[test]
fn old_unknown_malformed_or_cross_request_reply_never_clears_uncertainty() {
    let original = reply();
    let changes = [
        ("version", serde_json::json!(2)),
        (
            "requestId",
            serde_json::json!("ffffffff-ffff-4fff-8fff-ffffffffffff"),
        ),
        ("phase", serde_json::json!("retained")),
        ("phase", serde_json::json!("memberConfigured")),
        ("known", serde_json::json!(false)),
        ("known", serde_json::json!("true")),
        (
            "primaryError",
            serde_json::json!("WORKER_POOL_MEMBER_RETAINED"),
        ),
        ("primaryError", serde_json::Value::Null),
        ("anchor", serde_json::json!(true)),
        ("anchor", serde_json::json!({})),
        (
            "anchor",
            serde_json::json!({"container":"d".repeat(64),"pid":0}),
        ),
        ("anchor", serde_json::json!({"container":"invalid","pid":7})),
        (
            "anchor",
            serde_json::json!({"container":"d".repeat(64),"pid":7,"authority":true}),
        ),
        ("authority", serde_json::json!(true)),
    ];
    for (key, value) in changes {
        let mut candidate = original.clone();
        candidate[key] = value;
        let mut unknown = false;
        let dispatch = MemberRequestDispatch::begin(REQUEST.into(), &mut unknown);
        assert!(dispatch.refused(&candidate).is_none(), "{key}");
        assert!(unknown, "{key}");
    }
    for key in [
        "version",
        "requestId",
        "phase",
        "known",
        "primaryError",
        "anchor",
    ] {
        let mut candidate = original.clone();
        candidate.as_object_mut().unwrap().remove(key);
        let mut unknown = false;
        let dispatch = MemberRequestDispatch::begin(REQUEST.into(), &mut unknown);
        assert!(dispatch.refused(&candidate).is_none(), "{key}");
        assert!(unknown, "{key}");
    }
    let mut unknown = false;
    let dispatch = MemberRequestDispatch::begin(REQUEST.into(), &mut unknown);
    drop(dispatch);
    assert!(unknown, "abandoning the original request cannot settle it");
}
