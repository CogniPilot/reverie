fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert_eq!(args, ["--agent", "chat", "--model", "vendor/model $(echo literal)"]);
    assert_eq!(std::env::var("REVERIE_INSTANCE_CONFIG").unwrap(), "./instance.json");
    std::process::exit(37);
}
