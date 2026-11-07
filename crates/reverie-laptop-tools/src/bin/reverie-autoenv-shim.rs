fn main() {
    if let Err(error) = reverie_laptop_tools::autoenv::launch() {
        eprintln!("reverie-autoenv: could not execute tool: {error}");
        std::process::exit(if error.kind() == std::io::ErrorKind::NotFound {
            127
        } else {
            126
        });
    }
}
