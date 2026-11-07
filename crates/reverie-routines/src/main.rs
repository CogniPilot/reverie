//! `reverie-routines`: the host routines tick (see the library documentation).

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let code = reverie_routines::run(
        &argv,
        &reverie_routines::Env::from_process(),
        None,
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
    );
    std::process::exit(code);
}
