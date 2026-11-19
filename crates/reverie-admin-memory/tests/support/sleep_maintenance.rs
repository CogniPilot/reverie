use super::{Fixture, success};
use crate::maintenance_model::serve_model;
use reverie_store::memory::EpisodeInput;
use serde_json::json;
use std::{env, fs, net::TcpListener, os::unix::fs::symlink};

fn setup(fixture: &Fixture, pending: bool) -> serde_json::Value {
    let mut expert = fixture.agent("expert", None, false);
    expert["consolidate"] = json!(false);
    let store = fixture.store("expert");
    let mut row = EpisodeInput::new(
        "Question about lattice symmetry",
        "Check a concrete example.",
    );
    if !pending {
        row.importance_source =
            reverie_contracts::storage_identity::MetadataText::from_scalar_text("fixed");
    }
    store.add_episode(row).unwrap();
    let idle_since = jiff::Timestamp::now().as_second() - 3600;
    store
        .set_state("reverie_last_activity", &idle_since.to_string())
        .unwrap();
    store.close().unwrap();
    fixture.policy(&[expert])
}

#[test]
fn a_dry_run_reports_real_due_work_without_contacting_models() {
    let fixture = Fixture::new();
    let mut policy = setup(&fixture, false);
    policy["dry_run"] = json!(true);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let output = success(fixture.run("tick", &policy, |command| {
        command
            .env("REVERIE_API_BASE", &base)
            .env("REVERIE_EMBED_URL", &base)
            .env("REVERIE_REFLECT_MIN_EPISODES", "1")
            .env("REVERIE_DREAMS_PER_SLEEP", "1");
    }));
    assert!(
        output.contains("would_reflect_dream expert 0 dry-run"),
        "{output}"
    );
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(!fixture.0.join("expert/morning-note.md").exists());
    let store = fixture.store("expert");
    assert_eq!(store.count(Some("episode")).unwrap(), 1);
    assert!(store.latest_dream().unwrap().is_none());
    assert!(store.reflections().unwrap().is_empty());
    store.close().unwrap();
}

#[test]
fn the_live_tick_rates_then_dreams_and_writes_only_the_waking_summary() {
    let fixture = Fixture::new();
    let policy = setup(&fixture, true);
    let grep = env::split_paths(&env::var_os("PATH").unwrap())
        .map(|path| path.join("grep"))
        .find(|path| path.is_file())
        .unwrap();
    let bin = fixture.0.join("bin");
    fs::create_dir(&bin).unwrap();
    fs::write(fixture.0.join("ls"), "agent fixture is idle\n").unwrap();
    symlink(grep, bin.join("reverie")).unwrap();
    let dream = json!({
        "dream":"I watched a lattice fold into an equation, then wandered down a corridor of paper.",
        "recall":"I dreamed about a lattice",
        "tone":"playful",
        "ideas":[{"hypothesis":"A symmetry might reduce the search","check":"Try a small example"}]
    });
    let (base, server) = serve_model(vec![Some("8".into()), Some(dream.to_string())]);
    let result = fixture.run("tick", &policy, |command| {
        command
            .env("REVERIE_API_BASE", &base)
            .env("PATH", &bin)
            .env("REVERIE_TIMEOUT", "3")
            .env("REVERIE_REFLECT_MIN_EPISODES", "99")
            .env("REVERIE_DREAMS_PER_SLEEP", "1")
            .env("REVERIE_GPU_LOCK", fixture.0.join("gpu.lock"))
            .env("REVERIE_GPU_ACTIVITY", fixture.0.join("gpu.activity"));
    });
    let output = success(result);
    let rate = output.find("rated expert 1 live").expect(&output);
    let dream = output.find("dreamed expert 1 live").expect(&output);
    let note = output.find("morning_note expert").expect(&output);
    assert!(rate < dream && dream < note);
    assert_eq!(server.join().unwrap().len(), 2);
    let note = fs::read_to_string(fixture.0.join("expert/morning-note.md")).unwrap();
    assert!(note.starts_with("Dream ("));
    assert!(note.contains("I dreamed about a lattice"));
    assert!(!note.contains("corridor of paper"));
    assert!(note.trim().chars().count() <= 600);
}
