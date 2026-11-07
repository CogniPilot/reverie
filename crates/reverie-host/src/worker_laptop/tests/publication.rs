use super::*;
use crate::command_telemetry::CommandTelemetry;
fn created(fixture: &Fixture) -> (LaptopWorkflow, CreatedLaptop) {
    let workflow = fixture.retain();
    fixture
        .runtime()
        .run_laptop_network(&workflow, end())
        .unwrap();
    let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
    let LaptopCreation::Created(created) = fixture
        .runtime()
        .create_laptop(&workflow, &telemetry, end())
        .unwrap()
    else {
        panic!("actual successful create");
    };
    (workflow, created)
}
fn trace(fixture: &Fixture, verb: &str) -> usize {
    fs::read_to_string(fixture.root.join("trace"))
        .unwrap_or_default()
        .lines()
        .filter(|line| line.starts_with(&format!("{verb}\0")))
        .count()
}
#[test]
fn actual_publication_precedes_start_and_native_started_is_not_cli_readiness_or_reclaim() {
    if isolated(
        "actual_publication_precedes_start_and_native_started_is_not_cli_readiness_or_reclaim",
    ) {
        return;
    }
    for (mode, normal_parent) in [("created-normal", true), ("created-noncanonical", false)] {
        let fixture = Fixture::new(mode);
        let (workflow, created) = created(&fixture);
        assert!(
            fixture
                .runtime()
                .start_laptop_container(&created, end())
                .is_err()
        );
        let home = fixture.root.join("state").join(SID).join("home");
        if normal_parent {
            fs::create_dir(home.join(".reverie-launch")).unwrap();
            fs::set_permissions(
                home.join(".reverie-launch"),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        fixture.runtime().publish_laptop_launch(&created).unwrap();
        let metadata = fs::read(fixture.root.join("state").join(SID).join("runtime.json")).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&metadata).unwrap();
        let exit = value["exit"].as_str().unwrap();
        let record = home
            .join(".reverie-launch")
            .join(exit.replace(".exit", ".json"));
        assert_eq!(fs::metadata(&record).unwrap().mode() & 0o777, 0o600);
        assert!(
            fs::read(&record)
                .unwrap()
                .windows(b"NIX_REMOTE".len())
                .any(|v| v == b"NIX_REMOTE")
        );
        assert!(fixture.runtime().publish_laptop_launch(&created).is_err());
        assert_eq!(
            fs::read(fixture.root.join("state").join(SID).join("runtime.json")).unwrap(),
            metadata
        );
        let ContainerStart::Started(started) = fixture
            .runtime()
            .start_laptop_container(&created, end())
            .unwrap()
        else {
            panic!("actual start acknowledgement");
        };
        assert_eq!(started.container_id().is_some(), normal_parent);
        assert!(started.same_workflow(&workflow));
        assert!(
            fixture
                .runtime()
                .start_laptop_container(&created, end())
                .is_err()
        );
        assert_eq!(trace(&fixture, "start"), 1);
        assert!(fixture.root.join("started-laptop").is_file());
        assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
        assert!(fixture.runtime().close(end()).is_err());
    }
}
#[test]
fn metadata_symlink_and_hardlink_refuse_before_truncate_without_losing_created_owners() {
    if isolated(
        "metadata_symlink_and_hardlink_refuse_before_truncate_without_losing_created_owners",
    ) {
        return;
    }
    use std::os::unix::fs::symlink;
    for symbolic in [false, true] {
        let fixture = Fixture::new("created-normal");
        let (workflow, created) = created(&fixture);
        let victim = fixture.root.join("victim");
        fs::write(&victim, b"owned prior bytes").unwrap();
        let metadata = fixture.root.join("state").join(SID).join("runtime.json");
        if symbolic {
            symlink(&victim, &metadata).unwrap();
        } else {
            fs::hard_link(&victim, &metadata).unwrap();
        }
        assert!(fixture.runtime().publish_laptop_launch(&created).is_err());
        assert_eq!(fs::read(&victim).unwrap(), b"owned prior bytes");
        assert!(workflow.failure().unwrap().is_some());
        assert!(
            fixture
                .runtime()
                .start_laptop_container(&created, end())
                .is_err()
        );
        assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
        assert!(fixture.runtime().close(end()).is_err());
        assert_eq!(trace(&fixture, "start"), 0);
        assert!(NixStoreGuard::acquire_migration(&fixture.source, &sid()).is_err());
    }
}
#[test]
fn writable_launch_parent_refuses_after_create_without_unlinking_any_namespace() {
    if isolated("writable_launch_parent_refuses_after_create_without_unlinking_any_namespace") {
        return;
    }
    let fixture = Fixture::new("created-normal");
    let (workflow, created) = created(&fixture);
    let root = fixture
        .root
        .join("state")
        .join(SID)
        .join("home/.reverie-launch");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o777)).unwrap();
    fs::write(root.join("existing"), b"preserve").unwrap();
    assert!(fixture.runtime().publish_laptop_launch(&created).is_err());
    assert_eq!(fs::read(root.join("existing")).unwrap(), b"preserve");
    assert!(
        !fixture
            .root
            .join("state")
            .join(SID)
            .join("runtime.json")
            .exists()
    );
    assert!(
        fixture
            .runtime()
            .start_laptop_container(&created, end())
            .is_err()
    );
    assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
    assert_eq!(trace(&fixture, "start"), 0);
}
#[test]
fn actual_start_nonzero_keeps_started_side_effect_and_all_original_resources() {
    if isolated("actual_start_nonzero_keeps_started_side_effect_and_all_original_resources") {
        return;
    }
    let fixture = Fixture::new("created-start-nonzero");
    let (workflow, created) = created(&fixture);
    fixture.runtime().publish_laptop_launch(&created).unwrap();
    assert!(matches!(
        fixture
            .runtime()
            .start_laptop_container(&created, end())
            .unwrap(),
        ContainerStart::Retained
    ));
    fixture
        .runtime()
        .installed_engine()
        .settle_owned(end())
        .unwrap();
    assert!(fixture.root.join("started-laptop").is_file());
    assert!(fixture.runtime().close(end()).is_err());
    assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
    assert_eq!(trace(&fixture, "start"), 1);
}
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_laptop::tests::publication::{name}"))
}

#[test]
fn actual_consumed_writer_close_refusal_keeps_primary_cause_and_never_retries_the_fd() {
    if isolated("actual_consumed_writer_close_refusal_keeps_primary_cause_and_never_retries_the_fd")
    {
        return;
    }
    for with_primary in [false, true] {
        let fixture = Fixture::new("created-normal");
        let (workflow, created) = created(&fixture);
        if with_primary {
            let victim = fixture.root.join("victim");
            fs::write(&victim, b"unchanged").unwrap();
            fs::hard_link(
                &victim,
                fixture.root.join("state").join(SID).join("runtime.json"),
            )
            .unwrap();
        }
        super::super::publication::test_hooks::refuse_close(if with_primary { 2 } else { 1 });
        assert!(fixture.runtime().publish_laptop_launch(&created).is_err());
        let failure = workflow.failure().unwrap().unwrap();
        if with_primary {
            assert!(
                matches!(failure.as_ref(),LaptopError::Finalization {primary,..} if matches!(primary.as_ref(),LaptopError::Refused("WORKER_LAPTOP_RUNTIME_METADATA_ALIAS")))
            );
            assert_eq!(fs::read(fixture.root.join("victim")).unwrap(), b"unchanged");
        } else {
            assert!(matches!(failure.as_ref(), LaptopError::Observation(_)));
        }
        let closed = super::super::publication::test_hooks::count();
        assert!(fixture.runtime().publish_laptop_launch(&created).is_err());
        assert!(
            fixture
                .runtime()
                .start_laptop_container(&created, end())
                .is_err()
        );
        assert!(fixture.runtime().close(end()).is_err());
        assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
        assert_eq!(super::super::publication::test_hooks::count(), closed);
        assert_eq!(trace(&fixture, "start"), 0);
    }
}

#[test]
fn actual_anchor_and_parent_close_refusals_prevent_publication_ack_and_start() {
    if isolated("actual_anchor_and_parent_close_refusals_prevent_publication_ack_and_start") {
        return;
    }
    // Two source writers, then two pinned file anchors and two held parents.
    for close_number in [3, 4, 5, 6] {
        let fixture = Fixture::new("created-normal");
        let (workflow, created) = created(&fixture);
        super::super::publication::test_hooks::refuse_close(close_number);
        assert!(fixture.runtime().publish_laptop_launch(&created).is_err());
        assert!(workflow.failure().unwrap().is_some());
        assert_eq!(super::super::publication::test_hooks::count(), 6);
        assert!(
            fixture
                .runtime()
                .start_laptop_container(&created, end())
                .is_err()
        );
        assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
        assert!(fixture.runtime().close(end()).is_err());
        assert_eq!(super::super::publication::test_hooks::count(), 6);
        assert_eq!(trace(&fixture, "start"), 0);
    }
}
