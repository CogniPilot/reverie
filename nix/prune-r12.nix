# Source-reviewed candidate, isolated from the installed r8 observation package.
# Host lease, phase-3 and clean dry-run acceptance remain operator gates.
{ pkgs, src, leaseCli }:
let
  hashes = {
    prune = "55f26deec48c2c5d25b7d2509aa2ec28a22b1ebb0a6747c8be021a79129d4bed";
    lease = "606cacea83ebb70bb805423e67be44168fec411d3e5c62c5e563c416ab6891aa";
  };
in pkgs.runCommand "reverie-prune-r12-candidate" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  # reverie-prune stays dry-run only. reverie-prune-live is the separate entry point used solely by the NixOS module
  # when services.reverie.prune.live.enable passes its evaluation gates; r12 itself still needs --live AND
  # live_enabled = true in the config, plus its root/registry admission, before it deletes anything.
  passthru = { sourceHashes = hashes; dryRunOnly = true; liveEntry = "reverie-prune-live"; hostQualified = false; };
  meta = {
    description = "Dry-run-only r12 cleanup candidate for explicit host acceptance";
    mainProgram = "reverie-prune";
    platforms = pkgs.lib.platforms.linux;
  };
} ''
  mkdir -p "$out/bin" "$out/libexec/reverie" "$out/share/reverie-prune"
  install -m444 ${src}/python/reverie/cleanup/candidate/reverie_prune.py "$out/libexec/reverie/reverie_prune.py"
  install -m444 ${src}/python/reverie/cleanup/lease.py "$out/libexec/reverie/lease.py"
  printf '%s  %s\n' '${hashes.prune}' "$out/libexec/reverie/reverie_prune.py" \
    '${hashes.lease}' "$out/libexec/reverie/lease.py" | sha256sum --check --status
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-prune" \
    --add-flags "-I -B $out/libexec/reverie/reverie_prune.py --dry-run" \
    --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.git ]}
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-prune-live" \
    --add-flags "-I -B $out/libexec/reverie/reverie_prune.py" \
    --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.git ]}
  ln -s ${leaseCli}/bin/reverie-lease "$out/bin/lease"
  cat > "$out/share/reverie-prune/README" <<'DOC'
  Candidate r12 with lease r7. The public wrapper forces --dry-run and rejects
  --live. Building this package does not install or upgrade any service, grant
  filesystem access, qualify live cleanup, or start an observation.

  The raw immutable sources are available for the separately reviewed operator
  phase-3 synthetic fixture. Never run raw live mode against real data before
  all host acceptance and owner authorization gates pass. The r8 host installer
  refuses this candidate because its source pins intentionally remain unchanged.
  bin/lease is the native reverie-lease command; libexec/reverie/lease.py stays
  only as the janitor's lease_lib source.
  DOC
  "$out/bin/reverie-prune" --help > help.txt
  "$out/bin/reverie-prune-live" --help > live-help.txt
  "$out/bin/lease" --help > lease-help.txt
  if "$out/bin/reverie-prune" --live > refused.txt 2>&1; then
    echo "candidate accepted live mode" >&2
    exit 1
  fi
  grep -F -- 'not allowed with argument --dry-run' refused.txt > /dev/null
  chmod -R a-w "$out"
''
