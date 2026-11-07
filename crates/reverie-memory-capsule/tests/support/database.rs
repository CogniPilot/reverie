//! Test-only snapshots of the one owned synthetic SQLite file. No runtime SQL
//! surface or dependency is added to the capsule producer or memory services.
use super::{command, run, success};
use serde_json::{Value, json};
const MODEL: &str = "native_memory_embed_model_v1";
const READY: &str = "native_memory_startup_v1";

pub(super) fn snapshot() -> Value {
    let output = run(command("node").args(["-e", r#"
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/home/agent/state/memory.sqlite',{readOnly:true});
function cell(v){
 if(v===null)return ['null'];
 if(typeof v==='bigint')return ['integer',v.toString()];
 if(typeof v==='number'){const b=Buffer.alloc(8);b.writeDoubleBE(v);return ['real',b.toString('hex')];}
 if(typeof v==='string')return ['text',v];
 if(v instanceof Uint8Array)return ['blob',Buffer.from(v).toString('hex')];
 throw Error('unclassified SQLite cell');
}
let result;
try{
 const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 const tables={};
 for(const table of schema.filter(r=>r.type==='table')){
  const name='"'+table.name.replaceAll('"','""')+'"';
  const statement=db.prepare('SELECT rowid AS "__owned_rowid__",* FROM '+name+' ORDER BY rowid');
  statement.setReadBigInts(true);statement.setReturnArrays(true);
  tables[table.name]={columns:statement.columns().map(c=>c.name),rows:statement.all().map(r=>r.map(cell))};
 }
 result={schema,tables,userVersion:db.prepare('PRAGMA user_version').get().user_version};
}finally{db.close();}
console.log(JSON.stringify(result));
"#]), &[]);
    success(&output)
}
fn marker(row: &Value, key: usize) -> Option<&str> {
    let text = row[key].as_array()?;
    (text.first()?.as_str()? == "text")
        .then(|| text[1].as_str())
        .flatten()
}
fn state_key(value: &Value) -> usize {
    value["tables"]["state"]["columns"]
        .as_array()
        .unwrap()
        .iter()
        .position(|name| name == "key")
        .unwrap()
}
pub(super) fn assert_existing_preserved(before: &Value, after: &Value) {
    let key = state_key(before);
    assert!(
        before["tables"]["state"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| !matches!(marker(row, key), Some(MODEL | READY)))
    );
    let mut copied = after.clone();
    let value = copied["tables"]["state"]["columns"]
        .as_array()
        .unwrap()
        .iter()
        .position(|name| name == "value")
        .unwrap();
    let rows = copied["tables"]["state"]["rows"].as_array_mut().unwrap();
    let mut added = 0;
    rows.retain(|row| match marker(row, key) {
        Some(MODEL) => {
            assert_eq!(row[value], json!(["text", "hashed-v1-8"]));
            added += 1;
            false
        }
        Some(READY) => {
            assert_eq!(row[value], json!(["text", "ready"]));
            added += 1;
            false
        }
        _ => true,
    });
    assert_eq!(
        added, 2,
        "only the new native readiness records may be added"
    );
    assert_eq!(
        &copied, before,
        "preserve complete original schema, every cell/BLOB and all IDs/rowids"
    );
}
fn normalize_readiness_rowids(value: &mut Value) {
    let key = state_key(value);
    assert_eq!(value["tables"]["state"]["columns"][0], "__owned_rowid__");
    let mut normalized = 0;
    for row in value["tables"]["state"]["rows"].as_array_mut().unwrap() {
        if matches!(marker(row, key), Some(MODEL | READY)) {
            assert_eq!(row[0][0], "integer");
            row[0] = json!(["native-readiness-implicit-rowid"]);
            normalized += 1;
        }
    }
    assert_eq!(normalized, 2);
}
pub(super) fn assert_repeat_preserved(before: &Value, after: &Value) {
    let (mut before, mut after) = (before.clone(), after.clone());
    normalize_readiness_rowids(&mut before);
    normalize_readiness_rowids(&mut after);
    assert_eq!(
        before, after,
        "only the two new readiness implicit rowids may move during explicit initialization"
    );
}
