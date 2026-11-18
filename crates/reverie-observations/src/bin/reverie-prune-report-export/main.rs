//! Publish the aggregate from the newest cleanup summary as the report user.
mod directory;
mod report;

use chrono::{DateTime, Utc};
use clap::Parser;
use nix::unistd::{Gid, Uid, getresgid, getresuid, setgroups, setresgid, setresuid};
use std::{io, path::PathBuf, process::ExitCode, time::SystemTime};

#[derive(Parser)]
#[command(about = "Export the newest cleanup run's aggregate as a non-root report user.")]
struct Args {
    #[arg(long)]
    state: PathBuf,
    #[arg(long)]
    out: PathBuf,
    #[arg(long)]
    uid: u32,
    #[arg(long)]
    gid: u32,
}

fn credentials_match(uid: Uid, gid: Gid) -> io::Result<bool> {
    let users = getresuid()?;
    let groups = getresgid()?;
    Ok([users.real, users.effective, users.saved] == [uid; 3]
        && [groups.real, groups.effective, groups.saved] == [gid; 3])
}

fn drop_to(uid: Uid, gid: Gid) -> io::Result<()> {
    if credentials_match(uid, gid)? {
        return Ok(());
    }
    setgroups(&[])?;
    setresgid(gid, gid, gid)?;
    setresuid(uid, uid, uid)?;
    if !credentials_match(uid, gid)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "could not drop to the report user",
        ));
    }
    Ok(())
}

fn run(args: &Args) -> io::Result<()> {
    let now = DateTime::<Utc>::from(SystemTime::now());
    let summary = directory::newest_summary(&args.state, now)?;
    let record = report::Run::capture(now, summary);
    // All input handles have closed. This one-shot process never regains root
    // and opens the reviewer-controlled output only as the report user.
    drop_to(Uid::from_raw(args.uid), Gid::from_raw(args.gid))?;
    directory::write_reports(&args.out, record)
}

fn main() -> ExitCode {
    let args = Args::parse();
    if args.uid == 0 || args.gid == 0 {
        eprintln!("reverie-prune-report-export: the report user must not be root");
        return ExitCode::from(2);
    }
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("reverie-prune-report-export: {error}");
            ExitCode::FAILURE
        }
    }
}
