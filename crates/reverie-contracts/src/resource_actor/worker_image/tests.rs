use super::*;
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};
fn sha(raw: &[u8]) -> String { format!("{:x}", Sha256::digest(raw)) }
fn pin(path: &str, bytes: &[u8]) -> Json { json!({"path":path,"sha256":sha(bytes),"bytes":bytes.len()}) }
fn inputs() -> (ArtifactReference, Vec<u8>, Json) {
    let program=json!({"version":1,"purpose":"worker-child-program-v1","abi":"record-pane-exit-v1","program":pin("/nix/store/fixture-child/bin/child",b"ELF"),"elfMachine":62});
    let raw=serde_json::to_vec(&program).unwrap();
    let manifest=pin("/nix/store/fixture-manifest/worker-child.json",&raw);
    let image=json!({"Config":{"User":"1000:100","Entrypoint":["/bin/sleep"],"Cmd":["infinity"],"WorkingDir":"/reverie_workspace","Labels":{"org.reverie.worker.child-manifest":manifest["path"],"org.reverie.worker.uid":"1000","org.reverie.worker.gid":"100","org.reverie.worker.rootless-docker":"1","org.reverie.worker.rootless-docker.mount-layout":"1","org.reverie.worker.subuid-start":"100000","org.reverie.worker.subgid-start":"100000","org.reverie.worker.subid-count":"65536","reverie.worker.nix-store":"1"}},"RootFS":{"Type":"layers","Layers":[format!("sha256:{}","d".repeat(64))]},"Architecture":"amd64","Os":"linux","Created":"1970-01-01T00:00:01Z"});
    let factory=json!({"name":"lib.workerDockerImage","system":"x86_64-linux","uid":1000,"gid":100,"subuidStart":100000,"subgidStart":100000,"subidCount":65536,"browser":false});
    let archive=pin("/nix/store/fixture-image.tar",b"archive");
    let base=json!({"version":1,"purpose":"worker-image-provenance-v1","archiveConfigSHA256":"a".repeat(64),"imageSpec":image,"archive":archive,"factory":factory,"source":{"path":"/nix/store/fixture-source","factoryFiles":{"nix/image.nix":{"sha256":"b".repeat(64),"bytes":10}}},"toolkit":{"version":1,"static":true,"manifest":pin("/nix/store/fixture-toolkit/manifest.json",b"manifest"),"files":{"/opt/reverie/human/bin/bash":{"sha256":"c".repeat(64),"bytes":11},"/opt/reverie/human/bin/reverie-human-shell":{"sha256":"e".repeat(64),"bytes":12}}}});
    let bytes=serde_json::to_vec(&base).unwrap();
    let selected=ArtifactReference{path:PythonText::from_scalar_text("/nix/store/fixture-base/worker-image.json"),sha256:JournalDigest::parse(&sha(&bytes)).unwrap()};
    let mut child=program; child["manifest"]=manifest;
    let annex=json!({"version":1,"purpose":"worker-child-image-v1","baseProvenance":pin("/nix/store/fixture-base/worker-image.json",&bytes),"archiveConfigSHA256":base["archiveConfigSHA256"],"archive":base["archive"],"imageSpec":base["imageSpec"],"factory":base["factory"],"workerChild":child});
    (selected,bytes,annex)
}
fn decode(base:&ArtifactReference,raw:&[u8],annex:&Json)->Result<WorkerImageProvenance>{WorkerImageProvenance::decode(base,raw,&serde_json::to_vec(annex).unwrap())}
#[test]
fn exact_worker_base_child_and_actual_full_image_join_is_data_only(){
    let (base,raw,annex)=inputs(); let selected=decode(&base,&raw,&annex).unwrap();
    let mut actual=annex["imageSpec"].clone();actual["Id"]=json!(format!("sha256:{}","a".repeat(64)));
    let engine=EngineMetadata::decode(&serde_json::to_vec(&actual).unwrap()).unwrap();
    assert_eq!(engine.qualify_worker_image(&selected).unwrap(),actual["Id"]);
    selected.require_program_manifest(&serde_json::to_vec(&{let mut p=annex["workerChild"].clone();p.as_object_mut().unwrap().remove("manifest");p}).unwrap()).unwrap();
    actual["Config"]["User"]=json!("0:0");
    assert!(EngineMetadata::decode(&serde_json::to_vec(&actual).unwrap()).unwrap().qualify_worker_image(&selected).is_err());
}
#[test]
fn worker_annex_refuses_cross_construction_or_program_manifest_substitution(){
    let(base,raw,annex)=inputs();
    for path in ["archiveConfigSHA256","archive","factory","imageSpec","baseProvenance"] {let mut changed=annex.clone();changed[path]=Json::Null;assert!(decode(&base,&raw,&changed).is_err(),"{path}");}
    let mut changed=annex.clone();changed["workerChild"]["manifest"]["path"]=json!("/nix/store/foreign/manifest.json");assert!(decode(&base,&raw,&changed).is_err());
    let selected=decode(&base,&raw,&annex).unwrap();assert!(selected.require_program_manifest(b"{}").is_err());
    let mut other=raw.clone();other.push(b' ');assert!(decode(&base,&other,&annex).is_err());
}
#[test]
fn worker_annex_closed_integer_version_abi_and_machine_refusals(){
    let(base,raw,annex)=inputs();
    for bad in [json!(true),json!(1.0),json!("1"),json!(2)] {let mut changed=annex.clone();changed["version"]=bad;assert!(decode(&base,&raw,&changed).is_err());}
    for (key,value) in [("abi",json!("legacy")),("elfMachine",json!(183)),("extra",json!(true))] {let mut changed=annex.clone();changed["workerChild"][key]=value;assert!(decode(&base,&raw,&changed).is_err());}
}
