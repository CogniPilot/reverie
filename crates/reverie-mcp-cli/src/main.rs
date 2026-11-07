//! Fixed installed MCP entry, with bootstrap data separate from actual API authority.
use clap::Parser;
use std::process::ExitCode;
#[derive(Parser)]
#[command(
    version,
    about = "Run Reverie's installed MCP tools over stdin/stdout.",
    long_about = "Serve the existing MCP protocol using fixed installed Node and TypeScript artifacts. Installed memory context selects data, never grants access; every installed read checks the real fixed-session Office API before and after use. Owner grants, current employee identity and existing memory data remain authoritative.",
    after_help = "Examples:\n  reverie-mcp --chat\n  reverie-mcp --url http://127.0.0.1:3000\n\nInstallation: use the packaged runtime. Missing origins refuse without PATH or interpreter fallback.\nPermissions: the actual API checks the current employee and owner-issued scope. A role, path or ready marker grants nothing.\nOutput: MCP JSON-RPC on stdout. Keep stdout dedicated to the MCP client.\nRecovery: inspect the current installation and grant; this command never initializes, migrates or reembeds memory."
)]
struct Arguments {
    /// Server URL for standalone MCP; installed context pins its fixed Office phone.
    #[arg(long)]
    url: Option<String>,
    /// Relax the client-side session filter; server authorization still applies.
    #[arg(long)]
    allow_any_session: bool,
    /// Include the existing room chat tools.
    #[arg(long)]
    chat: bool,
}
fn main() -> ExitCode {
    let args = Arguments::parse();
    let options = reverie_core::memory_context::McpOptions {
        url: args.url,
        allow_any_session: args.allow_any_session,
        chat: args.chat,
    };
    match reverie_host::memory_mcp::exec_installed(&options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = reverie_diagnostics::stderr(format!("{error}\n").as_bytes());
            ExitCode::FAILURE
        }
    }
}
