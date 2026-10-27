#!/usr/bin/env bash
# Phase-3 ROOT runner for Rex's p3kit sandbox (kit r4; runner r5: config parent from RUNTIME_DIRECTORY for the self-test unit). Takes external Tim's preflight requirements
# (external-tim/prune-host-preflight-r1): root never reads the agent's sandbox config or a laptop-selected library; the
# config is built here, root-only, with fixed relative paths and the INSTALLED lease lib; exit status is captured
# explicitly (no set -e); an optional bind mount is trapped and verified gone; every path is checked for symlinks first.
#
# usage (as root):
#   p3_host_runner.sh --host-tmp DIR --run NAME --python PY --prune FILE --prune-sha HEX --lease-lib FILE --lease-sha HEX
#                     --run-id ID [--rev r8|r10] [--with-mount]
#   --host-tmp  the selected laptop's /tmp as seen from the host (its folder on drive B, ending in /tmp)
#   --run       the kit run directory name under that /tmp, e.g. rex-p3/host-run2 (relative, no ..)
#   --with-mount  ONLY after the prune has mount-identity detection (rex/prune-bind-mount-finding-r1): until then a
#               same-filesystem bind would let the prune empty the victim; default is no mount (mount case NOT RUN).
# Exit: 0 runner finished (the prune's own status is in HOST-RESULT.json), 2 refused before any effect, 3 cleanup failed.
set -u -o pipefail
fail() { echo "REFUSED: $*" >&2; exit 2; }
HOST_TMP= RUN= PY= PRUNE= PRUNE_SHA= LEASE= LEASE_SHA= RUN_ID= REV=r10 WITH_MOUNT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --with-mount) WITH_MOUNT=1; shift; continue;;
    --host-tmp|--run|--python|--prune|--prune-sha|--lease-lib|--lease-sha|--run-id|--rev) [ $# -ge 2 ] || fail "missing value for $1";;
    *) fail "unknown argument $1";;
  esac
  case "$1" in
    --host-tmp) HOST_TMP=$2;; --run) RUN=$2;; --python) PY=$2;; --prune) PRUNE=$2;; --prune-sha) PRUNE_SHA=$2;;
    --lease-lib) LEASE=$2;; --lease-sha) LEASE_SHA=$2;; --run-id) RUN_ID=$2;; --rev) REV=$2;;
  esac
  shift 2
done
[ "$(id -u)" = 0 ] || fail "must run as root on the host"
for v in HOST_TMP RUN PY PRUNE PRUNE_SHA LEASE LEASE_SHA RUN_ID; do [ -n "${!v}" ] || fail "--${v,,} is required"; done
[[ $RUN =~ ^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$ ]] || fail "--run must be a relative path of plain names"
[[ $RUN_ID =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail "bad --run-id"
[[ $PRUNE_SHA =~ ^[0-9a-f]{64}$ && $LEASE_SHA =~ ^[0-9a-f]{64}$ ]] || fail "shas must be 64 hex"
case "$REV" in r8|r10*) ;; *) fail "--rev must be r8 or r10";; esac

# 1. No symlink anywhere from / down to the run dir, and the run dir lies inside the laptop's /tmp.
nolink() { local p=$1 cur=; IFS=/ read -ra parts <<< "${p#/}"; for c in "${parts[@]}"; do cur="$cur/$c"; [ -L "$cur" ] && return 1; done; return 0; }
case "$HOST_TMP" in /*) ;; *) fail "--host-tmp must be absolute";; esac
[[ $HOST_TMP =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "--host-tmp must be plain path characters"   # r5: it goes into HOST-RESULT.json
[ -d "$HOST_TMP" ] && nolink "$HOST_TMP" || fail "host tmp missing or has a symlink in its path: $HOST_TMP"
W="$HOST_TMP/$RUN"; SB="$W/sb"
nolink "$SB" && [ -d "$SB" ] || fail "sandbox missing or reached through a symlink: $SB"
[ "$(realpath -e -- "$SB")" = "$SB" ] || fail "sandbox path is not canonical"
OWNER=$(stat -c %u -- "$HOST_TMP")
[ "$OWNER" != 0 ] || fail "host tmp is root-owned: not a laptop's /tmp"
[ "$(stat -c %u -- "$SB")" = "$OWNER" ] || fail "sandbox not owned by the laptop user"
[ ! -e "$W/HOST-DONE" ] || fail "HOST-DONE exists: this run was already used"
for d in B logs registry runtime A victim; do [ -d "$SB/$d" ] && [ ! -L "$SB/$d" ] || fail "fixture dir $d missing or a link"; done

# 2. The installed code: root-owned, not group/world-writable, exact sha (never anything from the sandbox).
for f in "$PY" "$PRUNE" "$LEASE"; do
  case "$f" in /*) ;; *) fail "$f must be absolute";; esac
  [ -f "$f" ] || [ -x "$f" ] || fail "missing $f"
done
for f in "$PRUNE" "$LEASE"; do
  m=$(stat -c '%u %a' -- "$f"); [ "${m%% *}" = 0 ] || fail "$f not root-owned"
  perm=${m##* }; [ $(( 8#$perm & 8#022 )) = 0 ] || fail "$f is group/world-writable"
  case "$f" in "$HOST_TMP"/*) fail "$f lies inside the laptop's tmp";; esac
done
[ "$(sha256sum -- "$PRUNE" | cut -d' ' -f1)" = "$PRUNE_SHA" ] || fail "prune sha mismatch"
[ "$(sha256sum -- "$LEASE" | cut -d' ' -f1)" = "$LEASE_SHA" ] || fail "lease lib sha mismatch"

# 3. Root-only config snapshot with FIXED relative paths (resolved inside --test-root by the prune) and the installed lib.
# r5: the self-test unit runs under ProtectSystem=strict, so its RuntimeDirectory is the config parent (default /run).
CFG_PARENT=${RUNTIME_DIRECTORY:-/run}
case "$CFG_PARENT" in /run|/run/*) ;; *) fail "config parent must be under /run";; esac
CFGDIR=$(mktemp -d "$CFG_PARENT/rex-p3.XXXXXX") || fail "mktemp"; chmod 0700 "$CFGDIR"
CFG="$CFGDIR/prune.toml"
{
  echo 'live_enabled = true'                      # confined synthetic run only; production config stays false
  echo 'b_mount = "B"'
  echo 'laptops_root = "laptops/employees"'
  echo 'high_water_pct = 1'
  echo 'low_water_pct = 0'
  echo 'idle_days = 3'
  echo 'recent_write_hours = 6'
  echo 'max_delete_bytes = 214748364800'
  echo 'registry_dir = "registry"'
  echo 'checkout_roots = ["A"]'
  echo 'log_dir = "logs"'
  echo 'laptop_home_root = "runtime/workers/employees"'
  echo "lease_lib = \"$LEASE\""
  case "$REV" in r10*) echo 'test_unbound_ok = true';; esac
  # r5: the fixture registry is written by the laptop user, so in this --test-root run that uid (and only it) is the
  # trusted registry owner. r12 accepts test_trusted_uid only with --test-root; production trusts root alone.
  case "$REV" in r10*) echo "test_trusted_uid = $OWNER";; esac
} > "$CFG"
sha256sum -- "$CFG" > "$CFGDIR/prune.toml.sha256"

# 4. Optional bind mount, trapped. Both ends are re-checked as real dirs owned by the laptop user, no links.
MNT="$SB/B/laptops/employees/L1/tmp/reverie/projects/mount/build/mnt"; MOUNTED=0
cleanup() {
  if [ "$MOUNTED" = 1 ]; then umount -- "$MNT" && MOUNTED=0; fi
}
trap cleanup EXIT INT TERM HUP
if [ "$WITH_MOUNT" = 1 ]; then
  for p in "$SB/victim" "$MNT"; do
    nolink "$p" && [ -d "$p" ] && [ "$(stat -c %u -- "$p")" = "$OWNER" ] || fail "mount end not a plain laptop-owned dir: $p"
  done
  mount --bind -- "$SB/victim" "$MNT" || fail "bind mount failed"
  MOUNTED=1
fi

# 5. The prune, status captured explicitly.
if "$PY" -I -B "$PRUNE" --config "$CFG" --test-root "$SB" --pass all --live --run-id "$RUN_ID" --test-df-pct 100; then
  PRUNE_RC=0
else
  PRUNE_RC=$?
fi
cleanup
UNMOUNTED=1; awk -v m="$MNT" '$5 == m {found=1} END {exit !found}' /proc/self/mountinfo && UNMOUNTED=0
trap - EXIT INT TERM HUP

# 6. Result for the laptop side, then HOST-DONE (both owned by the laptop user, so it can clean up).
# r5: the prune writes its run log as root 0600; hand exactly this run's two log files to the laptop user so the kit
# can grade them. chown -h never follows a link planted in the laptop-owned logs dir.
for f in "$SB/logs/$RUN_ID.jsonl" "$SB/logs/$RUN_ID.summary.json"; do
  if [ -e "$f" ] || [ -L "$f" ]; then chown -h -- "$OWNER" "$f"; fi
done
RES="$W/HOST-RESULT.json"
printf '{"run_id":"%s","rev":"%s","prune_rc":%d,"with_mount":%s,"unmounted":%s,"config_sha256":"%s","prune_sha256":"%s","lease_sha256":"%s","sandbox":"%s"}\n' \
  "$RUN_ID" "$REV" "$PRUNE_RC" "$([ $WITH_MOUNT = 1 ] && echo true || echo false)" "$([ $UNMOUNTED = 1 ] && echo true || echo false)" \
  "$(cut -d' ' -f1 "$CFGDIR/prune.toml.sha256")" "$PRUNE_SHA" "$LEASE_SHA" "$SB" > "$RES"
chown "$OWNER" -- "$RES"
touch -- "$W/HOST-DONE"; chown "$OWNER" -- "$W/HOST-DONE"
rm -rf -- "$CFGDIR"
cat "$RES"
echo "prune exit $PRUNE_RC (0 or 4 expected; the laptop side decides PASS from RESULT.json)"
[ "$UNMOUNTED" = 1 ] || { echo "CLEANUP FAILED: $MNT still mounted" >&2; exit 3; }
exit 0
