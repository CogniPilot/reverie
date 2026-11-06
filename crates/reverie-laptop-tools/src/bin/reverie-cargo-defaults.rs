fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments == ["--help"] {
        println!("Usage: reverie-cargo-defaults");
        return;
    }
    if !arguments.is_empty() {
        eprintln!("Usage: reverie-cargo-defaults");
        std::process::exit(2);
    }
    let Some(home) = std::env::var_os("HOME") else {
        eprintln!("Cargo defaults require HOME");
        std::process::exit(1);
    };
    match reverie_laptop_tools::merge_cargo_defaults(std::path::Path::new(&home)) {
        Ok(reverie_laptop_tools::MergeOutcome::Preserved) => {
            println!("preserved existing build-dir")
        }
        Ok(reverie_laptop_tools::MergeOutcome::Merged) => {
            println!("merged Cargo build-dir; final artifacts remain in ./target")
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
