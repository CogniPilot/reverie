//! The bootstrap selector must refuse a live/foreign predecessor before any
//! selection write. The native capture fixture never invokes the user manager.
use super::*;
#[test]
fn installed_generation_must_be_inactive_and_exact_before_replacement() {
    let old=Path::new("/nix/store/old-worker/share/systemd/user/reverie-worker-broker.service");
    assert!(ObservedUnit::decode("loaded\ninactive\ndead\n/nix/store/old-worker/share/systemd/user/reverie-worker-broker.service\n").unwrap().require_replaceable(Some(old)).is_ok());
    for raw in ["loaded\nactive\nrunning\n/nix/store/old-worker/share/systemd/user/reverie-worker-broker.service\n", "loaded\ninactive\ndead\n/etc/systemd/user/foreign.service\n"] {
        assert!(ObservedUnit::decode(raw).unwrap().require_replaceable(Some(old)).is_err());
    }
    assert!(ObservedUnit::decode("not-found\ninactive\ndead\n\n").unwrap().require_replaceable(None).is_ok());
}
#[test]
fn selection_environment_is_exact_and_cannot_inject_unit_directives() {
    assert_eq!(environment(Path::new("/home/owner/reverie/worker.json")).unwrap(),"REVERIE_WORKER_CONFIG=\"/home/owner/reverie/worker.json\"\n");
    for value in ["relative", "/home/owner/reverie/a\nb", "/home/owner/reverie/a\rb"] { assert!(environment(Path::new(value)).is_err()); }
}
