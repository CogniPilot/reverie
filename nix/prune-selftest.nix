{ pkgs, src, prune ? import ./prune-r12.nix { inherit pkgs src; } }:
let
  hashes = {
    "selftest.py" = "280dd66b9c83f0faa99c263dddbee99f8e37a1104548f4d4f690066d0061574e";
    "p3kit.py" = "cf4ca5a1b0fc84b2502e126be5a0c9b06881a11eba9161324efc1e352db0024a";
    "suite.py" = "b94a3959f6a9a836f22e744c0c12041bea197d1744a4cc5e085f010afad96312";
    "p3_host_runner.sh" = "5e5f776fcc158f4c54a17a0fac43c1ae2a5f403e78a4f6fc6cc2a1f1e624eab8";
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
