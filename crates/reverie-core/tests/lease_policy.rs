use reverie_core::ids::ProfileEmployeeId;
use reverie_core::lease_policy::{
    LeaseAbsolutePath as Absolute, LeaseAcceptance, LeaseControlContext, LeaseMountView,
    LeasePolicyError, LeaseRelativePath as Relative, PeerMachine, static_peer_elf,
};
fn path(value: &str) -> Absolute {
    Absolute::from_scalar_text(value).unwrap()
}
#[test]
fn path_types_preserve_posix_policy_including_dot_del_and_non_scalar_text() {
    for value in ["/", "/nix/store/peer", "/é/😀", "/file\u{7f}"] {
        assert!(Absolute::from_scalar_text(value).is_ok());
    }
    for value in [
        "", "relative", "//host/a", "/a//b", "/a/./b", "/a/../b", "/a/", "/a\n",
    ] {
        assert!(Absolute::from_scalar_text(value).is_err(), "{value:?}");
    }
    for value in [".", "leases", ".local/state/leases", "a\u{7f}"] {
        assert!(Relative::from_scalar_text(value).is_ok());
    }
    for value in [
        "",
        "..",
        "../leases",
        "a/../b",
        "/absolute",
        "./a",
        "a//b",
        "a/",
        "a\n",
    ] {
        assert!(Relative::from_scalar_text(value).is_err(), "{value:?}");
    }
    let surrogate = Absolute::try_new(vec![47, 0xd800]).unwrap();
    assert_eq!(surrogate.scalar_text(), None);
    assert_eq!(surrogate.codepoints(), &[47, 0xd800]);
    assert_eq!(path("/a").parent(), path("/"));
    assert_eq!(path("/a/b").parent(), path("/a"));
    assert!(path("/a/b").is_relative_to(&path("/a")));
    assert!(!path("/ab").is_relative_to(&path("/a")));
}
#[test]
fn layout_checks_are_pure_and_nil_employee_is_canonical() {
    let employee = ProfileEmployeeId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    let broker: Vec<_> = "/host/state/broker.sock".chars().map(u32::from).collect();
    let context = LeaseControlContext::try_new(path("/host/state"), &broker, true).unwrap();
    let accepted = LeaseAcceptance::try_new(
        path("/host/state/peer/peer.sock"),
        employee.clone(),
        Relative::from_scalar_text(".").unwrap(),
        path("/nix/store/peer"),
        &context,
        &[],
    )
    .unwrap();
    assert_eq!(accepted.employee(), &employee);
    for socket in [
        "/host/state/p.sock",
        "/host/state/employees/a/p.sock",
        "/host/state-other/peer/p.sock",
    ] {
        assert!(
            LeaseAcceptance::try_new(
                path(socket),
                employee.clone(),
                Relative::from_scalar_text(".").unwrap(),
                path("/nix/store/peer"),
                &context,
                &[]
            )
            .is_err()
        );
    }
    let mount = LeaseMountView::new(path("/nix/store/peer/sub"), path("/workspace"));
    assert_eq!(
        LeaseAcceptance::try_new(
            accepted.socket().clone(),
            employee,
            accepted.subdirectory().clone(),
            accepted.peer_binary().clone(),
            &context,
            &[mount]
        ),
        Err(LeasePolicyError::ArtifactAlias)
    );
}
#[test]
fn elf_check_refuses_overflow_and_checks_each_header_without_execution() {
    let mut bytes = vec![0; 176];
    bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
    bytes[16..18].copy_from_slice(&2_u16.to_le_bytes());
    bytes[18..20].copy_from_slice(&62_u16.to_le_bytes());
    bytes[32..40].copy_from_slice(&64_u64.to_le_bytes());
    bytes[54..56].copy_from_slice(&56_u16.to_le_bytes());
    bytes[56..58].copy_from_slice(&2_u16.to_le_bytes());
    let observed = static_peer_elf(&bytes, PeerMachine::X86_64).unwrap();
    assert_eq!(observed.program_headers(), 2);
    assert!(static_peer_elf(&bytes, PeerMachine::Aarch64).is_err());
    bytes[120..124].copy_from_slice(&3_u32.to_le_bytes());
    assert_eq!(
        static_peer_elf(&bytes, PeerMachine::X86_64),
        Err(LeasePolicyError::DynamicElf)
    );
    bytes[32..40].copy_from_slice(&u64::MAX.to_le_bytes());
    assert_eq!(
        static_peer_elf(&bytes, PeerMachine::X86_64),
        Err(LeasePolicyError::ElfHeaders)
    );
}
