//! Inspect a saved Docker image for credential shapes and inadvertent instance data.
mod archive;
mod detectors;
mod layout;
mod report;
mod scan;

use clap::Parser;
use report::Report;
use std::{
    fs::{self, File},
    io,
    path::PathBuf,
    process::ExitCode,
};

#[derive(Parser)]
#[command(about = "Scan a saved Docker image archive before publication")]
struct Args {
    /// The uncompressed tar from docker save.
    archive: PathBuf,
    /// Allow listed detector IDs at exact archive paths.
    #[arg(long)]
    allow: Option<PathBuf>,
    /// Also write a machine-readable report.
    #[arg(long)]
    json: Option<PathBuf>,
}

fn run(args: Args) -> io::Result<Report> {
    let allowlist = match args.allow {
        Some(path) => layout::allowlist(&fs::read_to_string(path)?),
        None => layout::Allowlist::new(),
    };
    let report = scan::scan(File::open(args.archive)?, &allowlist)?;
    if let Some(path) = args.json {
        serde_json::to_writer_pretty(File::create(path)?, &report)?;
    }
    Ok(report)
}

fn show(report: &Report) {
    for finding in &report.findings {
        println!("{}\t{}", finding.detector, finding.location);
    }
    for (prefix, count) in &report.unread_third_party {
        println!(
            "names only\t/{prefix}\t{} files, {} bytes",
            count.files, count.bytes
        );
    }
    println!(
        "{} layers, {} findings",
        report.layers,
        report.findings.len()
    );
}

fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(report) => {
            show(&report);
            ExitCode::from(u8::from(!report.clean))
        }
        Err(error) => {
            eprintln!("malformed image archive: {error}");
            ExitCode::from(2)
        }
    }
}
