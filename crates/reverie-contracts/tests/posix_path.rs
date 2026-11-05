use reverie_core::posix_path::PosixPath;
use serde::Deserialize;

#[derive(Deserialize)]
struct Corpus {
    normalized: Vec<Normalized>,
    pairs: Vec<Pair>,
}
#[derive(Deserialize)]
struct Normalized {
    input: Vec<u32>,
    normalized: Vec<u32>,
    parent: Vec<u32>,
    absolute: bool,
}
#[derive(Deserialize)]
struct Pair {
    a: Vec<u32>,
    b: Vec<u32>,
    relative: bool,
    overlap: bool,
    joined: Vec<u32>,
}
fn corpus() -> Corpus {
    serde_json::from_str(include_str!("fixtures/posix-path-python-interop.json")).unwrap()
}
#[test]
fn actual_python_lexical_normalization_and_parent_preserve_anchors_and_codepoints() {
    let cases = corpus().normalized;
    assert_eq!(cases.len(), 106);
    for case in cases {
        let path = PosixPath::try_new(&case.input).unwrap();
        assert_eq!(path.codepoints(), case.normalized, "{:?}", case.input);
        assert_eq!(path.parent().codepoints(), case.parent, "{:?}", case.input);
        assert_eq!(path.is_absolute(), case.absolute);
    }
}
#[test]
fn actual_python_joins_descendants_and_overlap_match_seeded_path_pairs() {
    let cases = corpus().pairs;
    assert_eq!(cases.len(), 1300);
    for case in cases {
        let a = PosixPath::try_new(&case.a).unwrap();
        let b = PosixPath::try_new(&case.b).unwrap();
        assert_eq!(
            a.is_relative_to(&b),
            case.relative,
            "{:?} {:?}",
            case.a,
            case.b
        );
        assert_eq!(a.overlaps(&b), case.overlap, "{:?} {:?}", case.a, case.b);
        assert_eq!(
            a.join(&b).codepoints(),
            case.joined,
            "{:?} {:?}",
            case.a,
            case.b
        );
    }
}
#[test]
fn lexical_path_data_are_not_native_path_or_mount_permission() {
    for value in ["\0", "a/../b", "//a", "/a\nb"] {
        assert!(PosixPath::try_new(&value.chars().map(u32::from).collect::<Vec<_>>()).is_ok());
    }
    assert!(PosixPath::try_new(&[0xd800, 47, 0xdcff]).is_ok());
    assert!(PosixPath::try_new(&[0x110000]).is_err());
    assert!(!PosixPath::from_scalar_text("/a").is_relative_to(&PosixPath::from_scalar_text("//a")));
    assert!(
        !PosixPath::from_scalar_text("/a/../b").is_relative_to(&PosixPath::from_scalar_text("/b"))
    );
}
