use super::*;
use nix::{
    sys::stat::Mode,
    unistd::{mkdtemp, mkfifo},
};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink},
    path::PathBuf,
};

const SESSION: &str = "11111111-2222-3333-4444-555555555555";
const ROOM: &str = "12345678-1234-1234-1234-123456789abc";
const ATTACHMENT: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";

pub(crate) struct Fixture(pub(crate) PathBuf);

impl Fixture {
    pub(crate) fn new() -> Self {
        let temporary = env::temp_dir()
            .canonicalize()
            .unwrap()
            .join("scoped-vision-XXXXXX");
        let path = mkdtemp(&temporary).unwrap();
        private_file(&path.join("elsewhere.bin"), PNG);
        Self(path)
    }

    pub(crate) fn verify_cleanup(&self) {
        assert_eq!(fs::read(self.0.join("elsewhere.bin")).unwrap(), PNG);
        assert_eq!(fs::read_dir(self.0.join("tmp")).unwrap().count(), 0);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn private_file(path: &Path, data: &[u8]) {
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .unwrap()
        .write_all(data)
        .unwrap();
}

pub(crate) fn request(mode: &str) -> Request {
    let mut cli = vec![
        env::current_exe()
            .unwrap()
            .into_os_string()
            .into_string()
            .unwrap(),
    ];
    cli.extend(
        [
            "--exact",
            "scoped_image::tests::office_child",
            "--nocapture",
            "--",
            mode,
        ]
        .map(str::to_owned),
    );
    Request {
        cli,
        session: SESSION.into(),
        room: ROOM.into(),
        attachment: ATTACHMENT.into(),
        max_bytes: 100,
        timeout: if mode == "slow" { 0.2 } else { 120.0 },
    }
}

#[test]
fn office_child() {
    let args = env::args().collect::<Vec<_>>();
    let Some(tail) = args.split(|arg| arg == "--").nth(1) else {
        return;
    };
    let Some((mode, operation)) = tail.split_first() else {
        return;
    };
    let timeout = if mode == "slow" { "200" } else { "10000" };
    assert_eq!(
        operation,
        [
            "fetch",
            ROOM,
            ATTACHMENT,
            "--output",
            "image.bin",
            "--max-bytes",
            "100",
            "--timeout",
            timeout,
            "--json"
        ]
    );
    let file = Path::new("image.bin");
    let outside = Path::new("../../elsewhere.bin");
    match mode.as_str() {
        "good" => private_file(file, PNG),
        "symlink" => symlink(outside, file).unwrap(),
        "hardlink" => fs::hard_link(outside, file).unwrap(),
        "oversize" => private_file(file, &[0; 101]),
        "mode" => {
            private_file(file, PNG);
            fs::set_permissions(file, fs::Permissions::from_mode(0o644)).unwrap();
        }
        "fifo" => mkfifo(file, Mode::S_IRUSR | Mode::S_IWUSR).unwrap(),
        "denied" => std::process::exit(77),
        "slow" => std::thread::sleep(Duration::from_secs(30)),
        _ => panic!("unknown Office fixture request"),
    }
}

#[test]
fn downloads_with_the_same_cli_and_returns_only_the_verified_bytes() {
    let fixture = Fixture::new();
    let download = request("good").authorize(Some("1"), Some(SESSION)).unwrap();
    let signals = Signals::install().unwrap();
    assert_eq!(
        download.fetch(&fixture.0.join("tmp"), &signals).unwrap(),
        PNG
    );
    fixture.verify_cleanup();
}

#[test]
fn refuses_untrusted_output_and_cleans_scratch_after_timeout_or_denial() {
    let fixture = Fixture::new();
    let signals = Signals::install().unwrap();
    for mode in [
        "symlink", "hardlink", "oversize", "mode", "fifo", "denied", "slow",
    ] {
        let download = request(mode).authorize(Some("1"), Some(SESSION)).unwrap();
        let error = download
            .fetch(&fixture.0.join("tmp"), &signals)
            .unwrap_err();
        if mode == "slow" {
            assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        }
        fixture.verify_cleanup();
    }
}

#[test]
fn requires_matching_session_and_exact_room_and_file_ids() {
    assert!(request("good").authorize(None, Some(SESSION)).is_err());
    assert!(request("good").authorize(Some("1"), Some(ROOM)).is_err());
    let mut request = request("good");
    request.attachment = "../image.bin".into();
    assert!(request.authorize(Some("1"), Some(SESSION)).is_err());
}

#[test]
fn refuses_aliased_scratch_without_creating_files_in_the_target() {
    let fixture = Fixture::new();
    let alias = fixture.0.join("tmp");
    let destination = fixture.0.join("elsewhere");
    fs::create_dir(&destination).unwrap();
    symlink(&destination, &alias).unwrap();
    assert!(scratch::ImageScratch::new(&alias).is_err());
    assert_eq!(fs::read_dir(destination).unwrap().count(), 0);
}
