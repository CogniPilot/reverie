fn main() {
    if let Err(error) = reverie_laptop_tools::autoenv::command() {
        eprintln!("reverie-autoenv: {error}");
        std::process::exit(1);
    }
}
