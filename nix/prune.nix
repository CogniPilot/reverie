{ pkgs, src }:
let
  lib = pkgs.lib;
  sourceHashes = {
    prune = "eee8b1608e1e87117d00b955b6cf6271cea809ab5e0cfd3f77696a05007eb3fb";
    lease = "7b640a38331c198626601346594ead1437fd6c15044393e55996aee9b62337f9";
  };
in
pkgs.runCommand "reverie-prune-tools" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  passthru = { inherit sourceHashes; dryRunOnly = true; };
  meta = {
    description = "Dry-run scratch cleanup and disposable-directory leases";
    mainProgram = "reverie-prune";
    platforms = lib.platforms.linux;
  };
} ''
  mkdir -p "$out/bin" "$out/libexec/reverie" "$out/share/reverie-prune"
  install -m444 ${src}/python/reverie/cleanup/reverie_prune.py "$out/libexec/reverie/reverie_prune.py"
  install -m444 ${src}/python/reverie/cleanup/lease.py "$out/libexec/reverie/lease.py"

  # Frozen r8 prune algorithm plus current canonical lease inventory support.
  # Source pins are not renewed native/phase-3/authorization acceptance.
  printf '%s  %s\n' '${sourceHashes.prune}' "$out/libexec/reverie/reverie_prune.py" \
    '${sourceHashes.lease}' "$out/libexec/reverie/lease.py" | sha256sum --check --status

  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-prune" \
    --add-flags "-I -B $out/libexec/reverie/reverie_prune.py --dry-run" \
    --prefix PATH : ${lib.makeBinPath [ pkgs.git ]}
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/lease" \
    --add-flags "-I -B $out/libexec/reverie/lease.py"

  cat > "$out/share/reverie-prune/prune.example.toml" <<'TOML'
  # Review and copy to private host configuration before running anything.
  # Replace placeholders with owner-approved bindings. Nothing is activated here.
  live_enabled = false
  b_mount = "/ABSOLUTE-DISPOSABLE-MOUNT"
  laptops_root = "laptops/employees"
  laptop_home_root = "/ABSOLUTE-PERSISTENT-EMPLOYEE-ROOT"
  lease_lib = "/ROOT-CONTROLLED-STATE/reverie-prune/lib/lease.py"
  lease_dir_template = "{home}/.local/state/reverie/leases"
  host_lease_dirs = ["/ROOT-CONTROLLED-STATE/reverie-prune/leases"]
  registry_dir = "/ROOT-CONTROLLED-STATE/reverie-prune/registry"
  log_dir = "/ROOT-CONTROLLED-STATE/reverie-prune/logs"
  lock_path = "/ROOT-CONTROLLED-STATE/reverie-prune/prune.lock"
  checkout_roots = []
  # The owner supplies a reviewed, fixed-argv laptop inventory command.
  laptops_cmd = []
  TOML

  cat > "$out/share/reverie-prune/README" <<'DOC'
  This package contains reviewed prune r8 and lease r7 sources. reverie-prune
  always supplies --dry-run; --live conflicts and is refused. No service, timer,
  private configuration, filesystem grant or cleanup is installed by this build.

  Dry-run activation is not live qualification. Filesystem-binding approval,
  registry approval, shared host/laptop inode-and-lock validation and phase-3
  host acceptance remain separate gates. Missing or unreadable leases fail closed.
  The reviewed source's same-device bind-mount gap is not fixed or qualified here.

  Copy and review the example into owner-selected private host configuration.
  Its placeholders are intentionally unusable. Configuration, registries, locks
  and logs belong outside the public checkout. The inventory command runs with
  the operator's authority; protect the configuration and its parent directories.

  The janitor imports only an absolute, canonical lease_lib path whose file and
  every ancestor are root-owned and not group/world writable. A Nix store with a
  group-writable parent (including mode 1775) FAILS this existing check. Do not
  weaken it. The owner installer must hash-copy libexec/reverie/lease.py into a
  configurable root-controlled directory, verify the copied hash and full parent
  chain, then put that canonical copy in lease_lib. The immutable package source
  alone does not establish that the live import path is acceptable.

  lease uses REVERIE_LEASE_DIR, defaulting to the user's persistent
  .local/state/reverie/leases directory. Provision every applicable lease directory
  before a janitor run; it never treats a missing directory as free.

  Raw libexec sources are retained for an operator-owned synthetic phase-3 test
  only. Their presence is not authorization for live cleanup or a way around the
  public command's dry-run restriction. Do not run raw live mode on real data.
  DOC

  # Build smoke checks execute only help and argument rejection, never host scans.
  "$out/bin/reverie-prune" --help > prune-help.txt
  "$out/bin/lease" --help > lease-help.txt
  if "$out/bin/reverie-prune" --live > live-refused.txt 2>&1; then
    echo "dry-run package accepted --live" >&2
    exit 1
  fi
  grep -F -- 'not allowed with argument --dry-run' live-refused.txt > /dev/null
  chmod -R a-w "$out"
''
