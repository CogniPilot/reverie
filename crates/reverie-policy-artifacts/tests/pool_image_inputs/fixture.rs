use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) struct Fixture {
    pub root: PathBuf,
    pub source: PathBuf,
    pub controller: Archive,
    pub anchor: Archive,
    pub output: PathBuf,
}
pub(super) struct Archive {
    pub root: PathBuf,
    pub path: PathBuf,
    pub config: Value,
    pub config_name: String,
    layer: PathBuf,
    payload: PathBuf,
}
impl Fixture {
    pub(super) fn program(&self) -> PathBuf {
        PathBuf::from(env!("REVERIE_TEST_CONTROLLER_PROGRAM"))
    }
    pub(super) fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("pool-inputs-{}-{nonce}", std::process::id()));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let source = root.join("source");
        for name in [
            "nix/worker-pool-anchor-image.nix",
            "nix/worker-resource-controller-image.nix",
            "nix/worker-resource-controller.nix",
            "nix/native-worker-packages.nix",
            "nix/rust-workspace-source.nix",
            "nix/source-filter.nix",
            "Cargo.lock",
        ] {
            let path = source.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, format!("actual source fixture: {name}\n")).unwrap();
        }
        let controller = Archive::new(&root, "controller");
        let anchor = Archive::new(&root, "anchor");
        let output = root.join("pool-images.json");
        Self {
            root,
            source,
            controller,
            anchor,
            output,
        }
    }
    pub(super) fn run(&self, swapped: bool) -> Output {
        self.run_with_program(swapped, Some(&self.program()))
    }
    pub(super) fn run_with_program(&self, swapped: bool, program: Option<&Path>) -> Output {
        let (controller, anchor) = if swapped {
            (&self.anchor, &self.controller)
        } else {
            (&self.controller, &self.anchor)
        };
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-policy-artifacts"));
        command
            .args([
                "pool-image-inputs",
                "--system",
                "x86_64-linux",
                "--controller-archive",
            ])
            .arg(&controller.path);
        if let Some(program) = program {
            command.arg("--controller-program").arg(program);
        }
        command
            .arg("--anchor-archive")
            .arg(&anchor.path)
            .arg("--source")
            .arg(&self.source)
            .arg("--output")
            .arg(&self.output)
            .env("REVERIE_FIXED_BUILD_GNUTAR", "/not/a/runtime/override")
            .env("TAR_OPTIONS", "--version")
            .env("PATH", "/not/a/runtime/program/path")
            .output()
            .unwrap()
    }
    pub(super) fn close(self) {
        fs::remove_dir_all(self.root).unwrap();
    }
}
impl Archive {
    fn new(parent: &Path, role: &str) -> Self {
        let root = parent.join(format!("{role}-archive"));
        fs::create_dir(&root).unwrap();
        let payload = parent.join(format!("{role}-payload"));
        fs::create_dir(&payload).unwrap();
        fs::write(payload.join("role"), role).unwrap();
        if role == "controller" {
            let program = Path::new(env!("REVERIE_TEST_CONTROLLER_PROGRAM"));
            let packaged = payload.join(program.strip_prefix("/").unwrap());
            fs::create_dir_all(packaged.parent().unwrap()).unwrap();
            fs::copy(program, packaged).unwrap();
            fs::create_dir(payload.join("bin")).unwrap();
            symlink(
                program,
                payload.join("bin/reverie-worker-resource-controller"),
            )
            .unwrap();
        }
        let layer_tmp = parent.join(format!("{role}-layer.tar"));
        assert!(
            Command::new("tar")
                .arg("-cf")
                .arg(&layer_tmp)
                .arg("-C")
                .arg(&payload)
                .arg(".")
                .status()
                .unwrap()
                .success()
        );
        let digest = hash(&fs::read(&layer_tmp).unwrap());
        let layer = root.join(&digest).join("layer.tar");
        fs::create_dir(layer.parent().unwrap()).unwrap();
        fs::rename(layer_tmp, &layer).unwrap();
        let entry = if role == "controller" {
            "/bin/reverie-worker-resource-controller"
        } else {
            "/bin/sleep"
        };
        let mut image_config = json!({"Entrypoint":[entry],"Env":["PATH=/bin","LANG=C.UTF-8"],"User":"0:0","WorkingDir":"/"});
        if role != "controller" {
            image_config["Cmd"] = json!(["infinity"]);
        }
        let config = json!({"created":"1970-01-01T00:00:01+00:00","architecture":"amd64","os":"linux",
            "config":image_config,
            "rootfs":{"type":"layers","diff_ids":[format!("sha256:{digest}")]}});
        let raw = serde_json::to_vec(&config).unwrap();
        let config_name = format!("{}.json", hash(&raw));
        fs::write(root.join(&config_name), raw).unwrap();
        fs::write(root.join("manifest.json"), serde_json::to_vec(&json!([{"Config":config_name,"RepoTags":[format!("owned-{role}:test")],"Layers":[format!("{digest}/layer.tar")]}])).unwrap()).unwrap();
        let path = parent.join(format!("{role}.tar.gz"));
        let value = Self {
            root,
            path,
            config,
            config_name,
            layer,
            payload,
        };
        value.pack();
        value
    }
    pub(super) fn pack(&self) {
        assert!(
            Command::new("tar")
                .arg("-czf")
                .arg(&self.path)
                .arg("-C")
                .arg(&self.root)
                .arg("manifest.json")
                .arg(&self.config_name)
                .arg(self.layer.parent().unwrap().file_name().unwrap())
                .status()
                .unwrap()
                .success()
        );
    }
    pub(super) fn change_valid_layer_payload(&self) {
        fs::write(
            self.payload.join("role"),
            b"changed but valid layer contents",
        )
        .unwrap();
        assert!(
            Command::new("tar")
                .arg("-cf")
                .arg(&self.layer)
                .arg("-C")
                .arg(&self.payload)
                .arg(".")
                .status()
                .unwrap()
                .success()
        );
    }
    pub(super) fn change_config(&mut self, change: impl FnOnce(&mut Value)) {
        change(&mut self.config);
        fs::remove_file(self.root.join(&self.config_name)).unwrap();
        let raw = serde_json::to_vec(&self.config).unwrap();
        self.config_name = format!("{}.json", hash(&raw));
        fs::write(self.root.join(&self.config_name), raw).unwrap();
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(self.root.join("manifest.json")).unwrap()).unwrap();
        manifest[0]["Config"] = json!(self.config_name);
        fs::write(
            self.root.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        self.pack();
    }
}
pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
