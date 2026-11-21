//! Real cgroup2 RO binds and an owned unobservable peer. No host cgroup writes,
//! Docker execution, resource configuration or running employee effects.
use super::*;
use std::process::{Child, Command, Stdio};

fn setup(f: &Fixture, destination: &str, pid: u32) {
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
    other["State"]["Pid"] = json!(pid);
    other["Mounts"][0]["Source"] = json!("/sys/fs/cgroup");
    other["Mounts"][0]["Destination"] = json!(destination);
    let mut listed = inventory(&f.source, &fixture::worker());
    listed.as_array_mut().unwrap().push(json!({"Id":other["Id"],"ImageID":other["Image"],"State":"running","Mounts":other["Mounts"]}));
    f.port.set("/containers/json".into(), listed);
    f.port
        .set(format!("/containers/{}/json", "8".repeat(64)), other);
}
struct Peer(Child);
impl Peer {
    fn spawn() -> Self {
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "service::apply::live_accounts::tests::cgroup_observer::unobservable_peer_child_fixture"])
            .env("NIX_REVERIE_CGROUP_PEER", "1")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let peer = Self(child);
        let end = Instant::now() + Duration::from_secs(5);
        while !Path::new("/tmp/cgroup-peer-ready").exists() {
            assert!(Instant::now() < end, "Owned peer setup timed out");
            std::thread::sleep(Duration::from_millis(5));
        }
        peer
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        self.0.wait().unwrap();
    }
}
#[test]
fn unobservable_peer_child_fixture() {
    if std::env::var_os("NIX_REVERIE_CGROUP_PEER").is_some() {
        nix::sys::prctl::set_dumpable(false).unwrap();
        std::fs::write("/tmp/cgroup-peer-ready", "ready").unwrap();
        std::thread::sleep(Duration::from_secs(30));
    }
}
#[test]
#[ignore = "requires real host cgroup2; mandatory Rust CI cgroup observer qualification"]
fn actual_virtual_filesystem_proof_does_not_require_target_root_or_namespace_symlink_access() {
    namespace(
        "cgroup_observer::actual_virtual_filesystem_proof_does_not_require_target_root_or_namespace_symlink_access",
        || {
            let f = Fixture::live_accounts();
            let peer = Peer::spawn();
            let pid = peer.0.id();
            assert_eq!(
                std::fs::metadata(format!("/proc/{pid}/root"))
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::PermissionDenied
            );
            assert_eq!(
                std::fs::read_link(format!("/proc/{pid}/ns/mnt"))
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::PermissionDenied
            );
            assert!(
                std::fs::read_to_string(format!("/proc/{pid}/mountinfo"))
                    .unwrap()
                    .contains(" - cgroup2 ")
            );
            setup(&f, "/virtual-cgroup", pid);
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
            drop(peer);
            f.close();
        },
    );
}
#[test]
#[ignore = "requires real host cgroup2; mandatory Rust CI cgroup observer qualification"]
fn cgroup_named_source_never_relabels_a_retained_regular_data_bind() {
    namespace(
        "cgroup_observer::cgroup_named_source_never_relabels_a_retained_regular_data_bind",
        || {
            let f = Fixture::live_accounts();
            setup(&f, "/other-writer", std::process::id());
            let result = f.service.preview_live_accounts_fix_forward(
                &format!("sha256:{}", "f".repeat(64)),
                model::DeploymentProfile::Ordinary,
            );
            assert_eq!(
                result.err().unwrap().code(),
                "DEPLOYMENT_CGROUP_BIND_UNCONFIRMED"
            );
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}
#[test]
#[ignore = "requires real host cgroup2; mandatory Rust CI cgroup observer qualification"]
fn a_regular_file_overlay_beneath_the_real_cgroup_mount_refuses() {
    namespace(
        "cgroup_observer::a_regular_file_overlay_beneath_the_real_cgroup_mount_refuses",
        || {
            let f = Fixture::live_accounts();
            let kernel = std::fs::read_to_string("/proc/self/mountinfo").unwrap();
            assert!(
                kernel
                    .lines()
                    .any(|row| row.contains(" /hidden-run/cgroup ") && row.contains(" - cgroup2 "))
            );
            for destination in ["/virtual-cgroup-overlay", "/hidden-run/cgroup"] {
                setup(&f, destination, std::process::id());
                let result = f.service.preview_live_accounts_fix_forward(
                    &format!("sha256:{}", "f".repeat(64)),
                    model::DeploymentProfile::Ordinary,
                );
                assert_eq!(
                    result.err().unwrap().code(),
                    "DEPLOYMENT_CGROUP_BIND_UNCONFIRMED"
                );
            }
            assert!(!f.port.calls().iter().any(|call| call.starts_with("POST ")));
            f.close();
        },
    );
}
