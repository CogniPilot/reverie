//! Actual service/transport, controlled observations only; no real Docker.
use super::*;
use crate::service::rollback::network_tests::fixture::{self, Fixture};

fn namespace(test: &str, scenario: fn()) {
    crate::test_namespace::run(
        &format!("service::apply::live_accounts::tests::{test}"),
        scenario,
    );
}
fn inventory(source: &Value, worker: &Value) -> Value {
    json!([
        {"Id":"a".repeat(64),"State":"running","ImageID":source["Image"],"Mounts":source["Mounts"]},
        {"Id":"d".repeat(64),"State":"running","ImageID":worker["Image"],"Mounts":worker["Mounts"]}
    ])
}

#[test]
fn actual_preview_issues_only_the_full_version_five_disposition_tuple() {
    namespace(
        "actual_preview_issues_only_the_full_version_five_disposition_tuple",
        || {
            let f = Fixture::live_accounts();
            f.port
                .set("/containers/fixture/json".into(), f.source.clone());
            for letter in ['e', 'f'] {
                let image = fixture::image(letter);
                f.port.set(
                    format!("/images/{}/json", image["Id"].as_str().unwrap()),
                    image,
                );
            }
            let preview = f
                .service
                .preview_live_accounts_fix_forward(
                    &format!("sha256:{}", "f".repeat(64)),
                    model::DeploymentProfile::Ordinary,
                )
                .unwrap();
            let operation = f.service.effect_operation(&preview.operation).unwrap();
            assert_eq!(operation.plan.version, 5);
            assert!(
                operation.plan.live_account_writers.is_some()
                    && operation.plan.network_topology.is_some()
            );
            let disposition = preview.live_accounts.unwrap();
            assert_eq!(disposition.policy, "live-accounts-fix-forward");
            assert_eq!(disposition.writers.len(), 1);
            assert_eq!(disposition.writers[0].container_id, "d".repeat(64));
            assert!(!disposition.code_rollback_guaranteed && !disposition.automatic_data_restore);
            let public = serde_json::to_string(&disposition).unwrap();
            assert!(!public.contains("FAKE_PRIVATE") && !public.contains("existing-provider"));
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}

#[test]
fn fresh_preview_refuses_an_actual_inside_root_retaining_the_older_account_directory() {
    namespace(
        "fresh_preview_refuses_an_actual_inside_root_retaining_the_older_account_directory",
        || {
            let f = Fixture::live_accounts();
            let accounts = Path::new("/tmp/deployment/data/console/accounts");
            std::fs::rename(accounts.join("profile"), accounts.join("retained-old")).unwrap();
            std::fs::create_dir(accounts.join("profile")).unwrap();
            f.port
                .set("/containers/fixture/json".into(), f.source.clone());
            for letter in ['e', 'f'] {
                let image = fixture::image(letter);
                f.port.set(
                    format!("/images/{}/json", image["Id"].as_str().unwrap()),
                    image,
                );
            }
            let result = f.service.preview_live_accounts_fix_forward(
                &format!("sha256:{}", "f".repeat(64)),
                model::DeploymentProfile::Ordinary,
            );
            assert_eq!(
                result.err().unwrap().code(),
                "DEPLOYMENT_LIVE_ACCOUNT_BIND_CHANGED"
            );
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}

#[test]
fn fresh_preview_never_adopts_leaf_or_ancestor_aliases_under_the_writer_root() {
    namespace(
        "fresh_preview_never_adopts_leaf_or_ancestor_aliases_under_the_writer_root",
        || {
            let f = Fixture::live_accounts();
            f.port
                .set("/containers/fixture/json".into(), f.source.clone());
            for letter in ['e', 'f'] {
                let image = fixture::image(letter);
                f.port.set(
                    format!("/images/{}/json", image["Id"].as_str().unwrap()),
                    image,
                );
            }
            std::os::unix::fs::symlink(
                "/tmp/deployment/data/console/accounts/profile",
                "/accounts/leaf-alias",
            )
            .unwrap();
            std::os::unix::fs::symlink(
                "/tmp/deployment/data/console/accounts",
                "/accounts/ancestor-alias",
            )
            .unwrap();
            for destination in ["/accounts/leaf-alias", "/accounts/ancestor-alias/profile"] {
                let mut worker = fixture::worker();
                worker["Mounts"][0]["Destination"] = json!(destination);
                f.port
                    .set("/containers/json".into(), inventory(&f.source, &worker));
                f.port
                    .set(format!("/containers/{}/json", "d".repeat(64)), worker);
                let result = f.service.preview_live_accounts_fix_forward(
                    &format!("sha256:{}", "f".repeat(64)),
                    model::DeploymentProfile::Ordinary,
                );
                assert_eq!(
                    result.err().unwrap().code(),
                    "DEPLOYMENT_LIVE_ACCOUNT_BIND_CHANGED",
                    "{destination}"
                );
            }
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}

#[test]
fn known_writer_epoch_is_reobserved_after_the_final_active_census() {
    namespace(
        "known_writer_epoch_is_reobserved_after_the_final_active_census",
        || {
            let f = Fixture::live_accounts();
            let mut changed = fixture::worker();
            changed["Config"]["Cmd"] = json!(["changed-after-census"]);
            f.port.set_sequence(
                format!("/containers/{}/json", "d".repeat(64)),
                vec![fixture::worker(), fixture::worker(), changed],
            );
            let result = f.service.verify_live_account_writers(&f.operation);
            assert!(result.is_err());
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}

#[test]
fn another_retained_console_writer_never_becomes_disjoint_after_its_source_alias_is_replaced() {
    namespace(
        "another_retained_console_writer_never_becomes_disjoint_after_its_source_alias_is_replaced",
        || {
            let f = Fixture::live_accounts();
            f.port
                .set("/containers/fixture/json".into(), f.source.clone());
            for letter in ['e', 'f'] {
                let image = fixture::image(letter);
                f.port.set(
                    format!("/images/{}/json", image["Id"].as_str().unwrap()),
                    image,
                );
            }
            // Bwrap bound the original Source alias to the real console before the
            // child replaced that alias with a new disjoint directory. The second
            // peer still has the original console inode at /other-writer.
            let mut other = fixture::worker();
            other["Id"] = json!("8".repeat(64));
            other["Mounts"][0]["Source"] = json!("/tmp/deployment/data/disjoint-source");
            other["Mounts"][0]["Destination"] = json!("/other-writer");
            let mut listed = inventory(&f.source, &fixture::worker());
            listed.as_array_mut().unwrap().push(json!({"Id":other["Id"],"ImageID":other["Image"],"State":"running","Mounts":other["Mounts"]}));
            f.port.set("/containers/json".into(), listed);
            f.port
                .set(format!("/containers/{}/json", "8".repeat(64)), other);
            let result = f.service.preview_live_accounts_fix_forward(
                &format!("sha256:{}", "f".repeat(64)),
                model::DeploymentProfile::Ordinary,
            );
            assert_eq!(
                result.err().unwrap().code(),
                "DEPLOYMENT_LIVE_ACCOUNT_BIND_CHANGED"
            );
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}

#[test]
fn current_host_bind_aliases_and_nested_mounts_never_become_disjoint_writers() {
    namespace(
        "current_host_bind_aliases_and_nested_mounts_never_become_disjoint_writers",
        || {
            let f = Fixture::live_accounts();
            std::fs::create_dir("/tmp/deployment/data/console/metadata").unwrap();
            f.port
                .set("/containers/fixture/json".into(), f.source.clone());
            for letter in ['e', 'f'] {
                let image = fixture::image(letter);
                f.port.set(
                    format!("/images/{}/json", image["Id"].as_str().unwrap()),
                    image,
                );
            }
            for source in [
                "/other-writer",
                "/other-writer/metadata",
                "/instances/default",
                "/accounts",
            ] {
                let mut other = fixture::worker();
                other["Id"] = json!("8".repeat(64));
                other["Mounts"][0]["Source"] = json!(source);
                other["Mounts"][0]["Destination"] = json!(source);
                let mut listed = inventory(&f.source, &fixture::worker());
                listed.as_array_mut().unwrap().push(json!({"Id":other["Id"],"ImageID":other["Image"],"State":"running","Mounts":other["Mounts"]}));
                f.port.set("/containers/json".into(), listed);
                f.port
                    .set(format!("/containers/{}/json", "8".repeat(64)), other);
                let result = f.service.preview_live_accounts_fix_forward(
                    &format!("sha256:{}", "f".repeat(64)),
                    model::DeploymentProfile::Ordinary,
                );
                assert_eq!(
                    result.err().unwrap().code(),
                    "DEPLOYMENT_LIVE_ACCOUNT_HOST_MOUNT_UNSUPPORTED",
                    "{source}"
                );
            }
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}

#[test]
fn genuinely_disjoint_other_filesystem_writer_keeps_the_account_only_disposition() {
    namespace(
        "genuinely_disjoint_other_filesystem_writer_keeps_the_account_only_disposition",
        || {
            let f = Fixture::live_accounts();
            std::fs::create_dir("/run/disjoint-dir").unwrap();
            f.port
                .set("/containers/fixture/json".into(), f.source.clone());
            for letter in ['e', 'f'] {
                let image = fixture::image(letter);
                f.port.set(
                    format!("/images/{}/json", image["Id"].as_str().unwrap()),
                    image,
                );
            }
            let mut other = fixture::worker();
            other["Id"] = json!("8".repeat(64));
            other["Mounts"][0]["Source"] = json!("/run/disjoint-dir");
            other["Mounts"][0]["Destination"] = json!("/run/disjoint-dir");
            let mut listed = inventory(&f.source, &fixture::worker());
            listed.as_array_mut().unwrap().push(json!({"Id":other["Id"],"ImageID":other["Image"],"State":"running","Mounts":other["Mounts"]}));
            f.port.set("/containers/json".into(), listed);
            f.port
                .set(format!("/containers/{}/json", "8".repeat(64)), other);
            let preview = f
                .service
                .preview_live_accounts_fix_forward(
                    &format!("sha256:{}", "f".repeat(64)),
                    model::DeploymentProfile::Ordinary,
                )
                .unwrap();
            let approved = preview.live_accounts.unwrap().writers;
            assert_eq!(approved.len(), 1);
            assert_eq!(approved[0].container_id, "d".repeat(64));
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}

#[test]
fn live_copy_is_explicitly_unverified_and_precedes_the_single_website_stop() {
    namespace(
        "live_copy_is_explicitly_unverified_and_precedes_the_single_website_stop",
        || {
            let f = Fixture::live_accounts();
            std::fs::write("/tmp/deployment/data/console/retained-marker", "owned-data").unwrap();
            let result = f.service.apply(&f.operation.plan.operation);
            // The controlled port refuses all mutation requests; this is ordering
            // qualification, never a fabricated stopped/ready container receipt.
            if option_env!("REVERIE_DEPLOYMENT_COPY").is_some() {
                assert_eq!(result.err().unwrap().code(), "DEPLOYMENT_ENGINE_REFUSED");
                assert_eq!(
                    std::fs::read_to_string(
                        f.operation.directory.join("retained-copy/retained-marker")
                    )
                    .unwrap(),
                    "owned-data"
                );
                assert_eq!(f.operation.status().unwrap().backup_verified, Some(false));
                let posts: Vec<_> = f
                    .port
                    .calls()
                    .into_iter()
                    .filter(|call| call.starts_with("POST "))
                    .collect();
                assert_eq!(
                    posts,
                    vec![format!("POST /containers/{}/stop?t=30", "a".repeat(64))]
                );
                assert!(f.operation.exists("stop-attempt"));
            } else {
                assert_eq!(result.err().unwrap().code(), "DEPLOYMENT_COPY_UNINSTALLED");
                assert!(!f.operation.exists("stop-attempt"));
            }
            assert!(!f.operation.exists("started") && !f.operation.exists("ready"));
            f.close();
        },
    );
}

#[test]
fn bounded_copy_child_fixture() {
    if std::env::var_os("NIX_REVERIE_DEPLOYMENT_COPY_SLEEP").is_some() {
        std::thread::sleep(Duration::from_secs(10));
    }
}

#[test]
fn version_five_disposition_cannot_be_downgraded_or_partially_stripped() {
    namespace(
        "version_five_disposition_cannot_be_downgraded_or_partially_stripped",
        || {
            let f = Fixture::live_accounts();
            let path = f.operation.directory.join("plan.json");
            let original = std::fs::read(&path).unwrap();
            let original_value: Value = serde_json::from_slice(&original).unwrap();
            assert_eq!(
                f.service
                    .effect_operation(&f.operation.plan.operation)
                    .unwrap()
                    .plan
                    .version,
                5
            );
            for fault in ["v4", "writers", "networks", "preview", "policy"] {
                let mut value = original_value.clone();
                match fault {
                    "v4" => value["version"] = json!(4),
                    "writers" => value
                        .as_object_mut()
                        .unwrap()
                        .remove("live_account_writers")
                        .map(|_| ())
                        .unwrap(),
                    "networks" => value
                        .as_object_mut()
                        .unwrap()
                        .remove("network_topology")
                        .map(|_| ())
                        .unwrap(),
                    "preview" => value["preview"]
                        .as_object_mut()
                        .unwrap()
                        .remove("live_accounts")
                        .map(|_| ())
                        .unwrap(),
                    "policy" => value["preview"]["live_accounts"]["policy"] = json!("skip-backup"),
                    _ => unreachable!(),
                }
                std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
                assert!(
                    f.service
                        .effect_operation(&f.operation.plan.operation)
                        .is_err(),
                    "{fault}"
                );
            }
            std::fs::write(path, original).unwrap();
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}

#[test]
fn writer_change_after_retained_copy_refuses_before_the_website_stop() {
    namespace(
        "writer_change_after_retained_copy_refuses_before_the_website_stop",
        || {
            let f = Fixture::live_accounts();
            let original = inventory(&f.source, &fixture::worker());
            let mut changed = original.clone();
            changed[1]["Mounts"][0]["Destination"] = json!("/different");
            let mut worker = fixture::worker();
            worker["Mounts"] = changed[1]["Mounts"].clone();
            f.port.set_sequence(
                "/containers/json".into(),
                vec![
                    original.clone(),
                    original.clone(),
                    original.clone(),
                    original,
                    changed,
                ],
            );
            let mut observed = vec![fixture::worker(); 8];
            observed.push(worker);
            f.port
                .set_sequence(format!("/containers/{}/json", "d".repeat(64)), observed);
            let result = f.service.apply(&f.operation.plan.operation);
            assert!(result.is_err());
            assert!(!f.operation.exists("stop-attempt"));
            if option_env!("REVERIE_DEPLOYMENT_COPY").is_some() {
                assert!(f.operation.exists("unverified-backup-accepted"));
                assert_eq!(f.operation.status().unwrap().backup_verified, Some(false));
            }
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}

#[test]
fn final_ready_writer_rechecks_the_approved_employee_inventory() {
    namespace(
        "final_ready_writer_rechecks_the_approved_employee_inventory",
        || {
            let f = Fixture::live_accounts();
            let mut stopped = f.source.clone();
            stopped["State"]["Running"] = json!(false);
            stopped["State"]["Pid"] = json!(0);
            f.port
                .set(format!("/containers/{}/json", "a".repeat(64)), stopped);
            let mut running = f.source.clone();
            running["Id"] = json!("b".repeat(64));
            running["Image"] = f.operation.plan.body["Image"].clone();
            let mut config = f.operation.plan.body.clone();
            config.as_object_mut().unwrap().remove("HostConfig");
            config.as_object_mut().unwrap().remove("NetworkingConfig");
            running["Config"] = config;
            running["HostConfig"] = f.operation.plan.body["HostConfig"].clone();
            f.port
                .set(format!("/containers/{}/json", "b".repeat(64)), running);
            let mut worker = fixture::worker();
            worker["Config"]["Cmd"] = json!(["changed"]);
            f.port
                .set(format!("/containers/{}/json", "d".repeat(64)), worker);
            let pins = f.service.pins(&f.operation).unwrap();
            let result = f.service.publish_ready(
                &f.operation,
                &"b".repeat(64),
                &pins,
                OperationDeadline::Ordinary,
            );
            assert_eq!(
                result.err().unwrap().code(),
                "DEPLOYMENT_LIVE_ACCOUNT_WRITERS_CHANGED"
            );
            assert!(!f.operation.exists("ready"));
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            pins.close().unwrap();
            f.close();
        },
    );
}

#[test]
fn expired_copy_deadline_joins_the_original_child_without_swap() {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child
        .args([
            "--exact",
            "service::apply::live_accounts::tests::bounded_copy_child_fixture",
        ])
        .env("NIX_REVERIE_DEPLOYMENT_COPY_SLEEP", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = child.spawn().unwrap();
    let pid = child.id();
    assert_eq!(
        join_copy(child, Instant::now()).unwrap_err().code(),
        "DEPLOYMENT_RETAINED_COPY_DEADLINE"
    );
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
}

#[test]
fn default_preview_still_refuses_the_exact_live_account_writer() {
    namespace(
        "default_preview_still_refuses_the_exact_live_account_writer",
        || {
            let f = Fixture::live_accounts();
            f.port
                .set("/containers/fixture/json".into(), f.source.clone());
            let result = f.service.preview_preserving_networks(
                &format!("sha256:{}", "f".repeat(64)),
                model::DeploymentProfile::Ordinary,
            );
            assert_eq!(
                result.err().unwrap().code(),
                "DEPLOYMENT_SHARED_WRITABLE_MOUNT"
            );
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}

#[test]
fn fresh_inventory_detects_new_writer_and_full_original_identity_drift() {
    namespace(
        "fresh_inventory_detects_new_writer_and_full_original_identity_drift",
        || {
            let f = Fixture::live_accounts();
            f.service.verify_live_account_writers(&f.operation).unwrap();
            let original = fixture::worker();
            for path in ["pid", "image", "command", "mount", "new-writer"] {
                let mut worker = original.clone();
                let mut listed = inventory(&f.source, &original);
                match path {
                    "pid" => worker["State"]["Pid"] = json!(43),
                    "image" => {
                        worker["Image"] = json!(format!("sha256:{}", "9".repeat(64)));
                        listed[1]["ImageID"] = worker["Image"].clone();
                    }
                    "command" => worker["Config"]["Cmd"] = json!(["changed"]),
                    "mount" => {
                        worker["Mounts"][0]["Destination"] = json!("/different");
                        listed[1]["Mounts"] = worker["Mounts"].clone();
                    }
                    "new-writer" => {
                        let mut extra = listed[1].clone();
                        extra["Id"] = json!("8".repeat(64));
                        listed.as_array_mut().unwrap().push(extra);
                        f.port.set(
                            format!("/containers/{}/json", "8".repeat(64)),
                            worker.clone(),
                        );
                    }
                    _ => unreachable!(),
                }
                f.port.set("/containers/json".into(), listed);
                f.port
                    .set(format!("/containers/{}/json", "d".repeat(64)), worker);
                assert!(
                    f.service.verify_live_account_writers(&f.operation).is_err(),
                    "{path}"
                );
            }
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}

#[test]
fn changed_writer_refuses_actual_prepare_before_create_attempt() {
    namespace(
        "changed_writer_refuses_actual_prepare_before_create_attempt",
        || {
            let f = Fixture::live_accounts();
            std::fs::remove_file(
                f.service
                    .installation
                    .state
                    .join("console-deployment-active.json"),
            )
            .unwrap();
            let mut worker = fixture::worker();
            worker["State"]["StartedAt"] = json!("later");
            f.port
                .set(format!("/containers/{}/json", "d".repeat(64)), worker);
            let result = f.service.prepare(&f.operation.plan.operation);
            assert_eq!(
                result.err().unwrap().code(),
                "DEPLOYMENT_LIVE_ACCOUNT_WRITERS_CHANGED"
            );
            assert!(!f.operation.exists("create-attempt"));
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}

#[test]
fn changed_writer_refuses_actual_apply_before_copy_or_website_stop() {
    namespace(
        "changed_writer_refuses_actual_apply_before_copy_or_website_stop",
        || {
            let f = Fixture::live_accounts();
            let mut worker = fixture::worker();
            worker["Config"]["Cmd"] = json!(["changed"]);
            f.port
                .set(format!("/containers/{}/json", "d".repeat(64)), worker);
            let result = f.service.apply(&f.operation.plan.operation);
            assert_eq!(
                result.err().unwrap().code(),
                "DEPLOYMENT_LIVE_ACCOUNT_WRITERS_CHANGED"
            );
            assert!(
                !f.operation.exists("stop-attempt") && !f.operation.exists("retained-copy-attempt")
            );
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}

#[test]
fn second_census_refuses_writer_drift_after_rename_before_candidate_start() {
    namespace(
        "second_census_refuses_writer_drift_after_rename_before_candidate_start",
        || {
            let f = Fixture::live_accounts();
            let mut stopped = f.source.clone();
            stopped["State"]["Running"] = json!(false);
            stopped["State"]["Pid"] = json!(0);
            f.port
                .set(format!("/containers/{}/json", "a".repeat(64)), stopped);
            let original = inventory(&f.source, &fixture::worker());
            let mut changed = original.clone();
            changed[1]["Mounts"][0]["Destination"] = json!("/different");
            let mut worker = fixture::worker();
            worker["Mounts"] = changed[1]["Mounts"].clone();
            // First two samples qualify the initial swap boundary; the later
            // census disagrees with the physically re-read retained writer.
            f.port.set_sequence(
                "/containers/json".into(),
                vec![original.clone(), original, changed],
            );
            // Keep the first worker observation original, then change its binding.
            let mut observed = vec![fixture::worker(); 4];
            observed.push(worker);
            f.port
                .set_sequence(format!("/containers/{}/json", "d".repeat(64)), observed);
            for (id, name) in [
                (
                    "a".repeat(64),
                    crate::service::temporary_name(&f.operation, "before-front"),
                ),
                ("b".repeat(64), "fixture".into()),
            ] {
                f.port.set(
                    format!("POST /containers/{id}/rename?name={name}"),
                    Value::Null,
                );
            }
            let pins = f.service.pins(&f.operation).unwrap();
            let result = f.service.swap_scoped(
                &f.operation,
                &"b".repeat(64),
                &pins,
                OperationDeadline::Ordinary,
            );
            assert!(result.is_err());
            let calls = f.port.calls();
            assert_eq!(
                calls
                    .iter()
                    .filter(|call| call.contains("/rename?"))
                    .count(),
                2,
                "{calls:?}"
            );
            assert!(
                !calls.iter().any(|call| call.contains("/start")),
                "{calls:?}"
            );
            assert!(!f.operation.exists("started") && !f.operation.exists("ready"));
            pins.close().unwrap();
            f.close();
        },
    );
}
