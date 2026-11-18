use super::*;
use crate::scoped_image::tests::{Fixture, request as office_fixture};
use nix::{sys::stat::Mode as FileMode, unistd::mkfifo};
use std::{fs, os::unix::fs::symlink};

const SESSION: &str = "11111111-2222-3333-4444-555555555555";
const ROOM: &str = "12345678-1234-1234-1234-123456789abc";
const ATTACHMENT: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";

fn request(room: &str, root: &Path, files: Vec<Value>) -> Request {
    Request {
        settings: Settings {
            vision: true,
            root: Some(root.to_owned()),
            session: Some(SESSION.to_owned()),
            cli: Vec::new(),
            max_images: 1,
            max_bytes: 100,
            timeout: 120.0,
        },
        room: room.to_owned(),
        message: json!({ "roomId": ROOM, "attachments": files }),
    }
}

fn png(path: &Path) -> Value {
    json!({ "id": ATTACHMENT, "path": path, "name": "fixture.png", "type": "image/png" })
}

fn decoded(reply: &Reply) -> Vec<u8> {
    let data = reply.parts[0]["image_url"]["url"]
        .as_str()
        .unwrap()
        .strip_prefix("data:image/png;base64,")
        .unwrap();
    assert_eq!(reply.parts[0]["type"], "image_url");
    STANDARD.decode(data).unwrap()
}

fn read_images(request: &Request, scope: Mode<'_>, scratch: &Path) -> Reply {
    let signals = Signals::install().unwrap();
    request
        .collect(scope, |file| request.read(scope, file, scratch, &signals))
        .unwrap()
}

#[test]
fn shared_mode_reads_the_full_room_for_a_short_id_and_refuses_cross_room_paths() {
    let fixture = Fixture::new();
    let room = fixture.0.join(ROOM);
    fs::create_dir(&room).unwrap();
    let path = room.join("test.png");
    fs::write(&path, PNG).unwrap();
    let allowed = room.join("allowed.png");
    symlink(&path, &allowed).unwrap();
    let other = fixture.0.join("elsewhere.bin");
    let wrong_room = room.join("wrong.png");
    symlink(&other, &wrong_room).unwrap();
    let fifo = room.join("fifo.png");
    mkfifo(&fifo, FileMode::S_IRUSR).unwrap();
    let local = Mode::Shared(&fixture.0);

    for accepted in [&path, &allowed] {
        let image = request(&ROOM[..8], &fixture.0, vec![png(accepted)]);
        let reply = read_images(&image, local, &fixture.0);
        assert!(reply.notes.is_empty());
        assert_eq!(decoded(&reply), PNG);
    }

    for refused in [&other, &wrong_room, &fifo] {
        let image = request(ROOM, &fixture.0, vec![png(refused)]);
        let reply = read_images(&image, local, &fixture.0);
        assert!(reply.parts.is_empty());
        assert_eq!(reply.notes, ["[image fixture.png: could not be read]"]);
    }
    fs::remove_dir_all(&room).unwrap();
    symlink(&fixture.0, &room).unwrap();
    let image = request(ROOM, &fixture.0, vec![png(&room.join("elsewhere.bin"))]);
    assert!(read_images(&image, local, &fixture.0).parts.is_empty());
}

#[test]
fn scoped_mode_calls_office_with_exact_ids_and_has_no_local_fallback() {
    let fixture = Fixture::new();
    let shared = fixture.0.join(ROOM);
    fs::create_dir(&shared).unwrap();
    let local = shared.join("fallback.png");
    fs::write(&local, PNG).unwrap();
    let scratch = fixture.0.join("tmp");
    let mut image = request(&ROOM[..8], &fixture.0, vec![png(&local), png(&local)]);
    image.settings.cli = office_fixture("good").cli;
    let scope = mode(&image.settings, true, Some(SESSION));
    let reply = read_images(&image, scope, &scratch);
    assert_eq!(decoded(&reply), PNG);
    assert_eq!(
        reply.notes,
        ["[image fixture.png: skipped, more than 1 images]"]
    );
    fixture.verify_cleanup();

    image.settings.cli = office_fixture("denied").cli;
    for session in [Some(SESSION), None, Some(ROOM)] {
        let reply = read_images(&image, mode(&image.settings, true, session), &scratch);
        assert!(reply.parts.is_empty());
        assert_eq!(reply.notes, ["[image fixture.png: could not be read]"; 2]);
        assert_eq!(fs::read(&local).unwrap(), PNG);
        fixture.verify_cleanup();
    }
}

#[test]
fn budget_counts_accepted_parts_and_ignores_unrecognized_attachment_types() {
    let item = png(Path::new("/fixture.png"));
    let image = request(
        "room",
        Path::new("/"),
        vec![
            json!({ "type": "text/plain" }),
            item.clone(),
            item.clone(),
            item.clone(),
            item,
        ],
    );
    let mut reads = [b"invalid".to_vec(), [0; 101].to_vec(), PNG.to_vec()].into_iter();
    let reply = image
        .collect(Mode::Shared(Path::new("/")), |_| Ok(reads.next().unwrap()))
        .unwrap();
    assert_eq!(decoded(&reply), PNG);
    assert_eq!(
        reply.notes,
        [
            "[image fixture.png: could not be read]",
            "[image fixture.png: could not be read]",
            "[image fixture.png: skipped, more than 1 images]",
        ]
    );
    assert!(reads.next().is_none());
    assert!(
        reply.failures[0]
            .1
            .contains("content does not match image/png")
    );
    assert_eq!(reply.failures[1].1, "too large");
    assert!(ImageType::Gif.matches(b"GIF89a"));
    assert!(ImageType::Gif.matches(b"GIF87a"));
    assert!(ImageType::Jpeg.matches(b"\xff\xd8\xff"));
    assert!(ImageType::Webp.matches(b"RIFFtestWEBP"));
    assert!(!ImageType::Webp.matches(b"RIFFtestWAVE"));
}

#[test]
fn vision_disabled_and_unlisted_attachments_never_read_an_image() {
    let item = png(Path::new("/fixture.png"));
    let mut image = request(
        "room",
        Path::new("/"),
        vec![item.clone(); ATTACHMENT_LIMIT + 1],
    );
    image.settings.vision = false;
    let scope = mode(&image.settings, true, Some(SESSION));
    let reply = image
        .collect(scope, |_| panic!("no image read expected"))
        .unwrap();
    assert!(reply.parts.is_empty());
    assert!(reply.failures.is_empty());
    assert_eq!(reply.notes.len(), ATTACHMENT_LIMIT);
    assert_eq!(
        reply.notes[0],
        "[image fixture.png: you cannot see images yet]"
    );
}
