//! Isolated HTTPS laptop previews and their private owner control transport.
#![cfg(unix)]

mod configuration;
mod control_socket;
mod docker;
mod registry;
mod responses;
mod server;
mod upstream;

pub use configuration::Config;
pub use docker::{DockerLookup, Lookup, Target};
pub use server::{Server, bind, shutdown};

#[cfg(feature = "browser-fixture")]
pub mod browser_fixture;

fn invalid(message: &'static str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}
