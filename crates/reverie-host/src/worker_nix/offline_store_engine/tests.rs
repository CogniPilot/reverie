use super::*;
use std::{
    collections::BTreeMap,
    os::unix::{fs::symlink, net::UnixListener},
    path::PathBuf,
};

const BASE: &str = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-fixture";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join("rv-engine-XXXXXX");
        Self(nix::unistd::mkdtemp(&directory).unwrap())
    }
    fn command(&self, name: &str) -> InstalledCommand {
        let path = self.0.join(name);
        if !path.exists() {
            fs::hard_link(crate::engine_metadata::tests::program(), &path).unwrap();
        }
        InstalledCommand::from_service(path.as_os_str(), BTreeMap::new(), self.0.clone()).unwrap()
    }
    fn query(&self, query: Query) -> Result<Vec<u8>> {
        read_command(
            &self.0.join("docker.sock"),
            query,
            self.command("offline-store-engine"),
        )
    }
    fn reply(&self, path: &str, data: &[u8]) {
        fs::write(self.0.join(path), data).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn archive(entries: &[(&[u8], tar::EntryType)]) -> Vec<u8> {
    let mut raw = tar::Builder::new(Vec::new());
    for (name, kind) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_path(std::str::from_utf8(name).unwrap()).unwrap();
        header.set_entry_type(*kind);
        header.set_size(0);
        if kind.is_symlink() {
            header.set_link_name(BASE).unwrap();
        }
        header.set_cksum();
        raw.append(&header, &[][..]).unwrap();
    }
    raw.into_inner().unwrap()
}

#[test]
fn sends_only_the_fixed_queries_and_checks_the_responses() {
    let fixture = Fixture::new();
    let _socket = UnixListener::bind(fixture.0.join("docker.sock")).unwrap();
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    let image = format!("sha256:{}", "1".repeat(64));
    fixture.reply("engine-id", br#""  observed-id  ""#);
    fixture.reply("engine-inventory", format!("{a}\n{b}\n").as_bytes());
    fixture.reply(
        "engine-image",
        format!(r#"[{{"Id":"{image}"}}]"#).as_bytes(),
    );
    fixture.reply(
        "engine-rows",
        format!(r#"[{{"Id":"{b}"}},{{"Id":"{a}"}}]"#).as_bytes(),
    );
    fixture.reply(
        "engine-base",
        &archive(&[(b"reverie-nix-base", tar::EntryType::Symlink)]),
    );
    assert_eq!(fixture.query(Query::Identity).unwrap(), br#""observed-id""#);
    assert_eq!(
        fixture.query(Query::Inventory).unwrap(),
        serde_json::to_vec(&[&a, &b]).unwrap()
    );
    assert!(
        fixture
            .query(Query::Image(WorkerImageId::parse(&image).unwrap()))
            .is_ok()
    );
    let ids = || {
        vec![
            ContainerId::parse(&a).unwrap(),
            ContainerId::parse(&b).unwrap(),
        ]
    };
    assert!(fixture.query(Query::Inspect(ids())).is_ok());
    assert_eq!(
        fixture
            .query(Query::Base(ContainerId::parse(&a).unwrap()))
            .unwrap(),
        serde_json::to_vec(BASE).unwrap()
    );
    fixture.reply(
        "engine-rows",
        format!(r#"[{{"Id":"{a}"}},{{"Id":"{a}"}}]"#).as_bytes(),
    );
    assert!(fixture.query(Query::Inspect(ids())).is_err());
    fixture.reply("engine-inventory", format!("{a}\n{a}\n").as_bytes());
    assert!(fixture.query(Query::Inventory).is_err());
}

#[test]
fn refuses_aliases_and_archives_without_exactly_one_symbolic_link() {
    let fixture = Fixture::new();
    let socket = fixture.0.join("docker.sock");
    let _socket = UnixListener::bind(&socket).unwrap();
    let alias = fixture.0.join("alias");
    symlink(socket, &alias).unwrap();
    assert!(socket_identity(&alias).is_err());
    assert!(base_target(&archive(&[(b"regular", tar::EntryType::Regular)])).is_err());
    assert!(
        base_target(&archive(&[
            (b"first", tar::EntryType::Symlink),
            (b"second", tar::EntryType::Symlink),
        ]))
        .is_err()
    );
}

#[test]
fn capture_preserves_binary_bytes_and_enforces_independent_bounds_and_deadline() {
    let fixture = Fixture::new();
    let socket = fixture.0.join("docker.sock");
    let budget = Duration::from_secs(3);
    let query = Query::Identity;
    let binary = CapturedClient::new(fixture.command("badout"));
    assert_eq!(run(&binary, &socket, &query, budget).unwrap(), [0xff]);
    let overflow = CapturedClient::new(fixture.command("overflow"));
    assert_eq!(
        run(&overflow, &socket, &query, budget)
            .unwrap_err()
            .to_string(),
        "engine response bound"
    );
    let stalled = CapturedClient::new(fixture.command("stall"));
    assert_eq!(
        run(&stalled, &socket, &query, Duration::from_millis(40))
            .unwrap_err()
            .to_string(),
        "engine response deadline"
    );
}
