# Laptop toolchains

The laptop image includes Rust and Cargo, GCC, GitHub CLI, jq, diffutils and fd.
Use the project's `nix develop` environment for Python, pytest, and any native
libraries that the project's packages require. Recreate project virtual
environments against that interpreter when updating a laptop image.
