//! Build-time Linux ELF closure assembly from immutable Nix inputs.
//! These tools operate only in image builds; their output is artifact data,
//! never runtime identity, installation consent, or execution authority.
#![forbid(unsafe_code)]
mod files;
mod idmap;
mod image;
mod libraries;
mod tools;
mod tree;

pub use files::{copy, digest, executable_machine, machine};
pub use idmap::build_idmap;
pub use image::ImageLayout;
pub use libraries::Libraries;
pub use tools::{Tools, immutable_input};
pub use tree::{readonly, tree};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn refused(message: &str) -> Box<dyn std::error::Error> {
    std::io::Error::other(message).into()
}
