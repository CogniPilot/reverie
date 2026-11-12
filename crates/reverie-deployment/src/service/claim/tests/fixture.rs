use super::*;
pub(super) struct Fixture {
    root: PathBuf,
    pub(super) service: DeploymentService,
    pub(super) previous: Operation,
    pub(super) next: Operation,
    pub(super) current: Value,
    _socket: UnixListener,
}
impl Fixture {
    pub(super) fn new(restored: bool) -> Self {
        let mut bytes = [0_u8; 16];
        getrandom::getrandom(&mut bytes).unwrap();
        let suffix = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let root = std::env::temp_dir().join(format!("claim-{suffix}"));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        installation::exclusive_json(
            &root.join("deployment.json"),
            &json!({"version":1,"containerName":"fixture","port":3000,"websiteRuntime":"default"}),
        )
        .unwrap();
        let socket = UnixListener::bind(root.join("engine.sock")).unwrap();
        let installation = Installation::capture(&root).unwrap();
        let service = DeploymentService {
            engine: Engine::new(&root.join("engine.sock")).unwrap(),
            installation,
        };
        let source = original();
        let previous = make_operation(&service, 'a', source.clone(), &image('e'), &image('f'));
        previous
            .record("candidate", &json!({"id":"b".repeat(64)}))
            .unwrap();
        previous
            .record(
                "prepared",
                &json!({"candidateId":"b".repeat(64),"validated":true}),
            )
            .unwrap();
        previous
            .record("unverified-backup-accepted", &json!({"accepted":true}))
            .unwrap();
        previous.record("ready", &json!({"containerId":"b".repeat(64),"mode":"hybrid-rust-front","brokerChanged":false,"backupVerified":false})).unwrap();
        let mut current = source;
        if restored {
            previous.attempt("rollback-attempt").unwrap();
            previous.record("restored", &json!({"containerId":current["Id"],"dataRestored":false,"brokerChanged":false})).unwrap();
        } else {
            current["Id"] = json!("b".repeat(64));
            current["Image"] = image('f')["Id"].clone();
            current["Config"] = previous.plan.body.clone();
            current["Config"]
                .as_object_mut()
                .unwrap()
                .remove("HostConfig");
            current["Config"]
                .as_object_mut()
                .unwrap()
                .remove("NetworkingConfig");
            current["HostConfig"] = previous.plan.body["HostConfig"].clone();
        }
        let next = make_operation(
            &service,
            'c',
            current.clone(),
            &image(if restored { 'e' } else { 'f' }),
            &image('d'),
        );
        let fixture = Self {
            root,
            service,
            previous,
            next,
            current,
            _socket: socket,
        };
        fs::write(
            fixture.claim_path(),
            format!(
                "{{ \"operation\" : \"{}\" }}\n",
                fixture.previous.plan.operation
            ),
        )
        .unwrap();
        fs::set_permissions(fixture.claim_path(), fs::Permissions::from_mode(0o600)).unwrap();
        fixture
    }
    pub(super) fn claim_path(&self) -> PathBuf {
        self.service
            .installation
            .state
            .join("console-deployment-active.json")
    }
    pub(super) fn claim_bytes(&self) -> Vec<u8> {
        fs::read(self.claim_path()).unwrap()
    }
    pub(super) fn active(&self) -> String {
        serde_json::from_slice::<Value>(&self.claim_bytes()).unwrap()["operation"]
            .as_str()
            .unwrap()
            .into()
    }
    pub(super) fn close(&mut self) {
        self.service.close().unwrap();
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn image(letter: char) -> Value {
    json!({"Id":format!("sha256:{}",letter.to_string().repeat(64)),"Config":{"Env":["REVERIE_NATIVE_FRONT=1"],"Entrypoint":["entry"],"Cmd":["web"],"Volumes":null}})
}
fn original() -> Value {
    let mut config = image('e')["Config"].clone();
    config["Image"] = image('e')["Id"].clone();
    json!({"Id":"a".repeat(64),"Name":"/fixture","Image":image('e')["Id"],"Config":config,
        "State":{"Running":true,"Paused":false,"Restarting":false,"Dead":false,"Pid":42,"StartedAt":"epoch"},
        "HostConfig":{"Binds":["/source:/target:ro,rslave"],"AutoRemove":false,"Privileged":false,"NetworkMode":"bridge"},
        "NetworkSettings":{"Networks":{"bridge":{}}},
        "Mounts":[{"Type":"bind","Source":"/source","Destination":"/target","RW":false,"Propagation":"rslave","Mode":"ro,rslave"}]})
}
fn make_operation(
    service: &DeploymentService,
    letter: char,
    source: Value,
    old: &Value,
    next: &Value,
) -> Operation {
    let id = letter.to_string().repeat(32);
    let (body, refreshed) = model::create_body(&source, old, next).unwrap();
    let preview = DeploymentPreview {
        operation: id.clone(),
        container: "fixture".into(),
        source_id: source["Id"].as_str().unwrap().into(),
        source_image: source["Image"].as_str().unwrap().into(),
        candidate_image: next["Id"].as_str().unwrap().into(),
        environment_policy: "fixture".into(),
        refreshed_environment_keys: refreshed,
        broker_preserved: true,
        backup_metadata_scope: "fixture".into(),
        profile: None,
    };
    Operation::create(
        &service.installation.state,
        Plan {
            version: 1,
            operation: id,
            container: "fixture".into(),
            installation_revision: service.installation.revision.clone(),
            source,
            body,
            preview,
            bind_identities: Vec::new(),
        },
    )
    .unwrap()
}
