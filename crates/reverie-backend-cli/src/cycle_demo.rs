//! Prepare the synthetic daily-cycle trial. The scheduler owns execution.
use clap::Parser;
use nix::unistd::{User, getuid};
use serde_json::{Map, Value, json};
use std::{
    env,
    fs::{self, DirBuilder, OpenOptions},
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
    process::ExitCode,
};

const AGENTS: [(&str, &str); 2] = [("cto", "CTO"), ("math", "Mathematics specialist lead")];
const VERIFIER: &[u8] = br#"import assert from 'node:assert/strict';
import { answer } from './answer.mjs';

assert.equal(answer(), 42);
"#;

#[derive(Parser)]
#[command(about = "Create an isolated synthetic daily-cycle trial")]
struct Args {
    /// Empty owned directory for trial files.
    #[arg(long)]
    directory: PathBuf,
    /// HTTP(S) endpoint offered to the trial scheduler.
    #[arg(long)]
    api_base: String,
    /// Model selected explicitly for the synthetic agents.
    #[arg(long)]
    model: String,
}

fn expand_home(path: &Path) -> io::Result<PathBuf> {
    let mut parts = path.components();
    let Some(Component::Normal(first)) = parts.next() else {
        return Ok(path.to_owned());
    };
    let Some(user) = first.to_str().and_then(|name| name.strip_prefix('~')) else {
        return Ok(path.to_owned());
    };
    let home = if user.is_empty() {
        match env::var_os("HOME").filter(|path| !path.is_empty()) {
            Some(path) => Some(path.into()),
            None => User::from_uid(getuid())?.map(|entry| entry.dir),
        }
    } else {
        User::from_name(user)?.map(|entry| entry.dir)
    };
    Ok(home.map_or_else(|| path.to_owned(), |home| home.join(parts.as_path())))
}

fn open_trial(path: &Path) -> io::Result<PathBuf> {
    let path = expand_home(path)?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&path)?;
    let root = path.canonicalize()?;
    let info = root.metadata()?;
    if !info.is_dir()
        || info.uid() != getuid().as_raw()
        || info.mode() & 0o022 != 0
        || root.to_str().is_none()
        || root.read_dir()?.next().transpose()?.is_some()
    {
        return Err(io::Error::other("choose an empty owned trial directory"));
    }
    Ok(root)
}

fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn write_json(path: &Path, value: &Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    write_new(path, &bytes)
}

fn phases() -> Value {
    let regular = json!({"max_tokens": 48000, "max_seconds": 180});
    let boundary = json!({"max_tokens": 0, "max_seconds": 5});
    json!({
        "waking": boundary, "planning": regular, "research": regular,
        "implementation": {"max_tokens": 64000, "max_seconds": 300},
        "reporting": regular, "consolidation": regular,
        "dreaming": regular, "sleeping": boundary,
    })
}

fn instance(name: &str, role: &str) -> Value {
    json!({
        "id": name, "agent_name": role, "owner_name": "Trial operator",
        "role": role, "kind": "agent", "data_dir": format!("../memory/{name}"),
        "persona": "Be inquisitive, candid, precise and professional. Keep personal and project memory separate.",
        "initial_self": {
            "consciousness": "The nature of AI consciousness is an open question.",
            "directives": ["Seek evidence.", "Be curious and test ideas."],
        }
    })
}

fn agent(path: &Path, role: &str, phases: &Value) -> Value {
    json!({
        "instance": path, "kind": "agent", "role": role, "model": "local",
        "allowed_models": ["local"], "projects": ["demo"],
        "interests": ["mathematics", "small counterexamples"],
        "memory_queries": ["prior test results", "open questions"], "phases": phases,
        "allow_subagents": true, "max_children": 1, "child_models": ["local"],
        "child_roles": ["implementer"],
        "attributes": {
            "tags": {"value": ["curious", "evidence-focused"], "editable": "agent"},
            "stats.curiosity": {"value": 0.8, "editable": "agent"},
            "stats.creativity": {"value": 0.7, "editable": "weekly"},
            "stats.focus": {"value": 0.8, "editable": "frozen"}
        }
    })
}

fn policy(root: &Path, work: &Path, args: &Args, agents: Map<String, Value>) -> Value {
    json!({
        "coordinator": "cto", "timezone": "UTC", "wake_at": "08:00", "sleep_at": "22:00",
        "planning_horizon_days": 14, "poll_seconds": 30, "max_parallel_leads": 1,
        "state_dir": root.join("controller"), "scratch_dir": root.join("scratch"),
        "project_memory_dir": root.join("project-memory"), "agents": agents,
        "models": {"local": {
            "api_base": args.api_base, "model": args.model, "provider": "local_agent",
            "context_window": 32768, "output_tokens": 4096, "resource": "local-gpu",
            "local": true, "enabled": true
        }},
        "resources": {"local-gpu": {
            "max_tokens": 300000, "max_seconds": 3600,
            "reserved_tokens": 8192, "reserved_seconds": 120
        }},
        "tasks": [{
            "id": "answer-demo", "project": "demo", "kind": "implementation", "approved": true,
            "workdir": work,
            "brief": "Create answer.mjs exporting a function answer() that returns 42. Run node verify.mjs and report the result. Leave the verifier unchanged. Do not commit.",
            "verification": [["node", "verify.mjs"]]
        }]
    })
}

fn create(args: &Args) -> io::Result<PathBuf> {
    let root = open_trial(&args.directory)?;
    let work = root.join("project");
    let instances = root.join("instances");
    // The exclusive project directory creation elects the single trial writer.
    DirBuilder::new().mode(0o700).create(&work)?;
    DirBuilder::new().mode(0o700).create(&instances)?;
    write_new(
        &work.join("README.txt"),
        b"Synthetic trial project. Export answer() from answer.mjs and return 42. Run node verify.mjs to check it.\n",
    )?;
    write_new(&work.join("verify.mjs"), VERIFIER)?;
    let mut agents = Map::new();
    let phases = phases();
    for (name, role) in AGENTS {
        let path = instances.join(format!("{name}.json"));
        write_json(&path, &instance(name, role))?;
        agents.insert(name.into(), agent(&path, role, &phases));
    }
    let final_path = root.join("daily-cycle.json");
    let staged = root.join(".daily-cycle.json.tmp");
    write_json(&staged, &policy(&root, &work, args, agents))?;
    fs::hard_link(&staged, &final_path)?;
    fs::remove_file(staged)?;
    Ok(final_path)
}

fn main() -> ExitCode {
    match create(&Args::parse()) {
        Ok(policy) => {
            println!(
                "{}",
                json!({"policy": policy, "next": "reverie-cycle --policy POLICY once"})
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("reverie-cycle-demo: {error}");
            ExitCode::FAILURE
        }
    }
}
