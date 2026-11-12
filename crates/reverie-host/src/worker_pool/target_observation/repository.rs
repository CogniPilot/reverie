//! Native retained-raw comparison only; fixture manifest DATA is not trusted
//! package provenance, OS origin, controller readiness or effect authority.
use super::*;
use reverie_contracts::resource_actor::{POOL_IMAGE_INPUT_FACTORY_FILES, PoolImageInputsData};
use serde_json::json;

fn inputs(fixture: &Fixture, different: bool) -> PoolImageInputsData {
    let files: serde_json::Map<_, _> = POOL_IMAGE_INPUT_FACTORY_FILES
        .iter()
        .map(|name| {
            (
                (*name).to_owned(),
                json!({"sha256":"f".repeat(64),"bytes":1}),
            )
        })
        .collect();
    let mut document = json!({"version":1,"purpose":"worker-pool-image-inputs-v1",
        "system":"x86_64-linux","source":{"path":"/tmp/source","files":files}});
    for (role, id) in [("anchor", image('a')), ("controller", image('b'))] {
        let mut spec = json!({"Config":{"Env":[format!("ROLE={role}")]},
            "RootFS":{"Type":"layers","Layers":[format!("sha256:{}","c".repeat(64))]},
            "Architecture":"amd64","Os":"linux","Created":"1970-01-01T00:00:01Z"});
        if !different {
            let mut actual = spec.clone();
            actual["Id"] = json!(id);
            fixture.write(role, actual);
        } else if role == "controller" {
            spec["Config"]["Env"] = json!(["ROLE=foreign"]);
        }
        document[role] = json!({"archive":{"path":"/tmp/measured.tar.gz","sha256":"d".repeat(64),"bytes":1},
            "archiveConfigSHA256":id.strip_prefix("sha256:").unwrap(),"imageSpec":spec});
    }
    PoolImageInputsData::decode(&serde_json::to_vec(&document).unwrap()).unwrap()
}

#[test]
fn captured_or_closed_target_cannot_supply_observed_package_image_data() {
    let fixture = Fixture::new();
    let input = inputs(&fixture, false);
    let mut owner =
        PoolTargetObservation::capture(&fixture.runtime, &fixture.policy, end()).unwrap();
    let refused = owner.qualify_observed_images(&input);
    let reads = fixture.starts();
    let closed = owner.close(&fixture.runtime);
    let closed_refusal = owner.qualify_observed_images(&input);
    fixture.finish();
    assert!(refused.is_err() && closed_refusal.is_err());
    assert_eq!(reads, 0);
    closed.unwrap();
}

#[test]
fn actual_three_reads_compare_full_package_fields_without_requery_and_keep_typed_mismatch() {
    let fixture = Fixture::new();
    let input = inputs(&fixture, false);
    let different = inputs(&fixture, true);
    let mut owner =
        PoolTargetObservation::capture(&fixture.runtime, &fixture.policy, end()).unwrap();
    let observed = owner.observe(&fixture.runtime, &fixture.policy);
    let matched = owner.qualify_observed_images(&input);
    let mismatch = owner.qualify_observed_images(&different);
    let after_failure = owner.observe(&fixture.runtime, &fixture.policy);
    let reads = fixture.starts();
    let closed = owner.close(&fixture.runtime);
    fixture.finish();
    observed.unwrap();
    assert_eq!(matched.unwrap(), [image('a'), image('b')]);
    let mismatch = mismatch.unwrap_err();
    assert!(matches!(mismatch, PoolTargetObservationError::Data(_)));
    assert_eq!(mismatch.code(), after_failure.unwrap_err().code());
    assert_eq!(reads, 3);
    closed.unwrap();
}
