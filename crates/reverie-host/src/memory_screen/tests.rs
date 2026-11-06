use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "memory-screen-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn names_file_keeps_source_comments_unicode_lines_and_strict_utf8_failures() {
    let tree = Tree::new();
    let names = tree.0.join("people.txt");
    std::fs::write(
        &names,
        "# ignored\r\n  # literal name \nPat Example\u{1c}Jane Roe\u{1f}\n",
    )
    .unwrap();
    let loaded = read_names(&names).unwrap();
    assert_eq!(
        loaded
            .iter()
            .map(|text| text.as_text_ref().scalar_text().unwrap().into_owned())
            .collect::<Vec<_>>(),
        ["# literal name", "Pat Example", "Jane Roe"]
    );
    let screen =
        MemoryScreen::from_parts(PythonTextRef::from_scalar_text("{}"), names.clone()).unwrap();
    assert_eq!(
        screen
            .check(&MetadataText::from_scalar_text(
                "Pat Example lives at night"
            ))
            .unwrap(),
        "targeting a real private person"
    );
    std::fs::write(&names, [0xff]).unwrap();
    assert!(matches!(
        screen.check(&MetadataText::from_scalar_text("ordinary")),
        Err(ScreenError::Utf8(_))
    ));
}
#[test]
fn missing_names_and_bad_policy_do_not_create_memory_or_silently_skip_rules() {
    let tree = Tree::new();
    let missing = tree.0.join("missing");
    let screen =
        MemoryScreen::from_parts(PythonTextRef::from_scalar_text("{}"), missing.clone()).unwrap();
    assert_eq!(
        screen
            .check(&MetadataText::from_scalar_text("ordinary"))
            .unwrap(),
        ""
    );
    assert_eq!(
        screen
            .check(&MetadataText::from_scalar_text("Jane Roe 555-123-4567"))
            .unwrap(),
        "targeting a real private person"
    );
    let configured = MemoryScreen::from_parts(
        PythonTextRef::from_scalar_text(r#"{"denied_patterns":["policy"]}"#),
        missing.clone(),
    )
    .unwrap();
    assert_eq!(
        configured
            .check(&MetadataText::from_scalar_text("ordinary"))
            .unwrap(),
        ""
    );
    assert_eq!(
        configured
            .check(&MetadataText::from_scalar_text("POLICY"))
            .unwrap(),
        "configured output policy"
    );
    assert!(!missing.exists());
}
#[test]
fn input_utf8_surrogateescape_and_universal_newlines_reach_the_same_lossless_json_owner() {
    use reverie_contracts::memory_cli::MemoryRequest;
    let mut raw = b"{\r\n\"action\":\"recall\",\"private\":true,\"query\":\"".to_vec();
    raw.extend_from_slice(&[0xed, 0xa0, 0x80]);
    raw.extend_from_slice(b"\"}\r\n");
    let text = memory_stdin_text(&raw);
    let MemoryRequest::Recall { query, .. } = MemoryRequest::decode(text.as_text_ref()).unwrap()
    else {
        unreachable!()
    };
    assert_eq!(query.codepoints(), [0xdced, 0xdca0, 0xdc80]);
    assert!(!text.codepoints().contains(&13));
}
#[test]
fn invalid_names_plus_actual_checked_close_failure_preserves_both_errors() {
    let tree = Tree::new();
    let path = tree.0.join("bad.txt");
    std::fs::write(&path, [0xff]).unwrap();
    native::test_faults::set(None, true);
    assert!(
        matches!(read_names(&path),Err(ScreenError::Finalization{primary,secondary}) if matches!(*primary,ScreenError::Utf8(_))&&matches!(*secondary,ScreenError::Native(_)))
    );
}
#[test]
fn compiled_policy_precedes_private_names_but_compiles_every_rule_before_search() {
    let tree = Tree::new();
    let path = tree.0.join("invalid-utf8");
    std::fs::write(&path, [0xff]).unwrap();
    let screen = MemoryScreen::from_parts(
        PythonTextRef::from_scalar_text(r#"{"denied_patterns":["(?a:\\W)","(?i:policy)"]}"#),
        path.clone(),
    )
    .unwrap();
    assert_eq!(
        screen
            .check(&MetadataText::from_scalar_text("POLICY"))
            .unwrap(),
        "configured output policy"
    );
    assert!(matches!(
        screen.check(&MetadataText::from_scalar_text("Σ")),
        Err(ScreenError::Utf8(_))
    ));
    assert!(matches!(
        MemoryScreen::from_parts(
            PythonTextRef::from_scalar_text(r#"{"denied_patterns":["a","("]}"#),
            path.clone()
        ),
        Err(ScreenError::Regex(_))
    ));
    assert!(matches!(
        MemoryScreen::from_parts(
            PythonTextRef::from_scalar_text(r#"{"denied_patterns":["(",null]}"#),
            path
        ),
        Err(ScreenError::Policy(_))
    ));
}
