fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments == ["--help"] {
        println!("Usage: reverie-build-jobs");
        return;
    }
    if !arguments.is_empty() {
        eprintln!("Usage: reverie-build-jobs");
        std::process::exit(2);
    }
    println!(
        "{}",
        reverie_laptop_tools::build_jobs(
            std::path::Path::new("/sys/fs/cgroup"),
            std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get)
        )
    );
}
