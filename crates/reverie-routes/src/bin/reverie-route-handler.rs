//! The Rust route handler child: `reverie-route-handler --generation <n>`. Frames arrive on stdin
//! and leave on stdout; nothing else is written to stdout. It exits 0 at the end of its input and
//! 2 after one diagnostic line on stderr for a bad argument or the first fatal frame. It starts no
//! processes and reads no environment.
use std::io::{self, Write};
use std::process::ExitCode;

fn generation() -> Option<u64> {
    let mut arguments = std::env::args().skip(1);
    match (
        arguments.next().as_deref(),
        arguments.next(),
        arguments.next(),
    ) {
        (Some("--generation"), Some(value), None) => value
            .parse::<u64>()
            .ok()
            .filter(|generation| *generation != 0),
        _ => None,
    }
}

fn main() -> ExitCode {
    let Some(generation) = generation() else {
        let _ = writeln!(
            io::stderr(),
            "usage: reverie-route-handler --generation <n>"
        );
        return ExitCode::from(2);
    };
    match reverie_routes::channel::serve(
        generation,
        &mut io::stdin().lock(),
        &mut io::stdout().lock(),
    ) {
        Ok(()) => ExitCode::SUCCESS,
        Err(fatal) => {
            let _ = writeln!(io::stderr(), "reverie-route-handler: {fatal}");
            ExitCode::from(2)
        }
    }
}
