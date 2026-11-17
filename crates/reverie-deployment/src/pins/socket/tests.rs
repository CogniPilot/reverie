use super::*;
use std::os::unix::{
    fs::{PermissionsExt, symlink},
    net::UnixListener,
};
fn namespace(test: &str, scenario: fn()) {
    crate::test_namespace::run(&format!("pins::socket::tests::{test}"), scenario);
}
fn listener() -> UnixListener {
    symlink("/run", "/var/run").unwrap();
    let listener = UnixListener::bind(CANONICAL).unwrap();
    fs::set_permissions(CANONICAL, fs::Permissions::from_mode(0o660)).unwrap();
    listener
}
#[test]
fn fixed_root_socket_is_pinned_without_connecting_and_proc_root_join_is_exact() {
    namespace(
        "fixed_root_socket_is_pinned_without_connecting_and_proc_root_join_is_exact",
        || {
            let _listener = listener();
            let held = EngineSocket::capture(Path::new(ALIAS), DESTINATION).unwrap();
            let canonical = EngineSocket::capture(Path::new(CANONICAL), DESTINATION).unwrap();
            assert_eq!(
                held.identity().unwrap().inode,
                canonical.identity().unwrap().inode
            );
            assert_eq!(held.identity().unwrap().uid, 0);
            fs::create_dir("/run/reverie-engine").unwrap();
            fs::hard_link(CANONICAL, DESTINATION).unwrap();
            let source = serde_json::json!({"State":{"Pid":std::process::id()},"Mounts":[{
                "Type":"bind","Source":ALIAS,"Destination":DESTINATION,"RW":false
            }]});
            let pins = super::super::Pins::capture(&source).unwrap();
            pins.running_mounts(&source).unwrap();
            let saved: Vec<Identity> =
                serde_json::from_slice(&serde_json::to_vec(&pins.identities()).unwrap()).unwrap();
            pins.matches(&saved).unwrap();
            let mut changed = pins.identities();
            changed[0].gid ^= 1;
            assert!(pins.matches(&changed).is_err());
            pins.matches(&pins.identities()).unwrap();
            pins.close().unwrap();
            fs::write("/run/ordinary", "retained regular bind").unwrap();
            let ordinary =
                super::super::Anchor::capture(Path::new("/run/ordinary"), "/ordinary", true)
                    .unwrap();
            ordinary.verify().unwrap();
            ordinary.close().unwrap();
            held.inside(Path::new("/proc/self/root/run/reverie-engine/docker.sock"))
                .unwrap();
            let _foreign = UnixListener::bind("/run/reverie-engine/foreign.sock").unwrap();
            assert!(
                held.inside(Path::new("/proc/self/root/run/reverie-engine/foreign.sock"))
                    .is_err()
            );
            canonical.close().unwrap();
            held.close().unwrap();
        },
    );
}
#[test]
fn actual_socket_replacement_cannot_reuse_the_held_inode() {
    namespace(
        "actual_socket_replacement_cannot_reuse_the_held_inode",
        || {
            let _old = listener();
            let held = EngineSocket::capture(Path::new(ALIAS), DESTINATION).unwrap();
            fs::remove_file(CANONICAL).unwrap();
            let _new = UnixListener::bind(CANONICAL).unwrap();
            fs::set_permissions(CANONICAL, fs::Permissions::from_mode(0o660)).unwrap();
            assert!(held.verify().is_err());
            held.close().unwrap();
        },
    );
}
#[test]
fn socket_permission_drift_and_alias_replacement_refuse() {
    namespace(
        "socket_permission_drift_and_alias_replacement_refuse",
        || {
            let _listener = listener();
            fs::set_permissions(CANONICAL, fs::Permissions::from_mode(0o666)).unwrap();
            assert!(EngineSocket::capture(Path::new(ALIAS), DESTINATION).is_err());
            fs::set_permissions(CANONICAL, fs::Permissions::from_mode(0o660)).unwrap();
            let held = EngineSocket::capture(Path::new(ALIAS), DESTINATION).unwrap();
            fs::set_permissions(CANONICAL, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(held.verify().is_err());
            fs::set_permissions(CANONICAL, fs::Permissions::from_mode(0o660)).unwrap();
            fs::remove_file("/var/run").unwrap();
            fs::create_dir("/var/foreign").unwrap();
            symlink("/var/foreign", "/var/run").unwrap();
            assert!(held.verify().is_err());
            held.close().unwrap();
        },
    );
}
#[test]
fn no_writable_destination_or_generic_socket_exception_is_granted() {
    namespace(
        "no_writable_destination_or_generic_socket_exception_is_granted",
        || {
            let _listener = listener();
            assert!(super::super::Anchor::capture(Path::new(ALIAS), DESTINATION, false).is_err());
            assert!(EngineSocket::capture(Path::new(ALIAS), "/foreign/docker.sock").is_err());
            let _foreign = UnixListener::bind("/run/foreign.sock").unwrap();
            assert!(
                super::super::Anchor::capture(Path::new("/run/foreign.sock"), DESTINATION, true)
                    .is_err()
            );
            assert!(
                super::super::Anchor::capture(
                    Path::new("/run/foreign.sock"),
                    "/foreign.sock",
                    true
                )
                .is_err()
            );
        },
    );
}
#[test]
fn regular_files_symlinked_leaf_and_writable_ancestors_are_refused() {
    namespace(
        "regular_files_symlinked_leaf_and_writable_ancestors_are_refused",
        || {
            symlink("/run", "/var/run").unwrap();
            fs::write(CANONICAL, "not a socket").unwrap();
            assert!(EngineSocket::capture(Path::new(ALIAS), DESTINATION).is_err());
            fs::remove_file(CANONICAL).unwrap();
            let _foreign = UnixListener::bind("/run/foreign.sock").unwrap();
            symlink("/run/foreign.sock", CANONICAL).unwrap();
            assert!(EngineSocket::capture(Path::new(ALIAS), DESTINATION).is_err());
            fs::remove_file(CANONICAL).unwrap();
            let _real = UnixListener::bind(CANONICAL).unwrap();
            fs::set_permissions(CANONICAL, fs::Permissions::from_mode(0o660)).unwrap();
            fs::set_permissions("/run", fs::Permissions::from_mode(0o777)).unwrap();
            assert!(EngineSocket::capture(Path::new(ALIAS), DESTINATION).is_err());
        },
    );
}
