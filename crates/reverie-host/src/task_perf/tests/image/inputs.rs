use super::*;
use crate::native;
use reverie_contracts::{rootless::RootlessConfig, task_perf_v1::*};
use reverie_core::ids::ProfileEmployeeId;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(super) struct Inputs {
    pub(super) policy: reverie_core::task_perf::TaskPerfPolicy,
    pub(super) image: String,
    pub(super) provenance: Value,
    pub(super) security: Vec<String>,
    pub(super) runtime: Vec<String>,
    pub(super) tools: PathBuf,
    pub(super) coreutils: PathBuf,
    pub(super) closure: Vec<PathBuf>,
    pub(super) core_closure: Vec<PathBuf>,
}
impl Inputs {
    pub(super) fn capture(policy: reverie_core::task_perf::TaskPerfPolicy) -> Self {
        let image =
            std::env::var("REVERIE_PERF_FIXTURE_IMAGE").expect("explicit actual immutable imageID");
        assert!(
            image
                .strip_prefix("sha256:")
                .is_some_and(|value| reverie_core::ids::ContainerId::parse(value).is_ok())
        );
        let provenance: Value =
            serde_json::from_slice(&immutable_file("REVERIE_PERF_FIXTURE_PROVENANCE", 65_536))
                .unwrap();
        assert_eq!(provenance["purpose"], "worker-image-provenance-v1");
        assert_eq!(provenance["version"], 1);
        for (key, value) in [
            ("uid", 1000),
            ("gid", 100),
            ("subuidStart", 100000),
            ("subgidStart", 100000),
            ("subidCount", 65536),
        ] {
            assert_eq!(provenance["factory"][key], value);
        }
        assert_eq!(provenance["factory"]["name"], "lib.workerDockerImage");
        let (security, runtime) = selected_policy(policy);
        let tools = package("REVERIE_PERF_FIXTURE_DOCKER_TOOLS");
        let coreutils = package("REVERIE_PERF_FIXTURE_COREUTILS");
        assert!(tools.join("bin/dockerd-rootless").is_file());
        assert!(tools.join("bin/docker").is_file());
        assert!(coreutils.join("bin/true").is_file());
        let closure = read_closure("REVERIE_PERF_FIXTURE_CLOSURE");
        let core_closure = read_closure("REVERIE_PERF_FIXTURE_CORE_CLOSURE");
        assert!(closure.contains(&tools) && closure.contains(&coreutils));
        assert!(core_closure.contains(&coreutils));
        Self {
            policy,
            image,
            provenance,
            security,
            runtime,
            tools,
            coreutils,
            closure,
            core_closure,
        }
    }
    pub(super) fn verify_image(&self) {
        let raw = docker::run(&["image", "inspect", &self.image]).unwrap();
        let rows: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 1);
        let row = &rows[0];
        assert_eq!(row["Id"], self.image);
        let expected = &self.provenance["imageSpec"];
        for name in ["Architecture", "Os", "RootFS"] {
            assert_eq!(row[name], expected[name], "{name}");
        }
        for (key, value) in expected["Config"].as_object().unwrap() {
            assert_eq!(&row["Config"][key], value, "{key}");
        }
        assert_eq!(expected["Config"]["User"], "1000:100");
        assert_eq!(expected["Created"], "1970-01-01T00:00:01+00:00");
        assert!(
            [
                "1970-01-01T00:00:01Z",
                "1970-01-01T00:00:01+00:00",
                "1970-01-01T00:00:01.000000000Z"
            ]
            .contains(&row["Created"].as_str().unwrap())
        );
        // archiveConfigSHA256 is deliberately NOT compared with Engine .Id:
        // Docker's containerd image store can expose a manifest digest as .Id.
        println!(
            "PERF_IMAGE_BOUND actual={} archiveConfig={}",
            self.image, self.provenance["archiveConfigSHA256"]
        );
    }
}
fn selected_policy(policy: reverie_core::task_perf::TaskPerfPolicy) -> (Vec<String>, Vec<String>) {
    let manifest = TaskPerfManifest::decode(
        &immutable_file("REVERIE_PERF_FIXTURE_POLICY", 65_536),
        PerfSystem::from_linux_uname("Linux", std::env::consts::ARCH).unwrap(),
    )
    .unwrap();
    assert_eq!(
        manifest.policy(),
        policy,
        "explicit test policy must match actual artifact"
    );
    let artifact = TaskPerfArtifactData::verify(
        manifest.clone(),
        &store_file(Path::new(manifest.base_profile()), 65_536),
        &store_file(Path::new(manifest.profile()), 65_536),
    )
    .unwrap();
    let employee = ProfileEmployeeId::parse("22222222-2222-4222-8222-222222222222").unwrap();
    let config = TaskPerfConfiguration::decode(&serde_json::to_vec(&json!({"uid":1000,"gid":100,"mounts":[],"employeePerfPolicies":{employee.as_str():policy.name()},"rootlessDocker":{"enabled":true,"seccompProfile":manifest.base_profile(),"seccompSha256":manifest.base_sha256()}})).unwrap()).unwrap();
    let projection = config.project(Some(&employee), Some(&artifact)).unwrap();
    assert!(projection.selected());
    let rootless = RootlessConfig::capture(projection.into_configuration()).unwrap();
    rootless
        .check_profile(
            &store_file(Path::new(manifest.profile()), 65_536),
            Some(&artifact),
        )
        .unwrap();
    let strings = |items: Vec<reverie_contracts::storage_identity::MetadataText>| {
        items
            .iter()
            .map(|value| value.scalar_text().unwrap())
            .collect()
    };
    (
        strings(rootless.security_args()),
        strings(rootless.runtime_args()),
    )
}
fn immutable_file(name: &str, maximum: usize) -> Vec<u8> {
    store_file(
        &PathBuf::from(std::env::var_os(name).expect("explicit reviewed fixture input")),
        maximum,
    )
}
fn store_file(path: &Path, maximum: usize) -> Vec<u8> {
    let path = native::canonical_in(path, Path::new("/nix/store")).unwrap();
    native::observe(&path, maximum, super::super::allowed_metadata).unwrap()
}
fn package(name: &str) -> PathBuf {
    let path =
        PathBuf::from(std::env::var_os(name).expect("explicit reviewed Nix fixture package"));
    let canonical = native::canonical_in(&path, Path::new("/nix/store")).unwrap();
    assert_eq!(path, canonical);
    assert_eq!(path.parent(), Some(Path::new("/nix/store")));
    path
}
fn read_closure(name: &str) -> Vec<PathBuf> {
    // Declared test metadata only, never an installed workload capability.
    let raw = fs::read(std::env::var_os(name).expect("exact Nix closure receipt")).unwrap();
    assert!(raw.len() <= 4_194_304);
    let data: Value = serde_json::from_slice(&raw).unwrap();
    let entries = data.as_object().unwrap();
    assert!(!entries.is_empty() && entries.len() <= 4096);
    let mut paths = Vec::new();
    for (name, metadata) in entries {
        let path = PathBuf::from(name);
        assert_eq!(path.parent(), Some(Path::new("/nix/store")));
        assert_eq!(fs::canonicalize(&path).unwrap(), path);
        for reference in metadata["references"].as_array().unwrap() {
            assert!(entries.contains_key(reference.as_str().unwrap()));
        }
        paths.push(path);
    }
    paths
}
