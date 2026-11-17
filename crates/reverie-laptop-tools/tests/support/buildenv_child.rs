use std::{env, fs, hint::black_box, path::Path, thread, time::Duration};

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("measure") => measure(),
        Some("watchdog") => {
            let root = args.next().unwrap();
            fs::write(Path::new(&root).join("memory.current"), 4190000000_u64.to_string()).unwrap();
            thread::sleep(Duration::from_secs(15));
        }
        Some("vitest") => {
            let count = args.next().unwrap().parse::<usize>().unwrap();
            let exit = args.next().unwrap().parse::<i32>().unwrap();
            if count > 0 {
                println!("\x1b[2m Test Files \x1b[22m {count} passed ({count})");
            }
            std::process::exit(exit);
        }
        _ => panic!("unknown fixture action"),
    }
}

fn measure() {
    let mut allocation = vec![0_u8; 80 * 1024 * 1024];
    for page in allocation.chunks_mut(4096) {
        page[0] = 42;
    }
    black_box(&allocation);
    let values = ["CARGO_TARGET_DIR", "CARGO_BUILD_JOBS", "RUSTUP_AUTO_INSTALL", "TMPDIR", "RUSTUP_HOME"]
        .map(|key| env::var(key).unwrap());
    fs::write("ran", values.join("\n")).unwrap();
    thread::sleep(Duration::from_millis(125));
}
