#![forbid(unsafe_code)]
use clap::{Parser, Subcommand, ValueEnum};
use reverie_company_api::{
    CompanyStore, client, initialization_status, initialize, qualification, server,
};
use serde_json::{Value, json};
use std::{io::Read, net::SocketAddr, path::PathBuf, process::ExitCode, sync::Arc};

#[derive(Parser)]
#[command(
    about = "Opt-in Rust company API and headless client; native lifecycle is not yet implemented"
)]
struct Arguments {
    #[command(subcommand)]
    action: Action,
}
#[derive(Subcommand)]
enum Action {
    /// Create a NEW private directory and owner credential. Existing stores refuse unchanged.
    Init { directory: PathBuf },
    /// Read-only qualification of an original initialized directory, including after a lost publish ACK.
    InitStatus { directory: PathBuf },
    /// Explicit fresh-service selection only; never points at the deployed TS company.
    Serve {
        #[arg(long)]
        fresh_company: PathBuf,
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,
    },
    /// Read or submit one request; retain its UUID on transport failure, never auto-retry.
    Call {
        #[arg(long)]
        address: SocketAddr,
        #[arg(long)]
        credential: PathBuf,
        #[arg(long, value_enum)]
        method: Method,
        #[arg(long)]
        path: String,
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Machine-readable required full-cycle matrix. --require-complete fails while any native step is pending.
    Qualification {
        #[arg(long)]
        require_complete: bool,
    },
}
#[derive(Clone, ValueEnum)]
enum Method {
    Get,
    Post,
}
fn main() -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(8)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            eprintln!("RUNTIME_UNAVAILABLE");
            return ExitCode::from(3);
        }
    };
    let code = runtime.block_on(run());
    runtime.shutdown_timeout(std::time::Duration::from_millis(100));
    code
}
async fn run() -> ExitCode {
    let(result,request)=match Arguments::parse().action {
        Action::Init{directory}=>(initialize(&directory).map(|()|json!({"success":true,"credentialFile":directory.join("owner-credential.json"),"nativeLifecycle":"unimplemented"})),None),
        Action::InitStatus{directory}=>(initialization_status(directory),None),
        Action::Serve{fresh_company,listen}=>return serve(fresh_company,listen).await,
        Action::Qualification{require_complete}=>{println!("{}",qualification::matrix());return if require_complete&&!qualification::full_lifecycle_qualified(){ExitCode::from(78)}else{ExitCode::SUCCESS};},
        Action::Call{address,credential,method,path,request_id}=>{
            let result=call(address,credential,method,&path,request_id.as_deref()).await;(result,request_id)
        }
    };
    let (value, exit) = match result {
        Ok(mut value) => {
            if value.get("success") == Some(&json!(false))
                && let Some(request) = &request
            {
                value["requestId"] = json!(request);
            }
            let code = if value.get("success") == Some(&json!(false)) {
                3
            } else if value.pointer("/data/phase") == Some(&json!("held")) {
                4
            } else {
                0
            };
            (value, code)
        }
        Err(error) => (
            json!({"success":false,"code":error.code(),"requestId":request}),
            3,
        ),
    };
    println!("{value}");
    ExitCode::from(exit)
}
async fn serve(directory: PathBuf, address: SocketAddr) -> ExitCode {
    let result = async {
        let store = Arc::new(CompanyStore::open(directory)?);
        if !address.ip().is_loopback() {
            return Err(reverie_company_api::Error::Forbidden);
        }
        let listener = tokio::net::TcpListener::bind(address)
            .await
            .map_err(|_| reverie_company_api::Error::Storage)?;
        let address = listener
            .local_addr()
            .map_err(|_| reverie_company_api::Error::Storage)?;
        println!(
            "{}",
            json!({"listening":address.to_string(),"nativeLifecycle":"unimplemented"})
        );
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            let _ = tx.send(());
        });
        server::serve(listener, store, rx).await
    }
    .await;
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(3)
        }
    }
}
async fn call(
    address: SocketAddr,
    credential: PathBuf,
    method: Method,
    path: &str,
    request: Option<&str>,
) -> std::result::Result<Value, reverie_company_api::Error> {
    let token = client::credential(&credential)?;
    let body = if matches!(method, Method::Post) {
        let mut raw = String::new();
        std::io::Read::take(std::io::stdin().lock(), 16385)
            .read_to_string(&mut raw)
            .map_err(|_| reverie_company_api::Error::Invalid)?;
        if raw.len() > 16384 {
            return Err(reverie_company_api::Error::Invalid);
        }
        let value: Value =
            serde_json::from_str(&raw).map_err(|_| reverie_company_api::Error::Invalid)?;
        if value.get("requestId").and_then(Value::as_str) != request {
            return Err(reverie_company_api::Error::Invalid);
        }
        raw.into_bytes()
    } else {
        Vec::new()
    };
    client::call_raw(
        address,
        &token,
        if matches!(method, Method::Get) {
            "GET"
        } else {
            "POST"
        },
        path,
        body,
    )
    .await
}
