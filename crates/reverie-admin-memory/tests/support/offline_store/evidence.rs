use super::{BASE, EMPLOYEE, Fixture, SESSION, digest, employee, expiry, image};
use serde_json::{Value, json};
use std::{fs, io, path::Path};

impl Fixture {
    pub(crate) fn evidence(&self, isolated: bool) {
        let validation = "a".repeat(64);
        let receipts = self.evidence_receipts(isolated, &validation);
        let mut target = json!({
            "version":1,"kind":"reverie.worker-store-target","imageId":image(),
            "engineId":"fixture-engine","engineSocket":self.path("docker.sock"),
            "validationContainerId":validation,"baseTarget":BASE,"closurePaths":[BASE],
            "expiresAtEpoch": expiry(1800.0),
            "cohort":[{"employeeId":EMPLOYEE,"sessionId":SESSION,"sessionGeneration":1,
                "employeeDigest":digest(&serde_json::to_vec(&employee()).unwrap())}],
            "budget":{"fullClosureAllocatedBytes":1000,"overheadBytes":1000,"mainFloorBytes":1000,"scratchFloorBytes":1000},
            "receipts":receipts,
        });
        let mut validation = json!({
            "Id":validation, "Image":image(),"Name":"/validation",
            "State":{"Running":true,"Pid":10},"Mounts":[],
        });
        if isolated {
            target["validationScope"] = "VALIDATED_OFFLINE_IMAGE_TOOL_SHELL".into();
            validation["Config"] = json!({"User": user()});
            validation["HostConfig"] = host();
        }
        self.write_json("target.json", &target);
        self.write_json("validation.json", &validation);
        self.engine_rows();
    }

    fn evidence_receipts(&self, isolated: bool, validation: &str) -> Value {
        let mut references = json!({});
        for kind in ["D2", "CAN"] {
            let raw = format!("{kind}.txt");
            let report = if kind == "D2" {
                concat!(
                    "PASS shim body = F1 r7 / native bridge r5 (shebang line excluded)\n",
                    "PASS builder body = r5 (fixture)\nPASS cargo resolves to the shim\n",
                    "PASS shim sets CARGO_BUILD_JOBS=2\nPASS REVERIE_NO_AUTOENV=1 untouched\n",
                    "PASS explicit -j left as given\njobs=2\n",
                )
            } else {
                "GREP pos=0 neg=1 find=0\nSHIMS /opt/reverie/autoenv/bin/cargo /shim jobs=2\nCAN-DONE\n"
            };
            self.write(&raw, report.as_bytes());
            let mut data = json!({"version":1,"containerId":validation,
                "rawEvidencePath":self.path(&raw),"rawEvidenceDigest":digest(report.as_bytes())});
            if isolated {
                data["imageId"] = image().into();
                data["scope"] = "OFFLINE_IMAGE_TOOL_SHELL".into();
            } else {
                data["employeeId"] = EMPLOYEE.into();
            }
            if kind == "D2" {
                data["jobs"] = 2.into();
            } else {
                self.write("probe", b"actual fixture own-shell probe");
                data["probePath"] = json!(self.path("probe"));
                data["probeDigest"] = digest(b"actual fixture own-shell probe").into();
            }
            if kind == "CAN" && !isolated {
                data["ownToolShell"] = true.into();
                data["scope"] = "CURRENT_CODEX_TOOL_SHELL_ONLY".into();
            }
            let leaf = format!("{kind}.json");
            let bytes = serde_json::to_vec(&json!({"version":1,"kind":kind,"data":data})).unwrap();
            self.write(&leaf, &bytes);
            references[kind] = json!({"path":self.path(&leaf), "digest":digest(&bytes)});
        }
        references
    }

    fn engine_rows(&self) {
        let image_row = json!([{"Id":image(),"Config":{"User":user(),"Labels":{"reverie.worker.nix-store":"1"}}}]);
        self.write_json("image.json", &image_row);
        let stopped = json!({"Id":"b".repeat(64),"Image":format!("sha256:{}", "2".repeat(64)),
            "Name":"/old-laptop","State":{"Running":false,"Pid":0},
            "Mounts":[{"Type":"bind","Source":self.home,"Destination":"/home/agent","RW":true},
                      {"Type":"bind","Source":self.store,"Destination":"/nix","RW":true}],
        });
        self.write_json("stopped.json", &stopped);
        let mut running = stopped;
        running["State"] = json!({"Running":true,"Pid":2});
        self.write_json("running.json", &running);
        let mut helper = json!({
            "Id":"c".repeat(64),"Image":image(), "Name":format!("/fixture-nix-prepare-{SESSION}"),
            "Config":{"User":user(),"Entrypoint":["/bin/reverie-nix-store-prepare"],
                "Labels":{"reverie.nix-prepare":"fixture","reverie.session":SESSION,
                    "reverie.offline-store-operation":super::OPERATION}},
            "State":{"Running":false,"Pid":0,"Status":"created","ExitCode":0},
            "HostConfig":host(),
            "Mounts":[{"Type":"bind","Source":self.store,"Destination":"/target/nix","RW":true}],
        });
        self.write_json("created.json", &helper);
        helper["State"]["Status"] = "exited".into();
        self.write_json("exited.json", &helper);
        self.write("base.tar", &base_archive());
        let mut changed = employee();
        changed["onVacation"] = false.into();
        self.write_json(
            "changed-company.json",
            &json!({"employees":[changed],"retired":[]}),
        );
        self.write("foreign-fence.json", b"{\"foreign\":true}");
        self.write("replacement-lock", b"");
    }

    pub(crate) fn write_json(&self, leaf: &str, value: &Value) {
        self.write(leaf, &serde_json::to_vec(value).unwrap());
    }

    pub(crate) fn change(&self, leaf: &str, update: impl FnOnce(&mut Value)) {
        let mut data = serde_json::from_slice(&fs::read(self.path(leaf)).unwrap()).unwrap();
        update(&mut data);
        self.write_json(leaf, &data);
    }
}

fn user() -> String {
    format!("{}:{}", nix::unistd::getuid(), nix::unistd::getgid())
}

fn host() -> Value {
    json!({"ReadonlyRootfs":true,"NetworkMode":"none","Privileged":false,
        "CapDrop":["ALL"],"CapAdd":null,"Memory":536870912,"MemorySwap":536870912,
        "PidsLimit":128,"NanoCpus":1000000000,"RestartPolicy":{"Name":"no"},
        "SecurityOpt":["no-new-privileges:true"],
        "Tmpfs":{"/tmp":"rw,nosuid,nodev,size=268435456,mode=1777",
            "/nix/store/.links":"rw,nosuid,nodev,size=1048576,mode=1777"}})
}

fn base_archive() -> Vec<u8> {
    let mut tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_mode(0o777);
    header.set_size(0);
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_link_name(Path::new(BASE)).unwrap();
    tar.append_data(&mut header, "reverie-nix-base", io::empty())
        .unwrap();
    tar.into_inner().unwrap()
}
