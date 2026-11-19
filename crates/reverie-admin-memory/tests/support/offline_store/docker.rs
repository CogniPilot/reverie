//! Bounded test child for the fixed Docker arguments of the installed CLI.
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let endpoint = format!(
        "unix://{}/docker.sock",
        env::current_dir().unwrap().display()
    );
    assert_eq!(&args[..2], ["--host", &endpoint]);
    let id = |byte| std::iter::repeat_n(byte, 64).collect::<String>();
    let (validation, stopped, helper) = (id('a'), id('b'), id('c'));
    let image = format!("sha256:{}", id('1'));
    match args[2..]
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["info", "--format", "{{json .ID}}"] => println!("\"fixture-engine\""),
        ["image", "inspect", selected] if *selected == image => emit("image.json"),
        ["cp", source, "-"] if *source == format!("{validation}:/etc/reverie-nix-base") => {
            emit("base.tar")
        }
        ["ps", "--all", "--quiet", "--no-trunc"] => {
            println!("{validation}");
            if !Path::new("lose-stopped").exists() || !Path::new("removed").exists() {
                println!("{stopped}");
            }
        }
        ["inspect", single] if *single == validation => array(&["validation.json"]),
        ["inspect", first, second] if *first == validation && *second == stopped => {
            array(&["validation.json", "stopped.json"])
        }
        ["inspect", cid] if *cid == helper => inspect_helper(),
        ["create", tail @ ..] => {
            step("create");
            let expected = fs::read_to_string("expected-args").unwrap();
            assert_eq!(tail.join("\0"), expected);
            if Path::new("stderr-bound").exists() {
                io::stderr().write_all(&vec![b'x'; 1024 * 1024]).unwrap();
            }
            println!("{helper}");
        }
        ["start", cid] if *cid == helper => {
            step("start");
            seed();
        }
        ["rm", cid] if *cid == helper => {
            step("rm");
            File::create("removed").unwrap();
        }
        unknown => panic!("unexpected fixture argv {unknown:?}"),
    }
}

fn step(verb: &str) {
    let mut trace = OpenOptions::new()
        .append(true)
        .create(true)
        .open("effect-log")
        .unwrap();
    writeln!(trace, "{verb}").unwrap();
    for leaf in ["employee-lock", "session-lock"] {
        let path = fs::read_to_string(leaf).unwrap();
        let lock = File::open(path).unwrap();
        assert!(matches!(
            lock.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
    }
    let fence = fs::read_to_string("fence-path").unwrap();
    assert!(Path::new(&fence).is_file());
    assert!(Path::new("prepared-audit").exists());
    if fs::read_to_string("fail").is_ok_and(|failure| failure == verb) {
        std::process::exit(1);
    }
}

fn seed() {
    let path = PathBuf::from(fs::read_to_string("nix-path").unwrap());
    let base = fs::read_to_string("base").unwrap();
    if !Path::new("miss-closure").exists() {
        fs::create_dir(
            path.join("store")
                .join(Path::new(&base).file_name().unwrap()),
        )
        .unwrap();
    }
    let image = path.join("var/nix/gcroots/reverie-image");
    fs::remove_file(&image).unwrap();
    symlink(base, image).unwrap();
    File::create("started").unwrap();
    for (marker, source, destination) in [
        ("drift-company", "changed-company.json", "company.json"),
        ("add-writer", "running.json", "stopped.json"),
        ("change-fence", "foreign-fence.json", "fence-leaf"),
        ("receipt-collision", "foreign-fence.json", "receipt-leaf"),
        ("replace-lock", "replacement-lock", "lock-leaf"),
    ] {
        if Path::new(marker).exists() {
            let target = if destination.ends_with("-leaf") {
                PathBuf::from(fs::read_to_string(destination).unwrap())
            } else {
                PathBuf::from(destination)
            };
            fs::rename(source, target).unwrap();
        }
    }
    if Path::new("profile-drift").exists() {
        File::create(path.join("var/nix/profiles/foreign")).unwrap();
    }
}

fn inspect_helper() {
    if Path::new("slow-create-inspect").exists() {
        thread::sleep(Duration::from_secs(7));
    }
    let file = if !Path::new("started").exists() || Path::new("never-exited").exists() {
        "created.json"
    } else {
        "exited.json"
    };
    array(&[file]);
}

fn array(files: &[&str]) {
    let rows = files
        .iter()
        .map(fs::read_to_string)
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    println!("[{}]", rows.join(","));
}

fn emit(path: &str) {
    io::stdout().write_all(&fs::read(path).unwrap()).unwrap();
}
