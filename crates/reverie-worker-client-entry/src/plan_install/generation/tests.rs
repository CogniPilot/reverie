use super::*;
use crate::plan_install::input::{Context, Conversation, Provider, Role, Source};
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt, symlink},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static SERIAL: AtomicU64 = AtomicU64::new(0);
const OP: &str = "11111111-1111-4111-8111-111111111111";
const SID: &str = "22222222-2222-4222-8222-222222222222";
const ATTEMPT: &str = "33333333-3333-4333-8333-333333333333";
const THREAD: &str = "44444444-4444-4444-8444-444444444444";
struct Fixture {
    path: PathBuf,
    home: Home,
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "reverie-plan-generation-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        let metadata = fs::metadata(&path).unwrap();
        Self {
            path,
            home: Home {
                dev: metadata.dev(),
                ino: metadata.ino(),
            },
        }
    }
    fn generation(&self, projection: &str) -> PathBuf {
        self.path
            .join(".reverie/plan-moves")
            .join(OP)
            .join(generation_name(projection))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.path).unwrap();
    }
}
fn payload() -> Payload {
    Payload {
        version: 1,
        purpose: "reverie-plan-install-v1".into(),
        operation_id: OP.into(),
        session_id: SID.into(),
        container_id: "a".repeat(64),
        provider: Provider::Anthropic,
        account_id: "account-b".into(),
        auth: r#"{"syntheticAccount":"B","paid":false}"#.into(),
        identity: format!("synthetic.{}", "b".repeat(64)),
        context: Context {
            source: Source::None,
            roles: vec![],
            conversation: None,
        },
    }
}
#[test]
fn actual_account_and_identity_generation_preserves_original_files() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.path.join(".claude")).unwrap();
    let old = fixture.path.join(".claude/.credentials.json");
    fs::write(&old, b"original account A").unwrap();
    let value = payload();
    let projection = Material::from_payload(&value).digest().unwrap();
    let receipt = install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).unwrap();
    let encoded = serde_json::to_value(&receipt).unwrap();
    let actual = encoded
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let described = crate::plan_protocol::RECEIPT_FIELDS
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(actual, described);
    let generation = fixture.generation(&projection);
    assert_eq!(fs::read(&old).unwrap(), b"original account A");
    assert_eq!(
        fs::read(generation.join("claude/.credentials.json")).unwrap(),
        value.auth.as_bytes()
    );
    assert_eq!(
        fs::read(generation.join(value.identity_filename())).unwrap(),
        value.identity.as_bytes()
    );
    assert_eq!(
        receipt.token_digest,
        input::digest(value.identity.as_bytes())
    );
    assert_eq!(
        receipt.installed_auth_digest,
        input::digest(value.auth.as_bytes())
    );
    assert_eq!(
        status(
            &fixture.path,
            fixture.home,
            OP,
            &value.container_id,
            &projection,
            true
        )
        .unwrap()
        .config_ino,
        receipt.config_ino
    );
    assert_eq!(
        fs::metadata(generation.join("manifest.json"))
            .unwrap()
            .mode()
            & 0o7777,
        0o600
    );
    assert_eq!(
        fs::metadata(generation.join("claude")).unwrap().mode() & 0o7777,
        0o700
    );
}
#[test]
fn exact_retry_reads_published_generation_but_never_overwrites_other_material() {
    let fixture = Fixture::new();
    let mut value = payload();
    let projection = Material::from_payload(&value).digest().unwrap();
    let first = install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).unwrap();
    let second = install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).unwrap();
    assert_eq!(first.config_ino, second.config_ino);
    value.identity = format!("changed.{}", "c".repeat(64));
    assert!(install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).is_err());
    value.auth = r#"{"syntheticAccount":"C"}"#.into();
    assert!(install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).is_err());
    assert_eq!(
        fs::read(
            fixture
                .generation(&projection)
                .join(value.identity_filename())
        )
        .unwrap(),
        payload().identity.as_bytes()
    );
}
#[test]
fn material_is_independent_of_cid_token_but_exact_payload_is_not() {
    let mut a = payload();
    let material = Material::from_payload(&a).digest().unwrap();
    let wire = input::digest(&serde_json::to_vec(&a).unwrap());
    a.container_id = "f".repeat(64);
    a.identity = format!("other.{}", "d".repeat(64));
    assert_eq!(Material::from_payload(&a).digest().unwrap(), material);
    assert!(Payload::parse(&serde_json::to_vec(&a).unwrap(), &wire).is_err());
    let fixture = Fixture::new();
    install(&fixture.path, fixture.home, &payload(), &material, ATTEMPT).unwrap();
    install(
        &fixture.path,
        fixture.home,
        &a,
        &material,
        "55555555-5555-4555-8555-555555555555",
    )
    .unwrap();
    assert!(
        fixture
            .generation(&material)
            .join(payload().identity_filename())
            .exists()
    );
    assert!(
        fixture
            .generation(&material)
            .join(a.identity_filename())
            .exists()
    );
}
#[test]
fn retained_incomplete_attempt_never_becomes_a_receipt_or_rewrites_files() {
    let fixture = Fixture::new();
    let value = payload();
    let projection = Material::from_payload(&value).digest().unwrap();
    let parent = fixture.path.join(".reverie/plan-moves").join(OP);
    fs::create_dir_all(parent.join(format!("pending-{ATTEMPT}"))).unwrap();
    for path in [
        fixture.path.join(".reverie"),
        fixture.path.join(".reverie/plan-moves"),
        parent.clone(),
        parent.join(format!("pending-{ATTEMPT}")),
    ] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    assert!(install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).is_err());
    assert!(!fixture.generation(&projection).exists());
    assert!(
        status(
            &fixture.path,
            fixture.home,
            OP,
            &value.container_id,
            &projection,
            false
        )
        .is_err()
    );
}
#[test]
fn wrong_home_symlink_and_modified_material_fail_without_following_or_overwrite() {
    let fixture = Fixture::new();
    let value = payload();
    let projection = Material::from_payload(&value).digest().unwrap();
    assert!(
        install(
            &fixture.path,
            Home {
                ino: fixture.home.ino + 1,
                ..fixture.home
            },
            &value,
            &projection,
            ATTEMPT
        )
        .is_err()
    );
    symlink("/elsewhere", fixture.path.join(".reverie")).unwrap();
    assert!(install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).is_err());
    fs::remove_file(fixture.path.join(".reverie")).unwrap();
    install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).unwrap();
    fs::write(
        fixture
            .generation(&projection)
            .join("claude/.credentials.json"),
        b"{\"syntheticAccount\":\"unselected\"}",
    )
    .unwrap();
    assert!(
        status(
            &fixture.path,
            fixture.home,
            OP,
            &value.container_id,
            &projection,
            true
        )
        .is_err()
    );
}
fn with_history(fixture: &Fixture) -> Payload {
    let mut value = payload();
    let history = fixture.path.join(".claude");
    fs::DirBuilder::new().mode(0o700).create(&history).unwrap();
    fs::create_dir_all(history.join("projects/workspace")).unwrap();
    let file = history.join(format!("projects/workspace/{THREAD}.jsonl"));
    fs::write(&file, b"same provider source transcript").unwrap();
    let metadata = fs::metadata(history).unwrap();
    value.context = Context {
        source: Source::Home {
            relative: vec![".claude".into()],
            dev: metadata.dev().to_string(),
            ino: metadata.ino().to_string(),
        },
        roles: vec![Role::ClaudeProjects],
        conversation: Some(Conversation {
            native_id: THREAD.into(),
            relative: vec![
                "projects".into(),
                "workspace".into(),
                format!("{THREAD}.jsonl"),
            ],
            sha256: input::digest(b"same provider source transcript"),
        }),
    };
    value
}
#[test]
fn actual_history_link_keeps_selected_thread_and_refuses_replaced_source() {
    let fixture = Fixture::new();
    let value = with_history(&fixture);
    let projection = Material::from_payload(&value).digest().unwrap();
    install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).unwrap();
    assert_eq!(
        fs::read_link(fixture.generation(&projection).join("claude/projects")).unwrap(),
        Path::new("/home/agent/.claude/projects")
    );
    fs::write(
        fixture
            .path
            .join(format!(".claude/projects/workspace/{THREAD}.jsonl")),
        b"legitimate native progress",
    )
    .unwrap();
    assert!(
        status(
            &fixture.path,
            fixture.home,
            OP,
            &value.container_id,
            &projection,
            true
        )
        .is_err()
    );
    assert!(
        status(
            &fixture.path,
            fixture.home,
            OP,
            &value.container_id,
            &projection,
            false
        )
        .is_ok()
    );
    fs::rename(
        fixture.path.join(".claude/projects"),
        fixture.path.join(".claude/retained-projects"),
    )
    .unwrap();
    fs::create_dir(fixture.path.join(".claude/projects")).unwrap();
    assert!(
        status(
            &fixture.path,
            fixture.home,
            OP,
            &value.container_id,
            &projection,
            false
        )
        .is_err()
    );
}
#[test]
fn two_account_generations_leave_both_selected_accounts_and_source_context_intact() {
    let fixture = Fixture::new();
    let a = with_history(&fixture);
    let first = Material::from_payload(&a).digest().unwrap();
    install(&fixture.path, fixture.home, &a, &first, ATTEMPT).unwrap();
    let mut b = payload();
    b.operation_id = "66666666-6666-4666-8666-666666666666".into();
    b.session_id = "77777777-7777-4777-8777-777777777777".into();
    b.account_id = "account-a".into();
    b.auth = "{\"syntheticAccount\":\"A\"}".into();
    b.context = a.context.clone();
    let second = Material::from_payload(&b).digest().unwrap();
    install(&fixture.path, fixture.home, &b, &second, ATTEMPT).unwrap();
    assert!(
        status(
            &fixture.path,
            fixture.home,
            OP,
            &a.container_id,
            &first,
            false
        )
        .is_ok()
    );
    assert!(
        status(
            &fixture.path,
            fixture.home,
            &b.operation_id,
            &b.container_id,
            &second,
            false
        )
        .is_ok()
    );
    assert_eq!(
        fs::read(
            fixture
                .path
                .join(format!(".claude/projects/workspace/{THREAD}.jsonl"))
        )
        .unwrap(),
        b"same provider source transcript"
    );
}

#[test]
fn live_auth_refresh_is_observed_without_claiming_initial_account_ack() {
    let fixture = Fixture::new();
    let value = payload();
    let projection = Material::from_payload(&value).digest().unwrap();
    let initial = install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).unwrap();
    let auth = fixture
        .generation(&projection)
        .join("claude/.credentials.json");
    let refreshed = auth.with_file_name("refreshed-auth.json");
    fs::write(
        &refreshed,
        b"{\"syntheticAccount\":\"B\",\"refreshGeneration\":2}",
    )
    .unwrap();
    fs::set_permissions(&refreshed, fs::Permissions::from_mode(0o644)).unwrap();
    fs::rename(&refreshed, &auth).unwrap();
    assert!(
        status(
            &fixture.path,
            fixture.home,
            OP,
            &value.container_id,
            &projection,
            true
        )
        .is_err()
    );
    let observed = status(
        &fixture.path,
        fixture.home,
        OP,
        &value.container_id,
        &projection,
        false,
    )
    .unwrap();
    assert_eq!(observed.purpose, "reverie-plan-live-observation-v1");
    assert_eq!(observed.read_mode, "live");
    assert_eq!(
        observed.installed_auth_digest,
        initial.installed_auth_digest
    );
    assert_ne!(
        observed.observed_auth_digest,
        observed.installed_auth_digest
    );
    fs::write(&auth, b"incomplete refresh").unwrap();
    assert!(
        status(
            &fixture.path,
            fixture.home,
            OP,
            &value.container_id,
            &projection,
            false
        )
        .is_err()
    );
}
#[test]
fn unexpected_config_is_refused_before_install_ack_but_never_deleted() {
    let fixture = Fixture::new();
    let value = payload();
    let projection = Material::from_payload(&value).digest().unwrap();
    install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).unwrap();
    let settings = fixture.generation(&projection).join("claude/settings.json");
    fs::write(&settings, b"{\"hooks\":\"never copy external commands\"}").unwrap();
    assert!(install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).is_err());
    assert!(
        status(
            &fixture.path,
            fixture.home,
            OP,
            &value.container_id,
            &projection,
            true
        )
        .is_err()
    );
    assert!(settings.exists());
    assert_eq!(
        status(
            &fixture.path,
            fixture.home,
            OP,
            &value.container_id,
            &projection,
            false
        )
        .unwrap()
        .purpose,
        "reverie-plan-live-observation-v1"
    );
}

#[test]
fn live_owned_instruction_rotation_is_observation_not_initial_context_proof() {
    let fixture = Fixture::new();
    let mut value = with_history(&fixture);
    fs::write(
        fixture.path.join(".claude/CLAUDE.md"),
        b"owned employee memory v1",
    )
    .unwrap();
    value.context.roles.push(Role::ClaudeInstructions);
    let projection = Material::from_payload(&value).digest().unwrap();
    let installed = install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).unwrap();
    let replacement = fixture.path.join(".claude/new-memory");
    fs::write(&replacement, b"owned employee memory v2").unwrap();
    fs::rename(&replacement, fixture.path.join(".claude/CLAUDE.md")).unwrap();
    assert!(
        status(
            &fixture.path,
            fixture.home,
            OP,
            &value.container_id,
            &projection,
            true
        )
        .is_err()
    );
    let live = status(
        &fixture.path,
        fixture.home,
        OP,
        &value.container_id,
        &projection,
        false,
    )
    .unwrap();
    assert_eq!(live.context_digest, installed.context_digest);
    assert_ne!(
        live.observed_context_digest,
        installed.observed_context_digest
    );
    assert_eq!(live.purpose, "reverie-plan-live-observation-v1");
}

#[test]
fn initial_receipt_binds_selected_account_and_input_context_separately_from_inodes() {
    let fixture = Fixture::new();
    let value = with_history(&fixture);
    let projection = Material::from_payload(&value).digest().unwrap();
    let installed = install(&fixture.path, fixture.home, &value, &projection, ATTEMPT).unwrap();
    assert_eq!(installed.account_id, value.account_id);
    assert_eq!(installed.provider, value.provider);
    assert_eq!(
        installed.context_input_digest,
        value.context.digest().unwrap()
    );
    assert_ne!(installed.context_input_digest, installed.context_digest);
    let fields = serde_json::to_value(&installed).unwrap();
    let mut keys = fields
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    keys.sort_unstable();
    let mut expected = vec![
        "version",
        "purpose",
        "operationId",
        "sessionId",
        "containerId",
        "projectionDigest",
        "accountId",
        "provider",
        "contextInputDigest",
        "readMode",
        "installedAuthDigest",
        "observedAuthDigest",
        "tokenDigest",
        "contextDigest",
        "observedContextDigest",
        "homeDev",
        "homeIno",
        "configDev",
        "configIno",
    ];
    expected.sort_unstable();
    assert_eq!(keys, expected);
    let none = Context {
        source: Source::None,
        roles: vec![],
        conversation: None,
    };
    assert_eq!(
        none.digest().unwrap(),
        input::digest(br#"{"conversation":null,"roles":[],"source":{"kind":"none"}}"#)
    );
}
