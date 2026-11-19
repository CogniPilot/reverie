use super::{Target, checked_address};
use std::net::{Ipv6Addr, SocketAddr, SocketAddrV6};

#[test]
fn only_credential_free_https_targets_on_port_443_are_valid() {
    let url = Target::parse("https://BÜCHER.example:443?article=1").unwrap();
    assert_eq!(url.host, "xn--bcher-kva.example");
    assert_eq!(url.path.as_str(), "/?article=1");
    assert_eq!(
        Target::parse("https://[2606:4700:4700::1111]")
            .unwrap()
            .authority,
        "[2606:4700:4700::1111]"
    );
    for invalid in [
        "file:///etc/passwd",
        "http://example.com",
        "https://u:p@example.com",
        "https://example.com:444/",
        "https://example.com/#fragment",
        "https://",
        "https://example.com/\r\nHeader:x",
        "https://example.com\\x",
        "https://[fe80::1%eth0]",
        "https://[]",
    ] {
        assert!(Target::parse(invalid).is_none(), "{invalid}");
    }
    assert!(Target::parse(&format!("https://example.com/{}", "x".repeat(2049))).is_none());
}

#[test]
fn checks_the_full_dns_answer_and_pins_only_the_first_public_address() {
    let first: SocketAddr = "93.184.215.14:443".parse().unwrap();
    let second = "[2606:4700:4700::1111]:443".parse().unwrap();
    assert_eq!(checked_address([first, second]), Some(first));
    assert!(checked_address([]).is_none());
    assert_eq!(checked_address([first; 32]), Some(first));
    assert!(checked_address([first; 33]).is_none());
    for private in [
        "127.0.0.1:443",
        "0.0.0.0:443",
        "10.0.0.1:443",
        "172.16.0.1:443",
        "192.168.1.1:443",
        "169.254.169.254:443",
        "100.64.0.1:443",
        "224.0.0.1:443",
        "255.255.255.255:443",
        "[::1]:443",
        "[fe80::1]:443",
        "[fc00::1]:443",
        "[ff02::1]:443",
        "[::ffff:127.0.0.1]:443",
        "[64:ff9b::a9fe:a9fe]:443",
        "[2002:7f00:1::1]:443",
        "198.18.0.1:443",
        "203.0.113.8:443",
        "[2001:db8::1]:443",
        "[3fff::12]:443",
    ] {
        let address = private.parse().unwrap();
        assert!(checked_address([address]).is_none(), "{private}");
        assert!(checked_address([first, address]).is_none(), "{private}");
    }
    let public_with_scope = SocketAddrV6::new(
        "2606:4700:4700::1111".parse::<Ipv6Addr>().unwrap(),
        443,
        0,
        1,
    );
    assert!(checked_address([public_with_scope.into()]).is_none());
}
