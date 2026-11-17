use flate2::{Compression, write::GzEncoder};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};
use tar::{Builder, EntryType, Header};

fn token() -> String {
    ["gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"].concat()
}

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "reverie-image-check-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn regular(tar: &mut Builder<Vec<u8>>, path: &str, bytes: &[u8]) {
    let mut header = Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    tar.append_data(&mut header, path, bytes).unwrap();
}

fn link(tar: &mut Builder<Vec<u8>>, kind: EntryType, path: &str, target: &str) {
    let mut header = Header::new_gnu();
    header.set_entry_type(kind);
    header.set_mode(0o777);
    header.set_size(0);
    tar.append_link(&mut header, path, target).unwrap();
}

fn fixture(
    scratch: &Scratch,
    entries: impl IntoIterator<Item = Vec<u8>>,
    config: Value,
) -> PathBuf {
    let layers: Vec<_> = entries.into_iter().collect();
    let names: Vec<_> = (0..layers.len())
        .map(|index| format!("layer-{index}.tar"))
        .collect();
    let manifest = json!([{"Config": "config.json", "Layers": names}]);
    let mut tar = Builder::new(Vec::new());
    for (name, layer) in names.iter().zip(layers) {
        regular(&mut tar, name, &layer);
    }
    regular(&mut tar, "config.json", config.to_string().as_bytes());
    regular(&mut tar, "manifest.json", manifest.to_string().as_bytes());
    let path = scratch.path("image.tar");
    fs::write(&path, tar.into_inner().unwrap()).unwrap();
    path
}

fn run(image: &Path, report: &Path, allow: Option<&Path>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-image-check"));
    command.arg(image).arg("--json").arg(report);
    if let Some(allow) = allow {
        command.arg("--allow").arg(allow);
    }
    command.output().unwrap()
}

fn report(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn reads_owned_content_and_counts_dependencies_in_manifest_order() {
    let scratch = Scratch::new();
    let root = "nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-";
    let owned = format!("{root}reverie-console-1.41.1/lib/reverie/index.js");
    let backend = format!("{root}reverie-backend-cli-0.1.0/bin/reverie-backend");
    let dep = format!("{root}reverie-console-1.41.1/lib/reverie/node_modules/pkg/tests.js");
    let mut first = Builder::new(Vec::new());
    regular(&mut first, &owned, token().as_bytes());
    regular(&mut first, &backend, token().as_bytes());
    regular(&mut first, &dep, token().as_bytes());
    regular(&mut first, "usr/lib/a", b"abc");
    let mut last = Builder::new(Vec::new());
    regular(&mut last, "opt/reverie/.wh.leak", b"");
    let image = fixture(
        &scratch,
        [first.into_inner().unwrap(), last.into_inner().unwrap()],
        json!({"config": {"Env":[format!("GH={}",token())]}, "history":[{"created_by":token()}]}),
    );
    let path = scratch.path("report.json");
    let result = run(&image, &path, None);
    assert_eq!(result.status.code(), Some(1));
    let document = report(&path);
    assert_eq!(
        document,
        json!({
            "layers":2, "clean":false,
            "findings":[
                {"where":"config.Env", "detector":"github_token"},
                {"where":"config.history", "detector":"github_token"},
                {"where":format!("layer 0: /{owned}"), "detector":"github_token"},
                {"where":format!("layer 0: /{backend}"), "detector":"github_token"}
            ],
            "unread_third_party":{
                "nix/store/":{"files":1,"bytes":token().len()},
                "usr/":{"files":1,"bytes":3}
            }
        })
    );
    assert!(!document.to_string().contains(&token()));
    assert!(!String::from_utf8_lossy(&result.stdout).contains(&token()));
}

#[test]
fn checks_instance_names_mounts_and_link_targets_in_every_tree() {
    let scratch = Scratch::new();
    let mut layer = Builder::new(Vec::new());
    regular(&mut layer, "./.env", b"x");
    regular(&mut layer, "opt/.env.example", b"x");
    regular(&mut layer, "workspace/changes", b"x");
    regular(&mut layer, "usr/lib/memory.sqlite-wal", b"x");
    link(
        &mut layer,
        EntryType::Symlink,
        "usr/lib/config",
        "../../instances/default/auth.json",
    );
    link(
        &mut layer,
        EntryType::Link,
        "usr/lib/start",
        "private/.git-credentials",
    );
    let image = fixture(&scratch, [layer.into_inner().unwrap()], json!({}));
    let path = scratch.path("report.json");
    assert_eq!(run(&image, &path, None).status.code(), Some(1));
    assert_eq!(
        report(&path)["findings"],
        json!([
            {"where":"layer 0: /.env","detector":"instance_file"},
            {"where":"layer 0: /workspace/changes","detector":"mount_point_not_empty"},
            {"where":"layer 0: /usr/lib/memory.sqlite-wal","detector":"instance_file"},
            {"where":"layer 0: /usr/lib/config","detector":"link_to_instance_file"},
            {"where":"layer 0: /usr/lib/config","detector":"link_into_mount_point"},
            {"where":"layer 0: /usr/lib/start","detector":"link_to_instance_file"}
        ])
    );
}

#[test]
fn scans_binary_windows_across_boundaries_and_gzip_layers() {
    let scratch = Scratch::new();
    let mut bytes = vec![b'x'; 1024 * 1024 - 10];
    bytes.extend_from_slice(&[0, 255, b' ']);
    bytes.extend_from_slice(token().as_bytes());
    let mut layer = Builder::new(Vec::new());
    regular(&mut layer, "usr/local/bin/a", &bytes);
    let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
    gzip.write_all(&layer.into_inner().unwrap()).unwrap();
    let image = fixture(&scratch, [gzip.finish().unwrap()], json!({}));
    let path = scratch.path("report.json");
    assert_eq!(run(&image, &path, None).status.code(), Some(1));
    assert_eq!(
        report(&path)["findings"],
        json!([{"where":"layer 0: /usr/local/bin/a","detector":"github_token"}])
    );
    let allow = scratch.path("allow.tsv");
    fs::write(&allow, "usr/local/bin/a\tprivate_key\n").unwrap();
    assert_eq!(run(&image, &path, Some(&allow)).status.code(), Some(1));
    fs::write(&allow, "usr/local/bin/a\tgithub_token\n").unwrap();
    assert_eq!(run(&image, &path, Some(&allow)).status.code(), Some(0));
    assert_eq!(report(&path)["clean"], true);
}

#[test]
fn malformed_metadata_or_missing_layer_refuses_before_writing_report() {
    let scratch = Scratch::new();
    let path = scratch.path("report.json");
    for manifest in [r"[]", r#"[{"Config":"config.json","Layers":["missing"]}]"#] {
        let mut tar = Builder::new(Vec::new());
        regular(&mut tar, "manifest.json", manifest.as_bytes());
        regular(&mut tar, "config.json", b"{}");
        let image = scratch.path("bad.tar");
        fs::write(&image, tar.into_inner().unwrap()).unwrap();
        assert_eq!(run(&image, &path, None).status.code(), Some(2));
        assert!(!path.exists());
    }
}
