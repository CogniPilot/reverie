use super::{Registry, StatusCode, Target};
use std::{fs, net::Ipv4Addr, path::PathBuf, time::Duration};

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn registry() -> (Directory, Registry) {
    let dir = Directory(
        nix::unistd::mkdtemp(&std::env::temp_dir().join("rvpv-registry-XXXXXX")).unwrap(),
    );
    let config = serde_json::from_value(serde_json::json!({
        "version":1, "domain":"preview.test", "officeOrigin":"https://office.test",
        "deployment":"fixture", "listenAddress":"127.0.0.1", "port":9443,
        "auditFile":dir.0.join("audit.jsonl"), "certificate":"/unused/cert.pem",
        "privateKey":"/unused/key.pem", "controlSocket":dir.0.join("preview.sock"),
    }))
    .unwrap();
    let registry = Registry::new(&config, 9443);
    (dir, registry)
}

fn expose(registry: &Registry) -> super::Created {
    let target = Target {
        container: "test-container".into(),
        network: "test-network".into(),
        address: Ipv4Addr::LOCALHOST,
    };
    registry
        .expose("fixture".to_owned(), 13000, target, "/".parse().unwrap())
        .unwrap()
}

fn get_token(url: &str) -> &str {
    url.split_once("?token=").unwrap().1
}

#[tokio::test(start_paused = true)]
async fn links_expire_and_browsers_cannot_outlive_the_grant() {
    let (_dir, registry) = registry();
    let created = expose(&registry);
    let authority = created.preview.origin.strip_prefix("https://").unwrap();
    tokio::time::advance(Duration::from_secs(61)).await;
    assert_eq!(
        registry.exchange(authority, get_token(&created.url)).err(),
        Some(StatusCode::FORBIDDEN)
    );
    let url = registry
        .link(&created.preview.id, "/new".parse().unwrap())
        .unwrap();
    let opened = registry.exchange(authority, get_token(&url)).unwrap();
    assert_eq!(opened.page, "/new");
    let mut access = registry.access(authority, &opened.cookie, true).unwrap();
    tokio::time::advance(Duration::from_secs(1_800)).await;
    assert!(!registry.exists(authority));
    assert!(access.revocation.changed().await.is_err());
}

#[tokio::test(start_paused = true)]
async fn grant_rate_window_and_concurrent_capacity_are_independent() {
    let (_dir, registry) = registry();
    let created = expose(&registry);
    let authority = created.preview.origin.strip_prefix("https://").unwrap();
    let opened = registry
        .exchange(authority, get_token(&created.url))
        .unwrap();
    for _ in 0..600 {
        assert!(registry.access(authority, &opened.cookie, true).is_ok());
    }
    assert_eq!(
        registry.access(authority, &opened.cookie, true).err(),
        Some(StatusCode::TOO_MANY_REQUESTS)
    );
    tokio::time::advance(Duration::from_secs(61)).await;
    let active = (0..4)
        .map(|_| registry.access(authority, &opened.cookie, true).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        registry.access(authority, &opened.cookie, true).err(),
        Some(StatusCode::TOO_MANY_REQUESTS)
    );
    drop(active);
    assert!(registry.access(authority, &opened.cookie, true).is_ok());
}
