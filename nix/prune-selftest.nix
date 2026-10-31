{ pkgs, src, prune ? import ./prune-r12.nix { inherit pkgs src; } }:
let
  hashes = {
    "selftest.py" = "2468295330b1d75a4c7eefff6f8f1d2669e792cf13515277c2b1143e6a6c591c";
    "p3kit.py" = "34a1642b16484aeb876277e87a058556ef8f47c608cc64acf3268b06f37c6a83";
    "suite.py" = "3dd4961eeda3045a0962bb2c1af491370b3526fbdaa955b078128f8df4027e98";
    "p3_host_runner.sh" = "401569b70f20f7f7f0883134d3a1ca88832f8dc33bf6de46bca7c593847e7927";
  };
in pkgs.runCommand "reverie-prune-selftest-r2" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  passthru = { sourceHashes = hashes; executionQualified = false; };
} ''
  mkdir -p "$out/bin" "$out/libexec/reverie/selftest"
  ${pkgs.lib.concatStringsSep "\n" (pkgs.lib.mapAttrsToList (name: hash: ''
    install -m444 ${src}/python/reverie/cleanup/selftest/${name} "$out/libexec/reverie/selftest/${name}"
    echo '${hash}  '"$out/libexec/reverie/selftest/${name}" | sha256sum --check --status
  '') hashes)}
  install -m444 ${src}/python/reverie/cleanup/host_install.py "$out/libexec/reverie/host_install.py"
  install -m444 ${src}/python/reverie/cleanup/selftest_state.py "$out/libexec/reverie/selftest_state.py"
  install -m444 ${src}/python/reverie/cleanup/lease.py "$out/libexec/reverie/lease.py"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-prune-selftest-prepare" \
    --add-flags "-I -B $out/libexec/reverie/selftest_state.py" \
    --add-flags "--package $out --prune ${prune}/libexec/reverie/reverie_prune.py" \
    --add-flags "--detect-virt ${pkgs.systemd}/bin/systemd-detect-virt"
  "$out/bin/reverie-prune-selftest-prepare" --help > /dev/null
  ${pkgs.python3}/bin/python3 -I -B "$out/libexec/reverie/selftest/selftest.py" --help > /dev/null
  chmod -R a-w "$out"
''
