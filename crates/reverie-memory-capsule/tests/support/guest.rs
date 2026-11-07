use super::capture::capture;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::process::CommandExt,
    path::Path,
    process::{Command, Output},
    time::Duration,
};
#[path = "database.rs"]
mod database;
#[path = "http_fixture.rs"]
mod http_fixture;
#[path = "mcp.rs"]
mod mcp;
const PREFIX: &str = "/opt/reverie/memory";

fn command(program: &str) -> Command {
    let mut command = Command::new(format!("{PREFIX}/bin/{program}"));
    command
        .uid(1000)
        .gid(1000)
        .current_dir("/home/agent")
        .env_clear()
        .env("HOME", "/home/agent")
        .env("PATH", "/home/agent/bin")
        .env(
            "REVERIE_INSTANCE_CONFIG",
            "/home/agent/config/instance.json",
        )
        .env(
            "REVERIE_MCP_MEMORY_INSTANCE",
            "/home/agent/config/instance.json",
        )
        .env("REVERIE_EMBED_DIMS", "8");
    command
}
fn run(command: &mut Command, input: &[u8]) -> Output {
    capture(command, input, Duration::from_secs(20))
}
fn memory(value: &Value) -> Output {
    run(
        &mut command("reverie-memory"),
        &serde_json::to_vec(value).unwrap(),
    )
}
fn success(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn initialize() {
    let output = run(command("node").args(["-e", "const fs=require('node:fs');fs.mkdirSync('/home/agent/config');fs.copyFileSync('/fixture/legacy-instance.json','/home/agent/config/instance.json');"]), &[]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let absent = memory(&json!({"action":"recall","private":true,"query":"synthetic"}));
    assert!(!absent.status.success());
    assert!(String::from_utf8_lossy(&absent.stderr).contains("initialized"));
    assert!(
        !Path::new("/home/agent/state").exists(),
        "read never initializes state"
    );
    let output = run(command("node").args(["-e", "const fs=require('node:fs');fs.mkdirSync('/home/agent/state',{mode:0o700});for(const [source,name] of [['legacy-memory.sqlite','memory.sqlite'],['legacy-profile.md','profile.md']]){const p='/home/agent/state/'+name;fs.copyFileSync('/fixture/'+source,p);fs.chmodSync(p,0o600);}"]),&[]);
    assert!(output.status.success());
    let original = Snapshot::capture();
    let absent =
        memory(&json!({"action":"recall","private":true,"query":"synthetic capsule anchor"}));
    assert!(!absent.status.success());
    assert!(String::from_utf8_lossy(&absent.stderr).contains("initialized"));
    original.assert_unchanged();
    let legacy = database::snapshot();
    assert_eq!(
        success(&run(command("reverie-memory").arg("--initialize"), &[])),
        json!({"initialized": true})
    );
    database::assert_existing_preserved(&legacy, &database::snapshot());
    original.assert_profile_configuration_unchanged();
    let snapshot = Snapshot::capture();
    let ready = database::snapshot();
    assert_eq!(
        success(&run(command("reverie-memory").arg("--initialize"), &[])),
        json!({"initialized": true})
    );
    database::assert_repeat_preserved(&ready, &database::snapshot());
    snapshot.assert_profile_configuration_unchanged();
}
struct Snapshot(Vec<Vec<u8>>);
impl Snapshot {
    const FILES: [&str; 3] = [
        "/home/agent/state/memory.sqlite",
        "/home/agent/state/profile.md",
        "/home/agent/config/instance.json",
    ];
    fn capture() -> Self {
        Self(
            Self::FILES
                .iter()
                .map(|path| fs::read(path).unwrap())
                .collect(),
        )
    }
    fn assert_unchanged(&self) {
        self.check(0);
    }
    fn assert_profile_configuration_unchanged(&self) {
        self.check(1);
    }
    fn check(&self, first: usize) {
        for (path, before) in Self::FILES.iter().zip(&self.0).skip(first) {
            let after = fs::read(path).unwrap();
            assert!(
                after == *before,
                "existing synthetic bytes changed: {path}; before {:x}, after {:x}",
                Sha256::digest(before),
                Sha256::digest(&after)
            );
        }
    }
}
fn requests(calls: &[(u64, &str, Value)]) -> Vec<Value> {
    let mut frames = vec![
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"owned-capsule-qualification","version":"1"}}}),
    ];
    frames.push(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
    for (id, method, params) in calls {
        frames.push(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
    }
    frames
}
fn replies(output: &Output) -> Vec<Value> {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
        .stdout
        .split(|&byte| byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect()
}
fn reply(values: &[Value], id: u64) -> &Value {
    let matched = values.iter().filter(|v| v["id"] == id).collect::<Vec<_>>();
    assert_eq!(
        matched.len(),
        1,
        "exactly one actual protocol response: {values:?}"
    );
    assert!(
        matched[0].get("error").is_none(),
        "actual protocol error: {}",
        matched[0]
    );
    matched[0]
}
fn injection_environment(command: &mut Command) {
    command
        .env("LD_PRELOAD", "/home/agent/missing-preload.so")
        .env("LD_LIBRARY_PATH", "/home/agent/bad-libraries")
        .env("NODE_OPTIONS", "--require=/home/agent/owned-preload.cjs")
        .env("NODE_PATH", "/home/agent/.node_modules")
        .env("NODE_COMPILE_CACHE", "/home/agent/compiled-cache")
        .env("OPENSSL_CONF", "/home/agent/missing-openssl.cnf");
}
fn origins_and_preloads() -> Value {
    system_preload_control();
    fs::write(
        "/home/agent/owned-preload.cjs",
        "require('node:fs').writeFileSync('/home/agent/preload-ran', 'bad');",
    )
    .unwrap();
    let output = run(command("node").args(["-e", "const fs=require('node:fs'); console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid()})); for(const p of ['/opt/reverie/memory/bin/node','/opt/reverie/memory/bin/reverie-memory']) { try { fs.chmodSync(p,0o755); throw Error('chmod unexpectedly succeeded'); } catch(e) {if(!['EPERM','EROFS','EACCES'].includes(e.code))throw e;} } require('/opt/reverie/memory/console/node_modules/node-pty');"]), &[]);
    let identity = success(&output);
    assert!(
        output.stderr.is_empty(),
        "fixed capsule loader must ignore the synthetic system preload: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(identity, json!({"uid":1000,"gid":1000}));
    let mut positive = command("node");
    positive.args([
        "-e",
        "console.log(JSON.stringify({cache:require('node:module').getCompileCacheDir()}))",
    ]);
    injection_environment(&mut positive);
    positive.env_remove("OPENSSL_CONF");
    let positive = run(&mut positive, &[]);
    assert!(positive.status.success());
    assert!(
        fs::metadata("/home/agent/preload-ran").is_ok(),
        "negative control detects Node autoload"
    );
    assert!(String::from_utf8_lossy(&positive.stderr).contains("missing-preload.so"));
    assert!(
        success(&positive)["cache"]
            .as_str()
            .unwrap()
            .starts_with("/home/agent/compiled-cache/")
    );
    assert!(Path::new("/home/agent/compiled-cache").is_dir());
    fs::remove_file("/home/agent/preload-ran").unwrap();
    fs::remove_dir_all("/home/agent/compiled-cache").unwrap();
    identity
}

fn system_preload_control() {
    const MISSING: &str = "/home/agent/missing-system-preload.so";
    assert!(!Path::new(MISSING).exists());
    fs::write("/etc/ld-nix.so.preload", format!("{MISSING}\n")).unwrap();
    let output = run(
        Command::new("/fixture/original-loader")
            .uid(1000)
            .gid(1000)
            .env_clear()
            .args([
                "--library-path",
                "/opt/reverie/memory/lib",
                "/opt/reverie/memory/bin/node",
                "-e",
                "console.log('original-loader-positive')",
            ]),
        &[],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let warning = String::from_utf8_lossy(&output.stderr);
    assert!(warning.contains(MISSING) && warning.contains("/etc/ld-nix.so.preload"));
    assert_eq!(output.stdout, b"original-loader-positive\n");
}
fn global_module_decoys() {
    fs::create_dir_all("/home/agent/.node_modules/capsule-decoy").unwrap();
    fs::write(
        "/home/agent/.node_modules/capsule-decoy/index.js",
        "require('node:fs').writeFileSync('/home/agent/global-module-ran','bad');",
    )
    .unwrap();
    let positive = run(
        command("node")
            .args(["-e", "require('capsule-decoy')"])
            .env("NODE_PATH", "/home/agent/.node_modules"),
        &[],
    );
    assert!(positive.status.success());
    assert!(Path::new("/home/agent/global-module-ran").exists());
    fs::remove_file("/home/agent/global-module-ran").unwrap();
    let negative = run(command("node").args(["--no-global-search-paths","-e","try {require('capsule-decoy');throw Error('untrusted fallback')} catch(e) {if(e.code!=='MODULE_NOT_FOUND')throw e; console.log('closed')} "]).env("NODE_PATH","/home/agent/.node_modules"),&[]);
    assert!(
        negative.status.success(),
        "{}",
        String::from_utf8_lossy(&negative.stderr)
    );
    assert_eq!(negative.stdout, b"closed\n");
    assert!(!Path::new("/home/agent/global-module-ran").exists());
}
fn actual_mcp_readonly() -> Value {
    let database = fs::read("/home/agent/state/memory.sqlite").unwrap();
    let profile = fs::read("/home/agent/state/profile.md").unwrap();
    let configuration = fs::read("/home/agent/config/instance.json").unwrap();
    let mut selected = command("reverie-mcp");
    injection_environment(&mut selected);
    let output = mcp::run(
        &mut selected,
        &requests(&[
            (2, "tools/list", json!({})),
            (
                3,
                "tools/call",
                json!({"name":"memory_recall","arguments":{"query":"synthetic"}}),
            ),
        ]),
        Duration::from_secs(20),
    );
    assert!(
        output.stderr.is_empty(),
        "static entry and fixed Node must not process injected loader settings: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let values = replies(&output);
    let tools = reply(&values, 2)["result"]["tools"].as_array().unwrap();
    assert!(tools.iter().any(|v| v["name"] == "memory_recall"));
    assert_ne!(reply(&values, 3)["result"]["isError"], true);
    let memory_text = reply(&values, 3)["result"]["content"][0]["text"]
        .as_str()
        .unwrap();
    let recalled = serde_json::from_str::<Value>(memory_text).unwrap();
    assert!(
        recalled.is_array(),
        "actual native recall data must be decoded"
    );
    assert!(
        recalled
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == 42
                && item["text"]
                    == "synthetic capsule anchor memory preserves existing vector bytes"),
        "actual original Python-created memory must be recalled: {recalled}"
    );
    assert!(!Path::new("/home/agent/preload-ran").exists());
    assert!(!Path::new("/home/agent/compiled-cache").exists());
    assert_eq!(
        fs::read("/home/agent/state/memory.sqlite").unwrap(),
        database
    );
    assert_eq!(fs::read("/home/agent/state/profile.md").unwrap(), profile);
    assert_eq!(
        fs::read("/home/agent/config/instance.json").unwrap(),
        configuration
    );
    let refused = memory(
        &json!({"action":"recall","private":true,"query":"synthetic","database":"/home/agent/foreign.sqlite"}),
    );
    assert!(!refused.status.success());
    assert!(refused.stdout.is_empty());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("unsupported"));
    assert!(!Path::new("/home/agent/foreign.sqlite").exists());
    json!({"tools":tools.len(),"replies":values.len(),"databaseProfileConfigurationUnchanged":true})
}
fn loopback_transport() -> Value {
    // This is a controlled transport responder, not Company/ServiceGrant or
    // Office qualification. No Parent-Session or global key is manufactured.
    let fixture = http_fixture::Fixture::new(false);
    let mut selected = command("reverie-mcp");
    selected
        .env("REVERIE_API_URL", fixture.url())
        .env("REVERIE_USERNAME", "capsule-user")
        .env("REVERIE_PASSWORD", "fixture-password");
    let output = mcp::run(
        &mut selected,
        &requests(&[(
            2,
            "tools/call",
            json!({"name":"list_sessions","arguments":{}}),
        )]),
        Duration::from_secs(20),
    );
    let values = replies(&output);
    assert_ne!(reply(&values, 2)["result"]["isError"], true);
    assert!(
        serde_json::to_string(&reply(&values, 2)["result"])
            .unwrap()
            .contains("owned-transport-session")
    );
    let received = fixture.finish();
    assert_eq!(received.len(), 1);
    assert!(received[0].starts_with("GET /api/v1/sessions "));
    let fixture = http_fixture::Fixture::new(true);
    let mut selected = command("reverie-memory");
    selected
        .env("REVERIE_API_URL", fixture.url())
        .env("REVERIE_USERNAME", "capsule-user")
        .env("REVERIE_PASSWORD", "fixture-password")
        .env("REVERIE_SESSION_ID", "10000000-0000-4000-8000-000000000001")
        .env("REVERIE_MUX", "1")
        .env("REVERIE_NO_AUTOSTART", "1");
    injection_environment(&mut selected);
    let output = run(&mut selected,&serde_json::to_vec(&json!({"action":"remember","private":true,"text":"A synthetic decision","room":"20000000-0000-4000-8000-000000000001","turn":"20000000-0000-4000-8000-000000000002","tag":"decision","quote":"exact synthetic words"})).unwrap());
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let received = fixture.finish();
    assert_eq!(received.len(), 1, "no transport retry/replay");
    assert!(received[0].starts_with("POST "));
    assert!(!fs::exists("/home/agent/preload-ran").unwrap());
    assert!(!Path::new("/home/agent/compiled-cache").exists());
    json!({"mcpGet":1,"nativeRawConsoleJournalRefusedPost":1,"authority":"transport-only-no-grant"})
}

pub(super) fn qualify() {
    initialize();
    let snapshot = Snapshot::capture();
    let identity = origins_and_preloads();
    global_module_decoys();
    let readonly = actual_mcp_readonly();
    let transport = loopback_transport();
    snapshot.assert_unchanged();
    fs::write("/fixture/result.json",serde_json::to_vec_pretty(&json!({"identity":identity,"readonly":readonly,"transport":transport,"scope":"owned namespace only; no Created/Office/context/OCI/adoption"})).unwrap()).unwrap();
}
