# The producer depends on these three crates only. Project Cargo metadata and
# its transitive lock closure so unrelated workspace/source edits cannot change
# the fixed artifact's identity. Ambiguous lock dependencies fail evaluation.
{ pkgs, src }:
let
  lib = pkgs.lib;
  original = src.origSrc or src;
  names = [ "reverie-core" "reverie-contracts" "reverie-policy-artifacts" ];
  manifest = builtins.fromTOML (builtins.readFile (original + "/Cargo.toml"));
  lock = builtins.fromTOML (builtins.readFile (original + "/Cargo.lock"));
  dependency = text:
    let
      parts = lib.splitString " " text;
      matching = builtins.filter (package:
        package.name == builtins.head parts
        && (builtins.length parts == 1 || package.version == builtins.elemAt parts 1)
        && (builtins.length parts < 3
          || "(${package.source or ""})" == builtins.elemAt parts 2)
      ) lock.package;
    in assert builtins.length matching == 1; builtins.head matching;
  entry = package: {
    key = "${package.name} ${package.version} ${package.source or ""}";
    inherit package;
  };
  closure = builtins.genericClosure {
    startSet = map (name: entry (dependency name)) names;
    operator = item: map (name: entry (dependency name)) (item.package.dependencies or []);
  };
  selectedLock = (pkgs.formats.toml {}).generate "policy-artifacts-Cargo.lock" {
    inherit (lock) version;
    package = map (item: item.package) (lib.sort (a: b: a.key < b.key) closure);
  };
  selectedManifest = (pkgs.formats.toml {}).generate "policy-artifacts-Cargo.toml" {
    workspace = {
      members = map (name: "crates/${name}") names;
      inherit (manifest.workspace) resolver package lints;
      dependencies = lib.filterAttrs (name: _: builtins.elem name
        [ "reverie-core" "reverie-contracts" "clap" "libc" "serde" "serde_json" "sha2" ])
        manifest.workspace.dependencies;
    };
    inherit (manifest) profile;
  };
  crates = map (name: {
    inherit name;
    path = builtins.path { path = original + "/crates/${name}"; inherit name; };
  }) names;
  selectedSource = pkgs.runCommand "reverie-policy-artifacts-source" {} ''
    mkdir -p "$out/crates"
    cp ${selectedManifest} "$out/Cargo.toml"
    cp ${selectedLock} "$out/Cargo.lock"
    ${lib.concatMapStringsSep "\n" (crate: ''cp -r ${crate.path} "$out/crates/${crate.name}"'') crates}
  '';
in pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-policy-artifacts";
  version = "0.1.0";
  src = selectedSource;
  cargoLock.lockFile = selectedLock;
  cargoBuildFlags = [ "-p" "reverie-policy-artifacts" ];
  cargoTestFlags = [ "-p" "reverie-policy-artifacts" ];
  doCheck = true;
  meta = {
    description = "Build-only fixed task perf seccomp artifact producer";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
    mainProgram = "reverie-policy-artifacts";
  };
}
