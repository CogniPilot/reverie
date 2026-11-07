//! Explicit qualification only. Inputs are compile-bound immutable Nix data;
//! every destination is freshly created task-owned temporary storage. No image
//! start, mount, host daemon, live company state or request-selected path.
use super::*;
use std::os::unix::fs::MetadataExt;

#[test]
#[ignore = "requires explicit compile-bound installed Nix closure qualification"]
fn actual_installed_nix_import_and_offline_copy_preserve_a_private_target_store() {
    let Some(artifact) = option_env!("REVERIE_TEST_NIX_SEED_ARTIFACT") else {
        panic!("requires compile-bound immutable Nix qualification artifact");
    };
    let artifact = PathBuf::from(artifact);
    assert!(artifact.starts_with("/nix/store"));
    assert_eq!(fs::canonicalize(&artifact).unwrap(), artifact);
    let registration = artifact.join("registration");
    let base = fs::read_link(artifact.join("base")).unwrap();
    let previous = fs::read_link(artifact.join("previous-base")).unwrap();
    let root = std::env::temp_dir().join(format!(
        "qualified-nix-seed-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir_all(root.join("target/nix")).unwrap();
    fs::create_dir(root.join("tmp")).unwrap();
    fs::create_dir(root.join("tmp-prior")).unwrap();
    fs::write(
        root.join("target/nix/prior-owner-data"),
        b"preserve-before-and-after",
    )
    .unwrap();
    let before = fs::read(&registration).unwrap();
    seed_stage(
        &artifact,
        &root,
        "tmp-prior",
        "previous-registration",
        "previous-base",
    );
    let profile = root.join("target/nix/var/nix/profiles/owner-history");
    fs::create_dir_all(profile.parent().unwrap()).unwrap();
    symlink(&previous, &profile).unwrap();
    seed_stage(&artifact, &root, "tmp", "registration", "base");
    assert_eq!(fs::read_link(profile).unwrap(), previous);
    let copied_previous = root
        .join("target/nix/store")
        .join(previous.file_name().unwrap());
    assert_eq!(
        fs::read(copied_previous.join("share/reverie/prior-fixture")).unwrap(),
        b"prior-image-data"
    );
    assert!(registered(&artifact, &root, &previous));
    assert_eq!(fs::read(&registration).unwrap(), before);
    assert_eq!(
        fs::read(root.join("target/nix/prior-owner-data")).unwrap(),
        b"preserve-before-and-after"
    );
    let copied = root
        .join("target/nix/store")
        .join(base.file_name().unwrap());
    assert_eq!(
        fs::read(copied.join("bin/hello")).unwrap(),
        fs::read(base.join("bin/hello")).unwrap()
    );
    assert_eq!(
        fs::read_link(root.join("target/nix/var/nix/gcroots/reverie-image")).unwrap(),
        base
    );
    assert_eq!(
        fs::metadata(root.join("tmp/nix-bootstrap-state/db/db.sqlite"))
            .unwrap()
            .mode()
            & 0o222,
        0
    );
    assert!(root.join("target/nix/var/nix/db/db.sqlite").is_file());
    println!(
        "qualified artifact={} copied={} owned-target={}",
        artifact.display(),
        copied.display(),
        root.display()
    );
    // Keep this regenerable owned qualification output for inspection. It is
    // never recursively deleted by an error path or mistaken for a live store.
}
fn seed_stage(artifact: &Path, root: &Path, temporary: &str, registration: &str, base: &str) {
    let bootstrap = Bootstrap {
        target: root.join("target/nix"),
        temporary: root.join(temporary),
        registration: artifact.join(registration),
        base: artifact.join(base),
        nix_store: artifact.join("nix/bin/nix-store"),
        nix: artifact.join("nix/bin/nix"),
        environment: std::env::vars_os().collect(),
        directory: root.to_owned(),
    };
    let mut owner = GuestNixSeed::new(bootstrap);
    let deadline = Instant::now() + Duration::from_secs(300);
    let result = owner.seed(deadline);
    let settled = settled(&mut owner, deadline);
    assert!(
        result.is_ok(),
        "seed={result:?}, cleanup={settled:?}, owned destination={}",
        root.display()
    );
    settled.unwrap();
}
fn registered(artifact: &Path, root: &Path, previous: &Path) -> bool {
    let command = InstalledCommand::from_service(
        artifact.join("nix/bin/nix-store").as_os_str(),
        std::env::vars_os().collect(),
        root.to_owned(),
    )
    .unwrap();
    let client = CapturedClient::new(command);
    let deadline = Instant::now() + Duration::from_secs(20);
    let result = client.run(
        vec![
            "--store".into(),
            format!("local?root={}", root.join("target").display()).into(),
            "--query".into(),
            "--hash".into(),
            previous.as_os_str().to_owned(),
        ],
        deadline,
        &CancellationToken::new(),
        captured_client::Policy {
            maximum: Duration::from_secs(20),
            maximum_output: 4 * 1024 * 1024,
            successful_exit: true,
        },
    );
    let mut status = client.shutdown(deadline);
    while matches!(status, reverie_core::shutdown::ShutdownStatus::Pending(_)) {
        std::thread::sleep(Duration::from_millis(50));
        status = client.shutdown(Instant::now());
    }
    assert!(matches!(
        status,
        reverie_core::shutdown::ShutdownStatus::Complete
    ));
    result
        .ok()
        .is_some_and(|output| output.stdout.starts_with(b"sha256:"))
}
fn settled(owner: &mut GuestNixSeed, deadline: Instant) -> std::result::Result<(), SeedError> {
    use reverie_core::shutdown::ShutdownStatus;
    let mut status = owner.shutdown(deadline);
    loop {
        match status {
            ShutdownStatus::Complete => return Ok(()),
            ShutdownStatus::Refused(error) => return Err(error),
            ShutdownStatus::Pending(_) => {
                std::thread::sleep(Duration::from_millis(50));
                status = owner.shutdown(Instant::now());
            }
        }
    }
}
