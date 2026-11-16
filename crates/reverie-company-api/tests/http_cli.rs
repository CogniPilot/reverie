//! Actual Rust service + HTTP transport + compiled Rust CLI. No Node/Python PATH.
use reverie_company_api::{client, initialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

struct Fixture {
    root: PathBuf,
    instance: PathBuf,
    empty_path: PathBuf,
    child: Child,
    address: SocketAddr,
    owner: String,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "reverie-company-http-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let instance = root.join("company");
        initialize(&instance).unwrap();
        let owner = client::credential(&instance.join("owner-credential.json")).unwrap();
        let empty_path = root.join("empty-path");
        fs::create_dir(&empty_path).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_reverie-company"))
            .args(["serve", "--fresh-company", instance.to_str().unwrap()])
            .env_clear()
            .env("PATH", &empty_path)
            .env("HOME", &root)
            .env("TMPDIR", &root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let ready: Value = serde_json::from_str(&line).unwrap();
        let address = ready["listening"].as_str().unwrap().parse().unwrap();
        Self {
            root,
            instance,
            empty_path,
            child,
            address,
            owner,
        }
    }
    async fn post(&self, token: &str, path: &str, value: Value) -> Value {
        client::call(self.address, token, "POST", path, Some(value))
            .await
            .unwrap()
    }
    fn cli(
        &self,
        method: &str,
        path: &str,
        request: Option<&str>,
        body: Option<&Value>,
    ) -> std::process::Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-company"));
        command.args([
            "call",
            "--address",
            &self.address.to_string(),
            "--credential",
            self.instance
                .join("owner-credential.json")
                .to_str()
                .unwrap(),
            "--method",
            method,
            "--path",
            path,
        ]);
        if let Some(id) = request {
            command.args(["--request-id", id]);
        }
        let mut child = command
            .env_clear()
            .env("PATH", &self.empty_path)
            .env("HOME", &self.root)
            .env("TMPDIR", &self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(value) = body {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(&serde_json::to_vec(value).unwrap())
                .unwrap();
        } else {
            drop(child.stdin.take());
        }
        child.wait_with_output().unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}
async fn reject_role_and_stale_scopes(f: &Fixture, agent: &str, office: &str, scope: &Value) {
    for invalid in [
        json!({"requestId":id(40),"scope":scope,"action":"leave","role":"owner"}),
        json!({"requestId":id(41),"scope":{"sessionId":scope["sessionId"],"sessionGeneration":2},"action":"leave"}),
        json!({"requestId":id(42),"scope":{"sessionId":id(43),"sessionGeneration":1},"action":"leave"}),
    ] {
        assert_eq!(f.post(agent, office, invalid).await["success"], false);
    }
}
fn assert_held(held: &Value) {
    assert_eq!(held["data"]["phase"], "held");
    assert_eq!(held["data"]["effectIssued"], false);
    assert_eq!(held["data"]["nativeState"], "unobserved");
    assert_eq!(held["data"]["allowedActions"], json!([]));
}
#[tokio::test]
async fn genuine_credentials_grants_revocation_and_held_originals_use_actual_http() {
    let f = Fixture::new();
    let request = id(1);
    let registered = f
        .post(
            &f.owner,
            "/api/company/employees",
            json!({"requestId":request,"name":"Synthetic"}),
        )
        .await;
    assert_eq!(registered["data"]["phase"], "registered");
    assert_eq!(registered["data"]["nativeState"], "unobserved");
    let employee = registered["data"]["employeeId"].as_str().unwrap();
    let scope = json!({"sessionId":registered["data"]["sessionId"],"sessionGeneration":1});
    let agent = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let office = format!("/api/company/employees/{employee}/office/operations");
    let unauth = f
        .post(
            agent,
            &office,
            json!({"requestId":id(2),"scope":scope,"action":"leave","role":"owner"}),
        )
        .await;
    assert_eq!(unauth["success"], false);
    let enrolled = f
        .post(
            &f.owner,
            &format!("/api/company/employees/{employee}/credential"),
            json!({"requestId":id(3),"scope":scope,"secret":agent}),
        )
        .await;
    assert_eq!(enrolled["data"]["phase"], "credential-registered");
    let body = json!({"requestId":id(4),"scope":scope,"action":"leave"});
    assert_eq!(
        f.post(agent, &office, body.clone()).await["code"],
        "MANAGE_OFFICE_REQUIRED"
    );
    let grant = f
        .post(
            &f.owner,
            &format!("/api/company/employees/{employee}/manage-office"),
            json!({"requestId":id(5),"scope":scope,"enabled":true}),
        )
        .await;
    assert_eq!(grant["data"]["manageOffice"], true);
    reject_role_and_stale_scopes(&f, agent, &office, &scope).await;
    let held = f.post(agent, &office, body.clone()).await;
    assert_held(&held);
    assert_eq!(f.post(agent, &office, body.clone()).await, held);
    assert_eq!(
        f.post(
            agent,
            &office,
            json!({"requestId":id(4),"scope":scope,"action":"restart"})
        )
        .await["code"],
        "ORIGINAL_REQUEST_CONFLICT"
    );
    let original = client::call(
        f.address,
        agent,
        "GET",
        &format!("/api/company/operations/{}", id(4)),
        None,
    )
    .await
    .unwrap();
    assert_eq!(original, held);
    f.post(
        &f.owner,
        &format!("/api/company/employees/{employee}/manage-office"),
        json!({"requestId":id(6),"scope":scope,"enabled":false}),
    )
    .await;
    assert_eq!(
        f.post(
            agent,
            &office,
            json!({"requestId":id(7),"scope":scope,"action":"enter"})
        )
        .await["code"],
        "MANAGE_OFFICE_REQUIRED"
    );
    assert_eq!(
        client::call(
            f.address,
            agent,
            "GET",
            &format!("/api/company/operations/{}", id(4)),
            None
        )
        .await
        .unwrap(),
        held
    );
    let rows = client::call(f.address, &f.owner, "GET", "/api/company/employees", None)
        .await
        .unwrap();
    assert_eq!(rows["data"]["employees"][0]["onVacation"], true);
    assert_eq!(rows["data"]["employees"][0]["desiredRunning"], false);
}
#[tokio::test]
async fn actual_http_rejects_mixed_credentials_and_duplicate_typed_body_fields() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let f = Fixture::new();
    let before = fs::read(f.instance.join("company.json")).unwrap();
    let body = format!(r#"{{"requestId":"{}","name":"one","name":"two"}}"#, id(50));
    for (headers, payload, expected) in [
        (String::new(), body.as_str(), "INVALID_REQUEST"),
        (
            "Cookie: actor=owner\r\n".into(),
            "{}",
            "CREDENTIAL_REQUIRED",
        ),
        (
            format!("Authorization: Bearer {}\r\n", f.owner),
            "{}",
            "CREDENTIAL_REQUIRED",
        ),
        (
            "X-Reverie-Worker-Identity: forged\r\n".into(),
            "{}",
            "CREDENTIAL_REQUIRED",
        ),
    ] {
        let mut stream = tokio::net::TcpStream::connect(f.address).await.unwrap();
        stream.write_all(format!("POST /api/company/employees HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\n{headers}Content-Length: {}\r\n\r\n{payload}", f.owner, payload.len()).as_bytes()).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            stream.read_to_end(&mut response),
        )
        .await
        .unwrap()
        .unwrap();
        let text = String::from_utf8(response).unwrap();
        let value: Value = serde_json::from_str(text.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(value["code"], expected);
        assert!(!text.contains(&f.owner));
    }
    assert_eq!(fs::read(f.instance.join("company.json")).unwrap(), before);
}
#[tokio::test]
async fn actual_cli_needs_no_node_or_python_and_never_reports_held_as_native_success() {
    let f = Fixture::new();
    let request = id(10);
    let output = f.cli(
        "post",
        "/api/company/employees",
        Some(&request),
        Some(&json!({"requestId":request,"name":"CLI fixture"})),
    );
    assert!(output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains(&f.owner));
    let registered: Value = serde_json::from_slice(&output.stdout).unwrap();
    let employee = registered["data"]["employeeId"].as_str().unwrap();
    let bad = f.cli(
        "post",
        "/api/company/employees",
        Some(&id(99)),
        Some(&json!({"requestId":id(99),"name":"bad","role":"owner"})),
    );
    assert_eq!(bad.status.code(), Some(3));
    assert_eq!(
        serde_json::from_slice::<Value>(&bad.stdout).unwrap()["requestId"],
        id(99)
    );
    for (action, n) in [
        ("leave", 11),
        ("enter", 12),
        ("restart", 13),
        ("retire", 14),
    ] {
        let request = id(n);
        let body = json!({"requestId":request,"scope":{"sessionId":registered["data"]["sessionId"],"sessionGeneration":1},"action":action});
        let output = f.cli(
            "post",
            &format!("/api/company/employees/{employee}/office/operations"),
            Some(&request),
            Some(&body),
        );
        assert_eq!(output.status.code(), Some(4));
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["data"]["blocker"], "NATIVE_LIFECYCLE_UNIMPLEMENTED");
        assert_eq!(result["data"]["requestId"], request);
    }
    assert!(fs::read_dir(&f.empty_path).unwrap().next().is_none());
    let qualification = Command::new(env!("CARGO_BIN_EXE_reverie-company"))
        .args(["qualification", "--require-complete"])
        .env_clear()
        .env("PATH", &f.empty_path)
        .output()
        .unwrap();
    assert_eq!(qualification.status.code(), Some(78));
    assert_eq!(
        serde_json::from_slice::<Value>(&qualification.stdout).unwrap()["fullLifecycleQualified"],
        false
    );
}
