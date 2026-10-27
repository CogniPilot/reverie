# Source-reviewed candidate, isolated from the installed r8 observation package.
# Host lease, phase-3 and clean dry-run acceptance remain operator gates.
{ pkgs, src }:
let
  hashes = {
    prune = "fbed566fbdfe89d312abb8b1b32354e5f44f35b94918028ce882fbf444b17181";
    lease = "13f2f4af7ea1bf7cf1d9f315ee214c367eb5434bf8a4cb2ee570b5b990420c3c";
  };
in pkgs.runCommand "reverie-prune-r12-candidate" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  passthru = { sourceHashes = hashes; dryRunOnly = true; hostQualified = false; };
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
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/lease" \
    --add-flags "-I -B $out/libexec/reverie/lease.py"
  cat > "$out/share/reverie-prune/README" <<'DOC'
  Candidate r12 with lease r7. The public wrapper forces --dry-run and rejects
  --live. Building this package does not install or upgrade any service, grant
  filesystem access, qualify live cleanup, or start an observation.

  The raw immutable sources are available for the separately reviewed operator
  phase-3 synthetic fixture. Never run raw live mode against real data before
  all host acceptance and owner authorization gates pass. The r8 host installer
  refuses this candidate because its source pins intentionally remain unchanged.
  DOC
  "$out/bin/reverie-prune" --help > help.txt
  "$out/bin/lease" --help > lease-help.txt
  if "$out/bin/reverie-prune" --live > refused.txt 2>&1; then
    echo "candidate accepted live mode" >&2
    exit 1
  fi
  grep -F -- 'not allowed with argument --dry-run' refused.txt > /dev/null
  chmod -R a-w "$out"
''
